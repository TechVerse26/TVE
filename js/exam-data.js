// ==========================================================================
// exam-data.js — every Firestore read/write the exam section needs.
//
// READ / WRITE BUDGET
// Firestore's free (Spark) plan gives 50,000 document reads and 20,000 writes
// per day, and EVERY document a query returns counts as one read. This file
// is built around one rule: never pay twice for the same data, and never pay
// per-question / per-exam when one document can carry the whole set.
//
//   Data                      Before                      Now
//   ─────────────────────────────────────────────────────────────────────
//   exam list (each screen)   1 read per exam, every      1 read (examIndex/main),
//                             screen, every time          then cached 5 min
//   course name + cover       1 read per course           0 (lives in the index)
//   my result per exam card   1 read per exam card        0 (one userStats doc)
//   my profile (users/{uid})  1 read per screen + exam    1 read, cached 5 min
//   questions of an exam      1 read per QUESTION         1 read per ~600 KB
//                             (50 questions = 50 reads)   (a bundle doc), cached
//   admin: save a 50-q exam   ~50 reads + 50 deletes      1 write
//                             + 50 writes (+ rules reads)
//   admin: open the panel     ~4 full collection scans    count/sum/avg aggregates
//                                                         (≈ 1 read per 1,000 docs)
//
// New collections (see firestore.rules):
//   examIndex/main        one doc: a slim copy of every exam + course names
//   examBundles/{examId}  the exam's whole question bank (split only if huge)
//   userStats/{uid}       one doc per student: a compact summary of their results
//
// Everything degrades gracefully: if the new rules are not published yet, or a
// new doc does not exist yet, each function silently falls back to the old
// per-document behaviour, so the site never breaks — it is just not cheaper yet.
// ==========================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, query, where, orderBy,
  setDoc, updateDoc, deleteField, writeBatch, serverTimestamp, Timestamp, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as FirestoreLib from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "./cache.js";

// count / sum / average are read off the namespace object on purpose: if some
// SDK build ever lacked them, this module would still load and only the
// aggregate-based admin overview would fall back to its slower path.
const { getAggregateFromServer, sum, average, count } = FirestoreLib;

/* ==========================================================================
   Tunables
   ========================================================================== */

/**
 * The question bank is stored as ONE bundle document per exam (examBundles/{id}).
 * Set this to true only if another site/app still reads the old
 * exams/{id}/questions subcollection and must keep seeing questions saved here —
 * every save then ALSO rewrites the old per-question docs (the expensive way).
 */
export const KEEP_LEGACY_QUESTION_DOCS = false;

/** exams/{id}.qFormat === 2  →  questions live in examBundles/{id}. */
export const QUESTION_FORMAT = 2;

const MIN = 60 * 1000;
const TTL = {
  catalog: 5 * MIN,      // exam list + course names
  questions: 10 * MIN,   // a loaded question bank (retakes in the same visit are free)
  stats: 10 * MIN,       // my per-exam summary
  myResults: 3 * MIN,    // my full result docs ("My Activity")
  percentile: 10 * MIN,  // anonymous rank pool
  course: 30 * MIN,      // a single course doc (fallback path only)
  admin: 5 * MIN,        // admin: users / results / exams collections
  retry: 30 * 1000,      // how long a FAILED lookup is remembered (stops retry storms)
};

/* ==========================================================================
   Small helpers
   ========================================================================== */
const isPermissionDenied = (err) => err?.code === "permission-denied";

function approxBytes(value) {
  try { return new Blob([JSON.stringify(value)]).size; } catch { return 0; }
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

function timestampToMs(ts) {
  if (ts?.toMillis) return ts.toMillis();
  if (ts?.seconds) return ts.seconds * 1000;
  return null;
}

const byNewest = (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);

/** Stable, order-independent JSON of anything (Timestamps → millis) — used to tell "did this change?". */
function stable(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (typeof v.toMillis === "function") return v.toMillis();
    if (Array.isArray(v)) return v.map(stable);
    const out = {};
    Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) out[k] = stable(v[k]); });
    return out;
  }
  return v;
}

/* ==========================================================================
   1. Exam catalog — the student-facing exam list
   ==========================================================================
   examIndex/main = { exams: [ …every exam doc, without questions… ],
                      courses: { [courseId]: { title, coverImage } } }
   One read replaces "read every exam doc + every course doc" on every screen.
   The admin panel keeps it in sync (see syncExamIndex); if it does not exist
   yet, we fall back to reading the exams collection — but only once per 5 min. */
const INDEX_PATH = ["examIndex", "main"];
const INDEX_MAX_BYTES = 880 * 1024; // stay clear of the 1 MB document limit

async function readExamIndexDoc() {
  try {
    const snap = await getDoc(doc(db, ...INDEX_PATH));
    if (!snap.exists()) return null;
    const d = snap.data();
    if (!Array.isArray(d.exams)) return null;
    return {
      exams: d.exams.filter((e) => e && e.id),
      courses: d.courses && typeof d.courses === "object" ? d.courses : {},
      statsReady: !!d.statsBackfilledAt, // the admin "Optimize" run has summarised every student's results
      // Site-wide switch set in Admin → Settings (maintenance mode). Rides along in this document: no extra read.
      site: d.site && typeof d.site === "object" ? { maintenance: !!d.site.maintenance, message: String(d.site.message || "").slice(0, 300) } : { maintenance: false, message: "" },
    };
  } catch {
    return null; // rules not published yet / offline → caller falls back
  }
}

async function readExamsCollection() {
  // No orderBy() on purpose — Firestore silently drops a doc missing the
  // sorted field, which would make an exam saved without createdAt vanish.
  const snap = await getDocs(collection(db, "exams"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadExamCatalog() {
  const idx = await readExamIndexDoc();
  if (idx) return { exams: idx.exams.filter((e) => !isDraftExam(e)).sort(byNewest), courses: idx.courses, statsReady: idx.statsReady, site: idx.site, source: "index" };
  return { exams: (await readExamsCollection()).filter((e) => !isDraftExam(e)).sort(byNewest), courses: {}, statsReady: false, site: { maintenance: false, message: "" }, source: "collection" };
}

/** { maintenance, message } — from the cached exam catalog, so asking costs nothing extra. */
export async function getSiteStatus(opts) {
  const catalog = await getExamCatalog(opts);
  return catalog.site || { maintenance: false, message: "" };
}

/** { exams, courses, source } — cached; `{ force: true }` (or a click Event) re-reads. */
export function getExamCatalog(opts) {
  return cache.remember("exams:catalog", TTL.catalog, loadExamCatalog, { force: cache.wantsFresh(opts) });
}

export function invalidateExamCatalog() {
  cache.del("exams:catalog");
}

export async function fetchAllExams(opts) {
  const catalog = await getExamCatalog(opts);
  return catalog.exams.map((e) => ({ ...e }));
}

/** Always a fresh read on purpose: the exam START must see the latest schedule / attempt limit. (1 read) */
export async function fetchExam(examId) {
  const snap = await getDoc(doc(db, "exams", examId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* ---------- Course info + whether THIS exam should even be visible ----------
   Rule (per product decision): if an exam is tied to a course (exam.courseId),
   it only shows up for students enrolled in that course — free or paid makes
   no difference, unenrolled means invisible, not just "locked". Exams with no
   courseId at all are open to every signed-in student. ---------- */
async function getCourseInfo(courseId) {
  const catalog = await getExamCatalog(); // already cached → no read
  const fromIndex = catalog.courses?.[courseId];
  if (fromIndex) return { title: fromIndex.title || "", coverImage: fromIndex.coverImage || "" };
  return cache.remember(`course:${courseId}`, TTL.course, async () => {
    try {
      const courseSnap = await getDoc(doc(db, "courses", courseId));
      return courseSnap.exists()
        ? { title: courseSnap.data().title || "", coverImage: courseSnap.data().coverImage || "" }
        : { title: "", coverImage: "" };
    } catch {
      return { title: "", coverImage: "" };
    }
  });
}

export async function checkExamVisibility(courseId, userProfile) {
  if (!courseId) return { visible: true, title: "", coverImage: "" };
  const info = await getCourseInfo(courseId);
  const enrolled = !!userProfile?.enrolledCourses?.includes(courseId);
  return { visible: enrolled, title: info.title, coverImage: info.coverImage };
}

export async function fetchAllCourses() {
  const snap = await getDocs(collection(db, "courses"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ---------- Index maintenance (admin side) ---------- */
function slimExam(ex) {
  // `instructions` is read from the full exam document when a student starts the exam — keep the shared index small.
  const { questions, questionsBundle, instructions, ...rest } = ex || {};
  return stripUndefined(rest);
}

/** A draft exam (status: "draft", set from the admin panel) is hidden from students everywhere. Missing status = published. */
const isDraftExam = (e) => e?.status === "draft";

function buildCourseMap(exams, coursesList = []) {
  const byId = Object.fromEntries((coursesList || []).map((c) => [c.id, c]));
  const map = {};
  exams.forEach((e) => {
    const c = e.courseId && byId[e.courseId];
    if (c) map[e.courseId] = { title: c.title || "", coverImage: c.coverImage || "" };
  });
  return map;
}

/** Signature of "what students would see" — createdAt excluded (it only orders the list). */
export function examSignature(exams, courseMap = {}) {
  const list = exams
    .map((e) => { const { createdAt, ...rest } = slimExam(e); return stable(rest); })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ list, courses: stable(courseMap) });
}

/**
 * Overwrite examIndex/main from the given exams (1 write). Returns false if it could not be written.
 * `statsBackfilled: true` stamps the doc once the admin "Optimize" run has summarised every student's results.
 */
export async function writeExamIndex(allExams, coursesList = [], { statsBackfilled = false } = {}) {
  const exams = allExams.filter((e) => !isDraftExam(e)); // drafts never reach the students' index
  const courseMap = buildCourseMap(exams, coursesList);
  const entries = exams.slice().sort(byNewest).map(slimExam);
  if (approxBytes({ entries, courseMap }) > INDEX_MAX_BYTES) {
    console.warn("examIndex would exceed the 1 MB document limit — students keep using the slower per-exam path.");
    return false;
  }
  const body = { v: 1, exams: entries, courses: courseMap, count: entries.length, updatedAt: serverTimestamp() };
  if (statsBackfilled) body.statsBackfilledAt = serverTimestamp();
  try {
    // mergeFields REPLACES exactly these fields and leaves the rest (e.g. statsBackfilledAt) alone
    await setDoc(doc(db, ...INDEX_PATH), body, { mergeFields: Object.keys(body) });
  } catch (err) {
    if (isPermissionDenied(err)) { console.warn("examIndex rules are not published yet — see firestore.rules."); return false; }
    throw err;
  }
  invalidateExamCatalog();
  return true;
}

/** Cheap self-heal: rewrites the index only when it differs from the real exams (1 read, 0–1 write). */
export async function syncExamIndex(allExams, coursesList = []) {
  const exams = allExams.filter((e) => !isDraftExam(e));
  const courseMap = buildCourseMap(exams, coursesList);
  const current = await readExamIndexDoc();
  if (current && examSignature(current.exams, current.courses) === examSignature(exams, courseMap)) {
    return { written: false, upToDate: true };
  }
  return { written: await writeExamIndex(allExams, coursesList), upToDate: false };
}

/* ==========================================================================
   2. Questions — one bundle document per exam
   ==========================================================================
   examBundles/{examId} = { questions: [ {id,text,options,correctIndex,explanation,order} … ],
                            chunks, count, part }
   A normal exam is ONE document → loading it is 1 read, saving it is 1 write.
   A very large bank (1000+ questions, could pass Firestore's 1 MB doc limit) is
   split over a few chunk docs (examBundles/{id}__1, __2 …) of ≈600 KB each,
   written atomically in one batch — still ~1 read per 600 KB, not per question.

   Exams created before this change keep working: exams/{id}.qFormat is missing,
   so the old exams/{id}/questions subcollection is read instead (the admin
   "Optimize" button converts them once). */
const BUNDLE_COL = "examBundles";
const CHUNK_BYTES = 600 * 1024;
const MAX_CHUNKS_PER_BATCH = 8; // ≈ 5 MB per commit, safely under Firestore's request-size limit
const bundleDocId = (examId, part = 0) => (part === 0 ? examId : `${examId}__${part}`);

async function readBundle(examId) {
  const first = await getDoc(doc(db, BUNDLE_COL, bundleDocId(examId, 0)));
  if (!first.exists()) return null;
  const head = first.data();
  const questions = Array.isArray(head.questions) ? head.questions.slice() : [];
  const chunks = Math.max(1, Number(head.chunks) || 1);
  if (chunks > 1) {
    const rest = await Promise.all(
      Array.from({ length: chunks - 1 }, (_, i) => getDoc(doc(db, BUNDLE_COL, bundleDocId(examId, i + 1))))
    );
    for (const snap of rest) {
      if (!snap.exists()) return null; // incomplete bundle → treat as missing rather than serve half an exam
      questions.push(...(snap.data().questions || []));
    }
  }
  return questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}` }));
}

async function readLegacyQuestions(examId) {
  const snap = await getDocs(query(collection(db, "exams", examId, "questions"), orderBy("order", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadQuestions(examId, exam) {
  // We only bother with the bundle when the exam says it has one (or we were not told).
  // Trying it for an old exam would waste a read on a document that does not exist.
  const bundleExpected = !exam || Number(exam.qFormat) === QUESTION_FORMAT;
  if (bundleExpected) {
    try {
      const fromBundle = await readBundle(examId);
      if (fromBundle) return fromBundle;
    } catch (err) {
      // Exam says "bundle" but the read failed for a real reason (network…) → surface it,
      // don't quietly serve an empty legacy list. A rules error just means "not published yet".
      if (Number(exam?.qFormat) === QUESTION_FORMAT && !isPermissionDenied(err)) throw err;
    }
  }
  return readLegacyQuestions(examId);
}

const cloneQuestion = (q) => ({ ...q, options: Array.isArray(q.options) ? q.options.slice() : [] });

/** The exam's question bank (cached ~10 min, so a retake in the same visit costs 0 reads). Pass the exam doc if you have it. */
export async function fetchQuestions(examId, exam) {
  const list = await cache.remember(`questions:${examId}`, TTL.questions, () => loadQuestions(examId, exam));
  return list.map(cloneQuestion);
}

/** Admin editor: always straight from the database, never from the cache. */
export async function fetchQuestionsAdmin(examId, exam) {
  const list = await loadQuestions(examId, exam);
  return list.map(cloneQuestion);
}

export function invalidateQuestions(examId) {
  cache.del(`questions:${examId}`);
}

function normalizeForBundle(questions) {
  return questions.map((q, i) => ({
    id: `q${i + 1}`,
    text: q.text,
    options: q.options.slice(),
    correctIndex: q.correctIndex,
    explanation: String(q.explanation || "").trim(),
    order: i,
  }));
}

function chunkQuestions(list) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const q of list) {
    const bytes = approxBytes(q) + 2;
    if (cur.length && size + bytes > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 0; }
    cur.push(q);
    size += bytes;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

/** Old-style write (one doc per question). Only used as a fallback / when KEEP_LEGACY_QUESTION_DOCS is on. */
async function writeLegacyQuestions(examId, list) {
  const col = collection(db, "exams", examId, "questions");
  const old = await getDocs(col);
  const ops = [];
  old.docs.forEach((d) => ops.push({ del: d.ref }));
  list.forEach((q, i) => ops.push({
    ref: doc(col),
    data: { text: q.text, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation || "", order: i },
  }));
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => (o.del ? batch.delete(o.del) : batch.set(o.ref, o.data)));
    await batch.commit();
  }
}

/**
 * ONE atomic commit: the exam doc (create, update, or just the qFormat/qChunks marker when `meta` is null)
 * + every bundle chunk + removal of chunks a shorter bank no longer needs.
 * Resolves { format: 2, chunks } — or { format: 1 } when the examBundles rules are not published yet,
 * in which case NOTHING was written and the caller falls back to the old per-question format.
 */
async function persistBundle(ref, meta, list, { isNew, prevChunks }) {
  const chunks = chunkQuestions(list);
  const chunkWrite = (batch, part, i) => batch.set(doc(db, BUNDLE_COL, bundleDocId(ref.id, i)), {
    examId: ref.id, part: i, chunks: chunks.length, count: list.length, questions: part, updatedAt: serverTimestamp(),
  });
  try {
    const patch = { ...(meta || {}), qFormat: QUESTION_FORMAT, qChunks: chunks.length };
    const stale = [];
    for (let i = chunks.length; i < Math.max(1, Number(prevChunks) || 1); i++) stale.push(i);

    if (chunks.length <= MAX_CHUNKS_PER_BATCH) {
      // The normal case: the exam doc, every chunk and the cleanup of old chunks land together or not at all.
      const batch = writeBatch(db);
      if (isNew) batch.set(ref, { ...patch, createdAt: serverTimestamp() });
      else batch.update(ref, patch);
      chunks.forEach((part, i) => chunkWrite(batch, part, i));
      stale.forEach((i) => batch.delete(doc(db, BUNDLE_COL, bundleDocId(ref.id, i))));
      await batch.commit();
    } else {
      // A truly huge bank (thousands of questions) would exceed Firestore's ~10 MB per-request limit as one batch:
      // write the chunks in groups first and flip the exam doc over LAST, so students never see a half-written exam.
      for (let at = 0; at < chunks.length; at += MAX_CHUNKS_PER_BATCH) {
        const batch = writeBatch(db);
        chunks.slice(at, at + MAX_CHUNKS_PER_BATCH).forEach((part, k) => chunkWrite(batch, part, at + k));
        await batch.commit();
      }
      const last = writeBatch(db);
      if (isNew) last.set(ref, { ...patch, createdAt: serverTimestamp() });
      else last.update(ref, patch);
      stale.forEach((i) => last.delete(doc(db, BUNDLE_COL, bundleDocId(ref.id, i))));
      await last.commit();
    }
    return { format: QUESTION_FORMAT, chunks: chunks.length };
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    return { format: 1, chunks: 0 };
  }
}

/**
 * Create or update an exam TOGETHER with its whole question bank — normally a single atomic write
 * (the old code did ~50 reads + 50 deletes + 50 writes for a 50-question exam).
 *   examId  null → new exam (an id is generated)         data  the exam fields (no id / createdAt / qFormat)
 *   questions [{text, options, correctIndex, explanation}]   prevChunks  exam.qChunks of the version being replaced
 * Resolves { id, format, chunks, count }.
 */
export async function saveExamDoc({ examId = null, data, questions, prevChunks = 1 }) {
  const isNew = !examId;
  const ref = examId ? doc(db, "exams", examId) : doc(collection(db, "exams"));
  const list = normalizeForBundle(questions);
  const meta = stripUndefined(data);

  const saved = await persistBundle(ref, meta, list, { isNew, prevChunks });
  if (saved.format !== QUESTION_FORMAT) {
    // examBundles rules are not published yet → save the old way so the admin's work is never lost.
    if (isNew) await setDoc(ref, { ...meta, createdAt: serverTimestamp() });
    else await updateDoc(ref, { ...meta, qFormat: deleteField(), qChunks: deleteField() });
    await writeLegacyQuestions(ref.id, list);
  } else if (KEEP_LEGACY_QUESTION_DOCS) {
    await writeLegacyQuestions(ref.id, list);
  }
  invalidateQuestions(ref.id);
  return { id: ref.id, format: saved.format, chunks: saved.chunks, count: list.length };
}

/** Delete an exam and its questions. New-format exam = one atomic batch; an old-format exam also clears its per-question docs. */
export async function deleteExamCompletely(examId, exam) {
  const isBundle = Number(exam?.qFormat) === QUESTION_FORMAT;
  let bundleGone = false;
  if (isBundle) {
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "exams", examId));
      const chunks = Math.max(1, Number(exam?.qChunks) || 1);
      for (let i = 0; i < chunks; i++) batch.delete(doc(db, BUNDLE_COL, bundleDocId(examId, i)));
      await batch.commit();
      bundleGone = true;
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
    }
  }
  if (!bundleGone) {
    const batch = writeBatch(db);
    batch.delete(doc(db, "exams", examId));
    await batch.commit();
  }
  if (!isBundle || KEEP_LEGACY_QUESTION_DOCS) {
    // Leftover per-question docs of an old-format exam (best effort — the exam itself is already gone).
    try {
      const snap = await getDocs(collection(db, "exams", examId, "questions"));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    } catch { /* orphan docs are harmless */ }
  }
  invalidateQuestions(examId);
}

/** One-time conversion of an old exam (per-question docs) into a bundle. Costs N reads + 1 atomic write, once; every load afterwards is 1 read. */
export async function migrateExamQuestions(exam) {
  if (Number(exam.qFormat) === QUESTION_FORMAT) return { skipped: true, reason: "already" };
  const legacy = await readLegacyQuestions(exam.id);
  if (!legacy.length) return { skipped: true, reason: "empty" };
  const list = normalizeForBundle(legacy);
  const saved = await persistBundle(doc(db, "exams", exam.id), null, list, { isNew: false, prevChunks: 1 });
  if (saved.format !== QUESTION_FORMAT) return { skipped: true, reason: "rules" };
  invalidateQuestions(exam.id);
  return { migrated: true, count: list.length, chunks: saved.chunks };
}

/* ==========================================================================
   3. Results
   ========================================================================== */

/* ---------- 48-hour lifetime for a saved wrong-answer review ----------
   A submitted attempt's `review` field (see reviewSnapshot in exam.js) only
   ever holds the questions the student got wrong. It's meant to be seen
   right after the exam and revisited for a couple of days at most — not
   kept around forever. isReviewExpired() is the single source of truth for
   "is this attempt's review still within its window", shared by the prune
   pass below and by page-results.js when deciding whether to offer the
   "reopen this attempt's review" button at all. ---------- */
export const REVIEW_TTL_MS = 48 * 60 * 60 * 1000;
export function isReviewExpired(submittedAt) {
  const ms = timestampToMs(submittedAt);
  if (!ms) return false; // unknown timestamp — never force-expire, just leave it be
  return Date.now() - ms > REVIEW_TTL_MS;
}
/** Milliseconds a saved review has left before it expires (null if the attempt time is unknown). */
export function reviewMsLeft(submittedAt) {
  const ms = timestampToMs(submittedAt);
  if (!ms) return null;
  return Math.max(0, REVIEW_TTL_MS - (Date.now() - ms));
}

/** Real number of attempts one results/{uid}_{examId} doc stands for (one doc per student+exam, many attempts). */
export function countAttempts(result) {
  const byNumber = Number(result?.attemptNumber) || 0;
  const byHistory = Array.isArray(result?.attempts) ? result.attempts.length : 0;
  return Math.max(byNumber, byHistory, 1);
}

/* ---------- Every result belonging to the current user (My Results page) ----------
   Query filtered by uid == request.auth.uid, matching the existing Firestore
   rule exactly — a signed-in user can list only their own result documents.

   Cached for 3 minutes (and dropped the moment a new attempt is saved), so
   the profile page, My Activity and the stats builder share ONE fetch
   instead of each re-reading every result document.

   Also does one small piece of self-cleanup on the way out: any attempt
   whose review has passed its 48-hour window gets that review wiped for
   good the next time the student opens this page — no cron job or Cloud
   Function needed. The returned list is already pruned in memory, and the
   actual database clean-up runs in the background (a transaction per
   document, so it can never overwrite an attempt saved a moment earlier),
   so opening "My Activity" never waits on it. ---------- */
function pruneExpiredReviews(attempts) {
  let changed = false;
  const next = attempts.map((a) => {
    if (a && a.review && isReviewExpired(a.submittedAt)) { changed = true; return { ...a, review: null }; }
    return a;
  });
  return { next, changed };
}

async function purgeExpiredReviews(resultId) {
  const ref = doc(db, "results", resultId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const attempts = snap.data().attempts;
    if (!Array.isArray(attempts)) return;
    const { next, changed } = pruneExpiredReviews(attempts);
    if (changed) tx.set(ref, { attempts: next }, { merge: true });
  });
}

async function loadMyResults(uid) {
  const snap = await getDocs(query(collection(db, "results"), where("uid", "==", uid)));
  const results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  for (const r of results) {
    if (!Array.isArray(r.attempts)) continue;
    const { next, changed } = pruneExpiredReviews(r.attempts);
    if (!changed) continue;
    r.attempts = next; // the UI sees the pruned view immediately
    purgeExpiredReviews(r.id).catch(() => { /* best-effort — the UI already hides it */ });
  }

  return results.sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
}

export async function fetchMyResults(uid, opts) {
  const list = await cache.remember(`results:my:${uid}`, TTL.myResults, () => loadMyResults(uid), { force: cache.wantsFresh(opts) });
  return list.slice();
}

/**
 * A new attempt was just saved: put it into the cached "My Activity" list right away instead of
 * throwing the whole list away — otherwise the very next visit to My Activity would re-download
 * every result document just to learn about the one that changed. If nothing is cached yet there is
 * nothing to patch and the first visit simply loads the list as usual.
 */
function patchMyResultsCache(uid, resultId, saved) {
  const key = `results:my:${uid}`;
  const list = cache.get(key);
  if (!list || !saved.data) { cache.del(key); return; } // not cached / a retried duplicate → let the next visit re-read
  const stored = { id: resultId, ...saved.data, submittedAt: Timestamp.now() }; // serverTimestamp() → "now" locally
  cache.set(key, [stored, ...list.filter((r) => r.id !== resultId)], TTL.myResults);
}

/** One results doc, straight from the database (1 read). Missing doc ⇒ null. */
async function fetchResultDoc(uid, examId) {
  try {
    const snap = await getDoc(doc(db, "results", `${uid}_${examId}`));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

/* ==========================================================================
   4. Per-student summary — userStats/{uid}
   ==========================================================================
   { v, uid, examsTaken, exams: { [examId]: { n, s, t, p, at, ty, ti, h? } } }
     n  attempts so far           s/t/p  latest score / total / percent
     at latest submit (ms)        ty     "live" | "practice"      ti  exam title
     h  practice exams only: last ≤30 attempts [{p,s,t}] for the sparkline

   One 1-read document answers "which exams did I take and how did I do?" for the
   exam list and the profile page — instead of one read per exam card / result doc.

   It is a SUMMARY, never the source of truth: the results/{uid}_{examId} doc still
   decides attempt limits (inside saveResult's transaction). It is written AFTER a
   result is saved, best-effort, and never blocks or fails a submission. If it is
   missing (first visit after the upgrade) it is rebuilt once from the student's
   own result docs. */
const STATS_VERSION = 1;
const STATS_HISTORY_CAP = 30;
const statsRef = (uid) => doc(db, "userStats", uid);
let statsWriteBlocked = false; // set when the rules reject a write, so we stop trying this visit
let statsReadBlocked = false;  // set when the rules reject the read (not published yet) — remembered for the whole TTL

const typeOf = (examType) => (examType === "practice" ? "practice" : "live");

function statsEntry({ attemptNumber, score, total, percent, examType, examTitle, submittedMs, attempts }) {
  const entry = {
    n: Math.max(0, Number(attemptNumber) || 0),
    s: Number(score) || 0,
    t: Number(total) || 0,
    p: Math.round(Number(percent) || 0),
    at: Number(submittedMs) || 0,
    ty: typeOf(examType),
    ti: String(examTitle || "").slice(0, 120),
  };
  if (entry.ty === "practice" && Array.isArray(attempts) && attempts.length) {
    entry.h = attempts.slice(-STATS_HISTORY_CAP).map((a) => ({
      p: Math.round(Number(a?.percent) || 0), s: Number(a?.score) || 0, t: Number(a?.total) || 0,
    }));
  }
  return entry;
}

function statsEntryFromResultDoc(r) {
  const attempts = Array.isArray(r.attempts) ? r.attempts : [];
  const last = attempts[attempts.length - 1];
  return statsEntry({
    attemptNumber: r.attemptNumber || attempts.length || 1,
    score: r.score, total: r.total, percent: r.percent,
    examType: r.examType, examTitle: r.examTitle,
    submittedMs: timestampToMs(r.submittedAt) || timestampToMs(last?.submittedAt) || 0,
    attempts,
  });
}

const examIdOfResult = (r, uid) => r.examId || String(r.id || "").slice(String(uid).length + 1);

/** A stats entry shaped like the old results doc, so exam-render.js / exam-guard.js need no changes. */
function entryAsResult(examId, e) {
  return {
    examId,
    examType: e.ty === "practice" ? "practice" : "live",
    examTitle: e.ti || "",
    attemptNumber: e.n,
    score: e.s, total: e.t, percent: e.p,
    submittedAt: e.at ? Timestamp.fromMillis(e.at) : null,
    attempts: Array.isArray(e.h) ? e.h.map((a) => ({ percent: a.p, score: a.s, total: a.t })) : undefined,
    fromStats: true,
  };
}

function persistStats(uid, body, { replace = false } = {}) {
  if (statsWriteBlocked) return Promise.resolve(false);
  return setDoc(statsRef(uid), { v: STATS_VERSION, uid, ...body, updatedAt: serverTimestamp() }, replace ? undefined : { merge: true })
    .then(() => true)
    .catch((err) => { if (isPermissionDenied(err)) statsWriteBlocked = true; return false; });
}

async function loadUserStats(uid) {
  let snap;
  try {
    snap = await getDoc(statsRef(uid));
  } catch (err) {
    if (isPermissionDenied(err)) statsReadBlocked = true;
    return null; // rules not published yet / offline → callers use the old per-doc path
  }
  if (snap.exists()) {
    const d = snap.data();
    if (d && d.v === STATS_VERSION && d.exams && typeof d.exams === "object") return { exams: { ...d.exams } };
  }
  // First visit since the upgrade (or a brand-new student): build it ONCE from their own result docs.
  const results = await fetchMyResults(uid); // shared cache — My Activity reuses this same fetch
  const exams = {};
  results.forEach((r) => { exams[examIdOfResult(r, uid)] = statsEntryFromResultDoc(r); });
  persistStats(uid, { exams, examsTaken: Object.keys(exams).length }, { replace: true }); // best-effort, not awaited
  return { exams };
}

/** { exams } for this student, or null when the summary can't be used (callers then fall back). */
export async function fetchUserStats(uid, opts) {
  try {
    return await cache.remember(
      `stats:${uid}`,
      (v) => (v || statsReadBlocked ? TTL.stats : TTL.retry),
      () => loadUserStats(uid),
      { force: cache.wantsFresh(opts) },
    );
  } catch {
    return null;
  }
}

/** Result of one exam for the exam-list cards: served from the summary (0 extra reads); old per-doc read only as a fallback. */
export async function fetchResult(uid, examId) {
  const stats = await fetchUserStats(uid);
  if (stats) return stats.exams[examId] ? entryAsResult(examId, stats.exams[examId]) : null;
  return fetchResultDoc(uid, examId);
}

/** Numbers for the profile page: exams taken, live count, average and best percent. */
export async function fetchProfileStats(uid) {
  const stats = await fetchUserStats(uid);
  let rows;
  if (stats) {
    rows = Object.values(stats.exams).map((e) => ({ examType: e.ty, percent: e.p }));
  } else {
    rows = (await fetchMyResults(uid)).map((r) => ({ examType: r.examType, percent: r.percent }));
  }
  const total = rows.length;
  const liveCount = rows.filter((r) => r.examType !== "practice").length; // practice attempts have their own place
  if (!total) return { total: 0, liveCount, avg: 0, best: 0 };
  const avg = Math.round(rows.reduce((s, r) => s + (Number(r.percent) || 0), 0) / total);
  const best = Math.max(...rows.map((r) => Number(r.percent) || 0));
  return { total, liveCount, avg, best };
}

/** Keep the summary in step with a just-saved attempt — memory first (instant), database second (best-effort). */
function applySavedAttempt(uid, payload, saved) {
  const entry = statsEntry({
    attemptNumber: saved.attemptNumber,
    score: payload.score, total: payload.total, percent: payload.percent,
    examType: payload.examType, examTitle: payload.examTitle,
    submittedMs: Date.now(), attempts: saved.attempts,
  });
  const inMemory = cache.get(`stats:${uid}`);
  if (inMemory) inMemory.exams[payload.examId] = entry;

  (async () => {
    const stats = await fetchUserStats(uid); // loads or (once) builds the summary if it isn't in memory yet
    if (!stats) return;                      // summary not usable (rules) → nothing to keep in sync
    stats.exams[payload.examId] = entry;
    await persistStats(uid, { exams: { [payload.examId]: entry }, examsTaken: Object.keys(stats.exams).length });
  })().catch(() => { /* best-effort */ });
}

/* ---------- Attempt counter used by the start-of-exam check ---------- */
const attemptsCache = {};
export async function getAttemptsCount(uid, examId) {
  if (attemptsCache[examId] !== undefined) return attemptsCache[examId];
  // Authoritative on purpose (1 read, only for exams that HAVE an attempt limit): a stale summary must never let someone in.
  const result = await fetchResultDoc(uid, examId);
  const count = Number(result?.attemptNumber || 0);
  attemptsCache[examId] = count;
  return count;
}
export function bumpAttemptsCache(examId, attemptNumber) {
  attemptsCache[examId] = attemptNumber;
}

/* ---------- Every exam (live AND practice) keeps a capped history of every
   attempt ---------- Stored as an array field on the same
   results/{uid}_{examId} doc — no new collection and no Firestore rules
   changes needed. Capped at 30 so the document can't grow without bound.
   (Live exams keep this history too, not just practice ones — that is what
   lets "My Results" chart and review a live exam retaken across sittings.) ---------- */
const RESULT_HISTORY_CAP = 30;
// A big exam (hundreds of questions) retaken many times could make full
// question-snapshot detail alone approach Firestore's 1MB document limit
// long before RESULT_HISTORY_CAP is reached. Score/date history is cheap
// and kept for all RESULT_HISTORY_CAP attempts either way, but the heavier
// question-by-question review is only kept for the most recent attempts —
// older ones fall back to the "no detailed review saved" state the UI
// already handles gracefully (see page-results.js).
const REVIEW_DETAIL_CAP = 10;
// Hard safety net on top of the cap above: whatever the exam size, the
// document is kept safely under Firestore's 1MB limit by shedding the
// OLDEST reviews first. A result (score + history) must always be saved —
// the review is the optional part.
const RESULT_DOC_BUDGET_BYTES = 800 * 1024;

function fitAttemptsToBudget(attempts, rest) {
  const out = attempts.slice();
  let size = approxBytes({ ...rest, attempts: out });
  for (let i = 0; i < out.length && size > RESULT_DOC_BUDGET_BYTES; i++) {
    if (out[i].review) {
      out[i] = { ...out[i], review: null };
      size = approxBytes({ ...rest, attempts: out });
    }
  }
  return out;
}

/* ---------- Save one finished attempt ----------
   For a student's 2nd, 3rd … attempt at an exam the append runs as a
   transaction: read the current doc, add the attempt, write — atomically.
   The old read-then-overwrite version could silently wipe a student's whole
   history if that read happened to fail (offline blip, etc.), and two tabs
   finishing at the same moment could overwrite each other.

   Also safe to retry: every attempt carries a client-generated `attemptId`,
   so if a save "fails" after it actually reached the server (lost
   acknowledgement) and the student retries, the retry finds its own attempt
   already stored and returns instead of adding a duplicate.

   `maxAttempts` (0 = unlimited) is re-checked against the stored attempt
   count, which closes the "two tabs, one attempt left" loophole that the
   start-of-exam check alone can't.

   First-ever attempt: the results/{uid}_{examId} doc doesn't exist yet, and
   the Firestore rule for reading it (`resource.data.uid == …`) can't be
   evaluated on a missing doc — so the read is answered with
   "permission-denied", not "not found". That specific answer is therefore
   treated as "no history yet" and the doc is simply created. Any OTHER read
   failure (offline, timeout…) is re-thrown on purpose: mistaking a network
   blip for "no history" is exactly how a student's earlier attempts used to
   get overwritten.

   Read saving: when the student's summary already says they have taken this
   exam, the doc is known to exist, so the existence probe (1 read) is skipped.
   The summary is updated AFTER the save and can never make a save fail. ---------- */
async function resultDocExists(ref) {
  try {
    return (await getDoc(ref)).exists();
  } catch (err) {
    if (isPermissionDenied(err)) return false;
    throw err;
  }
}

export async function saveResult(payload) {
  // reviewSnapshot only belongs inside this one attempt entry — pulling it
  // out of `rest` keeps it from also being duplicated at the top level of
  // the doc (which would double its storage cost for no reason, since the
  // top-level fields only ever need to reflect the LATEST attempt).
  const { reviewSnapshot, attemptId, maxAttempts = 0, ...rest } = payload;
  const ref = doc(db, "results", `${payload.uid}_${payload.examId}`);

  // The new results doc: everything already stored + this attempt, trimmed to fit.
  function compose(prevAttempts, priorCount) {
    const attemptNumber = priorCount + 1;
    let attempts = [...prevAttempts, {
      id: attemptId || null,
      score: payload.score, total: payload.total, percent: payload.percent,
      correctCount: payload.correctCount, wrongCount: payload.wrongCount,
      unansweredCount: payload.unansweredCount, timeTakenSeconds: payload.timeTakenSeconds,
      submittedAt: Timestamp.now(),
      review: reviewSnapshot || null,
    }];
    if (attempts.length > RESULT_HISTORY_CAP) attempts = attempts.slice(attempts.length - RESULT_HISTORY_CAP);
    attempts = attempts.map((a, i) =>
      i < attempts.length - REVIEW_DETAIL_CAP ? { ...a, review: null } : a
    );
    attempts = fitAttemptsToBudget(attempts, rest);
    return { attemptNumber, attempts, data: { ...rest, attemptNumber, attempts, submittedAt: serverTimestamp() } };
  }

  async function createFirst() {
    const { attemptNumber, attempts, data } = compose([], 0);
    await setDoc(ref, data);
    return { attemptNumber, attempts, data, duplicate: false };
  }

  async function appendInTransaction() {
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists() ? snap.data() : null;
      const prevAttempts = Array.isArray(prev?.attempts) ? prev.attempts : [];
      const priorCount = Math.max(Number(prev?.attemptNumber) || 0, prevAttempts.length);

      if (attemptId && prevAttempts.some((a) => a && a.id === attemptId)) {
        return { attemptNumber: priorCount || 1, attempts: prevAttempts, duplicate: true }; // this very attempt is already stored
      }
      if (Number(maxAttempts) > 0 && priorCount >= Number(maxAttempts)) {
        const err = new Error("attempts-exhausted");
        err.code = "attempts-exhausted";
        throw err;
      }
      const { attemptNumber, attempts, data } = compose(prevAttempts, priorCount);
      tx.set(ref, data);
      return { attemptNumber, attempts, data, duplicate: false };
    });
  }

  const summaryKnowsIt = (cache.get(`stats:${payload.uid}`)?.exams?.[payload.examId]?.n || 0) > 0;
  const exists = summaryKnowsIt ? true : await resultDocExists(ref);

  let saved;
  if (!exists) {
    saved = await createFirst();
  } else {
    try {
      saved = await appendInTransaction();
    } catch (err) {
      // The summary said "exists" but the doc is gone (an admin removed it): reading a missing
      // result doc is answered with permission-denied, exactly like the first-attempt case.
      if (summaryKnowsIt && isPermissionDenied(err)) saved = await createFirst();
      else throw err;
    }
  }

  bumpAttemptsCache(payload.examId, saved.attemptNumber);
  patchMyResultsCache(payload.uid, `${payload.uid}_${payload.examId}`, saved);
  applySavedAttempt(payload.uid, payload, saved);
  return saved;
}

/* ==========================================================================
   5. Anonymous percentile stats for the student-facing "my rank" card
   ==========================================================================
   Listing every result document (fetchAllResultsAdmin) is admin-gated by
   Firestore rules on purpose — a live exam's questions/answers are inside
   those docs (see reviewSnapshot above), so letting any signed-in student
   list the whole `results` collection would leak every other student's
   answers and every exam's question bank, not just scores.

   So a student's own rank is built from two pieces instead:
   1) Their OWN average (computed client-side from fetchMyResults — a
      query they're already allowed to run, filtered to their own uid).
   2) An ANONYMOUS array of every student's average percent — just numbers,
      no uid, no name, no exam content — published to this one small
      `leaderboard/publicStats` doc whenever an admin opens the Leaderboard
      tab (see admin/leaderboard.js). Any signed-in student may read that
      doc, but it carries nothing identifying or content-bearing to leak.

   Needs one narrow Firestore rule addition (same pattern as the existing
   counters/students rule documented in README.md):
     match /leaderboard/{docId} {
       allow read: if request.auth != null;
       allow write: if request.auth != null
         && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
     }
---------- */
export async function publishPercentileStats(percents) {
  await setDoc(doc(db, "leaderboard", "publicStats"), {
    percents: percents.map((p) => Math.round(Number(p) || 0)),
    updatedAt: serverTimestamp(),
  });
  cache.del("percentile");
}

export function fetchPercentileStats() {
  return cache.remember("percentile", (v) => (v ? TTL.percentile : TTL.retry), async () => {
    try {
      const snap = await getDoc(doc(db, "leaderboard", "publicStats"));
      return snap.exists() ? snap.data() : null;
    } catch {
      return null;
    }
  });
}

/* ==========================================================================
   6. Admin-only reads — shared, cached, de-duplicated
   ==========================================================================
   The admin panel used to scan the same collections again for every tab
   (users ×4, results ×4, exams ×3 on one page load). Now each collection is
   read at most once per 5 minutes and shared by every tab; the ⟳ Refresh
   buttons pass their click Event, which means "re-read from the server". */
export async function fetchAllResultsAdmin(opts) {
  const list = await cache.remember("admin:results", TTL.admin, async () => {
    const snap = await getDocs(collection(db, "results"));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  }, { force: cache.wantsFresh(opts) });
  return list.slice();
}

export async function fetchAllUsersAdmin(opts) {
  const list = await cache.remember("admin:users", TTL.admin, async () => {
    const snap = await getDocs(collection(db, "users"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, { force: cache.wantsFresh(opts) });
  return list.slice();
}

/** The real exams collection (the source of truth the index is built from) — used only by the admin Exams tab. */
export async function fetchAllExamsAdmin(opts) {
  const list = await cache.remember("admin:exams", TTL.admin, readExamsCollection, { force: cache.wantsFresh(opts) });
  return list.map((e) => ({ ...e })).sort(byNewest);
}

/** After the admin edits exams locally, keep the shared copy in step (no re-read needed). */
export function primeAdminExams(list) {
  cache.set("admin:exams", list.map((e) => ({ ...e })), TTL.admin);
}

/** True when the exams collection is already in memory — i.e. the next fetchAllExamsAdmin() costs nothing. */
export function isAdminExamsCached() {
  return cache.get("admin:exams") !== undefined;
}

export function invalidateAdminCaches() {
  cache.del("admin:results");
  cache.del("admin:users");
  cache.del("admin:exams");
}

/**
 * Overview numbers WITHOUT downloading a single result / user document.
 * Firestore aggregation queries (count / sum / average) are billed at
 * 1 read per 1,000 matching index entries — so the whole overview costs a
 * handful of reads instead of "every user + every result + every exam".
 * Throws if aggregation isn't available (the dashboard then shows what it can without the totals).
 */
export async function fetchOverviewStats(opts) {
  if (!getAggregateFromServer || !count || !sum || !average) throw new Error("aggregate-unsupported");
  const [catalog, users, results, takers] = await Promise.all([
    getExamCatalog(opts),
    getAggregateFromServer(collection(db, "users"), { n: count() }),
    getAggregateFromServer(collection(db, "results"), { docs: count(), attempts: sum("attemptNumber"), avg: average("percent") }),
    // Students who have taken at least one exam. Exact once the admin "Optimize" run has created
    // every student's summary (catalog.statsReady); until then the overview shows "—" instead of a wrong number.
    getAggregateFromServer(query(collection(db, "userStats"), where("examsTaken", ">", 0)), { n: count() }).catch(() => null),
  ]);
  const r = results.data();
  return {
    exams: catalog.exams.length,
    students: users.data().n,
    attempts: Math.max(Number(r.attempts) || 0, Number(r.docs) || 0), // every result doc stands for at least one attempt
    avgPercent: Math.round(Number(r.avg) || 0),
    studentsWhoAttempted: takers && catalog.statsReady ? takers.data().n : null,
  };
}

/**
 * Admin "Optimize": write a userStats doc for every student from the results the admin already
 * downloaded (so nobody has to rebuild theirs on first visit, and the overview count is exact).
 * ≈ 1 write per student who has results. Safe to run again.
 */
export async function backfillUserStats(results, onProgress) {
  const byUid = new Map();
  results.forEach((r) => {
    if (!r.uid) return;
    if (!byUid.has(r.uid)) byUid.set(r.uid, {});
    byUid.get(r.uid)[examIdOfResult(r, r.uid)] = statsEntryFromResultDoc(r);
  });
  const entries = Array.from(byUid.entries());
  let done = 0;
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    entries.slice(i, i + 400).forEach(([uid, exams]) => {
      batch.set(statsRef(uid), { v: STATS_VERSION, uid, exams, examsTaken: Object.keys(exams).length, updatedAt: serverTimestamp() });
    });
    await batch.commit();
    done += Math.min(400, entries.length - i);
    onProgress?.(done, entries.length);
  }
  return entries.length;
}
