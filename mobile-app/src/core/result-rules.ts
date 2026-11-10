// Pure rules for results/{uid}_{examId} and userStats/{uid} — ported from js/exam-data.js so they can be tested without Firebase.
import type { AttemptRecord, ResultDoc, ReviewItem, StatsEntry, Ts } from "./types";

export const REVIEW_TTL_MS = 48 * 60 * 60 * 1000;
export const RESULT_HISTORY_CAP = 30;
export const REVIEW_DETAIL_CAP = 10;
export const RESULT_DOC_BUDGET_BYTES = 800 * 1024;
export const STATS_VERSION = 1;
export const STATS_HISTORY_CAP = 30;

export function tsToMs(ts: Ts): number | null {
  const t = ts as any;
  if (t?.toMillis) return t.toMillis();
  if (t?.seconds) return t.seconds * 1000;
  if (typeof ts === "number") return ts;
  return null;
}

export function isReviewExpired(submittedAt: Ts, now = Date.now()): boolean {
  const ms = tsToMs(submittedAt);
  if (!ms) return false; // unknown timestamp — never force-expire
  return now - ms > REVIEW_TTL_MS;
}
export function reviewMsLeft(submittedAt: Ts, now = Date.now()): number | null {
  const ms = tsToMs(submittedAt);
  if (!ms) return null;
  return Math.max(0, REVIEW_TTL_MS - (now - ms));
}

/** Real number of attempts one results doc stands for (one doc per student+exam, many attempts). */
export function countAttempts(result: Partial<ResultDoc> | null | undefined): number {
  const byNumber = Number(result?.attemptNumber) || 0;
  const byHistory = Array.isArray(result?.attempts) ? result!.attempts!.length : 0;
  return Math.max(byNumber, byHistory, 1);
}

export const approxBytes = (v: unknown) => { try { return new Blob([JSON.stringify(v)]).size; } catch { return JSON.stringify(v ?? "").length; } };

export function fitAttemptsToBudget(attempts: AttemptRecord[], rest: Record<string, unknown>): AttemptRecord[] {
  const out = attempts.slice();
  let size = approxBytes({ ...rest, attempts: out });
  for (let i = 0; i < out.length && size > RESULT_DOC_BUDGET_BYTES; i++) {
    if (out[i].review) { out[i] = { ...out[i], review: null }; size = approxBytes({ ...rest, attempts: out }); }
  }
  return out;
}

/** The attempt list after adding one new attempt: capped history, review detail only for the latest few, size-budgeted. */
export function composeAttempts(prevAttempts: AttemptRecord[], newAttempt: AttemptRecord, rest: Record<string, unknown>): AttemptRecord[] {
  let attempts = [...prevAttempts, newAttempt];
  if (attempts.length > RESULT_HISTORY_CAP) attempts = attempts.slice(attempts.length - RESULT_HISTORY_CAP);
  attempts = attempts.map((a, i) => (i < attempts.length - REVIEW_DETAIL_CAP ? { ...a, review: null } : a));
  return fitAttemptsToBudget(attempts, rest);
}

export function pruneExpiredReviews(attempts: AttemptRecord[], now = Date.now()) {
  let changed = false;
  const next = attempts.map((a) => {
    if (a && a.review && isReviewExpired(a.submittedAt, now)) { changed = true; return { ...a, review: null }; }
    return a;
  });
  return { next, changed };
}

const typeOf = (t: unknown): "live" | "practice" => (t === "practice" ? "practice" : "live");

export function statsEntry(i: {
  attemptNumber: number; score: number; total: number; percent: number; examType?: string; examTitle?: string; submittedMs: number;
  attempts?: { percent?: number; score?: number; total?: number }[]; correct?: number; wrong?: number; unanswered?: number; seconds?: number;
}): StatsEntry {
  const entry: StatsEntry = {
    n: Math.max(0, Number(i.attemptNumber) || 0), s: Number(i.score) || 0, t: Number(i.total) || 0, p: Math.round(Number(i.percent) || 0),
    at: Number(i.submittedMs) || 0, ty: typeOf(i.examType), ti: String(i.examTitle || "").slice(0, 120),
  };
  ([["c", i.correct], ["w", i.wrong], ["u", i.unanswered], ["tt", i.seconds]] as const).forEach(([key, value]) => {
    if (value !== undefined && value !== null && (value as unknown) !== "" && Number.isFinite(Number(value))) entry[key] = Math.max(0, Math.round(Number(value)));
  });
  if (Array.isArray(i.attempts) && i.attempts.length) {
    const best = Math.max(...i.attempts.map((a) => Math.round(Number(a?.percent) || 0)), entry.p);
    if (Number.isFinite(best)) entry.b = best;
  }
  if (entry.ty === "practice" && Array.isArray(i.attempts) && i.attempts.length) {
    entry.h = i.attempts.slice(-STATS_HISTORY_CAP).map((a) => ({ p: Math.round(Number(a?.percent) || 0), s: Number(a?.score) || 0, t: Number(a?.total) || 0 }));
  }
  return entry;
}

export function statsEntryFromResultDoc(r: Partial<ResultDoc>): StatsEntry {
  const attempts = Array.isArray(r.attempts) ? r.attempts : [];
  const last = attempts[attempts.length - 1];
  return statsEntry({
    attemptNumber: r.attemptNumber || attempts.length || 1, score: r.score as number, total: r.total as number, percent: r.percent as number,
    examType: r.examType, examTitle: r.examTitle as string,
    submittedMs: tsToMs(r.submittedAt) || tsToMs(last?.submittedAt) || 0, attempts,
    correct: last?.correctCount, wrong: last?.wrongCount, unanswered: last?.unansweredCount, seconds: last?.timeTakenSeconds,
  });
}

export const examIdOfResult = (r: { examId?: string; id?: string }, uid: string) => r.examId || String(r.id || "").slice(String(uid).length + 1);

export type { ReviewItem };
