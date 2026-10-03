// ==========================================================================
// admin/overview.js — quick stat cards for the admin dashboard
// ==========================================================================
import {
  fetchOverviewStats, fetchAllExams, fetchAllResultsAdmin, fetchAllUsersAdmin, countAttempts,
} from "../exam-data.js";

/* The old version downloaded EVERY exam, user and result document just to show five numbers
   (thousands of reads each time the panel opened, again after every save). Firestore aggregation
   queries (count / sum / average) answer the same questions server-side for about 1 read per
   1,000 documents. The full scan below is only a fallback if aggregation is unavailable.
   Called by the ⟳ Refresh button with a click Event, which means "recompute now". */
async function computeStats(opts) {
  try {
    return await fetchOverviewStats(opts);
  } catch (err) {
    console.warn("Aggregate overview unavailable, using the full scan:", err?.message || err);
    const [exams, results, users] = await Promise.all([fetchAllExams(opts), fetchAllResultsAdmin(opts), fetchAllUsersAdmin(opts)]);
    return {
      exams: exams.length,
      students: users.length,
      // One result document = one student + one exam, however many times they retook it —
      // so real attempts are counted from each doc's attempt count, not from the number of docs.
      attempts: results.reduce((sum, r) => sum + countAttempts(r), 0),
      avgPercent: results.length ? Math.round(results.reduce((sum, r) => sum + (Number(r.percent) || 0), 0) / results.length) : 0,
      studentsWhoAttempted: new Set(results.map((r) => r.uid)).size,
    };
  }
}

export async function loadOverview(opts) {
  const grid = document.getElementById("overview-stat-grid");
  if (!grid) return;
  grid.innerHTML = `<div class="loading-screen"><span class="spinner"></span></div>`;
  try {
    const st = await computeStats(opts);
    const takers = st.studentsWhoAttempted === null || st.studentsWhoAttempted === undefined
      ? `<span class="stat-value" title="ইনডেক্স তৈরি করতে Exams ট্যাবের ⚡ Optimize একবার চালান">—</span>`
      : `<span class="stat-value">${st.studentsWhoAttempted}</span>`;

    grid.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-file-pen"></i></div><div><span class="stat-value">${st.exams}</span><span class="stat-label">মোট এক্সাম</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-users"></i></div><div><span class="stat-value">${st.students}</span><span class="stat-label">মোট শিক্ষার্থী</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-pen-to-square"></i></div><div><span class="stat-value">${st.attempts}</span><span class="stat-label">মোট অ্যাটেম্পট</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-user-check"></i></div><div>${takers}<span class="stat-label">এক্সাম দিয়েছেন এমন শিক্ষার্থী</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-chart-simple"></i></div><div><span class="stat-value">${st.avgPercent}%</span><span class="stat-label">গড় স্কোর</span></div></div>`;
  } catch {
    grid.innerHTML = `<div class="empty-state"><p>ওভারভিউ লোড করা যায়নি</p></div>`;
  }
}
