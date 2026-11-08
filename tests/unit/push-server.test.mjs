// Push notifications — the whole server side (store, audience, engine, routes) against in-memory fakes of Firestore /
// Auth / FCM. No network, no key, no Google account.      node --test tests/unit/push-server.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as F from "../support/fake-admin.mjs";
const require = createRequire(import.meta.url);
const V = require("../../server/push/validate.js");
const S = require("../../server/push/store.js");
const A = require("../../server/push/audience.js");
const E = require("../../server/push/engine.js");
const R = require("../../server/push/routes.js");

const ACTOR = { uid: "admin1", name: "Imran", email: "imran@example.com", role: "super" };
let seq = 0;
/** a validated composer payload with a unique title (so the duplicate-content guard never fires by accident) */
const compose = (env, over = {}) => V.validateCompose({ requestId: F.reqId(), title: `Notice ${++seq}`, body: "Body text", audience: { type: "all" }, ...over }, { now: env.clock.t, cfg: env.cfg });
const later = (env, ms = 5000) => { env.clock.t += ms; };
const body = (res) => F.parse(res);
const ok = (res, status = 200) => { assert.equal(res.status, status, res.body && String(res.body).slice(0, 300)); return body(res); };
const fails = (res, status, code) => { const b = body(res); assert.equal(res.status, status, String(res.body).slice(0, 300)); assert.equal(b.ok, false); assert.equal(b.error.code, code); return b.error; };
const rejects = async (p, status, code) => assert.rejects(p, (e) => e.status === status && e.code === code, `expected ${status} ${code}`);

function world({ students = 4, env: envOpts } = {}) {
  const env = F.makeEnv({ env: envOpts });
  const adminTok = F.addUser(env, "admin1", { isAdmin: true, displayName: "Imran", email: "imran@example.com" });
  const st = {};
  for (let i = 1; i <= students; i++) { const uid = `s${i}`; st[uid] = { tok: F.addUser(env, uid), dev: F.addDevice(env, uid) }; }
  return { env, adminTok, st };
}
const jobOf = (env, id) => env.db.peek("pushNotifications", id);

/* =========================================================================== store */
test("rateDecision: spacing, hourly and daily caps, and old entries expire", () => {
  const L = { adminPerHour: 3, adminPerDay: 5, adminMinGapMs: 4000, testPerHour: 15, uploadPerHour: 30, subscribePerHour: 40 };
  const T = 10 * 86400000;
  let r = S.rateDecision([], "send", T, L); assert.equal(r.ok, true);
  r = S.rateDecision([T - 1000], "send", T, L); assert.deepEqual([r.ok, r.why, r.retryAfter], [false, "too_fast", 3]);
  r = S.rateDecision([T - 5000, T - 600000, T - 1200000], "send", T, L); assert.deepEqual([r.ok, r.why], [false, "hour"]);
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 3600);
  r = S.rateDecision([T - 5000 * 3600, T - 4 * 3600000, T - 5 * 3600000, T - 6 * 3600000, T - 7 * 3600000], "send", T, L); assert.deepEqual([r.ok, r.why], [false, "day"]);
  r = S.rateDecision([T - 2 * 86400000], "send", T, L); assert.equal(r.ok, true); assert.deepEqual(r.list, [T]);
});

test("consumeRate: per-admin hourly cap, global daily cap, and it is per kind", async () => {
  const env = F.makeEnv({ env: { PUSH_ADMIN_PER_HOUR: "3" } });
  for (let i = 0; i < 3; i++) { assert.equal((await S.consumeRate(env.ctx, "a1", "send")).ok, true); later(env); }
  const r = await S.consumeRate(env.ctx, "a1", "send");
  assert.equal(r.ok, false); assert.equal(r.why, "hour"); assert.ok(r.retryAfter > 0);
  assert.equal((await S.consumeRate(env.ctx, "a2", "send")).ok, true, "another admin is unaffected");
  assert.equal((await S.consumeRate(env.ctx, "a1", "test")).ok, true, "tests have their own bucket");
  env.clock.t += 3600000 + 1000;
  assert.equal((await S.consumeRate(env.ctx, "a1", "send")).ok, true, "the window slides");

  const big = F.makeEnv({ env: { PUSH_ADMIN_PER_HOUR: "500", PUSH_ADMIN_PER_DAY: "2000" } });
  for (let i = 0; i < 300; i++) { assert.equal((await S.consumeRate(big.ctx, `adm${i % 7}`, "send")).ok, true, `send ${i}`); big.clock.t += 5000; }
  const g = await S.consumeRate(big.ctx, "adm9", "send");
  assert.deepEqual([g.ok, g.why], [false, "global"]);
});

test("guardDuplicate: the same words for the same people within two minutes are refused", async () => {
  const env = F.makeEnv();
  assert.equal((await S.guardDuplicate(env.ctx, "h1")).duplicate, false);
  assert.equal((await S.guardDuplicate(env.ctx, "h2")).duplicate, false);
  const d = await S.guardDuplicate(env.ctx, "h1"); assert.equal(d.duplicate, true);
  env.clock.t += 3 * 60000;
  assert.equal((await S.guardDuplicate(env.ctx, "h1")).duplicate, false, "allowed again after the window");
});

test("upsertDevice: a token lives in exactly one document; ownership moves; the device list stays short", async () => {
  const env = F.makeEnv();
  const sub = (o = {}) => V.validateSubscribe({ token: F.fakeToken("x"), deviceKey: F.fakeKey(), ...o });
  const a = sub();
  const d1 = await S.upsertDevice(env.ctx, "u1", a);
  assert.equal(d1.current, true); assert.equal(env.db.all("pushDevices").length, 1);
  // same physical browser, next student signs in → the token moves to the new owner
  await S.upsertDevice(env.ctx, "u2", sub({ token: a.token }));
  const docs = env.db.all("pushDevices");
  assert.equal(docs.length, 1); assert.equal(docs[0].uid, "u2");
  // token refresh: the old token is removed
  const k = F.fakeKey(); const t1 = F.fakeToken("r1"); const t2 = F.fakeToken("r2");
  await S.upsertDevice(env.ctx, "u3", sub({ token: t1, deviceKey: k })); later(env);
  await S.upsertDevice(env.ctx, "u3", sub({ token: t2, deviceKey: k, previousToken: t1 }));
  assert.deepEqual(env.db.all("pushDevices").filter((d) => d.uid === "u3").map((d) => d.token), [t2]);
  // re-subscribing keeps createdAt, resets failCount
  const created = env.db.all("pushDevices").find((d) => d.uid === "u3").createdAt;
  later(env, 99999);
  await S.upsertDevice(env.ctx, "u3", sub({ token: t2, deviceKey: k }));
  assert.equal(env.db.all("pushDevices").find((d) => d.uid === "u3").createdAt, created);
  // at most 8 devices per student, oldest go first
  for (let i = 0; i < 10; i++) { later(env, 1000); await S.upsertDevice(env.ctx, "u4", sub()); }
  assert.equal(env.db.all("pushDevices").filter((d) => d.uid === "u4").length, env.cfg.limits.maxDevicesPerUser);
});

test("re-subscribing without preferences keeps the student's choices; a new device starts with everything on", async () => {
  const env = F.makeEnv();
  const k = F.fakeKey(); const tk = F.fakeToken("p");
  const first = await S.upsertDevice(env.ctx, "u1", V.validateSubscribe({ token: tk, deviceKey: k }));
  assert.deepEqual(first.prefs, { announcement: true, exam: true, result: true });
  await S.setDevicePrefs(env.ctx, "u1", k, { announcement: true, exam: false, result: true });
  later(env, 2000);
  const again = await S.upsertDevice(env.ctx, "u1", V.validateSubscribe({ token: F.fakeToken("p2"), deviceKey: k, previousToken: tk }));
  assert.deepEqual(again.prefs, { announcement: true, exam: false, result: true });
  const explicit = await S.upsertDevice(env.ctx, "u1", V.validateSubscribe({ token: F.fakeToken("p3"), deviceKey: k, prefs: { exam: true } }));
  assert.deepEqual(explicit.prefs, { announcement: true, exam: true, result: true });
});

test("unsubscribe / prefs only ever touch the caller's own device", async () => {
  const env = F.makeEnv();
  const mine = F.addDevice(env, "u1"); const theirs = F.addDevice(env, "u2");
  assert.equal(await S.unsubscribeDevice(env.ctx, "u1", theirs.deviceKey), false, "u2's key is not even addressable by u1");
  assert.equal(await S.setDevicePrefs(env.ctx, "u1", theirs.deviceKey, { exam: false }), null);
  assert.equal(env.db.peek("pushDevices", theirs.id).status, "active");
  assert.equal(await S.unsubscribeDevice(env.ctx, "u1", mine.deviceKey), true);
  const d = env.db.peek("pushDevices", mine.id);
  assert.deepEqual([d.status, d.token], ["unsubscribed", ""]);
});

test("createJob is idempotent and publicJob never exposes device ids, tokens, lock or cursor", async () => {
  const w = world();
  const c = compose(w.env);
  const a = await E.submitNotification(w.env.ctx, ACTOR, c);
  assert.equal(a.created, true);
  const j = jobOf(w.env, c.requestId);
  assert.ok(Array.isArray(j.deviceIds) === false && j.status === "sending");
  await E.processJob(w.env.ctx, c.requestId);
  const full = jobOf(w.env, c.requestId);
  assert.ok(Array.isArray(full.deviceIds) && full.deviceIds.length === 4);
  const pub = S.publicJob(full);
  const dump = JSON.stringify(pub);
  for (const secret of ["deviceIds", "lock", "cursor"]) assert.ok(!(secret in pub), secret);
  for (const s of Object.values(w.st)) assert.ok(!dump.includes(s.dev.token) && !dump.includes(s.dev.id), "no token / device id in the public job");
  assert.deepEqual(Object.keys(pub.counts).sort(), ["accepted", "failed", "invalid", "skipped", "targeted"]);
  assert.ok(!/deliver/i.test(dump), "never claims delivery");
});

/* =========================================================================== audience */
function seedSchool(env) {
  // users
  const tok = {};
  ["s1", "s2", "s3", "s4", "s5"].forEach((u) => { tok[u] = F.addUser(env, u, { enrolledCourses: u === "s5" ? [] : ["c1"] }); });
  F.addUser(env, "adm", { isAdmin: true, enrolledCourses: ["c1"] });
  env.db.seed("users", "sOff", { displayName: "Off", disabled: true, enrolledCourses: ["c1"] });
  // exams
  env.db.seed("exams", "eCourse", { title: "Course exam", courseId: "c1" });
  env.db.seed("exams", "eOpen", { title: "Open exam" });
  env.db.seed("exams", "eLvl", { title: "Level exam", academicProgramId: "sec1", academicLevelId: "lv1", academicSubjectId: "sub1" });
  // results
  env.db.seed("results", "r1", { uid: "s1", examId: "eCourse" });
  env.db.seed("results", "r2", { uid: "s5", examId: "eOpen" });
  env.db.seed("results", "r3", { uid: "s4", examId: "eLvl" });
  // academic tree + entitlements
  env.db.seed("academicSections", "sec1", { name: "HSC" });
  env.db.seed("academicLevels", "lv1", { name: "First paper", sectionId: "sec1" });
  env.db.seed("academicLevels", "lv2", { name: "Second paper", sectionId: "sec1" });
  env.db.seed("academicSubjects", "sub1", { name: "Physics", sectionId: "sec1", levelId: "lv1" });
  env.db.seed("academicEntitlements", "s2_sec1", { uid: "s2", nodeId: "sec1" });
  env.db.seed("academicEntitlements", "s3_sub1", { uid: "s3", nodeId: "sub1" });
  const dev = {};
  ["s1", "s2", "s3", "s4", "s5", "adm", "sOff"].forEach((u) => { dev[u] = F.addDevice(env, u); });
  return { tok, dev };
}
const idsFor = async (env, a, o = {}) => (await A.resolveAudience(env.ctx, a, { category: "announcement", ...o })).deviceIds.sort();
const devIds = (m, ...us) => us.map((u) => m.dev[u].id).sort();

test("audience: all / user — only active, opted-in devices", async () => {
  const env = F.makeEnv(); const m = seedSchool(env);
  env.db.seed("pushDevices", m.dev.s3.id, { ...env.db.peek("pushDevices", m.dev.s3.id), status: "unsubscribed", token: "" });
  env.db.seed("pushDevices", m.dev.s2.id, { ...env.db.peek("pushDevices", m.dev.s2.id), prefs: { announcement: false, exam: true, result: true } });
  assert.deepEqual(await idsFor(env, { type: "all" }), devIds(m, "s1", "s4", "s5", "adm", "sOff"));
  assert.deepEqual(await idsFor(env, { type: "all" }, { category: "exam" }), devIds(m, "s1", "s2", "s4", "s5", "adm", "sOff"));
  assert.deepEqual(await idsFor(env, { type: "user", uid: "s2" }), []);
  assert.deepEqual(await idsFor(env, { type: "user", uid: "s2" }, { ignorePrefs: true }), devIds(m, "s2"));
  assert.deepEqual(await idsFor(env, { type: "user", uid: "s1" }), devIds(m, "s1"));
});

test("audience: an exam's students = its course's enrolled students (admins and deactivated accounts skipped)", async () => {
  const env = F.makeEnv(); const m = seedSchool(env);
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eCourse", filter: "all" }), devIds(m, "s1", "s2", "s3", "s4"));
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eCourse", filter: "submitted" }), devIds(m, "s1"));
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eCourse", filter: "not_submitted" }), devIds(m, "s2", "s3", "s4"));
  // an exam with no course is open to everybody
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eOpen", filter: "all" }), devIds(m, "s1", "s2", "s3", "s4", "s5", "adm", "sOff"));
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eOpen", filter: "not_submitted" }), devIds(m, "s1", "s2", "s3", "s4", "adm", "sOff"));
  assert.deepEqual(await idsFor(env, { type: "exam", examId: "eOpen", filter: "submitted" }), devIds(m, "s5"));
  await rejects(A.resolveAudience(env.ctx, { type: "exam", examId: "ghost", filter: "all" }, { category: "exam" }), 404, "exam_not_found");
});

test("audience: a section / level = students holding access to it or anything below + students who took one of its exams", async () => {
  const env = F.makeEnv(); const m = seedSchool(env);
  assert.deepEqual(await idsFor(env, { type: "section", sectionId: "sec1" }), devIds(m, "s2", "s3", "s4"));
  assert.deepEqual(await idsFor(env, { type: "level", levelId: "lv1" }), devIds(m, "s2", "s3", "s4")); // s2: section access covers the level; s3: subject; s4: took the level's exam
  assert.deepEqual(await idsFor(env, { type: "level", levelId: "lv2" }), devIds(m, "s2"));            // a sibling level: only the section-wide entitlement
  await rejects(A.resolveAudience(env.ctx, { type: "level", levelId: "ghost" }, { category: "exam" }), 404, "node_not_found");
});

test("audience: describe, preview (cheap counts for 'all'), and the recipient safety cap", async () => {
  const env = F.makeEnv(); const m = seedSchool(env);
  assert.equal((await A.describeAudience(env.ctx, { type: "exam", examId: "eCourse", filter: "not_submitted" })).label, "Exam: Course exam · not yet submitted");
  assert.equal((await A.describeAudience(env.ctx, { type: "user", uid: "s1" })).label, "Student: s1");
  await rejects(A.describeAudience(env.ctx, { type: "user", uid: "ghost" }), 404, "student_not_found");
  for (let i = 0; i < 60; i++) F.addDevice(env, `bulk${i}`);
  env.db.resetCounters();
  const p = await A.previewAudience(env.ctx, { type: "all" }, "announcement");
  assert.equal(p.devices, 67); assert.ok(env.db.reads <= 6, `a preview of everyone must not read every device (read ${env.db.reads})`);
  const capped = F.makeEnv({ env: { PUSH_MAX_RECIPIENTS: "10" } });
  for (let i = 0; i < 11; i++) F.addDevice(capped, `u${i}`);
  await rejects(A.resolveAudience(capped.ctx, { type: "all" }, { category: "announcement" }), 400, "audience_too_large");
  assert.ok(m);
});

/* =========================================================================== engine */
test("send now: every eligible device is handed to FCM once, with a well-formed data-only payload", async () => {
  const w = world(); const { env } = w;
  const c = compose(env, { url: "#/results", category: "result", image: "https://tvgallery.vercel.app/p.webp" });
  const sub = await E.submitNotification(env.ctx, ACTOR, c);
  assert.deepEqual([sub.created, sub.duplicate, sub.job.status], [true, false, "sending"]);
  const r = await E.processJob(env.ctx, c.requestId);
  assert.equal(r.done, true); assert.equal(r.job.status, "completed");
  assert.deepEqual(r.job.counts, { targeted: 4, accepted: 4, failed: 0, invalid: 0, skipped: 0 });
  assert.equal(env.messaging.deliveredTokens().length, 4);
  assert.equal(new Set(env.messaging.deliveredTokens()).size, 4);
  const msg = env.messaging.sent[0];
  assert.equal(msg.data.title, c.title); assert.equal(msg.data.url, "#/results"); assert.equal(msg.data.cat, "result"); assert.equal(msg.data.image, "https://tvgallery.vercel.app/p.webp");
  assert.equal(msg.data.nid, c.requestId); assert.match(msg.data.tag, /^tvp-/); assert.equal(Object.keys(msg).includes("notification"), false, "data-only: the service worker draws it");
  assert.equal(msg.webpush.headers.TTL, "86400"); assert.equal(msg.webpush.headers.Urgency, "high"); assert.ok(msg.webpush.headers.Topic.length <= 32);
  // audit trail: the push log AND the panel's existing Activity Logs
  const audit = env.db.all("pushAudit").map((a) => a.action).sort();
  assert.deepEqual(audit, ["push.complete", "push.send"]);
  const logs = env.db.all("adminLogs");
  assert.equal(logs.length, 2); assert.ok(logs.every((l) => l.targetType === "push" && l.uid === "admin1" && l.email === "imran@example.com"));
});

test("an announcement uses normal urgency; the image/icon keys are omitted when empty", async () => {
  const w = world({ students: 1 }); const c = compose(w.env);
  await E.submitNotification(w.env.ctx, ACTOR, c); await E.processJob(w.env.ctx, c.requestId);
  const m = w.env.messaging.sent[0];
  assert.equal(m.webpush.headers.Urgency, "normal"); assert.ok(!("image" in m.data) && !("icon" in m.data));
});

test("FCM 'accepted' is all we claim: dead tokens are removed, failures are counted, statuses are honest", async () => {
  const w = world(); const { env } = w;
  env.messaging.failToken(w.st.s2.dev.token, "messaging/registration-token-not-registered");
  env.messaging.failToken(w.st.s3.dev.token, "messaging/internal-error");
  const c = compose(env);
  await E.submitNotification(env.ctx, ACTOR, c);
  const r = await E.processJob(env.ctx, c.requestId);
  assert.equal(r.job.status, "completed_with_errors");
  assert.deepEqual(r.job.counts, { targeted: 4, accepted: 2, failed: 2, invalid: 1, skipped: 0 });
  assert.equal(env.db.peek("pushDevices", w.st.s2.dev.id), undefined, "a dead token is cleaned up");
  assert.ok(env.db.peek("pushDevices", w.st.s3.dev.id), "a temporary failure keeps the device");
  assert.equal(r.job.errors["registration_token_not_registered"], 1);
  assert.equal(r.job.errors["internal_error"], 1);
  // everything failing → "failed", never "completed"
  const w2 = world({ students: 2 });
  w2.env.messaging.failToken(w2.st.s1.dev.token, "messaging/internal-error"); w2.env.messaging.failToken(w2.st.s2.dev.token, "messaging/internal-error");
  const c2 = compose(w2.env); await E.submitNotification(w2.env.ctx, ACTOR, c2);
  assert.equal((await E.processJob(w2.env.ctx, c2.requestId)).job.status, "failed");
});

test("a transient FCM error is retried once", async () => {
  const w = world({ students: 2 }); const { env } = w;
  env.messaging.transientOnce.add(w.st.s1.dev.token);
  const c = compose(env); await E.submitNotification(env.ctx, ACTOR, c);
  const r = await E.processJob(env.ctx, c.requestId);
  assert.deepEqual(r.job.counts, { targeted: 2, accepted: 2, failed: 0, invalid: 0, skipped: 0 });
  assert.equal(env.messaging.calls, 2);
});

test("duplicates: the same request id never creates or sends twice; the same words within 2 minutes are refused", async () => {
  const w = world(); const { env } = w;
  const c = compose(env);
  const [a, b] = await Promise.all([E.submitNotification(env.ctx, ACTOR, c), E.submitNotification(env.ctx, ACTOR, c)]);
  assert.equal([a, b].filter((x) => x.created).length, 1, "exactly one creator");
  assert.equal(env.db.all("pushNotifications").length, 1);
  await E.processJob(env.ctx, c.requestId);
  const again = await E.submitNotification(env.ctx, ACTOR, c);
  assert.deepEqual([again.created, again.duplicate, again.job.status], [false, true, "completed"]);
  const re = await E.processJob(env.ctx, c.requestId);
  assert.equal(re.done, true); assert.equal(env.messaging.deliveredTokens().length, 4, "nothing was sent a second time");
  // a different request with identical content
  later(env, 6000);
  await rejects(E.submitNotification(env.ctx, ACTOR, { ...c, requestId: F.reqId() }), 409, "duplicate_content");
  env.clock.t += 3 * 60000;
  assert.equal((await E.submitNotification(env.ctx, ACTOR, { ...c, requestId: F.reqId() })).created, true);
});

test("the same request reaching two server instances at once still makes exactly one notification", async () => {
  const w = world(); const { env } = w;
  const other = { ...env.ctx, state: {} };                      // a second serverless instance: same database, its own memory
  const c = compose(env);
  const res = await Promise.allSettled([E.submitNotification(env.ctx, ACTOR, c), E.submitNotification(other, ACTOR, c)]);
  assert.deepEqual(res.map((r) => r.status), ["fulfilled", "fulfilled"], "a double click must not show an error");
  assert.equal(res.filter((r) => r.value.created).length, 1);
  assert.equal(env.db.all("pushNotifications").length, 1);
  await E.processJob(env.ctx, c.requestId);
  assert.equal(env.messaging.deliveredTokens().length, 4);
});

test("send rate limit: 429 with a retry time once the hourly cap is used", async () => {
  const w = world({ students: 1, env: { PUSH_ADMIN_PER_HOUR: "2" } }); const { env } = w;
  for (let i = 0; i < 2; i++) { await E.submitNotification(env.ctx, ACTOR, compose(env)); later(env); }
  const e = await E.submitNotification(env.ctx, ACTOR, compose(env)).catch((x) => x);
  assert.equal(e.status, 429); assert.equal(e.code, "rate_limited"); assert.ok(e.extra.retryAfter > 0);
});

test("scheduling: nothing goes out early; the audience is frozen at send time; cancel stops a pending one", async () => {
  const w = world({ students: 2 }); const { env } = w;
  const at = env.clock.t + 10 * 60000;
  const c = compose(env, { scheduleAt: at });
  const sub = await E.submitNotification(env.ctx, ACTOR, c);
  assert.equal(sub.job.status, "scheduled");
  assert.equal(sub.job.scheduledAt, at);
  assert.equal(env.db.all("pushAudit")[0].action, "push.schedule");
  // too early: neither the direct call nor the scheduler sends anything
  const early = await E.processJob(env.ctx, c.requestId);
  assert.equal(early.done, false); assert.equal(env.messaging.calls, 0);
  assert.deepEqual((await E.tick(env.ctx)).jobs, []);
  // a student turns notifications on AFTER it was scheduled, before it is due → included
  F.addUser(env, "late"); F.addDevice(env, "late");
  env.clock.t = at + 1000;
  const t = await E.tick(env.ctx);
  assert.equal(t.jobs.length, 1); assert.equal(t.jobs[0].status, "completed");
  assert.equal(t.jobs[0].counts.accepted, 3);
  assert.equal(t.jobs[0].startedAt >= at, true);
  // the next tick has nothing to do
  assert.deepEqual((await E.tick(env.ctx)).jobs, []); assert.equal(env.messaging.deliveredTokens().length, 3);

  // cancel
  later(env, 10000);
  const c2 = compose(env, { scheduleAt: env.clock.t + 5 * 60000 });
  await E.submitNotification(env.ctx, ACTOR, c2);
  const cancelled = await E.cancelJob(env.ctx, ACTOR, c2.requestId);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.cancelledBy.uid, "admin1");
  env.clock.t += 10 * 60000;
  assert.deepEqual((await E.tick(env.ctx)).jobs, []);
  assert.equal(env.messaging.deliveredTokens().length, 3, "a cancelled notification never leaves");
  assert.ok(env.db.all("pushAudit").some((a) => a.action === "push.cancel"));
  // only a pending scheduled one can be cancelled
  await rejects(E.cancelJob(env.ctx, ACTOR, c.requestId), 409, "not_cancellable");
  await rejects(E.cancelJob(env.ctx, ACTOR, c2.requestId), 409, "not_cancellable");
  await rejects(E.cancelJob(env.ctx, ACTOR, "ghost_id_that_does_not_exist"), 404, "job_not_found");
});

test("a big send is resumable: time runs out → progress is saved → the next call continues, nobody gets two copies", async () => {
  const w = world({ students: 7 }); const { env } = w;
  env.ctx.cfg.deviceBatch = 2;
  env.messaging.onSend = () => { env.clock.t += 3000; };
  const c = compose(env); await E.submitNotification(env.ctx, ACTOR, c);
  const first = await E.processJob(env.ctx, c.requestId);
  assert.equal(first.done, false); assert.equal(first.busy, false);
  assert.deepEqual(first.job.progress, { done: 6, total: 7 });
  assert.equal(first.job.status, "sending");
  assert.equal(jobOf(env, c.requestId).lock, null, "the lease is handed back");
  const second = await E.processJob(env.ctx, c.requestId);
  assert.equal(second.done, true); assert.equal(second.job.status, "completed");
  assert.equal(second.job.counts.accepted, 7);
  const got = env.messaging.deliveredTokens();
  assert.equal(got.length, 7); assert.equal(new Set(got).size, 7);
});

test("two callers at once (admin page + scheduler): one works, the other backs off", async () => {
  const w = world({ students: 5 }); const { env } = w;
  const c = compose(env); await E.submitNotification(env.ctx, ACTOR, c);
  const [x, y] = await Promise.all([E.processJob(env.ctx, c.requestId), E.processJob(env.ctx, c.requestId)]);
  assert.equal([x, y].filter((r) => r.busy).length, 1, "exactly one was told the job is busy");
  assert.equal(env.messaging.deliveredTokens().length, 5); assert.equal(new Set(env.messaging.deliveredTokens()).size, 5);
});

test("crash recovery: a stale lease is taken over and the send continues from the saved position", async () => {
  const w = world({ students: 5 }); const { env } = w;
  env.ctx.cfg.deviceBatch = 2;
  env.messaging.onSend = () => { env.clock.t += 4000; };
  const c = compose(env); await E.submitNotification(env.ctx, ACTOR, c);
  const first = await E.processJob(env.ctx, c.requestId);        // two chunks done, then it hands back
  assert.equal(first.done, false);
  const j = jobOf(env, c.requestId);
  env.db.seed("pushNotifications", c.requestId, { ...j, lock: { id: "dead-worker", until: env.clock.t + 60000 } }); // pretend that worker crashed holding the lease
  const busy = await E.processJob(env.ctx, c.requestId);
  assert.equal(busy.busy, true);
  env.messaging.onSend = null; env.clock.t += 61000;
  const done = await E.processJob(env.ctx, c.requestId);
  assert.equal(done.done, true); assert.equal(env.messaging.deliveredTokens().length, 5); assert.equal(new Set(env.messaging.deliveredTokens()).size, 5);
});

test("a broken setup (bad key) stops at once and says so; a mass 'unregistered' never deletes devices", async () => {
  const w = world({ students: 3 }); const { env } = w;
  env.messaging.failEverything = "messaging/authentication-error";
  const c = compose(env); await E.submitNotification(env.ctx, ACTOR, c);
  const r = await E.processJob(env.ctx, c.requestId);
  assert.equal(r.job.status, "failed"); assert.equal(r.job.lastError, "messaging/authentication-error");
  assert.equal(env.db.all("pushDevices").length, 3);

  const w2 = world({ students: 25 });
  w2.env.messaging.failEverything = "messaging/registration-token-not-registered";
  const c2 = compose(w2.env); await E.submitNotification(w2.env.ctx, ACTOR, c2);
  const r2 = await E.processJob(w2.env.ctx, c2.requestId);
  assert.equal(r2.job.status, "failed"); assert.equal(r2.job.counts.invalid, 0);
  assert.equal(w2.env.db.all("pushDevices").length, 25, "when EVERY token 'fails the same way' it is our setup, not their phones");
});

test("devices are re-checked at send time: a student who switched off / left in the meantime is skipped", async () => {
  const w = world({ students: 3 }); const { env } = w;
  const at = env.clock.t + 120000;
  const c = compose(env, { scheduleAt: at, category: "exam" });
  await E.submitNotification(env.ctx, ACTOR, c);
  await S.unsubscribeDevice(env.ctx, "s1", w.st.s1.dev.deviceKey);                                 // left before it was due
  await S.setDevicePrefs(env.ctx, "s2", w.st.s2.dev.deviceKey, { announcement: true, exam: false, result: true }); // switched this type off
  env.clock.t = at + 1;
  const r = (await E.tick(env.ctx)).jobs[0];
  assert.equal(r.counts.accepted, 1); assert.deepEqual(env.messaging.deliveredTokens(), [w.st.s3.dev.token]);
  // and a device that unsubscribes AFTER the audience was frozen is skipped by the per-chunk re-check
  const w2 = world({ students: 5 }); const e2 = w2.env;       // 3 chunks of one fit in the time budget, so 5 devices guarantee a hand-back
  e2.ctx.cfg.deviceBatch = 1;
  e2.messaging.onSend = () => { e2.clock.t += 3000; };
  const c2 = compose(e2); await E.submitNotification(e2.ctx, ACTOR, c2);
  const part = await E.processJob(e2.ctx, c2.requestId);
  assert.equal(part.done, false);
  e2.messaging.onSend = null;
  const frozen = jobOf(e2, c2.requestId).deviceIds;
  const last = frozen[frozen.length - 1];
  const dev = e2.db.peek("pushDevices", last);
  e2.db.seed("pushDevices", last, { ...dev, status: "unsubscribed", token: "" });
  const fin = await E.processJob(e2.ctx, c2.requestId);
  assert.equal(fin.done, true); assert.equal(fin.job.counts.skipped, 1); assert.equal(fin.job.counts.accepted, 4);
});

test("an audience that cannot be built at send time fails the job cleanly (it does not retry forever)", async () => {
  const w = world({ students: 2 }); const { env } = w;
  env.db.seed("exams", "eGone", { title: "Gone soon" });
  const at = env.clock.t + 120000;
  const c = compose(env, { scheduleAt: at, audience: { type: "exam", examId: "eGone", filter: "all" } });
  await E.submitNotification(env.ctx, ACTOR, c);
  env.db._docs.delete("exams/eGone");                      // the exam was deleted while the notification waited
  env.clock.t = at + 1;
  const r = (await E.tick(env.ctx)).jobs[0];
  assert.equal(r.status, "failed"); assert.equal(r.lastError, "exam_not_found");
  assert.deepEqual((await E.tick(env.ctx)).jobs, []);
});

test("test notification: only the sender's own devices, whatever their switches say; others never see it", async () => {
  const w = world({ students: 2 }); const { env } = w;
  await rejects(E.submitTest(env.ctx, ACTOR, V.validateCompose({ requestId: F.reqId(), title: "Test", body: "Body" }, { now: env.clock.t, cfg: env.cfg, requireAudience: false })), 409, "no_own_device");
  const mine = F.addDevice(env, "admin1", { prefs: { announcement: false, exam: false, result: false } });
  const c = V.validateCompose({ requestId: F.reqId(), title: "Test", body: "Body" }, { now: env.clock.t, cfg: env.cfg, requireAudience: false });
  const sub = await E.submitTest(env.ctx, ACTOR, c);
  assert.equal(sub.job.test, true);
  const r = await E.processJob(env.ctx, c.requestId);
  assert.equal(r.job.status, "completed"); assert.deepEqual(env.messaging.deliveredTokens(), [mine.token]);
  assert.ok(env.db.all("pushAudit").some((a) => a.action === "push.test"));
});

test("housekeeping: devices unseen for 90 days and long-unsubscribed ones are pruned", async () => {
  const env = F.makeEnv();
  const day = 86400000;
  const fresh = F.addDevice(env, "a"); const stale = F.addDevice(env, "b", { lastSeenAt: env.clock.t - 91 * day });
  const gone = F.addDevice(env, "c", { status: "unsubscribed" });
  env.db.seed("pushDevices", gone.id, { ...env.db.peek("pushDevices", gone.id), token: "", unsubscribedAt: env.clock.t - 31 * day });
  const recent = F.addDevice(env, "d", { status: "unsubscribed" });
  env.db.seed("pushDevices", recent.id, { ...env.db.peek("pushDevices", recent.id), token: "", unsubscribedAt: env.clock.t - 2 * day });
  assert.equal(await E.pruneDevices(env.ctx), 2);
  assert.deepEqual(env.db.all("pushDevices").map((d) => d.uid).sort(), ["a", "d"]);
  assert.ok(fresh && stale);
});

/* =========================================================================== routes: who may do what */
test("auth: no token, garbage, expired, other project, flaky Auth — each gets the right answer", async () => {
  const w = world(); const { env } = w;
  fails(await R.handle(env.ctx, F.call("history", { method: "GET" })), 401, "unauthenticated");
  fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "short" })), 401, "unauthenticated");
  fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "garbage.garbage.garbage.garbage" })), 401, "invalid_token");
  fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "expired.token.xxxxxxxxxxxxxxxxxxxxxxxx" })), 401, "token_expired");
  fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "revoked.token.xxxxxxxxxxxxxxxxxxxxxxxx" })), 401, "token_revoked");
  fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "flaky.token.xxxxxxxxxxxxxxxxxxxxxxxxx" })), 503, "auth_unavailable");
  const e = fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "wrongaud.token.xxxxxxxxxxxxxxxxxxxxxxx" })), 401, "project_mismatch");
  assert.deepEqual([e.serverProject, e.siteProject], ["tvsaccount", "some-other-app"]);
});

test("admin gate: a student, a non-admin flag, a string 'true', an editor/viewer role — all refused; super and manager allowed", async () => {
  const env = F.makeEnv();
  const toks = {
    student: F.addUser(env, "stu"),
    flagFalse: F.addUser(env, "f1", { isAdmin: false }),
    str: (env.db.seed("users", "str", { isAdmin: "true" }), env.auth.addUser("str")),
    noDoc: env.auth.addUser("nodoc"),
    editor: F.addUser(env, "ed", { isAdmin: true, role: "editor" }),
    viewer: F.addUser(env, "vw", { isAdmin: true, role: "viewer" }),
    noRoleField: (env.db.seed("users", "nr", { isAdmin: true }), env.db.seed("adminRoles", "nr", {}), env.auth.addUser("nr")),
    superNoDoc: F.addUser(env, "sup", { isAdmin: true }),
    superRole: F.addUser(env, "sup2", { isAdmin: true, role: "super" }),
    manager: F.addUser(env, "mgr", { isAdmin: true, role: "manager" }),
  };
  const actions = ["health", "history", "audit", "images"];
  for (const k of ["student", "flagFalse", "str", "noDoc"]) for (const a of actions) fails(await R.handle(env.ctx, F.call(a, { method: "GET", token: toks[k] })), 403, "not_admin");
  for (const k of ["editor", "viewer", "noRoleField"]) for (const a of actions) fails(await R.handle(env.ctx, F.call(a, { method: "GET", token: toks[k] })), 403, "role_not_allowed");
  for (const k of ["superNoDoc", "superRole", "manager"]) for (const a of actions) ok(await R.handle(env.ctx, F.call(a, { method: "GET", token: toks[k] })));
  // every admin route is closed to a student, including the dangerous ones
  for (const a of ["send", "test", "process", "cancel", "audience", "upload", "image-delete"]) fails(await R.handle(env.ctx, F.call(a, { token: toks.student, body: {} })), 403, "not_admin");
  assert.equal(env.messaging.calls, 0);
  assert.ok(env.auth.calls.every((c) => c.checkRevoked === true), "admin calls also check for a revoked session");
});

test("method / action / size / CORS handling", async () => {
  const w = world(); const { env } = w;
  fails(await R.handle(env.ctx, F.call("nope", { token: w.adminTok })), 404, "unknown_action");
  fails(await R.handle(env.ctx, F.call("constructor", { token: w.adminTok })), 404, "unknown_action");
  fails(await R.handle(env.ctx, F.call("__proto__", { token: w.adminTok })), 404, "unknown_action");
  const m = await R.handle(env.ctx, F.call("send", { method: "GET", token: w.adminTok }));
  fails(m, 405, "method_not_allowed"); assert.equal(m.headers.Allow, "POST");
  fails(await R.handle(env.ctx, F.call("send", { token: w.adminTok, headers: { "content-length": String(200 * 1024) } })), 413, "payload_too_large");
  // CORS: the site's own origin is echoed; any other origin gets nothing; preflight answers 204
  const same = await R.handle(env.ctx, F.call("history", { method: "GET", token: w.adminTok, origin: "https://tvexam.vercel.app" }));
  assert.equal(same.headers["Access-Control-Allow-Origin"], "https://tvexam.vercel.app");
  const other = await R.handle(env.ctx, F.call("history", { method: "GET", token: w.adminTok, origin: "https://evil.example" }));
  assert.equal(other.headers["Access-Control-Allow-Origin"], undefined); assert.equal(other.status, 200);
  const pre = await R.handle(env.ctx, F.call("send", { method: "OPTIONS", origin: "https://tvexam.vercel.app" }));
  assert.equal(pre.status, 204); assert.match(pre.headers["Access-Control-Allow-Headers"], /Authorization/);
  const preBad = await R.handle(env.ctx, F.call("send", { method: "OPTIONS", origin: "https://evil.example" }));
  assert.equal(preBad.status, 204); assert.equal(preBad.headers["Access-Control-Allow-Origin"], undefined);
  assert.notEqual(same.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(same.headers["Cache-Control"], "no-store");
});

test("an unconfigured server answers 503 with the reason — it never half-works", async () => {
  const env = F.makeEnv(); env.ctx.setupError = "missing";
  const e = fails(await R.handle(env.ctx, F.call("history", { method: "GET", token: "x".repeat(30) })), 503, "server_not_configured");
  assert.equal(e.reason, "missing");
  assert.equal((await R.handle(env.ctx, F.call("send", { method: "OPTIONS", origin: "https://tvexam.vercel.app" }))).status, 204);
});

/* =========================================================================== routes: students */
const sub = (o = {}) => ({ token: F.fakeToken("web"), deviceKey: F.fakeKey(), platform: "android", browser: "chrome", label: "Chrome on Android", ...o });

test("student: subscribe → me → prefs → unsubscribe, only ever for their own device", async () => {
  const env = F.makeEnv();
  const t1 = F.addUser(env, "u1"); const t2 = F.addUser(env, "u2");
  const s1 = sub(); const s2 = sub();
  const r1 = ok(await R.handle(env.ctx, F.call("subscribe", { token: t1, body: s1 })));
  assert.equal(r1.device.current, true); assert.equal(r1.device.status, "active"); assert.deepEqual(r1.device.prefs, { announcement: true, exam: true, result: true });
  later(env); ok(await R.handle(env.ctx, F.call("subscribe", { token: t2, body: s2 })));
  // me: only my devices
  later(env);
  const me = ok(await R.handle(env.ctx, F.call("me", { token: t1, body: { deviceKey: s1.deviceKey } })));
  assert.equal(me.devices.length, 1); assert.equal(me.devices[0].current, true);
  assert.ok(!JSON.stringify(me).includes(s1.token), "the token is never sent back to the browser");
  assert.ok(!JSON.stringify(me).includes(s2.token));
  // prefs
  const p = ok(await R.handle(env.ctx, F.call("prefs", { token: t1, body: { deviceKey: s1.deviceKey, prefs: { exam: false } } })));
  assert.deepEqual(p.prefs, { announcement: true, exam: false, result: true });
  fails(await R.handle(env.ctx, F.call("prefs", { token: t1, body: { deviceKey: s2.deviceKey, prefs: { exam: false } } })), 404, "device_not_found");
  // u1 cannot unsubscribe u2's device
  const x = ok(await R.handle(env.ctx, F.call("unsubscribe", { token: t1, body: { deviceKey: s2.deviceKey } })));
  assert.equal(x.removed, false);
  assert.equal(env.db.all("pushDevices").find((d) => d.token === s2.token).status, "active");
  const u = ok(await R.handle(env.ctx, F.call("unsubscribe", { token: t1, body: { deviceKey: s1.deviceKey } })));
  assert.equal(u.removed, true);
  const after = ok(await R.handle(env.ctx, F.call("me", { token: t1, body: { deviceKey: s1.deviceKey } })));
  assert.equal(after.devices[0].status, "unsubscribed");
  fails(await R.handle(env.ctx, F.call("unsubscribe", { token: t1, body: {} })), 400, "invalid_device");
});

test("student: bad input is rejected, a deactivated account cannot subscribe, and subscribing is rate limited", async () => {
  const env = F.makeEnv();
  const t1 = F.addUser(env, "u1"); const off = F.addUser(env, "off", { disabled: true });
  fails(await R.handle(env.ctx, F.call("subscribe", { token: t1, body: { ...sub(), token: "nope" } })), 400, "invalid_token");
  fails(await R.handle(env.ctx, F.call("subscribe", { token: off, body: sub() })), 403, "account_disabled");
  assert.equal(env.db.all("pushDevices").length, 0);
  fails(await R.handle(env.ctx, F.call("subscribe", { method: "GET", token: t1 })), 405, "method_not_allowed");
  fails(await R.handle(env.ctx, F.call("subscribe", { body: sub() })), 401, "unauthenticated");
  let last;
  for (let i = 0; i < 45; i++) { later(env, 1500); last = await R.handle(env.ctx, F.call("subscribe", { token: t1, body: sub() })); if (last.status !== 200) break; }
  const e = fails(last, 429, "rate_limited"); assert.ok(e.retryAfter > 0); assert.ok(last.headers["Retry-After"]);
  assert.ok(env.db.all("pushDevices").filter((d) => d.uid === "u1").length <= env.cfg.limits.maxDevicesPerUser);
});

/* =========================================================================== routes: admin */
test("admin: send now through the API — validated, processed, logged; a student's request body cannot reach other people", async () => {
  const w = world(); const { env } = w;
  const id = F.reqId();
  const res = ok(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: id, title: "Result out", body: "Check it", category: "result", url: "#/results", audience: { type: "user", uid: "s2" } } })));
  assert.equal(res.created, true); assert.equal(res.job.status, "completed");
  assert.deepEqual(res.job.counts, { targeted: 1, accepted: 1, failed: 0, invalid: 0, skipped: 0 });
  assert.deepEqual(env.messaging.deliveredTokens(), [w.st.s2.dev.token]);
  assert.equal(res.job.createdBy.uid, "admin1");
  // invalid → 400 with the field, nothing stored, nothing sent
  later(env);
  const bad = fails(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: F.reqId(), title: "x", body: "y", url: "https://evil.example", audience: { type: "all" } } })), 400, "invalid_url");
  assert.equal(bad.field, "url");
  assert.equal(env.db.all("pushNotifications").length, 1); assert.equal(env.messaging.calls, 1);
  // retrying the SAME request is harmless
  later(env);
  const again = ok(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: id, title: "Result out", body: "Check it", category: "result", url: "#/results", audience: { type: "user", uid: "s2" } } })));
  assert.equal(again.duplicate, true); assert.equal(env.messaging.calls, 1);
});

test("admin: schedule → list → cancel → history; the scheduler (cron) sends it when due and only with the secret", async () => {
  const w = world({ students: 2 }); const { env } = w;
  const id = F.reqId();
  const at = env.clock.t + 15 * 60000;
  const s = ok(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: id, title: "Reminder", body: "Tonight", audience: { type: "all" }, scheduleAt: at } })));
  assert.equal(s.job.status, "scheduled"); assert.equal(env.messaging.calls, 0);
  // cron: refuses without / with a wrong secret
  const noAuth = await R.handle(env.ctx, F.call("cron", { method: "GET" })); fails(noAuth, 401, "invalid_cron_secret");
  fails(await R.handle(env.ctx, F.call("cron", { method: "GET", token: "w".repeat(48) })), 401, "invalid_cron_secret");
  fails(await R.handle(env.ctx, F.call("cron", { method: "GET", token: w.adminTok })), 401, "invalid_cron_secret"); // even an admin's own token is not the scheduler secret
  const cleared = F.makeEnv({ env: { CRON_SECRET: "" } });
  fails(await R.handle(cleared.ctx, F.call("cron", { method: "GET", token: "" })), 503, "cron_not_configured");
  assert.equal(env.messaging.calls, 0);
  // not due yet → nothing; due → sent once
  assert.deepEqual(ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET }))), { ok: true, ran: 0, waiting: 0 });
  env.clock.t = at + 2000;
  const run = ok(await R.handle(env.ctx, F.call("cron", { method: "POST", token: F.CRON_SECRET })));
  assert.equal(run.ran, 1);
  assert.equal(env.messaging.deliveredTokens().length, 2);
  ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET }))); assert.equal(env.messaging.deliveredTokens().length, 2);
  // the heartbeat tells the admin page that the free scheduler is alive
  const h = ok(await R.handle(env.ctx, F.call("health", { method: "GET", token: w.adminTok })));
  assert.ok(h.scheduler.lastTickAt > 0);
  // cancel through the API
  later(env, 10000);
  const id2 = F.reqId();
  ok(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: id2, title: "Never", body: "Cancelled", audience: { type: "all" }, scheduleAt: env.clock.t + 600000 } })));
  const c = ok(await R.handle(env.ctx, F.call("cancel", { token: w.adminTok, body: { id: id2 } })));
  assert.equal(c.job.status, "cancelled");
  fails(await R.handle(env.ctx, F.call("cancel", { token: w.adminTok, body: { id: id2 } })), 409, "not_cancellable");
  fails(await R.handle(env.ctx, F.call("cancel", { token: w.adminTok, body: { id: "../x" } })), 400, "invalid_id");
});

test("admin: history is paged newest-first; process continues a job; audit lists every action", async () => {
  const w = world({ students: 1 }); const { env } = w;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    later(env, 6000);
    const id = F.reqId(); ids.push(id);
    ok(await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: id, title: `History ${i}`, body: "b", audience: { type: "all" } } })));
  }
  const p1 = ok(await R.handle(env.ctx, F.call("history", { method: "GET", token: w.adminTok, query: { limit: "2" } })));
  assert.deepEqual(p1.items.map((j) => j.id), [ids[4], ids[3]]); assert.ok(p1.next);
  const p2 = ok(await R.handle(env.ctx, F.call("history", { token: w.adminTok, body: { limit: 2, before: p1.next } })));
  assert.deepEqual(p2.items.map((j) => j.id), [ids[2], ids[1]]);
  const p3 = ok(await R.handle(env.ctx, F.call("history", { token: w.adminTok, body: { limit: 2, before: p2.next } })));
  assert.deepEqual(p3.items.map((j) => j.id), [ids[0]]); assert.equal(p3.next, null);
  const dump = JSON.stringify(p1) + JSON.stringify(p2);
  assert.ok(!dump.includes(w.st.s1.dev.token) && !dump.includes("deviceIds") && !dump.includes('"lock"'));
  const proc = ok(await R.handle(env.ctx, F.call("process", { token: w.adminTok, body: { id: ids[0] } })));
  assert.equal(proc.done, true);
  assert.deepEqual(ok(await R.handle(env.ctx, F.call("process", { token: w.adminTok, body: {} }))).jobs, []);
  fails(await R.handle(env.ctx, F.call("process", { token: w.adminTok, body: { id: "ghost_ghost_ghost_ghost" } })), 404, "job_not_found");
  const au = ok(await R.handle(env.ctx, F.call("audit", { method: "GET", token: w.adminTok, query: { limit: "100" } })));
  assert.equal(au.items.length, 10); assert.ok(au.items.every((a) => a.uid === "admin1" && a.action));
});

test("admin: audience preview, test send, and the cache that protects the free read quota", async () => {
  const w = world(); const { env } = w;
  env.db.seed("exams", "e1", { title: "Mock 1" });
  const body1 = { audience: { type: "exam", examId: "e1", filter: "all" }, category: "exam" };
  const a = ok(await R.handle(env.ctx, F.call("audience", { token: w.adminTok, body: body1 })));
  assert.equal(a.preview.devices, 4); assert.equal(a.cached, false); assert.match(a.preview.label, /Mock 1/);
  env.db.resetCounters();
  const b = ok(await R.handle(env.ctx, F.call("audience", { token: w.adminTok, body: body1 })));
  assert.equal(b.cached, true); assert.equal(env.db.reads <= 4, true, `the cached answer costs almost nothing (read ${env.db.reads})`);
  fails(await R.handle(env.ctx, F.call("audience", { token: w.adminTok, body: { audience: { type: "weird" } } })), 400, "invalid_audience");
  // test send: first no device → 409, then works
  fails(await R.handle(env.ctx, F.call("test", { token: w.adminTok, body: { requestId: F.reqId(), title: "Hello", body: "Test" } })), 409, "no_own_device");
  const mine = F.addDevice(env, "admin1");
  later(env);
  const t = ok(await R.handle(env.ctx, F.call("test", { token: w.adminTok, body: { requestId: F.reqId(), title: "Hello", body: "Test", scheduleAt: Date.now() + 9e8, audience: { type: "all" } } })));
  assert.equal(t.job.test, true); assert.equal(t.job.status, "completed");
  assert.deepEqual(env.messaging.deliveredTokens(), [mine.token], "a test never reaches students — the audience and schedule fields are ignored");
});

test("admin: pictures — upload, serve publicly with strong caching, list, delete; nothing but real images", async () => {
  const w = world({ students: 0 }); const { env } = w;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(300).fill(7)]);
  const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(50).fill(9)]);
  const up = ok(await R.handle(env.ctx, F.call("upload", { token: w.adminTok, body: { kind: "image", name: "Banner.jpg", data: JPEG.toString("base64"), thumb: THUMB.toString("base64") } })));
  assert.match(up.image.id, /^[a-f0-9]{24}$/); assert.equal(up.image.url, `https://tvexam.vercel.app/api/push/img?id=${up.image.id}`);
  assert.equal(V.safeHttpsUrl(up.image.url), up.image.url, "the link the composer will use passes the same validation the server applies");
  // public fetch, no login
  const img = await R.handle(env.ctx, F.call("img", { method: "GET", query: { id: up.image.id } }));
  assert.equal(img.status, 200); assert.equal(img.headers["Content-Type"], "image/jpeg");
  assert.match(img.headers["Cache-Control"], /immutable/); assert.equal(img.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(Buffer.isBuffer(img.body) && img.body.equals(JPEG));
  fails(await R.handle(env.ctx, F.call("img", { method: "GET", query: { id: "0".repeat(24) } })), 404, "image_not_found");
  fails(await R.handle(env.ctx, F.call("img", { method: "GET", query: { id: "../../etc/passwd" } })), 404, "image_not_found");
  fails(await R.handle(env.ctx, F.call("img", { method: "GET", query: {} })), 404, "image_not_found");
  // rejected uploads
  later(env);
  fails(await R.handle(env.ctx, F.call("upload", { token: w.adminTok, body: { data: Buffer.from("<svg onload=alert(1)>".padEnd(50)).toString("base64"), thumb: THUMB.toString("base64") } })), 400, "invalid_image_file");
  fails(await R.handle(env.ctx, F.call("upload", { token: F.addUser(env, "stu"), body: { data: JPEG.toString("base64"), thumb: THUMB.toString("base64") } })), 403, "not_admin");
  fails(await R.handle(env.ctx, F.call("upload", { token: w.adminTok, body: { data: JPEG.toString("base64"), thumb: THUMB.toString("base64") }, headers: { "content-length": String(2 * 1024 * 1024) } })), 413, "payload_too_large");
  // list + delete
  const list = ok(await R.handle(env.ctx, F.call("images", { method: "GET", token: w.adminTok })));
  assert.equal(list.images.length, 1); assert.match(list.images[0].thumb, /^data:image\/jpeg;base64,/);
  later(env);
  ok(await R.handle(env.ctx, F.call("image-delete", { token: w.adminTok, body: { id: up.image.id } })));
  assert.equal(env.db.all("pushImages").length + env.db.all("pushImageData").length, 0);
  fails(await R.handle(env.ctx, F.call("image-delete", { token: w.adminTok, body: { id: up.image.id } })), 404, "image_not_found");
  fails(await R.handle(env.ctx, F.call("image-delete", { token: w.adminTok, body: { id: "nope" } })), 400, "invalid_id");
});

test("admin: the saved-picture library has a hard cap", async () => {
  const w = world({ students: 0 }); const { env } = w;
  env.ctx.cfg.limits.maxImages = 3; env.ctx.cfg.limits.uploadPerHour = 100;
  const J = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(100).fill(1)]).toString("base64");
  for (let i = 0; i < 3; i++) { later(env, 2000); ok(await R.handle(env.ctx, F.call("upload", { token: w.adminTok, body: { data: J, thumb: J } }))); }
  later(env, 2000);
  fails(await R.handle(env.ctx, F.call("upload", { token: w.adminTok, body: { data: J, thumb: J } })), 409, "too_many_images");
});

/* =========================================================================== routes: what must never leak */
test("health: useful numbers, never a secret", async () => {
  const w = world(); const { env } = w;
  ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET })));
  const res = await R.handle(env.ctx, F.call("health", { method: "GET", token: w.adminTok }));
  const h = ok(res);
  assert.equal(h.server.projectId, "tvsaccount"); assert.equal(h.server.cronConfigured, true); assert.equal(h.devices.active, 4); assert.equal(h.actor.role, "super");
  const dump = res.body;
  for (const secret of [F.FAKE_SA.private_key, "FAKEFAKE", F.FAKE_SA.client_email, F.CRON_SECRET, F.FAKE_SA.private_key_id]) assert.ok(!dump.includes(secret), `leaked: ${secret.slice(0, 12)}`);
});

test("errors are masked: an unexpected failure is a plain 500 and the quota error is explained", async () => {
  const w = world(); const { env } = w;
  const boom = new Error("INTERNAL SECRET path /srv/x token abc");
  env.db.fail = { error: boom, times: 1 };
  const res = await R.handle(env.ctx, F.call("subscribe", { token: w.st.s1.tok, body: sub() }));
  const e = fails(res, 500, "internal_error");
  assert.ok(!res.body.includes("SECRET") && !res.body.includes("/srv"), "internals stay in the server log");
  assert.ok(env.ctx.logs.some((l) => l.level === "error"));
  later(env);
  env.db.fail = { error: Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded."), { code: 8 }), times: 1 };
  const q = fails(await R.handle(env.ctx, F.call("subscribe", { token: w.st.s2.tok, body: sub() })), 503, "firestore_quota");
  assert.match(q.message, /free/i);
  assert.ok(e);
});

test("no API response ever contains a device token or the device-id list", async () => {
  const w = world(); const { env } = w;
  const tokens = Object.values(w.st).map((s) => s.dev.token);
  const bodies = [];
  const c = F.reqId();
  bodies.push((await R.handle(env.ctx, F.call("send", { token: w.adminTok, body: { requestId: c, title: "Leak check", body: "b", audience: { type: "all" } } }))).body);
  for (const a of ["history", "audit", "health", "images"]) bodies.push((await R.handle(env.ctx, F.call(a, { method: "GET", token: w.adminTok }))).body);
  bodies.push((await R.handle(env.ctx, F.call("process", { token: w.adminTok, body: { id: c } }))).body);
  bodies.push((await R.handle(env.ctx, F.call("me", { method: "GET", token: w.st.s1.tok }))).body);
  const all = bodies.join("\n");
  tokens.forEach((t) => assert.ok(!all.includes(t), "a device token leaked"));
  assert.ok(!all.includes("deviceIds"));
});

test("a quiet scheduler tick is cheap on the free Firestore quota", async () => {
  const w = world(); const { env } = w;
  ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET }))); // first call also writes the heartbeat
  env.db.resetCounters();
  for (let i = 0; i < 9; i++) { env.clock.t += 60000; ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET }))); }
  assert.ok(env.db.reads <= 9, `idle ticks should cost ~1 read each (9 ticks read ${env.db.reads})`);
  assert.equal(env.db.writes, 0, "idle ticks write nothing within 10 minutes");
  env.clock.t += 11 * 60000;
  ok(await R.handle(env.ctx, F.call("cron", { method: "GET", token: F.CRON_SECRET })));
  assert.ok(env.db.writes >= 1 && env.db.writes <= 2, "…then one heartbeat write");
});
