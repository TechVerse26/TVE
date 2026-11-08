// Admin "Push Notifications" page — the pure rules (js/push/push-admin-core.js).
//   node --no-warnings --test tests/unit/push-admin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = await import("../../js/push/push-admin-core.js");
const C = await import("../../js/push/push-core.js");
const V = require("../../server/push/validate.js");
const serverConfig = require("../../server/push/config.js");

const NOW = Date.UTC(2026, 10, 6, 4, 0, 0);
const MIN = 60000;
const DAY = 86400000;
const form = (over = {}) => ({ ...A.emptyForm(), title: "Exam tonight", body: "Starts at 8 PM", ...over });

/* ---------- destinations ---------- */
test("destinationFor: only pages of this site", () => {
  assert.deepEqual(A.destinationFor(form()), { ok: true, value: "#/home" });
  assert.deepEqual(A.destinationFor(form({ destPage: "#/results" })), { ok: true, value: "#/results" });
  assert.deepEqual(A.destinationFor(form({ destMode: "exam", destExamId: "Ab12_x-9" })), { ok: true, value: "#/exams?open=Ab12_x-9" });
  assert.equal(A.destinationFor(form({ destMode: "exam", destExamId: "" })).ok, false);
  assert.equal(A.destinationFor(form({ destMode: "exam", destExamId: "a b" })).ok, false);
  assert.equal(A.destinationFor(form({ destMode: "exam", destExamId: "x?y=1&z" })).ok, false);
  assert.deepEqual(A.destinationFor(form({ destMode: "custom", destCustom: "" })), { ok: true, value: "#/home" });
  assert.deepEqual(A.destinationFor(form({ destMode: "custom", destCustom: " #/exams?open=abc " })), { ok: true, value: "#/exams?open=abc" });
  for (const bad of ["https://evil.example/", "//evil.example", "javascript:alert(1)", "#/admin", "#/login", "results", "#/exam?id=<x>"]) {
    const r = A.destinationFor(form({ destMode: "custom", destCustom: bad }));
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /other websites/);
  }
  assert.equal(A.destinationFor(form({ destPage: "https://evil.example" })).ok, false);
});

test("every destination the admin can pick is accepted by the server too", () => {
  for (const [value] of A.PAGES) {
    assert.equal(A.destinationFor(form({ destPage: value })).value, value);
    const r = V.normalizeDestination(value, "https://tvexam.vercel.app");
    assert.equal(r.ok, true, value);
    assert.equal(r.value, value);
  }
  const exam = A.destinationFor(form({ destMode: "exam", destExamId: "exam_2026-01" })).value;
  assert.equal(V.normalizeDestination(exam, "https://tvexam.vercel.app").ok, true);
  for (const [value] of A.PAGES) assert.ok(serverConfig.SITE_ROUTES.includes(value.slice(2)), value);
});

/* ---------- audience ---------- */
test("audienceFromForm / audienceProblem: the five audiences, each complete or not", () => {
  assert.deepEqual(A.audienceFromForm(form()), { type: "all" });
  assert.equal(A.audienceProblem(form()), "");
  assert.deepEqual(A.audienceFromForm(form({ audienceType: "user", userId: "u1" })), { type: "user", uid: "u1" });
  assert.equal(A.audienceProblem(form({ audienceType: "user" })), "Pick a student.");
  assert.deepEqual(A.audienceFromForm(form({ audienceType: "exam", examId: "e1", examFilter: "not_submitted" })), { type: "exam", examId: "e1", filter: "not_submitted" });
  assert.deepEqual(A.audienceFromForm(form({ audienceType: "exam", examId: "e1", examFilter: "weird" })), { type: "exam", examId: "e1", filter: "all" });
  assert.equal(A.audienceProblem(form({ audienceType: "exam" })), "Pick an exam.");
  assert.deepEqual(A.audienceFromForm(form({ audienceType: "section", sectionId: "s1" })), { type: "section", sectionId: "s1" });
  assert.equal(A.audienceProblem(form({ audienceType: "section" })), "Pick a program.");
  assert.deepEqual(A.audienceFromForm(form({ audienceType: "level", levelId: "l1" })), { type: "level", levelId: "l1" });
  assert.equal(A.audienceProblem(form({ audienceType: "level", levelId: "bad id" })), "Pick a level.");
  assert.ok(A.audienceProblem(form({ audienceType: "mystery" })));
});

test("every audience the form can build is accepted by the server's validator", () => {
  for (const f of [form(), form({ audienceType: "user", userId: "u1" }), form({ audienceType: "exam", examId: "e1", examFilter: "submitted" }),
    form({ audienceType: "section", sectionId: "s1" }), form({ audienceType: "level", levelId: "l1" })]) {
    assert.doesNotThrow(() => V.validateAudience(A.audienceFromForm(f)), f.audienceType);
  }
});

/* ---------- validation ---------- */
test("validateForm: a complete form passes", () => {
  const r = A.validateForm(form(), { now: NOW });
  assert.deepEqual(r, { ok: true, errors: {}, warnings: [] });
});

test("validateForm: title and message — required, and counted like the server counts", () => {
  assert.equal(A.validateForm(form({ title: "  " }), { now: NOW }).errors.title, "Write a title.");
  assert.equal(A.validateForm(form({ body: "" }), { now: NOW }).errors.body, "Write the message.");
  assert.equal(A.validateForm(form({ title: "x".repeat(65) }), { now: NOW }).ok, true);
  assert.match(A.validateForm(form({ title: "x".repeat(66) }), { now: NOW }).errors.title, /66 \/ 65/);
  assert.match(A.validateForm(form({ body: "y".repeat(241) }), { now: NOW }).errors.body, /241 \/ 240/);
  // Bengali: every letter and sign is one unit, exactly like the server
  const bn = "পরীক্ষা শুরু হচ্ছে";
  assert.equal(A.cpLen(bn), Array.from(bn).length);
  assert.equal(A.cpLen("😀"), 1);
  assert.equal(A.cpLen(null), 0);
  // the limits can come from the server
  assert.equal(A.validateForm(form({ title: "x".repeat(40) }), { now: NOW, limits: { ...A.DEFAULT_LIMITS, titleMax: 30 } }).ok, false);
});

test("validateForm: the client's limits equal the server's (so the screen never promises what the server refuses)", () => {
  const L = serverConfig.readConfig({ FIREBASE_SERVICE_ACCOUNT: "{}" }).limits;
  assert.equal(A.DEFAULT_LIMITS.titleMax, L.titleMax);
  assert.equal(A.DEFAULT_LIMITS.bodyMax, L.bodyMax);
  assert.equal(A.DEFAULT_LIMITS.imageMaxBytes, L.imageMaxBytes);
  assert.equal(A.DEFAULT_LIMITS.thumbMaxBytes, L.thumbMaxBytes);
  assert.equal(A.DEFAULT_LIMITS.maxScheduleDays, L.maxScheduleDays);
  assert.equal(A.DEFAULT_LIMITS.maxImages, L.maxImages);
  assert.equal(A.DEFAULT_LIMITS.imageUrlMax, L.imageUrlMax);
});

test("validateForm: a picture link longer than the server accepts is refused here first", () => {
  const long = `https://img.example/${"a".repeat(490)}.png`;
  assert.ok(A.validateForm(form({ image: { url: long } }), { now: NOW }).errors.image);
  assert.ok(A.validateForm(form({ icon: { url: long } }), { now: NOW }).errors.icon);
  assert.equal(A.validateForm(form({ image: { url: `https://img.example/${"a".repeat(400)}.png` } }), { now: NOW }).ok, true);
});

test("validateForm: scheduling — at least a minute ahead, at most the server's horizon, warns without a timer", () => {
  const later = (ms) => form({ delivery: "later", scheduleLocal: A.toLocalInputValue(ms) });
  assert.equal(A.validateForm(form({ delivery: "later", scheduleLocal: "" }), { now: NOW }).errors.schedule, "Pick the date and time to send it.");
  assert.match(A.validateForm(later(NOW - 5 * MIN), { now: NOW }).errors.schedule, /one minute/);
  assert.match(A.validateForm(later(NOW + 30000), { now: NOW }).errors.schedule, /one minute/);
  assert.equal(A.validateForm(later(NOW + 10 * MIN), { now: NOW }).ok, true);
  assert.match(A.validateForm(later(NOW + 400 * DAY), { now: NOW }).errors.schedule, /366 days/);
  const noTimer = A.validateForm(later(NOW + 10 * MIN), { now: NOW, cronConfigured: false });
  assert.equal(noTimer.ok, true);
  assert.equal(noTimer.warnings.length, 1);
  assert.match(noTimer.warnings[0], /page open/);
  assert.deepEqual(A.validateForm(form(), { now: NOW, cronConfigured: false }).warnings, [], "no warning for a send-now");
});

test("validateForm: pictures must be https; a bad destination or audience blocks sending", () => {
  assert.equal(A.validateForm(form({ image: { url: "https://img.example/a.jpg" } }), { now: NOW }).ok, true);
  assert.ok(A.validateForm(form({ image: { url: "http://img.example/a.jpg" } }), { now: NOW }).errors.image);
  assert.ok(A.validateForm(form({ icon: { url: "javascript:alert(1)" } }), { now: NOW }).errors.icon);
  assert.ok(A.validateForm(form({ destMode: "custom", destCustom: "https://evil.example" }), { now: NOW }).errors.url);
  assert.ok(A.validateForm(form({ audienceType: "user" }), { now: NOW }).errors.audience);
  assert.ok(A.validateForm(form({ category: "weird" }), { now: NOW }).errors.category);
  const many = A.validateForm(form({ title: "", body: "", audienceType: "exam" }), { now: NOW });
  assert.deepEqual(Object.keys(many.errors).sort(), ["audience", "body", "title"]);
});

test("whatever validateForm accepts, the server's validateCompose accepts too (same rules, same result)", () => {
  const cfg = serverConfig.readConfig({ FIREBASE_SERVICE_ACCOUNT: "{}", SITE_URL: "https://tvexam.vercel.app" });
  const cases = [
    form(),
    form({ title: "ফলাফল প্রকাশিত হয়েছে", body: "আপনার ফলাফল এখন দেখা যাবে।", category: "result", destPage: "#/results" }),
    form({ category: "exam", destMode: "exam", destExamId: "exam_1", audienceType: "exam", examId: "exam_1", examFilter: "not_submitted", image: { url: "https://img.example/p.png" }, icon: { url: "https://img.example/i.png" } }),
    form({ audienceType: "user", userId: "uid_42", delivery: "later", scheduleLocal: A.toLocalInputValue(NOW + 2 * 3600000) }),
    form({ audienceType: "section", sectionId: "sec_1", destMode: "custom", destCustom: "#/exams?open=abc" }),
    form({ audienceType: "level", levelId: "lvl_1", title: "x".repeat(65), body: "y".repeat(240) }),
  ];
  for (const f of cases) {
    const v = A.validateForm(f, { now: NOW });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const payload = A.buildPayload(f, A.newRequestId());
    const c = V.validateCompose(payload, { now: NOW, cfg });
    assert.equal(c.title, payload.title);
    assert.equal(c.body, payload.body);
    assert.equal(c.url, payload.url);
    assert.equal(c.category, payload.category);
    assert.deepEqual(c.audience, payload.audience);
    assert.equal(c.scheduleAt, payload.scheduleAt);
    assert.equal(c.image, payload.image);
    assert.equal(c.icon, payload.icon);
  }
});

test("…and whatever validateForm refuses, the server refuses too", () => {
  const cfg = serverConfig.readConfig({ FIREBASE_SERVICE_ACCOUNT: "{}", SITE_URL: "https://tvexam.vercel.app" });
  const bad = [
    form({ title: "" }), form({ body: " " }), form({ title: "x".repeat(66) }), form({ body: "y".repeat(241) }),
    form({ destMode: "custom", destCustom: "https://evil.example" }), form({ image: { url: "http://x.example/a.png" } }),
    form({ delivery: "later", scheduleLocal: A.toLocalInputValue(NOW + 10000) }),
  ];
  for (const f of bad) {
    assert.equal(A.validateForm(f, { now: NOW }).ok, false);
    const payload = { ...A.buildPayload(f, A.newRequestId()) };
    if (payload.url === undefined) payload.url = "https://evil.example";
    assert.throws(() => V.validateCompose(payload, { now: NOW, cfg }), (e) => e.status === 400, JSON.stringify(f).slice(0, 60));
  }
});

/* ---------- request ids ---------- */
test("newRequestId: unique and accepted by the server; fingerprint ignores the id", () => {
  const a = A.newRequestId();
  const b = A.newRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^req_[A-Za-z0-9_-]{24}$/);
  assert.match(A.newRequestId(null), /^req_[A-Za-z0-9_-]{24}$/);
  assert.equal(V.REQUEST_ID_RE.test(a), true);
  const p1 = A.buildPayload(form(), a);
  const p2 = A.buildPayload(form(), b);
  assert.equal(A.fingerprint(p1), A.fingerprint(p2));
  assert.notEqual(A.fingerprint(p1), A.fingerprint(A.buildPayload(form({ title: "Other" }), a)));
  assert.notEqual(A.fingerprint(p1), A.fingerprint(A.buildPayload(form({ audienceType: "user", userId: "u1" }), a)));
});

test("formFromJob: text, kind, destination and pictures come back — audience and time do not", () => {
  const f = A.formFromJob({ title: "T", body: "B", category: "result", url: "#/results", image: "https://i.example/p.jpg", icon: "https://i.example/i.png", audience: { type: "user", uid: "u1" }, scheduledAt: 123 });
  assert.equal(f.title, "T");
  assert.equal(f.body, "B");
  assert.equal(f.category, "result");
  assert.deepEqual([f.destMode, f.destPage], ["page", "#/results"]);
  assert.deepEqual(f.image, { url: "https://i.example/p.jpg" });
  assert.deepEqual(f.icon, { url: "https://i.example/i.png" });
  assert.deepEqual([f.audienceType, f.userId, f.delivery, f.scheduleLocal], ["all", "", "now", ""]);
  const e = A.formFromJob({ title: "T", body: "B", category: "exam", url: "#/exams?open=exam_1" });
  assert.deepEqual([e.destMode, e.destExamId], ["exam", "exam_1"]);
  const c = A.formFromJob({ title: "T", body: "B", url: "#/exam?id=abc" });
  assert.deepEqual([c.destMode, c.destCustom], ["custom", "#/exam?id=abc"]);
  assert.equal(c.category, "announcement");
  const bad = A.formFromJob({ title: "T", body: "B", category: "nonsense", url: "https://evil.example/" });
  assert.deepEqual([bad.category, bad.destMode, bad.destPage], ["announcement", "page", "#/home"], "an unknown kind or a foreign link falls back to safe defaults");
  assert.deepEqual(A.formFromJob(null), A.emptyForm());
  // whatever comes back is a form the validator accepts (given an audience)
  assert.equal(A.validateForm(A.formFromJob({ title: "T", body: "B", url: "#/exams?open=exam_1" }), { now: NOW }).ok, true);
});

test("requestSlot: same content keeps its id (a retry is the same request); other content, or the test slot, never shares one", () => {
  let n = 0;
  const make = () => `id${++n}`;
  const p1 = A.buildPayload(form(), "");
  const a = A.requestSlot(null, p1, make);
  assert.equal(a.id, "id1");
  assert.equal(A.requestSlot(a, A.buildPayload(form(), ""), make), a, "identical content → the very same slot");
  const b = A.requestSlot(a, A.buildPayload(form({ title: "Different" }), ""), make);
  assert.notEqual(b, a);
  assert.equal(b.id, "id2");
  assert.equal(A.requestSlot(null, p1, make).id, "id3", "an empty slot (after a definite answer) starts a new request");
});

test("schedule helpers: local time round-trips; the default suggestion is about an hour ahead", () => {
  const ms = new Date(2026, 10, 7, 9, 30).getTime();
  assert.equal(A.toLocalInputValue(ms), "2026-11-07T09:30");
  assert.equal(A.scheduleMs("2026-11-07T09:30"), ms);
  assert.ok(Number.isNaN(A.scheduleMs("")));
  assert.ok(Number.isNaN(A.scheduleMs("garbage")));
  assert.ok(Number.isNaN(A.scheduleMs(undefined)));
  const suggested = A.scheduleMs(A.defaultSchedule(NOW));
  assert.ok(suggested >= NOW + 60 * MIN && suggested <= NOW + 66 * MIN, `suggested ${(suggested - NOW) / MIN} min ahead`);
  assert.equal(new Date(suggested).getMinutes() % 5, 0);
});

/* ---------- reach and the confirmation ---------- */
test("reachInfo: devices, never 'delivered'", () => {
  assert.equal(A.reachInfo(null), null);
  const none = A.reachInfo({ devices: 0, students: 3, optedOut: null });
  assert.equal(none.tone, "bad");
  assert.match(none.headline, /nobody would receive/i);
  const some = A.reachInfo({ devices: 128, students: 90, optedOut: 4 });
  assert.equal(some.tone, "ok");
  assert.equal(some.headline, "About 128 devices will receive it");
  assert.match(some.detail, /90 students in this audience/);
  assert.match(some.detail, /4 devices switched this kind off/);
  assert.equal(A.reachInfo({ devices: 1, students: 1, optedOut: null }).headline, "About 1 device will receive it");
  assert.match(A.reachInfo({ devices: 5, students: null, optedOut: null }).detail, /turned notifications on/);
  for (const r of [none, some]) assert.doesNotMatch(JSON.stringify(r), /delivered/i);
});

test("confirmMessage: says what, to whom, when — and that it cannot be taken back", () => {
  const p = A.buildPayload(form(), A.newRequestId());
  const m = A.confirmMessage(p, A.reachInfo({ devices: 12, students: null, optedOut: null }), "All subscribed students");
  assert.match(m, /Exam tonight/);
  assert.match(m, /about 12 devices/);
  assert.match(m, /All subscribed students/);
  assert.match(m, /send it now/);
  assert.match(m, /cannot be taken back/);
  const s = A.confirmMessage({ ...p, scheduleAt: NOW + DAY }, null, "");
  assert.match(s, /schedule it for/);
  assert.match(s, /selected audience/);
});

/* ---------- history ---------- */
const job = (over = {}) => ({ id: "j1", title: "Exam tonight", body: "8 PM", audienceLabel: "All subscribed students", status: "completed", test: false, createdAt: NOW - DAY, scheduledAt: null, startedAt: null, finishedAt: NOW - DAY + 5000, createdBy: { name: "Imran" }, counts: { targeted: 10, accepted: 9, failed: 1, invalid: 0, skipped: 0 }, errors: {}, ...over });

test("statusMeta / statusGroup: every server status has a label, and 'sent with errors' counts as sent", () => {
  for (const s of ["scheduled", "sending", "completed", "completed_with_errors", "failed", "cancelled"]) {
    const m = A.statusMeta(s);
    assert.ok(m.label && m.icon, s);
    assert.ok(["", "teal", "amber", "coral", "accent"].includes(m.tone), s);
  }
  assert.equal(A.statusMeta("nonsense").label, "nonsense");
  assert.equal(A.statusGroup("completed_with_errors"), "completed");
  assert.equal(A.statusGroup("failed"), "failed");
  for (const g of A.GROUPS) assert.equal(typeof g[1], "string");
});

test("the statuses the page knows are exactly the statuses the server can write", () => {
  const src = require("node:fs").readFileSync(new URL("../../server/push/engine.js", import.meta.url), "utf8") + require("node:fs").readFileSync(new URL("../../server/push/store.js", import.meta.url), "utf8");
  const used = new Set([...src.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]).filter((s) => !["active", "inactive", "invalid", "unsubscribed"].includes(s)));
  for (const s of used) assert.ok(A.STATUS[s], `the page has no label for server status "${s}"`);
});

test("filterJobs: status group, search (title / text / audience / admin), tests hidden unless asked", () => {
  const items = [
    job({ id: "a", title: "Result published", audienceLabel: "Exam: Physics" }),
    job({ id: "b", status: "scheduled", scheduledAt: NOW + DAY, title: "Reminder" }),
    job({ id: "c", status: "failed", title: "Broken" }),
    job({ id: "d", status: "completed_with_errors", title: "Partly" }),
    job({ id: "e", status: "cancelled", title: "Nope", createdBy: { name: "Rafi" } }),
    job({ id: "t", test: true, title: "Test one" }),
  ];
  const ids = (o) => A.filterJobs(items, o).map((j) => j.id);
  assert.deepEqual(ids({}), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids({ showTests: true }), ["a", "b", "c", "d", "e", "t"]);
  assert.deepEqual(ids({ group: "scheduled" }), ["b"]);
  assert.deepEqual(ids({ group: "completed" }), ["a", "d"]);
  assert.deepEqual(ids({ group: "failed" }), ["c"]);
  assert.deepEqual(ids({ q: "physics" }), ["a"]);
  assert.deepEqual(ids({ q: "  RAFI " }), ["e"]);
  assert.deepEqual(ids({ q: "zzz" }), []);
  assert.deepEqual(ids({ group: "completed", q: "part" }), ["d"]);
  assert.deepEqual(A.filterJobs(null, {}), []);
  assert.deepEqual(A.groupCounts(items), { all: 5, scheduled: 1, sending: 0, completed: 2, failed: 1, cancelled: 1 });
  assert.equal(A.groupCounts(items, true).all, 6);
});

test("jobWhen: the time that matters for each status", () => {
  assert.deepEqual(A.jobWhen(job({ status: "scheduled", scheduledAt: NOW + 5 })), { label: "Scheduled for", at: NOW + 5 });
  assert.deepEqual(A.jobWhen(job({ status: "sending", startedAt: NOW - 9 })), { label: "Started", at: NOW - 9 });
  assert.deepEqual(A.jobWhen(job({ status: "cancelled", cancelledAt: NOW - 3 })), { label: "Cancelled", at: NOW - 3 });
  assert.deepEqual(A.jobWhen(job({ status: "completed", finishedAt: NOW - 7 })), { label: "Finished", at: NOW - 7 });
  assert.equal(A.jobWhen(job({ status: "completed", finishedAt: null })).at, NOW - DAY);
});

test("timer logic: nothing active → no timer; sending → poll; scheduled → look again when due", () => {
  assert.equal(A.nextCheckDelay([], NOW), null);
  assert.equal(A.nextCheckDelay([job()], NOW), null);
  assert.equal(A.nextCheckDelay([job({ status: "sending" })], NOW), 15000);
  assert.equal(A.nextCheckDelay([job({ status: "scheduled", scheduledAt: NOW + 20000 })], NOW), 21500);
  assert.equal(A.nextCheckDelay([job({ status: "scheduled", scheduledAt: NOW - 20000 })], NOW), 1500, "already due: look again almost at once");
  assert.equal(A.nextCheckDelay([job({ status: "scheduled", scheduledAt: NOW + 3 * 3600000 })], NOW), 5 * 60000, "far away: just look again in 5 minutes");
  assert.equal(A.nextCheckDelay([job({ status: "scheduled", scheduledAt: NOW + 3 * 3600000 }), job({ status: "sending" })], NOW), 15000);
  assert.equal(A.dueNow([job({ status: "scheduled", scheduledAt: NOW + DAY })], NOW), false, "a notification for tomorrow never makes the page ask the server anything");
  assert.equal(A.dueNow([job({ status: "scheduled", scheduledAt: NOW })], NOW), true);
  assert.equal(A.dueNow([job({ status: "scheduled", scheduledAt: NOW + 5000 })], NOW), false);
  assert.equal(A.dueNow([job({ status: "sending" })], NOW), true);
  assert.equal(A.dueNow([job()], NOW), false);
  assert.equal(A.isActive(job({ status: "scheduled" })), true);
  assert.equal(A.isActive(job({ status: "failed" })), false);
  assert.equal(A.isActive(null), false);
});

test("progressPct", () => {
  assert.equal(A.progressPct(job({ progress: { done: 50, total: 200 } })), 25);
  assert.equal(A.progressPct(job({ progress: { done: 999, total: 200 } })), 100);
  assert.equal(A.progressPct(job({ progress: { done: 0, total: 0 } })), null);
  assert.equal(A.progressPct(job()), null);
  assert.equal(A.progressPct(null), null);
});

/* ---------- honest numbers ---------- */
test("countRows / deliveryNote: 'accepted by FCM' is never presented as 'delivered'", () => {
  const rows = A.countRows({ targeted: 10, accepted: 8, failed: 1, invalid: 1, skipped: 0 });
  assert.deepEqual(rows.map((r) => [r.key, r.value]), [["targeted", 10], ["accepted", 8], ["failed", 1], ["invalid", 1], ["skipped", 0]]);
  assert.equal(rows.find((r) => r.key === "accepted").label, "Accepted by FCM");
  assert.match(rows.find((r) => r.key === "accepted").help, /NOT a confirmation/);
  assert.deepEqual(A.countRows(undefined).map((r) => r.value), [0, 0, 0, 0, 0]);
  // no label, help text or note anywhere may say "delivered" as a fact about a device
  const all = JSON.stringify(rows) + [undefined, "scheduled", "sending", "completed", "completed_with_errors", "failed", "cancelled"].map((s) => A.deliveryNote(job({ status: s || "completed" }))).join(" ");
  assert.doesNotMatch(all.replace(/not (?:a )?(?:confirm\w*|proof)[^.]*delivered?[^.]*\./gi, ""), /\bdelivered\b/i);
  assert.match(A.deliveryNote(job()), /FCM accepted 9 of 10 devices/);
  assert.match(A.deliveryNote(job()), /cannot confirm that a phone actually showed it/);
  assert.equal(A.deliveryNote(job({ status: "scheduled" })), "Not sent yet.");
  assert.match(A.deliveryNote(job({ status: "cancelled" })), /Nobody received it/);
  assert.match(A.deliveryNote(job({ status: "completed", noRecipients: true })), /nothing was sent/);
  assert.equal(A.deliveryNote(null), "");
});

test("errorRows: the biggest reason first, in words", () => {
  const rows = A.errorRows({ unavailable: 2, registration_token_not_registered: 7, zero: 0, some_new_code: 1 });
  assert.deepEqual(rows.map((r) => r.key), ["registration_token_not_registered", "unavailable", "some_new_code"]);
  assert.equal(rows[0].label, "Device no longer registered (removed)");
  assert.equal(rows[2].label, "some new code");
  assert.deepEqual(A.errorRows(undefined), []);
  assert.equal(A.errorLabel(undefined), "error");
});

/* ---------- error messages ---------- */
test("adminErrorText: every server error code has a sentence an admin can act on", () => {
  const src = ["errors", "validate", "routes", "engine", "store", "audience"].map((f) => require("node:fs").readFileSync(new URL(`../../server/push/${f}.js`, import.meta.url), "utf8")).join("\n");
  const codes = new Set([...src.matchAll(/(?:bad|tooMany|conflict|forbidden|notFound|unauthorized)\('([a-z_]+)'/g)].map((m) => m[1]));
  codes.add("server_not_configured"); codes.add("firestore_quota"); codes.add("internal_error");
  for (const code of codes) {
    const text = A.adminErrorText({ code, message: "", extra: {} });
    assert.ok(text.length > 10, code);
    assert.doesNotMatch(text, /undefined|\[object/, code);
  }
});

test("adminErrorText: specific, calm wording for the cases that matter", () => {
  assert.match(A.adminErrorText({ code: "network" }), /internet connection/);
  assert.match(A.adminErrorText({ code: "timeout" }), /History/);
  assert.match(A.adminErrorText({ code: "unauthenticated" }), /sign in again/);
  assert.match(A.adminErrorText({ code: "not_admin" }), /Super Admin or a Manager/);
  assert.match(A.adminErrorText({ code: "role_not_allowed" }), /Super Admin or a Manager/);
  assert.match(A.adminErrorText({ code: "http_404" }), /Vercel/);
  assert.match(A.adminErrorText({ code: "http_405" }), /Setup tab/);
  assert.match(A.adminErrorText({ code: "firestore_quota" }), /resets every day/);
  assert.match(A.adminErrorText({ code: "rate_limited", extra: { retryAfter: 45 } }), /45 seconds/);
  assert.match(A.adminErrorText({ code: "rate_limited", extra: { retryAfter: 600 } }), /10 minutes/);
  assert.match(A.adminErrorText({ code: "rate_limited" }), /a little while/);
  assert.match(A.adminErrorText({ code: "duplicate_content", extra: { ageSec: 12 } }), /12 seconds ago/);
  assert.match(A.adminErrorText({ code: "duplicate_content" }), /a moment ago/);
  assert.match(A.adminErrorText({ code: "no_own_device" }), /turn notifications on/);
  assert.match(A.adminErrorText({ code: "not_cancellable" }), /already started or finished/);
  for (const reason of ["missing", "invalid_json", "not_a_service_account", "firebase_init_failed"]) {
    assert.match(A.adminErrorText({ code: "server_not_configured", extra: { reason } }), /service|Firebase|FIREBASE/, reason);
  }
  assert.match(A.adminErrorText({ code: "server_not_configured" }), /Setup tab/);
  // validation codes pass the server's own sentence through
  assert.equal(A.adminErrorText({ code: "invalid_title", message: "Title must be 1–65 characters." }), "Title must be 1–65 characters.");
  assert.equal(A.adminErrorText({ code: "weird_new_code" }), "Something went wrong (weird_new_code).");
  assert.equal(A.adminErrorText(null), "Something went wrong.");
});

/* ---------- setup checklist ---------- */
const HEALTH = { now: NOW, server: { projectId: "tvsaccount", siteUrl: "https://tvexam.vercel.app", cronConfigured: true }, scheduler: { lastTickAt: NOW - 2 * MIN }, devices: { active: 42 }, limits: {}, actor: { role: "super" } };
const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

test("describeHealth: everything in place", () => {
  const r = A.describeHealth({ health: HEALTH, vapid: true, now: NOW });
  const i = byId(r);
  for (const k of ["api", "creds", "vapid", "devices", "scheduler"]) assert.equal(i[k].tone, "ok", k);
  assert.match(i.creds.text, /tvsaccount/);
  assert.match(i.devices.text, /42 active devices/);
  assert.match(i.scheduler.text, /2 minutes ago/);
  assert.equal(r.canSend, true);
  assert.equal(r.canSchedule, true);
  assert.equal(r.cronConfigured, true);
});

test("describeHealth: the server is not deployed / not configured / not reachable", () => {
  const notDeployed = A.describeHealth({ error: { code: "http_404" }, vapid: true, now: NOW });
  assert.equal(byId(notDeployed).api.tone, "bad");
  assert.match(byId(notDeployed).api.text, /Vercel/);
  assert.equal(byId(notDeployed).creds.tone, "mute");
  assert.equal(notDeployed.canSend, false);

  const noCreds = A.describeHealth({ error: { code: "server_not_configured", extra: { reason: "missing" } }, vapid: true, now: NOW });
  assert.equal(byId(noCreds).api.tone, "ok", "the API answered, so it is deployed");
  assert.equal(byId(noCreds).creds.tone, "bad");
  assert.match(byId(noCreds).creds.text, /FIREBASE_SERVICE_ACCOUNT/);
  assert.equal(noCreds.canSend, false);

  const offline = A.describeHealth({ error: { code: "network" }, now: NOW });
  assert.equal(byId(offline).api.tone, "bad");
  assert.match(byId(offline).api.text, /internet connection/);

  const forbidden = A.describeHealth({ error: { code: "not_admin" }, now: NOW });
  assert.equal(byId(forbidden).api.tone, "ok");
  assert.equal(byId(forbidden).creds.tone, "bad");
  assert.equal(forbidden.canSend, false);
});

test("describeHealth: the browser key, the devices and the free timer each get their own honest line", () => {
  assert.equal(byId(A.describeHealth({ health: HEALTH, vapid: false, now: NOW })).vapid.tone, "warn");
  assert.match(byId(A.describeHealth({ health: HEALTH, vapid: false, now: NOW })).vapid.text, /push-config\.js/);
  assert.equal(byId(A.describeHealth({ health: { ...HEALTH, devices: { active: 0 } }, vapid: true, now: NOW })).devices.tone, "warn");
  assert.equal(byId(A.describeHealth({ health: { ...HEALTH, devices: { active: 1 } }, vapid: true, now: NOW })).devices.text, "1 active device.");
  assert.equal(byId(A.describeHealth({ health: { ...HEALTH, devices: { active: null } }, vapid: true, now: NOW })).devices.tone, "mute");

  const noCron = A.describeHealth({ health: { ...HEALTH, server: { ...HEALTH.server, cronConfigured: false } }, vapid: true, now: NOW });
  assert.equal(byId(noCron).scheduler.tone, "warn");
  assert.match(byId(noCron).scheduler.text, /CRON_SECRET/);
  assert.equal(noCron.cronConfigured, false);
  assert.equal(noCron.canSend, true, "sending now works without the timer");

  assert.match(byId(A.describeHealth({ health: { ...HEALTH, scheduler: null }, vapid: true, now: NOW })).scheduler.text, /not called the server yet/);
  const stale = byId(A.describeHealth({ health: { ...HEALTH, scheduler: { lastTickAt: NOW - 3 * 3600000 } }, vapid: true, now: NOW })).scheduler;
  assert.equal(stale.tone, "warn");
  assert.match(stale.text, /3 hours ago/);
  assert.match(byId(A.describeHealth({ health: { ...HEALTH, scheduler: { lastTickAt: NOW - 20 * 3600000 * 3 } }, vapid: true, now: NOW })).scheduler.text, /3 days ago/);
  assert.match(byId(A.describeHealth({ health: { ...HEALTH, scheduler: { lastTickAt: NOW - 10000 } }, vapid: true, now: NOW })).scheduler.text, /less than a minute ago/);
});

/* ---------- pictures ---------- */
test("fitWithin / coverSquare: resize math for uploads", () => {
  assert.deepEqual(A.fitWithin(4000, 2000, 1024, 1024), { width: 1024, height: 512 });
  assert.deepEqual(A.fitWithin(2000, 4000, 1024, 1024), { width: 512, height: 1024 });
  assert.deepEqual(A.fitWithin(500, 300, 1024, 1024), { width: 500, height: 300 }, "never scaled up");
  assert.deepEqual(A.fitWithin(4000, 1000, 96, 96), { width: 96, height: 24 });
  assert.deepEqual(A.fitWithin(0, 0, 96, 96), { width: 1, height: 1 });
  assert.deepEqual(A.coverSquare(400, 200), { sx: 100, sy: 0, side: 200 });
  assert.deepEqual(A.coverSquare(200, 400), { sx: 0, sy: 100, side: 200 });
  assert.deepEqual(A.coverSquare(300, 300), { sx: 0, sy: 0, side: 300 });
  assert.equal(A.fmtKB(700 * 1024), "700 KB");
  assert.equal(A.fmtKB(10), "1 KB");
  assert.equal(A.fmtKB(undefined), "1 KB");
});

test("the kinds of notification match the student side and the server", () => {
  assert.deepEqual(A.TYPES.map((t) => t.id), [...C.CATEGORIES]);
  assert.deepEqual(A.TYPES.map((t) => t.id), [...serverConfig.CATEGORIES]);
  for (const t of A.TYPES) assert.equal(t.bn, C.CATEGORY_LABEL[t.id]);
});
