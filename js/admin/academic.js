// ==========================================================================
// admin/academic.js — Academic Management: Section › Level › Subject, all created here, nothing hard-coded.
//
//   • a nested tree: every row has Add child · Edit · Reorder ↑↓ · ⋯ (Preview, Move, Activate/Archive, Student access, Delete)
//   • one form for all three kinds: name, description, Cover Image URL (live preview — the picture itself is never stored,
//     only the https link, in the node's `coverImage` field), status, display order, Free / Paid / Inherit, linked course
//   • safe delete: a node with levels, subjects or exams under it is never deleted — archive it, or move its content first
//   • Paid nodes: who may open them is recorded in academicEntitlements (admins only) — the same record firestore.rules checks
//
// Pure rules live in ../academic-core.js (unit-tested); every Firestore call is in ./core/academic-data.js.
// ==========================================================================
import { toast, openModal, closeModal } from "../utils.js";
import { getCoursePricing } from "../utils.js";
import {
  esc, $, $$, pageHead, kpi, chip, emptyState, errorState, rulesHint, skeleton, confirmDanger, withBusy, fmtN, fmtDate, isDenied, debounce,
} from "./core/ui.js";
import { can } from "./core/permissions.js";
import { onChange } from "./core/bus.js";
import { courses } from "./admin.js";
import { fetchAllExamsAdmin, fetchAllUsersAdmin } from "../exam-data.js";
import * as AC from "../academic-core.js";
import { cardHtml, bindCoverFallbacks, KIND_ICON, KIND_LABEL, plural } from "../academic-ui.js";
import * as D from "./core/academic-data.js";

let root, data = null, exams = null, usage = new Map(), stale = false, forcedSync = false;
const ui = { q: "", status: "all", access: "all", collapsed: new Set() };
const CHILD = { section: "level", level: "subject" };

const MSG = {
  "name-required": "নাম লিখুন",
  "name-too-long": "নাম সর্বোচ্চ ৮০ অক্ষরের হতে পারে",
  "name-duplicate": "এই পেরেন্টের ভেতরে একই নামের আরেকটি আইটেম আছে",
  "desc-too-long": "ডেসক্রিপশন সর্বোচ্চ ৪০০ অক্ষর",
  "status-invalid": "স্ট্যাটাস সঠিক নয়",
  "access-invalid": "অ্যাক্সেস মোড সঠিক নয়",
  "order-invalid": "Display order ০ থেকে ১০০০০০ এর মধ্যে একটি পূর্ণ সংখ্যা হতে হবে",
  "parent-missing": "পেরেন্ট নির্বাচন করুন",
  "parent-mismatch": "নির্বাচিত Level এই Section-এর অধীনে নয়",
  "course-invalid": "কোর্স নির্বাচন সঠিক নয়",
};
const errText = (code) => MSG[code] || AC.IMAGE_REASON_TEXT[String(code).replace(/^image-/, "")] || "মানটি সঠিক নয়";

/** The data layer patches its in-memory copy after every write — always draw from that copy. */
const sync = () => { data = D.peekAcademic() || data; };
const listOf = (kind) => data[kind === "section" ? "sections" : kind === "level" ? "levels" : "subjects"];
const find = (kind, id) => listOf(kind).find((n) => n.id === id) || null;
const idx = () => AC.indexNodes(data);
const courseTitle = (id) => courses.find((c) => c.id === id)?.title || "";
const fail = (err) => {
  console.error(err);
  toast(isDenied(err) ? "অনুমতি নেই — firestore.rules Publish করা আছে তো? (README → Academic)" : (err?.message || "কিছু একটা ভুল হয়েছে"), "error");
};

/* ==========================================================================
   Page
   ========================================================================== */
export async function mount(el) {
  root = el;
  const canWrite = can("academic.write");
  root.innerHTML = `
    ${pageHead({
      title: "Academic Management",
      desc: "Section › Level › Subject — তৈরি, সাজানো এবং Free / Paid নিয়ন্ত্রণ। কোনো নামই কোডে বাঁধা নয়; সবকিছু এখান থেকে।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="ac-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${canWrite ? `<button type="button" class="btn btn-primary btn-sm" id="ac-new"><i class="fa-solid fa-plus"></i> New section</button>` : ""}`,
    })}
    <div class="kpis kpis-4 ac-adm-kpis" id="ac-kpis"></div>
    <div class="panel mt-12">
      <div class="toolbar ac-adm-toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="ac-q" placeholder="Search sections, levels, subjects…" autocomplete="off"></div>
        <select id="ac-status" aria-label="Status"><option value="all">All status</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option></select>
        <select id="ac-access" aria-label="Access"><option value="all">All access</option><option value="free">Free</option><option value="paid">Paid</option><option value="inherit">Inherit</option></select>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" id="ac-expand"><i class="fa-solid fa-angles-down"></i> Expand</button>
        <button type="button" class="btn btn-ghost btn-sm" id="ac-collapse"><i class="fa-solid fa-angles-up"></i> Collapse</button>
      </div>
      <div class="panel-body" id="ac-tree">${skeleton(6)}</div>
    </div>`;

  $("#ac-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#ac-new", root)?.addEventListener("click", () => openNodeModal("section", null));
  $("#ac-q", root).addEventListener("input", debounce((e) => { ui.q = e.target.value; renderTree(); }, 180));
  $("#ac-status", root).addEventListener("change", (e) => { ui.status = e.target.value; renderTree(); });
  $("#ac-access", root).addEventListener("change", (e) => { ui.access = e.target.value; renderTree(); });
  $("#ac-expand", root).addEventListener("click", () => { ui.collapsed.clear(); renderTree(); });
  $("#ac-collapse", root).addEventListener("click", () => { data.sections.forEach((s) => ui.collapsed.add(s.id)); data.levels.forEach((l) => ui.collapsed.add(l.id)); renderTree(); });
  root.addEventListener("click", onClick);
  // thumbnails: a link that does not load shows the placeholder icon instead
  $("#ac-tree", root).addEventListener("error", (e) => { if (e.target?.tagName === "IMG") e.target.closest(".ac-thumb")?.classList.add("is-broken"); }, true);
  onChange((kind) => { if (kind === "exams") { stale = true; } });
  await load();
}

export async function activate() {
  if (!stale || !data) return;
  stale = false;
  await loadExamsAndRepaint(true);
}

async function load(opts = {}) {
  const host = $("#ac-tree", root);
  if (opts.force || !data) host.innerHTML = skeleton(6);
  try {
    data = await D.loadAcademic(opts);
  } catch (err) {
    host.innerHTML = isDenied(err) ? rulesHint("Academic Management") : errorState({ title: "লোড করা যায়নি", text: err?.message || "" });
    host.querySelector("[data-retry]")?.addEventListener("click", () => load({ force: true }));
    return;
  }
  if (!ui.seeded) {   // a big tree starts with its levels folded
    ui.seeded = true;
    if (data.sections.length + data.levels.length + data.subjects.length > 60) data.levels.forEach((l) => ui.collapsed.add(l.id));
  }
  renderKpis();
  renderTree();
  // the student exam catalog is refreshed once per admin session (and on ⟳), so a half-finished earlier change can never linger
  if (can("academic.write") && (!forcedSync || opts.force)) {
    forcedSync = true;
    D.syncHidden({ force: true }).catch((err) => console.warn("[academic] catalog sync skipped:", err));
  }
  await loadExamsAndRepaint(!!opts.force);
}

/** The exam list gives the per-node exam counts; it is cached and shared with the Exams page. */
async function loadExamsAndRepaint(force) {
  try { exams = await fetchAllExamsAdmin(force ? { force: true } : undefined); } catch { exams = []; }
  usage = new Map();
  for (const e of exams) {
    for (const kind of AC.KINDS) { const id = e[AC.EXAM_FIELD[kind]]; if (id) usage.set(`${kind}:${id}`, (usage.get(`${kind}:${id}`) || 0) + 1); }
  }
  renderKpis();
  renderTree();
}
const examCount = (kind, id) => (exams ? usage.get(`${kind}:${id}`) || 0 : null);

/* ==========================================================================
   KPI cards
   ========================================================================== */
function renderKpis() {
  sync();
  const s = AC.academicSummary(data, exams || []);
  const examsVal = exams ? fmtN(s.exams) : "…";
  $("#ac-kpis", root).innerHTML = [
    kpi({ label: "Academic sections", value: fmtN(s.sections), tone: "accent" }),
    kpi({ label: "Levels", value: fmtN(s.levels) }),
    kpi({ label: "Subjects", value: fmtN(s.subjects) }),
    kpi({ label: "Academic exams", value: examsVal, sub: "exams placed in a subject" }),
    kpi({ label: "Free programs", value: fmtN(s.free), tone: "teal", sub: "sections · levels · subjects" }),
    kpi({ label: "Paid programs", value: fmtN(s.paid), tone: "amber", sub: "sections · levels · subjects" }),
    kpi({ label: "Active items", value: fmtN(s.active), tone: "teal" }),
    kpi({ label: "Inactive / archived", value: fmtN(s.inactive), tone: s.inactive ? "coral" : "" }),
  ].join("");
}

/* ==========================================================================
   Tree
   ========================================================================== */
function withPositions(tree) {
  tree.forEach((s, i) => {
    s._pos = i; s._cnt = tree.length;
    s.levels.forEach((l, j) => {
      l._pos = j; l._cnt = s.levels.length;
      l.subjects.forEach((b, k) => { b._pos = k; b._cnt = l.subjects.length; });
    });
  });
  return tree;
}

const isFiltered = () => !!ui.q.trim() || ui.status !== "all" || ui.access !== "all";

/** Search + filters. A node stays if it matches, if something under it matches, or (text only) if a parent matched. */
function pruneTree(tree) {
  const q = ui.q.trim().toLowerCase();
  const text = (n) => !q || `${n.name} ${n.description}`.toLowerCase().includes(q);
  const flags = (n) => (ui.status === "all" || n.status === ui.status) && (ui.access === "all" || n.accessMode === ui.access);
  if (!isFiltered()) return tree;
  const out = [];
  for (const sec of tree) {
    const levels = [];
    for (const lvl of sec.levels) {
      const subjects = lvl.subjects.filter((b) => flags(b) && (text(b) || text(lvl) || text(sec)));
      if (subjects.length || (flags(lvl) && (text(lvl) || text(sec)))) levels.push({ ...lvl, subjects });
    }
    if (levels.length || (flags(sec) && text(sec))) out.push({ ...sec, levels });
  }
  return out;
}

function renderTree() {
  sync();
  const host = $("#ac-tree", root);
  const canWrite = can("academic.write");
  const { tree, orphanLevels, orphanSubjects } = AC.buildTree(data);
  if (!data.sections.length && !orphanLevels.length && !orphanSubjects.length) {
    host.innerHTML = emptyState({
      icon: "fa-graduation-cap", title: "No academic sections yet",
      text: "Create a section first, then add levels and subjects inside it. Everything you create here appears on the student Courses page — nothing is hard-coded, you name everything yourself.",
      action: canWrite ? `<button type="button" class="btn btn-primary btn-sm" data-act="add" data-kind="section"><i class="fa-solid fa-plus"></i> Create the first section</button>` : "",
    });
    return;
  }
  const index = idx();
  const pruned = pruneTree(withPositions(tree));
  const orphans = [...orphanLevels, ...orphanSubjects];
  host.innerHTML = `
    ${pruned.length ? `<ul class="ac-tree">${pruned.map((s) => nodeHtml("section", s, index)).join("")}</ul>` : emptyState({ icon: "fa-magnifying-glass", title: "Nothing matches", text: "Change the search or the filters." })}
    ${orphans.length ? `
      <div class="ac-orphans">
        <div class="note warn"><b>${plural(orphans.length, "item")} without a valid parent.</b> Their section or level was removed. Use “Move to…” to attach them again, or delete them.</div>
        <ul class="ac-tree">${orphans.map((n) => nodeHtml(n.kind, { ...n, levels: [], subjects: [], _pos: 0, _cnt: 1, _orphan: true }, index)).join("")}</ul>
      </div>` : ""}`;
}

const STATUS_CHIP = { active: ["Active", "teal"], inactive: ["Inactive", "amber"], archived: ["Archived", ""] };

function nodeHtml(kind, n, index) {
  const canWrite = can("academic.write");
  const eff = AC.resolveAccess(index.chainOf(kind, n.id));
  const kids = kind === "section" ? n.levels : kind === "level" ? n.subjects : [];
  const open = !ui.collapsed.has(n.id);
  const url = AC.safeImageUrl(n.coverImage);
  const [stLabel, stTone] = STATUS_CHIP[n.status] || STATUS_CHIP.inactive;
  const accessChip = n.accessMode === "inherit"
    ? chip(`Inherit · ${eff.mode === "paid" ? "Paid" : "Free"}`, eff.mode === "paid" ? "amber" : "", "fa-arrow-turn-down")
    : n.accessMode === "paid" ? chip("Paid", "amber", "fa-lock") : chip("Free", "teal", "fa-circle-check");
  const ec = examCount(kind, n.id);
  const facts = [
    kind === "section" ? plural(listOf("level").filter((l) => l.sectionId === n.id).length, "level") : "",
    kind !== "subject" ? plural(listOf("subject").filter((s) => (kind === "section" ? s.sectionId : s.levelId) === n.id).length, "subject") : "",
    ec === null ? "… exams" : plural(ec, "exam"),
  ].filter(Boolean).join(" · ");
  const attrs = `data-kind="${kind}" data-id="${esc(n.id)}"`;
  const childKind = CHILD[kind];
  return `
    <li class="ac-node${open ? "" : " is-collapsed"}${n.status !== "active" ? " is-dim" : ""}" ${attrs}>
      <div class="ac-row">
        <button type="button" class="ac-twisty${kids.length ? "" : " is-leaf"}" data-act="toggle" ${attrs} aria-label="${open ? "Collapse" : "Expand"}" aria-expanded="${open}"><i class="fa-solid fa-chevron-down"></i></button>
        <span class="ac-thumb" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}<i class="fa-solid ${KIND_ICON[kind]}"></i></span>
        <div class="ac-info">
          <div class="ac-title"><b>${esc(n.name || "Untitled")}</b>${chip(stLabel, stTone)}${accessChip}${n.linkedCourseId ? chip(courseTitle(n.linkedCourseId) || "Linked course", "accent", "fa-link") : ""}</div>
          <div class="ac-sub">${KIND_LABEL[kind]} · ${esc(facts)}${n.description ? ` · ${esc(n.description.slice(0, 70))}${n.description.length > 70 ? "…" : ""}` : ""}</div>
        </div>
        <div class="ac-actions">
          ${canWrite && !n._orphan && n._cnt > 1 ? `
            <button type="button" class="icon-btn" data-act="up" ${attrs} title="Move up" aria-label="Move up" ${n._pos === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" class="icon-btn" data-act="down" ${attrs} title="Move down" aria-label="Move down" ${n._pos === n._cnt - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>` : ""}
          ${canWrite && childKind ? `<button type="button" class="icon-btn" data-act="add" ${attrs} title="Add ${childKind}" aria-label="Add ${childKind}"><i class="fa-solid fa-plus"></i></button>` : ""}
          ${canWrite ? `<button type="button" class="icon-btn" data-act="edit" ${attrs} title="Edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>` : ""}
          <button type="button" class="icon-btn" data-act="more" ${attrs} title="More" aria-label="More actions"><i class="fa-solid fa-ellipsis"></i></button>
        </div>
      </div>
      ${childKind ? (kids.length
        ? `<ul class="ac-tree ac-children">${kids.map((c) => nodeHtml(childKind, c, index)).join("")}</ul>`
        : (isFiltered() ? "" : `<div class="ac-empty-children" ${open ? "" : "hidden"}>No ${childKind}s yet${canWrite ? ` — use <i class="fa-solid fa-plus"></i> to add one.` : "."}</div>`)) : ""}
    </li>`;
}

function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !root.contains(btn)) return;
  const { act, kind, id } = btn.dataset;
  if (act === "toggle") { ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id); renderTree(); return; }
  if (act === "add") {
    if (!can("academic.write")) return;
    if (!id) return openNodeModal("section", null);
    return openNodeModal(CHILD[kind], null, { parentId: id, parentKind: kind });
  }
  if (act === "edit") return can("academic.write") && openNodeModal(kind, find(kind, id));
  if (act === "up" || act === "down") return reorder(kind, id, act, btn);
  if (act === "more") return openMore(kind, id);
}

async function reorder(kind, id, dir, btn) {
  if (!can("academic.write")) return;
  sync();
  const n = find(kind, id);
  const siblings = listOf(kind).filter((x) => (kind === "section") || (kind === "level" ? x.sectionId === n.sectionId : x.levelId === n.levelId));
  const plan = AC.reorderPlan(siblings, id, dir);
  if (!plan.length) return;
  await withBusy(btn, async () => {
    try { await D.applyOrder(kind, plan); renderTree(); } catch (err) { fail(err); }
  });
}

/* ==========================================================================
   Create / edit form
   ========================================================================== */
const opt = (value, label, sel) => `<option value="${esc(value)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
const statusOpts = (v) => ["active", "inactive", "archived"].map((s) => opt(s, s[0].toUpperCase() + s.slice(1), s === v)).join("");
const accessOpts = (v, isRoot) => [["inherit", isRoot ? "Inherit (Free by default)" : "Inherit from parent"], ["free", "Free"], ["paid", "Paid"]].map(([k, l]) => opt(k, l, k === v)).join("");

function courseOpts(selected) {
  return `<option value="">— None —</option>${courses.map((c) => opt(c.id, `${c.title}${getCoursePricing(c).isPaid ? " (Paid)" : " (Free)"}`, c.id === selected)).join("")}`;
}

function openNodeModal(kind, node, { parentId = "", parentKind = "" } = {}) {
  if (!can("academic.write")) return;
  sync();
  const editing = !!node;
  const preSection = editing ? node.sectionId : parentKind === "section" ? parentId : parentKind === "level" ? find("level", parentId)?.sectionId : "";
  const preLevel = editing ? node.levelId : parentKind === "level" ? parentId : "";
  const sections = data.sections.slice().sort(AC.byOrder);
  const title = `${editing ? "Edit" : "New"} ${kind === "section" ? "academic section" : kind}`;
  const overlay = openModal(`
    <div class="modal-head"><h3>${esc(title)}</h3></div>
    <form id="ac-form" class="ac-form" novalidate>
      ${kind !== "section" ? `
        <div class="ac-two">
          <div class="field" data-f="sectionId"><label for="ac-section">Academic section</label>
            <select id="ac-section" ${editing ? "disabled" : ""}><option value="">— Select —</option>${sections.map((s) => opt(s.id, s.name, s.id === preSection)).join("")}</select></div>
          ${kind === "subject" ? `<div class="field" data-f="levelId"><label for="ac-level">Level</label><select id="ac-level" ${editing ? "disabled" : ""}></select></div>` : ""}
        </div>
        ${editing ? `<div class="ac-hint">The location is fixed here — use “Move to…” (⋯ menu) to relocate it together with its content.</div>` : ""}` : ""}
      <div class="field" data-f="name"><label for="ac-name">Name</label><input type="text" id="ac-name" value="${esc(node?.name || "")}" maxlength="80" autocomplete="off" placeholder="${kind === "section" ? "Section name" : kind === "level" ? "Level name" : "Subject name"}"></div>
      <div class="field" data-f="description"><label for="ac-desc">Short description <span class="muted">(optional)</span></label><textarea id="ac-desc" rows="2" maxlength="400" placeholder="One or two lines students will see on the card">${esc(node?.description || "")}</textarea></div>

      <div class="field ac-img-field" data-f="coverImage">
        <label for="ac-img">Cover Image URL</label>
        <input type="url" id="ac-img" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Paste your direct image URL here..." value="${esc(node?.coverImage || "")}">
        <div class="ac-img-preview" id="ac-img-prev" aria-live="polite"></div>
        <div class="ac-img-msg" id="ac-img-msg"></div>
        <div class="ac-img-actions">
          <button type="button" class="btn btn-outline btn-sm" id="ac-img-update"><i class="fa-solid fa-rotate"></i> Update preview</button>
          <button type="button" class="btn btn-outline btn-sm" id="ac-img-replace"><i class="fa-solid fa-paste"></i> Replace URL</button>
          <button type="button" class="btn btn-ghost btn-sm" id="ac-img-remove"><i class="fa-solid fa-trash-can"></i> Remove image</button>
        </div>
        <div class="ac-hint">Host the picture anywhere you like and paste its direct https link. Only the link is saved in the database — nothing is uploaded.</div>
      </div>

      <div class="ac-two">
        <div class="field" data-f="status"><label for="ac-status-sel">Status</label><select id="ac-status-sel">${statusOpts(node?.status || "active")}</select></div>
        <div class="field" data-f="order"><label for="ac-order">Display order</label><input type="number" id="ac-order" min="0" max="100000" step="1" value="${node ? esc(node.order) : ""}" placeholder="Auto (last)"></div>
      </div>
      <div class="ac-two">
        <div class="field" data-f="accessMode"><label for="ac-access-sel">Access</label><select id="ac-access-sel">${accessOpts(node?.accessMode || (kind === "section" ? "free" : "inherit"), kind === "section")}</select><div class="ac-hint" id="ac-access-hint"></div></div>
        <div class="field" data-f="linkedCourseId"><label for="ac-course">Linked course <span class="muted">(optional)</span></label><select id="ac-course">${courseOpts(node?.linkedCourseId || "")}</select><div class="ac-hint" id="ac-course-hint"></div></div>
      </div>
      <div class="ac-hint">Paid items open only for students you grant access to (⋯ → Student access) or whose redeemed access code for the linked course is imported there.</div>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button>
        <button type="submit" class="btn btn-primary btn-block" id="ac-save">${editing ? "Save changes" : "Create"}</button>
      </div>
    </form>`);
  overlay.querySelector(".modal-box").classList.add("wide");

  const f = (sel) => $(sel, overlay);
  // level dropdown follows the section dropdown (subjects only)
  const fillLevels = (selected) => {
    const sel = f("#ac-level");
    if (!sel) return;
    const sid = f("#ac-section").value;
    sel.innerHTML = `<option value="">— Select —</option>${data.levels.filter((l) => l.sectionId === sid).sort(AC.byOrder).map((l) => opt(l.id, l.name, l.id === selected)).join("")}`;
  };
  if (kind === "subject") { fillLevels(preLevel); f("#ac-section").addEventListener("change", () => { fillLevels(""); hint(); }); f("#ac-level").addEventListener("change", hint); }
  if (kind === "level") f("#ac-section").addEventListener("change", hint);

  // "Inherit → follows …"
  function hint() {
    const mode = f("#ac-access-sel").value;
    const out = f("#ac-access-hint");
    if (mode !== "inherit") { out.textContent = mode === "paid" ? "Paid — students need access granted." : "Free — every signed-in student."; return; }
    if (kind === "section") { out.textContent = "Nothing above a section, so Inherit means Free."; return; }
    const index = idx();
    const parentChain = kind === "level" ? index.chainOf("section", f("#ac-section").value) : index.chainOf("level", f("#ac-level")?.value);
    const eff = AC.resolveAccess(parentChain);
    const from = parentChain.find((p) => p.id === eff.nodeId);
    out.textContent = `Follows the parent: ${eff.mode === "paid" ? "Paid" : "Free"}${from ? ` (set on “${from.name}”)` : " (default)"}.`;
  }
  f("#ac-access-sel").addEventListener("change", hint);
  hint();
  // the linked course keeps its own price (existing pricing rule) — say so when it disagrees with this item's access
  function courseHint() {
    const c = courses.find((x) => x.id === f("#ac-course").value);
    const out = f("#ac-course-hint");
    if (!c) { out.textContent = ""; return; }
    const paid = getCoursePricing(c).isPaid;
    const mode = f("#ac-access-sel").value;
    out.textContent = paid && mode === "free" ? "The linked course is Paid, but this item is set to Free — set it to Paid (or Inherit from a Paid parent) to protect it."
      : !paid && mode === "paid" ? "The linked course is Free; this item stays Paid until you grant access." : "";
  }
  f("#ac-course").addEventListener("change", courseHint);
  f("#ac-access-sel").addEventListener("change", courseHint);
  courseHint();

  const img = bindImageField(overlay);
  f("#ac-name").focus();

  f("#ac-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = {
      name: f("#ac-name").value, description: f("#ac-desc").value, coverImage: f("#ac-img").value,
      status: f("#ac-status-sel").value, accessMode: f("#ac-access-sel").value, order: f("#ac-order").value,
      linkedCourseId: f("#ac-course").value,
      sectionId: kind === "section" ? undefined : f("#ac-section").value,
      levelId: kind === "subject" ? f("#ac-level").value : undefined,
    };
    const siblings = listOf(kind).filter((x) => kind === "section" || (kind === "level" ? x.sectionId === input.sectionId : x.levelId === input.levelId));
    const res = AC.validateNodeInput(kind, input, { siblings, editingId: node?.id, sections: data.sections, levels: data.levels, defaultOrder: node ? node.order : AC.nextOrder(siblings) });
    $$(".field.has-error .ac-err", overlay).forEach((x) => x.remove());
    $$(".field.has-error", overlay).forEach((x) => x.classList.remove("has-error"));
    if (!res.ok) {
      for (const [field, code] of Object.entries(res.errors)) {
        const wrap = overlay.querySelector(`[data-f="${field}"]`);
        if (!wrap) continue;
        wrap.classList.add("has-error");
        wrap.insertAdjacentHTML("beforeend", `<div class="ac-err">${esc(errText(code))}</div>`);
      }
      overlay.querySelector(".has-error input, .has-error select, .has-error textarea")?.focus();
      return;
    }
    if (editing && node.status === "active" && res.clean.status !== "active") {
      // hiding a node hides its whole subtree from students → say so before doing it
      const under = AC.deletionBlockers(kind, node.id, { levels: data.levels, subjects: data.subjects, exams: exams || [] });
      if (under.total && !(await confirmDanger({ title: "Hide from students?", message: `“${node.name}” has ${under.levels} level(s), ${under.subjects} subject(s) and ${under.exams} exam(s) under it. Students will stop seeing all of it (nothing is deleted).`, confirmLabel: "Yes, hide it", tone: "primary" }))) return;
    }
    await withBusy(f("#ac-save"), async () => {
      try {
        const { synced } = await D.saveNode(kind, node?.id || null, res.clean);
        closeModal();
        toast(editing ? "আপডেট হয়েছে" : "তৈরি হয়েছে", "success");
        if (!synced) toast("সেভ হয়েছে, কিন্তু স্টুডেন্টদের এক্সাম লিস্ট রিফ্রেশ হয়নি — ⟳ চাপুন।", "info");
        if (img.state() === "bad-load") toast("সেভ হয়েছে — তবে ছবির লিংকটি লোড হয়নি; লিংকটি সরাসরি ছবির কিনা দেখুন।", "info");
        if (!editing) { ui.collapsed.delete(res.clean.sectionId); ui.collapsed.delete(res.clean.levelId); }
        renderKpis(); renderTree();
      } catch (err) { fail(err); }
    });
  });
}

/* ---------- Cover Image URL: validate → preview with a real <img> → report ---------- */
function bindImageField(overlay) {
  const input = $("#ac-img", overlay), prev = $("#ac-img-prev", overlay), msg = $("#ac-img-msg", overlay);
  let token = 0, state = "empty";
  const show = (cls, html) => { prev.className = `ac-img-preview ${cls}`; prev.innerHTML = html; };
  const say = (text, tone = "") => { msg.className = `ac-img-msg ${tone}`; msg.textContent = text; };

  function run() {
    const my = ++token;
    const v = AC.validateImageUrl(input.value);
    $(".ac-err", input.closest(".field"))?.remove();
    input.closest(".field").classList.remove("has-error");
    if (v.empty) { state = "empty"; show("", `<div class="ac-img-state"><i class="fa-regular fa-image"></i>No image — students will see a plain placeholder</div>`); say(""); return; }
    if (!v.ok) { state = "invalid"; show("is-bad", `<div class="ac-img-state"><i class="fa-solid fa-link-slash"></i>Invalid link</div>`); say(AC.IMAGE_REASON_TEXT[v.reason], "bad"); return; }
    state = "loading";
    show("", `<div class="ac-img-state"><span class="spinner"></span>Loading preview…</div>`);
    say("");
    const el = document.createElement("img");          // a real <img> built from the validated URL — never injected as HTML
    el.alt = "Cover preview"; el.referrerPolicy = "no-referrer"; el.decoding = "async";
    el.addEventListener("load", () => {
      if (my !== token) return;
      state = "ok";
      show("is-ok", ""); prev.appendChild(el);
      say(`Image loaded (${el.naturalWidth}×${el.naturalHeight}px).`, "ok");
    });
    el.addEventListener("error", () => {
      if (my !== token) return;
      state = "bad-load";
      show("is-bad", `<div class="ac-img-state"><i class="fa-solid fa-image"></i>Couldn't load this image</div>`);
      say("The link is valid, but the picture did not load. Open it in a new tab — it must show the image itself (not a web page), and the host must allow embedding.", "bad");
    });
    el.src = v.url;
  }
  input.addEventListener("input", debounce(run, 350));
  input.addEventListener("blur", run);
  $("#ac-img-update", overlay).addEventListener("click", run);
  $("#ac-img-remove", overlay).addEventListener("click", () => { input.value = ""; run(); input.focus(); });
  $("#ac-img-replace", overlay).addEventListener("click", async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) { input.value = text; run(); return; }
    } catch { /* no clipboard permission → just let them paste */ }
    input.focus(); input.select();
  });
  run();
  return { state: () => state };
}

/* ==========================================================================
   ⋯ menu
   ========================================================================== */
function openMore(kind, id) {
  sync();
  const n = find(kind, id);
  if (!n) return;
  const w = can("academic.write"), del = can("academic.delete"), acc = can("academic.access");
  const eff = AC.resolveAccess(idx().chainOf(kind, id));
  const item = (act, icon, label, cls = "btn-outline") => `<button type="button" class="btn ${cls}" data-sheet="${act}"><i class="fa-solid ${icon}"></i> ${label}</button>`;
  const overlay = openModal(`
    <div class="modal-head"><h3>${esc(n.name)}</h3><p class="muted" style="font-size:.84rem;margin-top:2px">${KIND_LABEL[kind]}</p></div>
    <div class="ac-sheet">
      ${item("preview", "fa-eye", "Preview as a student")}
      ${w && kind !== "section" ? item("move", "fa-right-left", `Move to another ${kind === "level" ? "section" : "level"}…`) : ""}
      ${w ? item("toggle", n.status === "active" ? "fa-eye-slash" : "fa-eye", n.status === "active" ? "Deactivate (hide from students)" : "Activate (show to students)") : ""}
      ${w ? item("archive", n.status === "archived" ? "fa-box-open" : "fa-box-archive", n.status === "archived" ? "Restore from archive" : "Archive") : ""}
      ${acc ? item("access", "fa-key", `Student access${eff.mode === "paid" ? "" : " (item is Free)"}`) : ""}
      ${del ? item("delete", "fa-trash", "Delete…", "btn-danger") : ""}
      <button type="button" class="btn btn-ghost" data-modal-close>Close</button>
    </div>`);
  overlay.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sheet]");
    if (!b) return;
    const act = b.dataset.sheet;
    closeModal();
    if (act === "preview") return openPreview(kind, id);
    if (act === "move") return openMove(kind, id);
    if (act === "access") return openAccess(kind, id);
    if (act === "delete") return startDelete(kind, id);
    if (act === "toggle") return changeStatus(kind, id, n.status === "active" ? "inactive" : "active");
    if (act === "archive") return changeStatus(kind, id, n.status === "archived" ? "active" : "archived");
  });
}

async function changeStatus(kind, id, status, { confirmed = false } = {}) {
  sync();
  const n = find(kind, id);
  if (!confirmed && status !== "active" && n.status === "active") {
    const under = AC.deletionBlockers(kind, id, { levels: data.levels, subjects: data.subjects, exams: exams || [] });
    if (under.total && !(await confirmDanger({ title: status === "archived" ? "Archive this item?" : "Hide from students?", message: `“${n.name}” has ${under.levels} level(s), ${under.subjects} subject(s) and ${under.exams} exam(s) under it. Students will stop seeing all of it. Nothing is deleted and you can restore it any time.`, confirmLabel: status === "archived" ? "Archive" : "Hide", tone: "primary" }))) return;
  }
  try {
    const { synced } = await D.setNodeStatus(kind, id, status);
    toast(status === "active" ? "এখন স্টুডেন্টদের কাছে দেখাচ্ছে" : status === "archived" ? "আর্কাইভ করা হয়েছে" : "স্টুডেন্টদের কাছ থেকে লুকানো হয়েছে", "success");
    if (!synced) toast("স্ট্যাটাস সেভ হয়েছে, কিন্তু এক্সাম লিস্ট রিফ্রেশ হয়নি — ⟳ চাপুন।", "info");
    renderKpis(); renderTree();
  } catch (err) { fail(err); }
}

/* ==========================================================================
   Preview (the student's card) + link
   ========================================================================== */
function studentHash(kind, n) {
  const index = idx();
  const chain = index.chainOf(kind, n.id);
  const sec = chain.find((x) => x.kind === "section"), lvl = chain.find((x) => x.kind === "level"), sub = chain.find((x) => x.kind === "subject");
  return AC.academicHash({ program: sec?.id, level: lvl?.id, subject: sub?.id });
}

function openPreview(kind, id) {
  sync();
  const n = find(kind, id);
  const index = idx();
  const eff = AC.resolveAccess(index.chainOf(kind, id));
  const ec = examCount(kind, id);
  const meta = [
    kind === "section" ? { icon: KIND_ICON.level, text: plural(data.levels.filter((l) => l.sectionId === id && l.status === "active").length, "Level") } : null,
    kind === "level" ? { icon: KIND_ICON.subject, text: plural(data.subjects.filter((s) => s.levelId === id && s.status === "active").length, "Subject") } : null,
    { icon: "fa-file-pen", text: plural(ec || 0, "Exam") },
  ];
  const href = `${new URL("./", location.href).href}${studentHash(kind, n)}`;
  const overlay = openModal(`
    <div class="modal-head"><h3>Preview</h3></div>
    <div class="ac-preview-wrap">${cardHtml(n, { tag: "div", verdict: { mode: eff.mode, allowed: false, locked: eff.mode === "paid" }, meta })}</div>
    ${n.status !== "active" ? `<div class="note warn mt-12">This item is <b>${esc(n.status)}</b> — students do not see it.</div>` : ""}
    <dl class="kv mt-12">
      <dt>Access</dt><dd>${eff.mode === "paid" ? "Paid" : "Free"}${eff.inherited && eff.source !== "default" ? ` <span class="muted">(inherited from ${esc(eff.source)})</span>` : ""}</dd>
      <dt>Stable ID</dt><dd><code>${esc(n.id)}</code></dd>
      <dt>Student link</dt><dd style="word-break:break-all"><a href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a></dd>
      ${n.updatedAt ? `<dt>Updated</dt><dd>${esc(fmtDate(n.updatedAt))}</dd>` : ""}
    </dl>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" id="ac-copy"><i class="fa-regular fa-copy"></i> Copy link</button><button type="button" class="btn btn-primary btn-block" data-modal-close>Close</button></div>`);
  bindCoverFallbacks(overlay);
  $("#ac-copy", overlay).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(href); toast("লিংক কপি হয়েছে", "success"); } catch { toast(href, "info"); }
  });
}

/* ==========================================================================
   Move to another parent
   ========================================================================== */
async function openMove(kind, id) {
  if (!can("academic.write")) return;
  sync();
  const n = find(kind, id);
  const targets = kind === "level"
    ? data.sections.filter((s) => s.id !== n.sectionId).map((s) => [s.id, s.name])
    : data.levels.filter((l) => l.id !== n.levelId).map((l) => [l.id, `${data.sections.find((s) => s.id === l.sectionId)?.name || "?"} › ${l.name}`]);
  if (!targets.length) { toast(`কোথাও সরানোর মতো ${kind === "level" ? "Section" : "Level"} নেই`, "info"); return; }
  const overlay = openModal(`
    <div class="modal-head"><h3>Move “${esc(n.name)}”</h3></div>
    <div class="field"><label for="ac-mv">New ${kind === "level" ? "section" : "level"}</label><select id="ac-mv"><option value="">— Select —</option>${targets.map(([v, l]) => opt(v, l, false)).join("")}</select></div>
    <div class="note" id="ac-mv-info">Its ${kind === "level" ? "subjects" : "exams"} move with it — nothing is deleted.</div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-primary btn-block" id="ac-mv-go" disabled>Move</button></div>`);
  let plan = null;
  $("#ac-mv", overlay).addEventListener("change", async (e) => {
    plan = null; $("#ac-mv-go", overlay).disabled = true;
    if (!e.target.value) return;
    plan = AC.movePlan(kind, id, e.target.value, data, exams || []);
    const info = $("#ac-mv-info", overlay);
    if (!plan.ok) { info.className = "note bad"; info.textContent = plan.error === "name-duplicate" ? `সেখানে ইতিমধ্যে “${n.name}” নামে একটি আইটেম আছে — আগে নাম বদলান।` : "এই জায়গায় সরানো যাচ্ছে না।"; return; }
    info.className = "note";
    info.textContent = `${plural(plan.counts.subjects, "subject")} and ${plural(plan.counts.exams, "exam")} will follow.`;
    $("#ac-mv-go", overlay).disabled = false;
  });
  $("#ac-mv-go", overlay).addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      // plan again on a fresh exam list so an exam added a minute ago is not left behind
      plan = AC.movePlan(kind, id, $("#ac-mv", overlay).value, data, await fetchAllExamsAdmin({ force: true }));
      if (!plan.ok) { toast("এই জায়গায় সরানো যাচ্ছে না", "error"); return; }
      const { synced } = await D.commitPlan(plan, { courses, label: n.name, kind });
      closeModal(); toast("সরানো হয়েছে", "success");
      if (!synced) toast("সরানো হয়েছে, কিন্তু এক্সাম লিস্ট রিফ্রেশ হয়নি — ⟳ চাপুন।", "info");
      data = D.peekAcademic() || data;
      exams = null; await loadExamsAndRepaint(true);
    } catch (err) { fail(err); }
  }));
}

/* ==========================================================================
   Delete — only an EMPTY node; otherwise archive it or move its content
   ========================================================================== */
async function startDelete(kind, id) {
  if (!can("academic.delete")) return;
  const n = find(kind, id);
  let fresh;
  try { [data, fresh] = [await D.loadAcademic({ force: true }), await fetchAllExamsAdmin({ force: true })]; exams = fresh; } catch (err) { fail(err); return; }
  const b = AC.deletionBlockers(kind, id, { levels: data.levels, subjects: data.subjects, exams: fresh });
  if (!b.blocked) {
    if (!(await confirmDanger({ title: `Delete ${kind}?`, message: `“${n.name}” is empty. This cannot be undone.`, confirmLabel: "Delete", phrase: n.name }))) return;
    try {
      await D.deleteNode(kind, id, { exams: fresh });
      toast("মুছে ফেলা হয়েছে", "success"); renderKpis(); renderTree();
    } catch (err) { err.blockers ? toast("এর নিচে এখনো কনটেন্ট আছে", "error") : fail(err); }
    return;
  }
  // blocked: explain, then offer the two safe ways out
  const sameKind = listOf(kind).filter((x) => x.id !== id);
  const label = (x) => (kind === "subject" ? `${data.sections.find((s) => s.id === x.sectionId)?.name || "?"} › ${data.levels.find((l) => l.id === x.levelId)?.name || "?"} › ${x.name}` : kind === "level" ? `${data.sections.find((s) => s.id === x.sectionId)?.name || "?"} › ${x.name}` : x.name);
  const overlay = openModal(`
    <div class="modal-head"><h3>“${esc(n.name)}” can't be deleted yet</h3></div>
    <p class="muted" style="font-size:.9rem;line-height:1.55">It still contains content. To protect your data, a ${kind} with content is never deleted directly.</p>
    <div class="ac-usage">${b.levels ? chip(plural(b.levels, "level"), "amber") : ""}${b.subjects ? chip(plural(b.subjects, "subject"), "amber") : ""}${b.exams ? chip(plural(b.exams, "exam"), "amber") : ""}</div>
    <div class="ac-sheet">
      ${can("academic.write") && n.status !== "archived" ? `<button type="button" class="btn btn-outline" id="ac-del-arch"><i class="fa-solid fa-box-archive"></i> Archive it instead (hidden from students, nothing lost)</button>` : ""}
      ${can("academic.write") && sameKind.length ? `
        <div class="field"><label for="ac-del-to">…or move all its content to another ${kind}</label>
          <select id="ac-del-to"><option value="">— Select —</option>${sameKind.map((x) => opt(x.id, label(x), false)).join("")}</select></div>
        <div class="note" id="ac-del-info" hidden></div>
        <button type="button" class="btn btn-primary" id="ac-del-move" disabled><i class="fa-solid fa-right-left"></i> Move content, then delete</button>` : ""}
      <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
    </div>`);
  $("#ac-del-arch", overlay)?.addEventListener("click", () => { closeModal(); changeStatus(kind, id, "archived", { confirmed: true }); });
  let plan = null;
  $("#ac-del-to", overlay)?.addEventListener("change", (e) => {
    plan = null;
    const go = $("#ac-del-move", overlay), info = $("#ac-del-info", overlay);
    go.disabled = true; info.hidden = !e.target.value;
    if (!e.target.value) return;
    const clash = AC.moveCollisions(kind, id, e.target.value, data);
    plan = AC.reassignPlan(kind, id, e.target.value, data, fresh);
    if (clash.length) { info.className = "note bad"; info.textContent = `এই নামগুলো টার্গেটে আগে থেকেই আছে: ${clash.join(", ")} — আগে নাম বদলান।`; plan = null; return; }
    if (!plan.ok) { info.className = "note bad"; info.textContent = "এই টার্গেটে সরানো যাচ্ছে না।"; return; }
    info.className = "note";
    info.textContent = `${plural(plan.counts.levels, "level")}, ${plural(plan.counts.subjects, "subject")} and ${plural(plan.counts.exams, "exam")} will be re-pointed. Then “${n.name}” is deleted.`;
    go.disabled = false;
  });
  $("#ac-del-move", overlay)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      await D.commitPlan(plan, { courses, label: n.name, kind });
      await D.deleteNode(kind, id);
      closeModal(); toast("কনটেন্ট সরিয়ে আইটেমটি মুছে ফেলা হয়েছে", "success");
      data = D.peekAcademic() || data; exams = null; await loadExamsAndRepaint(true);
    } catch (err) { err.blockers ? toast("কিছু কনটেন্ট এখনো রয়ে গেছে — আবার চেষ্টা করুন (কাজটি নিরাপদে পুনরায় চালানো যায়)।", "error") : fail(err); }
  }));
}

/* ==========================================================================
   Student access (entitlements) for a Paid node
   ========================================================================== */
async function openAccess(kind, id) {
  if (!can("academic.access")) return;
  sync();
  const n = find(kind, id);
  const eff = AC.resolveAccess(idx().chainOf(kind, id));
  const linked = n.linkedCourseId ? courseTitle(n.linkedCourseId) || n.linkedCourseId : "";
  const overlay = openModal(`
    <div class="modal-head"><h3>Student access</h3><p class="muted" style="font-size:.84rem;margin-top:2px">${KIND_LABEL[kind]} · ${esc(n.name)}</p></div>
    <div class="note ${eff.mode === "paid" ? "" : "warn"}">${eff.mode === "paid"
      ? `This item is <b>Paid</b>. A student opens it (and everything under it) only after you grant access here — firestore.rules checks this record on the server, so hiding a button is not the protection.`
      : `This item is currently <b>Free</b> — everyone can open it. Grants matter only once it (or a parent) is set to Paid.`}</div>
    <div class="field mt-12"><label for="ac-find">Find a student to grant access</label><input type="search" id="ac-find" placeholder="Name, email or roll…" autocomplete="off"></div>
    <div class="ac-find-results" id="ac-found"></div>
    <h4 style="margin:14px 0 4px;font-size:.92rem">Has access <span class="muted" id="ac-ent-n"></span></h4>
    <div class="ac-ent-list" id="ac-ents">${skeleton(2)}</div>
    ${linked ? `<button type="button" class="btn btn-outline btn-sm" id="ac-import"><i class="fa-solid fa-file-import"></i> Import redeemed access codes of “${esc(linked)}”</button>
      <div class="ac-hint">Each access code is created by an admin, so a redeemed one is trusted proof of purchase. Run this after students redeem new codes.</div>` : `<div class="ac-hint">Tip: link a course to this item to import its redeemed access codes in one click.</div>`}
    <div class="confirm-actions"><button type="button" class="btn btn-primary btn-block" data-modal-close>Done</button></div>`);
  overlay.querySelector(".modal-box").classList.add("wide");

  let users = [], grants = [];
  const grantedUids = () => new Set(grants.map((g) => g.uid));
  async function refresh() {
    try { grants = await D.listEntitlements(id); } catch (err) { $("#ac-ents", overlay).innerHTML = isDenied(err) ? rulesHint("Student access") : errorState({ title: "লোড করা যায়নি", retry: false }); return; }
    $("#ac-ent-n", overlay).textContent = `(${grants.length})`;
    $("#ac-ents", overlay).innerHTML = grants.length ? grants.map((g) => `
      <div class="ac-ent"><div class="who"><b>${esc(g.studentName || "Student")}</b><small>${esc(g.studentEmail || g.uid)} · ${esc(g.source === "accessCode" ? "access code" : "admin")}${g.grantedAt ? ` · ${esc(fmtDate(g.grantedAt))}` : ""}</small></div>
        <button type="button" class="btn btn-danger btn-sm" data-revoke="${esc(g.id)}">Revoke</button></div>`).join("") : `<div class="muted" style="font-size:.84rem">No one yet.</div>`;
  }
  $("#ac-ents", overlay).addEventListener("click", async (e) => {
    const b = e.target.closest("[data-revoke]");
    if (!b) return;
    const g = grants.find((x) => x.id === b.dataset.revoke);
    if (!g) return;
    // the confirmation dialog replaces this one (one modal at a time) → after it, this dialog is shown again with the fresh list
    const ok = await confirmDanger({ title: "Revoke access?", message: `${g.studentName || g.studentEmail || "This student"} will no longer open “${n.name}”.`, confirmLabel: "Revoke" });
    if (ok) {
      try { await D.revokeEntitlement(g, n); toast("অ্যাক্সেস তুলে নেওয়া হয়েছে", "success"); } catch (err) { fail(err); }
    }
    openAccess(kind, id);
  });

  const find$ = $("#ac-find", overlay);
  find$.addEventListener("input", debounce(async () => {
    const q = find$.value.trim().toLowerCase();
    const out = $("#ac-found", overlay);
    if (q.length < 2) { out.innerHTML = ""; return; }
    if (!users.length) { try { users = await fetchAllUsersAdmin(); } catch (err) { fail(err); return; } }
    const have = grantedUids();
    const hits = users.filter((u) => !u.isAdmin && `${u.displayName || ""} ${u.email || ""} ${u.roll || ""}`.toLowerCase().includes(q)).slice(0, 8);
    out.innerHTML = hits.length ? hits.map((u) => `
      <div class="ac-ent"><div class="who"><b>${esc(u.displayName || "নাম নেই")}</b><small>${esc(u.email || u.id)}${u.roll ? ` · roll ${esc(u.roll)}` : ""}</small></div>
        ${have.has(u.id) ? chip("Has access", "teal") : `<button type="button" class="btn btn-primary btn-sm" data-grant="${esc(u.id)}">Grant</button>`}</div>`).join("") : `<div class="muted" style="font-size:.84rem">No student found.</div>`;
  }, 220));
  $("#ac-found", overlay).addEventListener("click", (e) => {
    const b = e.target.closest("[data-grant]");
    if (!b) return;
    const u = users.find((x) => x.id === b.dataset.grant);
    withBusy(b, async () => {
      try {
        await D.grantEntitlement({ uid: u.id, node: n, student: { name: u.displayName, email: u.email } });
        toast("অ্যাক্সেস দেওয়া হয়েছে", "success");
        await refresh(); find$.dispatchEvent(new Event("input"));
      } catch (err) { fail(err); }
    });
  });
  $("#ac-import", overlay)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      if (!users.length) users = await fetchAllUsersAdmin().catch(() => []);
      const r = await D.importFromAccessCodes(n, { users });
      toast(r.granted ? `${r.granted} জন শিক্ষার্থীকে অ্যাক্সেস দেওয়া হয়েছে` : "ইমপোর্ট করার মতো ব্যবহৃত অ্যাক্সেস কোড পাওয়া যায়নি", r.granted ? "success" : "info");
      await refresh();
    } catch (err) { fail(err); }
  }));
  await refresh();
}
