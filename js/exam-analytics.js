// ==========================================================================
// exam-analytics.js — what the result screen and the PDF report SAY about an attempt.
//
// Pure functions only: no DOM, no Firestore, no clock, no randomness. The same attempt (+ the same history)
// always gives the same numbers and the same words, so the on-screen result, the PDF and the unit tests can
// never disagree with each other.
//
// REAL DATA ONLY. Every figure comes from
//   • the attempt snapshot built at submit time (counts, score, percent, time used, per-question screen time), and
//   • the student's own earlier results (the userStats summary), the exam list and the subject names.
// Nothing is estimated, rounded up for comfort or invented. When something cannot be known — a first attempt,
// history that failed to load, an exam without a subject, a layout that shows every question at once — the answer
// is an explicit state ("first" / "unknown" / "empty") with the reason, never a made-up number. No letter grades,
// no ranks, no "you beat X% of students" — none of that exists in the data.
//
// The scoring itself (+1 / −negative marking / percent) lives in exam-engine.js and is NOT touched here: this file
// only reads the numbers scoreExam() already produced.
//
// Text fields in the returned objects are PLAIN text (they can contain admin-written subject names) — escape
// them when drawing HTML.
// ==========================================================================
import { toBnDigits } from "./schedule-core.js";
import { bestOf } from "./home-core.js";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const ratio = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const bn = (v) => toBnDigits(v);
const bnPct = (v) => `${bn(v)}%`;
const typeOf = (t) => (t === "practice" ? "practice" : "live");

/* ==========================================================================
   Formatting (the same rules everywhere on the result screen and in the PDF)
   ========================================================================== */

/** 31 → "31", 31.75 → "31.75" (identical to utils.formatScore, kept here so this module stays pure). */
export function formatScoreText(n) {
  const x = num(n);
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

/** 312 → "05:12", 3725 → "1:02:05" — the compact clock used on stat cards. */
export function formatClockText(totalSeconds) {
  const s = Math.max(0, Math.floor(num(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** 312 → "৫ মিনিট ১২ সেকেন্ড" — Bengali digits and units, for sentences. */
export function formatDurationBn(totalSeconds) {
  const s = Math.max(0, Math.round(num(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${bn(h)} ঘণ্টা`);
  if (m) parts.push(`${bn(m)} মিনিট`);
  if (sec && !h) parts.push(`${bn(sec)} সেকেন্ড`);
  if (!parts.length) parts.push(`${bn(sec)} সেকেন্ড`);
  return parts.join(" ");
}

/** +5 → "+5%", −3 → "−3%", 0 → "0%". */
export function deltaText(n, suffix = "%") {
  const v = round1(num(n));
  if (v === 0) return `0${suffix}`;
  return `${v > 0 ? "+" : "−"}${Math.abs(v)}${suffix}`;
}

/* ==========================================================================
   1. The numbers of one attempt
   ========================================================================== */

/**
 * Everything countable about the attempt, from the numbers scoreExam() already produced.
 * `penalty` is wrong × negativeMarking, so  correct − penalty === score  (up to the 2-decimal rounding scoreExam uses).
 */
export function computeMetrics(a) {
  const total = Math.max(0, Math.round(num(a?.total)));
  const correct = Math.max(0, num(a?.correctCount));
  const wrong = Math.max(0, num(a?.wrongCount));
  const unanswered = Math.max(0, num(a?.unansweredCount, Math.max(0, total - correct - wrong)));
  const attempted = correct + wrong;
  const negativeMarking = a?.examType === "practice" ? 0 : Math.max(0, num(a?.negativeMarking));
  const penalty = round2(wrong * negativeMarking);
  const score = num(a?.score);
  const percent = clamp(Math.round(num(a?.percent)), 0, 100);
  const allowedSeconds = Math.max(0, num(a?.durationSeconds));
  const takenSeconds = Math.max(0, num(a?.timeTakenSeconds));

  return {
    total, correct, wrong, unanswered, attempted,
    score, percent,
    // Of the questions the student actually answered, how many were right. Unknown (null) when nothing was answered.
    accuracy: attempted > 0 ? round1(ratio(correct, attempted)) : null,
    // How much of the paper was attempted at all.
    attemptRate: total > 0 ? round1(ratio(attempted, total)) : 0,
    // Segment widths for the stacked bar (sum = 100 when total > 0).
    shares: {
      correct: total > 0 ? ratio(correct, total) : 0,
      wrong: total > 0 ? ratio(wrong, total) : 0,
      unanswered: total > 0 ? ratio(unanswered, total) : 0,
    },
    negativeMarking, penalty,
    // Negative marking can push the score below zero; the percent shown is clamped to 0 (scoreExam's rule).
    belowZero: score < 0,
    allowedSeconds, takenSeconds,
    timeUsedPercent: allowedSeconds > 0 ? clamp(Math.round(ratio(takenSeconds, allowedSeconds)), 0, 100) : null,
    timeLeftSeconds: allowedSeconds > 0 ? Math.max(0, allowedSeconds - takenSeconds) : null,
    avgSecondsPerQuestion: total > 0 ? Math.round(takenSeconds / total) : null,
    allowedSecondsPerQuestion: allowedSeconds > 0 && total > 0 ? Math.floor(allowedSeconds / total) : null,
    auto: !!a?.auto,
  };
}

/* ==========================================================================
   2. The headline message (respectful, relative to the exam's own pass line)
   ========================================================================== */
const TIERS = {
  perfect: { title: "নিখুঁত ফলাফল!", message: "প্রতিটি প্রশ্নের সঠিক উত্তর দিয়েছেন — অসাধারণ প্রস্তুতি।", tone: "great" },
  great: { title: "অসাধারণ ফলাফল!", message: "খুব ভালো করেছেন। এই ধারাবাহিকতা ধরে রাখুন।", tone: "great" },
  good: { title: "ভালো ফলাফল", message: "পাস মার্ক পেরিয়েছেন। ভুলগুলো একবার দেখে নিলে আরও ভালো করা সম্ভব।", tone: "good" },
  near: { title: "পাস মার্কের কাছাকাছি", message: "আর অল্প একটু এগোলেই পাস মার্ক ছোঁয়া সম্ভব। ভুলগুলো শুধরে নিয়ে আবার চেষ্টা করুন।", tone: "near" },
  weak: { title: "আরও চর্চার প্রয়োজন", message: "এবারের ফল প্রত্যাশামতো না হলেও এটি শেখার সুযোগ। ভুলগুলো দেখে নিয়ে আবার চেষ্টা করুন।", tone: "weak" },
  none: { title: "কোনো উত্তর দেওয়া হয়নি", message: "এবার কোনো প্রশ্নের উত্তর জমা পড়েনি। প্রস্তুতি নিয়ে আবার চেষ্টা করুন।", tone: "weak" },
};

/** Pass line in whole percent; falls back to 60 (the site default) when the attempt carries none. */
export function passLineOf(a) {
  const p = Math.round(num(a?.passPercent));
  return p > 0 ? Math.min(100, p) : 60;
}

/**
 * { key, title, message, tone, pass:{ percent, passed, gap } } — judged ONLY against the pass line the exam
 * itself defines (or the site default); no grade is invented.
 */
export function resultTier(m, passPercent) {
  const pass = clamp(Math.round(num(passPercent, 60)) || 60, 1, 100);
  const passed = m.percent >= pass;
  const greatFrom = Math.min(100, Math.max(pass + 20, 80));
  let key;
  if (m.total > 0 && m.attempted === 0) key = "none";
  else if (m.total > 0 && m.correct === m.total) key = "perfect";
  else if (m.percent >= greatFrom) key = "great";
  else if (passed) key = "good";
  else if (m.percent >= pass - 15) key = "near";
  else key = "weak";
  return { key, ...TIERS[key], pass: { percent: pass, passed, gap: Math.max(0, pass - m.percent) } };
}

/* ==========================================================================
   3. Comparison with the student's earlier results
   ========================================================================== */

/**
 * The previous result record for THIS exam: the stored summary entry and/or the attempt just finished in this
 * browser session (the summary may not know about it yet if its save is still pending). The newer one wins.
 */
export function pickPrevious(storedEntry, sessionEntry) {
  const a = storedEntry && typeof storedEntry === "object" ? storedEntry : null;
  const b = sessionEntry && typeof sessionEntry === "object" ? sessionEntry : null;
  if (a && b) return num(b.at) >= num(a.at) ? b : a;
  return a || b || null;
}

/** Average of the latest percent over the student's OTHER exams of the same type (null below 2 exams: not a trend yet). */
export function overallAverage(entries, excludeExamId, type) {
  const list = Object.entries(entries || {})
    .filter(([id, e]) => id !== excludeExamId && e && typeOf(e.ty) === type)
    .map(([, e]) => num(e.p));
  if (list.length < 2) return null;
  return { count: list.length, avg: Math.round(list.reduce((s, v) => s + v, 0) / list.length) };
}

/**
 * state: "unknown" — no history could be loaded (never claim "first attempt" without knowing)
 *        "first"   — history loaded and this exam is not in it
 *        "ok"      — there is a previous attempt: deltas below
 * `m` = computeMetrics(current), `prev` = pickPrevious(...), `others` = overallAverage(...) or null.
 */
export function compareAttempts(m, prev, { known = true, others = null } = {}) {
  if (!prev) {
    if (!known) return { state: "unknown" };
    return { state: "first", vsOthers: others ? { ...others, delta: m.percent - others.avg } : null };
  }
  const prevPercent = clamp(Math.round(num(prev.p)), 0, 100);
  const delta = m.percent - prevPercent;
  const priorBest = Math.max(bestOf(prev), prevPercent);
  const out = {
    state: "ok",
    prevAttemptNumber: num(prev.n) || null,
    prevAt: num(prev.at) || null,
    prevPercent,
    prevScore: num(prev.s),
    prevTotal: num(prev.t),
    deltaPercent: delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "same",
    priorBest,
    isNewBest: m.percent > priorBest,
    equalsBest: m.percent === priorBest && priorBest > 0,
    vsOthers: others ? { ...others, delta: m.percent - others.avg } : null,
    // Detail below exists only for summaries written after this feature shipped, and only when the two papers
    // had the same number of questions (so counts are comparable). Otherwise null — never guessed.
    detail: null,
    trend: null,
  };

  const sameSize = num(prev.t) === m.total && m.total > 0;
  const hasCounts = Number.isFinite(Number(prev.c)) && Number.isFinite(Number(prev.w));
  if (sameSize && hasCounts) {
    const pc = num(prev.c);
    const pw = num(prev.w);
    const prevAcc = pc + pw > 0 ? round1(ratio(pc, pc + pw)) : null;
    out.detail = {
      prevCorrect: pc,
      prevWrong: pw,
      deltaCorrect: m.correct - pc,
      deltaWrong: m.wrong - pw,
      prevAccuracy: prevAcc,
      deltaAccuracy: prevAcc !== null && m.accuracy !== null ? round1(m.accuracy - prevAcc) : null,
      prevTimeSeconds: Number.isFinite(Number(prev.tt)) ? num(prev.tt) : null,
      deltaTimeSeconds: Number.isFinite(Number(prev.tt)) ? m.takenSeconds - num(prev.tt) : null,
    };
  }

  // Practice exams keep their last attempts in the summary (a short history): enough for a small trend.
  if (Array.isArray(prev.h) && prev.h.length) {
    out.trend = prev.h.slice(-7).map((x) => clamp(Math.round(num(x?.p)), 0, 100)).concat(m.percent);
  }
  return out;
}

/* ==========================================================================
   4. Subject-wise performance (from the student's exams, grouped by the exam's subject)
   ========================================================================== */

/**
 * Per-question subjects are not stored in the question banks today, so subjects are judged at EXAM level:
 * every exam the student took that carries a subject counts once, at its latest result — and the attempt that was
 * just finished replaces the stored result of its own exam.
 *   entries   { [examId]: stats entry }  (before this attempt)
 *   examsById { [examId]: { subjectId } }
 *   taxonomy  { subjects: [{ id, name }] }
 *   current   { examId, subjectId, percent }
 * → { state:"ok", rows:[{ id, name, exams, avg, status:"weak"|"ok"|"strong", isCurrent }], weak, partial }
 *   { state:"empty", reason:"no-subject" | "no-name" }
 */
export function subjectPerformance({ entries = {}, examsById = {}, taxonomy = null, current, passLine = 60, partial = false }) {
  const names = new Map((taxonomy?.subjects || []).map((s) => [s.id, s.name]));
  const bySubject = new Map();
  const add = (subjectId, percent, isCurrent) => {
    if (!subjectId) return;
    const bucket = bySubject.get(subjectId) || { id: subjectId, sum: 0, exams: 0, isCurrent: false };
    bucket.sum += percent;
    bucket.exams += 1;
    bucket.isCurrent = bucket.isCurrent || isCurrent;
    bySubject.set(subjectId, bucket);
  };

  Object.entries(entries || {}).forEach(([examId, e]) => {
    if (!e || examId === current?.examId) return;
    add(examsById?.[examId]?.subjectId, clamp(num(e.p), 0, 100), false);
  });
  add(current?.subjectId, clamp(num(current?.percent), 0, 100), true);

  const line = clamp(Math.round(num(passLine, 60)) || 60, 1, 100);
  const rows = [];
  let unnamed = 0;
  bySubject.forEach((b) => {
    const name = names.get(b.id);
    if (!name) { unnamed++; return; }
    const avg = Math.round(b.sum / b.exams);
    rows.push({ id: b.id, name, exams: b.exams, avg, status: avg < line ? "weak" : avg >= 80 ? "strong" : "ok", isCurrent: b.isCurrent });
  });

  if (!rows.length) return { state: "empty", reason: bySubject.size || unnamed ? "no-name" : "no-subject" };

  // This exam's subject first, then weakest → strongest (what to revise comes before what is fine).
  rows.sort((x, y) => (Number(y.isCurrent) - Number(x.isCurrent)) || (x.avg - y.avg) || x.name.localeCompare(y.name, "bn"));
  const shown = rows.slice(0, 6);
  return { state: "ok", rows: shown, hidden: rows.length - shown.length, weak: rows.filter((r) => r.status === "weak"), line, partial: !!partial };
}

/* ==========================================================================
   5. Time analysis from the per-question screen time
   ========================================================================== */

/**
 * qStats = [{ n, sec, status:"correct"|"wrong"|"skipped" }] — recorded only when the exam shows ONE question at a
 * time. With the "all questions on one page" layout nothing is tracked and the answer is { tracked:false }.
 */
export function timingInsights(qStats) {
  const items = (Array.isArray(qStats) ? qStats : [])
    .map((q) => ({ n: num(q?.n), sec: Math.max(0, Math.round(num(q?.sec))), status: q?.status === "correct" || q?.status === "wrong" ? q.status : "skipped" }))
    .filter((q) => q.n > 0);
  const totalSeconds = items.reduce((s, q) => s + q.sec, 0);
  if (!items.length || totalSeconds <= 0) return { tracked: false };

  const avg = totalSeconds / items.length;
  const slowest = items.filter((q) => q.sec >= 5).sort((a, b) => b.sec - a.sec || a.n - b.n).slice(0, 3);
  return {
    tracked: true,
    avgSeconds: Math.round(avg),
    totalSeconds,
    slowest,
    rushedWrong: items.filter((q) => q.status === "wrong" && q.sec <= 3).length,
    // Heavy time sink: at least 45 s and well above this student's own average.
    sink: slowest.length && slowest[0].sec >= 45 && slowest[0].sec >= avg * 2.5 ? slowest[0] : null,
  };
}

/* ==========================================================================
   6. Suggestions — rules over the real numbers above, nothing generic padded in
   ========================================================================== */

/** Up to 4 short, actionable lines. `action:"review"` lets the screen link the line to the mistakes list. */
export function buildSuggestions({ m, tier, comparison, subjects, timing }) {
  const out = [];
  const push = (s) => out.push(s);

  if (m.total > 0 && m.attempted === 0) {
    push({ id: "none", tone: "warn", icon: "fa-pen-to-square", text: "এবার কোনো উত্তর দেওয়া হয়নি। প্রশ্নগুলো মনোযোগ দিয়ে পড়ে অন্তত জানা প্রশ্নগুলোর উত্তর আগে দিন।" });
  }
  if (tier.key === "perfect") {
    push({ id: "perfect", tone: "good", icon: "fa-star", text: "সব প্রশ্ন সঠিক হয়েছে। এবার নতুন মডেল টেস্ট বা কঠিন প্র্যাকটিস সেট দিয়ে নিজেকে আরও যাচাই করুন।" });
  }

  const weak = subjects?.state === "ok" ? subjects.weak : [];
  if (weak.length) {
    push({ id: "weak-subjects", tone: "warn", icon: "fa-book-open", text: `দুর্বল বিষয়: ${weak.slice(0, 2).map((r) => r.name).join(" ও ")}। এই বিষয়ের পাঠ আবার রিভিশন করুন এবং প্র্যাকটিস পরীক্ষা দিন।` });
  }

  const missed = m.wrong + m.unanswered;
  if (missed > 0 && m.attempted > 0) {
    push({ id: "review", tone: "info", icon: "fa-list-check", action: "review", text: `নিচের রিভিউতে ভুল ও বাদ পড়া ${bn(missed)}টি প্রশ্নের সঠিক উত্তর দেওয়া আছে — মিলিয়ে নিন, যাতে একই ভুল আর না হয়।` });
  }

  if (m.unanswered > 0 && m.attempted > 0) {
    if (m.auto) {
      push({
        id: "unanswered-time", tone: "warn", icon: "fa-hourglass-end",
        text: `সময় শেষ হয়ে যাওয়ায় ${bn(m.unanswered)}টি প্রশ্নের উত্তর দেওয়া হয়নি।${m.allowedSecondsPerQuestion ? ` এই পরীক্ষায় প্রতি প্রশ্নে গড়ে ${bn(m.allowedSecondsPerQuestion)} সেকেন্ড বরাদ্দ — সেই গতিতে এগোনোর অভ্যাস করুন।` : ""}`,
      });
    } else if (m.timeLeftSeconds > 0) {
      push({
        id: "unanswered-left", tone: "warn", icon: "fa-clock",
        text: `${bn(m.unanswered)}টি প্রশ্ন উত্তর ছাড়াই জমা দিয়েছেন, অথচ ${formatDurationBn(m.timeLeftSeconds)} সময় বাকি ছিল। জমা দেওয়ার আগে বাদ পড়া প্রশ্নগুলো একবার দেখে নিন।`,
      });
    }
  }

  if (m.negativeMarking > 0 && m.penalty > 0) {
    push({ id: "negative", tone: "warn", icon: "fa-triangle-exclamation", text: `ভুল উত্তরের কারণে মোট ${bn(formatScoreText(m.penalty))} নম্বর কাটা গেছে। নিশ্চিত না হলে উত্তর দেওয়ার আগে আরেকটু ভেবে নিন।` });
  }

  if (comparison?.state === "ok") {
    if (comparison.direction === "down") {
      push({ id: "cmp-down", tone: "warn", icon: "fa-arrow-trend-down", text: `আগের অ্যাটেম্পটের চেয়ে ${bnPct(Math.abs(comparison.deltaPercent))} কম হয়েছে। আগের ভুলগুলো আবার দেখে নিলে এগোনো সহজ হবে।` });
    } else if (comparison.direction === "up") {
      push({ id: "cmp-up", tone: "good", icon: "fa-arrow-trend-up", text: `আগের অ্যাটেম্পটের চেয়ে ${bnPct(comparison.deltaPercent)} উন্নতি হয়েছে — এই অভ্যাস চালিয়ে যান।` });
    }
  }

  if (timing?.tracked) {
    if (timing.rushedWrong >= 2) {
      push({ id: "rushed", tone: "info", icon: "fa-bolt", text: `${bn(timing.rushedWrong)}টি ভুল উত্তর ৩ সেকেন্ডেরও কম সময়ে দেওয়া হয়েছে। প্রশ্ন ও অপশন ভালোভাবে পড়ে উত্তর দিলে ভুল কমতে পারে।` });
    }
    if (timing.sink) {
      push({ id: "sink", tone: "info", icon: "fa-stopwatch", text: `প্রশ্ন ${bn(timing.sink.n)}-এ সবচেয়ে বেশি (${formatDurationBn(timing.sink.sec)}) সময় গেছে। কঠিন প্রশ্নে বেশি আটকে না থেকে এগিয়ে যাওয়ার অভ্যাস করুন।` });
    }
  }
  return out.slice(0, 4);
}

/* ==========================================================================
   7. Putting it together
   ========================================================================== */

/**
 * Everything that can be said from the attempt ALONE — available the instant the exam is submitted.
 * The two sections that need the student's history start as "pending".
 */
export function buildCoreAnalytics(attempt) {
  const m = computeMetrics(attempt);
  const tier = resultTier(m, passLineOf(attempt));
  const timing = timingInsights(attempt?.qStats);
  const core = { m, tier, timing, comparison: { state: "pending" }, subjects: { state: "pending" } };
  core.suggestions = buildSuggestions(core);
  return core;
}

/**
 * Adds the history-based sections.
 *   ctx = { statsOk, entries, sessionEntry, examsById, taxonomy, defaultPass }  — see exam.js (captured when the
 *   attempt began, so the "previous result" is exactly what the student had BEFORE this attempt).
 *   A missing ctx (it could not be loaded) turns both sections into explicit "unknown" states.
 */
export function completeAnalytics(attempt, core, ctx) {
  const { m } = core;
  const type = typeOf(attempt?.examType);
  let comparison;
  let subjects;

  if (!ctx) {
    comparison = { state: "unknown" };
    subjects = { state: "unknown" };
  } else {
    const stored = ctx.statsOk ? ctx.entries?.[attempt.examId] : null;
    const prev = pickPrevious(stored, ctx.sessionEntry);
    const others = ctx.statsOk ? overallAverage(ctx.entries, attempt.examId, type) : null;
    comparison = compareAttempts(m, prev, { known: !!ctx.statsOk, others });

    const subjectId = attempt.subjectId || ctx.examsById?.[attempt.examId]?.subjectId || "";
    const perf = subjectPerformance({
      entries: ctx.statsOk ? ctx.entries : {},
      examsById: ctx.examsById || {},
      taxonomy: ctx.taxonomy,
      current: { examId: attempt.examId, subjectId, percent: m.percent },
      passLine: ctx.defaultPass,
      partial: !ctx.statsOk,
    });
    subjects = perf;
  }

  const full = { ...core, comparison, subjects };
  full.suggestions = buildSuggestions(full);
  return full;
}

/**
 * A summary-shaped entry ({ n, s, t, p, at, ty, ti, b, c, w, u, tt }) for an attempt that finished in this browser
 * session — so a quick retake can compare against it even if the stored summary has not caught up yet.
 */
export function entryFromAttempt(a, prev = null) {
  const p = clamp(Math.round(num(a?.percent)), 0, 100);
  return {
    n: Math.max(num(a?.attemptNumber, 1), prev ? num(prev.n) + 1 : 0, 1),
    s: num(a?.score),
    t: num(a?.total),
    p,
    at: num(a?.submittedAtMs),
    ty: typeOf(a?.examType),
    ti: String(a?.examTitle || "").slice(0, 120),
    b: Math.max(p, prev ? bestOf(prev) : 0),
    c: Math.max(0, num(a?.correctCount)),
    w: Math.max(0, num(a?.wrongCount)),
    u: Math.max(0, num(a?.unansweredCount)),
    tt: Math.max(0, num(a?.timeTakenSeconds)),
  };
}
