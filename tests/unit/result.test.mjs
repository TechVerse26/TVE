// Unit tests for the post-exam Result Experience: the analytics rules (exam-analytics.js), the scoring they read
// (exam-engine.js — which must NOT have changed), and the per-question clock. No Firebase, no DOM.
//   node --test tests/unit/result.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// exam-engine.js registers a visibilitychange listener at import time when a `document` exists — give it a tiny one first.
const fakeDoc = new EventTarget();
fakeDoc.hidden = false;
globalThis.document = fakeDoc;

const A = await import("../../js/exam-analytics.js");
const E = await import("../../js/exam-engine.js");

/* ---------- helpers ---------- */
const attempt = (o = {}) => ({
  examType: "live", total: 40, correctCount: 31, wrongCount: 5, unansweredCount: 4, negativeMarking: 0.25,
  score: 29.75, percent: 74, durationSeconds: 1800, timeTakenSeconds: 1312, passPercent: 50, auto: false, ...o,
});
const metrics = (o) => A.computeMetrics(attempt(o));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/* ==========================================================================
   Scoring — the rules the result screen reads. Written against the REAL engine so a change there is caught.
   ========================================================================== */
function scoreWith(exam, correctIdx, picks, secondsLeft = 0) {
  E.resetSessionState("t");
  E.state.questions = correctIdx.map((c, i) => ({ id: `q${i}`, correctIndex: c, options: ["a", "b", "c", "d"] }));
  E.state.answers = {};
  picks.forEach((p, i) => { if (p !== undefined) E.state.answers[`q${i}`] = p; });
  E.state.secondsLeft = secondsLeft;
  return E.scoreExam(exam);
}

test("scoring: +1 per correct, −negativeMarking per wrong, nothing for unanswered", () => {
  const r = scoreWith({ examType: "live", negativeMarking: 0.25, duration: 10 }, [0, 1, 2, 3], [0, 1, 0, undefined]);
  assert.deepEqual([r.correctCount, r.wrongCount, r.unansweredCount], [2, 1, 1]);
  assert.equal(r.score, 1.75);
  assert.equal(r.percent, 44); // 1.75 / 4 = 43.75 % → 44
});

test("scoring: practice exams never apply negative marking", () => {
  const r = scoreWith({ examType: "practice", negativeMarking: 1, duration: 10 }, [0, 1], [1, 1]);
  assert.equal(r.negativeMarking, 0);
  assert.equal(r.score, 1);
});

test("scoring: a negative score is kept as the score but the percent is clamped to 0", () => {
  const r = scoreWith({ examType: "live", negativeMarking: 1, duration: 10 }, [0, 0, 0], [1, 1, 1]);
  assert.equal(r.score, -3);
  assert.equal(r.percent, 0);
});

test("scoring: time taken is the elapsed part of the limit, never beyond it", () => {
  assert.equal(scoreWith({ duration: 10 }, [0], [0], 100).timeTakenSeconds, 500);
  assert.equal(scoreWith({ duration: 10 }, [0], [0], 9999).timeTakenSeconds, 0);
  assert.equal(scoreWith({ duration: 10 }, [0], [0], -5).timeTakenSeconds, 600);
});

test("scoring: identity the result screen relies on — correct − (wrong × negative) equals the score (2 decimals)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const n = 5 + (seed % 17);
    const correct = Array.from({ length: n }, (_, i) => (i + seed) % 4);
    const picks = correct.map((c, i) => ((i * seed) % 5 === 4 ? undefined : (i * seed) % 7 < 3 ? c : (c + 1) % 4));
    const neg = [0, 0.25, 0.5, 1 / 3][seed % 4];
    const r = scoreWith({ examType: "live", negativeMarking: neg, duration: 20 }, correct, picks, 300);
    const m = A.computeMetrics({ examType: "live", total: n, correctCount: r.correctCount, wrongCount: r.wrongCount, unansweredCount: r.unansweredCount, negativeMarking: r.negativeMarking, score: r.score, percent: r.percent, durationSeconds: 1200, timeTakenSeconds: r.timeTakenSeconds });
    near(Math.round((m.correct - m.penalty) * 100) / 100, m.score, 0.011);
    assert.equal(m.correct + m.wrong + m.unanswered, n);
  }
});

/* ==========================================================================
   Metrics
   ========================================================================== */
test("metrics: accuracy is of the ANSWERED questions, attempt rate of the whole paper", () => {
  const m = metrics();
  assert.equal(m.attempted, 36);
  assert.equal(m.accuracy, 86.1);
  assert.equal(m.attemptRate, 90);
  near(m.shares.correct + m.shares.wrong + m.shares.unanswered, 100, 1e-9);
  assert.equal(m.penalty, 1.25);
  assert.equal(m.timeUsedPercent, 73);
  assert.equal(m.timeLeftSeconds, 488);
  assert.equal(m.avgSecondsPerQuestion, 33);
  assert.equal(m.allowedSecondsPerQuestion, 45);
});

test("metrics: nothing answered → accuracy is unknown (null), not 0%", () => {
  const m = metrics({ correctCount: 0, wrongCount: 0, unansweredCount: 40, score: 0, percent: 0 });
  assert.equal(m.accuracy, null);
  assert.equal(m.attemptRate, 0);
});

test("metrics: practice never reports a penalty, whatever the attempt carries", () => {
  const m = metrics({ examType: "practice", negativeMarking: 0.5 });
  assert.equal(m.negativeMarking, 0);
  assert.equal(m.penalty, 0);
});

test("metrics: a score below zero is flagged and the percent stays clamped", () => {
  const m = metrics({ correctCount: 1, wrongCount: 9, unansweredCount: 30, negativeMarking: 1, score: -8, percent: 0 });
  assert.equal(m.belowZero, true);
  assert.equal(m.percent, 0);
});

test("metrics: unknown time limit → no invented time percentages", () => {
  const m = metrics({ durationSeconds: undefined });
  assert.equal(m.timeUsedPercent, null);
  assert.equal(m.timeLeftSeconds, null);
  assert.equal(m.allowedSecondsPerQuestion, null);
});

test("metrics: more time recorded than allowed never shows above 100 %", () => {
  assert.equal(metrics({ timeTakenSeconds: 5000 }).timeUsedPercent, 100);
});

/* ==========================================================================
   The headline message — relative to the exam's own pass line, never an invented grade
   ========================================================================== */
const tierOf = (percent, pass, o = {}) => A.resultTier(metrics({ percent, ...o }), pass);

test("tier: bands relative to the pass line (default 60)", () => {
  assert.equal(tierOf(80, 60).key, "great");
  assert.equal(tierOf(79, 60).key, "good");
  assert.equal(tierOf(60, 60).key, "good");
  assert.equal(tierOf(59, 60).key, "near");
  assert.equal(tierOf(45, 60).key, "near");
  assert.equal(tierOf(44, 60).key, "weak");
});

test("tier: a pass line of 50 does not make 70 % 'great'", () => {
  assert.equal(tierOf(70, 50).key, "good");
  assert.equal(tierOf(80, 50).key, "great");
});

test("tier: pass info is factual (passed + the gap to the line)", () => {
  assert.deepEqual(tierOf(52, 60).pass, { percent: 60, passed: false, gap: 8 });
  assert.deepEqual(tierOf(60, 60).pass, { percent: 60, passed: true, gap: 0 });
});

test("tier: nothing answered / everything right are their own cases", () => {
  assert.equal(A.resultTier(metrics({ correctCount: 0, wrongCount: 0, unansweredCount: 40, score: 0, percent: 0 }), 60).key, "none");
  assert.equal(A.resultTier(metrics({ correctCount: 40, wrongCount: 0, unansweredCount: 0, score: 40, percent: 100 }), 60).key, "perfect");
});

test("tier: every message is Bengali text without emoji or a letter grade", () => {
  for (const key of ["perfect", "great", "good", "near", "weak", "none"]) {
    const m = key === "none" ? metrics({ correctCount: 0, wrongCount: 0, unansweredCount: 40, score: 0, percent: 0 })
      : key === "perfect" ? metrics({ correctCount: 40, wrongCount: 0, unansweredCount: 0, score: 40, percent: 100 })
      : metrics({ percent: { great: 85, good: 65, near: 50, weak: 20 }[key] });
    const t = A.resultTier(m, 60);
    assert.equal(t.key, key);
    assert.match(t.title + t.message, /[ঀ-৿]/);
    assert.doesNotMatch(t.title + t.message, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(t.title + t.message, /\b[A-F][+-]?\b/);
  }
});

test("passLineOf: own value, else 60", () => {
  assert.equal(A.passLineOf({ passPercent: 45 }), 45);
  assert.equal(A.passLineOf({}), 60);
  assert.equal(A.passLineOf({ passPercent: 250 }), 100);
});

/* ==========================================================================
   Comparison with earlier results
   ========================================================================== */
test("compare: no history loaded → unknown (never claims a first attempt)", () => {
  assert.equal(A.compareAttempts(metrics(), null, { known: false }).state, "unknown");
});

test("compare: history loaded but this exam not in it → first attempt", () => {
  assert.equal(A.compareAttempts(metrics(), null, { known: true }).state, "first");
});

test("compare: previous attempt → direction, delta and best handling", () => {
  const c = A.compareAttempts(metrics({ percent: 74 }), { n: 2, s: 24, t: 40, p: 60, b: 90, at: 1 });
  assert.equal(c.state, "ok");
  assert.equal(c.deltaPercent, 14);
  assert.equal(c.direction, "up");
  assert.equal(c.priorBest, 90);
  assert.equal(c.isNewBest, false); // 74 < the earlier best of 90
  assert.equal(c.prevAttemptNumber, 2);
});

test("compare: new best is only claimed when it beats the earlier BEST, not just the last attempt", () => {
  assert.equal(A.compareAttempts(metrics({ percent: 95 }), { p: 60, b: 90, t: 40 }).isNewBest, true);
  assert.equal(A.compareAttempts(metrics({ percent: 90 }), { p: 60, b: 90, t: 40 }).equalsBest, true);
  assert.equal(A.compareAttempts(metrics({ percent: 90 }), { p: 60, b: 90, t: 40 }).isNewBest, false);
});

test("compare: down and same", () => {
  assert.equal(A.compareAttempts(metrics({ percent: 50 }), { p: 60, t: 40 }).direction, "down");
  assert.equal(A.compareAttempts(metrics({ percent: 60 }), { p: 60, t: 40 }).direction, "same");
});

test("compare: counts / accuracy / time deltas only for summaries that carry them AND the same paper size", () => {
  const prev = { p: 60, t: 40, c: 24, w: 10, u: 6, tt: 1500 };
  const d = A.compareAttempts(metrics(), prev).detail;
  assert.equal(d.deltaCorrect, 7);
  assert.equal(d.deltaWrong, -5);
  assert.equal(d.deltaTimeSeconds, 1312 - 1500);
  assert.equal(d.prevAccuracy, 70.6);
  assert.equal(d.deltaAccuracy, 15.5);
  assert.equal(A.compareAttempts(metrics(), { p: 60, t: 40 }).detail, null, "an older summary without counts");
  assert.equal(A.compareAttempts(metrics(), { ...prev, t: 25 }).detail, null, "a different number of questions");
});

test("compare: practice history becomes a short trend that ends with this attempt", () => {
  const c = A.compareAttempts(metrics({ percent: 80 }), { p: 70, t: 40, h: [{ p: 40 }, { p: 55 }, { p: 70 }] });
  assert.deepEqual(c.trend, [40, 55, 70, 80]);
  assert.equal(A.compareAttempts(metrics(), { p: 70, t: 40 }).trend, null);
});

test("pickPrevious: the newer record wins; either side may be missing", () => {
  assert.deepEqual(A.pickPrevious({ at: 5, p: 1 }, { at: 9, p: 2 }), { at: 9, p: 2 });
  assert.deepEqual(A.pickPrevious({ at: 9, p: 1 }, { at: 5, p: 2 }), { at: 9, p: 1 });
  assert.deepEqual(A.pickPrevious(null, { at: 1 }), { at: 1 });
  assert.equal(A.pickPrevious(null, null), null);
});

test("overallAverage: other exams of the same type, at least two", () => {
  const entries = { cur: { p: 10, ty: "live" }, a: { p: 70, ty: "live" }, b: { p: 50, ty: "live" }, c: { p: 90, ty: "practice" } };
  assert.deepEqual(A.overallAverage(entries, "cur", "live"), { count: 2, avg: 60 });
  assert.equal(A.overallAverage(entries, "cur", "practice"), null, "one practice exam is not a trend");
});

/* ==========================================================================
   Subjects
   ========================================================================== */
const tax = { subjects: [{ id: "bn", name: "বাংলা" }, { id: "en", name: "English" }, { id: "gk", name: "সাধারণ জ্ঞান" }] };

test("subjects: grouped by the exam's subject; the finished attempt replaces its own exam's stored result", () => {
  const s = A.subjectPerformance({
    entries: { e1: { p: 40 }, e2: { p: 80 }, e3: { p: 30 }, cur: { p: 10 } },
    examsById: { e1: { subjectId: "bn" }, e2: { subjectId: "bn" }, e3: { subjectId: "en" }, cur: { subjectId: "bn" } },
    taxonomy: tax, current: { examId: "cur", subjectId: "bn", percent: 70 }, passLine: 60,
  });
  assert.equal(s.state, "ok");
  const bn = s.rows.find((r) => r.id === "bn");
  assert.equal(bn.exams, 3);
  assert.equal(bn.avg, 63); // (40 + 80 + 70) / 3
  assert.equal(bn.isCurrent, true);
  assert.equal(s.rows[0].id, "bn", "this exam's subject comes first");
  assert.deepEqual(s.weak.map((r) => r.id), ["en"]);
  assert.equal(s.rows.find((r) => r.id === "en").status, "weak");
});

test("subjects: statuses (weak < pass line ≤ ok < 80 ≤ strong)", () => {
  const run = (p) => A.subjectPerformance({ entries: {}, examsById: {}, taxonomy: tax, current: { examId: "x", subjectId: "bn", percent: p }, passLine: 60 }).rows[0].status;
  assert.equal(run(59), "weak");
  assert.equal(run(60), "ok");
  assert.equal(run(79), "ok");
  assert.equal(run(80), "strong");
});

test("subjects: honest empty states — no subject anywhere / subject without a name", () => {
  const none = A.subjectPerformance({ entries: { a: { p: 50 } }, examsById: { a: {} }, taxonomy: tax, current: { examId: "x", subjectId: "", percent: 50 } });
  assert.deepEqual([none.state, none.reason], ["empty", "no-subject"]);
  const unnamed = A.subjectPerformance({ entries: {}, examsById: {}, taxonomy: tax, current: { examId: "x", subjectId: "ghost", percent: 50 } });
  assert.deepEqual([unnamed.state, unnamed.reason], ["empty", "no-name"]);
});

test("subjects: at most six rows are shown and the rest is counted", () => {
  const subs = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `বিষয় ${i}` }));
  const entries = {}; const examsById = {};
  subs.forEach((s, i) => { entries[`e${i}`] = { p: 10 * i }; examsById[`e${i}`] = { subjectId: s.id }; });
  const r = A.subjectPerformance({ entries, examsById, taxonomy: { subjects: subs }, current: { examId: "x", subjectId: "", percent: 0 } });
  assert.equal(r.rows.length, 6);
  assert.equal(r.hidden, 3);
});

/* ==========================================================================
   Time analysis
   ========================================================================== */
test("timing: nothing recorded → not tracked", () => {
  assert.deepEqual(A.timingInsights([]), { tracked: false });
  assert.deepEqual(A.timingInsights([{ n: 1, sec: 0, status: "correct" }]), { tracked: false });
  assert.deepEqual(A.timingInsights(undefined), { tracked: false });
});

test("timing: slowest questions, rushed wrong answers and a heavy time sink", () => {
  const items = [
    { n: 1, sec: 10, status: "correct" }, { n: 2, sec: 2, status: "wrong" }, { n: 3, sec: 3, status: "wrong" },
    { n: 4, sec: 100, status: "wrong" }, { n: 5, sec: 12, status: "correct" }, { n: 6, sec: 8, status: "skipped" },
  ];
  const t = A.timingInsights(items);
  assert.equal(t.tracked, true);
  assert.deepEqual(t.slowest.map((q) => q.n), [4, 5, 1]);
  assert.equal(t.rushedWrong, 2);
  assert.equal(t.sink.n, 4);
  assert.equal(A.timingInsights(items.map((q) => ({ ...q, sec: q.sec === 100 ? 20 : q.sec }))).sink, null);
});

/* ==========================================================================
   Suggestions + the two-stage analytics
   ========================================================================== */
test("suggestions: real numbers only, at most four, plain Bengali text", () => {
  const core = A.buildCoreAnalytics(attempt());
  assert.ok(core.suggestions.length >= 1 && core.suggestions.length <= 4);
  const ids = core.suggestions.map((s) => s.id);
  assert.ok(ids.includes("review"));
  assert.ok(ids.includes("negative"));
  assert.ok(core.suggestions.find((s) => s.id === "negative").text.includes("১.২৫"));
  core.suggestions.forEach((s) => assert.match(s.text, /[ঀ-৿]/));
});

test("suggestions: auto-submitted vs finished early", () => {
  const timeUp = A.buildCoreAnalytics(attempt({ auto: true, timeTakenSeconds: 1800 })).suggestions.map((s) => s.id);
  const early = A.buildCoreAnalytics(attempt({ auto: false })).suggestions.map((s) => s.id);
  assert.ok(timeUp.includes("unanswered-time") && !timeUp.includes("unanswered-left"));
  assert.ok(early.includes("unanswered-left") && !early.includes("unanswered-time"));
});

test("suggestions: a perfect paper gets praise and no 'review' nag; nothing answered gets its own line", () => {
  const perfect = A.buildCoreAnalytics(attempt({ correctCount: 40, wrongCount: 0, unansweredCount: 0, score: 40, percent: 100 })).suggestions.map((s) => s.id);
  assert.deepEqual(perfect, ["perfect"]);
  const blank = A.buildCoreAnalytics(attempt({ correctCount: 0, wrongCount: 0, unansweredCount: 40, score: 0, percent: 0 })).suggestions.map((s) => s.id);
  assert.ok(blank.includes("none"));
});

test("analytics: core = pending history sections; completing them is a pure step", () => {
  const core = A.buildCoreAnalytics(attempt());
  assert.equal(core.comparison.state, "pending");
  assert.equal(core.subjects.state, "pending");
  const snapshot = JSON.stringify(core);
  const done = A.completeAnalytics(attempt({ examId: "cur", subjectId: "bn" }), core, {
    statsOk: true, entries: { cur: { n: 1, p: 60, t: 40, s: 24, at: 5 }, o1: { p: 40, ty: "live" }, o2: { p: 50, ty: "live" } },
    sessionEntry: null, examsById: { o1: { subjectId: "en" }, o2: { subjectId: "en" } }, taxonomy: tax, defaultPass: 60,
  });
  assert.equal(JSON.stringify(core), snapshot, "completeAnalytics must not mutate the core analytics");
  assert.equal(done.comparison.state, "ok");
  assert.equal(done.comparison.vsOthers.avg, 45);
  assert.equal(done.subjects.state, "ok");
  assert.ok(done.suggestions.some((s) => s.id === "weak-subjects"), "weak subject English (45 %) is called out");
  // Four higher-priority lines already fill the list; the improvement itself is shown by the comparison card.
  assert.deepEqual(done.suggestions.map((s) => s.id), ["weak-subjects", "review", "unanswered-left", "negative"]);
  assert.equal(done.suggestions.length, 4, "never more than four suggestions");
});

test("suggestions: comparison lines (improved / declined) appear when there is room", () => {
  const clean = { examId: "cur", total: 30, correctCount: 28, wrongCount: 2, unansweredCount: 0, score: 28, percent: 93, negativeMarking: 0 };
  const withId = (prevPercent) => {
    const a = attempt(clean);
    return A.completeAnalytics(a, A.buildCoreAnalytics(a), {
      statsOk: true, entries: { cur: { n: 1, p: prevPercent, t: 30, s: 1, at: 5 } },
      sessionEntry: null, examsById: {}, taxonomy: null, defaultPass: 60,
    });
  };
  const up = withId(70);
  assert.deepEqual(up.suggestions.map((s) => s.id), ["review", "cmp-up"]);
  assert.match(up.suggestions[1].text, /২৩%/, "93 − 70 = 23 points, written in Bengali digits");
  const down = withId(97);
  assert.deepEqual(down.suggestions.map((s) => s.id), ["review", "cmp-down"]);
  assert.match(down.suggestions[1].text, /৪%/);
  const same = withId(93);
  assert.deepEqual(same.suggestions.map((s) => s.id), ["review"], "no comparison line when nothing changed");
});

test("analytics: no context at all → both history sections are 'unknown', never made up", () => {
  const done = A.completeAnalytics(attempt(), A.buildCoreAnalytics(attempt()), null);
  assert.equal(done.comparison.state, "unknown");
  assert.equal(done.subjects.state, "unknown");
});

test("analytics: summary unavailable but the exam was already taken in this session → compared with that attempt", () => {
  const done = A.completeAnalytics(attempt({ examId: "cur" }), A.buildCoreAnalytics(attempt()), {
    statsOk: false, entries: {}, sessionEntry: { n: 1, p: 50, t: 40, s: 20, at: 9 }, examsById: {}, taxonomy: null, defaultPass: 60,
  });
  assert.equal(done.comparison.state, "ok");
  assert.equal(done.comparison.prevPercent, 50);
});

test("analytics: summary loaded, exam not in it, nothing in this session → first attempt", () => {
  const done = A.completeAnalytics(attempt({ examId: "cur" }), A.buildCoreAnalytics(attempt()), {
    statsOk: true, entries: {}, sessionEntry: null, examsById: {}, taxonomy: null, defaultPass: 60,
  });
  assert.equal(done.comparison.state, "first");
});

test("entryFromAttempt: a summary-shaped record; best and attempt number follow the earlier record", () => {
  const e = A.entryFromAttempt(attempt({ attemptNumber: 1, submittedAtMs: 123, examTitle: "T", percent: 74 }), { n: 3, p: 60, b: 90 });
  assert.deepEqual([e.n, e.p, e.b, e.c, e.w, e.u, e.tt, e.at, e.ty], [4, 74, 90, 31, 5, 4, 1312, 123, "live"]);
  const first = A.entryFromAttempt(attempt({ percent: 74 }));
  assert.deepEqual([first.n, first.b], [1, 74]);
});

/* ==========================================================================
   Formatting
   ========================================================================== */
test("formatting: scores, clocks, Bengali durations, deltas", () => {
  assert.equal(A.formatScoreText(31), "31");
  assert.equal(A.formatScoreText(29.75), "29.75");
  assert.equal(A.formatScoreText(-0), "0");
  assert.equal(A.formatClockText(312), "05:12");
  assert.equal(A.formatClockText(3725), "1:02:05");
  assert.equal(A.formatDurationBn(1312), "২১ মিনিট ৫২ সেকেন্ড");
  assert.equal(A.formatDurationBn(45), "৪৫ সেকেন্ড");
  assert.equal(A.formatDurationBn(3720), "১ ঘণ্টা ২ মিনিট");
  assert.equal(A.formatDurationBn(0), "০ সেকেন্ড");
  assert.equal(A.deltaText(5), "+5%");
  assert.equal(A.deltaText(-3.4), "−3.4%");
  assert.equal(A.deltaText(0), "0%");
});

/* ==========================================================================
   Per-question clock (feeds the time analysis only)
   ========================================================================== */
function withClock(fn) {
  let t = 0;
  const real = Object.getOwnPropertyDescriptor(globalThis, "performance");
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => t } });
  try { fn((ms) => { t += ms; }); } finally { Object.defineProperty(globalThis, "performance", real); }
}

test("clock: each question gets the time it was on screen; re-drawing the same question changes nothing", () => {
  withClock((advance) => {
    E.resetSessionState("c");
    E.markQuestionShown("q1"); advance(4000);
    E.markQuestionShown("q1"); advance(1000); // answered → re-rendered: still the same question
    E.markQuestionShown("q2"); advance(2500);
    E.markQuestionShown("q1"); advance(500);  // went back
    const t = E.stopQuestionClock();
    near(t.q1, 5.5); near(t.q2, 2.5);
  });
});

test("clock: time while the tab is hidden is not counted", () => {
  withClock((advance) => {
    E.resetSessionState("c");
    E.markQuestionShown("q1"); advance(3000);
    fakeDoc.hidden = true; fakeDoc.dispatchEvent(new Event("visibilitychange")); advance(60000);
    fakeDoc.hidden = false; fakeDoc.dispatchEvent(new Event("visibilitychange")); advance(2000);
    near(E.stopQuestionClock().q1, 5);
  });
});

test("clock: a new session starts from zero", () => {
  withClock((advance) => {
    E.resetSessionState("c"); E.markQuestionShown("q1"); advance(9000); E.stopQuestionClock();
    E.resetSessionState("d");
    assert.deepEqual(E.stopQuestionClock(), {});
  });
});

test("engine: the double-submit flag exists and is reset with the session", () => {
  E.state.submitting = true; E.state.submitted = true;
  E.resetSessionState("z");
  assert.equal(E.state.submitting, false);
  assert.equal(E.state.submitted, false);
});

/* ==========================================================================
   Design guardrails for css/exam-result.css — the brief, written down so a later edit cannot quietly break it:
   flat colours (no glow / neon / blur / gradient), nothing that flashes or loops, motion only behind .rx-animate,
   reduced motion honoured, both themes complete, no colour outside the theme tokens.
   ========================================================================== */
const rxCss = readFileSync(new URL("../../css/exam-result.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Text between the braces of the first block that starts with `head` (e.g. "@media print"), or null. */
function cssBlock(css, head) {
  const start = css.indexOf(head);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}
/** Every innermost rule as { selector, body } (an @media wrapper is flattened away). */
const cssRules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("design: the result stylesheet is flat — no gradients, glow, shadows, blur or filters", () => {
  const css = rxCss.toLowerCase();
  for (const bad of ["gradient(", "box-shadow", "text-shadow", "drop-shadow", "blur(", "backdrop-filter", "filter:", "mix-blend-mode", "glow", "neon"]) {
    assert.ok(!css.includes(bad), `exam-result.css must not use "${bad}" (the brief rules out glow / neon / blur / gradients)`);
  }
});

test("design: nothing loops or flashes — no infinite animation, no stepped blinking", () => {
  assert.ok(!/\binfinite\b/.test(rxCss), "no infinite animation");
  assert.ok(!/steps\(/.test(rxCss), "no steps() blinking");
  assert.ok(!/animation-iteration-count/.test(rxCss), "every animation runs once");
});

test("design: every keyframe animates FROM an offset to the plain style, so the finished state is the normal style", () => {
  const all = [...rxCss.matchAll(/@keyframes\s+([\w-]+)/g)];
  const simple = [...rxCss.matchAll(/@keyframes\s+([\w-]+)\s*\{\s*(from|to)\s*\{[^{}]*\}\s*\}/g)];
  assert.ok(all.length >= 6, "the motion set is there");
  assert.equal(simple.length, all.length, "each @keyframes is a single from{} / to{} step");
  for (const [, name, step] of simple) {
    assert.equal(step, name === "rx-stage-out" ? "to" : "from", `${name}: only the overlay's exit may animate toward a new style`);
  }
});

test("design: every animation sits behind .rx-animate (anything else must be 'none')", () => {
  let found = 0;
  for (const { selector, body } of cssRules(rxCss)) {
    for (const [, value] of body.matchAll(/(?:^|[;\s])animation(?:-[a-z-]+)?\s*:\s*([^;]+)/g)) {
      found++;
      if (/^none\b/.test(value.trim())) continue;
      for (const part of selector.split(",")) assert.ok(part.includes(".rx-animate"), `animation outside .rx-animate: ${part.trim()}`);
    }
  }
  assert.ok(found >= 10, "the animation rules were found");
});

test("design: reduced motion switches animation + transitions OFF and removes the overlay (a delay would still hide content)", () => {
  const rm = cssBlock(rxCss, "@media (prefers-reduced-motion: reduce)");
  assert.ok(rm, "reduced-motion block is missing");
  assert.match(rm, /animation:\s*none\s*!important/);
  assert.match(rm, /transition:\s*none\s*!important/);
  assert.match(rm, /\.rx-stage\s*\{\s*display:\s*none\s*!important/);
  assert.match(rxCss, /\.rx-static[^{]*\{\s*animation:\s*none\s*!important/, ".rx-static = finished state right now");
  const pr = cssBlock(rxCss, "@media print");
  assert.ok(pr, "print block is missing");
  assert.match(pr, /animation:\s*none\s*!important/);
  assert.match(pr, /\.rx-stage[^{]*\{[^}]*display:\s*none\s*!important/, "the overlay never prints");
});

test("design: light and dark define exactly the same colour tokens", () => {
  const tokens = (head) => {
    const rule = cssRules(rxCss).find((r) => r.selector.replace(/\s+/g, " ") === head);
    assert.ok(rule, `${head} is missing`);
    return [...rule.body.matchAll(/(--rx-[\w-]+)\s*:/g)].map((m) => m[1]).sort();
  };
  const dark = tokens('.rx, .rx[data-theme="dark"]');
  const light = tokens('.rx[data-theme="light"]');
  assert.ok(dark.length >= 15, "the token set was found");
  assert.deepEqual(light, dark);
});

test("design: colours come only from the theme tokens (so light and dark can never drift apart)", () => {
  for (const { selector, body } of cssRules(rxCss)) {
    const rest = body.replace(/--[\w-]+\s*:[^;]+;?/g, ""); // the token definitions themselves are allowed to hold literals
    assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(rest), `a literal colour outside the tokens in: ${selector}`);
  }
});

test("design: the overlay length in the JS (STAGE_MS) matches the CSS (--rx-stage and the exit delay)", () => {
  const js = readFileSync(new URL("../../js/exam-result.js", import.meta.url), "utf8");
  const ms = Number(/const STAGE_MS = (\d+);/.exec(js)?.[1]);
  const varS = Number(/\.rx-animate\s*\{\s*--rx-stage:\s*([\d.]+)s/.exec(rxCss)?.[1]);
  const exitDelay = Number(/rx-stage-out\s+[\d.]+s\s+\S+\s+([\d.]+)s\s+both/.exec(rxCss)?.[1]);
  assert.ok(ms > 0 && varS > 0 && exitDelay > 0, "all three numbers were found");
  assert.equal(varS * 1000, ms, "--rx-stage");
  assert.equal(exitDelay * 1000, ms, "overlay exit delay");
});
