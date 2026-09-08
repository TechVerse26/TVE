// ==========================================================================
// admin/results.js — every attempt across every exam: filter, search, export
// ==========================================================================
import { escapeHtml, formatScore, formatDateTime, downloadCsv } from "../utils.js";
import { fetchAllExams, fetchAllResultsAdmin, fetchAllUsersAdmin } from "../exam-data.js";

let allResults = [];
let allExams = [];
let usersById = {};

function applyFilters() {
  const examFilter = document.getElementById("res-exam-filter")?.value || "";
  const search = (document.getElementById("res-search")?.value || "").trim().toLowerCase();
  return allResults.filter((r) => {
    if (examFilter && r.examId !== examFilter) return false;
    if (!search) return true;
    const u = usersById[r.uid];
    const hay = `${u?.displayName || ""} ${u?.email || ""} ${r.examTitle || ""}`.toLowerCase();
    return hay.includes(search);
  });
}

function renderTable() {
  const tbody = document.querySelector("#results-table tbody");
  if (!tbody) return;
  const filtered = applyFilters();
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="icon"><i class="fa-solid fa-chart-simple"></i></div><p>কোনো ফলাফল পাওয়া যায়নি</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((r) => {
    const u = usersById[r.uid];
    return `
    <tr>
      <td data-label="Student"><div class="cell-title"><div><div class="t">${escapeHtml(u?.displayName || "অজানা")}</div><div class="muted" style="font-size:0.8em">${escapeHtml(u?.email || r.uid)}</div></div></div></td>
      <td data-label="Exam">${escapeHtml(r.examTitle || "—")}</td>
      <td data-label="Type">${r.examType === "practice" ? `<span class="badge"><i class="fa-solid fa-dumbbell"></i> Practice</span>` : `<span class="badge badge-teal"><i class="fa-solid fa-satellite-dish"></i> Live</span>`}</td>
      <td data-label="Score">${formatScore(r.score)} / ${r.total}</td>
      <td data-label="Percent"><span class="badge ${r.percent >= 60 ? "badge-teal" : "badge-coral"}">${r.percent}%</span></td>
      <td data-label="Attempt">#${r.attemptNumber || 1}</td>
      <td data-label="Submitted">${formatDateTime(r.submittedAt)}</td>
    </tr>`;
  }).join("");
}

export async function loadResultsTable() {
  const tbody = document.querySelector("#results-table tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="7"><div class="loading-screen"><span class="spinner"></span></div></td></tr>`;
  try {
    const [results, exams, users] = await Promise.all([fetchAllResultsAdmin(), fetchAllExams(), fetchAllUsersAdmin()]);
    allResults = results;
    allExams = exams;
    usersById = Object.fromEntries(users.map((u) => [u.id, u]));

    const examFilter = document.getElementById("res-exam-filter");
    if (examFilter) {
      examFilter.innerHTML = `<option value="">সব এক্সাম</option>` + allExams.map((e) => `<option value="${e.id}">${escapeHtml(e.title)}</option>`).join("");
    }
    renderTable();
  } catch {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>লোড করা যায়নি</p></div></td></tr>`;
  }
}

export function bindResultsControls() {
  document.getElementById("res-exam-filter")?.addEventListener("change", renderTable);
  document.getElementById("res-search")?.addEventListener("input", renderTable);
  document.getElementById("res-export-btn")?.addEventListener("click", () => {
    const filtered = applyFilters();
    const rows = [["Student", "Email", "Exam", "Type", "Score", "Total", "Percent", "Attempt", "Submitted"]];
    filtered.forEach((r) => {
      const u = usersById[r.uid];
      rows.push([u?.displayName || "", u?.email || r.uid, r.examTitle || "", r.examType === "practice" ? "Practice" : "Live", formatScore(r.score), r.total, `${r.percent}%`, r.attemptNumber || 1, formatDateTime(r.submittedAt)]);
    });
    downloadCsv(`exam-results-${Date.now()}.csv`, rows);
  });
  document.getElementById("res-refresh-btn")?.addEventListener("click", loadResultsTable);
}
