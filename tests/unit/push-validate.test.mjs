// Push notifications — input validation (server/push/validate.js, config.js). Pure functions, no network.
//   node --test tests/unit/push-validate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const V = require("../../server/push/validate.js");
const { readConfig, parseServiceAccount, normalizeSite } = require("../../server/push/config.js");
const { FAKE_SA } = await import("../support/fake-admin.mjs");

const SITE = "https://tvexam.vercel.app";
const cfg = readConfig({ SITE_URL: SITE });
const NOW = Date.UTC(2026, 10, 5, 6, 0, 0);
const RID = "req_0001bbbbbbbbbbbbbbbbbbbb";
const compose = (over = {}) => ({ requestId: RID, title: "Model test tonight", body: "Starts at 8 PM — be ready.", audience: { type: "all" }, ...over });
const rejects = (fn, code) => assert.throws(fn, (e) => e.status === 400 && e.code === code, `expected ${code}`);

/* ---------- plain text only ---------- */
test("cleanText: control characters, bidi overrides and zero-width spaces are removed", () => {
  assert.equal(V.cleanText("a\u0000b\u0007c‮d​e⁦f﻿g"), "abcdefg");
  assert.equal(V.cleanText(42), "");
  assert.equal(V.cleanText(null), "");
});
test("cleanText: Bengali conjuncts keep their joiners (ZWJ / ZWNJ)", () => {
  const s = "র‍ে ক‌ক";
  assert.equal(V.cleanText(s), s);
});
test("cleanText: whitespace is tidied; multi-line keeps single line breaks only", () => {
  assert.equal(V.cleanText("  a   b \n c\t d "), "a b c d");
  assert.equal(V.cleanText("one  \n\n\n\ntwo\r\nthree", { multiline: true }), "one\n\ntwo\nthree");
  assert.equal(V.cleanText("é"), "é");
});
test("cleanText: HTML is NOT executable — it stays literal text (the UI uses textContent / showNotification)", () => {
  assert.equal(V.cleanText("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>");
});

/* ---------- where a tap may lead ---------- */
test("normalizeDestination: only this site's pages", () => {
  const ok = (raw, value) => assert.deepEqual(V.normalizeDestination(raw, SITE), { ok: true, value }, raw);
  ok("", "#/home");
  ok("#/results", "#/results");
  ok("#/exam?id=abc_1-2", "#/exam?id=abc_1-2");
  ok("#/exam?academicProgram=sec1&level=lv2", "#/exam?academicProgram=sec1&level=lv2");
  ok(`${SITE}/#/results`, "#/results");
  ok(`${SITE}/index.html#/schedule`, "#/schedule");
  ok(`${SITE}/`, "#/home");
});
test("normalizeDestination: other sites, schemes, admin pages and tricks are refused", () => {
  const no = (raw, site = SITE) => assert.equal(V.normalizeDestination(raw, site).ok, false, String(raw));
  [
    "https://evil.example/#/results", "http://tvexam.vercel.app/#/results", "//evil.example/x", "javascript:alert(1)", "data:text/html,<b>x</b>",
    "https://tvexam.vercel.app.evil.example/#/results", `${SITE}/other#/results`, `${SITE}/?utm=1#/results`,
    "#/admin", "#/unknown", "#/exam?id=<script>", "#/exam?id=a b", "results", "/results", "#/results/../../x", "#/exam?" + "a".repeat(250),
  ].forEach((u) => no(u));
  no(`${SITE}/#/results`, ""); // a full link is only understood when the site address is configured
  no(`${SITE}/#/results`, "not a url");
});

/* ---------- picture links ---------- */
test("safeHttpsUrl: public https pictures only", () => {
  assert.equal(V.safeHttpsUrl("https://tvgallery.vercel.app/a.webp"), "https://tvgallery.vercel.app/a.webp");
  [
    "http://x.example/a.png", "https://127.0.0.1/a.png", "https://10.0.0.5/a.png", "https://localhost/a.png", "https://user:pw@x.example/a.png",
    "https://x.example:8443/a.png", "https://[::1]/a.png", "ftp://x.example/a", "javascript:alert(1)", "data:image/png;base64,AAAA",
    "https://intranet/a.png", "https://printer.local/a.png", "https://x.example/" + "a".repeat(600), "", "   ", null, 5,
  ].forEach((u) => assert.equal(V.safeHttpsUrl(u), "", String(u).slice(0, 40)));
});

/* ---------- the composer's payload ---------- */
test("validateCompose: a minimal valid request is normalized with safe defaults", () => {
  const c = V.validateCompose(compose(), { now: NOW, cfg });
  assert.deepEqual(c, {
    requestId: RID, title: "Model test tonight", body: "Starts at 8 PM — be ready.", category: "announcement", url: "#/home",
    image: "", icon: "", audience: { type: "all" }, scheduleAt: null,
  });
});
test("validateCompose: lengths are counted in characters (Bengali letters are 3 bytes each)", () => {
  const bn = (n) => "অ".repeat(n);
  assert.equal(V.validateCompose(compose({ title: bn(65), body: bn(240) }), { now: NOW, cfg }).title.length, 65);
  rejects(() => V.validateCompose(compose({ title: bn(66) }), { now: NOW, cfg }), "invalid_title");
  rejects(() => V.validateCompose(compose({ body: bn(241) }), { now: NOW, cfg }), "invalid_body_text");
  rejects(() => V.validateCompose(compose({ title: "   " }), { now: NOW, cfg }), "invalid_title");
  rejects(() => V.validateCompose(compose({ body: "" }), { now: NOW, cfg }), "invalid_body_text");
  rejects(() => V.validateCompose(compose({ title: { x: 1 } }), { now: NOW, cfg }), "invalid_title");
});
test("validateCompose: type, destination, picture and icon are checked", () => {
  rejects(() => V.validateCompose(compose({ category: "spam" }), { now: NOW, cfg }), "invalid_category");
  rejects(() => V.validateCompose(compose({ url: "https://evil.example/" }), { now: NOW, cfg }), "invalid_url");
  rejects(() => V.validateCompose(compose({ image: "http://x.example/a.png" }), { now: NOW, cfg }), "invalid_image");
  rejects(() => V.validateCompose(compose({ icon: "javascript:1" }), { now: NOW, cfg }), "invalid_icon");
  const c = V.validateCompose(compose({ category: "result", url: "#/results", image: "https://tvgallery.vercel.app/p.webp" }), { now: NOW, cfg });
  assert.equal(c.category, "result"); assert.equal(c.url, "#/results"); assert.equal(c.image, "https://tvgallery.vercel.app/p.webp");
});
test("validateCompose: request id must look like a client-generated id", () => {
  ["", "short", "has space has space has space", "x".repeat(65), undefined, 12345678901234567].forEach((id) => rejects(() => V.validateCompose(compose({ requestId: id }), { now: NOW, cfg }), "invalid_request_id"));
});
test("validateCompose: scheduling window — at least a minute ahead, at most a year", () => {
  const at = (ms) => V.validateCompose(compose({ scheduleAt: ms }), { now: NOW, cfg }).scheduleAt;
  assert.equal(at(NOW + 2 * 60000), NOW + 2 * 60000);
  assert.equal(at(new Date(NOW + 3600000).toISOString()), NOW + 3600000);
  rejects(() => at(NOW + 30000), "schedule_in_past");
  rejects(() => at(NOW - 1000), "schedule_in_past");
  rejects(() => at(NOW + 400 * 86400000), "schedule_too_far");
  rejects(() => at("tomorrow-ish"), "invalid_schedule");
  assert.equal(V.validateCompose(compose({ scheduleAt: "" }), { now: NOW, cfg }).scheduleAt, null);
  assert.equal(V.validateCompose(compose({ scheduleAt: null }), { now: NOW, cfg }).scheduleAt, null);
});
test("validateCompose: audience shapes and id hygiene", () => {
  const aud = (a) => V.validateCompose(compose({ audience: a }), { now: NOW, cfg }).audience;
  assert.deepEqual(aud({ type: "all" }), { type: "all" });
  assert.deepEqual(aud({ type: "user", uid: "abc123" }), { type: "user", uid: "abc123" });
  assert.deepEqual(aud({ type: "exam", examId: "e1" }), { type: "exam", examId: "e1", filter: "all" });
  assert.deepEqual(aud({ type: "exam", examId: "e1", filter: "not_submitted" }), { type: "exam", examId: "e1", filter: "not_submitted" });
  assert.deepEqual(aud({ type: "exam", examId: "e1", filter: "weird" }), { type: "exam", examId: "e1", filter: "all" });
  assert.deepEqual(aud({ type: "section", sectionId: "s1" }), { type: "section", sectionId: "s1" });
  assert.deepEqual(aud({ type: "level", levelId: "l1" }), { type: "level", levelId: "l1" });
  [undefined, null, "all", { type: "nope" }, { type: "user" }, { type: "user", uid: "../users/x" }, { type: "exam", examId: "a/b" }, { type: "level", levelId: "" }, { type: "section", sectionId: 7 }]
    .forEach((a) => rejects(() => aud(a), "invalid_audience"));
  assert.deepEqual(V.validateCompose(compose({ audience: undefined }), { now: NOW, cfg, requireAudience: false }).audience, { type: "self" });
});
test("contentHash / audienceKey are stable and sensitive to every field", () => {
  const base = V.validateCompose(compose(), { now: NOW, cfg });
  assert.equal(V.contentHash(base), V.contentHash({ ...base, requestId: "another_request_id_000000" }));
  ["title", "body", "category", "url", "image", "icon"].forEach((k) => assert.notEqual(V.contentHash(base), V.contentHash({ ...base, [k]: `${base[k]}x` }), k));
  assert.notEqual(V.contentHash(base), V.contentHash({ ...base, audience: { type: "user", uid: "u1" } }));
  assert.equal(V.audienceKey({ type: "all" }), "all");
  assert.equal(V.audienceKey({ type: "exam", examId: "e1", filter: "submitted" }), "exam:e1:submitted");
});

/* ---------- a student's subscription ---------- */
const TOKEN = `abc_1:APA91b${"Z".repeat(60)}`;
const KEY = `dk_${"a".repeat(28)}`;
test("validateSubscribe: a clean payload is normalized", () => {
  const s = V.validateSubscribe({ token: TOKEN, deviceKey: KEY, prefs: { exam: false }, label: "  My   phone ", platform: "android", browser: "chrome", standalone: true });
  assert.deepEqual(s.prefs, { announcement: true, exam: false, result: true });
  assert.equal(s.label, "My phone"); assert.equal(s.platform, "android"); assert.equal(s.standalone, true); assert.equal(s.previousToken, "");
});
test("validateSubscribe: junk is rejected or neutralized", () => {
  const bad = (o, code) => assert.throws(() => V.validateSubscribe({ token: TOKEN, deviceKey: KEY, ...o }), (e) => e.status === 400 && e.code === code);
  bad({ token: "short" }, "invalid_token");
  bad({ token: `${TOKEN} x` }, "invalid_token");
  bad({ token: 5 }, "invalid_token");
  bad({ deviceKey: "tiny" }, "invalid_device");
  bad({ deviceKey: "../../etc/passwd-long-enough-xx" }, "invalid_device");
  assert.throws(() => V.validateSubscribe(null), (e) => e.code === "invalid_body");
  const s = V.validateSubscribe({ token: TOKEN, deviceKey: KEY, platform: "plan9", browser: "lynx", standalone: "yes", previousToken: "nope", label: "x".repeat(200) });
  assert.equal(s.platform, "other"); assert.equal(s.browser, "other"); assert.equal(s.standalone, false); assert.equal(s.previousToken, ""); assert.equal(s.label.length, 60);
  assert.equal(V.validateSubscribe({ token: TOKEN, deviceKey: KEY }).prefs, null, "no prefs sent → keep what is stored");
  assert.deepEqual(V.validatePrefs(undefined), { announcement: true, exam: true, result: true });
  assert.deepEqual(V.validatePrefs({ announcement: "false", result: false }), { announcement: true, exam: true, result: false }); // only a real `false` switches a type off
});

/* ---------- picture upload ---------- */
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const JPEG = [0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(1)];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(2)];
const WEBP = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP"), ...new Array(30).fill(3)];
test("validateUpload: JPEG, PNG and WebP are accepted by their real signatures", () => {
  for (const [bytes, mime] of [[JPEG, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/webp"]]) {
    const u = V.validateUpload({ kind: "icon", data: b64(bytes), thumb: b64(JPEG), name: " logo \n" }, cfg);
    assert.equal(u.mime, mime); assert.equal(u.kind, "icon"); assert.equal(u.name, "logo"); assert.match(u.thumb, /^data:image\/jpeg;base64,/);
  }
  assert.equal(V.validateUpload({ data: b64(JPEG), thumb: b64(JPEG) }, cfg).kind, "image");
});
test("validateUpload: renamed files, other formats, oversize and bad base64 are refused", () => {
  const bad = (o) => assert.throws(() => V.validateUpload({ data: b64(JPEG), thumb: b64(JPEG), ...o }, cfg), (e) => e.status === 400 && e.code === "invalid_image_file");
  bad({ data: b64(Buffer.from("<html><script>alert(1)</script></html>".padEnd(40, " "))) });
  bad({ data: b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(40).fill(0)]) }); // GIF
  bad({ data: b64([0x3c, 0x73, 0x76, 0x67, ...new Array(40).fill(0)]) });               // SVG
  bad({ data: "not base64 !!" });
  bad({ data: "" });
  bad({ thumb: undefined });
  bad({ data: b64([...JPEG, ...new Array(cfg.limits.imageMaxBytes).fill(0)]) });
  bad({ thumb: b64([...JPEG, ...new Array(cfg.limits.thumbMaxBytes).fill(0)]) });
});

/* ---------- configuration ---------- */
test("parseServiceAccount: JSON, base64 and pasted-with-\\n forms all work; nothing is echoed on failure", () => {
  const json = JSON.stringify(FAKE_SA);
  assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT: json }).value.project_id, "tvsaccount");
  assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(json).toString("base64") }).value.client_email, FAKE_SA.client_email);
  const escaped = JSON.stringify({ ...FAKE_SA, private_key: FAKE_SA.private_key.replace(/\n/g, "\\n") });
  assert.match(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT: escaped }).value.private_key, /\n/);
  assert.equal(parseServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(json) }).value.project_id, "tvsaccount"); // JSON string of JSON
  for (const [env, error] of [[{}, "missing"], [{ FIREBASE_SERVICE_ACCOUNT: "  " }, "missing"], [{ FIREBASE_SERVICE_ACCOUNT: "{oops" }, "invalid_json"],
    [{ FIREBASE_SERVICE_ACCOUNT: '{"type":"authorized_user"}' }, "not_a_service_account"], [{ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...FAKE_SA, private_key: "x" }) }, "not_a_service_account"]]) {
    const r = parseServiceAccount(env);
    assert.equal(r.value, null); assert.equal(r.error, error); assert.ok(!JSON.stringify(r).includes("FAKEFAKE"));
  }
});
test("readConfig: site address, origins, limits and safe defaults", () => {
  const c = readConfig({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SA), SITE_URL: "tvexam.vercel.app/", PUSH_ALLOWED_ORIGINS: "https://a.example, https://b.example/" , PUSH_MAX_RECIPIENTS: "99999999", PUSH_ADMIN_PER_HOUR: "abc" });
  assert.equal(c.siteUrl, "https://tvexam.vercel.app"); assert.deepEqual(c.allowedOrigins.sort(), ["https://a.example", "https://b.example", "https://tvexam.vercel.app"]);
  assert.equal(c.limits.maxRecipients, 20000); assert.equal(c.limits.adminPerHour, 20); assert.equal(c.cronSecret, "");
  assert.equal(readConfig({ VERCEL_PROJECT_PRODUCTION_URL: "my-exam.vercel.app" }).siteUrl, "https://my-exam.vercel.app");
  assert.equal(readConfig({}).siteUrl, ""); assert.equal(readConfig({}).serviceAccount, null);
  assert.equal(normalizeSite("http://evil.example"), null); assert.equal(normalizeSite("http://localhost:3000").origin, "http://localhost:3000");
  assert.equal(readConfig({ PUSH_FUNCTION_BUDGET_MS: "999999" }).budgetMs, 55000);
});
