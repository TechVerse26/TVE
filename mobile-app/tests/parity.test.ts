// The app's exam engine must behave EXACTLY like the website's. These tests load the website's own js/exam-engine.js and
// compare it with src/core/engine.ts on the same inputs (and, for shuffling, the same random numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildQuestionPool, scoreExam, buildAttemptSnapshot, saveResultPayload } from "../src/core/engine";
import type { Question, Exam } from "../src/core/types";

const here = dirname(fileURLToPath(import.meta.url));
const siteEngine = resolve(here, "..", "..", "js", "exam-engine.js");
const have = existsSync(siteEngine);
const W: any = have ? await import(siteEngine) : null;

// Deterministic random numbers (mulberry32) so both engines see the same sequence.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const bank = (n: number): Question[] => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, text: `Question ${i + 1}`, options: ["A", "B", "C", "D"].map((x) => `${x}${i}`), correctIndex: i % 4, explanation: i % 2 ? "because" : "" }));

test("scoreExam matches the website engine (live, practice, negative marking, partial answers)", { skip: !have }, () => {
  const rnd = prng(7);
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rnd() * 40);
    const questions = bank(n);
    const answers: Record<string, number> = {};
    questions.forEach((q) => { const r = rnd(); if (r < 0.7) answers[q.id] = r < 0.35 ? q.correctIndex : (q.correctIndex + 1) % 4; });
    const exam: Partial<Exam> = { examType: rnd() < 0.4 ? "practice" : "live", negativeMarking: [0, 0.25, 0.5, 1][Math.floor(rnd() * 4)], duration: [0, 10, 25, 60][Math.floor(rnd() * 4)] };
    const secondsLeft = Math.floor(rnd() * ((exam.duration || 10) * 60 + 50)) - 10;
    W.state.questions = questions; W.state.answers = answers; W.state.secondsLeft = secondsLeft;
    assert.deepEqual(scoreExam(exam, questions, answers, secondsLeft), W.scoreExam(exam));
  }
});

test("buildQuestionPool matches the website engine for the same random numbers", { skip: !have }, () => {
  for (const seed of [1, 2, 3, 99, 12345]) {
    for (const exam of [{}, { shuffle: false }, { questionsPerAttempt: 5 }, { questionsPerAttempt: 5, shuffle: false }, { questionsPerAttempt: 50 }] as Partial<Exam>[]) {
      const original = Math.random;
      Math.random = prng(seed);
      const theirs = W.buildQuestionPool(exam, bank(12));
      Math.random = prng(seed);
      const ours = buildQuestionPool(exam, bank(12));
      Math.random = original;
      assert.deepEqual(ours, theirs, `seed ${seed} exam ${JSON.stringify(exam)}`);
    }
  }
});

test("shuffling keeps the right answer attached to the right option", () => {
  const rnd = prng(5);
  const pool = buildQuestionPool({}, bank(30), rnd);
  const src = bank(30);
  for (const q of pool) {
    const original = src.find((s) => s.id === q.id)!;
    assert.equal(q.options[q.correctIndex], original.options[original.correctIndex]);
    assert.deepEqual([...q.options].sort(), [...original.options].sort());
  }
  assert.equal(pool.length, 30);
});

test("attempt snapshot lists only wrong / unanswered questions and the payload carries the website's fields", () => {
  const questions = bank(4);
  const answers = { q1: 0, q2: 0, q3: 2 }; // q1 ✓, q2 ✗ (correct is 1), q3 ✓, q4 unanswered
  const exam = { id: "e1", title: "T", examType: "live", duration: 10, maxAttempts: 2, negativeMarking: 0.5 } as Exam;
  const breakdown = scoreExam(exam, questions, answers, 100);
  const snap = buildAttemptSnapshot({ exam, examId: "e1", uid: "u1", questions, answers, breakdown, layout: "one", attemptId: "att-1", attemptsSoFar: 1, student: { name: "N", email: "e@x.com", roll: "0001" }, passPercent: 60, now: 5 });
  assert.equal(snap.attemptNumber, 2);
  assert.deepEqual(snap.review.map((r) => [r.n, r.selected]), [[2, 0], [4, null]]);
  assert.deepEqual(snap.qStats.map((s) => s.status), ["correct", "wrong", "correct", "skipped"]);
  assert.equal(breakdown.score, 1.5);
  const payload = saveResultPayload(snap);
  assert.deepEqual(Object.keys(payload).sort(), ["answers", "attemptId", "correctCount", "examId", "examTitle", "examType", "maxAttempts", "negativeMarking", "percent", "reviewSnapshot", "score", "timeTakenSeconds", "total", "uid", "unansweredCount", "wrongCount"]);
});

test("all-on-one-page layout records no per-question timing (like the website)", () => {
  const questions = bank(3);
  const breakdown = scoreExam({}, questions, {}, 0);
  const snap = buildAttemptSnapshot({ exam: null, examId: "e", uid: "u", questions, answers: {}, breakdown, layout: "all", attemptId: "a", attemptsSoFar: 0, student: { name: "", email: "", roll: "" }, passPercent: 60 });
  assert.deepEqual(snap.qStats, []);
});
