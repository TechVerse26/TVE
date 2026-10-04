// ==========================================================================
// admin/results.js — every student's result: filter, search, sort, rank, pass/fail, per-result detail.
// One results document = one student × one exam (latest attempt on top, history inside) — so
// "Attempts" is the real number of tries and "Rank" is each student's position within that exam.
// Data is the shared 5-minute download (see exam-data.js); ⟳ re-reads it.
// ==========================================================================
import { toast, downloadCsv, formatScore } from "../utils.js";
import { fetchAllResultsAdmin, fetchAllUsersAdmin, fetchAllExamsAdmin, countAttempts } from "../exam-data.js";
import {
  esc, $, fmtN, fmtPct, fmtDur, fmtDateTime, ago, toMs, toDate, debounce, pageHead, kpi, chip, avatar, createTable,
  openDrawer, errorState, skeleton,
} from "./core/ui.js";
import { can } from "./core/permissions.js";
import { onChange } from "./core/bus.js";
import { passPercentOf, passMarksOf } from "./core/exam-status.js";
import { columns as colChart } from "./core/charts.js";

let root, table, rows = [], examsById = {}, usersById = {}, stale = false;
const f = { q: "", exam: "", type: "", result: "", from: "", to: "" };

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({ title: "Results", desc: "সব ফলাফল — স্কোর, শতাংশ, সঠিক/ভুল উত্তর, সময়, র‍্যাংক ও পাস/ফেল।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="rs-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${can("results.export") ? `<button type="button" class="btn btn-outline btn-sm" id="rs-export"><i class="fa-solid fa-download"></i> Export CSV</button>` : ""}` })}
    <div class="stack">
      <div id="rs-kpis"></div>
      <div class="panel">
        <div class="toolbar">
          <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="rs-q" placeholder="Search student, email or exam…" autocomplete="off"></div>
          <select id="rs-exam" aria-label="Exam"></select>
          <select id="rs-type" aria-label="Type"><option value="">Live + Practice</option><option value="live">Live</option><option value="practice">Practice</option></select>
          <select id="rs-result" aria-label="Pass or fail"><option value="">Pass + Fail</option><option value="pass">Pass</option><option value="fail">Fail</option></select>
          <label class="muted" style="font-size:.8rem">From <input type="date" id="rs-from" class="inp"></label>
          <label class="muted" style="font-size:.8rem">To <input type="date" id="rs-to" class="inp"></label>
        </div>
        <div id="rs-table"></div>
      </div>
    </div>`;

  table = createTable({
    mount: $("#rs-table", root), defaultSort: { key: "when", dir: "desc" },
    empty: { icon: "fa-square-poll-vertical", title: "কোনো ফলাফল পাওয়া যায়নি", text: "ফিল্টার বদলে দেখুন।" },
    rowId: (r) => r.r.id,
    columns: [
      { key: "student", label: "Student", sortable: true, sortValue: (r) => r.name.toLowerCase(), render: (r) =>
        `<div class="row" style="flex-wrap:nowrap;gap:10px">${avatar(r.name, 30)}<div class="cell-main"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.email)}</div></div></div>` },
      { key: "exam", label: "Exam", sortable: true, sortValue: (r) => r.r.examTitle || "", render: (r) => `<div class="cell-main"><div class="t clamp2">${esc(r.r.examTitle || "—")}</div><div class="s">${r.r.examType === "practice" ? "Practice" : "Live"}</div></div>` },
      { key: "score", label: "Score", cls: "c-num", sortable: true, sortValue: (r) => Number(r.r.score) || 0, render: (r) => `${formatScore(r.r.score)}<span class="muted"> / ${r.r.total}</span>` },
      { key: "percent", label: "%", cls: "c-num", sortable: true, sortValue: (r) => Number(r.r.percent) || 0, render: (r) => `<b>${fmtPct(r.r.percent)}</b>` },
      { key: "correct", label: "Right / Wrong", cls: "c-num", sortable: true, sortValue: (r) => Number(r.r.correctCount) || 0, render: (r) =>
        r.r.correctCount === undefined ? `<span class="muted">—</span>` : `<span style="color:var(--accent-teal)">${r.r.correctCount}</span> / <span style="color:var(--accent-coral)">${r.r.wrongCount ?? 0}</span>` },
      { key: "time", label: "Time", cls: "c-num", sortable: true, sortValue: (r) => Number(r.r.timeTakenSeconds) || null, render: (r) => fmtDur(r.r.timeTakenSeconds) },
      { key: "attempts", label: "Tries", cls: "c-num", sortable: true, sortValue: (r) => r.tries, render: (r) => fmtN(r.tries) },
      { key: "rank", label: "Rank", cls: "c-num", sortable: true, sortValue: (r) => r.rank, render: (r) => `#${r.rank}<span class="muted"> / ${r.of}</span>` },
      { key: "result", label: "Result", sortable: true, sortValue: (r) => (r.pass ? 1 : 0), render: (r) => chip(r.pass ? "Pass" : "Fail", r.pass ? "teal" : "coral") },
      { key: "when", label: "Submitted", sortable: true, sortValue: (r) => toMs(r.r.submittedAt), render: (r) => `<span class="muted" title="${esc(fmtDateTime(r.r.submittedAt))}">${ago(r.r.submittedAt)}</span>` },
      { key: "act", label: "", cls: "c-act", render: (r) => `<button type="button" class="icon-btn" data-id="${esc(r.r.id)}" data-act="view" title="Details"><i class="fa-solid fa-eye"></i></button>` },
    ],
  });

  $("#rs-q", root).addEventListener("input", debounce((e) => { f.q = e.target.value; refresh(); }, 150));
  [["exam", "#rs-exam"], ["type", "#rs-type"], ["result", "#rs-result"], ["from", "#rs-from"], ["to", "#rs-to"]].forEach(([k, id]) => $(id, root).addEventListener("change", (e) => { f[k] = e.target.value; refresh(); }));
  $("#rs-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#rs-export", root)?.addEventListener("click", exportCsv);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const b = e.target.closest('[data-act="view"]');
    if (b) openDetail(b.dataset.id);
  });
  onChange((kind) => { if (["results", "exams", "users"].includes(kind)) stale = true; });
  await load();
}

export function activate() { if (stale) load(); }

async function load(opts) {
  table.setState(skeleton(6));
  try {
    const [results, users, exams] = await Promise.all([fetchAllResultsAdmin(opts), fetchAllUsersAdmin(opts), fetchAllExamsAdmin(opts).catch(() => [])]);
    stale = false;
    usersById = Object.fromEntries(users.map((u) => [u.id, u]));
    examsById = Object.fromEntries(exams.map((e) => [e.id, e]));

    // Rank inside each exam: higher % first, then faster, then earlier.
    const byExam = new Map();
    results.forEach((r) => { if (!byExam.has(r.examId)) byExam.set(r.examId, []); byExam.get(r.examId).push(r); });
    const rank = new Map();
    byExam.forEach((list) => {
      list.slice().sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0) || (Number(a.timeTakenSeconds) || 9e9) - (Number(b.timeTakenSeconds) || 9e9) || toMs(a.submittedAt) - toMs(b.submittedAt))
        .forEach((r, i) => rank.set(r.id, { rank: i + 1, of: list.length }));
    });

    rows = results.map((r) => {
      const u = usersById[r.uid];
      return {
        r, name: u?.displayName || (u ? "নাম নেই" : "অজানা"), email: u?.email || r.uid,
        tries: countAttempts(r), rank: rank.get(r.id)?.rank || 0, of: rank.get(r.id)?.of || 0,
        pass: (Number(r.percent) || 0) >= passPercentOf(examsById[r.examId]),
      };
    });
    const sorted = Object.values(examsById).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    // Exams that were deleted but still have results stay selectable.
    const orphan = [...byExam.keys()].filter((id) => !examsById[id]).map((id) => ({ id, title: `${byExam.get(id)[0].examTitle || id} (deleted)` }));
    const keep = $("#rs-exam", root).value;
    $("#rs-exam", root).innerHTML = `<option value="">All exams</option>${[...sorted, ...orphan].map((e) => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join("")}`;
    $("#rs-exam", root).value = [...$("#rs-exam", root).options].some((o) => o.value === keep) ? keep : "";
    f.exam = $("#rs-exam", root).value;
    refresh();
  } catch (err) { table.setState(errorState({ title: "ফলাফল লোড করা যায়নি", text: err?.message || "" })); }
}

function filtered() {
  const q = f.q.trim().toLowerCase();
  const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : 0;
  const to = f.to ? new Date(`${f.to}T23:59:59`).getTime() : 0;
  return rows.filter((x) => {
    const t = toMs(x.r.submittedAt);
    if (f.exam && x.r.examId !== f.exam) return false;
    if (f.type && (x.r.examType === "practice" ? "practice" : "live") !== f.type) return false;
    if (f.result === "pass" && !x.pass) return false;
    if (f.result === "fail" && x.pass) return false;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return !q || `${x.name} ${x.email} ${x.r.examTitle || ""}`.toLowerCase().includes(q);
  });
}

function refresh() {
  const list = filtered();
  const n = list.length;
  const avg = n ? list.reduce((s, x) => s + (Number(x.r.percent) || 0), 0) / n : 0;
  const passed = list.filter((x) => x.pass).length;
  const times = list.map((x) => Number(x.r.timeTakenSeconds) || 0).filter(Boolean);
  $("#rs-kpis", root).innerHTML = `<div class="kpis">
    ${kpi({ label: "Results", value: fmtN(n), sub: `${fmtN(new Set(list.map((x) => x.r.uid)).size)} students` })}
    ${kpi({ label: "Total attempts", value: fmtN(list.reduce((s, x) => s + x.tries, 0)) })}
    ${kpi({ label: "Average score", value: n ? fmtPct(avg) : "—", tone: "accent" })}
    ${kpi({ label: "Pass rate", value: n ? fmtPct((passed / n) * 100) : "—", sub: `${fmtN(passed)} pass · ${fmtN(n - passed)} fail`, tone: "teal" })}
    ${kpi({ label: "Highest", value: n ? fmtPct(Math.max(...list.map((x) => Number(x.r.percent) || 0))) : "—" })}
    ${kpi({ label: "Avg time taken", value: times.length ? fmtDur(times.reduce((a, b) => a + b, 0) / times.length) : "—" })}</div>`;
  table.setRows(list, { keepPage: true });
}

/* ---------- Detail drawer ---------- */
function openDetail(id) {
  const x = rows.find((r) => r.r.id === id);
  if (!x) return;
  const r = x.r, ex = examsById[r.examId];
  const attempts = (Array.isArray(r.attempts) && r.attempts.length ? r.attempts : [r]).slice().reverse();
  const series = attempts.slice().reverse().map((a, i) => ({ label: `#${i + 1}`, value: Number(a.percent) || 0, tone: (Number(a.percent) || 0) >= passPercentOf(ex) ? "teal" : "coral" }));
  openDrawer({
    title: x.name, subtitle: `${r.examTitle || "—"} · ${r.examType === "practice" ? "Practice" : "Live"}`, width: 580,
    html: `
    <div class="mini-stats">
      <div class="mini-stat"><b>${formatScore(r.score)} / ${r.total}</b><span>Score</span></div>
      <div class="mini-stat"><b>${fmtPct(r.percent)}</b><span>Percentage</span></div>
      <div class="mini-stat"><b>#${x.rank}<small class="muted"> / ${x.of}</small></b><span>Rank in exam</span></div>
      <div class="mini-stat"><b>${r.correctCount ?? "—"}</b><span>Correct</span></div>
      <div class="mini-stat"><b>${r.wrongCount ?? "—"}</b><span>Wrong</span></div>
      <div class="mini-stat"><b>${r.unansweredCount ?? "—"}</b><span>Unanswered</span></div></div>
    <div class="row">${chip(x.pass ? "Pass" : "Fail", x.pass ? "teal" : "coral")}<span class="muted" style="font-size:.84rem">Pass line: ${passPercentOf(ex)}%${ex ? ` (${passMarksOf(ex)} marks)` : ""}${Number(r.negativeMarking) > 0 ? ` · negative marking −${r.negativeMarking}` : ""}</span></div>
    <dl class="kv"><dt>Student</dt><dd>${esc(x.name)}<br><span class="muted">${esc(x.email)}</span></dd>
      <dt>Time taken</dt><dd>${fmtDur(r.timeTakenSeconds)}</dd><dt>Submitted</dt><dd>${fmtDateTime(r.submittedAt)}</dd><dt>Total attempts</dt><dd>${x.tries}</dd></dl>
    ${series.length > 1 ? `<div><h3>Progress across attempts</h3>${colChart({ bins: series, height: 110, format: (v) => `${v}%` })}</div>` : ""}
    <div><h3>Attempt history</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Try</th><th class="c-num">Score</th><th class="c-num">%</th><th class="c-num">Time</th><th>When</th></tr></thead><tbody>${attempts.map((a, i) => `<tr>
      <td data-label="Try">#${attempts.length - i}</td><td data-label="Score" class="c-num">${formatScore(a.score)} / ${a.total}</td><td data-label="%" class="c-num">${fmtPct(a.percent)}</td>
      <td data-label="Time" class="c-num">${fmtDur(a.timeTakenSeconds)}</td><td data-label="When" class="muted">${fmtDateTime(a.submittedAt || r.submittedAt)}</td></tr>`).join("")}</tbody></table></div>
      ${x.tries > attempts.length ? `<p class="muted" style="font-size:.78rem;margin-top:6px">শুধু সর্বশেষ ${attempts.length}টি চেষ্টার বিবরণ সংরক্ষিত থাকে।</p>` : ""}</div>`,
  });
}

function exportCsv() {
  const list = table.allRows();
  if (!list.length) { toast("এক্সপোর্ট করার মতো কিছু নেই", "info"); return; }
  const data = [["Student", "Email", "Exam", "Type", "Score", "Total", "Percent", "Correct", "Wrong", "Unanswered", "Time (s)", "Attempts", "Rank", "Of", "Result", "Submitted"]];
  list.forEach((x) => data.push([
    x.name, x.email, x.r.examTitle || "", x.r.examType === "practice" ? "Practice" : "Live", formatScore(x.r.score), x.r.total, `${x.r.percent}%`,
    x.r.correctCount ?? "", x.r.wrongCount ?? "", x.r.unansweredCount ?? "", x.r.timeTakenSeconds ?? "", x.tries, x.rank, x.of, x.pass ? "Pass" : "Fail", fmtDateTime(x.r.submittedAt),
  ]));
  downloadCsv(`exam-results-${new Date().toISOString().slice(0, 10)}.csv`, data);
}
