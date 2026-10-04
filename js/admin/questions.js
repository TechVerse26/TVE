// ==========================================================================
// admin/questions.js — Question Bank: a searchable library of reusable questions.
// Questions are COPIED into an exam (the exam keeps its own bundle, which is what students load),
// so editing the bank never changes a running exam by surprise.
// Every change re-reads the bank first and saves it atomically, so two admins rarely overwrite each other.
// ==========================================================================
import { toast, openModal, closeModal, downloadCsv } from "../utils.js";
import {
  esc, $, $$, fmtN, ago, debounce, pageHead, kpi, chip, createTable, bulkBar, confirmDanger, withBusy,
  skeleton, errorState, isDenied, toMs,
} from "./core/ui.js";
import { can } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { emitChange, onChange } from "./core/bus.js";
import { getSettings } from "./core/settings.js";
import { loadBank, saveBank, normQuestion, validateQuestion, parseBulk, qHash, toCsvRows } from "./core/qbank.js";
import { loadTaxonomy, subjectName, categoryPath, subjectOptions, subjectOptionsHtml, categoryOptionsHtml } from "./core/taxonomy.js";
import { fetchAllExamsAdmin } from "../exam-data.js";
import { appendQuestionsToExam, createExamFromQuestions } from "./core/exam-ops.js";
import { go } from "./admin.js";

let root, table, bank = { questions: [], chunks: 0 }, updateBulk = () => {}, stale = false, loadFailed = false;
const f = { q: "", subject: "", category: "", diff: "", flag: "" };
const DIFF_TONE = { easy: "teal", medium: "amber", hard: "coral" };
const DIFF_ORDER = { easy: 1, medium: 2, hard: 3 };
const clip = (s, n = 80) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

export async function mount(el) {
  root = el;
  await loadTaxonomy().catch(() => {});
  const w = can("questions.write");
  root.innerHTML = `
    ${pageHead({
      title: "Question Bank",
      desc: "পুনর্ব্যবহারযোগ্য প্রশ্নের লাইব্রেরি — বিষয় ও কঠিনতা অনুযায়ী সাজান, তারপর এক্সামে যোগ করুন বা এখান থেকেই এক্সাম বানান।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="qb-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button type="button" class="btn btn-outline btn-sm" id="qb-export"><i class="fa-solid fa-download"></i> Export CSV</button>
        ${w ? `<button type="button" class="btn btn-outline btn-sm" id="qb-import"><i class="fa-solid fa-file-import"></i> Import</button>
        <button type="button" class="btn btn-primary btn-sm" id="qb-new"><i class="fa-solid fa-plus"></i> New question</button>` : ""}`,
    })}
    <div class="stack">
      <div id="qb-kpis"></div>
      <div class="panel">
        <div class="toolbar">
          <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="qb-q" placeholder="Search question, option or tag…" autocomplete="off"></div>
          <select id="qb-subject" aria-label="Subject"></select>
          <select id="qb-category" aria-label="Category"></select>
          <select id="qb-diff" aria-label="Difficulty"><option value="">Any difficulty</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
          <select id="qb-flag" aria-label="Quick filter"><option value="">All questions</option><option value="noexp">Missing explanation</option><option value="nosubject">No subject</option></select>
        </div>
        <div id="qb-table"></div>
      </div>
    </div>
    <div id="qb-bulk"></div>`;

  table = createTable({
    mount: $("#qb-table", root),
    selectable: true,
    onSelect: (ids) => updateBulk(ids.length),
    defaultSort: { key: "updated", dir: "desc" },
    empty: { icon: "fa-circle-question", title: "কোনো প্রশ্ন নেই", text: "নতুন প্রশ্ন যোগ করুন, ইমপোর্ট করুন, অথবা এক্সাম এডিটরের “Save to Bank” ব্যবহার করুন।" },
    columns: [
      { key: "text", label: "Question", sortable: true, sortValue: (q) => q.text, render: (q) =>
        `<div class="cell-main"><div class="t clamp2">${esc(q.text)}</div><div class="s">${q.options.length} options${q.explanation ? " · explained" : ""}${(q.tags || []).length ? ` · ${esc(q.tags.join(", "))}` : ""}</div></div>` },
      { key: "answer", label: "Correct answer", render: (q) => `<span class="clamp2">${esc(clip(q.options[q.correctIndex] || "—", 70))}</span>` },
      { key: "subject", label: "Subject", sortable: true, sortValue: (q) => subjectName(q.subjectId), render: (q) => {
        const s = subjectName(q.subjectId), c = categoryPath(q.categoryId);
        return s || c ? `<div class="cell-main"><div class="t">${esc(s || "—")}</div>${c ? `<div class="s">${esc(c)}</div>` : ""}</div>` : `<span class="muted">—</span>`;
      } },
      { key: "difficulty", label: "Level", sortable: true, sortValue: (q) => DIFF_ORDER[q.difficulty] || 2, render: (q) => chip(q.difficulty, DIFF_TONE[q.difficulty] || "") },
      { key: "updated", label: "Updated", sortable: true, sortValue: (q) => toMs(q.updatedAt), render: (q) => `<span class="muted">${ago(q.updatedAt)}</span>` },
      { key: "act", label: "", cls: "c-act", render: (q) => `<div class="row-actions">
        ${w ? `<button type="button" class="icon-btn" data-act="edit" data-id="${esc(q.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="icon-btn" data-act="dup" data-id="${esc(q.id)}" title="Duplicate"><i class="fa-solid fa-clone"></i></button>` : ""}
        ${can("questions.delete") ? `<button type="button" class="icon-btn danger" data-act="del" data-id="${esc(q.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ""}</div>` },
    ],
  });

  updateBulk = bulkBar($("#qb-bulk", root), [
    ...(can("exams.write") ? [{ id: "assign", label: "Add to exam", icon: "fa-link", tone: "teal" }, { id: "make", label: "Create exam", icon: "fa-file-circle-plus", tone: "primary" }] : []),
    ...(w ? [{ id: "organize", label: "Organize", icon: "fa-folder-tree" }] : []),
    { id: "export", label: "Export", icon: "fa-download" },
    ...(can("questions.delete") ? [{ id: "delete", label: "Delete", icon: "fa-trash", tone: "coral" }] : []),
  ], onBulk);

  fillFilters();
  $("#qb-q", root).addEventListener("input", debounce((e) => { f.q = e.target.value; refresh(); }, 150));
  [["subject", "#qb-subject"], ["category", "#qb-category"], ["diff", "#qb-diff"], ["flag", "#qb-flag"]].forEach(([k, id]) => $(id, root).addEventListener("change", (e) => { f[k] = e.target.value; refresh(); }));
  $("#qb-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#qb-new", root)?.addEventListener("click", () => openEditor(null));
  $("#qb-import", root)?.addEventListener("click", openImport);
  $("#qb-export", root).addEventListener("click", () => exportCsv(filtered()));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const q = bank.questions.find((x) => x.id === b.dataset.id);
    if (!q) return;
    if (b.dataset.act === "edit") openEditor(q);
    else if (b.dataset.act === "dup") duplicate(q);
    else if (b.dataset.act === "del") remove([q]);
  });
  onChange((kind) => { if (kind === "questions") stale = true; });
  await load();
}

export async function activate() {
  if (!table) return;
  await loadTaxonomy().catch(() => {});
  fillFilters();
  if (loadFailed) return load(); // the last read failed (e.g. rules not published yet) — retry on re-open
  if (stale) { stale = false; try { bank = await loadBank(); } catch { /* keep what we have */ } }
  refresh();
}

function fillFilters() {
  const keep = (sel, html) => { const el = $(sel, root); const v = el.value; el.innerHTML = html; el.value = [...el.options].some((o) => o.value === v) ? v : ""; };
  keep("#qb-subject", subjectOptionsHtml("", "All subjects"));
  keep("#qb-category", categoryOptionsHtml("question", "", "All categories"));
  f.subject = $("#qb-subject", root).value; f.category = $("#qb-category", root).value;
}

async function load(opts) {
  table.setState(skeleton(6));
  try {
    bank = await loadBank(opts);
    loadFailed = false;
    refresh();
  } catch (err) {
    loadFailed = true;
    table.setState(isDenied(err)
      ? errorState({ title: "Question Bank — Firestore rules প্রয়োজন", text: "firestore.rules ফাইলটি Firebase Console → Firestore → Rules-এ পেস্ট করে Publish করুন, তারপর আবার চেষ্টা করুন।" })
      : errorState({ title: "প্রশ্নব্যাংক লোড করা যায়নি", text: err?.message || "" }));
  }
}

function filtered() {
  const needle = f.q.trim().toLowerCase();
  return bank.questions.filter((q) => {
    if (f.subject && q.subjectId !== f.subject) return false;
    if (f.category && q.categoryId !== f.category) return false;
    if (f.diff && q.difficulty !== f.diff) return false;
    if (f.flag === "noexp" && q.explanation) return false;
    if (f.flag === "nosubject" && q.subjectId) return false;
    return !needle || `${q.text} ${q.options.join(" ")} ${(q.tags || []).join(" ")}`.toLowerCase().includes(needle);
  });
}

function refresh() {
  const all = bank.questions;
  const n = (fn) => all.filter(fn).length;
  $("#qb-kpis", root).innerHTML = `<div class="kpis">
    ${kpi({ label: "Total questions", value: fmtN(all.length) })}
    ${kpi({ label: "Easy", value: fmtN(n((q) => q.difficulty === "easy")), tone: "teal" })}
    ${kpi({ label: "Medium", value: fmtN(n((q) => q.difficulty === "medium")), tone: "amber" })}
    ${kpi({ label: "Hard", value: fmtN(n((q) => q.difficulty === "hard")), tone: "coral" })}
    ${kpi({ label: "Missing explanation", value: fmtN(n((q) => !q.explanation)), sub: "optional but helpful" })}
    ${kpi({ label: "No subject", value: fmtN(n((q) => !q.subjectId)), sub: "unsorted" })}</div>`;
  table.setRows(filtered(), { keepPage: true });
}

/* ---------- Safe write: re-read → apply → save ---------- */
async function mutate(fn) {
  const fresh = await loadBank({ force: true });
  const next = fn(fresh.questions.slice());
  const chunks = await saveBank(next, fresh.chunks);
  bank = { questions: next, chunks };
  refresh();
  emitChange("questions");
}
const fail = (err, what = "সংরক্ষণ করা যায়নি") => toast(isDenied(err) ? "firestore.rules Publish করা হয়নি — README দেখুন" : what, "error");

/* ---------- Create / edit ---------- */
function openEditor(q) {
  const set = getSettings().question;
  const st = { options: q ? q.options.slice() : Array.from({ length: Math.max(set.minOptions, 4) }, () => ""), correct: q ? q.correctIndex : -1 };
  const overlay = openModal(`
    <div class="modal-head"><h3>${q ? "Edit question" : "New question"}</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <form id="qe-form" novalidate>
      <div class="field"><label>Question</label><textarea id="qe-text" rows="3" required>${esc(q?.text || "")}</textarea></div>
      <div class="field"><label>Options — tick the correct one</label><div class="q-options" id="qe-opts"></div>
        <button type="button" class="add-option-btn" id="qe-add"><i class="fa-solid fa-plus"></i> Add option</button></div>
      <div class="field"><label>Explanation ${set.requireExplanation ? "" : "(optional)"}</label><textarea id="qe-exp" rows="2" placeholder="Why is this the correct answer?">${esc(q?.explanation || "")}</textarea></div>
      <div class="form-grid">
        <div class="field"><label>Subject</label><select id="qe-subject">${subjectOptionsHtml(q?.subjectId || "")}</select></div>
        <div class="field"><label>Category</label><select id="qe-category">${categoryOptionsHtml("question", q?.categoryId || "")}</select></div>
        <div class="field"><label>Difficulty</label><select id="qe-diff">${["easy", "medium", "hard"].map((d) => `<option value="${d}" ${(q?.difficulty || set.defaultDifficulty) === d ? "selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("")}</select></div>
        <div class="field"><label>Tags (comma separated)</label><input type="text" id="qe-tags" value="${esc((q?.tags || []).join(", "))}" placeholder="e.g. chapter-3, formula"></div>
      </div>
      <div class="note bad" id="qe-err" hidden></div>
      <div class="confirm-actions mt-16"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary btn-block" id="qe-save">${q ? "Save changes" : "Add question"}</button></div>
    </form>`);
  overlay.firstElementChild.classList.add("wide");

  const optsEl = $("#qe-opts", overlay);
  function drawOpts() {
    optsEl.innerHTML = st.options.map((t, i) => `
      <div class="option-row ${i === st.correct ? "is-correct" : ""}">
        <span class="option-letter">${String.fromCharCode(65 + i)}</span>
        <input type="text" class="q-option-input" data-oi="${i}" value="${esc(t)}" placeholder="Option ${String.fromCharCode(65 + i)}">
        <div class="option-controls">
          <button type="button" class="opt-correct-btn ${i === st.correct ? "active" : ""}" data-correct="${i}" title="Mark as correct" aria-pressed="${i === st.correct}"><i class="fa-solid fa-check"></i></button>
          <button type="button" class="opt-remove-btn" data-remove="${i}" title="Remove" ${st.options.length <= set.minOptions ? "disabled" : ""}><i class="fa-solid fa-xmark"></i></button>
        </div></div>`).join("");
    $("#qe-add", overlay).disabled = st.options.length >= set.maxOptions;
  }
  drawOpts();
  optsEl.addEventListener("input", (e) => { const i = e.target.dataset.oi; if (i !== undefined) st.options[i] = e.target.value; });
  optsEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-correct]"), r = e.target.closest("[data-remove]");
    if (c) { st.correct = Number(c.dataset.correct); drawOpts(); }
    if (r && !r.disabled) { const i = Number(r.dataset.remove); st.options.splice(i, 1); if (st.correct === i) st.correct = -1; else if (st.correct > i) st.correct--; drawOpts(); }
  });
  $("#qe-add", overlay).addEventListener("click", () => { st.options.push(""); drawOpts(); optsEl.querySelector(`[data-oi="${st.options.length - 1}"]`)?.focus(); });

  $("#qe-form", overlay).addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = normQuestion({
      id: q?.id, createdAt: q?.createdAt, source: q?.source, text: $("#qe-text", overlay).value, options: st.options, correctIndex: st.correct,
      explanation: $("#qe-exp", overlay).value, subjectId: $("#qe-subject", overlay).value, categoryId: $("#qe-category", overlay).value,
      difficulty: $("#qe-diff", overlay).value, tags: $("#qe-tags", overlay).value,
    });
    const errors = validateQuestion(n, set);
    if (bank.questions.some((x) => x.id !== n.id && qHash(x) === qHash(n))) errors.push("এই প্রশ্ন ও সঠিক উত্তর ব্যাংকে আগে থেকেই আছে");
    const box = $("#qe-err", overlay);
    box.hidden = !errors.length;
    box.innerHTML = errors.map((m) => `• ${esc(m)}`).join("<br>");
    if (errors.length) return;
    await withBusy($("#qe-save", overlay), async () => {
      try {
        await mutate((list) => { const i = list.findIndex((x) => x.id === n.id); if (i >= 0) list[i] = n; else list.push(n); return list; });
        logAction(q ? "question.update" : "question.create", { type: "question", id: n.id, label: clip(n.text, 80) });
        toast(q ? "প্রশ্ন আপডেট হয়েছে" : "প্রশ্ন যোগ হয়েছে", "success");
        closeModal();
      } catch (err) { fail(err); }
    });
  });
  $("#qe-text", overlay).focus();
}

async function duplicate(q) {
  const copy = normQuestion({ ...q, id: undefined, createdAt: undefined, text: `${q.text} (copy)`, source: "manual" });
  try {
    await mutate((list) => [...list, copy]);
    logAction("question.create", { type: "question", id: copy.id, label: clip(copy.text, 80), detail: "duplicate" });
    toast("কপি তৈরি হয়েছে — এডিট করে নিন", "success");
    openEditor(copy);
  } catch (err) { fail(err); }
}

async function remove(list) {
  const many = list.length > 1;
  if (!(await confirmDanger({
    title: many ? `${list.length}টি প্রশ্ন মুছবেন?` : "প্রশ্নটি মুছবেন?",
    message: "প্রশ্নব্যাংক থেকে মুছে যাবে। যেসব এক্সামে এটি আগেই যোগ করা হয়েছে, সেখানে থেকে যাবে।",
    confirmLabel: many ? `Delete ${list.length}` : "Delete", phrase: many ? "delete" : "",
  }))) return;
  const ids = new Set(list.map((q) => q.id));
  try {
    await mutate((all) => all.filter((q) => !ids.has(q.id)));
    logAction("question.delete", { type: "question", label: many ? `${list.length} questions` : clip(list[0].text, 80) });
    toast(many ? `${list.length}টি প্রশ্ন মুছে ফেলা হয়েছে` : "প্রশ্ন মুছে ফেলা হয়েছে", "success");
    table.clearSelection();
  } catch (err) { fail(err, "মুছে ফেলা যায়নি"); }
}

/* ---------- Bulk actions ---------- */
const selected = () => { const ids = new Set(table.getSelected()); return bank.questions.filter((q) => ids.has(q.id)); };

async function onBulk(action) {
  const list = selected();
  if (action === "clear") return table.clearSelection();
  if (!list.length) return;
  if (action === "export") return exportCsv(list);
  if (action === "delete") return remove(list);
  if (action === "organize") return openOrganize(list);
  if (action === "assign") return openAssign(list);
  if (action === "make") return openMakeExam(list);
}

function openOrganize(list) {
  const overlay = openModal(`
    <div class="modal-head"><h3>Organize ${list.length} question${list.length === 1 ? "" : "s"}</h3></div>
    <p class="confirm-msg">যেগুলো বদলাতে চান শুধু সেগুলো বেছে নিন — বাকিগুলো যেমন আছে তেমনই থাকবে।</p>
    <div class="field"><label>Subject</label><select id="og-subject"><option value="__keep">— Keep as is —</option><option value="">No subject</option>${subjectOptions().map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></div>
    <div class="field"><label>Category</label><select id="og-category"><option value="__keep">— Keep as is —</option>${categoryOptionsHtml("question", "", "No category")}</select></div>
    <div class="field"><label>Difficulty</label><select id="og-diff"><option value="__keep">— Keep as is —</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-primary btn-block" id="og-ok">Apply</button></div>`);
  $("#og-ok", overlay).addEventListener("click", async (e) => {
    const subject = $("#og-subject", overlay).value, category = $("#og-category", overlay).value, diff = $("#og-diff", overlay).value;
    if ([subject, category, diff].every((v) => v === "__keep")) { toast("কিছু বদলানোর জন্য বেছে নিন", "info"); return; }
    const ids = new Set(list.map((q) => q.id));
    await withBusy(e.currentTarget, async () => {
      try {
        await mutate((all) => all.map((q) => !ids.has(q.id) ? q : {
          ...q, updatedAt: Date.now(),
          ...(subject !== "__keep" ? { subjectId: subject } : {}), ...(category !== "__keep" ? { categoryId: category } : {}), ...(diff !== "__keep" ? { difficulty: diff } : {}),
        }));
        logAction("question.bulk", { type: "question", label: `${list.length} questions organized` });
        toast("আপডেট হয়েছে", "success"); closeModal(); table.clearSelection();
      } catch (err) { fail(err); }
    });
  });
}

async function openAssign(list) {
  const overlay = openModal(`<div class="modal-head"><h3>Add ${list.length} question${list.length === 1 ? "" : "s"} to an exam</h3></div><div id="as-body">${skeleton(2)}</div>`);
  let exams = [];
  try { exams = (await fetchAllExamsAdmin()).slice().sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)); }
  catch { $("#as-body", overlay).innerHTML = errorState({ title: "এক্সাম লোড করা যায়নি", retry: false }); return; }
  if (!exams.length) { $("#as-body", overlay).innerHTML = `<p class="confirm-msg">কোনো এক্সাম নেই — আগে একটি এক্সাম তৈরি করুন, অথবা “Create exam” ব্যবহার করুন।</p><div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Close</button></div>`; $$("[data-modal-close]", overlay).forEach((b) => b.addEventListener("click", closeModal)); return; }
  $("#as-body", overlay).innerHTML = `
    <div class="field"><label>Exam</label><select id="as-exam">${exams.map((e) => `<option value="${esc(e.id)}">${esc(e.title)} — ${e.questionCount || 0} questions${e.status === "draft" ? " (draft)" : ""}</option>`).join("")}</select>
      <span class="form-hint">যেসব প্রশ্ন এক্সামে আগে থেকেই আছে সেগুলো বাদ যাবে। প্রশ্নগুলো কপি হয়ে এক্সামে যাবে।</span></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-teal btn-block" id="as-ok">Add to exam</button></div>`;
  $$("[data-modal-close]", overlay).forEach((b) => b.addEventListener("click", closeModal));
  $("#as-ok", overlay).addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const r = await appendQuestionsToExam($("#as-exam", overlay).value, list);
      toast(r.added ? `${r.added}টি প্রশ্ন যোগ হয়েছে (মোট ${r.total})` : "সবগুলো প্রশ্ন এক্সামে আগে থেকেই আছে", r.added ? "success" : "info");
      closeModal(); if (r.added) table.clearSelection();
    } catch (err) { toast(err?.message || "যোগ করা যায়নি", "error"); }
  }));
}

function openMakeExam(list) {
  const d = getSettings().exam;
  const subjects = new Set(list.map((q) => q.subjectId).filter(Boolean));
  const overlay = openModal(`
    <div class="modal-head"><h3>Create exam from ${list.length} question${list.length === 1 ? "" : "s"}</h3></div>
    <div class="field"><label>Exam title</label><input type="text" id="mk-title" placeholder="e.g. Chapter 3 quiz" autocomplete="off"></div>
    <div class="form-grid">
      <div class="field"><label>Type</label><select id="mk-type"><option value="live" ${d.examType !== "practice" ? "selected" : ""}>Live</option><option value="practice" ${d.examType === "practice" ? "selected" : ""}>Practice</option></select></div>
      <div class="field"><label>Time limit (minutes)</label><input type="number" id="mk-dur" min="1" value="${d.duration}"></div>
    </div>
    <div class="note">এক্সামটি <b>Draft</b> হিসেবে তৈরি হবে — Exams পেজে সেটিংস দেখে নিয়ে Publish করুন।</div>
    <div class="confirm-actions mt-16"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-primary btn-block" id="mk-ok">Create draft</button></div>`);
  $("#mk-ok", overlay).addEventListener("click", (e) => {
    const title = $("#mk-title", overlay).value.trim();
    if (!title) { toast("এক্সামের নাম লিখুন", "error"); $("#mk-title", overlay).focus(); return; }
    return withBusy(e.currentTarget, async () => {
      try {
        await createExamFromQuestions({ title, examType: $("#mk-type", overlay).value, duration: $("#mk-dur", overlay).value, subjectId: subjects.size === 1 ? [...subjects][0] : "", questions: list });
        toast("Draft এক্সাম তৈরি হয়েছে", "success");
        closeModal(); table.clearSelection(); go("exams");
      } catch (err) { fail(err, "এক্সাম তৈরি করা যায়নি"); }
    });
  });
  $("#mk-title", overlay).focus();
}

/* ---------- Import (same text format as the exam editor's Bulk Import) ---------- */
function openImport() {
  const set = getSettings().question;
  const overlay = openModal(`
    <div class="modal-head"><h3>Import questions</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <p class="form-hint" style="margin-bottom:8px">প্রতিটি প্রশ্নের মাঝে একটি ফাঁকা লাইন দিন। প্রথম লাইন প্রশ্ন, তারপর প্রতি লাইনে একটি অপশন; সঠিক অপশনের আগে <b>*</b>। শেষে ঐচ্ছিক <b>Explanation:</b> লাইন।</p>
    <pre class="qb-bulk-example">What is the capital of France?
*Paris
London
Berlin
Rome
Explanation: Paris has been the capital since the 12th century.</pre>
    <div class="field mt-12"><textarea id="im-text" rows="9" placeholder="Paste questions here…" style="font-family:monospace;font-size:.85rem"></textarea></div>
    <div class="form-grid">
      <div class="field"><label>Subject</label><select id="im-subject">${subjectOptionsHtml("")}</select></div>
      <div class="field"><label>Category</label><select id="im-category">${categoryOptionsHtml("question", "")}</select></div>
      <div class="field"><label>Difficulty</label><select id="im-diff">${["easy", "medium", "hard"].map((x) => `<option value="${x}" ${set.defaultDifficulty === x ? "selected" : ""}>${x[0].toUpperCase() + x.slice(1)}</option>`).join("")}</select></div>
    </div>
    <div id="im-preview" class="note" hidden></div>
    <div class="confirm-actions mt-16"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-primary btn-block" id="im-ok" disabled>Import</button></div>`);
  overlay.firstElementChild.classList.add("wide");
  let parsed = [];
  const defaults = () => ({ subjectId: $("#im-subject", overlay).value, categoryId: $("#im-category", overlay).value, difficulty: $("#im-diff", overlay).value, source: "import" });

  const preview = () => {
    const { questions, errors } = parseBulk($("#im-text", overlay).value);
    const have = new Set(bank.questions.map(qHash));
    parsed = [];
    let dupes = 0, invalid = 0;
    questions.forEach((raw) => {
      const n = normQuestion(raw, defaults());
      if (validateQuestion(n, { ...set, requireExplanation: false }).length) { invalid++; return; }
      const h = qHash(n);
      if (have.has(h)) { dupes++; return; }
      have.add(h); parsed.push(n);
    });
    const box = $("#im-preview", overlay);
    const any = $("#im-text", overlay).value.trim();
    box.hidden = !any;
    box.className = `note${errors.length || invalid ? " warn" : ""}`;
    box.innerHTML = `<b>${parsed.length}</b> নতুন প্রশ্ন ইমপোর্টের জন্য প্রস্তুত${dupes ? ` · ${dupes}টি আগে থেকেই আছে (বাদ যাবে)` : ""}${invalid ? ` · ${invalid}টি অবৈধ` : ""}${errors.length ? `<br>${errors.slice(0, 4).map((x) => `• প্রশ্ন ${x.n}: ${esc(x.msg)} — <i>${esc(clip(x.preview, 50))}</i>`).join("<br>")}${errors.length > 4 ? `<br>… আরও ${errors.length - 4}টি` : ""}` : ""}`;
    $("#im-ok", overlay).disabled = !parsed.length;
    $("#im-ok", overlay).textContent = parsed.length ? `Import ${parsed.length}` : "Import";
  };
  const live = debounce(preview, 200);
  ["#im-text"].forEach((s) => $(s, overlay).addEventListener("input", live));
  ["#im-subject", "#im-category", "#im-diff"].forEach((s) => $(s, overlay).addEventListener("change", preview));

  $("#im-ok", overlay).addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const batch = parsed.slice();
      await mutate((list) => {
        const have = new Set(list.map(qHash));
        return [...list, ...batch.filter((q) => !have.has(qHash(q)))];
      });
      logAction("question.import", { type: "bank", label: `${batch.length} questions imported` });
      toast(`${batch.length}টি প্রশ্ন ইমপোর্ট হয়েছে`, "success");
      closeModal();
    } catch (err) { fail(err, "ইমপোর্ট করা যায়নি"); }
  }));
  $("#im-text", overlay).focus();
}

function exportCsv(list) {
  if (!list.length) { toast("এক্সপোর্ট করার মতো কিছু নেই", "info"); return; }
  downloadCsv(`question-bank-${new Date().toISOString().slice(0, 10)}.csv`, toCsvRows(list, { subjectName, categoryPath }));
}
