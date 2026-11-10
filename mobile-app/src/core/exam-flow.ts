// Starting, finishing and saving an exam — the same checks and the same order as the website
// (js/exam-guard.js runVerification, js/exam.js submit/save). UI-free so the rules can be unit-tested.
import { computeStatus, passPercentFor, Session } from "./shared";
import { buildAttemptSnapshot, makeAttemptId, saveResultPayload, scoreExam, type AttemptSnapshot } from "./engine";
import { formatDateTime } from "./format";
import { serverNow } from "./clock";
import type { Exam, Profile } from "./types";

export interface Block { title: string; message: string }

/** Is this exam closed to the student right now? (judged against the SERVER clock; admins may still test cancelled / closed-registration exams) */
export function windowBlock(exam: Exam, isAdmin: boolean, now: number): Block | null {
  const st = computeStatus(exam, now);
  if (st.reason === "upcoming") return { title: "The exam hasn't started yet.", message: `This exam starts on ${formatDateTime(st.startsAt)}.` };
  if (st.reason === "window-closed") return { title: "Exam time is over.", message: `This exam closed on ${formatDateTime(st.endsAt)}.` };
  if (!isAdmin && st.reason === "cancelled") return { title: "Exam not available.", message: "এই পরীক্ষার সময়সূচি বাতিল করা হয়েছে।" };
  if (!isAdmin && st.reason === "registration-closed") return { title: "Registration closed.", message: "এই পরীক্ষায় নতুন করে অংশগ্রহণের সুযোগ বন্ধ করা হয়েছে।" };
  return null;
}

/** An exam tied to a course is only visible to students enrolled in it (exams with no course are open to everyone). */
export const isVisibleToStudent = (exam: Exam, profile: Profile | null | undefined) => !exam.courseId || (Array.isArray(profile?.enrolledCourses) && profile!.enrolledCourses!.includes(exam.courseId));

export type StartCheck = { ok: true; exam: Exam; attemptsSoFar: number; maxAttempts: number } | ({ ok: false } & Block);

export interface StartDeps {
  fetchExam(id: string): Promise<Exam | null>;
  getSite(): Promise<{ maintenance: boolean; message: string }>;
  academicGate(exam: Exam): Promise<{ allowed: boolean; reason: string }>;
  attemptsUsed(uid: string, examId: string): Promise<number>;
  now(): number;
}

export async function verifyStart(examId: string, who: { uid: string; profile: Profile | null; isAdmin: boolean }, deps: StartDeps): Promise<StartCheck> {
  const { profile, isAdmin } = who;
  const gone = { ok: false as const, title: "Exam not found", message: "This exam has been removed, or the link is incorrect." };
  if (profile?.disabled && !isAdmin) return { ok: false, title: "Account deactivated", message: "আপনার অ্যাকাউন্টটি বর্তমানে নিষ্ক্রিয় করা আছে, তাই এক্সাম শুরু করা যাবে না। বিস্তারিত জানতে অ্যাডমিনের সাথে যোগাযোগ করুন।" };
  const site = await deps.getSite().catch(() => ({ maintenance: false, message: "" }));
  if (site.maintenance && !isAdmin) return { ok: false, title: "Under maintenance", message: site.message || "এই মুহূর্তে নতুন এক্সাম শুরু করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।" };
  const exam = await deps.fetchExam(examId);
  if (!exam || (exam.status === "draft" && !isAdmin)) return gone;
  if (!isVisibleToStudent(exam, profile) && !isAdmin) return gone;
  if (exam.academicSubjectId) {
    const gate = await deps.academicGate(exam).catch(() => ({ allowed: true, reason: "unverified" }));
    if (!gate.allowed) {
      return gate.reason === "payment-required"
        ? { ok: false, title: "Premium access required", message: "This exam is part of a paid program and your account doesn't have access to it yet. Contact support with your registered email to get it activated." }
        : { ok: false, title: "Exam not available", message: "This exam isn't open right now — its program, level or subject has been taken offline." };
    }
  }
  const blocked = windowBlock(exam, isAdmin, deps.now());
  if (blocked) return { ok: false, ...blocked };
  const maxAttempts = Number(exam.maxAttempts || 0);
  let attemptsSoFar = 0;
  if (maxAttempts > 0) {
    attemptsSoFar = await deps.attemptsUsed(who.uid, examId);
    if (attemptsSoFar >= maxAttempts) return { ok: false, title: "No attempts left", message: `এই এক্সামে সর্বোচ্চ ${maxAttempts} বার অ্যাটেম্পট দেওয়া যায় — আপনি ইতিমধ্যে সবগুলো ব্যবহার করে ফেলেছেন।` };
  }
  return { ok: true, exam, attemptsSoFar, maxAttempts };
}

/** A fresh attempt: pool + deadline fixed by the server clock (identical to beginSession on the website). */
export function startSession(a: { uid: string; exam: Exam; questions: any[]; attemptsSoFar: number; now?: number }) {
  const now = a.now ?? serverNow();
  return Session.createSession({
    uid: a.uid, examId: a.exam.id, attemptId: makeAttemptId(), now, durationSec: (a.exam.duration || 10) * 60,
    attemptsSoFar: a.attemptsSoFar, layout: a.exam.layout === "all" ? "all" : "one", exam: a.exam, questions: a.questions,
  });
}

/** The attempt exactly as the result screen and the database need it, built from a saved session (live, submitted or expired). */
export function snapshotFromSession(session: any, o: { student: { name: string; email: string; roll: string }; auto?: boolean; now?: number; defaultPass?: number }): AttemptSnapshot {
  const now = o.now ?? serverNow();
  const plan = Session.toRestorePlan(session, now);
  const exam = plan.exam as Exam;
  const breakdown = scoreExam(exam, plan.questions, plan.answers, plan.secondsLeft);
  return buildAttemptSnapshot({
    exam, examId: session.examId, uid: session.uid, questions: plan.questions, answers: plan.answers, breakdown, layout: plan.layout,
    attemptId: plan.attemptId, attemptsSoFar: plan.attemptsSoFar, student: o.student, questionTimes: plan.times,
    auto: !!o.auto || plan.auto, passPercent: passPercentFor(exam, o.defaultPass ?? 60), now,
  });
}

export type SaveState = "saving" | "saved" | "failed" | "blocked";
const SAVE_TRIES = 3;
const SAVE_TIMEOUT_MS = 25_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number) => { let t: any; return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error("save timed out"), { code: "timeout" })), ms); })]).finally(() => clearTimeout(t)); };
const isPermanent = (e: any) => e?.code === "attempts-exhausted" || e?.code === "permission-denied";

/** Store the attempt (3 tries, 25 s each). Safe to repeat: the attempt id makes a retry idempotent (see saveResult). */
export async function saveWithRetries(snapshot: AttemptSnapshot, save: (payload: ReturnType<typeof saveResultPayload>) => Promise<unknown>): Promise<SaveState> {
  for (let i = 0; i < SAVE_TRIES; i++) {
    try { await withTimeout(save(saveResultPayload(snapshot)), SAVE_TIMEOUT_MS); return "saved"; }
    catch (err) { if (isPermanent(err)) return "blocked"; if (i < SAVE_TRIES - 1) await wait(1000 * (i + 1)); }
  }
  return "failed";
}

// ---------------------------------------------------------------- the last attempt, shared between the player and the result screen
export type LiveAttempt = AttemptSnapshot & { saveState: SaveState };
const attempts = new Map<string, LiveAttempt>();
const listeners = new Set<() => void>();
export const setLastAttempt = (a: LiveAttempt) => { attempts.set(a.examId, a); listeners.forEach((l) => l()); };
export const getLastAttempt = (examId: string) => attempts.get(examId);
export const patchLastAttempt = (examId: string, patch: Partial<LiveAttempt>) => { const a = attempts.get(examId); if (a) { attempts.set(examId, { ...a, ...patch }); listeners.forEach((l) => l()); } };
export const subscribeAttempts = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
