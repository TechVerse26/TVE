// ==========================================================================
// admin/core/academic-data.js — every Firestore read/write the Academic Management page needs.
//
//   academicSections/{id}   academicLevels/{id}   academicSubjects/{id}      one document per node (never one big document)
//   academicEntitlements/{uid}_{nodeId}                                       who may open a PAID node (written only here, by admins)
//   examIndex/main.academicHidden                                             ids of nodes that are not active → students' exam catalog skips their exams
//
// Reads: the three collections are read in full ONCE per 10 minutes (admins only, a few hundred small documents at most)
// and kept in memory; every write patches that copy, so the page never re-reads after an edit. The ⟳ button re-reads.
// A cover image is just the https URL string inside the node document — nothing is uploaded anywhere.
// ==========================================================================
import { db, auth } from "../../firebase-config.js";
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "../../cache.js";
import { fetchAllExamsAdmin, primeAdminExams, writeExamIndex, invalidateExamCatalog } from "../../exam-data.js";
import { logAction } from "./audit.js";
import { emitChange } from "./bus.js";
import { toMs } from "./ui.js";
import * as AC from "../../academic-core.js";

const KEY = "admin:academic";
const TTL = 10 * 60 * 1000;
const CHUNK = 400;                         // Firestore allows 500 writes per batch
const INDEX_PATH = ["examIndex", "main"];  // same document exam-data.js reads (INDEX_PATH there)
const LIST_KEY = { section: "sections", level: "levels", subject: "subjects" };

let hiddenSig = null;                      // the hidden-ids list last written in this session

const chunks = (list, n = CHUNK) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const logType = (kind) => `academic-${kind}`;

/* ==========================================================================
   Reading
   ========================================================================== */

/** { sections, levels, subjects } — every status, normalised. Rejects on a rules/network error (never cached). */
export function loadAcademic(opts) {
  return cache.remember(KEY, TTL, async () => {
    const [s, l, b] = await Promise.all([
      getDocs(collection(db, AC.COL.section)),
      getDocs(collection(db, AC.COL.level)),
      getDocs(collection(db, AC.COL.subject)),
    ]);
    return {
      sections: s.docs.map((d) => AC.normalizeNode("section", d.id, d.data())),
      levels: l.docs.map((d) => AC.normalizeNode("level", d.id, d.data())),
      subjects: b.docs.map((d) => AC.normalizeNode("subject", d.id, d.data())),
    };
  }, { force: cache.wantsFresh(opts) });
}

/** The copy in memory, or null if nothing has been loaded yet (no read). */
export const peekAcademic = () => cache.get(KEY) || null;

function setLocal(next) { cache.set(KEY, next, TTL); }

function patchLocal(kind, node) {
  const data = peekAcademic();
  if (!data) return;
  const key = LIST_KEY[kind];
  const list = data[key].some((n) => n.id === node.id) ? data[key].map((n) => (n.id === node.id ? node : n)) : [...data[key], node];
  setLocal({ ...data, [key]: list });
}

/* ==========================================================================
   Keeping the student catalog in step
   ========================================================================== */

/**
 * Publishes the ids of every inactive / archived node into examIndex/main.academicHidden, so the students' exam catalog (which
 * already reads that document) leaves the exams of those nodes out — no extra student read. Skipped when the list did not change
 * (unless `force`). Returns true when a write happened.
 */
export async function syncHidden({ force = false } = {}) {
  const data = peekAcademic();
  if (!data) return false;
  const ids = AC.computeHiddenIds(data);
  const sig = ids.join(",");
  if (!force && sig === hiddenSig) return false;
  await setDoc(doc(db, ...INDEX_PATH), { academicHidden: ids, academicHiddenAt: serverTimestamp() }, { mergeFields: ["academicHidden", "academicHiddenAt"] });
  hiddenSig = sig;
  invalidateExamCatalog();
  return true;
}

/** After any change: refresh the hidden list. A failure here never undoes the change itself — the caller is told. */
async function afterChange() {
  try { await syncHidden(); return { synced: true }; }
  catch (err) { console.warn("[academic] could not refresh the student exam catalog:", err); return { synced: false, error: err }; }
}

/* ==========================================================================
   Create / edit / status / order
   ========================================================================== */

/** Creates (id = null) or updates one section / level / subject. `clean` = validateNodeInput().clean. Returns { node, synced }. */
export async function saveNode(kind, id, clean) {
  const col = AC.COL[kind];
  const isNew = !id;
  const ref = isNew ? doc(collection(db, col)) : doc(db, col, id);
  if (isNew) await setDoc(ref, { ...clean, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  else await updateDoc(ref, { ...clean, updatedAt: serverTimestamp() });

  const prev = peekAcademic()?.[LIST_KEY[kind]].find((n) => n.id === ref.id);
  const now = new Date();
  const node = AC.normalizeNode(kind, ref.id, { ...(prev || {}), ...clean, createdAt: prev?.createdAt ?? now, updatedAt: now });
  patchLocal(kind, node);
  const { synced } = await afterChange();
  logAction(isNew ? "academic.create" : "academic.update", { type: logType(kind), id: ref.id, label: clean.name, detail: `${kind} · ${clean.status} · ${clean.accessMode}` });
  return { node, synced };
}

/** active / inactive / archived. */
export async function setNodeStatus(kind, id, status) {
  const data = peekAcademic();
  const prev = data?.[LIST_KEY[kind]].find((n) => n.id === id);
  if (!AC.STATUSES.includes(status)) throw new Error("bad-status");
  await updateDoc(doc(db, AC.COL[kind], id), { status, updatedAt: serverTimestamp() });
  if (prev) patchLocal(kind, { ...prev, status, updatedAt: new Date() });
  const { synced } = await afterChange();
  logAction("academic.status", { type: logType(kind), id, label: prev?.name || id, detail: `${prev?.status || "?"} → ${status}` });
  return { synced };
}

/** changes = reorderPlan() → [{ id, order }] — one batch. */
export async function applyOrder(kind, changes) {
  if (!changes.length) return;
  for (const part of chunks(changes)) {
    const batch = writeBatch(db);
    part.forEach((c) => batch.update(doc(db, AC.COL[kind], c.id), { order: c.order, updatedAt: serverTimestamp() }));
    await batch.commit();
  }
  const data = peekAcademic();
  if (data) {
    const byId = new Map(changes.map((c) => [c.id, c.order]));
    setLocal({ ...data, [LIST_KEY[kind]]: data[LIST_KEY[kind]].map((n) => (byId.has(n.id) ? { ...n, order: byId.get(n.id) } : n)) });
  }
  logAction("academic.order", { type: logType(kind), label: `${changes.length} ${kind}(s) reordered` });
}

/* ==========================================================================
   Moving content (safe delete → reassign, "Move to…")
   ========================================================================== */

/**
 * Commits a reassignPlan() / movePlan(): node documents and exam documents are re-pointed in batches of 400.
 * Every patch is an absolute target value → if it is interrupted, running the same plan again finishes it.
 * `courses` = the admin's course list (the exam index needs it when it is rewritten).
 */
export async function commitPlan(plan, { courses = [], label = "", kind = "subject" } = {}) {
  if (!plan?.ok || !plan.ops.length) return { synced: true, moved: 0 };
  const exams = await fetchAllExamsAdmin();
  for (const part of AC.chunkOps(plan.ops, { maxOps: CHUNK })) {   // parents first, few distinct parents per batch (the rules look them up)
    const batch = writeBatch(db);
    for (const op of part) {
      if (op.type === "exam") batch.update(doc(db, "exams", op.id), op.patch);
      else batch.update(doc(db, AC.COL[op.type], op.id), { ...op.patch, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }

  const data = peekAcademic();
  if (data) {
    const next = { sections: data.sections, levels: data.levels, subjects: data.subjects };
    for (const type of ["section", "level", "subject"]) {
      const byId = new Map(plan.ops.filter((o) => o.type === type).map((o) => [o.id, o.patch]));
      if (byId.size) next[LIST_KEY[type]] = next[LIST_KEY[type]].map((n) => (byId.has(n.id) ? { ...n, ...byId.get(n.id) } : n));
    }
    setLocal(next);
  }

  const examPatches = new Map(plan.ops.filter((o) => o.type === "exam").map((o) => [o.id, o.patch]));
  if (examPatches.size) {
    const patched = exams.map((e) => (examPatches.has(e.id) ? { ...e, ...examPatches.get(e.id) } : e));
    primeAdminExams(patched);
    // students read exams from examIndex/main — rewrite it now; if that fails the next admin Exams load self-heals it
    await writeExamIndex(patched, courses).catch((err) => console.warn("[academic] exam index not rewritten:", err));
    emitChange("exams");
  }
  const { synced } = await afterChange();
  logAction("academic.move", { type: logType(kind), label, detail: `${plan.counts.levels} level(s), ${plan.counts.subjects} subject(s), ${plan.counts.exams} exam(s)` });
  return { synced, moved: plan.ops.length };
}

/* ==========================================================================
   Deleting
   ========================================================================== */

/**
 * Deletes ONE EMPTY node. The caller has checked deletionBlockers(); this re-checks against fresh data and refuses if anything
 * still hangs under it. The node's access grants go with it (best effort — an orphan grant is harmless).
 */
export async function deleteNode(kind, id, { exams = null } = {}) {
  const data = (await loadAcademic({ force: true })) || peekAcademic();
  const examList = exams || (await fetchAllExamsAdmin({ force: true }));
  const blockers = AC.deletionBlockers(kind, id, { levels: data.levels, subjects: data.subjects, exams: examList });
  if (blockers.blocked) { const err = new Error("blocked"); err.blockers = blockers; throw err; }

  const node = data[LIST_KEY[kind]].find((n) => n.id === id);
  await deleteDoc(doc(db, AC.COL[kind], id));
  setLocal({ ...data, [LIST_KEY[kind]]: data[LIST_KEY[kind]].filter((n) => n.id !== id) });

  try {
    const grants = await getDocs(query(collection(db, AC.COL.entitlement), where("nodeId", "==", id)));
    for (const part of chunks(grants.docs)) {
      const batch = writeBatch(db);
      part.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) { console.warn("[academic] access grants of the deleted node were not cleaned up:", err); }

  const { synced } = await afterChange();
  logAction("academic.delete", { type: logType(kind), id, label: node?.name || id });
  return { synced };
}

/* ==========================================================================
   Access (entitlements) — the trusted record firestore.rules checks for PAID nodes
   ========================================================================== */

/** Everyone granted access to this node (newest first). */
export async function listEntitlements(nodeId) {
  const snap = await getDocs(query(collection(db, AC.COL.entitlement), where("nodeId", "==", nodeId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => toMs(b.grantedAt) - toMs(a.grantedAt));
}

function grantBody(uid, node, { student = {}, source = "admin", ref = "", note = "" } = {}) {
  return {
    uid, nodeId: node.id, nodeKind: node.kind,
    studentName: String(student.name || "").slice(0, 120), studentEmail: String(student.email || "").slice(0, 160),
    source, ref: String(ref || "").slice(0, 80), note: String(note || "").slice(0, 200),
    grantedBy: auth.currentUser?.uid || "", grantedAt: serverTimestamp(),
  };
}

export async function grantEntitlement({ uid, node, student, note = "" }) {
  const id = AC.entitlementId(uid, node.id);
  await setDoc(doc(db, AC.COL.entitlement, id), grantBody(uid, node, { student, note }));
  logAction("academic.access", { type: logType(node.kind), id: node.id, label: node.name, detail: `granted → ${student?.email || uid}` });
  return id;
}

export async function revokeEntitlement(entitlement, node) {
  await deleteDoc(doc(db, AC.COL.entitlement, entitlement.id));
  logAction("academic.access", { type: logType(node.kind), id: node.id, label: node.name, detail: `revoked → ${entitlement.studentEmail || entitlement.uid}` });
}

/**
 * Bridges the existing course purchases: every access code of the node's linked course that was issued by an admin AND redeemed
 * (accessCodes/{code}: uid, courseId, used === true — admin-created, so it is trusted evidence of a real purchase) becomes an
 * entitlement. `users` (optional) = the admin's user list, only used to store a readable name/email next to the grant.
 * → { found, granted }
 */
export async function importFromAccessCodes(node, { users = [] } = {}) {
  if (!node.linkedCourseId) throw new Error("no-linked-course");
  const snap = await getDocs(query(collection(db, "accessCodes"), where("courseId", "==", node.linkedCourseId)));
  const redeemed = new Map();
  snap.docs.forEach((d) => { const c = d.data(); if (c.used === true && typeof c.uid === "string" && c.uid) redeemed.set(c.uid, d.id); });
  const byUid = new Map(users.map((u) => [u.id, u]));
  const entries = Array.from(redeemed, ([uid, code]) => ({ uid, code, user: byUid.get(uid) }));
  for (const part of chunks(entries)) {
    const batch = writeBatch(db);
    part.forEach(({ uid, code, user }) => batch.set(
      doc(db, AC.COL.entitlement, AC.entitlementId(uid, node.id)),
      grantBody(uid, node, { student: { name: user?.name || user?.displayName || "", email: user?.email || "" }, source: "accessCode", ref: code }),
    ));
    await batch.commit();
  }
  logAction("academic.access", { type: logType(node.kind), id: node.id, label: node.name, detail: `imported ${entries.length} from redeemed access codes` });
  return { found: snap.size, granted: entries.length };
}
