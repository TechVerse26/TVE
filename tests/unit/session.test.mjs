// Unit tests for js/exam-session-core.js (the pure side of "resume my exam"). Run:  node --test tests/unit
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../js/exam-session-core.js";

const T0 = Date.UTC(2026, 9, 6, 4, 0, 0);
const Q = (id, correct = 0) => ({ id, text: `প্রশ্ন ${id}`, options: ["ক", "খ", "গ", "ঘ"], correctIndex: correct, explanation: "ব্যাখ্যা", order: 9 });
const EXAM = { id: "e1", title: "মডেল টেস্ট", examType: "live", duration: 10, negativeMarking: 0.25, maxAttempts: 2, layout: "one", closesAt: { toMillis: () => 5, seconds: 5 }, junk: () => 1 };
const make = (o = {}) => C.createSession({ uid: "u1", examId: "e1", attemptId: "a1", now: T0, durationSec: 600, attemptsSoFar: 1, layout: "one", exam: EXAM, questions: [Q("q1"), Q("q2", 2), Q("q3", 1)], ...o });
const roundTrip = (s) => JSON.parse(JSON.stringify(s));

test("stableStringify: key order does not matter, undefined is dropped, NaN becomes null", () => {
  assert.equal(C.stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] }), C.stableStringify({ a: [2, { c: undefined, d: 1 }], b: 1 }));
  assert.equal(C.stableStringify({ a: undefined, b: NaN }), '{"b":null}');
});

test("hash32: stable, 8 hex digits, sensitive to a one-character change", () => {
  assert.equal(C.hash32("abc"), C.hash32("abc"));
  assert.match(C.hash32("abc"), /^[0-9a-f]{8}$/);
  assert.notEqual(C.hash32("abc"), C.hash32("abd"));
  assert.equal(C.hash32(""), "811c9dc5");
});

test("pickExam keeps plain fields only (no Timestamp, no function, no unknown field)", () => {
  const e = C.pickExam(EXAM);
  assert.deepEqual(Object.keys(e).sort(), ["duration", "examType", "id", "layout", "maxAttempts", "negativeMarking", "title"]);
  assert.deepEqual(C.pickExam(null), {});
});

test("pickQuestions normalises shape and drops extras", () => {
  const [q] = C.pickQuestions([{ ...Q("q1", 3), junk: 1 }]);
  assert.deepEqual(Object.keys(q).sort(), ["correctIndex", "explanation", "id", "options", "text"]);
  assert.equal(C.pickQuestions(undefined).length, 0);
});

test("createSession: deadline = start + duration, empty progress, sealed, survives a JSON round trip", () => {
  const s = make();
  assert.equal(s.deadline, T0 + 600000);
  assert.equal(s.phase, "active");
  assert.deepEqual(s.answers, {});
  assert.equal(s.attemptId, "a1");
  const back = C.parseSession(JSON.stringify(s), { uid: "u1", examId: "e1" });
  assert.equal(back.ok, true);
  assert.deepEqual(back.session, s);
});

test("updateProgress is pure and keeps only restorable data", () => {
  const s = make();
  const frozen = JSON.stringify(s);
  const u = C.updateProgress(s, {
    answers: { q1: 2, q2: 9, nope: 0, q3: -1 }, locked: ["q1", "ghost"], index: 99, times: { q1: 12.34, q2: -1, q3: NaN }, now: T0 + 5000,
  });
  assert.equal(JSON.stringify(s), frozen, "input untouched");
  assert.deepEqual(u.answers, { q1: 2 });
  assert.deepEqual(u.locked, ["q1"]);
  assert.equal(u.index, 2);
  assert.deepEqual(u.times, { q1: 12.3 });
  assert.equal(u.savedAt, T0 + 5000);
  assert.equal(C.parseSession(JSON.stringify(u)).ok, true);
});

test("secondsLeft: counts down against the deadline, never negative, never above the duration", () => {
  const s = make();
  assert.equal(C.secondsLeft(s, T0), 600);
  assert.equal(C.secondsLeft(s, T0 + 1), 600);        // 599.999 s → 600 (rounds up, like the live timer)
  assert.equal(C.secondsLeft(s, T0 + 90000), 510);
  assert.equal(C.secondsLeft(s, T0 + 600000), 0);
  assert.equal(C.secondsLeft(s, T0 + 9e9), 0);
  assert.equal(C.secondsLeft(s, T0 - 3600000), 600);  // device clock jumped back → still only the exam's own duration
});

test("a deadline pushed past start + duration is clamped back", () => {
  const s = { ...make(), deadline: T0 + 99 * 3600000 };
  assert.equal(C.hardDeadline(s), T0 + 600000);
  assert.equal(C.secondsLeft(s, T0 + 300000), 300);
});

test("judge: resume → expired → stale, and 'expired with no answers' is stale", () => {
  let s = make();
  assert.deepEqual(C.judge(s, T0 + 60000), { state: "resume", left: 540, answered: 0, total: 3 });
  assert.equal(C.judge(s, T0 + 700000).state, "stale", "nothing answered → not worth submitting");
  s = C.updateProgress(s, { answers: { q1: 0, q2: 1 }, locked: ["q1", "q2"], index: 1, times: {}, now: T0 + 1000 });
  assert.deepEqual(C.judge(s, T0 + 700000), { state: "expired", left: 0, answered: 2, total: 3 });
  assert.equal(C.judge(s, T0 + 600000 + C.EXPIRED_KEEP_MS + 1).state, "stale");
});

test("markSubmitted → 'unsaved' until it is old; second call changes nothing; leftSec is clamped", () => {
  let s = C.updateProgress(make(), { answers: { q1: 1 }, locked: ["q1"], index: 0, times: {}, now: T0 + 10 });
  const sub = C.markSubmitted(s, { now: T0 + 20000, leftSec: 9999, auto: true });
  assert.equal(sub.phase, "submitted");
  assert.equal(sub.leftAtSubmit, 600);
  assert.equal(sub.auto, true);
  assert.equal(C.markSubmitted(sub, { now: T0 + 99999, leftSec: 1 }), sub);
  assert.equal(C.judge(sub, T0 + 5 * C.MINUTE).state, "unsaved");
  assert.equal(C.judge(sub, T0 + 20000 + C.SUBMITTED_KEEP_MS + 1).state, "stale");
  assert.equal(C.parseSession(JSON.stringify(sub)).ok, true);
});

test("parseSession reasons: empty, json, version, shape, sig, owner", () => {
  const s = make();
  assert.equal(C.parseSession(null).reason, "empty");
  assert.equal(C.parseSession("").reason, "empty");
  assert.equal(C.parseSession("{oops").reason, "json");
  assert.equal(C.parseSession(JSON.stringify({ ...s, v: 2 })).reason, "version");
  assert.equal(C.parseSession(JSON.stringify({ ...s, questions: [] })).reason, "shape");
  assert.equal(C.parseSession(JSON.stringify({ ...s, index: 7 })).reason, "shape");
  assert.equal(C.parseSession(JSON.stringify({ ...s, answers: [] })).reason, "shape");
  assert.equal(C.parseSession("[]").reason, "shape");
  assert.equal(C.parseSession(JSON.stringify({ ...s, durationSec: 601 })).reason, "sig", "edited without re-sealing");
  assert.equal(C.parseSession(JSON.stringify(s), { uid: "someone-else" }).reason, "owner");
  assert.equal(C.parseSession(JSON.stringify(s), { examId: "e2" }).reason, "owner");
  assert.equal(C.parseSession(JSON.stringify(s), { uid: "u1", examId: "e1" }).ok, true);
});

test("a question whose answer key points outside its options is rejected, not restored", () => {
  const bad = { ...make(), questions: [{ ...Q("q1"), correctIndex: 4 }] };
  assert.equal(C.parseSession(JSON.stringify(bad)).ok, false);
});

test("a half-written file (cut JSON) is 'json', never an exception", () => {
  const text = JSON.stringify(make());
  assert.equal(C.parseSession(text.slice(0, text.length - 40)).reason, "json");
});

test("toRestorePlan: copies, valid answers only, live time vs time at submit", () => {
  let s = C.updateProgress(make(), { answers: { q1: 3, q3: 0 }, locked: ["q1", "q3"], index: 2, times: { q1: 4 }, now: T0 + 1 });
  const plan = C.toRestorePlan(s, T0 + 100000);
  assert.equal(plan.secondsLeft, 500);
  assert.equal(plan.index, 2);
  assert.deepEqual(plan.answers, { q1: 3, q3: 0 });
  assert.deepEqual(plan.locked, ["q1", "q3"]);
  assert.equal(plan.attemptId, "a1");
  assert.equal(plan.attemptsSoFar, 1);
  assert.equal(plan.exam.title, "মডেল টেস্ট");
  plan.questions[0].options[0] = "CHANGED"; plan.answers.q1 = 0;
  assert.equal(s.questions[0].options[0], "ক", "restored copy is independent of the saved object");
  assert.equal(s.answers.q1, 3);
  const sub = C.markSubmitted(s, { now: T0 + 200000, leftSec: 123 });
  assert.equal(C.toRestorePlan(sub, T0 + 9e9).secondsLeft, 123, "a submitted attempt keeps the time it had left, whatever the clock says now");
});

test("describe + clockLabel", () => {
  const s = C.updateProgress(make(), { answers: { q1: 0 }, locked: ["q1"], index: 0, times: {}, now: T0 });
  assert.deepEqual(C.describe(s, T0 + 36000), { examId: "e1", title: "মডেল টেস্ট", state: "resume", left: 564, answered: 1, total: 3 });
  assert.equal(C.clockLabel(504), "08:24");
  assert.equal(C.clockLabel(3725), "1:02:05");
  assert.equal(C.clockLabel(-4), "00:00");
  assert.equal(C.clockLabel("x"), "00:00");
});

test("pickUrgent: a running exam beats an unsaved one beats an expired one; soonest deadline first", () => {
  const mk = (state, left, savedAt) => ({ session: { savedAt }, verdict: { state, left } });
  const a = mk("expired", 0, 50), b = mk("unsaved", 0, 40), c = mk("resume", 300, 10), d = mk("resume", 120, 5), e = mk("stale", 0, 99);
  assert.equal(C.pickUrgent([a, b, c, d, e]), d);
  assert.equal(C.pickUrgent([a, b, e]), b);
  assert.equal(C.pickUrgent([a, e]), a);
  assert.equal(C.pickUrgent([e]), null);
  assert.equal(C.pickUrgent([]), null);
  assert.equal(C.pickUrgent(undefined), null);
});

test("storage keys round-trip, and foreign keys are ignored", () => {
  assert.equal(C.sessionKey("u1", "e1"), "tvexam:s1:u1:e1");
  assert.deepEqual(C.parseSessionKey("tvexam:s1:u1:e1"), { uid: "u1", examId: "e1" });
  assert.deepEqual(C.parseSessionKey("tvexam:s1:u1:e:with:colons"), { uid: "u1", examId: "e:with:colons" });
  assert.equal(C.parseSessionKey("tvexam:s1lock:u1:e1"), null);
  assert.equal(C.parseSessionKey("tvexam:s1:u1"), null);
  assert.equal(C.parseSessionKey("tvexam:s1::e1"), null);
  assert.equal(C.parseSessionKey(null), null);
});

test("tab lock: free / mine / other, and a quiet tab loses the lock", () => {
  const lock = C.makeLock("tabA", T0);
  assert.equal(C.lockStatus(null, "tabA", T0), "free");
  assert.equal(C.lockStatus(lock, "tabA", T0 + 99999), "mine");
  assert.equal(C.lockStatus(lock, "tabB", T0 + C.LOCK_FRESH_MS - 1), "other");
  assert.equal(C.lockStatus(lock, "tabB", T0 + C.LOCK_FRESH_MS), "free");
  assert.deepEqual(C.parseLock(JSON.stringify(lock)), lock);
  assert.equal(C.parseLock("{bad"), null);
  assert.equal(C.parseLock('{"tab":1}'), null);
});

test("serializeSession refuses anything too big for localStorage", () => {
  const s = make();
  assert.equal(typeof C.serializeSession(s), "string");
  const huge = { ...s, questions: [{ ...s.questions[0], text: "x".repeat(C.MAX_CHARS) }] };
  assert.equal(C.serializeSession(huge), null);
});

test("a realistic 100-question pool stays far below the storage limit", () => {
  const qs = Array.from({ length: 100 }, (_, i) => ({ ...Q(`q${i + 1}`), text: "প্রশ্নের একটি লম্বা বাক্য ".repeat(8), explanation: "ব্যাখ্যা ".repeat(40) }));
  const json = C.serializeSession(make({ questions: qs }));
  assert.ok(json && json.length < 150000, `size ${json?.length}`);
});

test("round trip keeps every field byte-for-byte (so the checksum stays valid)", () => {
  let s = C.updateProgress(make(), { answers: { q2: 1 }, locked: ["q2"], index: 1, times: { q2: 7.5 }, now: T0 + 4 });
  s = C.markSubmitted(s, { now: T0 + 9, leftSec: 12.9 });
  assert.deepEqual(roundTrip(s), s);
  assert.equal(C.parseSession(JSON.stringify(s)).ok, true);
});
