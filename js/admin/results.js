// ==========================================================================
// admin/results.js — every attempt across every exam: filter, search, export
// ==========================================================================
import { escapeHtml, formatScore, formatDateTime, downloadCsv, toast } from "../utils.js";
import { fetchAllExams, fetchAllResultsAdmin, fetchAllUsersAdmin } from "../exam-data.js";
import { generateText } from "../ai.js";

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

/* ---------- AI performance summary ---------- */
let lastSummaryText = "";

function buildSummaryPrompt(filtered) {
  if (!filtered.length) return null;
  const scores = filtered.map((r) => r.percent);
  const avg = Math.round(scores.reduce((s, p) => s + p, 0) / scores.length);
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const passRate = Math.round((scores.filter((p) => p >= 60).length / scores.length) * 100);
  const byExam = {};
  filtered.forEach((r) => { (byExam[r.examTitle || "Untitled"] ||= []).push(r.percent); });
  const examLines = Object.entries(byExam).map(([title, pcts]) => {
    const a = Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length);
    return `- ${title}: ${pcts.length} attempts, average ${a}%`;
  }).join("\n");
  return `You are analyzing exam results for a course platform admin. Write a short, plain-language performance summary (4-6 sentences) in English: overall class performance, pass rate, which exam(s) students found hardest/easiest, and one practical suggestion for the instructor. Be specific with the numbers. No markdown, plain paragraph.

Data:
- Total attempts: ${filtered.length}
- Average score: ${avg}%
- Best: ${best}% · Lowest: ${worst}%
- Pass rate (>=60%): ${passRate}%
Per-exam breakdown:
${examLines}`;
}

async function generateSummary() {
  const filtered = applyFilters();
  const btn = document.getElementById("ai-summary-gen-btn");
  const out = document.getElementById("ai-summary-output");
  const actions = document.getElementById("ai-summary-actions");
  const prompt = buildSummaryPrompt(filtered);
  if (!prompt) { toast("No results to summarize yet", "error"); return; }
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span> Generating...`;
  try {
    const text = await generateText("results-summary", prompt, { system: "You are a helpful data analyst writing for a busy course admin.", temperature: 0.5, maxOutputTokens: 512 });
    lastSummaryText = text;
    out.textContent = text;
    out.hidden = false;
    actions.hidden = false;
    toast("Summary ready", "success");
  } catch (err) {
    toast(err.message || "Could not generate summary", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function buildSummaryPrintArea() {
  document.getElementById("ai-summary-print-area")?.remove();
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  const area = document.createElement("div");
  area.id = "ai-summary-print-area";
  area.className = "lb-print-only";
  area.innerHTML = `
    <div class="pr-watermark"><img src="assets/logo.png" alt=""></div>
    <div class="pr-header">
      <img src="assets/logo.png" alt="Tech Verse" class="pr-logo">
      <div><h1>Tech Verse Exam — Performance Summary</h1><p>Generated: ${escapeHtml(generatedAt)}</p></div>
    </div>
    <p style="line-height:1.7; font-size:0.92rem; white-space:pre-wrap;">${escapeHtml(lastSummaryText)}</p>
    <p class="pr-footer">Tech Verse Exam — AI-generated summary, reviewed by admin</p>`;
  document.body.appendChild(area);
}
function exportSummaryPdf() {
  if (!lastSummaryText) return;
  buildSummaryPrintArea();
  document.body.classList.add("lb-printing");
  const cleanup = () => {
    document.body.classList.remove("lb-printing");
    document.getElementById("ai-summary-print-area")?.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  requestAnimationFrame(() => window.print());
}

let html2canvasPromise = null;
function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve();
  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load the image export library"));
      document.head.appendChild(s);
    });
  }
  return html2canvasPromise;
}
async function exportSummaryImage() {
  if (!lastSummaryText) return;
  const btn = document.getElementById("ai-summary-image-btn");
  btn.disabled = true;
  try {
    await loadHtml2Canvas();
    const canvas = await window.html2canvas(document.getElementById("ai-summary-output"), { backgroundColor: "#14151E", scale: 2 });
    const link = document.createElement("a");
    link.download = `performance-summary-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (err) {
    toast(err.message || "Could not create image", "error");
  } finally {
    btn.disabled = false;
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
  document.getElementById("ai-summary-gen-btn")?.addEventListener("click", generateSummary);
  document.getElementById("ai-summary-pdf-btn")?.addEventListener("click", exportSummaryPdf);
  document.getElementById("ai-summary-image-btn")?.addEventListener("click", exportSummaryImage);
}
