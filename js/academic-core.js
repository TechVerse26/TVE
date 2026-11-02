// ==========================================================================
// academic-core.js — the pure logic of the Academic Management system.
//
//   Academic Section  ›  Level  ›  Subject  ›  Exams          (every name is admin-created data, none is hard-coded)
//   academicSections/{id}   academicLevels/{id}   academicSubjects/{id}   academicEntitlements/{uid}_{nodeId}
//
// No Firebase, no DOM in this file: the student pages (academic-data.js / academic-render.js), the admin panel
// (admin/academic.js) and the unit tests (tests/unit/academic.test.mjs) all share ONE implementation of
//   • image-URL validation        (cover images are plain https URL strings in Firestore — never files, never Storage)
//   • node normalisation / input validation
//   • Free / Paid / Inherit resolution + entitlement check (mirrors firestore.rules → academicAllowsStudent)
//   • tree building, ordering, deletion guards
//   • the #/exam?academicProgram=… route scheme
// ==========================================================================

export const COL = Object.freeze({
  section: "academicSections",
  level: "academicLevels",
  subject: "academicSubjects",
  entitlement: "academicEntitlements",
});
export const KINDS = Object.freeze(["section", "level", "subject"]);
export const STATUSES = Object.freeze(["active", "inactive", "archived"]);
export const ACCESS_MODES = Object.freeze(["free", "paid", "inherit"]);
export const BUCKETS = Object.freeze(["upcoming", "live", "practice"]);
export const LIMITS = Object.freeze({ name: 80, description: 400, url: 2048, order: 100000, course: 128 });

/** The exam-document field that points at each kind of node (all three are optional on an exam). */
export const EXAM_FIELD = Object.freeze({ section: "academicProgramId", level: "academicLevelId", subject: "academicSubjectId" });

/* ==========================================================================
   Small helpers
   ========================================================================== */

/** Firestore auto-ids (and our own test ids) only: safe to put in a URL, a selector or a document path. */
export const isSafeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Collapses whitespace/newlines, trims and caps the length. Never returns a non-string. */
export function cleanText(value, max = LIMITS.name) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export const displayName = (node) => (node && node.name ? node.name : "Untitled");

/* ==========================================================================
   Cover image URL — the ONLY thing stored for a picture is this string
   ==========================================================================
   Accepts a direct https link, nothing else: no javascript:, data:, blob:, file:, ftp:, no plain http, no credentials in
   the URL, no whitespace or control characters. Returns the normalised URL (URL#href — quotes, < and > come out
   percent-encoded), so what is saved is always safe to drop into an <img src>. */
export function validateImageUrl(raw, { allowEmpty = true } = {}) {
  const s = String(raw ?? "").trim();
  if (!s) return allowEmpty ? { ok: true, url: "", empty: true } : { ok: false, reason: "empty" };
  if (s.length > LIMITS.url) return { ok: false, reason: "too-long" };
  if (/[\u0000-\u0020\u007f-\u009f]/.test(s)) return { ok: false, reason: "whitespace" };
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: "invalid" }; }
  if (u.protocol === "http:") return { ok: false, reason: "not-https" };
  if (u.protocol !== "https:") return { ok: false, reason: "unsafe-scheme" };
  if (!u.hostname || !u.hostname.includes(".")) return { ok: false, reason: "invalid" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  return { ok: true, url: u.href };
}

/** For RENDERING: the URL if it is a valid https image link, otherwise "" (so bad data can never become markup). */
export function safeImageUrl(raw) {
  const v = validateImageUrl(raw);
  return v.ok ? v.url : "";
}

/** Human message for each validateImageUrl() reason (shown under the admin's URL field). */
export const IMAGE_REASON_TEXT = Object.freeze({
  empty: "Paste the direct link of an image.",
  "too-long": "This link is too long (max 2048 characters).",
  whitespace: "The link must not contain spaces or line breaks.",
  invalid: "This is not a valid web address.",
  "not-https": "Only secure https:// links are accepted — this one starts with http://.",
  "unsafe-scheme": "Only https:// image links are accepted (no data:, javascript:, file: …).",
  credentials: "Remove the username/password from the link.",
});

/* ==========================================================================
   Nodes
   ========================================================================== */

/** Defensive copy of a Firestore document: every field present, right type, capped length, safe cover URL. */
export function normalizeNode(kind, id, raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const order = Number(r.order);
  const node = {
    kind,
    id: String(id || r.id || ""),
    name: cleanText(r.name, LIMITS.name),
    description: cleanText(r.description, LIMITS.description),
    coverImage: safeImageUrl(r.coverImage),
    // A document with no (or a broken) status is treated as NOT published — firestore.rules hides it from students too.
    status: STATUSES.includes(r.status) ? r.status : "inactive",
    order: Number.isFinite(order) ? order : 0,
    accessMode: ACCESS_MODES.includes(r.accessMode) ? r.accessMode : "inherit",
    linkedCourseId: typeof r.linkedCourseId === "string" ? r.linkedCourseId.slice(0, LIMITS.course) : "",
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
  if (kind !== "section") node.sectionId = typeof r.sectionId === "string" ? r.sectionId : "";
  if (kind === "subject") node.levelId = typeof r.levelId === "string" ? r.levelId : "";
  return node;
}

export const byOrder = (a, b) =>
  (Number(a.order) || 0) - (Number(b.order) || 0) ||
  String(a.name || "").localeCompare(String(b.name || ""), "bn", { numeric: true, sensitivity: "base" });

/**
 * Validates what the admin typed in the create/edit form and returns the document fields to save.
 *   input: { name, description, coverImage, status, order, accessMode, linkedCourseId, sectionId?, levelId? }
 *   ctx:   { siblings: [nodes under the same parent], editingId, sections: [], levels: [], defaultOrder }
 * → { ok, errors: { field: code }, clean }
 */
export function validateNodeInput(kind, input = {}, ctx = {}) {
  const errors = {};
  const name = cleanText(input.name, LIMITS.name + 1);
  if (!name) errors.name = "name-required";
  else if (name.length > LIMITS.name) errors.name = "name-too-long";
  else {
    const dup = (ctx.siblings || []).some((n) => n.id !== ctx.editingId && cleanText(n.name).toLowerCase() === name.toLowerCase());
    if (dup) errors.name = "name-duplicate";
  }

  const description = cleanText(input.description, LIMITS.description + 1);
  if (description.length > LIMITS.description) errors.description = "desc-too-long";

  const img = validateImageUrl(input.coverImage);
  if (!img.ok) errors.coverImage = `image-${img.reason}`;

  const status = input.status === undefined ? "active" : input.status;
  if (!STATUSES.includes(status)) errors.status = "status-invalid";

  const accessMode = input.accessMode === undefined ? "inherit" : input.accessMode;
  if (!ACCESS_MODES.includes(accessMode)) errors.accessMode = "access-invalid";

  let order = ctx.defaultOrder ?? 0;
  const orderRaw = input.order;
  if (orderRaw !== undefined && orderRaw !== null && String(orderRaw).trim() !== "") {
    const n = Number(orderRaw);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.order) errors.order = "order-invalid";
    else order = n;
  }

  const linkedCourseId = String(input.linkedCourseId ?? "").trim();
  if (linkedCourseId && (linkedCourseId.length > LIMITS.course || !isSafeId(linkedCourseId))) errors.linkedCourseId = "course-invalid";

  const clean = {
    name: name.slice(0, LIMITS.name),
    description: description.slice(0, LIMITS.description),
    coverImage: img.ok ? img.url : "",
    status, order, accessMode, linkedCourseId,
  };

  if (kind === "level" || kind === "subject") {
    const sectionId = String(input.sectionId ?? "");
    clean.sectionId = sectionId;
    if (!sectionId || (ctx.sections && !ctx.sections.some((s) => s.id === sectionId))) errors.sectionId = "parent-missing";
  }
  if (kind === "subject") {
    const levelId = String(input.levelId ?? "");
    clean.levelId = levelId;
    const level = (ctx.levels || []).find((l) => l.id === levelId);
    if (!levelId || (ctx.levels && !level)) errors.levelId = "parent-missing";
    else if (level && level.sectionId !== clean.sectionId) errors.levelId = "parent-mismatch";
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

/* ==========================================================================
   Index + tree
   ========================================================================== */

/** Lookup maps over the three node lists. `chainOf(kind, id)` = [node, parent, grandparent] (leaf first). */
export function indexNodes({ sections = [], levels = [], subjects = [] } = {}) {
  const sec = new Map(sections.map((n) => [n.id, n]));
  const lvl = new Map(levels.map((n) => [n.id, n]));
  const sub = new Map(subjects.map((n) => [n.id, n]));
  const get = (kind, id) => (kind === "section" ? sec : kind === "level" ? lvl : sub).get(id) || null;
  function chainOf(kind, id) {
    const node = get(kind, id);
    if (!node) return [];
    const chain = [node];
    if (kind === "subject") {
      const l = lvl.get(node.levelId);
      if (l) { chain.push(l); const s = sec.get(l.sectionId); if (s) chain.push(s); }
    } else if (kind === "level") {
      const s = sec.get(node.sectionId);
      if (s) chain.push(s);
    }
    return chain;
  }
  return { sec, lvl, sub, get, chainOf };
}

const group = (list, key) => {
  const m = new Map();
  for (const n of list) { const k = n[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
  return m;
};

/** Sections › levels › subjects, each list in display order. Orphans (a parent that no longer exists) are returned separately. */
export function buildTree({ sections = [], levels = [], subjects = [] } = {}) {
  const levelsBySection = group(levels, "sectionId");
  const subjectsByLevel = group(subjects, "levelId");
  const tree = sections.slice().sort(byOrder).map((s) => ({
    ...s,
    levels: (levelsBySection.get(s.id) || []).slice().sort(byOrder).map((l) => ({
      ...l,
      subjects: (subjectsByLevel.get(l.id) || []).slice().sort(byOrder),
    })),
  }));
  const sectionIds = new Set(sections.map((s) => s.id));
  const levelById = new Map(levels.map((l) => [l.id, l]));
  return {
    tree,
    orphanLevels: levels.filter((l) => !sectionIds.has(l.sectionId)),
    // a subject is an orphan when its level is gone, is itself an orphan (its section is gone), or belongs to another section
    orphanSubjects: subjects.filter((s) => { const l = levelById.get(s.levelId); return !l || l.sectionId !== s.sectionId || !sectionIds.has(l.sectionId); }),
  };
}

/* ==========================================================================
   Free / Paid / Inherit
   ==========================================================================
   A node's own mode wins; "inherit" asks the parent; a section that inherits is Free (there is nothing above it).
   `chain` = [subject, level, section] (or any leaf-first prefix). */
export function resolveAccess(chain = []) {
  const leaf = chain[0] || null;
  for (const node of chain) {
    if (node && (node.accessMode === "paid" || node.accessMode === "free")) {
      return { mode: node.accessMode, source: node.kind, nodeId: node.id, inherited: node !== leaf };
    }
  }
  return { mode: "free", source: "default", nodeId: "", inherited: true };
}

/** Does the student hold an entitlement for ANY node on the chain? An entitlement covers its node and everything below it. */
export function isEntitled(chain = [], entitledIds) {
  if (!entitledIds) return false;
  const set = entitledIds instanceof Set ? entitledIds : new Set(entitledIds);
  return chain.some((n) => n && set.has(n.id));
}

/**
 * The student-facing verdict for one node. The SAME rule firestore.rules applies to an exam's questions
 * (academicAllowsStudent) — this copy only decides what the page shows; the server decides what can be read.
 *   → { allowed, locked, reason: "free" | "admin" | "entitled" | "payment-required" | "hidden", mode, source, nodeId, inherited }
 */
export function accessVerdict(chain = [], entitledIds, { isAdmin = false } = {}) {
  const eff = resolveAccess(chain);
  if (chain.some((n) => !n || n.status !== "active") && !isAdmin) return { ...eff, allowed: false, locked: false, reason: "hidden" };
  if (eff.mode !== "paid") return { ...eff, allowed: true, locked: false, reason: "free" };
  if (isAdmin) return { ...eff, allowed: true, locked: false, reason: "admin" };
  const ok = isEntitled(chain, entitledIds);
  return { ...eff, allowed: ok, locked: !ok, reason: ok ? "entitled" : "payment-required" };
}

/** Document id of an entitlement: one document per (student, node) — the same id firestore.rules checks with exists(). */
export const entitlementId = (uid, nodeId) => `${uid}_${nodeId}`;

/* ==========================================================================
   Exams ↔ academic nodes
   ========================================================================== */

/** The exams (index entries or exam docs) that sit directly under one node. */
export function examsOfNode(exams = [], kind, id) {
  const field = EXAM_FIELD[kind];
  return exams.filter((e) => e && e[field] === id);
}

export const hasAcademic = (exam) => !!(exam && exam.academicSubjectId);

/** Exams stay in examIndex/main; the admin panel only publishes the ids of nodes that are NOT active. */
export function isAcademicHidden(exam, hidden) {
  if (!exam || !hidden || !hidden.size) return false;
  return hidden.has(exam.academicProgramId) || hidden.has(exam.academicLevelId) || hidden.has(exam.academicSubjectId);
}

/** Ids of every section / level / subject that is not active (sorted, de-duplicated) → examIndex/main.academicHidden. */
export function computeHiddenIds({ sections = [], levels = [], subjects = [] } = {}) {
  const ids = new Set();
  for (const n of [...sections, ...levels, ...subjects]) if (n.status !== "active") ids.add(n.id);
  return Array.from(ids).sort();
}

/**
 * The exam form's "Academic placement": all three empty (not academic) or all three set and consistent.
 * → { ok, empty?, error?: "incomplete" | "missing" | "mismatch", payload }  (payload = the three exam fields)
 */
export function validatePlacement({ sectionId = "", levelId = "", subjectId = "" } = {}, index) {
  const none = { academicProgramId: "", academicLevelId: "", academicSubjectId: "" };
  if (!sectionId && !levelId && !subjectId) return { ok: true, empty: true, payload: none };
  if (!sectionId || !levelId || !subjectId) return { ok: false, error: "incomplete", payload: none };
  const s = index?.sec.get(sectionId), l = index?.lvl.get(levelId), sub = index?.sub.get(subjectId);
  if (!s || !l || !sub) return { ok: false, error: "missing", payload: none };
  if (l.sectionId !== sectionId || sub.levelId !== levelId || sub.sectionId !== sectionId) return { ok: false, error: "mismatch", payload: none };
  return { ok: true, payload: { academicProgramId: sectionId, academicLevelId: levelId, academicSubjectId: subjectId } };
}

/**
 * Where "Go back" / "Course exams" should lead from an exam's entry or result screen: an exam that sits in an academic subject
 * goes back to THAT subject's dashboard; every other exam keeps the `fallback` it always had (its course's exam list).
 */
export function examBackHref(exam, fallback) {
  const ids = exam ? [exam.academicProgramId, exam.academicLevelId, exam.academicSubjectId] : [];
  if (ids.length === 3 && ids.every(isSafeId)) return academicHash({ program: ids[0], level: ids[1], subject: ids[2] });
  return fallback;
}

/** "SSC › Mathematics" for an exam, from the node index (names only for what still exists). */
export function placementPath(exam, index) {
  if (!hasAcademic(exam) || !index) return "";
  return [index.sec.get(exam.academicProgramId), index.lvl.get(exam.academicLevelId), index.sub.get(exam.academicSubjectId)]
    .filter(Boolean).map(displayName).join(" › ");
}

/* ==========================================================================
   Admin helpers
   ========================================================================== */

/** What still hangs under a node → a node with any of it can't be deleted outright (archive it, or move the content). */
export function deletionBlockers(kind, id, { levels = [], subjects = [], exams = [] } = {}) {
  const out = { levels: 0, subjects: 0, exams: 0 };
  if (kind === "section") {
    out.levels = levels.filter((l) => l.sectionId === id).length;
    out.subjects = subjects.filter((s) => s.sectionId === id).length;
    out.exams = exams.filter((e) => e.academicProgramId === id).length;
  } else if (kind === "level") {
    out.subjects = subjects.filter((s) => s.levelId === id).length;
    out.exams = exams.filter((e) => e.academicLevelId === id).length;
  } else {
    out.exams = exams.filter((e) => e.academicSubjectId === id).length;
  }
  const total = out.levels + out.subjects + out.exams;
  return { ...out, total, blocked: total > 0 };
}

/* ---------- moving content between nodes (the "Safe delete → move it somewhere else" flow, and "Move to…") ----------
   Pure planners: they only describe WHICH documents change and HOW → [{ type: "section"|"level"|"subject"|"exam", id, patch }].
   admin/core/academic-data.js commits them in batches. Every patch sets absolute target values, so running a plan again
   after an interruption only finishes what is left (idempotent), and moving back is just the reverse plan. */

const sameName = (a, b) => cleanText(a.name).toLowerCase() === cleanText(b.name).toLowerCase();

/** Names that would end up twice under one parent if `fromId`'s children were moved under `toId`. */
export function moveCollisions(kind, fromId, toId, { levels = [], subjects = [] } = {}) {
  const [moving, there] = kind === "level"
    ? [subjects.filter((s) => s.levelId === fromId), subjects.filter((s) => s.levelId === toId)]
    : kind === "section"
      ? [levels.filter((l) => l.sectionId === fromId), levels.filter((l) => l.sectionId === toId)]
      : [[], []];
  return moving.filter((n) => there.some((t) => sameName(n, t))).map((n) => n.name);
}

/** Everything under `fromId` (children + exams) re-pointed to the same kind of node `toId`. */
export function reassignPlan(kind, fromId, toId, nodes = {}, exams = []) {
  const { sections = [], levels = [], subjects = [] } = nodes;
  const index = indexNodes({ sections, levels, subjects });
  const to = index.get(kind, toId);
  if (!to || !index.get(kind, fromId) || fromId === toId) return { ok: false, error: "target" };
  const ops = [];
  const exam = (e, patch) => ops.push({ type: "exam", id: e.id, patch });
  if (kind === "subject") {
    const chain = index.chainOf("subject", toId);
    if (chain.length < 3) return { ok: false, error: "target-broken" };
    exams.filter((e) => e.academicSubjectId === fromId)
      .forEach((e) => exam(e, { academicProgramId: chain[2].id, academicLevelId: chain[1].id, academicSubjectId: toId }));
  } else if (kind === "level") {
    if (!index.sec.get(to.sectionId)) return { ok: false, error: "target-broken" };
    subjects.filter((s) => s.levelId === fromId).forEach((s) => ops.push({ type: "subject", id: s.id, parent: toId, patch: { levelId: toId, sectionId: to.sectionId } }));
    exams.filter((e) => e.academicLevelId === fromId).forEach((e) => exam(e, { academicLevelId: toId, academicProgramId: to.sectionId }));
  } else {
    levels.filter((l) => l.sectionId === fromId).forEach((l) => ops.push({ type: "level", id: l.id, parent: toId, patch: { sectionId: toId } }));
    subjects.filter((s) => s.sectionId === fromId).forEach((s) => ops.push({ type: "subject", id: s.id, parent: s.levelId, patch: { sectionId: toId } }));
    exams.filter((e) => e.academicProgramId === fromId).forEach((e) => exam(e, { academicProgramId: toId }));
  }
  return { ok: true, ops, counts: countOps(ops) };
}

/** Move ONE level under another section, or ONE subject under another level — its children and exams follow. */
export function movePlan(kind, id, newParentId, nodes = {}, exams = []) {
  const { sections = [], levels = [], subjects = [] } = nodes;
  const index = indexNodes({ sections, levels, subjects });
  const node = index.get(kind, id);
  if (!node || kind === "section") return { ok: false, error: "kind" };
  const ops = [];
  if (kind === "level") {
    if (!index.sec.get(newParentId)) return { ok: false, error: "target" };
    if (node.sectionId === newParentId) return { ok: false, error: "same" };
    if (levels.some((l) => l.id !== id && l.sectionId === newParentId && sameName(l, node))) return { ok: false, error: "name-duplicate" };
    ops.push({ type: "level", id, parent: newParentId, patch: { sectionId: newParentId } });
    subjects.filter((s) => s.levelId === id).forEach((s) => ops.push({ type: "subject", id: s.id, parent: id, patch: { sectionId: newParentId } }));
    exams.filter((e) => e.academicLevelId === id).forEach((e) => ops.push({ type: "exam", id: e.id, patch: { academicProgramId: newParentId } }));
  } else {
    const parent = index.lvl.get(newParentId);
    if (!parent || !index.sec.get(parent.sectionId)) return { ok: false, error: "target" };
    if (node.levelId === newParentId) return { ok: false, error: "same" };
    if (subjects.some((s) => s.id !== id && s.levelId === newParentId && sameName(s, node))) return { ok: false, error: "name-duplicate" };
    ops.push({ type: "subject", id, parent: newParentId, patch: { levelId: newParentId, sectionId: parent.sectionId } });
    exams.filter((e) => e.academicSubjectId === id).forEach((e) => ops.push({ type: "exam", id: e.id, patch: { academicLevelId: newParentId, academicProgramId: parent.sectionId } }));
  }
  return { ok: true, ops, counts: countOps(ops) };
}

/**
 * Splits a plan into write batches. Firestore allows 500 writes per batch, and the security rules may look up at most ~20 other
 * documents per batch — every level / subject write that changes its parent looks up that parent. So a batch holds at most
 * `maxOps` writes AND `maxParents` different parents, and the order is parents-first (levels before the subjects that sit in
 * them, exams last) so every batch only depends on batches that were already committed.
 */
export function chunkOps(ops = [], { maxOps = 400, maxParents = 10 } = {}) {
  const rank = { section: 0, level: 1, subject: 2, exam: 3 };
  const sorted = ops.map((op, i) => ({ op, i })).sort((a, b) => (rank[a.op.type] - rank[b.op.type]) || String(a.op.parent || "").localeCompare(String(b.op.parent || "")) || (a.i - b.i)).map((x) => x.op);
  const batches = [];
  let cur = [], parents = new Set();
  const flush = () => { if (cur.length) batches.push(cur); cur = []; parents = new Set(); };
  for (const op of sorted) {
    const p = op.parent || "";
    if (cur.length >= maxOps || (p && !parents.has(p) && parents.size >= maxParents)) flush();
    cur.push(op);
    if (p) parents.add(p);
  }
  flush();
  return batches;
}

const countOps = (ops) => ({
  levels: ops.filter((o) => o.type === "level").length,
  subjects: ops.filter((o) => o.type === "subject").length,
  exams: ops.filter((o) => o.type === "exam").length,
});

/** Next display order for a new sibling: 10 after the current last one. */
export const nextOrder = (siblings = []) => siblings.reduce((m, n) => Math.max(m, Number(n.order) || 0), 0) + 10;

/** Move one sibling up/down: the full list is renumbered 10, 20, 30 … → only the rows whose order really changes. */
export function reorderPlan(siblings = [], id, direction) {
  const list = siblings.slice().sort(byOrder);
  const i = list.findIndex((n) => n.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  const changes = [];
  list.forEach((n, k) => { const order = (k + 1) * 10; if (Number(n.order) !== order) changes.push({ id: n.id, order }); });
  return changes;
}

/** Numbers for the admin dashboard cards. `exams` = the exam documents (only the ones with academic ids count). */
export function academicSummary({ sections = [], levels = [], subjects = [] } = {}, exams = []) {
  const index = indexNodes({ sections, levels, subjects });
  const all = [...sections, ...levels, ...subjects];
  let free = 0, paid = 0, active = 0;
  for (const n of all) {
    if (resolveAccess(index.chainOf(n.kind, n.id)).mode === "paid") paid++; else free++;
    if (n.status === "active") active++;
  }
  return {
    sections: sections.length, levels: levels.length, subjects: subjects.length,
    exams: exams.filter(hasAcademic).length,
    free, paid, active, inactive: all.length - active,
  };
}

/* ==========================================================================
   Routes — #/exam?academicProgram=P&academicLevel=L&academicSubject=S&type=practice
   ========================================================================== */

/**
 * Reads the academic part of a route. `params` = URLSearchParams.
 * → null when the URL is not an academic one; otherwise { program, level, subject, type, invalid }.
 * `invalid` = an id with odd characters, a child without its parent, or an unknown `type` (the page shows "not found").
 */
export function parseAcademicParams(params) {
  const program = params?.get?.("academicProgram");
  if (!program) return null;
  const level = params.get("academicLevel") || "";
  const subject = params.get("academicSubject") || "";
  const type = params.get("type") || "";
  const invalid =
    !isSafeId(program) ||
    (level && !isSafeId(level)) || (subject && !isSafeId(subject)) ||
    (subject && !level) ||
    (type && (!subject || !BUCKETS.includes(type)));
  return { program, level, subject, type, invalid: !!invalid };
}

/** The hash for any academic page: academicHash({ program }) → "#/exam?academicProgram=…". Children are dropped unless their parent is given. */
export function academicHash({ program, level, subject, type } = {}) {
  if (!program) return "#/exam";
  const q = [`academicProgram=${encodeURIComponent(program)}`];
  if (level) {
    q.push(`academicLevel=${encodeURIComponent(level)}`);
    if (subject) {
      q.push(`academicSubject=${encodeURIComponent(subject)}`);
      if (type && BUCKETS.includes(type)) q.push(`type=${encodeURIComponent(type)}`);
    }
  }
  return `#/exam?${q.join("&")}`;
}
