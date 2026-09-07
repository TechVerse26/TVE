// ==========================================================================
// admin/overview.js — quick stat cards for the admin dashboard
// ==========================================================================
import { fetchAllExams, fetchAllResultsAdmin, fetchAllUsersAdmin } from "../exam-data.js";

export async function loadOverview() {
  const grid = document.getElementById("overview-stat-grid");
  if (!grid) return;
  grid.innerHTML = `<div class="loading-screen"><span class="spinner"></span></div>`;
  try {
    const [exams, results, users] = await Promise.all([fetchAllExams(), fetchAllResultsAdmin(), fetchAllUsersAdmin()]);
    const totalAttempts = results.length;
    const avgPercent = totalAttempts ? Math.round(results.reduce((sum, r) => sum + (Number(r.percent) || 0), 0) / totalAttempts) : 0;
    const studentsWhoAttempted = new Set(results.map((r) => r.uid)).size;

    grid.innerHTML = `
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-file-pen"></i></div><div><span class="stat-value">${exams.length}</span><span class="stat-label">মোট এক্সাম</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-users"></i></div><div><span class="stat-value">${users.length}</span><span class="stat-label">মোট শিক্ষার্থী</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-pen-to-square"></i></div><div><span class="stat-value">${totalAttempts}</span><span class="stat-label">মোট অ্যাটেম্পট</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-user-check"></i></div><div><span class="stat-value">${studentsWhoAttempted}</span><span class="stat-label">এক্সাম দিয়েছেন এমন শিক্ষার্থী</span></div></div>
      <div class="stat-card"><div class="stat-icon"><i class="fa-solid fa-chart-simple"></i></div><div><span class="stat-value">${avgPercent}%</span><span class="stat-label">গড় স্কোর</span></div></div>`;
  } catch {
    grid.innerHTML = `<div class="empty-state"><p>ওভারভিউ লোড করা যায়নি</p></div>`;
  }
}
