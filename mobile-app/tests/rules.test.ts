import { test } from "node:test";
import assert from "node:assert/strict";
import { countAttempts, composeAttempts, isReviewExpired, reviewMsLeft, statsEntry, statsEntryFromResultDoc, REVIEW_TTL_MS, pruneExpiredReviews } from "../src/core/result-rules";
import { computeStatus, decorateAll, roleCan, normalizeRole, Session, scheduleItems, filterExams } from "../src/core/shared";
import type { AttemptRecord, Exam } from "../src/core/types";

const attempt = (i: number, review = true): AttemptRecord => ({ id: `a${i}`, score: i, total: 10, percent: i * 10, correctCount: i, wrongCount: 10 - i, unansweredCount: 0, timeTakenSeconds: 60, submittedAt: 1_000 * i, review: review ? [{ n: 1, text: "q", options: ["a", "b"], correctIndex: 0, selected: 1 }] : null });

test("history is capped at 30 and only the latest 10 keep their review", () => {
  let list: AttemptRecord[] = [];
  for (let i = 1; i <= 35; i++) list = composeAttempts(list, attempt(i), {});
  assert.equal(list.length, 30);
  assert.equal(list[0].id, "a6");
  assert.equal(list.filter((a) => a.review).length, 10);
  assert.ok(list.slice(-10).every((a) => a.review));
});

test("countAttempts uses the larger of attemptNumber and history length", () => {
  assert.equal(countAttempts(null), 1);
  assert.equal(countAttempts({ attemptNumber: 4 }), 4);
  assert.equal(countAttempts({ attemptNumber: 2, attempts: [attempt(1), attempt(2), attempt(3)] }), 3);
});

test("reviews expire after 48 hours and are pruned in memory", () => {
  const now = 10 * REVIEW_TTL_MS;
  assert.equal(isReviewExpired(now - REVIEW_TTL_MS - 1, now), true);
  assert.equal(isReviewExpired(now - 1000, now), false);
  assert.equal(isReviewExpired(null, now), false);
  assert.equal(reviewMsLeft(now - 1000, now), REVIEW_TTL_MS - 1000);
  const { next, changed } = pruneExpiredReviews([{ ...attempt(1), submittedAt: 1 }, { ...attempt(2), submittedAt: now }], now);
  assert.equal(changed, true);
  assert.equal(next[0].review, null);
  assert.ok(next[1].review);
});

test("userStats entry carries best percent and practice history", () => {
  const e = statsEntry({ attemptNumber: 3, score: 7, total: 10, percent: 70, examType: "practice", examTitle: "T", submittedMs: 5, attempts: [{ percent: 40, score: 4, total: 10 }, { percent: 90, score: 9, total: 10 }, { percent: 70, score: 7, total: 10 }], correct: 7, wrong: 3, unanswered: 0, seconds: 120 });
  assert.deepEqual([e.n, e.p, e.b, e.ty, e.c, e.w, e.u, e.tt], [3, 70, 90, "practice", 7, 3, 0, 120]);
  assert.equal(e.h?.length, 3);
  const live = statsEntryFromResultDoc({ examType: "live", examTitle: "L", score: 5, total: 10, percent: 50, attemptNumber: 1, attempts: [attempt(5)] });
  assert.equal(live.ty, "live");
  assert.equal(live.h, undefined);
});

const NOW = Date.parse("2026-11-09T10:00:00Z");
const exam = (o: Partial<Exam>): Exam => ({ id: "x", title: "X", ...o } as Exam);
test("exam status follows the website's schedule rules", () => {
  assert.equal(computeStatus(exam({ publishAt: NOW + 3 * 3600e3, closesAt: NOW + 5 * 3600e3 }), NOW).key, "upcoming");
  assert.equal(computeStatus(exam({ publishAt: NOW + 30 * 60e3, closesAt: NOW + 5 * 3600e3 }), NOW).key, "soon");
  const live = computeStatus(exam({ publishAt: NOW - 3600e3, closesAt: NOW + 3600e3 }), NOW);
  assert.deepEqual([live.key, live.canStart, live.cta], ["live", true, "start"]);
  assert.equal(computeStatus(exam({ publishAt: NOW - 7200e3, closesAt: NOW - 3600e3 }), NOW).key, "closed");
  assert.equal(computeStatus(exam({ publishAt: NOW - 7200e3, closesAt: NOW - 3600e3 }), NOW, { hasResult: true }).key, "completed");
  assert.equal(computeStatus(exam({ cancelled: true }), NOW).key, "unavailable");
  assert.equal(computeStatus(exam({ examType: "practice", publishAt: NOW + 9e9 }), NOW).key, "open");
  const exhausted = computeStatus(exam({ examType: "practice", maxAttempts: 2 }), NOW, { hasResult: true, attemptsUsed: 2 });
  assert.deepEqual([exhausted.key, exhausted.canStart, exhausted.reason], ["completed", false, "attempts"]);
  assert.equal(computeStatus(exam({}), NOW, { maintenance: true }).canStart, false);
  assert.equal(computeStatus(exam({ registration: "closed" }), NOW).reason, "registration-closed");
});

test("decorateAll + scheduleItems + filterExams work together on a student's list", () => {
  const exams = [
    exam({ id: "a", title: "Physics live", publishAt: NOW - 60e3, closesAt: NOW + 3600e3 }),
    exam({ id: "b", title: "Chem upcoming", publishAt: NOW + 2 * 86400e3, closesAt: NOW + 3 * 86400e3 }),
    exam({ id: "c", title: "Practice set", examType: "practice" }),
  ];
  const items = decorateAll(exams, NOW, { stats: { exams: { c: { n: 1, s: 5, t: 10, p: 50, at: NOW - 1000, ty: "practice", ti: "Practice set" } } } });
  assert.deepEqual(items.map((i) => i.status.key), ["live", "upcoming", "open"]);
  assert.equal(items[2].attemptsUsed, 1);
  assert.deepEqual(scheduleItems(items, NOW).map((i) => i.exam.id), ["a", "b"]);
  assert.deepEqual(filterExams(items, { status: "live" }, { now: NOW }).map((i) => i.exam.id), ["a"]);
  assert.deepEqual(filterExams(items, { q: "chem" }, { now: NOW }).map((i) => i.exam.id), ["b"]);
});

test("saved attempt: deadline is fixed, resume / expired verdicts follow the website's session core", () => {
  const questions = [{ id: "q1", text: "t", options: ["a", "b"], correctIndex: 0, explanation: "" }, { id: "q2", text: "t", options: ["a", "b"], correctIndex: 1, explanation: "" }];
  const s0 = Session.createSession({ uid: "u", examId: "e", attemptId: "att", now: NOW, durationSec: 600, exam: { id: "e", title: "T", duration: 10 }, questions });
  assert.equal(Session.secondsLeft(s0, NOW + 100e3), 500);
  const s1 = Session.updateProgress(s0, { answers: { q1: 0, bogus: 1 }, locked: ["q1", "zzz"], index: 1, times: { q1: 3.14159 }, now: NOW + 1000 });
  assert.deepEqual(s1.answers, { q1: 0 });
  assert.deepEqual(s1.locked, ["q1"]);
  assert.equal(Session.judge(s1, NOW + 100e3).state, "resume");
  assert.equal(Session.judge(s1, NOW + 700e3).state, "expired");
  assert.equal(Session.judge(s0, NOW + 700e3).state, "stale"); // nothing answered → nothing worth keeping
  const parsed = Session.parseSession(Session.serializeSession(s1), { uid: "u", examId: "e" });
  assert.equal(parsed.ok, true);
  const tampered = JSON.parse(Session.serializeSession(s1)); tampered.answers.q1 = 1;
  assert.equal(Session.parseSession(tampered).ok, false); // the integrity signature catches edits
  const submitted = Session.markSubmitted(s1, { now: NOW + 2000, leftSec: 590 });
  assert.equal(Session.judge(submitted, NOW + 5000).state, "unsaved");
});

test("admin roles map to the website's permissions", () => {
  assert.equal(normalizeRole("nonsense"), "viewer");
  assert.equal(roleCan("super", "anything.at.all"), true);
  assert.equal(roleCan("manager", "notices.manage"), true);
  assert.equal(roleCan("manager", "admins.manage"), false);
  assert.equal(roleCan("editor", "exams.delete"), false);
  assert.equal(roleCan("editor", "exams.write"), true);
  assert.equal(roleCan("viewer", "exams.write"), false);
});

import { routeFromSiteUrl } from "../src/core/links";
test("push links open the matching app screen", () => {
  assert.equal(routeFromSiteUrl("https://tvexam.vercel.app/#/results"), "/results");
  assert.equal(routeFromSiteUrl("#/exam?id=abc123"), "/exams/abc123");
  assert.equal(routeFromSiteUrl("#/exam?id=../../etc"), "/exams");
  assert.equal(routeFromSiteUrl("#/faq"), "/info/faq");
  assert.equal(routeFromSiteUrl("#/something-unknown"), "/home");
  assert.equal(routeFromSiteUrl(""), "/home");
  assert.equal(routeFromSiteUrl(undefined), "/home");
});

import { windowBlock, verifyStart, snapshotFromSession, saveWithRetries, startSession, isVisibleToStudent } from "../src/core/exam-flow";
const baseDeps = (o: any = {}) => ({ fetchExam: async () => o.exam ?? null, getSite: async () => o.site ?? { maintenance: false, message: "" }, academicGate: async () => o.gate ?? { allowed: true, reason: "free" }, attemptsUsed: async () => o.used ?? 0, now: () => NOW });
const who = (o: any = {}) => ({ uid: "u1", profile: { uid: "u1", ...(o.profile || {}) }, isAdmin: !!o.isAdmin });

test("start checks run in the website's order and say why an exam can't be started", async () => {
  const open = exam({ id: "e1", title: "Open", examType: "practice" });
  assert.equal((await verifyStart("e1", who(), baseDeps({ exam: open }))).ok, true);
  assert.equal((await verifyStart("e1", who({ profile: { disabled: true } }), baseDeps({ exam: open }))).ok, false);
  assert.equal((await verifyStart("e1", who({ isAdmin: true, profile: { disabled: true } }), baseDeps({ exam: open }))).ok, true);
  const m = await verifyStart("e1", who(), baseDeps({ exam: open, site: { maintenance: true, message: "Back soon" } }));
  assert.deepEqual([m.ok, (m as any).message], [false, "Back soon"]);
  assert.equal((await verifyStart("e1", who(), baseDeps({ exam: null }))).ok, false);
  assert.equal((await verifyStart("e1", who(), baseDeps({ exam: exam({ status: "draft" }) }))).ok, false);
  assert.equal((await verifyStart("e1", who(), baseDeps({ exam: exam({ courseId: "c9" }) }))).ok, false);
  assert.equal((await verifyStart("e1", who({ profile: { enrolledCourses: ["c9"] } }), baseDeps({ exam: exam({ courseId: "c9", examType: "practice" }) }))).ok, true);
  const paid = await verifyStart("e1", who(), baseDeps({ exam: exam({ academicSubjectId: "s1", examType: "practice" }), gate: { allowed: false, reason: "payment-required" } }));
  assert.match((paid as any).title, /Premium/);
  const upcoming = await verifyStart("e1", who(), baseDeps({ exam: exam({ publishAt: NOW + 3600e3, closesAt: NOW + 7200e3 }) }));
  assert.match((upcoming as any).title, /hasn't started/);
  const used = await verifyStart("e1", who(), baseDeps({ exam: exam({ examType: "practice", maxAttempts: 2 }), used: 2 }));
  assert.match((used as any).title, /No attempts/);
  const ok = await verifyStart("e1", who(), baseDeps({ exam: exam({ examType: "practice", maxAttempts: 3 }), used: 1 }));
  assert.deepEqual([ok.ok, (ok as any).attemptsSoFar], [true, 1]);
});

test("admins can test cancelled exams, students cannot", () => {
  const cancelled = exam({ cancelled: true });
  assert.ok(windowBlock(cancelled, false, NOW));
  assert.equal(windowBlock(cancelled, true, NOW), null);
  assert.equal(isVisibleToStudent(exam({}), null), true);
});

test("a finished attempt is rebuilt from the saved session with the same scoring", () => {
  const e = exam({ id: "e", title: "T", duration: 10, negativeMarking: 0.5, maxAttempts: 3, passPercent: 50 });
  const qs = [0, 1, 2, 3].map((i) => ({ id: `q${i + 1}`, text: `Q${i + 1}`, options: ["a", "b", "c"], correctIndex: i % 3, explanation: "" }));
  const s0 = startSession({ uid: "u", exam: e, questions: qs, attemptsSoFar: 1, now: NOW });
  const s1 = Session.updateProgress(s0, { answers: { q1: 0, q2: 0 }, locked: ["q1", "q2"], index: 1, times: { q1: 4, q2: 9 }, now: NOW + 5000 });
  const done = Session.markSubmitted(s1, { now: NOW + 100e3, leftSec: 500 });
  const snap = snapshotFromSession(done, { student: { name: "N", email: "e@x", roll: "0007" }, now: NOW + 100e3 });
  assert.deepEqual([snap.correctCount, snap.wrongCount, snap.unansweredCount, snap.score, snap.attemptNumber, snap.timeTakenSeconds, snap.passPercent, snap.maxAttempts], [1, 1, 2, 0.5, 2, 100, 50, 3]);
  const expired = snapshotFromSession(s1, { student: { name: "", email: "", roll: "" }, auto: true, now: NOW + 700e3 });
  assert.deepEqual([expired.auto, expired.timeTakenSeconds], [true, 600]);
});

test("saving retries on a flaky network, stops at once on a permanent refusal and never double-saves", async () => {
  const snap: any = { uid: "u", examId: "e", examTitle: "T", examType: "live", score: 1, total: 1, percent: 100, correctCount: 1, wrongCount: 0, unansweredCount: 0, negativeMarking: 0, timeTakenSeconds: 1, answers: {}, attemptId: "a1", maxAttempts: 0, review: [] };
  let calls = 0;
  assert.equal(await saveWithRetries(snap, async () => { calls++; if (calls < 2) throw new Error("offline"); }), "saved");
  assert.equal(calls, 2);
  let denied = 0;
  assert.equal(await saveWithRetries(snap, async () => { denied++; throw Object.assign(new Error("x"), { code: "attempts-exhausted" }); }), "blocked");
  assert.equal(denied, 1);
});

import { DOCS, faqSearch, faqCategories, whatsNew, html } from "../src/core/content";
test("website text is reshaped for the phone without losing anything", () => {
  for (const [id, d] of Object.entries(DOCS)) {
    const doc = d.build();
    assert.ok(doc.title, id);
    assert.ok(doc.sections.length >= 3, `${id} has sections`);
    for (const s of doc.sections) assert.ok(s.blocks.length > 0, `${id}/${s.id} has content`);
  }
  assert.ok(DOCS.privacy.build().sections.length >= 15);
  assert.ok(DOCS.terms.build().sections.some((s) => s.blocks.some((b) => b.t === "table" || b.t === "dl" || b.t === "ul")));
  assert.equal(html("<img src=x onerror=1> **ok**"), "&lt;img src=x onerror=1&gt; <strong>ok</strong>");
  assert.match(html("{name}"), /Tech Verse Exam/);
  assert.ok(faqCategories().length >= 5);
  assert.ok(faqSearch("").length > 40);
  assert.ok(faqSearch("reset password").length > 0);
  assert.ok(faqSearch("zzzqqqxxx").length === 0);
  assert.ok(whatsNew().items.length > 0);
});
