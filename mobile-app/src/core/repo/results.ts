// A student's results and per-student summary — ported from js/exam-data.js (saveResult, userStats, examSessions).
import { collection, doc, getDoc, getDocs, query, where, runTransaction, setDoc, increment, serverTimestamp, Timestamp } from "firebase/firestore";
import { db } from "../firebase";
import * as cache from "../cache";
import { composeAttempts, countAttempts, examIdOfResult, pruneExpiredReviews, statsEntry, statsEntryFromResultDoc, STATS_VERSION } from "../result-rules";
import type { AttemptRecord, ResultDoc, UserStats } from "../types";

const MIN = 60_000;
const TTL = { stats: 10 * MIN, myResults: 3 * MIN, retry: 30_000 };
const isDenied = (e: any) => e?.code === "permission-denied";
let statsWriteBlocked = false;
let statsReadBlocked = false;
let sessionsWriteBlocked = false;

// ---------------------------------------------------------------- my results
async function purgeExpiredReviews(resultId: string) {
  const ref = doc(db, "results", resultId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const attempts = (snap.data() as any).attempts;
    if (!Array.isArray(attempts)) return;
    const { next, changed } = pruneExpiredReviews(attempts);
    if (changed) tx.set(ref, { attempts: next }, { merge: true });
  });
}

async function loadMyResults(uid: string): Promise<ResultDoc[]> {
  const snap = await getDocs(query(collection(db, "results"), where("uid", "==", uid)));
  const results = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ResultDoc);
  for (const r of results) {
    if (!Array.isArray(r.attempts)) continue;
    const { next, changed } = pruneExpiredReviews(r.attempts);
    if (!changed) continue;
    r.attempts = next;
    purgeExpiredReviews(r.id).catch(() => { /* best-effort — the UI already hides it */ });
  }
  return results.sort((a, b) => ((b.submittedAt as any)?.seconds || 0) - ((a.submittedAt as any)?.seconds || 0));
}
export const fetchMyResults = (uid: string, opts: { force?: boolean } = {}) => cache.remember(`results:my:${uid}`, TTL.myResults, () => loadMyResults(uid), opts).then((l) => l.slice());

async function fetchResultDoc(uid: string, examId: string): Promise<ResultDoc | null> {
  try { const snap = await getDoc(doc(db, "results", `${uid}_${examId}`)); return snap.exists() ? ({ id: snap.id, ...snap.data() } as ResultDoc) : null; } catch { return null; }
}

// ---------------------------------------------------------------- userStats/{uid}
const statsRef = (uid: string) => doc(db, "userStats", uid);
function persistStats(uid: string, body: Record<string, unknown>, { replace = false } = {}) {
  if (statsWriteBlocked) return Promise.resolve(false);
  return setDoc(statsRef(uid), { v: STATS_VERSION, uid, ...body, updatedAt: serverTimestamp() }, replace ? undefined as any : { merge: true })
    .then(() => true).catch((err) => { if (isDenied(err)) statsWriteBlocked = true; return false; });
}

async function loadUserStats(uid: string): Promise<UserStats | null> {
  let snap;
  try { snap = await getDoc(statsRef(uid)); } catch (err) { if (isDenied(err)) statsReadBlocked = true; return null; }
  if (snap.exists()) {
    const d: any = snap.data();
    if (d && d.v === STATS_VERSION && d.exams && typeof d.exams === "object") return { exams: { ...d.exams } };
  }
  const results = await fetchMyResults(uid);
  const exams: UserStats["exams"] = {};
  results.forEach((r) => { exams[examIdOfResult(r, uid)] = statsEntryFromResultDoc(r); });
  void persistStats(uid, { exams, examsTaken: Object.keys(exams).length }, { replace: true });
  return { exams };
}

/** { exams } for this student, or null when the summary can't be used. */
export async function fetchUserStats(uid: string, opts: { force?: boolean } = {}): Promise<UserStats | null> {
  try { return await cache.remember(`stats:${uid}`, (v) => (v || statsReadBlocked ? TTL.stats : TTL.retry), () => loadUserStats(uid), opts); } catch { return null; }
}

// ---------------------------------------------------------------- exam-start counter
/** examSessions/{uid}_{examId}: written ONCE per exam start, fire-and-forget (a failed write never delays an exam). */
export function recordExamStart(uid: string, examId: string) {
  if (sessionsWriteBlocked || !uid || !examId) return;
  setDoc(doc(db, "examSessions", `${uid}_${examId}`), { uid, examId, starts: increment(1), lastStartAt: serverTimestamp() }, { merge: true })
    .catch((err) => { if (isDenied(err)) sessionsWriteBlocked = true; });
}

/** Attempts already used for this exam — read fresh from the result doc (the start check must not trust a stale summary). */
export async function getAttemptsCount(uid: string, examId: string): Promise<number> {
  const r = await fetchResultDoc(uid, examId);
  return Number(r?.attemptNumber || 0);
}

// ---------------------------------------------------------------- save one finished attempt
export interface SavePayload {
  uid: string; examId: string; examTitle: string; examType: "live" | "practice";
  score: number; total: number; percent: number; correctCount: number; wrongCount: number; unansweredCount: number;
  negativeMarking: number; timeTakenSeconds: number; answers: Record<string, number>;
  attemptId?: string; maxAttempts?: number; reviewSnapshot?: AttemptRecord["review"];
}
export interface SavedResult { attemptNumber: number; attempts: AttemptRecord[]; data?: Record<string, unknown>; duplicate: boolean }

async function resultDocExists(ref: any) {
  try { return (await getDoc(ref)).exists(); } catch (err) { if (isDenied(err)) return false; throw err; }
}

export async function saveResult(payload: SavePayload): Promise<SavedResult> {
  const { reviewSnapshot, attemptId, maxAttempts = 0, ...rest } = payload;
  const ref = doc(db, "results", `${payload.uid}_${payload.examId}`);
  function compose(prevAttempts: AttemptRecord[], priorCount: number) {
    const attemptNumber = priorCount + 1;
    const attempts = composeAttempts(prevAttempts, {
      id: attemptId || null, score: payload.score, total: payload.total, percent: payload.percent,
      correctCount: payload.correctCount, wrongCount: payload.wrongCount, unansweredCount: payload.unansweredCount,
      timeTakenSeconds: payload.timeTakenSeconds, submittedAt: Timestamp.now() as any, review: reviewSnapshot || null,
    }, rest as Record<string, unknown>);
    return { attemptNumber, attempts, data: { ...rest, attemptNumber, attempts, submittedAt: serverTimestamp() } };
  }
  async function createFirst(): Promise<SavedResult> {
    const { attemptNumber, attempts, data } = compose([], 0);
    await setDoc(ref, data);
    return { attemptNumber, attempts, data, duplicate: false };
  }
  async function appendInTransaction(): Promise<SavedResult> {
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const prev: any = snap.exists() ? snap.data() : null;
      const prevAttempts: AttemptRecord[] = Array.isArray(prev?.attempts) ? prev.attempts : [];
      const priorCount = Math.max(Number(prev?.attemptNumber) || 0, prevAttempts.length);
      if (attemptId && prevAttempts.some((a) => a && a.id === attemptId)) return { attemptNumber: priorCount || 1, attempts: prevAttempts, duplicate: true };
      if (Number(maxAttempts) > 0 && priorCount >= Number(maxAttempts)) { const err: any = new Error("attempts-exhausted"); err.code = "attempts-exhausted"; throw err; }
      const { attemptNumber, attempts, data } = compose(prevAttempts, priorCount);
      tx.set(ref, data);
      return { attemptNumber, attempts, data, duplicate: false };
    });
  }
  const known = cache.get<UserStats | null>(`stats:${payload.uid}`);
  const summaryKnowsIt = (known?.exams?.[payload.examId]?.n || 0) > 0;
  const exists = summaryKnowsIt ? true : await resultDocExists(ref);
  let saved: SavedResult;
  if (!exists) saved = await createFirst();
  else {
    try { saved = await appendInTransaction(); }
    catch (err) { if (summaryKnowsIt && isDenied(err)) saved = await createFirst(); else throw err; }
  }
  patchMyResultsCache(payload.uid, `${payload.uid}_${payload.examId}`, saved);
  applySavedAttempt(payload, saved);
  return saved;
}

function patchMyResultsCache(uid: string, resultId: string, saved: SavedResult) {
  const key = `results:my:${uid}`;
  const list = cache.get<ResultDoc[]>(key);
  if (!list || !saved.data) { cache.del(key); return; }
  const stored = { id: resultId, ...saved.data, submittedAt: Timestamp.now() } as unknown as ResultDoc;
  cache.set(key, [stored, ...list.filter((r) => r.id !== resultId)], TTL.myResults);
}

function applySavedAttempt(payload: SavePayload, saved: SavedResult) {
  const uid = payload.uid;
  const entry = statsEntry({
    attemptNumber: saved.attemptNumber, score: payload.score, total: payload.total, percent: payload.percent,
    examType: payload.examType, examTitle: payload.examTitle, submittedMs: Date.now(), attempts: saved.attempts,
    correct: payload.correctCount, wrong: payload.wrongCount, unanswered: payload.unansweredCount, seconds: payload.timeTakenSeconds,
  });
  const inMemory = cache.get<UserStats | null>(`stats:${uid}`);
  if (inMemory) inMemory.exams[payload.examId] = entry;
  (async () => {
    const stats = await fetchUserStats(uid);
    if (!stats) return;
    stats.exams[payload.examId] = entry;
    await persistStats(uid, { exams: { [payload.examId]: entry }, examsTaken: Object.keys(stats.exams).length });
  })().catch(() => { /* best-effort */ });
}

export { countAttempts };
