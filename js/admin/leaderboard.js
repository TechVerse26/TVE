// ==========================================================================
// admin/leaderboard.js — ranked leaderboard: name + email only by default,
// click a row to expand that student's full exam-by-exam breakdown inline
// (score, percent, attempt #, submitted date for every exam they've taken).
//
// Ranking = average of their BEST result per exam (so a retake can only
// help a student's rank, never hurt it), tie-broken by best single score,
// then by how many exams they've actually attempted, then by name.
// Practice-exam results never enter the leaderboard at all — practice is
// meant to be risk-free, so it's excluded before any grouping happens.
//
// PDF export uses the browser's own print pipeline (print dialog → "Save
// as PDF") — no external PDF library, pure HTML/CSS/JS. A dedicated,
// light, report-styled view (#lb-print-area) is built on demand and
// swapped in via a body class + @media print rules in admin.css, then
// window.print() runs the export.
// ==========================================================================
import { escapeHtml, toast, formatScore, formatDateTime } from "../utils.js";
import { fetchAllResultsAdmin, fetchAllUsersAdmin, publishPercentileStats } from "../exam-data.js";

let leaderboard = []; // ranked: [{ uid, displayName, email, results[], examsTaken, totalAttempts, avgPercent, bestPercent }]

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function buildLeaderboard(users, results) {
  const usersById = Object.fromEntries(users.map((u) => [u.id, u]));
  const liveResults = results.filter((r) => r.examType !== "practice");
  const byUser = {};
  liveResults.forEach((r) => { (byUser[r.uid] ||= []).push(r); });

  const rows = Object.entries(byUser).map(([uid, userResults]) => {
    const u = usersById[uid] || {};
    // Best attempt per exam — retakes only ever help the ranking, never hurt it.
    const bestByExam = {};
    userResults.forEach((r) => {
      const cur = bestByExam[r.examId];
      if (!cur || (Number(r.percent) || 0) > (Number(cur.percent) || 0)) bestByExam[r.examId] = r;
    });
    const bestResults = Object.values(bestByExam);
    const examsTaken = bestResults.length;
    const avgPercent = examsTaken
      ? Math.round(bestResults.reduce((s, r) => s + (Number(r.percent) || 0), 0) / examsTaken)
      : 0;
    const bestPercent = Math.max(0, ...userResults.map((r) => Number(r.percent) || 0));
    return {
      uid,
      displayName: u.displayName || "নাম নেই",
      email: u.email || uid,
      results: userResults.slice().sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0)),
      examsTaken,
      totalAttempts: userResults.length,
      avgPercent,
      bestPercent,
    };
  });

  rows.sort((a, b) => b.avgPercent - a.avgPercent
    || b.bestPercent - a.bestPercent
    || b.totalAttempts - a.totalAttempts
    || a.displayName.localeCompare(b.displayName, "bn"));
  return rows;
}

function rankBadgeClass(rank) {
  if (rank === 1) return "lb-rank lb-rank-gold";
  if (rank === 2) return "lb-rank lb-rank-silver";
  if (rank === 3) return "lb-rank lb-rank-bronze";
  return "lb-rank";
}

function detailsHtml(row) {
  if (!row.results.length) return `<div class="lb-empty-details">কোনো এক্সাম দেওয়া হয়নি</div>`;
  const examRows = row.results.map((r) => `
    <tr>
      <td>${escapeHtml(r.examTitle || "—")}</td>
      <td>${formatScore(r.score)} / ${r.total}</td>
      <td><span class="badge ${r.percent >= 60 ? "badge-teal" : "badge-coral"}">${r.percent}%</span></td>
      <td>#${r.attemptNumber || 1}</td>
      <td>${formatDateTime(r.submittedAt)}</td>
    </tr>`).join("");
  return `
    <div class="lb-details-summary">
      <span class="lb-chip"><i class="fa-solid fa-book-open"></i> ${row.examsTaken} টা এক্সাম</span>
      <span class="lb-chip"><i class="fa-solid fa-rotate"></i> ${row.totalAttempts} টা অ্যাটেম্পট</span>
      <span class="lb-chip"><i class="fa-solid fa-chart-line"></i> গড় ${row.avgPercent}%</span>
      <span class="lb-chip"><i class="fa-solid fa-trophy"></i> সেরা ${row.bestPercent}%</span>
    </div>
    <div class="table-wrap">
      <table class="data-table lb-inner-table">
        <thead><tr><th>Exam</th><th>Score</th><th>Percent</th><th>Attempt</th><th>Submitted</th></tr></thead>
        <tbody>${examRows}</tbody>
      </table>
    </div>`;
}

function renderTable() {
  const tbody = document.querySelector("#leaderboard-table tbody");
  if (!tbody) return;
  const search = (document.getElementById("lb-search")?.value || "").trim().toLowerCase();
  const filtered = leaderboard
    .map((row, idx) => ({ ...row, rank: idx + 1 })) // rank reflects overall standing, not filtered position
    .filter((row) => !search || `${row.displayName} ${row.email}`.toLowerCase().includes(search));

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="2"><div class="empty-state"><div class="icon"><i class="fa-solid fa-ranking-star"></i></div><p>${leaderboard.length ? "কোনো শিক্ষার্থী পাওয়া যায়নি" : "এখনো কেউ কোনো এক্সাম দেয়নি"}</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row) => `
    <tr class="lb-row" data-uid="${row.uid}">
      <td data-label="Rank"><span class="${rankBadgeClass(row.rank)}">${row.rank}</span></td>
      <td data-label="Student">
        <div class="lb-user">
          <span class="lb-avatar">${escapeHtml(initials(row.displayName))}</span>
          <div class="lb-user-info">
            <div class="lb-user-name">${escapeHtml(row.displayName)} <i class="fa-solid fa-chevron-down lb-chevron"></i></div>
            <div class="lb-user-email">${escapeHtml(row.email)}</div>
          </div>
        </div>
      </td>
    </tr>
    <tr class="lb-details-row hidden" data-details-for="${row.uid}">
      <td colspan="2"><div class="lb-details">${detailsHtml(row)}</div></td>
    </tr>`).join("");

  tbody.querySelectorAll(".lb-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const uid = tr.dataset.uid;
      const detailsRow = tbody.querySelector(`.lb-details-row[data-details-for="${uid}"]`);
      if (!detailsRow) return;
      const isOpen = !detailsRow.classList.contains("hidden");
      // Accordion: only one student's details open at a time.
      tbody.querySelectorAll(".lb-details-row:not(.hidden)").forEach((open) => {
        open.classList.add("hidden");
        tbody.querySelector(`.lb-row[data-uid="${open.dataset.detailsFor}"] .lb-chevron`)?.classList.remove("lb-chevron-open");
      });
      if (!isOpen) {
        detailsRow.classList.remove("hidden");
        tr.querySelector(".lb-chevron")?.classList.add("lb-chevron-open");
      }
    });
  });
}

export async function loadLeaderboard() {
  const tbody = document.querySelector("#leaderboard-table tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="2"><div class="loading-screen"><span class="spinner"></span></div></td></tr>`;
  try {
    const [users, results] = await Promise.all([fetchAllUsersAdmin(), fetchAllResultsAdmin()]);
    leaderboard = buildLeaderboard(users, results);
    renderTable();
    // Refresh the anonymous percentile pool every time an admin opens this
    // tab, so students' "my rank" card (My Results page) has a reasonably
    // fresh comparison set without ever letting a student query the raw
    // results collection themselves. Best-effort — a student's own rank
    // card still works from whatever was last published if this fails.
    publishPercentileStats(leaderboard.map((row) => row.avgPercent)).catch(() => {});
  } catch {
    if (tbody) tbody.innerHTML = `<tr><td colspan="2"><div class="empty-state"><p>লোড করা যায়নি</p></div></td></tr>`;
  }
}

/* ---------- PDF export: light report view + the browser's native print pipeline ---------- */
function buildPrintArea() {
  document.getElementById("lb-print-area")?.remove();
  const generatedAt = new Date().toLocaleString("bn-BD", { dateStyle: "long", timeStyle: "short" });
  const rows = leaderboard.map((row, idx) => `
    <tr>
      <td class="pr-rank">${idx + 1}</td>
      <td>${escapeHtml(row.displayName)}</td>
      <td>${escapeHtml(row.email)}</td>
      <td class="pr-num">${row.examsTaken}</td>
      <td class="pr-num">${row.totalAttempts}</td>
      <td class="pr-num">${row.avgPercent}%</td>
      <td class="pr-num">${row.bestPercent}%</td>
    </tr>`).join("");

  const area = document.createElement("div");
  area.id = "lb-print-area";
  area.className = "lb-print-only";
  area.innerHTML = `
    <div class="pr-watermark"><img src="assets/logo.png" alt=""></div>
    <div class="pr-header">
      <img src="assets/logo.png" alt="Tech Verse" class="pr-logo">
      <div>
        <h1>Tech Verse Exam — লিডারবোর্ড রিপোর্ট</h1>
        <p>তৈরি হয়েছে: ${escapeHtml(generatedAt)} • মোট শিক্ষার্থী: ${leaderboard.length}</p>
      </div>
    </div>
    <table class="pr-table">
      <thead><tr><th>Rank</th><th>নাম</th><th>ইমেইল</th><th>এক্সাম</th><th>অ্যাটেম্পট</th><th>গড় স্কোর</th><th>সেরা স্কোর</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="pr-footer">Tech Verse Exam — Auto-generated leaderboard report</p>`;
  document.body.appendChild(area);
}

function exportPdf() {
  if (!leaderboard.length) { toast("এখনো কোনো ডেটা নেই — কেউ কোনো এক্সাম দেয়নি", "error"); return; }
  buildPrintArea();
  document.body.classList.add("lb-printing");
  const cleanup = () => {
    document.body.classList.remove("lb-printing");
    document.getElementById("lb-print-area")?.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // One frame so the print view is fully laid out before the print dialog opens.
  requestAnimationFrame(() => window.print());
}

export function bindLeaderboardControls() {
  document.getElementById("lb-search")?.addEventListener("input", renderTable);
  document.getElementById("lb-refresh-btn")?.addEventListener("click", loadLeaderboard);
  document.getElementById("lb-pdf-btn")?.addEventListener("click", exportPdf);
}
