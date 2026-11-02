// ==========================================================================
// academic-data.js — every Firestore READ the student side needs for Academic programs.
//
// READ BUDGET (Firestore's free plan = 50,000 reads/day, every returned document is one read)
//   #/exam                    sections (1 query) + one cheap COUNT per section (billed ≈ 1 read per 1,000 matches)
//   #/exam?academicProgram=P  the section doc + its active levels + its active subjects — ONE "section tree",
//                             cached for 5 minutes, and re-used by the level page, the subject page and the
//                             subject dashboard (so drilling down costs 0 extra reads)
//   my entitlements           1 query (usually a handful of documents), cached
//   exam lists / counts       come from examIndex/main, which the exam section already reads (see exam-data.js)
//
// Every query is equality-only (status == "active" [+ sectionId == …]) → no composite index is needed; the lists are
// sorted in the browser. A student can only ever read ACTIVE documents (firestore.rules), so each query carries that filter.
//
// Nothing here ever breaks the existing course list: callers treat a failure as "no academic block".
// ==========================================================================
import { db } from "./firebase-config.js";
import { collection, getDocs, getDoc, doc, query, where } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as FirestoreLib from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "./cache.js";
import { getCoursePricing } from "./utils.js";
import { COL, normalizeNode, byOrder, accessVerdict } from "./academic-core.js";

// read off the namespace on purpose (same pattern as exam-data.js): an SDK build without it only loses the level counts
const { getCountFromServer } = FirestoreLib;

const MIN = 60 * 1000;
const TTL = { sections: 5 * MIN, tree: 5 * MIN, stats: 5 * MIN, entitlements: 5 * MIN, short: 30 * 1000 };

export const isPermissionDenied = (err) => err?.code === "permission-denied";

const activeQuery = (col, ...more) => query(collection(db, col), where("status", "==", "active"), ...more);
const toNodes = (kind, snap) => snap.docs.map((d) => normalizeNode(kind, d.id, d.data())).filter((n) => n.status === "active" && n.name);

/** Every active Academic section, in display order. Rejects on network/rules errors (errors are never cached). */
export function loadSections(opts) {
  return cache.remember("acad:sections", TTL.sections, async () => {
    const snap = await getDocs(activeQuery(COL.section));
    return toNodes("section", snap).sort(byOrder);
  }, { force: cache.wantsFresh(opts) });
}

/**
 * One section with its active levels and subjects: { section, levels, subjects } — or null when it does not exist or is
 * not active (a student's read of an inactive document is refused by the rules; that is the same answer: "not found").
 * Subjects whose level is not active are left out, so the page never shows a subject it can't reach.
 */
export function loadSectionTree(sectionId, opts) {
  return cache.remember(`acad:tree:${sectionId}`, (v) => (v ? TTL.tree : TTL.short), async () => {
    let section = null;
    try {
      const snap = await getDoc(doc(db, COL.section, sectionId));
      section = snap.exists() ? normalizeNode("section", snap.id, snap.data()) : null;
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
    }
    if (!section || section.status !== "active") return null;
    const [lv, sb] = await Promise.all([
      getDocs(activeQuery(COL.level, where("sectionId", "==", sectionId))),
      getDocs(activeQuery(COL.subject, where("sectionId", "==", sectionId))),
    ]);
    const levels = toNodes("level", lv).filter((l) => l.sectionId === sectionId).sort(byOrder);
    const levelIds = new Set(levels.map((l) => l.id));
    const subjects = toNodes("subject", sb).filter((s) => s.sectionId === sectionId && levelIds.has(s.levelId)).sort(byOrder);
    return { section, levels, subjects };
  }, { force: cache.wantsFresh(opts) });
}

/** { levels } for a section card, from one aggregation query — or null (offline, old SDK …): the card then simply omits it. */
export function loadSectionStats(sectionId, opts) {
  return cache.remember(`acad:stats:${sectionId}`, (v) => (v ? TTL.stats : TTL.short), async () => {
    if (typeof getCountFromServer !== "function") return null;
    try {
      const snap = await getCountFromServer(activeQuery(COL.level, where("sectionId", "==", sectionId)));
      const n = Number(snap.data().count);
      return Number.isFinite(n) ? { levels: n } : null;
    } catch { return null; }
  }, { force: cache.wantsFresh(opts) });
}

/**
 * The ids of every node this student has been granted access to (academicEntitlements, written only by admins).
 * A refused read (rules not published yet) simply means "no entitlements".
 */
export async function loadMyEntitlements(uid, opts) {
  if (!uid) return new Set();
  const ids = await cache.remember(`acad:ent:${uid}`, TTL.entitlements, async () => {
    try {
      const snap = await getDocs(query(collection(db, COL.entitlement), where("uid", "==", uid)));
      return snap.docs.map((d) => String(d.data().nodeId || "")).filter(Boolean);
    } catch (err) {
      if (isPermissionDenied(err)) return [];
      throw err;
    }
  }, { force: cache.wantsFresh(opts) });
  return new Set(ids);
}

/** The existing course a node is linked to: { id, title, isPaid } (title + the existing getCoursePricing() rule) — or null. One cached read. */
export function loadCourseInfo(courseId) {
  if (!courseId) return Promise.resolve(null);
  return cache.remember(`acad:course:${courseId}`, (v) => (v ? TTL.tree : TTL.short), async () => {
    try {
      const snap = await getDoc(doc(db, "courses", courseId));
      if (!snap.exists()) return null;
      const c = snap.data();
      return { id: courseId, title: String(c.title || "").slice(0, 120), isPaid: getCoursePricing(c).isPaid };
    } catch { return null; }
  });
}

/** Forget everything academic (after an admin edit in the same browser, on sign-out, on a manual refresh). */
export function invalidateAcademic() {
  cache.delPrefix("acad:");
}

/**
 * Entry gate for ONE exam (used by exam-guard.js before an exam starts):
 *   not an academic exam            → allowed
 *   admin                           → allowed (the rules let admins read everything too)
 *   section/level/subject hidden    → { allowed: false, reason: "hidden" }
 *   Paid and not entitled           → { allowed: false, reason: "payment-required" }
 *   anything unexpected (offline …) → allowed + "unverified": the server rules still decide when the questions are read
 */
export async function checkAcademicExamAccess(exam, { uid = "", isAdmin = false } = {}) {
  if (!exam?.academicSubjectId) return { allowed: true, reason: "not-academic" };
  if (isAdmin) return { allowed: true, reason: "admin" };
  try {
    const tree = await loadSectionTree(exam.academicProgramId);
    if (!tree) return { allowed: false, reason: "hidden" };
    const level = tree.levels.find((l) => l.id === exam.academicLevelId);
    const subject = tree.subjects.find((s) => s.id === exam.academicSubjectId);
    if (!level || !subject || subject.levelId !== level.id) return { allowed: false, reason: "hidden" };
    const entitled = await loadMyEntitlements(uid);
    const verdict = accessVerdict([subject, level, tree.section], entitled);
    return { allowed: verdict.allowed, reason: verdict.reason, verdict };
  } catch {
    return { allowed: true, reason: "unverified" };
  }
}
