// ==========================================================================
// admin/taxonomy-page.js — Subjects & (nested) Categories.
// Both live in one small document (see core/taxonomy.js). Exams and bank questions store only the
// ids, so renaming here renames everywhere. Usage counts load AFTER the page paints (they need the
// exam list and the question bank, which are cached and shared with the other pages).
// ==========================================================================
import { toast, openModal, closeModal } from "../utils.js";
import { esc, $, $$, pageHead, chip, emptyState, errorState, skeleton, confirmDanger, withBusy, rid, fmtN, isDenied } from "./core/ui.js";
import { can } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { emitChange } from "./core/bus.js";
import { loadTaxonomy, saveTaxonomy, getTaxonomy, childrenOf, descendantIds, categoryOf } from "./core/taxonomy.js";
import { fetchAllExamsAdmin } from "../exam-data.js";
import { loadBank } from "./core/qbank.js";

let root, usage = null;
const TYPE_LABEL = { exam: "Exams", question: "Questions", both: "Exams & Questions" };

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({ title: "Subjects & Categories", desc: "বিষয় ও (প্রয়োজনে স্তরবিন্যস্ত) ক্যাটাগরি — এক্সাম ও প্রশ্ন সাজানোর জন্য।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="tx-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>` })}
    <div class="grid-2" id="tx-body">${skeleton(4)}</div>`;
  root.querySelector("#tx-refresh").addEventListener("click", () => load({ force: true }));
  root.addEventListener("click", onClick);
  await load();
}

export function activate() { /* data is edited only here, nothing to refresh */ }

async function load(opts) {
  const t = await loadTaxonomy(opts);
  if (t.blocked) {
    $("#tx-body", root).className = "";
    $("#tx-body", root).innerHTML = errorState({ title: "Subjects & Categories — Firestore rules প্রয়োজন", text: "firestore.rules ফাইলটি Firebase Console → Firestore → Rules-এ পেস্ট করে Publish করুন, তারপর আবার চেষ্টা করুন।" });
    return;
  }
  if (!t.ok) {
    $("#tx-body", root).className = "";
    $("#tx-body", root).innerHTML = errorState({ title: "লোড করা যায়নি" });
    return;
  }
  $("#tx-body", root).className = "grid-2";
  render();
  countUsage(opts);
}

/* ---------- Usage counts (async, non-blocking) ---------- */
async function countUsage(opts) {
  const [exams, bank] = await Promise.allSettled([fetchAllExamsAdmin(opts), loadBank(opts)]);
  usage = {
    examsOk: exams.status === "fulfilled", questionsOk: bank.status === "fulfilled",
    sExam: {}, sQ: {}, cExam: {}, cQ: {},
  };
  const bump = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  if (usage.examsOk) exams.value.forEach((e) => { bump(usage.sExam, e.subjectId); bump(usage.cExam, e.categoryId); });
  if (usage.questionsOk) bank.value.questions.forEach((q) => { bump(usage.sQ, q.subjectId); bump(usage.cQ, q.categoryId); });
  render();
}
const used = (kind, id) => {
  if (!usage) return null;
  const e = kind === "s" ? usage.sExam[id] : usage.cExam[id];
  const q = kind === "s" ? usage.sQ[id] : usage.cQ[id];
  return { exams: usage.examsOk ? e || 0 : null, questions: usage.questionsOk ? q || 0 : null };
};
const usageChips = (u) => !u ? `<span class="muted" style="font-size:.76rem">…</span>`
  : `${u.exams !== null ? chip(`${fmtN(u.exams)} exam${u.exams === 1 ? "" : "s"}`) : ""} ${u.questions !== null ? chip(`${fmtN(u.questions)} question${u.questions === 1 ? "" : "s"}`) : ""}`;

/* ---------- Render ---------- */
function render() {
  const t = getTaxonomy();
  const w = can("taxonomy.write");
  const subjects = t.subjects.slice().sort((a, b) => a.name.localeCompare(b.name, "bn"));

  const subjectPanel = `<div class="panel">
    <div class="panel-head"><div><h2>Subjects</h2><small>${fmtN(subjects.length)} total</small></div>
      ${w ? `<button type="button" class="btn btn-primary btn-sm" data-tx="add-subject"><i class="fa-solid fa-plus"></i> Add subject</button>` : ""}</div>
    <div class="panel-body">${subjects.length ? `<ul class="tree">${subjects.map((s) => `
      <li><div class="tree-row"><i class="fa-solid fa-book muted"></i>
        <div class="tree-name" title="${esc(s.name)}">${esc(s.name)}${s.note ? `<div class="muted" style="font-weight:400;font-size:.78rem">${esc(s.note)}</div>` : ""}</div>
        ${usageChips(used("s", s.id))}
        ${w ? `<div class="row-actions"><button type="button" class="icon-btn" data-tx="edit-subject" data-id="${esc(s.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="icon-btn danger" data-tx="del-subject" data-id="${esc(s.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button></div>` : ""}
      </div></li>`).join("")}</ul>`
      : emptyState({ icon: "fa-book", title: "কোনো বিষয় নেই", text: "যেমন: পদার্থবিজ্ঞান, গণিত, ইংরেজি।", action: w ? `<button type="button" class="btn btn-primary btn-sm" data-tx="add-subject">Add subject</button>` : "" })}</div></div>`;

  const branch = (pid) => {
    const kids = childrenOf(pid).slice().sort((a, b) => a.name.localeCompare(b.name, "bn"));
    if (!kids.length) return "";
    return `<ul class="tree">${kids.map((c) => `
      <li><div class="tree-row"><i class="fa-solid ${childrenOf(c.id).length ? "fa-folder-open" : "fa-folder"} muted"></i>
        <div class="tree-name" title="${esc(c.name)}">${esc(c.name)}</div>
        ${chip(TYPE_LABEL[c.type] || TYPE_LABEL.both, c.type === "exam" ? "accent" : c.type === "question" ? "amber" : "")}
        ${usageChips(used("c", c.id))}
        ${w ? `<div class="row-actions"><button type="button" class="icon-btn" data-tx="add-child" data-id="${esc(c.id)}" title="Add sub-category"><i class="fa-solid fa-folder-plus"></i></button>
          <button type="button" class="icon-btn" data-tx="edit-category" data-id="${esc(c.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="icon-btn danger" data-tx="del-category" data-id="${esc(c.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button></div>` : ""}
      </div>${branch(c.id)}</li>`).join("")}</ul>`;
  };
  const tree = branch(null);
  const catPanel = `<div class="panel">
    <div class="panel-head"><div><h2>Categories</h2><small>${fmtN(t.categories.length)} total · sub-categories supported</small></div>
      ${w ? `<button type="button" class="btn btn-primary btn-sm" data-tx="add-category"><i class="fa-solid fa-plus"></i> Add category</button>` : ""}</div>
    <div class="panel-body">${tree || emptyState({ icon: "fa-folder-tree", title: "কোনো ক্যাটাগরি নেই", text: "যেমন: মডেল টেস্ট › অধ্যায়ভিত্তিক।", action: w ? `<button type="button" class="btn btn-primary btn-sm" data-tx="add-category">Add category</button>` : "" })}</div></div>`;

  $("#tx-body", root).innerHTML = subjectPanel + catPanel;
}

function onClick(e) {
  if (e.target.closest("[data-retry]")) return load({ force: true });
  const b = e.target.closest("[data-tx]");
  if (!b || !can("taxonomy.write")) return;
  const id = b.dataset.id;
  ({
    "add-subject": () => subjectModal(null), "edit-subject": () => subjectModal(id), "del-subject": () => deleteSubject(id),
    "add-category": () => categoryModal(null, null), "add-child": () => categoryModal(null, id),
    "edit-category": () => categoryModal(id, null), "del-category": () => deleteCategory(id),
  })[b.dataset.tx]?.();
}

/* Re-read first so an edit made in another tab/by another admin is not overwritten. */
async function mutate(fn) {
  const fresh = await loadTaxonomy({ force: true });
  if (!fresh.ok) throw Object.assign(new Error("taxonomy-unavailable"), { code: fresh.blocked ? "permission-denied" : "unavailable" });
  const next = fn({ subjects: fresh.subjects.slice(), categories: fresh.categories.slice() });
  await saveTaxonomy(next.subjects, next.categories);
  render();
  emitChange("taxonomy");
}
const fail = (err) => toast(isDenied(err) ? "firestore.rules Publish করা হয়নি — README দেখুন" : "সংরক্ষণ করা যায়নি", "error");
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/* ---------- Subjects ---------- */
function subjectModal(id) {
  const s = id ? getTaxonomy().subjects.find((x) => x.id === id) : null;
  const overlay = openModal(`
    <div class="modal-head"><h3>${s ? "Edit subject" : "New subject"}</h3></div>
    <form id="sj-form" novalidate>
      <div class="field"><label>Name</label><input type="text" id="sj-name" value="${esc(s?.name || "")}" maxlength="80" autocomplete="off" required></div>
      <div class="field"><label>Note (optional)</label><input type="text" id="sj-note" value="${esc(s?.note || "")}" maxlength="160"></div>
      <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary btn-block" id="sj-save">${s ? "Save" : "Add"}</button></div>
    </form>`);
  $("#sj-name", overlay).focus();
  $("#sj-form", overlay).addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#sj-name", overlay).value.trim(), note = $("#sj-note", overlay).value.trim();
    if (!name) { toast("নাম লিখুন", "error"); return; }
    if (getTaxonomy().subjects.some((x) => x.id !== id && same(x.name, name))) { toast("এই নামের বিষয় আগে থেকেই আছে", "error"); return; }
    await withBusy($("#sj-save", overlay), async () => {
      try {
        const nid = id || rid("s_");
        await mutate((t) => { const i = t.subjects.findIndex((x) => x.id === nid); const row = { id: nid, name, note }; if (i >= 0) t.subjects[i] = row; else t.subjects.push(row); return t; });
        logAction(s ? "subject.update" : "subject.create", { type: "subject", id: nid, label: name });
        toast(s ? "বিষয় আপডেট হয়েছে" : "বিষয় যোগ হয়েছে", "success");
        closeModal();
      } catch (err) { fail(err); }
    });
  });
}

async function deleteSubject(id) {
  const s = getTaxonomy().subjects.find((x) => x.id === id);
  if (!s) return;
  const u = used("s", id);
  const inUse = u && ((u.exams || 0) + (u.questions || 0));
  if (!(await confirmDanger({
    title: "বিষয়টি মুছবেন?",
    message: `"${s.name}"${inUse ? ` ব্যবহার হচ্ছে ${u.exams || 0}টি এক্সামে ও ${u.questions || 0}টি প্রশ্নে — সেগুলো “বিষয় ছাড়া” হয়ে যাবে (এক্সাম/প্রশ্ন মুছবে না)।` : " মুছে যাবে।"}`,
    confirmLabel: "Delete subject", phrase: inUse ? "delete" : "",
  }))) return;
  try {
    await mutate((t) => { t.subjects = t.subjects.filter((x) => x.id !== id); return t; });
    logAction("subject.delete", { type: "subject", id, label: s.name });
    toast("বিষয় মুছে ফেলা হয়েছে", "success");
  } catch (err) { fail(err); }
}

/* ---------- Categories ---------- */
function categoryModal(id, presetParent) {
  const t = getTaxonomy();
  const c = id ? categoryOf(id) : null;
  const blocked = new Set(id ? [id, ...descendantIds(id)] : []);
  const parentId = c ? c.parentId || "" : presetParent || "";
  const flat = [];
  const walk = (pid, depth) => childrenOf(pid).slice().sort((a, b) => a.name.localeCompare(b.name, "bn")).forEach((x) => { if (!blocked.has(x.id) && depth < 4) { flat.push({ x, depth }); walk(x.id, depth + 1); } });
  walk(null, 0);
  const overlay = openModal(`
    <div class="modal-head"><h3>${c ? "Edit category" : parentId ? "New sub-category" : "New category"}</h3></div>
    <form id="ct-form" novalidate>
      <div class="field"><label>Name</label><input type="text" id="ct-name" value="${esc(c?.name || "")}" maxlength="80" autocomplete="off" required></div>
      <div class="field"><label>Parent</label><select id="ct-parent"><option value="">— Top level —</option>${flat.map(({ x, depth }) => `<option value="${esc(x.id)}" ${x.id === parentId ? "selected" : ""}>${"— ".repeat(depth)}${esc(x.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Use for</label><select id="ct-type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${(c?.type || "both") === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary btn-block" id="ct-save">${c ? "Save" : "Add"}</button></div>
    </form>`);
  $("#ct-name", overlay).focus();
  $("#ct-form", overlay).addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#ct-name", overlay).value.trim(), parent = $("#ct-parent", overlay).value || null, type = $("#ct-type", overlay).value;
    if (!name) { toast("নাম লিখুন", "error"); return; }
    if (t.categories.some((x) => x.id !== id && (x.parentId || null) === parent && same(x.name, name))) { toast("এই স্তরে একই নামের ক্যাটাগরি আছে", "error"); return; }
    await withBusy($("#ct-save", overlay), async () => {
      try {
        const nid = id || rid("c_");
        await mutate((tx) => { const i = tx.categories.findIndex((x) => x.id === nid); const row = { id: nid, name, parentId: parent, type }; if (i >= 0) tx.categories[i] = row; else tx.categories.push(row); return tx; });
        logAction(c ? "category.update" : "category.create", { type: "category", id: nid, label: name });
        toast(c ? "ক্যাটাগরি আপডেট হয়েছে" : "ক্যাটাগরি যোগ হয়েছে", "success");
        closeModal();
      } catch (err) { fail(err); }
    });
  });
}

async function deleteCategory(id) {
  const c = categoryOf(id);
  if (!c) return;
  const branch = [id, ...descendantIds(id)];
  const u = branch.reduce((acc, cid) => { const x = used("c", cid); if (x) { acc.exams += x.exams || 0; acc.questions += x.questions || 0; } return acc; }, { exams: 0, questions: 0 });
  const inUse = usage && (u.exams + u.questions);
  const subs = branch.length - 1;
  if (!(await confirmDanger({
    title: "ক্যাটাগরি মুছবেন?",
    message: `"${c.name}"${subs ? ` ও এর ${subs}টি সাব-ক্যাটাগরি` : ""} মুছে যাবে।${inUse ? ` ${u.exams}টি এক্সাম ও ${u.questions}টি প্রশ্ন “ক্যাটাগরি ছাড়া” হয়ে যাবে।` : ""}`,
    confirmLabel: "Delete category", phrase: inUse || subs ? "delete" : "",
  }))) return;
  try {
    const gone = new Set(branch);
    await mutate((t) => { t.categories = t.categories.filter((x) => !gone.has(x.id)); return t; });
    logAction("category.delete", { type: "category", id, label: c.name, detail: subs ? `+${subs} sub-categories` : "" });
    toast("ক্যাটাগরি মুছে ফেলা হয়েছে", "success");
  } catch (err) { fail(err); }
}
