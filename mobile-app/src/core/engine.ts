// The exam engine — a line-for-line port of js/exam-engine.js (question pool, shuffling, scoring) and of the attempt
// snapshot built in js/exam.js. Pure functions: no Firebase, no DOM. tests/parity.test.ts runs this against the website's
// own engine with the same random numbers and requires identical output.
import type { Exam, Question, ReviewItem } from "./types";

export type Rnd = () => number;
const defaultRnd: Rnd = () => Math.random();

export function shuffleArray<T>(arr: T[], rnd: Rnd = defaultRnd): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The actual question set for one attempt: random pool (questionsPerAttempt) + shuffled questions and options. */
export function buildQuestionPool(exam: Partial<Exam>, bank: Question[], rnd: Rnd = defaultRnd): Question[] {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  let pool = perAttempt > 0 && perAttempt < bank.length ? shuffleArray(bank, rnd).slice(0, perAttempt) : bank.slice();
  if (exam.shuffle !== false) {
    pool = shuffleArray(pool, rnd).map((q) => {
      const optionOrder = shuffleArray(q.options.map((_, i) => i), rnd);
      return { ...q, options: optionOrder.map((oi) => q.options[oi]), correctIndex: optionOrder.indexOf(q.correctIndex) };
    });
  }
  return pool;
}

export interface Breakdown {
  correctCount: number; wrongCount: number; unansweredCount: number; negativeMarking: number;
  score: number; percent: number; timeTakenSeconds: number;
}

/** +1 per correct, −negativeMarking per wrong. Practice exams are risk-free: negative marking never applies. */
export function scoreExam(exam: Partial<Exam> | null | undefined, questions: Question[], answers: Record<string, number>, secondsLeft: number): Breakdown {
  const negativeMarking = exam?.examType === "practice" ? 0 : Math.max(0, Number(exam?.negativeMarking) || 0);
  let correctCount = 0;
  let wrongCount = 0;
  questions.forEach((q) => {
    if (answers[q.id] === undefined) return;
    if (answers[q.id] === q.correctIndex) correctCount++;
    else wrongCount++;
  });
  const unansweredCount = questions.length - correctCount - wrongCount;
  const rawScore = correctCount - wrongCount * negativeMarking;
  const score = Math.round(rawScore * 100) / 100;
  const percent = Math.max(0, Math.min(100, Math.round((rawScore / questions.length) * 100)));
  const totalSeconds = (exam?.duration || 10) * 60;
  const timeTakenSeconds = Math.max(0, Math.min(totalSeconds, totalSeconds - secondsLeft));
  return { correctCount, wrongCount, unansweredCount, negativeMarking, score, percent, timeTakenSeconds };
}

export function makeAttemptId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface AttemptSnapshot {
  attemptId: string; uid: string; examId: string; examTitle: string; examType: "live" | "practice";
  courseId: string; courseName: string; maxAttempts: number;
  score: number; total: number; percent: number; correctCount: number; wrongCount: number; unansweredCount: number;
  negativeMarking: number; timeTakenSeconds: number; attemptNumber: number; submittedAtMs: number;
  student: { name: string; email: string; roll: string };
  answers: Record<string, number>; review: ReviewItem[]; auto: boolean; layout: "one" | "all";
  durationSeconds: number; passPercent: number; subjectId: string;
  qStats: { n: number; sec: number; status: "skipped" | "correct" | "wrong" }[];
}

/** Everything the result screen and saveResult need — same fields, same rules as buildAttemptSnapshot in js/exam.js. */
export function buildAttemptSnapshot(a: {
  exam: Exam | null; examId: string; uid: string; questions: Question[]; answers: Record<string, number>;
  breakdown: Breakdown; layout: "one" | "all"; attemptId: string; attemptsSoFar: number;
  student: { name: string; email: string; roll: string }; questionTimes?: Record<string, number>;
  auto?: boolean; passPercent: number; now?: number;
}): AttemptSnapshot {
  const { exam, questions, answers, breakdown } = a;
  const times = a.questionTimes || {};
  const timed = a.layout === "one"; // only one-question-at-a-time can be timed
  const review: ReviewItem[] = [];
  const qStats: AttemptSnapshot["qStats"] = [];
  questions.forEach((q, i) => {
    const selected = answers[q.id] !== undefined ? answers[q.id] : null;
    if (timed) qStats.push({ n: i + 1, sec: Math.round(times[q.id] || 0), status: selected === null ? "skipped" : selected === q.correctIndex ? "correct" : "wrong" });
    if (selected === q.correctIndex) return;
    review.push({ id: q.id, n: i + 1, text: q.text, options: q.options.slice(), correctIndex: q.correctIndex, explanation: q.explanation || "", selected });
  });
  return {
    attemptId: a.attemptId, uid: a.uid, examId: a.examId,
    examTitle: exam?.title || "", examType: exam?.examType === "practice" ? "practice" : "live",
    courseId: exam?.courseId || "", courseName: exam?.courseName || "", maxAttempts: Number(exam?.maxAttempts) || 0,
    score: breakdown.score, total: questions.length, percent: breakdown.percent,
    correctCount: breakdown.correctCount, wrongCount: breakdown.wrongCount, unansweredCount: breakdown.unansweredCount,
    negativeMarking: breakdown.negativeMarking, timeTakenSeconds: breakdown.timeTakenSeconds,
    attemptNumber: a.attemptsSoFar + 1, submittedAtMs: a.now ?? Date.now(),
    student: a.student, answers: { ...answers }, review, auto: !!a.auto, layout: a.layout,
    durationSeconds: (exam?.duration || 10) * 60, passPercent: a.passPercent, subjectId: exam?.subjectId || "", qStats: timed ? qStats : [],
  };
}

/** The exact field list js/exam.js passes to saveResult (saveResultPayload). */
export function saveResultPayload(a: AttemptSnapshot) {
  return {
    uid: a.uid, examId: a.examId, examTitle: a.examTitle, examType: a.examType,
    score: a.score, total: a.total, percent: a.percent,
    correctCount: a.correctCount, wrongCount: a.wrongCount, unansweredCount: a.unansweredCount,
    negativeMarking: a.negativeMarking, timeTakenSeconds: a.timeTakenSeconds,
    answers: a.answers, attemptId: a.attemptId, maxAttempts: a.maxAttempts, reviewSnapshot: a.review,
  };
}

/** Per-question screen time (feeds the result's time analysis only — never scoring). Paused while the app is in the background. */
export class QuestionClock {
  private id: string | null = null;
  private since: number | null = null;
  private times: Record<string, number> = {};
  private now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  private hidden = () => typeof document !== "undefined" && document.hidden === true;
  private flush() {
    if (this.id !== null && this.since !== null) this.times[this.id] = (this.times[this.id] || 0) + Math.max(0, this.now() - this.since) / 1000;
    this.since = null;
  }
  reset() { this.id = null; this.since = null; this.times = {}; }
  show(id: string) {
    if (id === this.id) { if (this.since === null && !this.hidden()) this.since = this.now(); return; }
    this.flush(); this.id = id; this.since = this.hidden() ? null : this.now();
  }
  pause() { this.flush(); }
  resume() { if (this.id !== null && this.since === null) this.since = this.now(); }
  snapshot(): Record<string, number> {
    const t = { ...this.times };
    if (this.id !== null && this.since !== null) t[this.id] = (t[this.id] || 0) + Math.max(0, this.now() - this.since) / 1000;
    return t;
  }
  stop(): Record<string, number> { this.flush(); this.id = null; return { ...this.times }; }
  restore(times: Record<string, number> | undefined) {
    this.reset();
    Object.entries(times || {}).forEach(([id, s]) => { if (Number.isFinite(s) && s >= 0) this.times[id] = s; });
  }
}
