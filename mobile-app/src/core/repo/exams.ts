// Exams, the student catalog and the question bundles — ported from js/exam-data.js. Same collections, same field names,
// same document formats, so an exam created here appears on the website and the other way round.
import { collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, deleteField, writeBatch, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import * as cache from "../cache";
import { Academic, isDraftExam } from "../shared";
import { approxBytes } from "../result-rules";
import type { Catalog, Exam, Question } from "../types";

const MIN = 60_000;
const TTL = { catalog: 5 * MIN, questions: 10 * MIN, admin: 5 * MIN };
const INDEX_PATH = ["examIndex", "main"] as const;
const INDEX_MAX_BYTES = 880 * 1024; // stay clear of the 1 MB document limit
export const QUESTION_FORMAT = 2;    // exams/{id}.qFormat === 2 → questions live in examBundles/{id}
const BUNDLE_COL = "examBundles";
const CHUNK_BYTES = 600 * 1024;
const MAX_CHUNKS_PER_BATCH = 8;
const bundleDocId = (examId: string, part = 0) => (part === 0 ? examId : `${examId}__${part}`);
const isDenied = (e: any) => e?.code === "permission-denied";
const byNewest = (a: Exam, b: Exam) => ((b.createdAt as any)?.seconds || 0) - ((a.createdAt as any)?.seconds || 0);
const stripUndefined = <T extends Record<string, unknown>>(o: T): T => { const out: any = {}; for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v; return out; };

// ---------------------------------------------------------------- student catalog
async function readExamIndexDoc() {
  try {
    const snap = await getDoc(doc(db, ...INDEX_PATH));
    if (!snap.exists()) return null;
    const d: any = snap.data();
    if (!Array.isArray(d.exams)) return null;
    return {
      exams: d.exams.filter((e: any) => e && e.id) as Exam[],
      courses: (d.courses && typeof d.courses === "object" ? d.courses : {}) as Catalog["courses"],
      statsReady: !!d.statsBackfilledAt,
      academicHidden: Array.isArray(d.academicHidden) ? (d.academicHidden as unknown[]).filter((x) => typeof x === "string").slice(0, 5000) as string[] : [],
      site: d.site && typeof d.site === "object" ? { maintenance: !!d.site.maintenance, message: String(d.site.message || "").slice(0, 300) } : { maintenance: false, message: "" },
    };
  } catch { return null; }
}

async function loadCatalog(): Promise<Catalog> {
  const idx = await readExamIndexDoc();
  if (idx) {
    const hidden = new Set(idx.academicHidden);
    return { exams: idx.exams.filter((e) => !isDraftExam(e) && !Academic.isAcademicHidden(e, hidden)).sort(byNewest), courses: idx.courses, statsReady: idx.statsReady, site: idx.site, source: "index" };
  }
  const snap = await getDocs(collection(db, "exams"));
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Exam);
  return { exams: all.filter((e) => !isDraftExam(e)).sort(byNewest), courses: {}, statsReady: false, site: { maintenance: false, message: "" }, source: "collection" };
}

export const getExamCatalog = (opts: { force?: boolean } = {}) => cache.remember("exams:catalog", TTL.catalog, loadCatalog, opts);
export const invalidateExamCatalog = () => cache.del("exams:catalog");

/** Always a fresh read on purpose: the exam START must see the latest schedule / attempt limit. */
export async function fetchExam(examId: string): Promise<Exam | null> {
  const snap = await getDoc(doc(db, "exams", examId));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Exam) : null;
}

// ---------------------------------------------------------------- questions
async function readBundle(examId: string): Promise<Question[] | null> {
  const first = await getDoc(doc(db, BUNDLE_COL, bundleDocId(examId, 0)));
  if (!first.exists()) return null;
  const head: any = first.data();
  const questions: Question[] = Array.isArray(head.questions) ? head.questions.slice() : [];
  const chunks = Math.max(1, Number(head.chunks) || 1);
  if (chunks > 1) {
    const rest = await Promise.all(Array.from({ length: chunks - 1 }, (_, i) => getDoc(doc(db, BUNDLE_COL, bundleDocId(examId, i + 1)))));
    for (const snap of rest) {
      if (!snap.exists()) return null; // incomplete bundle → treat as missing rather than serve half an exam
      questions.push(...((snap.data() as any).questions || []));
    }
  }
  return questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}` }));
}

async function readLegacyQuestions(examId: string): Promise<Question[]> {
  const snap = await getDocs(query(collection(db, "exams", examId, "questions"), orderBy("order", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Question);
}

async function loadQuestions(examId: string, exam?: Exam | null): Promise<Question[]> {
  const bundleExpected = !exam || Number(exam.qFormat) === QUESTION_FORMAT;
  if (bundleExpected) {
    try {
      const fromBundle = await readBundle(examId);
      if (fromBundle) return fromBundle;
    } catch (err) {
      if (Number(exam?.qFormat) === QUESTION_FORMAT && !isDenied(err)) throw err;
    }
  }
  return readLegacyQuestions(examId);
}

const cloneQuestion = (q: Question): Question => ({ ...q, options: Array.isArray(q.options) ? q.options.slice() : [] });
/** The exam's question bank (cached ~10 min). Pass the exam doc if you have it. */
export async function fetchQuestions(examId: string, exam?: Exam | null): Promise<Question[]> {
  const list = await cache.remember(`questions:${examId}`, TTL.questions, () => loadQuestions(examId, exam));
  return list.map(cloneQuestion);
}
export async function fetchQuestionsAdmin(examId: string, exam?: Exam | null): Promise<Question[]> { return (await loadQuestions(examId, exam)).map(cloneQuestion); }
export const invalidateQuestions = (examId: string) => cache.del(`questions:${examId}`);

// ---------------------------------------------------------------- admin: write exams + keep examIndex in sync
function normalizeForBundle(questions: Pick<Question, "text" | "options" | "correctIndex" | "explanation">[]) {
  return questions.map((q, i) => ({ id: `q${i + 1}`, text: q.text, options: q.options.slice(), correctIndex: q.correctIndex, explanation: String(q.explanation || "").trim(), order: i }));
}
function chunkQuestions<T>(list: T[]): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
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

async function persistBundle(ref: any, meta: Record<string, unknown> | null, list: any[], { isNew, prevChunks }: { isNew: boolean; prevChunks: number }) {
  const chunks = chunkQuestions(list);
  const chunkWrite = (batch: any, part: any[], i: number) => batch.set(doc(db, BUNDLE_COL, bundleDocId(ref.id, i)), { examId: ref.id, part: i, chunks: chunks.length, count: list.length, questions: part, updatedAt: serverTimestamp() });
  try {
    const patch = { ...(meta || {}), qFormat: QUESTION_FORMAT, qChunks: chunks.length };
    const stale: number[] = [];
    for (let i = chunks.length; i < Math.max(1, Number(prevChunks) || 1); i++) stale.push(i);
    if (chunks.length <= MAX_CHUNKS_PER_BATCH) {
      const batch = writeBatch(db);
      if (isNew) batch.set(ref, { ...patch, createdAt: serverTimestamp() }); else batch.update(ref, patch);
      chunks.forEach((part, i) => chunkWrite(batch, part, i));
      stale.forEach((i) => batch.delete(doc(db, BUNDLE_COL, bundleDocId(ref.id, i))));
      await batch.commit();
    } else {
      for (let at = 0; at < chunks.length; at += MAX_CHUNKS_PER_BATCH) {
        const batch = writeBatch(db);
        chunks.slice(at, at + MAX_CHUNKS_PER_BATCH).forEach((part, k) => chunkWrite(batch, part, at + k));
        await batch.commit();
      }
      const last = writeBatch(db);
      if (isNew) last.set(ref, { ...patch, createdAt: serverTimestamp() }); else last.update(ref, patch);
      stale.forEach((i) => last.delete(doc(db, BUNDLE_COL, bundleDocId(ref.id, i))));
      await last.commit();
    }
    return { format: QUESTION_FORMAT, chunks: chunks.length };
  } catch (err) {
    if (!isDenied(err)) throw err;
    return { format: 1, chunks: 0 };
  }
}

async function writeLegacyQuestions(examId: string, list: any[]) {
  const col = collection(db, "exams", examId, "questions");
  const old = await getDocs(col);
  const ops: any[] = [];
  old.docs.forEach((d) => ops.push({ del: d.ref }));
  list.forEach((q, i) => ops.push({ ref: doc(col), data: { text: q.text, options: q.options, correctIndex: q.correctIndex, explanation: q.explanation || "", order: i } }));
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => (o.del ? batch.delete(o.del) : batch.set(o.ref, o.data)));
    await batch.commit();
  }
}

/** Create or update an exam TOGETHER with its whole question bank — one atomic write (same as saveExamDoc on the website). */
export async function saveExamDoc({ examId = null, data, questions, prevChunks = 1 }: { examId?: string | null; data: Record<string, unknown>; questions: Pick<Question, "text" | "options" | "correctIndex" | "explanation">[]; prevChunks?: number }) {
  const isNew = !examId;
  const ref = examId ? doc(db, "exams", examId) : doc(collection(db, "exams"));
  const list = normalizeForBundle(questions);
  const meta = stripUndefined(data);
  const saved = await persistBundle(ref, meta, list, { isNew, prevChunks });
  if (saved.format !== QUESTION_FORMAT) {
    if (isNew) await setDoc(ref, { ...meta, createdAt: serverTimestamp() });
    else await updateDoc(ref, { ...meta, qFormat: deleteField(), qChunks: deleteField() });
    await writeLegacyQuestions(ref.id, list);
  }
  invalidateQuestions(ref.id);
  return { id: ref.id, format: saved.format, chunks: saved.chunks, count: list.length };
}

/** Delete an exam and its questions (new format = one atomic batch). */
export async function deleteExamCompletely(examId: string, exam: Exam) {
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
    } catch (err) { if (!isDenied(err)) throw err; }
  }
  if (!bundleGone) { const batch = writeBatch(db); batch.delete(doc(db, "exams", examId)); await batch.commit(); }
  if (!isBundle) {
    try {
      const snap = await getDocs(collection(db, "exams", examId, "questions"));
      for (let i = 0; i < snap.docs.length; i += 400) { const batch = writeBatch(db); snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref)); await batch.commit(); }
    } catch { /* orphan docs are harmless */ }
  }
  invalidateQuestions(examId);
}

const slimExam = (ex: Exam) => { const { questions, questionsBundle, instructions, ...rest } = ex as any; return stripUndefined(rest) as Exam; };
function buildCourseMap(exams: Exam[], courses: { id: string; title?: string; coverImage?: string }[] = []) {
  const byId = Object.fromEntries(courses.map((c) => [c.id, c]));
  const map: Record<string, { title: string; coverImage: string }> = {};
  exams.forEach((e) => { const c = e.courseId && byId[e.courseId]; if (c) map[e.courseId as string] = { title: c.title || "", coverImage: c.coverImage || "" }; });
  return map;
}

/** Overwrite examIndex/main from the given exams (1 write) — drafts never reach the students' index. Returns false if it could not be written. */
export async function writeExamIndex(allExams: Exam[], courses: { id: string; title?: string; coverImage?: string }[] = []): Promise<boolean> {
  const exams = allExams.filter((e) => !isDraftExam(e));
  const courseMap = buildCourseMap(exams, courses);
  const entries = exams.slice().sort(byNewest).map(slimExam);
  if (approxBytes({ entries, courseMap }) > INDEX_MAX_BYTES) return false;
  const body = { v: 1, exams: entries, courses: courseMap, count: entries.length, updatedAt: serverTimestamp() };
  try { await setDoc(doc(db, ...INDEX_PATH), body, { mergeFields: Object.keys(body) }); } catch (err) { if (isDenied(err)) return false; throw err; }
  invalidateExamCatalog();
  return true;
}

export async function fetchAllExamsAdmin(opts: { force?: boolean } = {}): Promise<Exam[]> {
  return cache.remember("admin:exams", TTL.admin, async () => (await getDocs(collection(db, "exams"))).docs.map((d) => ({ id: d.id, ...d.data() }) as Exam), opts);
}
export async function fetchAllCourses(): Promise<{ id: string; title: string; coverImage?: string }[]> {
  return cache.remember("admin:courses", TTL.admin, async () => (await getDocs(collection(db, "courses"))).docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
}
export const setAdminExamsCache = (list: Exam[]) => cache.set("admin:exams", list, TTL.admin);

/** After any admin change to an exam: refresh the cached list and rewrite the students' index. */
export async function afterExamsChanged(list: Exam[]) {
  setAdminExamsCache(list);
  let courses: { id: string; title: string; coverImage?: string }[] = [];
  try { courses = await fetchAllCourses(); } catch { /* course names are optional */ }
  return writeExamIndex(list, courses);
}
