// ==========================================================================
// admin/exams.js — Exam management: searchable/filterable list, status (draft/published),
// bulk actions, per-exam statistics, and the full exam editor (settings + questions).
// The editor and the atomic save/delete logic are the original ones; this version adds
// status, subject/category, pass mark, instructions, a Question Bank picker and an audit trail.
// ==========================================================================
import { db } from "../firebase-config.js";
import {
  collection, getDocs, query, orderBy, Timestamp, doc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  toast, escapeHtml, formatDateTime, openModal, closeModal, confirmAction,
  getExamAvailability, getCoursePricing, formatScore,
} from "../utils.js";
import {
  QUESTION_FORMAT, fetchAllExamsAdmin, primeAdminExams, isAdminExamsCached, fetchQuestionsAdmin,
  saveExamDoc, deleteExamCompletely, migrateExamQuestions, syncExamIndex, writeExamIndex,
  fetchAllResultsAdmin, backfillUserStats, countAttempts,
} from "../exam-data.js";
import * as cache from "../cache.js";
import { courses } from "./admin.js";
import {
  esc, $, fmtN, fmtPct, fmtDur, pageHead, chip, segmented, bindSegmented, createTable, bulkBar,
  confirmDanger, openDrawer, withBusy, emptyState, errorState, skeleton, debounce, ago, toMs, avatar,
} from "./core/ui.js";
import { can } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { emitChange, takePending, onChange } from "./core/bus.js";
import { getSettings } from "./core/settings.js";
import { loadTaxonomy, subjectName, categoryPath, subjectOptionsHtml, categoryOptionsHtml, categoryOptions, subjectOptions } from "./core/taxonomy.js";
import { examState, STATE_META, isDraft, passPercentOf, totalMarksOf, passMarksOf } from "./core/exam-status.js";
import { columns as colChart } from "./core/charts.js";
import { loadBank, saveBank, qHash, normQuestion } from "./core/qbank.js";
import { resultsForExam, usersByIds } from "./core/data.js";
import { examSummary, questionPerformance } from "./core/exam-analytics.js";
import { fetchExamStartsAdmin } from "../exam-data.js";
import { DIFFICULTY, startOfDay, addDays, endOfDay } from "../schedule-core.js";
import { isExamRandomPool as isRandomPool } from "../utils.js";
import { openBankPicker } from "./core/bank-picker.js";

/* ==========================================================================
   Exam management
   ========================================================================== */
export let currentExams = [];

/* ==========================================================================
   List page
   ========================================================================== */
let root = null, table = null, updateBulk = () => {}, staleExams = false, loadFailed = false;
const filters = { q: "", status: "all", type: "", subject: "", category: "", course: "", difficulty: "", date: "" };

export async function mount(el) {
  root = el;
  await loadTaxonomy().catch(() => {});
  const canWrite = can("exams.write");
  root.innerHTML = `
    ${pageHead({
      title: "Exams",
      desc: "এক্সাম তৈরি, এডিট, পাবলিশ ও পরিসংখ্যান — এক জায়গা থেকে।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="exams-refresh-btn" title="Re-read the exams from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${canWrite ? `<button type="button" class="btn btn-outline btn-sm" id="optimize-exams-btn" title="One-time: bundle old questions, build student summaries and the exam index (cuts Firestore reads/writes)"><i class="fa-solid fa-bolt"></i> Optimize</button>
        <button type="button" class="btn btn-primary btn-sm" id="add-exam-btn-top"><i class="fa-solid fa-plus"></i> New exam</button>` : ""}`,
    })}
    <div class="panel">
      <div class="toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="ex-q" placeholder="Search title, course, subject…" autocomplete="off"></div>
        <select id="ex-type" aria-label="Type"><option value="">All types</option><option value="live">Live</option><option value="practice">Practice</option></select>
        <select id="ex-subject" aria-label="Subject"></select>
        <select id="ex-category" aria-label="Category"></select>
        <select id="ex-course" aria-label="Course"></select>
        <select id="ex-difficulty" aria-label="Difficulty"><option value="">Any difficulty</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
        <select id="ex-date" aria-label="Start date"><option value="">Any start date</option><option value="today">Starts today</option><option value="week">Starts in the next 7 days</option><option value="past">Started before today</option><option value="none">No start date</option></select>
      </div>
      <div class="toolbar" id="ex-seg"></div>
      <div id="exams-table-mount"></div>
    </div>
    <div id="exams-bulk"></div>`;

  table = createTable({
    mount: $("#exams-table-mount", root),
    selectable: canWrite || can("exams.delete"),
    onSelect: (ids) => updateBulk(ids.length),
    defaultSort: { key: "created", dir: "desc" },
    empty: { icon: "fa-file-pen", title: "কোনো এক্সাম পাওয়া যায়নি", text: "ফিল্টার বদলান, অথবা নতুন এক্সাম তৈরি করুন।" },
    columns: examColumns(),
  });
  updateBulk = bulkBar($("#exams-bulk", root), [
    ...(canWrite ? [{ id: "publish", label: "Publish", icon: "fa-eye", tone: "teal" }, { id: "unpublish", label: "Unpublish", icon: "fa-eye-slash" }] : []),
    ...(can("exams.delete") ? [{ id: "delete", label: "Delete", icon: "fa-trash", tone: "coral" }] : []),
  ], onBulk);

  fillFilters();
  bindSegmented($("#ex-seg", root), (v) => { filters.status = v; refreshList(); });
  $("#ex-q", root).addEventListener("input", debounce((e) => { filters.q = e.target.value; refreshList(); }, 150));
  ["type", "subject", "category", "course", "difficulty", "date"].forEach((k) => $(`#ex-${k}`, root).addEventListener("change", (e) => { filters[k] = e.target.value; refreshList(); }));
  $("#exams-refresh-btn", root).addEventListener("click", () => loadExamsTable({ force: true }));
  $("#optimize-exams-btn", root)?.addEventListener("click", optimizeAll);
  $("#add-exam-btn-top", root)?.addEventListener("click", () => openExamModal(null));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return loadExamsTable({ force: true });
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    ({
      stats: () => openExamStats(id), edit: () => openExamModal(id), dup: () => duplicateExam(id),
      practice: () => duplicateExam(id, { asPractice: true }), toggle: () => setStatus([id], isDraft(currentExams.find((x) => x.id === id)) ? "published" : "draft"),
      delete: () => deleteExam(id),
    })[b.dataset.act]?.();
  });
  onChange((kind) => { if (kind === "exams") staleExams = true; });

  await loadExamsTable();
  if (takePending("new-exam") && canWrite) openExamModal(null);
}

export async function activate() {
  if (!table) return;
  await loadTaxonomy().catch(() => {});
  fillFilters();
  if (loadFailed) return loadExamsTable(); // the last read failed — opening the page again retries it
  if (staleExams) { staleExams = false; currentExams = await fetchAllExamsAdmin(); }
  refreshList();
  if (takePending("new-exam") && can("exams.write")) openExamModal(null);
}

function fillFilters() {
  const keep = (id, html) => { const el = $(id, root); const v = el.value; el.innerHTML = html; el.value = [...el.options].some((o) => o.value === v) ? v : ""; };
  keep("#ex-subject", subjectOptionsHtml("", "All subjects"));
  keep("#ex-category", categoryOptionsHtml("exam", "", "All categories"));
  keep("#ex-course", `<option value="">All courses</option>` + courses.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join(""));
  filters.subject = $("#ex-subject", root).value; filters.category = $("#ex-category", root).value; filters.course = $("#ex-course", root).value;
}

export async function loadExamsTable(opts) {
  if (!table) return;
  table.setState(skeleton(5));
  try {
    const wasCached = isAdminExamsCached();
    currentExams = await fetchAllExamsAdmin(opts);
    loadFailed = false;
    refreshList();
    // What we just read IS the truth — make sure the students' index matches it (1 read; a write only if something differs).
    if (!wasCached || cache.wantsFresh(opts)) syncExamIndex(currentExams, courses).catch(() => { /* retried on the next fresh load */ });
  } catch (err) {
    loadFailed = true;
    table.setState(errorState({ title: "এক্সাম লোড করা যায়নি", text: err?.message || "" }));
  }
}

function filtered() {
  const q = filters.q.trim().toLowerCase();
  return currentExams.filter((e) => {
    if (filters.status !== "all" && examState(e) !== filters.status) return false;
    if (filters.type && (e.examType === "practice" ? "practice" : "live") !== filters.type) return false;
    if (filters.subject && e.subjectId !== filters.subject) return false;
    if (filters.category && e.categoryId !== filters.category) return false;
    if (filters.course && (e.courseId || "") !== filters.course) return false;
    if (filters.difficulty && (e.difficulty || "") !== filters.difficulty) return false;
    if (filters.date) {
      const t = toMs(e.publishAt), ds = startOfDay(Date.now());
      if (filters.date === "today" && !(t >= ds && t < endOfDay(ds))) return false;
      if (filters.date === "week" && !(t >= ds && t < addDays(ds, 7))) return false;
      if (filters.date === "past" && !(t && t < ds)) return false;
      if (filters.date === "none" && t) return false;
    }
    return !q || `${e.title} ${e.courseName || ""} ${subjectName(e.subjectId)} ${categoryPath(e.categoryId)}`.toLowerCase().includes(q);
  });
}

function renderSeg() {
  const counts = { all: currentExams.length, open: 0, scheduled: 0, closed: 0, draft: 0 };
  currentExams.forEach((e) => { counts[examState(e)]++; });
  $("#ex-seg", root).innerHTML = segmented([
    { id: "all", label: "All", count: counts.all }, { id: "open", label: "Open", count: counts.open },
    { id: "scheduled", label: "Scheduled", count: counts.scheduled }, { id: "closed", label: "Closed", count: counts.closed },
    { id: "draft", label: "Draft", count: counts.draft },
  ], filters.status);
}

function refreshList() {
  if (!table) return;
  renderSeg();
  table.setRows(filtered(), { keepPage: true });
}

/** Keep the shared copy, the table, the students' index and other pages in step after ANY exam change (no re-scan). */
function afterExamsChanged() {
  primeAdminExams(currentExams);
  refreshList();
  writeExamIndex(currentExams, courses).catch(() => { /* self-heals via syncExamIndex on the next fresh load */ });
  staleExams = false;
  emitChange("exams");
}

function examColumns() {
  const canWrite = can("exams.write"), canDel = can("exams.delete");
  return [
    { key: "title", label: "Exam", sortable: true, sortValue: (e) => e.title || "", render: (e) => {
      const sub = [subjectName(e.subjectId), categoryPath(e.categoryId), e.courseName].filter(Boolean).join(" · ");
      return `<div class="cell-main"><div class="t">${e.featured ? '<i class="fa-solid fa-star" style="color:var(--accent-amber)" title="Featured on the home page"></i> ' : ""}${esc(e.title || "Untitled")}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
    } },
    { key: "status", label: "Status", sortable: true, sortValue: (e) => examState(e), render: (e) => {
      const st = examState(e), m = STATE_META[st], av = getExamAvailability(e);
      const hint = st === "scheduled" ? `Opens ${formatDateTime(av.publishAt)}` : st === "closed" ? `Closed ${formatDateTime(av.closesAt)}` : st === "open" && av.closesAt ? `Closes ${formatDateTime(av.closesAt)}` : st === "open" ? "Always open" : "Hidden from students";
      return `${chip(m.label, m.tone)}${e.cancelled ? ` ${chip("Cancelled", "coral")}` : ""}<div class="muted" style="font-size:.74rem;margin-top:3px">${esc(hint)}</div>`;
    } },
    { key: "type", label: "Type", sortable: true, sortValue: (e) => e.examType || "live", render: (e) => e.examType === "practice" ? chip("Practice", "", "fa-dumbbell") : chip("Live", "accent", "fa-satellite-dish") },
    { key: "questions", label: "Questions", cls: "c-num", sortable: true, sortValue: (e) => Number(e.questionCount) || 0, render: (e) =>
      e.questionsPerAttempt > 0 && e.questionsPerAttempt < (e.questionCount || 0)
        ? `${e.questionsPerAttempt}<span class="muted"> / ${e.questionCount}</span>` : String(e.questionCount || 0) },
    { key: "marks", label: "Marks / Pass", cls: "c-num", sortValue: (e) => totalMarksOf(e), sortable: true, render: (e) => `${formatScore(totalMarksOf(e))}<span class="muted"> / ${passMarksOf(e)}</span>` },
    { key: "time", label: "Time", cls: "c-num", sortable: true, sortValue: (e) => Number(e.duration) || 0, render: (e) => `${e.duration || 0} min` },
    { key: "created", label: "Created", sortable: true, sortValue: (e) => (e.createdAt?.seconds || 0), render: (e) => `<span class="muted">${ago(e.createdAt)}</span>` },
    { key: "act", label: "", cls: "c-act", render: (e) => `<div class="row-actions">
      <button type="button" class="icon-btn" data-act="stats" data-id="${e.id}" title="Statistics"><i class="fa-solid fa-chart-simple"></i></button>
      ${canWrite ? `<button type="button" class="icon-btn" data-act="edit" data-id="${e.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="icon-btn" data-act="dup" data-id="${e.id}" title="Duplicate (saved as a draft)"><i class="fa-solid fa-clone"></i></button>
      ${e.examType !== "practice" ? `<button type="button" class="icon-btn" data-act="practice" data-id="${e.id}" title="Create a Practice copy"><i class="fa-solid fa-dumbbell"></i></button>` : ""}
      <button type="button" class="icon-btn" data-act="toggle" data-id="${e.id}" title="${isDraft(e) ? "Publish" : "Unpublish (move to draft)"}"><i class="fa-solid ${isDraft(e) ? "fa-eye" : "fa-eye-slash"}"></i></button>` : ""}
      ${canDel ? `<button type="button" class="icon-btn danger" data-act="delete" data-id="${e.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ""}
    </div>` },
  ];
}

/* ---------- Publish / unpublish (single or bulk) ---------- */
async function setStatus(ids, status) {
  const list = ids.map((id) => currentExams.find((e) => e.id === id)).filter((e) => e && isDraft(e) !== (status === "draft"));
  if (!list.length) { toast("কোনো পরিবর্তন নেই", "info"); return; }
  if (status === "published") {
    const empty = list.find((e) => !(Number(e.questionCount) > 0));
    if (empty) { toast(`"${empty.title}" এ কোনো প্রশ্ন নেই — প্রকাশের আগে প্রশ্ন যোগ করুন`, "error"); return; }
  }
  try {
    for (let i = 0; i < list.length; i += 400) {
      const batch = writeBatch(db);
      list.slice(i, i + 400).forEach((e) => batch.update(doc(db, "exams", e.id), { status }));
      await batch.commit();
    }
    list.forEach((e) => { e.status = status; logAction(status === "draft" ? "exam.unpublish" : "exam.publish", { type: "exam", id: e.id, label: e.title }); });
    toast(status === "draft" ? `${list.length}টি এক্সাম আনপাবলিশ হয়েছে` : `${list.length}টি এক্সাম পাবলিশ হয়েছে`, "success");
    table?.clearSelection();
    afterExamsChanged();
  } catch { toast("স্ট্যাটাস বদলানো যায়নি", "error"); }
}

async function onBulk(action) {
  const ids = table.getSelected();
  if (action === "clear") return table.clearSelection();
  if (action === "publish") return setStatus(ids, "published");
  if (action === "unpublish") return setStatus(ids, "draft");
  if (action === "delete") {
    if (!(await confirmDanger({ title: `${ids.length}টি এক্সাম মুছবেন?`, message: "নির্বাচিত এক্সামগুলো ও তাদের প্রশ্ন স্থায়ীভাবে মুছে যাবে। শিক্ষার্থীদের পুরোনো ফলাফল থেকে যাবে।", confirmLabel: `Delete ${ids.length}`, phrase: "delete" }))) return;
    let ok = 0;
    for (const id of ids) {
      const ex = currentExams.find((x) => x.id === id);
      if (!ex) continue;
      try { await deleteExamCompletely(id, ex); currentExams = currentExams.filter((x) => x.id !== id); logAction("exam.delete", { type: "exam", id, label: ex.title }); ok++; } catch { /* keep going */ }
    }
    toast(`${ok}/${ids.length}টি এক্সাম মুছে ফেলা হয়েছে`, ok === ids.length ? "success" : "error");
    table.clearSelection();
    afterExamsChanged();
  }
}

/* ---------- Duplicate: an exact copy saved as a DRAFT (or a Practice copy of a Live exam, as before) ---------- */
async function duplicateExam(examId, { asPractice = false } = {}) {
  const ex = currentExams.find((x) => x.id === examId);
  if (!ex) return;
  if (asPractice && !(await confirmAction(`"${ex.title}" এর একটি Practice কপি তৈরি করবেন? (একই প্রশ্নব্যাংক সহ, নতুন এক্সাম হিসেবে)`))) return;
  try {
    const questions = await fetchQuestionsAdmin(ex.id, ex); // 1 read for a bundle exam
    const { id, createdAt, publishAt, closesAt, availableHours, qFormat, qChunks, scheduleUpdatedAt, ...rest } = ex;
    // A copy starts clean: not featured, not cancelled, registration open (it inherits everything else).
    const freshFlags = { featured: false, cancelled: false, registration: "open" };
    const data = asPractice
      ? { ...rest, ...freshFlags, title: `${ex.title} (Practice)`, examType: "practice", status: "published", publishAt: null, closesAt: null, availableHours: 0 }
      : { ...rest, ...freshFlags, title: `${ex.title} (Copy)`, status: "draft", publishAt: null, closesAt: null, availableHours: 0 };
    const saved = await saveExamDoc({ data, questions }); // exam + whole question bank = one atomic write
    currentExams.unshift({
      id: saved.id, ...data, createdAt: Timestamp.now(),
      ...(saved.format === QUESTION_FORMAT ? { qFormat: QUESTION_FORMAT, qChunks: saved.chunks } : {}),
    });
    logAction("exam.duplicate", { type: "exam", id: saved.id, label: data.title, detail: `from ${ex.title}` });
    toast(asPractice ? "Practice exam তৈরি হয়েছে" : "কপি তৈরি হয়েছে (Draft) — প্রকাশের আগে দেখে নিন", "success");
    afterExamsChanged();
  } catch {
    toast("Could not duplicate", "error");
  }
}

/* ---------- Per-exam statistics drawer (exam analytics) ---------- */
async function openExamStats(examId) {
  const ex = currentExams.find((x) => x.id === examId);
  if (!ex) return;
  const d = openDrawer({ title: ex.title, subtitle: `${ex.examType === "practice" ? "Practice" : "Live"} exam · ${STATE_META[examState(ex)].label}`, width: 640, html: skeleton(5) });
  try {
    const [rows, starts] = await Promise.all([resultsForExam(examId), fetchExamStartsAdmin(examId)]);
    const pass = passPercentOf(ex);
    const sum = examSummary({ rows, starts, passPercent: pass });
    const pcts = rows.map((r) => Number(r.percent) || 0);
    const bins = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}`, value: 0, tone: i * 10 + 10 <= pass - 1 ? "coral" : "teal" }));
    pcts.forEach((p) => { bins[Math.min(9, Math.floor(p / 10))].value++; });
    const ranked = rows.slice().sort((a, b) => (Number(b.percent) || 0) - (Number(a.percent) || 0) || (Number(a.timeTakenSeconds) || 9e9) - (Number(b.timeTakenSeconds) || 9e9));
    const shown = [...ranked.slice(0, 5), ...ranked.slice(-3).filter((r) => !ranked.slice(0, 5).includes(r))];
    const users = await usersByIds(shown.map((r) => r.uid)).catch(() => ({}));
    const person = (r) => { const u = users[r.uid]; return u?.displayName || u?.email || (u?.missing ? "Deleted user" : "Student"); };
    const has = rows.length > 0;
    const tile = (v, label) => `<div class="mini-stat"><b>${v}</b><span>${label}</span></div>`;

    d.body.innerHTML = `
      <div class="mini-stats">
        ${tile(fmtN(sum.participants), "Participants")}
        ${tile(fmtN(sum.completed), "Completed attempts")}
        ${tile(sum.abandoned === null ? "—" : fmtN(sum.abandoned), "Abandoned")}
        ${tile(has ? fmtPct(sum.avg) : "—", "Average score")}
        ${tile(has ? fmtPct(sum.highest) : "—", "Highest")}
        ${tile(has ? fmtPct(sum.lowest) : "—", "Lowest")}
        ${tile(has ? fmtPct(sum.passRate) : "—", `Pass rate (≥ ${pass}%)`)}
        ${tile(has ? fmtPct(sum.failRate) : "—", "Fail rate")}
        ${tile(sum.avgTimeSeconds ? fmtDur(sum.avgTimeSeconds) : "—", "Avg completion time")}
      </div>
      <p class="muted" style="font-size:.76rem">${sum.abandoned === null ? "Abandoned = শুরু করেও জমা না দেওয়া অ্যাটেম্পট — এখনো ট্র্যাক হচ্ছে না (firestore.rules পাবলিশ করুন; ট্র্যাকিং চালুর পর থেকে গণনা হবে)।" : `Abandoned = শুরু করেও জমা না দেওয়া অ্যাটেম্পট (${fmtN(sum.startedStudents)} জন শুরু করেছিল; ট্র্যাকিং চালুর পর থেকে)।`} Score-গুলো প্রতিজন শিক্ষার্থীর সর্বশেষ অ্যাটেম্পটের।</p>
      <div><h3>Score distribution</h3>${has ? colChart({ bins, height: 120 }) : emptyState({ icon: "fa-chart-simple", title: "এখনো কেউ এক্সাম দেয়নি" })}
        ${has ? `<p class="muted" style="font-size:.76rem;margin-top:6px">নিচের অক্ষ = স্কোর শুরু (%); লাল = পাস মার্কের নিচে।</p>` : ""}</div>
      ${has ? `<div><h3>Top & bottom performers</h3><ul class="feed">${shown.map((r) => `<li>${avatar(person(r), 30)}<div style="flex:1;min-width:0"><div class="feed-t">${esc(person(r))}</div><div class="feed-s">${fmtDur(r.timeTakenSeconds)} · attempt #${countAttempts(r)}</div></div>${chip(fmtPct(r.percent), (Number(r.percent) || 0) >= pass ? "teal" : "coral")}</li>`).join("")}</ul></div>` : ""}
      ${has ? `<details id="stats-qw" class="qw"><summary><h3 style="display:inline">Question-wise performance</h3> <span class="muted">— tap to load</span></summary><div id="stats-qw-body" class="qw-body"></div></details>` : ""}
      <div><h3>Settings</h3><dl class="kv">
        <dt>Total marks</dt><dd>${formatScore(totalMarksOf(ex))} (1 per correct answer)</dd>
        <dt>Pass mark</dt><dd>${passMarksOf(ex)} (${pass}%)</dd>
        <dt>Time limit</dt><dd>${ex.duration || 0} minutes</dd>
        <dt>Difficulty</dt><dd>${esc(DIFFICULTY[ex.difficulty]?.label || "—")}</dd>
        <dt>Subject</dt><dd>${esc(subjectName(ex.subjectId) || "—")}</dd>
        <dt>Category</dt><dd>${esc(categoryPath(ex.categoryId) || "—")}</dd>
        <dt>Options</dt><dd>${examSettingsBadges(ex)}</dd></dl></div>
      ${can("exams.write") ? `<div class="row"><button type="button" class="btn btn-primary btn-sm" id="stats-edit"><i class="fa-solid fa-pen"></i> Edit exam</button></div>` : ""}`;
    d.body.querySelector("#stats-edit")?.addEventListener("click", () => { d.close(); openExamModal(examId); });

    // Question-wise: only when asked (it reads the exam's question bundle once for the "easiest" list).
    d.body.querySelector("#stats-qw")?.addEventListener("toggle", async (ev) => {
      const box = d.body.querySelector("#stats-qw-body");
      if (!ev.target.open || box.dataset.done) return;
      box.dataset.done = "1";
      box.innerHTML = skeleton(3);
      const pool = isRandomPool(ex);
      let questions = null;
      if (!pool) { try { questions = await fetchQuestionsAdmin(ex.id, ex); } catch { questions = null; } }
      const qp = questionPerformance({ rows, questions, randomPool: pool });
      const list = (title, items, fmt) => `<div class="qw-col"><h4>${title}</h4>${items.length ? `<ol>${items.map((q) => `<li><span class="clamp2">${esc(q.text)}</span><b>${fmt(q)}</b></li>`).join("")}</ol>` : '<p class="muted">—</p>'}</div>`;
      box.innerHTML = qp.hasData
        ? `<p class="muted" style="font-size:.78rem">${fmtN(qp.base)}টি অ্যাটেম্পটের সংরক্ষিত রিভিউ থেকে (রিভিউ শুধু ৪৮ ঘণ্টা থাকে, আর শুধু ভুল/স্কিপ করা প্রশ্ন সংরক্ষিত হয়)।</p>
          <div class="qw-grid">
            ${list("Most difficult", qp.mostDifficult, (q) => `${Math.round(q.wrongRate)}% missed`)}
            ${list("Most incorrect", qp.mostIncorrect, (q) => `${q.answeredWrong}× wrong`)}
            ${list("Most skipped", qp.mostSkipped, (q) => `${q.blank}× skipped`)}
            ${list("Easiest", qp.easiest, (q) => `${Math.round(100 - q.wrongRate)}% correct`)}
          </div>${qp.easiestNote ? `<p class="muted" style="font-size:.76rem">${esc(qp.easiestNote)}</p>` : ""}`
        : emptyState({ icon: "fa-circle-question", title: "সংরক্ষিত রিভিউ নেই", text: "রিভিউ ৪৮ ঘণ্টা পর মুছে যায় — নতুন অ্যাটেম্পটের পর আবার দেখুন।" });
    });
  } catch (err) {
    d.body.innerHTML = errorState({ title: "পরিসংখ্যান লোড করা যায়নি", text: err?.message || "", retry: false });
  }
}

/* ---------- Practice (always open, no schedule) vs Live (scheduled) ---------- */
function examTypeBadge(ex) {
  return ex.examType === "practice"
    ? `<span class="badge" title="Always open — students can retake anytime"><i class="fa-solid fa-dumbbell"></i> Practice</span>`
    : `<span class="badge badge-teal" title="Follows the publish schedule below"><i class="fa-solid fa-satellite-dish"></i> Live</span>`;
}

/* ---------- What this exam actually covers — whole course vs specific lesson(s) ---------- */
function examScopeBadge(ex) {
  if (!ex.courseId) return `<span class="badge">Open to Everyone</span>`;
  if (ex.lessonIds?.length) {
    const names = (ex.lessonNames || []).join(", ");
    return `<span class="badge badge-teal" title="${escapeHtml(names)}"><i class="fa-solid fa-list-check"></i> ${ex.lessonIds.length === 1 ? "1 Lesson" : `${ex.lessonIds.length} Lessons`}</span>`;
  }
  return `<span class="badge badge-amber"><i class="fa-solid fa-graduation-cap"></i> Whole Course</span>`;
}

function examSettingsBadges(ex) {
  const attemptsBadge = ex.maxAttempts > 0
    ? `<span class="badge badge-amber" title="Maximum ${ex.maxAttempts} attempts allowed"><i class="fa-solid fa-rotate"></i> ${ex.maxAttempts}x</span>`
    : `<span class="badge badge-teal" title="Unlimited attempts"><i class="fa-solid fa-infinity"></i> Unlimited</span>`;
  const layoutBadge = ex.layout === "all"
    ? `<span class="badge" title="All questions on one page"><i class="fa-solid fa-list"></i> All at once</span>`
    : `<span class="badge" title="One question at a time"><i class="fa-solid fa-layer-group"></i> One by one</span>`;
  const shuffleBadge = ex.shuffle !== false
    ? `<span class="badge" title="Questions and options are shuffled"><i class="fa-solid fa-shuffle"></i> Shuffle</span>`
    : "";
  const negBadge = Number(ex.negativeMarking) > 0
    ? `<span class="badge badge-coral" title="Deducted per wrong answer"><i class="fa-solid fa-triangle-exclamation"></i> −${formatScore(ex.negativeMarking)}/wrong</span>`
    : "";
  const poolBadge = ex.questionsPerAttempt > 0 && ex.questionsPerAttempt < (ex.questionCount || 0)
    ? `<span class="badge badge-teal" title="A random ${ex.questionsPerAttempt} of ${ex.questionCount} questions is drawn on every attempt"><i class="fa-solid fa-dice"></i> Random Pool</span>`
    : "";
  return `<div class="settings-badges">${attemptsBadge}${layoutBadge}${shuffleBadge}${negBadge}${poolBadge}</div>`;
}

function scheduleBadge(ex) {
  const { state, publishAt, closesAt } = getExamAvailability(ex);
  if (state === "upcoming") return `<span class="badge badge-amber" title="${formatDateTime(publishAt)}"><i class="fa-solid fa-lock"></i> Scheduled</span>`;
  if (state === "closed") return `<span class="badge badge-coral" title="${formatDateTime(closesAt)}"><i class="fa-solid fa-stopwatch"></i> Closed</span>`;
  if (closesAt) return `<span class="badge badge-teal" title="${formatDateTime(closesAt)}"><i class="fa-solid fa-circle" style="color:#22c55e"></i> Open</span>`;
  return `<span class="badge badge-teal"><i class="fa-solid fa-circle" style="color:#22c55e"></i> Always Open</span>`;
}

/* ---------- Firestore Timestamp → <input type="datetime-local"> value ---------- */
function toDatetimeLocalValue(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


async function openExamModal(examId) {
  const ex = examId ? currentExams.find((x) => x.id === examId) : null;
  let questionDrafts = [];
  if (ex) {
    // One bundle document for an up-to-date exam (1 read); the old per-question docs only for exams not optimised yet.
    const loaded = await fetchQuestionsAdmin(ex.id, ex);
    questionDrafts = loaded.map((q) => ({ text: q.text, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation || "" }));
  }

  const overlay = openModal(`
    <div class="modal-head"><h3>${ex ? "Edit Exam" : "Create New Exam"}</h3><button class="modal-close-btn" data-modal-close><i class="fa-solid fa-xmark"></i></button></div>
    <form id="exam-modal-form">
      <div class="exam-tabs">
        <button type="button" class="exam-tab-btn active" data-tab="settings" id="em-tab-btn-settings"><i class="fa-solid fa-sliders"></i> Info & Settings</button>
        <button type="button" class="exam-tab-btn" data-tab="questions" id="em-tab-btn-questions"><i class="fa-solid fa-list-check"></i> Questions <span class="exam-tab-count" id="em-tab-q-count">0</span></button>
      </div>

      <div class="exam-tab-panel" id="em-panel-settings">
        <div class="field">
          <label>Exam Type</label>
          <select id="em-exam-type">
            <option value="live" ${!ex || ex.examType !== "practice" ? "selected" : ""}>Live — follows a publish schedule (shows in Upcoming, then Live)</option>
            <option value="practice" ${ex && ex.examType === "practice" ? "selected" : ""}>Practice — always open, students can retake anytime (shows in Practice)</option>
          </select>
          <span class="form-hint">This decides which of the three student-facing tabs (Upcoming / Live / Practice) the exam shows up under</span>
        </div>
        <div class="admin-grid">
          <div class="field">
            <label>Status</label>
            <select id="em-status">
              <option value="published" ${!ex || ex.status !== "draft" ? "selected" : ""}>Published — visible to students (follows the schedule below)</option>
              <option value="draft" ${ex && ex.status === "draft" ? "selected" : ""}>Draft — hidden from students until you publish</option>
            </select>
          </div>
          <div class="field"><label>Subject</label><select id="em-subject">${subjectOptionsHtml(ex?.subjectId || "")}</select></div>
        </div>
        <div class="field"><label>Category</label><select id="em-category">${categoryOptionsHtml("exam", ex?.categoryId || "")}</select><span class="form-hint">Subjects and categories are managed under Subjects & Categories</span></div>
        <div class="admin-grid">
          <div class="field"><label>Difficulty</label><select id="em-difficulty"><option value="">— Not set —</option>${Object.entries(DIFFICULTY).map(([k, v]) => `<option value="${k}" ${ex?.difficulty === k ? "selected" : ""}>${v.label}</option>`).join("")}</select></div>
          <div class="field"><label>Home page</label><label class="switch-row"><input type="checkbox" id="em-featured" ${ex?.featured ? "checked" : ""}> Featured exam (shown prominently)</label></div>
        </div>
        <div class="admin-grid">
          <div class="field"><label>Exam Title</label><input type="text" id="em-title" required value="${ex ? escapeHtml(ex.title) : ""}"></div>
          <div class="field"><label>Course Name (as tag)</label><input type="text" id="em-course" value="${ex ? escapeHtml(ex.courseName || "") : ""}"></div>
        </div>
        <div class="field">
          <label>Linked Course (only enrolled students will see this exam)</label>
          <select id="em-course-id">
            <option value="">— Not linked to any course (open to everyone) —</option>
            ${courses.map((cc) => `<option value="${cc.id}" ${ex && ex.courseId === cc.id ? "selected" : ""}>${escapeHtml(cc.title)}${getCoursePricing(cc).isPaid ? " (Paid)" : " (Free)"}</option>`).join("")}
          </select>
          <span class="form-hint">If you link a course, only students enrolled in that course will be able to see or take this exam — unenrolled students won't see it in their list at all</span>
        </div>

        <div class="field" id="em-scope-field" hidden>
          <label>Exam Covers</label>
          <select id="em-scope">
            <option value="course">Whole Course (every lesson)</option>
            <option value="lessons">Specific Lesson(s) only</option>
          </select>
          <span class="form-hint">"Specific Lesson(s)" lets you build one exam for a single lesson, or pick several lessons at once</span>
        </div>
        <div class="field" id="em-lessons-field" hidden>
          <label>Select Lesson(s)</label>
          <div class="lesson-picker" id="em-lesson-picker"><div class="empty-state" style="padding:14px;">Loading lessons...</div></div>
        </div>

        <div class="field"><label>Description</label><textarea id="em-desc" rows="2">${ex ? escapeHtml(ex.description || "") : ""}</textarea></div>
        <div class="field"><label>Instructions for students (shown before the exam starts)</label><textarea id="em-instructions" rows="3" placeholder="e.g. Calculators are not allowed. Each correct answer is 1 mark.">${ex ? escapeHtml(ex.instructions || "") : ""}</textarea></div>
        <div class="admin-grid">
          <div class="field"><label>Time Limit (minutes, during the exam)</label><input type="number" id="em-duration" min="1" value="${ex ? ex.duration || 10 : 10}"></div>
          <div class="field"><label>Maximum Attempts Allowed</label><input type="number" id="em-max-attempts" min="0" placeholder="Leave empty or 0 for unlimited" value="${ex && ex.maxAttempts ? ex.maxAttempts : ""}"><span class="form-hint">Leave empty to let users attempt as many times as they like</span></div>
        </div>
        <div class="field">
          <label>Negative Marking (marks deducted per wrong answer)</label>
          <input type="number" id="em-negative-marking" min="0" step="0.25" placeholder="0" value="${ex && ex.negativeMarking ? ex.negativeMarking : ""}">
          <span class="form-hint">e.g. 0.25 deducts a quarter mark for every wrong answer — unanswered questions are never penalized. Leave empty or 0 to turn negative marking off. This also feeds the Leaderboard's ranking.</span>
        </div>
        <div class="field">
          <label>Passing percentage</label>
          <input type="number" id="em-pass-percent" min="0" max="100" step="1" placeholder="Default: ${getSettings().result.passPercent}" value="${ex && ex.passPercent ? ex.passPercent : ""}">
          <span class="form-hint" id="em-marks-hint"></span>
        </div>

        <div class="schedule-box">
          <div class="schedule-box-title"><i class="fa-solid fa-shuffle"></i> Random Question Pool</div>
          <div class="field">
            <label>Questions Per Attempt (leave empty to show every question)</label>
            <input type="number" id="em-pool-size" min="0" placeholder="e.g. 25" value="${ex && ex.questionsPerAttempt ? ex.questionsPerAttempt : ""}">
            <span class="form-hint">
              Add as many questions as you like below (even 1000+) as your full question bank. If you set a number
              here, every attempt — for every student, every time — a fresh random set of that many questions is
              drawn from the full bank, so no two students (and no two attempts) are guaranteed to see the same
              questions. Leave empty to show the full bank to everyone, every time.
            </span>
          </div>
        </div>

        <div class="schedule-box">
          <div class="schedule-box-title"><i class="fa-solid fa-sliders"></i> Exam Behavior</div>
          <div class="admin-grid">
            <div class="field">
              <label>Question Display Style</label>
              <select id="em-layout">
                <option value="one" ${!ex || (ex.layout || "one") === "one" ? "selected" : ""}>One at a time (one question / page)</option>
                <option value="all" ${ex && ex.layout === "all" ? "selected" : ""}>All questions on one page</option>
              </select>
            </div>
            <div class="field">
              <label>Question & Option Order</label>
              <label class="switch-row">
                <input type="checkbox" id="em-shuffle" ${!ex || ex.shuffle !== false ? "checked" : ""}>
                <span>Shuffle each time it's shown</span>
              </label>
              <span class="form-hint">When enabled, the question and option order changes on every attempt — makes cheating/memorizing harder</span>
            </div>
          </div>
        </div>

        <div class="schedule-box" id="em-schedule-box">
          <div class="schedule-box-title"><i class="fa-solid fa-calendar-days"></i> Publish Schedule</div>
          <div class="admin-grid">
            <div class="field">
              <label>When to Publish</label>
              <input type="datetime-local" id="em-publish-at" value="${ex ? toDatetimeLocalValue(ex.publishAt) : ""}">
              <span class="form-hint">Leave empty to publish immediately</span>
            </div>
            <div class="field">
              <label>Hours to Stay Open</label>
              <input type="number" id="em-available-hours" min="0" step="any" placeholder="e.g. 48" value="${ex && ex.availableHours ? ex.availableHours : ""}">
              <span class="form-hint">Leave empty or 0 to stay open indefinitely</span>
            </div>
          </div>
        </div>

        <button type="button" class="btn btn-teal btn-block mt-16" id="em-goto-questions-btn">Add Questions <i class="fa-solid fa-arrow-right"></i></button>
      </div>

      <div class="exam-tab-panel" id="em-panel-questions" hidden>
        <div class="qb-section">
          <button type="button" class="btn btn-outline btn-block mb-16" id="em-back-settings-btn"><i class="fa-solid fa-arrow-left"></i> Back to Settings</button>
          <div class="qb-toolbar">
            <div class="qb-count">Total Questions: <span id="em-q-count">0</span></div>
            <div class="row" style="gap:6px"><button type="button" class="btn btn-outline btn-sm" id="em-bank-btn"><i class="fa-solid fa-circle-question"></i> From Question Bank</button><button type="button" class="btn btn-outline btn-sm" id="em-tobank-btn" title="Copy these questions into the Question Bank"><i class="fa-solid fa-box-archive"></i> Save to Bank</button><button type="button" class="btn btn-outline btn-sm" id="em-bulk-toggle-btn"><i class="fa-solid fa-bolt"></i> Bulk Import</button></div>
          </div>
          <div class="qb-bulk-panel" id="em-bulk-panel" hidden>
            <span class="form-hint">Paste each question separated by a blank line. First line is the question, then one option per line. Mark the correct option with a leading <b>*</b>. Optionally add a last line starting with <b>Explanation:</b> —</span>
            <pre class="qb-bulk-example">What is the capital of France?
*Paris
London
Berlin
Rome
Explanation: Paris has been the capital of France since the 12th century.</pre>
            <textarea id="em-bulk-text" rows="8" placeholder="Paste multiple questions here..."></textarea>
            <div class="qb-bulk-actions">
              <button type="button" class="btn btn-outline btn-sm" id="em-bulk-cancel-btn">Cancel</button>
              <button type="button" class="btn btn-teal btn-sm" id="em-bulk-import-btn"><i class="fa-solid fa-file-import"></i> Import</button>
            </div>
          </div>
          <div id="em-question-list"></div>
          <button type="button" class="btn btn-outline btn-block mt-8" id="em-add-question-btn"><i class="fa-solid fa-plus"></i> Add Question</button>
        </div>
      </div>

      <div class="confirm-actions mt-24"><button type="button" class="btn btn-outline btn-block" id="em-save-draft">Save as draft</button><button type="submit" class="btn btn-teal btn-block" id="exam-modal-save-btn">${ex ? "Save Changes" : "Publish Exam"}</button></div>
    </form>
  `);

  /* ---------- Exam scope: whole course vs specific lesson(s) ----------
     The lesson picker only makes sense once a course is chosen (lessons live
     under a course), so it stays hidden until #em-course-id has a value. ---------- */
  /* ---------- Practice exams have no schedule — hide that box entirely ---------- */
  const examTypeSelect = overlay.querySelector("#em-exam-type");
  const scheduleBox = overlay.querySelector("#em-schedule-box");
  function refreshScheduleVisibility() { scheduleBox.hidden = examTypeSelect.value === "practice"; }
  examTypeSelect.addEventListener("change", refreshScheduleVisibility);
  refreshScheduleVisibility();

  const scopeField = overlay.querySelector("#em-scope-field");
  const lessonsField = overlay.querySelector("#em-lessons-field");
  const scopeSelect = overlay.querySelector("#em-scope");
  const lessonPicker = overlay.querySelector("#em-lesson-picker");
  const courseSelectEl = overlay.querySelector("#em-course-id");
  const examLessonsCache = {};

  async function loadLessonPicker(courseId, checkedIds) {
    lessonPicker.innerHTML = `<div class="empty-state" style="padding:14px;">Loading lessons...</div>`;
    if (!examLessonsCache[courseId]) {
      // Shared across modals for 10 minutes — re-opening the editor no longer re-reads a course's lessons.
      examLessonsCache[courseId] = await cache.remember(`lessons:${courseId}`, 10 * 60 * 1000, async () => {
        const snap = await getDocs(query(collection(db, "courses", courseId, "lessons"), orderBy("order")));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      });
    }
    const courseLessons = examLessonsCache[courseId];
    if (!courseLessons.length) {
      lessonPicker.innerHTML = `<div class="empty-state" style="padding:14px;">This course has no lessons yet — add lessons first</div>`;
      return;
    }
    lessonPicker.innerHTML = courseLessons
      .map(
        (l) => `
      <label class="lesson-picker-item">
        <input type="checkbox" value="${l.id}" data-title="${escapeHtml(l.title)}" ${checkedIds?.includes(l.id) ? "checked" : ""}>
        <span>${escapeHtml(l.title)}</span>
      </label>`
      )
      .join("");
  }

  function refreshScopeVisibility() {
    const cId = courseSelectEl.value;
    scopeField.hidden = !cId;
    lessonsField.hidden = !cId || scopeSelect.value !== "lessons";
  }

  courseSelectEl.addEventListener("change", () => {
    refreshScopeVisibility();
    if (courseSelectEl.value && scopeSelect.value === "lessons") loadLessonPicker(courseSelectEl.value, ex?.lessonIds);
  });
  scopeSelect.addEventListener("change", () => {
    refreshScopeVisibility();
    if (courseSelectEl.value && scopeSelect.value === "lessons") loadLessonPicker(courseSelectEl.value, ex?.lessonIds);
  });

  if (ex && ex.courseId) scopeSelect.value = ex.lessonIds?.length ? "lessons" : "course";
  refreshScopeVisibility();
  if (courseSelectEl.value && scopeSelect.value === "lessons") loadLessonPicker(courseSelectEl.value, ex?.lessonIds);

  /* ---------- Settings ⇄ Questions tab switching ---------- */
  function switchExamTab(tab) {
    const isSettings = tab === "settings";
    overlay.querySelector("#em-panel-settings").hidden = !isSettings;
    overlay.querySelector("#em-panel-questions").hidden = isSettings;
    overlay.querySelector("#em-tab-btn-settings").classList.toggle("active", isSettings);
    overlay.querySelector("#em-tab-btn-questions").classList.toggle("active", !isSettings);
  }
  overlay.querySelectorAll(".exam-tab-btn").forEach((btn) => btn.addEventListener("click", () => switchExamTab(btn.dataset.tab)));
  overlay.querySelector("#em-goto-questions-btn").addEventListener("click", () => switchExamTab("questions"));
  overlay.querySelector("#em-back-settings-btn").addEventListener("click", () => switchExamTab("settings"));

  const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];
  const MAX_OPTIONS = 6;

  function renderQ() {
    refreshMarksHint();
    const wrap = overlay.querySelector("#em-question-list");
    const countEl = overlay.querySelector("#em-q-count");
    if (countEl) countEl.textContent = questionDrafts.length;
    const tabCountEl = overlay.querySelector("#em-tab-q-count");
    if (tabCountEl) tabCountEl.textContent = questionDrafts.length;

    if (!questionDrafts.length) {
      wrap.innerHTML = `<div class="qb-empty">No questions added yet — click the button below or use bulk import</div>`;
      return;
    }

    wrap.innerHTML = questionDrafts
      .map((q, qi) => `
      <div class="q-card" data-qi="${qi}">
        <div class="q-card-head">
          <span class="q-badge"><i class="fa-solid fa-circle-question"></i> Question ${qi + 1}</span>
          <div class="q-card-actions">
            <button type="button" class="icon-btn q-move-up" data-qi="${qi}" title="Move up" ${qi === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" class="icon-btn q-move-down" data-qi="${qi}" title="Move down" ${qi === questionDrafts.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
            <button type="button" class="icon-btn q-duplicate" data-qi="${qi}" title="Duplicate question"><i class="fa-solid fa-copy"></i></button>
            <button type="button" class="icon-btn danger q-remove" data-qi="${qi}" title="Delete question"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
        <textarea class="q-text-input" data-qi="${qi}" rows="2" placeholder="Enter question" required>${escapeHtml(q.text)}</textarea>
        <div class="q-options">
          ${q.options.map((opt, oi) => `
            <div class="option-row ${q.correctIndex === oi ? "is-correct" : ""}">
              <span class="option-letter">${OPTION_LETTERS[oi] || oi + 1}</span>
              <input type="text" class="q-option-input" data-qi="${qi}" data-oi="${oi}" value="${escapeHtml(opt)}" placeholder="Option ${oi + 1}" required>
              <div class="option-controls">
                <button type="button" class="opt-correct-btn ${q.correctIndex === oi ? "active" : ""}" data-qi="${qi}" data-oi="${oi}" title="Mark as correct answer"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="opt-remove-btn" data-qi="${qi}" data-oi="${oi}" title="Remove option" ${q.options.length <= 2 ? "disabled" : ""}><i class="fa-solid fa-xmark"></i></button>
              </div>
            </div>`).join("")}
        </div>
        <button type="button" class="add-option-btn" data-qi="${qi}" ${q.options.length >= MAX_OPTIONS ? "disabled" : ""}><i class="fa-solid fa-plus"></i> Add Option</button>
        <div class="field q-explanation-field">
          <label><i class="fa-solid fa-lightbulb"></i> Explanation <span class="form-hint" style="font-weight:400;">(optional — shown to students after they submit, explains why the correct answer is correct)</span></label>
          <textarea class="q-explanation-input" data-qi="${qi}" rows="2" placeholder="e.g. Paris has been the capital of France since...">${escapeHtml(q.explanation || "")}</textarea>
        </div>
      </div>`)
      .join("");

    wrap.querySelectorAll(".q-text-input").forEach((el) => el.addEventListener("input", () => (questionDrafts[el.dataset.qi].text = el.value)));
    wrap.querySelectorAll(".q-option-input").forEach((el) => el.addEventListener("input", () => (questionDrafts[el.dataset.qi].options[el.dataset.oi] = el.value)));
    wrap.querySelectorAll(".q-explanation-input").forEach((el) => el.addEventListener("input", () => (questionDrafts[el.dataset.qi].explanation = el.value)));

    wrap.querySelectorAll(".opt-correct-btn").forEach((el) => el.addEventListener("click", () => {
      questionDrafts[el.dataset.qi].correctIndex = Number(el.dataset.oi);
      renderQ();
    }));
    wrap.querySelectorAll(".opt-remove-btn").forEach((el) => el.addEventListener("click", () => {
      const qi = Number(el.dataset.qi), oi = Number(el.dataset.oi);
      const q = questionDrafts[qi];
      if (q.options.length <= 2) return;
      q.options.splice(oi, 1);
      if (q.correctIndex === oi) q.correctIndex = 0;
      else if (q.correctIndex > oi) q.correctIndex -= 1;
      renderQ();
    }));
    wrap.querySelectorAll(".add-option-btn").forEach((el) => el.addEventListener("click", () => {
      const q = questionDrafts[Number(el.dataset.qi)];
      if (q.options.length < MAX_OPTIONS) q.options.push("");
      renderQ();
    }));
    wrap.querySelectorAll(".q-move-up").forEach((el) => el.addEventListener("click", () => {
      const qi = Number(el.dataset.qi);
      if (qi === 0) return;
      [questionDrafts[qi - 1], questionDrafts[qi]] = [questionDrafts[qi], questionDrafts[qi - 1]];
      renderQ();
    }));
    wrap.querySelectorAll(".q-move-down").forEach((el) => el.addEventListener("click", () => {
      const qi = Number(el.dataset.qi);
      if (qi === questionDrafts.length - 1) return;
      [questionDrafts[qi + 1], questionDrafts[qi]] = [questionDrafts[qi], questionDrafts[qi + 1]];
      renderQ();
    }));
    wrap.querySelectorAll(".q-duplicate").forEach((el) => el.addEventListener("click", () => {
      const qi = Number(el.dataset.qi);
      const clone = JSON.parse(JSON.stringify(questionDrafts[qi]));
      questionDrafts.splice(qi + 1, 0, clone);
      renderQ();
    }));
    wrap.querySelectorAll(".q-remove").forEach((el) => el.addEventListener("click", () => { questionDrafts.splice(Number(el.dataset.qi), 1); renderQ(); }));
  }
  renderQ();

  overlay.querySelector("#em-course-id").addEventListener("change", (e) => {
    const courseInput = overlay.querySelector("#em-course");
    if (!courseInput.value.trim() && e.target.value) {
      const picked = courses.find((cc) => cc.id === e.target.value);
      if (picked) courseInput.value = picked.title;
    }
  });
  overlay.querySelector("#em-add-question-btn").addEventListener("click", () => {
    questionDrafts.push({ text: "", options: ["", "", "", ""], correctIndex: 0, explanation: "" });
    renderQ();
    const cards = overlay.querySelectorAll(".q-card");
    cards[cards.length - 1]?.querySelector(".q-text-input")?.focus();
  });

  /* ---------- Bulk import: paste text to add many questions at once ---------- */
  function parseBulkQuestions(raw) {
    const blocks = raw.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const parsed = [];
    blocks.forEach((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 3) return;
      const qText = lines[0].replace(/^(question\s*[:\-]\s*)/i, "").replace(/^\d+[).]\s*/, "").trim();
      const options = [];
      let correctIndex = 0;
      let explanation = "";
      lines.slice(1).forEach((line) => {
        const expMatch = line.match(/^explanation\s*[:\-]\s*(.*)$/i);
        if (expMatch) { explanation = expMatch[1].trim(); return; }
        let isCorrect = false;
        let opt = line;
        if (opt.startsWith("*")) { isCorrect = true; opt = opt.slice(1).trim(); }
        opt = opt.replace(/^[A-Fa-f]\)\s*/, "").replace(/^\d+[).]\s*/, "").replace(/^[-•]\s*/, "").trim();
        if (!opt) return;
        if (isCorrect) correctIndex = options.length;
        options.push(opt);
      });
      if (qText && options.length >= 2) parsed.push({ text: qText, options: options.slice(0, MAX_OPTIONS), correctIndex: Math.min(correctIndex, options.length - 1), explanation });
    });
    return parsed;
  }

  const bulkPanel = overlay.querySelector("#em-bulk-panel");
  overlay.querySelector("#em-bulk-toggle-btn").addEventListener("click", () => { bulkPanel.hidden = !bulkPanel.hidden; });
  overlay.querySelector("#em-bulk-cancel-btn").addEventListener("click", () => { bulkPanel.hidden = true; overlay.querySelector("#em-bulk-text").value = ""; });
  overlay.querySelector("#em-bulk-import-btn").addEventListener("click", () => {
    const raw = overlay.querySelector("#em-bulk-text").value.trim();
    if (!raw) { toast("Please paste the questions first", "error"); return; }
    const parsed = parseBulkQuestions(raw);
    if (!parsed.length) { toast("No questions found in the correct format, please follow the example", "error"); return; }
    questionDrafts.push(...parsed);
    renderQ();
    bulkPanel.hidden = true;
    overlay.querySelector("#em-bulk-text").value = "";
    toast(`${parsed.length} question(s) added`, "success");
  });

  /* ---------- Live marks hint + Question Bank hooks ---------- */
  function refreshMarksHint() {
    const hint = overlay.querySelector("#em-marks-hint");
    if (!hint) return;
    const pool = Math.max(0, Number(overlay.querySelector("#em-pool-size").value) || 0);
    const perAttempt = pool > 0 && pool < questionDrafts.length ? pool : questionDrafts.length;
    const own = Math.min(100, Math.max(0, Number(overlay.querySelector("#em-pass-percent").value) || 0));
    const pct = own || Number(getSettings().result.passPercent) || 60;
    hint.textContent = `Total marks: ${perAttempt} (1 per correct answer) · Passing marks: ${Math.ceil((perAttempt * pct) / 100 - 1e-9)}${own ? "" : ` (default ${pct}%)`}`;
  }
  overlay.querySelector("#em-pass-percent").addEventListener("input", refreshMarksHint);
  overlay.querySelector("#em-pool-size").addEventListener("input", refreshMarksHint);
  refreshMarksHint();

  const draftHash = (q) => qHash({ text: q.text, options: q.options, correctIndex: q.correctIndex });
  overlay.querySelector("#em-bank-btn").addEventListener("click", () => openBankPicker({
    title: "Add questions from the Question Bank",
    exclude: new Set(questionDrafts.map(draftHash)),
    onPick: (picked) => {
      const have = new Set(questionDrafts.map(draftHash));
      let added = 0;
      picked.forEach((q) => {
        const h = qHash(q);
        if (have.has(h)) return;
        have.add(h);
        questionDrafts.push({ text: q.text, options: q.options.slice(), correctIndex: q.correctIndex, explanation: q.explanation || "" });
        added++;
      });
      renderQ();
      toast(added ? `${added}টি প্রশ্ন যোগ হয়েছে` : "নির্বাচিত প্রশ্নগুলো আগে থেকেই আছে", added ? "success" : "info");
    },
  }));
  overlay.querySelector("#em-tobank-btn").addEventListener("click", async (ev) => {
    const clean = questionDrafts.filter((q) => q.text.trim() && q.options.filter((o) => o.trim()).length >= 2 && q.correctIndex >= 0);
    if (!clean.length) { toast("ব্যাংকে রাখার মতো কোনো সম্পূর্ণ প্রশ্ন নেই", "error"); return; }
    if (!can("questions.write")) { toast("প্রশ্নব্যাংকে লেখার অনুমতি নেই", "error"); return; }
    await withBusy(ev.currentTarget, async () => {
      try {
        const bank = await loadBank({ force: true });
        const have = new Set(bank.questions.map(qHash));
        const defaults = { subjectId: overlay.querySelector("#em-subject").value, categoryId: "", source: "exam" };
        const fresh = [];
        clean.forEach((q) => { const n = normQuestion({ ...q }, defaults); const h = qHash(n); if (!have.has(h)) { have.add(h); fresh.push(n); } });
        if (!fresh.length) { toast("সবগুলো প্রশ্ন ইতিমধ্যে ব্যাংকে আছে", "info"); return; }
        await saveBank([...bank.questions, ...fresh], bank.chunks);
        logAction("question.import", { type: "bank", label: `${fresh.length} questions from an exam`, detail: overlay.querySelector("#em-title").value.trim() });
        emitChange("questions");
        toast(`${fresh.length}টি প্রশ্ন ব্যাংকে যোগ হয়েছে`, "success");
      } catch { toast("ব্যাংকে সংরক্ষণ করা যায়নি — firestore.rules Publish করেছেন?", "error"); }
    });
  });
  overlay.querySelector("#em-save-draft").addEventListener("click", () => {
    overlay.querySelector("#em-status").value = "draft";
    overlay.querySelector("#exam-modal-form").requestSubmit();
  });

  overlay.querySelector("#exam-modal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleInput = overlay.querySelector("#em-title");
    if (!titleInput.value.trim()) {
      switchExamTab("settings");
      toast("Please enter an exam title", "error");
      titleInput.focus();
      return;
    }
    if (!questionDrafts.length) { switchExamTab("questions"); toast("Please add at least one question", "error"); return; }
    if (questionDrafts.some((q) => !q.text.trim() || q.options.some((o) => !o.trim()))) { switchExamTab("questions"); toast("Please fill in all questions and options", "error"); return; }

    const poolSizeVal = Math.max(0, Number(overlay.querySelector("#em-pool-size").value) || 0);
    if (poolSizeVal > 0 && poolSizeVal > questionDrafts.length) {
      switchExamTab("questions");
      toast(`You set ${poolSizeVal} questions per attempt, but the question bank only has ${questionDrafts.length}. Add more questions or lower that number.`, "error");
      return;
    }

    const courseIdVal = overlay.querySelector("#em-course-id").value || "";
    const scopeVal = courseIdVal ? overlay.querySelector("#em-scope").value : "course";
    const checkedLessons = scopeVal === "lessons"
      ? Array.from(overlay.querySelectorAll("#em-lesson-picker input[type=checkbox]:checked"))
      : [];
    if (courseIdVal && scopeVal === "lessons" && !checkedLessons.length) {
      switchExamTab("settings");
      toast("Please select at least one lesson, or switch to Whole Course", "error");
      return;
    }

    const btn = overlay.querySelector("#exam-modal-save-btn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const examTypeVal = overlay.querySelector("#em-exam-type").value === "practice" ? "practice" : "live";
      const payload = {
        examType: examTypeVal,
        title: overlay.querySelector("#em-title").value.trim(),
        description: overlay.querySelector("#em-desc").value.trim(),
        courseName: overlay.querySelector("#em-course").value.trim(),
        courseId: courseIdVal,
        lessonIds: checkedLessons.map((cb) => cb.value),
        lessonNames: checkedLessons.map((cb) => cb.dataset.title),
        duration: Number(overlay.querySelector("#em-duration").value) || 10,
        questionCount: questionDrafts.length,
        questionsPerAttempt: poolSizeVal,
        maxAttempts: Math.max(0, Number(overlay.querySelector("#em-max-attempts").value) || 0),
        negativeMarking: Math.max(0, Number(overlay.querySelector("#em-negative-marking").value) || 0),
        layout: overlay.querySelector("#em-layout").value === "all" ? "all" : "one",
        shuffle: overlay.querySelector("#em-shuffle").checked,
        status: overlay.querySelector("#em-status").value === "draft" ? "draft" : "published",
        subjectId: overlay.querySelector("#em-subject").value || "",
        categoryId: overlay.querySelector("#em-category").value || "",
        difficulty: overlay.querySelector("#em-difficulty").value || "",
        featured: overlay.querySelector("#em-featured").checked,
        passPercent: Math.min(100, Math.max(0, Number(overlay.querySelector("#em-pass-percent").value) || 0)),
        instructions: overlay.querySelector("#em-instructions").value.trim(),
      };

      // Publish schedule — leave empty for "publish now", leave hours empty/0 for "unlimited".
      // Practice exams ignore this entirely: always open, no publishAt/closesAt saved.
      if (examTypeVal === "practice") {
        payload.publishAt = null;
        payload.availableHours = 0;
        payload.closesAt = null;
      } else {
        const publishRaw = overlay.querySelector("#em-publish-at").value;
        const hoursRaw = overlay.querySelector("#em-available-hours").value.trim();
        const publishDate = publishRaw ? new Date(publishRaw) : new Date();
        const availableHours = hoursRaw ? Math.max(0, Number(hoursRaw)) : 0;
        payload.publishAt = Timestamp.fromDate(publishDate);
        payload.availableHours = availableHours;
        payload.closesAt = availableHours > 0 ? Timestamp.fromDate(new Date(publishDate.getTime() + availableHours * 3600000)) : null;
      }

      // Exam doc + the WHOLE question bank in one atomic write (was: update + read/delete/add every question).
      const saved = await saveExamDoc({
        examId: ex ? ex.id : null,
        data: payload,
        questions: questionDrafts,
        prevChunks: ex?.qChunks || 1,
      });
      const bundleMeta = saved.format === QUESTION_FORMAT ? { qFormat: QUESTION_FORMAT, qChunks: saved.chunks } : {};
      if (ex) {
        const i = currentExams.findIndex((x) => x.id === ex.id);
        const { qFormat, qChunks, ...previous } = i >= 0 ? currentExams[i] : ex;
        const next = { ...previous, ...payload, ...bundleMeta };
        if (i >= 0) currentExams[i] = next; else currentExams.unshift(next);
      } else {
        currentExams.unshift({ id: saved.id, ...payload, ...bundleMeta, createdAt: Timestamp.now() });
      }
      toast(ex ? "Exam updated" : "Exam created", "success");
      logAction(ex ? "exam.update" : "exam.create", { type: "exam", id: saved.id, label: payload.title, detail: `${payload.questionCount} questions · ${payload.status}` });
      if (ex && (ex.status === "draft") !== (payload.status === "draft")) logAction(payload.status === "draft" ? "exam.unpublish" : "exam.publish", { type: "exam", id: saved.id, label: payload.title });
      closeModal();
      afterExamsChanged();
    } catch {
      toast("Could not save", "error");
      btn.disabled = false;
      btn.textContent = ex ? "Save Changes" : "Publish Exam";
    }
  });
}

async function deleteExam(examId) {
  const ex = currentExams.find((x) => x.id === examId);
  if (!ex) return;
  if (!(await confirmDanger({
    title: "এক্সাম মুছবেন?",
    message: `"${ex.title}" ও এর সব প্রশ্ন স্থায়ীভাবে মুছে যাবে। শিক্ষার্থীদের আগের ফলাফল থেকে যাবে।`,
    confirmLabel: "Delete exam", phrase: "delete",
  }))) return;
  try {
    await deleteExamCompletely(examId, ex); // exam + its question bundle: one atomic batch
    currentExams = currentExams.filter((x) => x.id !== examId);
    toast("Exam deleted", "success");
    logAction("exam.delete", { type: "exam", id: examId, label: ex.title });
    afterExamsChanged();
  } catch {
    toast("Could not delete", "error");
  }
}

/* ==========================================================================
   ⚡ Optimize — run ONCE after upgrading (safe to run again any time)
   1. Converts every old exam (one Firestore document per question) into a single question
      bundle. Costs one read per old question, one time; afterwards a student loads the whole
      exam with 1 read instead of 50, and editing it is 1 write instead of ~150 operations.
   2. Gives every student a one-document results summary (userStats) — the exam list and the
      profile page read that instead of one document per exam / per result.
   3. Rebuilds the students' one-document exam index.
   ========================================================================== */

let optimizing = false;
async function optimizeAll() {
  if (optimizing) return;
  const ok = await confirmAction(
    "এটি একবার চালালেই হবে: (১) পুরোনো এক্সামের প্রশ্নগুলো এক ডকুমেন্টে জড়ো করা, (২) প্রতিটি শিক্ষার্থীর রেজাল্ট সারাংশ তৈরি, (৩) এক্সাম ইনডেক্স তৈরি। এতে একবারের জন্য কিছু read/write খরচ হবে, তবে এরপর প্রতিদিনের খরচ অনেক কমে যাবে। চালাবেন?",
    { title: "⚡ Optimize", confirmLabel: "হ্যাঁ, চালান" },
  );
  if (!ok) return;

  optimizing = true;
  const btn = document.getElementById("optimize-exams-btn");
  const original = btn ? btn.innerHTML : "";
  if (btn) btn.disabled = true;
  const step = (text) => { if (btn) btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(text)}`; };

  try {
    // 1) exams — read the real collection so we convert exactly what is in the database
    step("Exams…");
    const exams = await fetchAllExamsAdmin({ force: true });
    let converted = 0;
    let failed = 0;
    let rulesMissing = false;
    for (let i = 0; i < exams.length; i++) {
      if (Number(exams[i].qFormat) === QUESTION_FORMAT) continue;
      step(`Exam ${i + 1}/${exams.length}`);
      try {
        const r = await migrateExamQuestions(exams[i]);
        if (r.migrated) { converted++; exams[i] = { ...exams[i], qFormat: QUESTION_FORMAT, qChunks: r.chunks }; }
        else if (r.reason === "rules") { rulesMissing = true; break; }
      } catch {
        failed++;
      }
    }
    currentExams = exams;
    primeAdminExams(exams);
    refreshList();
    if (rulesMissing) {
      toast("firestore.rules এখনো Publish করা হয়নি। আগে rules Publish করে তারপর আবার Optimize চালান।", "error");
      return;
    }

    // 2) every student's results summary (also makes the overview's "students who attempted" exact)
    let summarised = false;
    try {
      step("Students…");
      const results = await fetchAllResultsAdmin({ force: true });
      await backfillUserStats(results, (done, total) => step(`Students ${done}/${total}`));
      summarised = true;
    } catch (err) {
      console.warn("Could not write the student summaries:", err);
    }

    // 3) the students' exam index (one write)
    step("Index…");
    const indexed = await writeExamIndex(exams, courses, { statsBackfilled: summarised });

    const parts = [`${converted} টি এক্সাম কনভার্ট হয়েছে`];
    if (failed) parts.push(`${failed} টি ব্যর্থ`);
    if (!summarised) parts.push("রেজাল্ট সারাংশ তৈরি হয়নি");
    if (!indexed) parts.push("ইনডেক্স লেখা যায়নি");
    toast(`Optimize শেষ — ${parts.join(", ")}`, failed || !summarised || !indexed ? "error" : "success");
    logAction("exam.optimize", { type: "system", label: `${converted} exams converted` });
    emitChange("exams");
  } catch {
    toast("Optimize সম্পন্ন করা যায়নি, আবার চেষ্টা করুন", "error");
  } finally {
    optimizing = false;
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}
