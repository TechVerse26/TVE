// Push notifications — the student side (js/push/push-core.js, push-views.js, firebase-messaging-sw.js) and the
// guarantees that span the whole feature: one list of allowed pages, no secret anywhere in the browser code.
//   node --no-warnings --test tests/unit/push.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));   // objects built inside the vm sandbox have another Object.prototype: compare plain copies

const C = await import("../../js/push/push-core.js");
const V = await import("../../js/push/push-views.js");
const { PUSH, pushConfigured } = await import("../../js/push/push-config.js");
const serverConfig = require("../../server/push/config.js");

/* ==========================================================================
   push-core.js
   ========================================================================== */
test("safeRoute: only known pages of this site, with a plain query at most", () => {
  assert.equal(C.safeRoute("#/results"), "#/results");
  assert.equal(C.safeRoute("  #/home "), "#/home");
  assert.equal(C.safeRoute("#/exam?id=abc_1-2"), "#/exam?id=abc_1-2");
  assert.equal(C.safeRoute("#/exam?academicProgram=sec1&level=lv2"), "#/exam?academicProgram=sec1&level=lv2");
  for (const bad of ["https://evil.example/#/home", "//evil.example", "javascript:alert(1)", "data:text/html,x", "#/admin", "#/login", "#/signup", "#/unknown",
    "#/results/../x", "#/exam?id=<script>", "#/exam?id=a b", "results", "/results", "", "#/exam?" + "a".repeat(260)]) {
    assert.equal(C.safeRoute(bad), "", String(bad));
  }
  for (const notText of [null, undefined, 42, {}, ["#/home"]]) assert.equal(C.safeRoute(notText), "");
});

test("normalizeIncoming: draws only what is safe, and nothing that is not ours", () => {
  const ok = C.normalizeIncoming({ nid: "n_abcdefgh1", title: " Exam tonight ", body: "Line 1\nLine 2", url: "#/exam?id=x1", cat: "exam", ts: "1760000000000" });
  assert.deepEqual(ok, { nid: "n_abcdefgh1", title: "Exam tonight", body: "Line 1\nLine 2", url: "#/exam?id=x1", cat: "exam", ts: 1760000000000 });
  // not ours / malformed → nothing is drawn
  assert.equal(C.normalizeIncoming(null), null);
  assert.equal(C.normalizeIncoming("x"), null);
  assert.equal(C.normalizeIncoming({ title: "no id" }), null);
  assert.equal(C.normalizeIncoming({ nid: "short", title: "bad id" }), null);
  assert.equal(C.normalizeIncoming({ nid: "n_abcdefgh1", title: "   " }), null);
  assert.equal(C.normalizeIncoming({ nid: "n_abcdefgh1" }), null);
  // fallbacks: a foreign link becomes the home page, an unknown kind becomes an announcement, a bad time becomes "now"
  const fb = C.normalizeIncoming({ nid: "n_abcdefgh1", title: "T", url: "https://evil.example/", cat: "weird", ts: "x" });
  assert.equal(fb.url, "#/home");
  assert.equal(fb.cat, "announcement");
  assert.ok(fb.ts > 1.7e12);
  // control characters never reach the screen
  assert.equal(C.normalizeIncoming({ nid: "n_abcdefgh1", title: "A\u0000B\u0007C" }).title, "A B C");
  assert.equal(C.normalizeIncoming({ nid: "n_abcdefgh1", title: "x".repeat(500) }).title.length, 120);
});

test("randomKey: URL-safe, unique, and still works without Web Crypto", () => {
  const a = C.randomKey();
  const b = C.randomKey();
  assert.match(a, /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(a, b);
  assert.match(C.randomKey(null), /^[A-Za-z0-9_-]{16,64}$/);
});

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
};
test("detectDevice: a readable name and the platform / browser the server stores", () => {
  assert.deepEqual(C.detectDevice({ ua: UA.androidChrome }), { platform: "android", browser: "chrome", standalone: false, label: "Chrome · Android" });
  assert.equal(C.detectDevice({ ua: UA.samsung }).label, "Samsung Internet · Android");
  assert.deepEqual(C.detectDevice({ ua: UA.iphone, standalone: true }), { platform: "ios", browser: "safari", standalone: true, label: "Safari · iPhone/iPad (app)" });
  assert.equal(C.detectDevice({ ua: UA.winEdge }).label, "Edge · Windows");
  assert.equal(C.detectDevice({ ua: UA.firefoxLinux }).label, "Firefox · Linux");
  assert.equal(C.detectDevice({ ua: UA.mac }).platform, "mac");
  assert.equal(C.detectDevice({ ua: UA.mac, touchPoints: 5 }).platform, "ios", "an iPad that asks for the desktop site is still an iPad");
  assert.equal(C.detectDevice({ ua: "", navPlatform: "MacIntel", touchPoints: 5 }).platform, "ios");
  assert.deepEqual(C.detectDevice({}), { platform: "other", browser: "other", standalone: false, label: "Browser · Device" });
  assert.ok(C.detectDevice({ ua: UA.androidChrome, standalone: true }).label.length <= 60);
});

test("supportState: says WHY a device cannot receive push", () => {
  const ok = { secure: true, hasSW: true, hasPush: true, hasNotification: true, ios: false, standalone: false };
  assert.deepEqual(C.supportState(ok), { ok: true, reason: "ok" });
  assert.equal(C.supportState({ ...ok, secure: false }).reason, "insecure");
  assert.equal(C.supportState({ ...ok, ios: true }).reason, "ios-install", "iPhone / iPad: only the installed app can receive push");
  assert.equal(C.supportState({ ...ok, ios: true, standalone: true }).ok, true);
  assert.equal(C.supportState({ ...ok, hasSW: false }).reason, "no-sw");
  assert.equal(C.supportState({ ...ok, hasPush: false }).reason, "no-push");
  assert.equal(C.supportState({ ...ok, hasNotification: false }).reason, "no-push");
});

const NOW = Date.UTC(2026, 10, 5, 6, 0, 0);
const DAY = 86400000;
const base = { configured: true, support: { ok: true, reason: "ok" }, signedIn: true, permission: "default", enabledHere: false, examTaking: false, overlayOpen: false, resumeBar: false, route: "home", rec: {}, visits: 2, now: NOW };
const why = (over) => C.promptDecision({ ...base, ...over });

test("promptDecision: asks only when every rule allows it — each rule is a reason NOT to disturb the student", () => {
  assert.deepEqual(why({}), { show: true, reason: "ok" });
  assert.equal(why({ configured: false }).reason, "not-configured");
  assert.equal(why({ support: { ok: false, reason: "no-sw" } }).reason, "unsupported");
  assert.equal(why({ support: null }).reason, "unsupported");
  assert.equal(why({ signedIn: false }).reason, "signed-out");
  assert.equal(why({ permission: "denied" }).reason, "denied");
  assert.equal(why({ enabledHere: true }).reason, "already-on");
  assert.equal(why({ examTaking: true }).reason, "busy");
  assert.equal(why({ overlayOpen: true }).reason, "busy");
  assert.equal(why({ resumeBar: true }).reason, "busy");
  assert.equal(why({ visits: 1 }).reason, "too-early", "never on a first visit");
  assert.equal(why({ visits: 0 }).reason, "too-early");
  assert.equal(why({ rec: { n: 1, at: NOW, never: true } }).reason, "never");
  for (const route of ["exam", "login", "signup", "results", "profile", "leaderboard", "admin"]) assert.equal(why({ route }).reason, "route", route);
  for (const route of ["home", "notifications", "schedule", "exams"]) assert.equal(why({ route }).show, true, route);
});

test("promptDecision: back-off — 7 days after the first ask, 30 after the second, then never again by itself", () => {
  assert.equal(C.promptBackoffMs(0), 0);
  assert.equal(C.promptBackoffMs(1), 7 * DAY);
  assert.equal(C.promptBackoffMs(2), 30 * DAY);
  assert.equal(C.promptBackoffMs(3), Infinity);
  const asked = (n, ago) => ({ n, at: NOW - ago });
  assert.equal(why({ rec: asked(1, 6 * DAY) }).reason, "cooling-down");
  assert.equal(why({ rec: asked(1, 8 * DAY) }).show, true);
  assert.equal(why({ rec: asked(2, 29 * DAY) }).reason, "cooling-down");
  assert.equal(why({ rec: asked(2, 31 * DAY) }).show, true);
  assert.equal(why({ rec: asked(3, 400 * DAY) }).reason, "cooling-down", "the third time it does not return by itself, however long it has been");
});

test("afterLater / afterNever: counting how often the card has been shown", () => {
  assert.deepEqual(C.afterLater(undefined, NOW), { n: 1, at: NOW, never: false });
  assert.deepEqual(C.afterLater({ n: 1, at: 5, never: false }, NOW), { n: 2, at: NOW, never: false });
  assert.deepEqual(C.afterNever({ n: 2 }, NOW), { n: 3, at: NOW, never: true });
  // "shown once" followed by the very next evaluation must not show it again
  const once = C.afterLater({}, NOW);
  assert.equal(why({ rec: once, now: NOW + 60000 }).reason, "cooling-down");
});

test("classifyFcmError: browser / Firebase errors become our own codes", () => {
  assert.equal(C.classifyFcmError({ code: "messaging/permission-blocked" }), "permission_denied");
  assert.equal(C.classifyFcmError({ name: "NotAllowedError" }), "permission_denied");
  assert.equal(C.classifyFcmError({ code: "messaging/unsupported-browser" }), "unsupported");
  assert.equal(C.classifyFcmError({ message: "The applicationServerKey is not valid" }), "vapid_invalid");
  assert.equal(C.classifyFcmError({ name: "InvalidAccessError" }), "vapid_invalid");
  assert.equal(C.classifyFcmError({ code: "messaging/failed-service-worker-registration" }), "sw_failed");
  assert.equal(C.classifyFcmError({ code: "messaging/token-subscribe-failed" }), "fcm_failed");
  assert.equal(C.classifyFcmError(null), "fcm_failed");
  assert.equal(C.classifyFcmError("boom"), "fcm_failed");
});

test("errorText / agoBn: Bengali wording, never an empty message", () => {
  for (const code of Object.keys(C.ERR)) assert.ok(C.errorText(code).length > 5, code);
  assert.equal(C.errorText("http_404"), C.ERR.server_not_configured);
  assert.equal(C.errorText("http_405"), C.ERR.server_not_configured);
  assert.match(C.errorText("something_new"), /সমস্যা/);
  assert.equal(C.errorText(undefined).length > 5, true);
  assert.equal(C.agoBn(0, NOW), "এইমাত্র");
  assert.equal(C.agoBn(NOW - 30000, NOW), "এইমাত্র");
  assert.equal(C.agoBn(NOW - 5 * 60000, NOW), "৫ মিনিট আগে");
  assert.equal(C.agoBn(NOW - 3 * 3600000, NOW), "৩ ঘণ্টা আগে");
  assert.equal(C.agoBn(NOW - 12 * DAY, NOW), "১২ দিন আগে");
});

test("dormant by default: nothing runs until the VAPID key is pasted", () => {
  const saved = { ...PUSH };
  try {
    assert.equal(saved.vapidKey, "", "the shipped config must be empty so the site behaves exactly as before");
    assert.equal(pushConfigured(), false);
    const key = "B" + "A".repeat(86);
    PUSH.vapidKey = key;
    assert.equal(pushConfigured(), true);
    PUSH.vapidKey = `  ${key}  `;
    assert.equal(pushConfigured(), true, "stray spaces from copy-paste are tolerated");
    PUSH.enabled = false;
    assert.equal(pushConfigured(), false, "the master switch wins");
    PUSH.enabled = true;
    for (const bad of ["short", "B" + "A".repeat(200), "has space " + "A".repeat(80), "-----BEGIN PRIVATE KEY-----" + "A".repeat(80), null, 42]) {
      PUSH.vapidKey = bad;
      assert.equal(pushConfigured(), false, String(bad).slice(0, 20));
    }
  } finally { Object.assign(PUSH, saved); }
});

/* ==========================================================================
   push-views.js
   ========================================================================== */
const status = (over = {}) => ({ phase: "off", support: { ok: true, reason: "ok" }, permission: "default", uid: "u1", prefs: { announcement: true, exam: true, result: true }, devices: null, syncPending: false, error: "", ...over });

test("esc: the five characters that can break out of HTML", () => {
  assert.equal(V.esc(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(V.esc(null), "");
  assert.equal(V.esc(0), "0");
});

test("settingsHtml: off → a clear benefit list and ONE button to turn on; busy → the button waits", () => {
  const off = V.settingsHtml(status());
  assert.match(off, /data-tvp="enable"/);
  assert.doesNotMatch(off, /data-tvp="enable"[^>]*disabled/);
  assert.match(off, /কখনো জোর করা হয় না/);
  assert.match(off, /badge-muted/);
  assert.equal((off.match(/data-tvp="enable"/g) || []).length, 1);
  const busy = V.settingsHtml(status({ phase: "busy" }));
  assert.match(busy, /data-tvp="enable"[^>]*disabled/);
  assert.match(busy, /fa-spin/);
});

test("settingsHtml: on → a switch per kind (reflecting the choice), the device list and a way to turn it off", () => {
  const html = V.settingsHtml(status({
    phase: "on", prefs: { announcement: true, exam: false, result: true },
    devices: [{ id: "d1", label: "Chrome · Android", platform: "android", status: "active", lastSeenAt: Date.now() - 5 * 60000, current: true },
      { id: "d2", label: "Edge · Windows", platform: "windows", status: "active", lastSeenAt: Date.now() - 3 * DAY, current: false }],
  }));
  for (const cat of C.CATEGORIES) assert.match(html, new RegExp(`data-pref="${cat}"`));
  assert.match(html, /data-pref="announcement" checked/);
  assert.doesNotMatch(html, /data-pref="exam" checked/);
  assert.match(html, /data-pref="result" checked/);
  assert.match(html, /role="switch"/);
  assert.match(html, /data-tvp="disable"/);
  assert.match(html, /এই ডিভাইস · /);
  assert.match(html, /Edge · Windows/);
  assert.match(html, /fa-mobile-screen/);
  assert.match(html, /fa-laptop/);
  assert.match(html, /badge-green/);
  assert.doesNotMatch(html, /data-tvp="enable"/, "already on: no second 'turn on' button");
});

test("settingsHtml: a device name or an error can never inject markup", () => {
  const html = V.settingsHtml(status({ phase: "on", devices: [{ id: "d1", label: "<img src=x onerror=alert(1)>", platform: "other", status: "active", lastSeenAt: 1, current: false }] }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("settingsHtml: denied and unsupported are explained calmly — no button that cannot work", () => {
  const denied = V.settingsHtml(status({ phase: "denied", permission: "denied", error: "permission_denied" }));
  assert.match(denied, /ব্লক/);
  assert.match(denied, /অনুমতি দিন/);
  assert.doesNotMatch(denied, /data-tvp="enable"/);
  assert.doesNotMatch(denied, /role="alert"/, "blocked is a state, not an error message");
  const ios = V.settingsHtml(status({ phase: "unsupported", support: { ok: false, reason: "ios-install" } }));
  assert.match(ios, /Add to Home Screen/);
  assert.doesNotMatch(ios, /data-tvp="enable"/);
  for (const reason of ["insecure", "no-sw", "no-push", "other-reason", undefined]) {
    const h = V.settingsHtml(status({ phase: "unsupported", support: reason ? { ok: false, reason } : null }));
    assert.match(h, /tvp-note/, String(reason));
  }
});

test("settingsHtml: errors are shown in Bengali (on and off), an unknown phase falls back to off", () => {
  assert.match(V.settingsHtml(status({ error: "fcm_failed" })), new RegExp(C.ERR.fcm_failed));
  assert.match(V.settingsHtml(status({ phase: "on", error: "rate_limited" })), new RegExp(C.ERR.rate_limited));
  assert.match(V.settingsHtml(status({ phase: "on", syncPending: true })), /সংযোগ ফিরলে/);
  assert.match(V.settingsHtml(status({ phase: "idle" })), /data-tvp="enable"/);
});

test("promptHtml: explains the benefit first, offers 'turn on', 'not now' and 'never', and starts with no error", () => {
  const html = V.promptHtml();
  assert.match(html, /data-tvp="enable"/);
  assert.match(html, /data-tvp="later"/);
  assert.match(html, /data-tvp="never"/);
  assert.match(html, /নতুন পরীক্ষা/);
  assert.match(html, /যেকোনো সময় বন্ধ করতে পারবেন/);
  assert.match(html, /data-tvp-error[^>]*hidden/);
});

test("bannerHtml: title and text are plain text, the kind picks the icon", () => {
  const html = V.bannerHtml({ nid: "n_abcdefgh1", title: "<b>Hi</b>", body: "x\"y<z>", cat: "result", url: "#/results" });
  assert.doesNotMatch(html, /<b>Hi/);
  assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
  assert.match(html, /x&quot;y&lt;z&gt;/);
  assert.match(html, /fa-square-poll-vertical/);
  assert.match(V.bannerHtml({ title: "T", body: "", cat: "exam" }), /fa-file-pen/);
  assert.match(V.bannerHtml({ title: "T", body: "", cat: "nonsense" }), /fa-bullhorn/);
  assert.doesNotMatch(V.bannerHtml({ title: "T", body: "", cat: "exam" }), /tvp-banner-body/, "no empty text line");
  assert.match(V.bannerHtml({ title: "T", body: "", cat: "exam" }), /data-tvp="go"[\s\S]*data-tvp="close"/);
});

/* ==========================================================================
   firebase-messaging-sw.js — run in a sandbox with a fake worker environment
   ========================================================================== */
const SW_SRC = read("firebase-messaging-sw.js");
const SITE = "https://tvexam.vercel.app";

function loadSw({ search = "?k=KEY&p=proj&s=123&a=1%3A123%3Aweb%3Aabc", tabs = [] } = {}) {
  const listeners = {};
  const order = [];
  const shown = [];
  const opened = [];
  const calls = { importScripts: [], init: [], bg: null };
  let clock = 1760000000000;
  class FakeDate extends Date { static now() { return clock; } }
  const store = new Map();
  class FakeHeaders { constructor(init = {}) { this.m = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)])); } get(k) { const v = this.m.get(String(k).toLowerCase()); return v === undefined ? null : v; } }
  class FakeResponse { constructor(body, init = {}) { this.body = body; this.headers = new FakeHeaders(init.headers); } }
  class FakeRequest { constructor(url) { this.url = url; } }
  const cache = {
    match: async (req) => store.get(req.url),
    put: async (req, res) => { store.set(req.url, res); },
    keys: async () => [...store.keys()].map((u) => new FakeRequest(u)),
    delete: async (req) => store.delete(req.url),
  };
  const self = {
    location: { href: `${SITE}/firebase-messaging-sw.js${search}` },
    addEventListener: (type, fn) => { order.push(type); (listeners[type] = listeners[type] || []).push(fn); },
    skipWaiting: () => { calls.skip = true; },
    clients: { claim: async () => { calls.claimed = true; }, matchAll: async () => tabs, openWindow: async (u) => { opened.push(u); } },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
  };
  const sandbox = {
    self, URL, URLSearchParams, Request: FakeRequest, Response: FakeResponse, Date: FakeDate, encodeURIComponent,
    caches: { open: async () => cache },
    importScripts: (...u) => { order.push("importScripts"); calls.importScripts.push(...u); },
    firebase: { initializeApp: (cfg) => calls.init.push(cfg), messaging: () => ({ onBackgroundMessage: (fn) => { calls.bg = fn; } }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox, { filename: "firebase-messaging-sw.js" });
  const click = (data) => {
    const event = { notification: { data, close() { event.closed = true; } }, waitUntil(p) { event.work = p; } };
    (listeners.notificationclick || []).forEach((fn) => fn(event));
    return event;
  };
  const push = (payload, { broken = false } = {}) => {
    const event = { data: broken ? { json: () => { throw new SyntaxError("not json"); } } : (payload === null ? null : { json: () => payload }), waitUntil(p) { event.work = p; } };
    (listeners.push || []).forEach((fn) => fn(event));
    return event;
  };
  return { listeners, order, shown, opened, calls, store, click, push, setClock: (t) => { clock = t; }, self };
}
const tab = (url, visibilityState = "visible") => {
  const t = { url, visibilityState, focused: 0, messages: [], focus: async () => { t.focused++; }, postMessage: (m) => t.messages.push(m) };
  return t;
};
const msg = (over = {}) => ({ data: { nid: "n_abcdefgh1", title: "Exam tonight", body: "Starts at 8 PM", url: "#/exam?id=x1", cat: "exam", ts: "1760000000000", ...over } });

test("SW: parses as a classic worker script and exposes a version marker", () => {
  assert.doesNotThrow(() => new vm.Script(SW_SRC, { filename: "firebase-messaging-sw.js" }));
  const sw = loadSw();
  assert.match(sw.self.__TVP_SW_VERSION__, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test("SW: the click handler is registered BEFORE the Firebase SDK starts", () => {
  const sw = loadSw();
  assert.ok(sw.order.indexOf("notificationclick") >= 0 && sw.order.indexOf("importScripts") >= 0);
  assert.ok(sw.order.indexOf("notificationclick") < sw.order.indexOf("importScripts"));
});

test("SW: the 'only the admin panel is open' listener is registered BEFORE the Firebase SDK starts", () => {
  const sw = loadSw();
  assert.equal(sw.listeners.push.length, 1, "exactly one push listener of our own (the SDK adds its own later)");
  assert.ok(sw.order.indexOf("push") < sw.order.indexOf("importScripts"));
});

test("SW: with ONLY the admin panel visible, a push is drawn by the worker (the SDK would hand it to a page that has no push code)", async () => {
  const admin = tab(`${SITE}/admin.html`, "visible");
  const sw = loadSw({ tabs: [admin] });
  const ev = sw.push(msg());
  await ev.work;
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "Exam tonight");
  assert.equal(sw.shown[0].options.data.url, "#/exam?id=x1");
  assert.equal(sw.shown[0].options.silent, false);
  // the same notification arriving twice (e.g. a second path also draws it) replaces itself, silently
  await sw.push(msg()).work;
  assert.equal(sw.shown.length, 2);
  assert.equal(sw.shown[1].options.tag, sw.shown[0].options.tag);
  assert.equal(sw.shown[1].options.silent, true);
});

test("SW: a visible student page keeps the in-page banner — the worker draws nothing beside it", async () => {
  for (const tabs of [
    [tab(`${SITE}/`, "visible")],
    [tab(`${SITE}/index.html#/home`, "visible"), tab(`${SITE}/admin.html`, "visible")],
  ]) {
    const sw = loadSw({ tabs });
    await sw.push(msg()).work;
    assert.equal(sw.shown.length, 0);
  }
});

test("SW: with no visible tab the worker leaves it to the SDK's background handler (one copy, never two)", async () => {
  for (const tabs of [[], [tab(`${SITE}/admin.html`, "hidden")], [tab(`${SITE}/`, "hidden"), tab(`${SITE}/admin.html`, "hidden")]]) {
    const sw = loadSw({ tabs });
    await sw.push(msg()).work;
    assert.equal(sw.shown.length, 0);
  }
  const sw = loadSw({ tabs: [] });
  await sw.calls.bg(msg());
  assert.equal(sw.shown.length, 1, "…and the SDK path still draws it");
});

test("SW: a push that is empty, not JSON, or not ours draws nothing and never throws", async () => {
  const admin = tab(`${SITE}/admin.html`, "visible");
  const sw = loadSw({ tabs: [admin] });
  await sw.push(null).work;
  await sw.push(null, { broken: true }).work;
  await sw.push({ data: { title: "no id" } }).work;
  await sw.push({ notification: { title: "foreign" } }).work;
  await sw.push({ data: { nid: "n_abcdefgh1", title: "" } }).work;
  assert.equal(sw.shown.length, 0);
});

test("SW: a pushed destination that is not a page of this site still becomes the home page", async () => {
  const sw = loadSw({ tabs: [tab(`${SITE}/admin.html`, "visible")] });
  await sw.push(msg({ url: "https://evil.example/phish" })).work;
  assert.equal(sw.shown[0].options.data.url, "#/home");
});

test("SW: Firebase starts from the page's own (public) settings, once, with the pinned release", () => {
  const sw = loadSw();
  assert.deepEqual(plain(sw.calls.init), [{ apiKey: "KEY", projectId: "proj", messagingSenderId: "123", appId: "1:123:web:abc" }]);
  assert.equal(sw.calls.importScripts.length, 2);
  for (const u of sw.calls.importScripts) assert.match(u, /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.13\.0\/firebase-(app|messaging)-compat\.js$/);
  assert.equal(typeof sw.calls.bg, "function");
});

test("SW: without its settings it does nothing at all (no download, no Firebase)", () => {
  for (const search of ["", "?k=KEY", "?k=KEY&p=proj&s=123"]) {
    const sw = loadSw({ search });
    assert.equal(sw.calls.importScripts.length, 0, search);
    assert.equal(sw.calls.init.length, 0, search);
    assert.equal(sw.calls.bg, null, search);
    assert.ok(sw.listeners.notificationclick.length === 1, "tapping an already-shown notification still works");
  }
});

test("SW: a background message becomes ONE branded notification with a safe destination", async () => {
  const sw = loadSw();
  await sw.calls.bg(msg({ image: "https://img.example/pic.png" }));
  assert.equal(sw.shown.length, 1);
  const { title, options } = sw.shown[0];
  assert.equal(title, "Exam tonight");
  assert.equal(options.body, "Starts at 8 PM");
  assert.equal(options.icon, `${SITE}/assets/pwa/icon-192.png`);
  assert.equal(options.badge, `${SITE}/assets/push/badge-72.png`);
  assert.equal(options.image, "https://img.example/pic.png");
  assert.equal(options.tag, "tvp-n_abcdefgh1");
  assert.equal(options.silent, false);
  assert.equal(options.renotify, false);
  assert.equal(options.lang, "bn");
  assert.equal(options.timestamp, 1760000000000);
  assert.deepEqual(plain(options.data), { nid: "n_abcdefgh1", url: "#/exam?id=x1", cat: "exam" });
});

test("SW: pictures and icons must be https — anything else is dropped, not fetched", async () => {
  const sw = loadSw();
  await sw.calls.bg(msg({ nid: "n_pics00001", image: "http://img.example/pic.png", icon: "http://img.example/i.png" }));
  await sw.calls.bg(msg({ nid: "n_pics00002", image: "javascript:alert(1)", icon: "data:image/png;base64,AAAA" }));
  await sw.calls.bg(msg({ nid: "n_pics00003", image: "https://user:pw@img.example/pic.png" }));
  await sw.calls.bg(msg({ nid: "n_pics00004", icon: "https://img.example/custom.png" }));
  assert.equal(sw.shown.length, 4);
  for (const i of [0, 1, 2]) assert.equal(sw.shown[i].options.image, undefined, `#${i}`);
  for (const i of [0, 1]) assert.equal(sw.shown[i].options.icon, `${SITE}/assets/pwa/icon-192.png`, `#${i}`);
  assert.equal(sw.shown[3].options.icon, "https://img.example/custom.png");
});

test("SW: the same notification twice → the same tag (it replaces itself) and the repeat is silent", async () => {
  const sw = loadSw();
  await sw.calls.bg(msg());
  await sw.calls.bg(msg());
  assert.equal(sw.shown.length, 2, "Chrome requires every push to end in a visible notification, so the repeat is shown …");
  assert.equal(sw.shown[0].options.tag, sw.shown[1].options.tag, "… but under the same tag, replacing the first");
  assert.equal(sw.shown[0].options.silent, false);
  assert.equal(sw.shown[1].options.silent, true, "… and without a second sound");
});

test("SW: the 'already shown' memory expires after a day and never grows without bound", async () => {
  const sw = loadSw();
  await sw.calls.bg(msg());
  sw.setClock(1760000000000 + 25 * 3600 * 1000);
  await sw.calls.bg(msg());
  assert.equal(sw.shown[1].options.silent, false, "a day later it is new again");
  for (let i = 0; i < 90; i++) await sw.calls.bg(msg({ nid: `n_flood${String(i).padStart(4, "0")}` }));
  assert.ok(sw.store.size <= 60, `memory stays small (${sw.store.size})`);
});

test("SW: a foreign or blank payload draws nothing", async () => {
  const sw = loadSw();
  for (const payload of [undefined, null, {}, { data: null }, { data: {} }, { data: { title: "no id" } }, { data: { nid: "bad", title: "short id" } }, { data: { nid: "n_abcdefgh1", title: "  " } }, { notification: { title: "from elsewhere" } }]) {
    await sw.calls.bg(payload);
  }
  assert.equal(sw.shown.length, 0);
});

test("SW: a destination that is not a page of this site becomes the home page", async () => {
  const sw = loadSw();
  for (const [i, url] of ["https://evil.example/phish", "javascript:alert(1)", "#/admin", "//evil.example", "#/exam?x=<s>"].entries()) {
    await sw.calls.bg(msg({ nid: `n_dest0000${i}`, url }));
  }
  for (const s of sw.shown) assert.equal(s.options.data.url, "#/home");
});

test("SW: tapping focuses the open site tab and asks it to go to the page — it never navigates elsewhere", async () => {
  const hidden = tab(`${SITE}/`, "hidden");
  const visible = tab(`${SITE}/index.html#/home`, "visible");
  const admin = tab(`${SITE}/admin.html`, "visible");
  const other = tab("https://evil.example/", "visible");
  const sw = loadSw({ tabs: [admin, other, hidden, visible] });
  const ev = sw.click({ nid: "n_abcdefgh1", url: "#/results", cat: "result" });
  await ev.work;
  assert.equal(ev.closed, true);
  assert.equal(visible.focused, 1, "the visible site tab is the one that gets focus");
  assert.deepEqual(plain(visible.messages), [{ type: "tvp-open", hash: "#/results" }]);
  for (const t of [hidden, admin, other]) { assert.equal(t.focused, 0); assert.deepEqual(plain(t.messages), []); }
  assert.deepEqual(sw.opened, []);
});

test("SW: tapping with the site closed opens THIS site at the page (and only this site)", async () => {
  const sw = loadSw({ tabs: [tab(`${SITE}/admin.html`), tab("https://evil.example/")] });
  const ev = sw.click({ nid: "n_abcdefgh1", url: "#/exam?id=x1", cat: "exam" });
  await ev.work;
  assert.deepEqual(sw.opened, [`${SITE}/#/exam?id=x1`]);
});

test("SW: a tampered destination in a notification is re-validated at tap time", async () => {
  for (const url of ["https://evil.example/", "javascript:alert(1)", "#/admin", undefined, 42]) {
    const sw = loadSw();
    const ev = sw.click({ nid: "n_abcdefgh1", url, cat: "exam" });
    await ev.work;
    assert.deepEqual(sw.opened, [`${SITE}/#/home`], String(url));
  }
});

test("SW: a notification that is not ours is left alone", () => {
  const sw = loadSw();
  for (const data of [undefined, null, {}, { url: "#/home" }, { nid: 42 }]) {
    const ev = sw.click(data);
    assert.equal(ev.closed, undefined);
    assert.equal(ev.work, undefined);
  }
  assert.deepEqual(sw.opened, []);
});

test("SW: installs and takes over at once (it is stateless); it never fetches anything itself", async () => {
  const sw = loadSw();
  sw.listeners.install[0]();
  assert.equal(sw.calls.skip, true);
  const ev = { waitUntil(p) { ev.p = p; } };
  sw.listeners.activate[0](ev);
  await ev.p;
  assert.equal(sw.calls.claimed, true);
  assert.doesNotMatch(SW_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
});

/* ==========================================================================
   Guarantees that span the feature
   ========================================================================== */
const quoted = (src, re) => { const m = src.match(re); assert.ok(m, `pattern ${re} not found`); return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]); };

test("ONE list of destinations: the worker, the page and the server allow exactly the same pages", () => {
  const sw = quoted(SW_SRC, /const ROUTES = \[([^\]]*)\]/);
  const page = quoted(read("js/push/push-core.js"), /export const ROUTES = \[([^\]]*)\]/);
  assert.deepEqual(sw, serverConfig.SITE_ROUTES);
  assert.deepEqual(page, serverConfig.SITE_ROUTES);
  assert.deepEqual(C.ROUTES, serverConfig.SITE_ROUTES);
});

test("every allowed destination is a real page of the student app — and the sign-in / admin pages are not among them", () => {
  const app = read("js/app.js");
  const routes = new Set([...app.matchAll(/^\s{4}([a-z]+):\s*(?:genericRoute|examRoute)/gm)].map((m) => m[1]));
  assert.ok(routes.size >= 15, `found ${routes.size} routes in app.js`);
  for (const r of C.ROUTES) assert.ok(routes.has(r), `#/${r} has no page in js/app.js`);
  for (const r of ["login", "signup", "admin", "404"]) assert.equal(C.ROUTES.includes(r), false, r);
});

test("ONE list of notification kinds: page and server agree", () => {
  assert.deepEqual([...C.CATEGORIES], [...serverConfig.CATEGORIES]);
  for (const c of C.CATEGORIES) { assert.ok(C.CATEGORY_LABEL[c]); assert.ok(C.CATEGORY_HINT[c]); }
});

/** Anything that would be a leaked server credential if it ever appeared in a file the browser downloads. */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
  [/"private_key"\s*:/, "a service-account private_key field"],
  [/"type"\s*:\s*"service_account"/, "a service-account file"],
  [/"client_email"\s*:\s*"[^"]*gserviceaccount\.com/, "a service-account client_email"],
  [/\bFIREBASE_SERVICE_ACCOUNT\b/, "the server's credential variable"],
  [/\bCRON_SECRET\b/, "the scheduler secret variable"],
  [/\bfirebase-admin\b/, "the server SDK"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{24,}/, "a hard-coded bearer token"],
  [/\bya29\.[A-Za-z0-9._-]{20,}/, "a Google OAuth access token"],
  [/\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140,}/, "a legacy FCM server key"],
];
const findSecrets = (text) => SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, what]) => what);

test("the secret scanner itself catches what it should (so a clean scan means something)", () => {
  assert.deepEqual(findSecrets("-----BEGIN PRIVATE KEY-----\nMIIE"), ["a PEM private key"]);
  assert.ok(findSecrets('{"type": "service_account", "private_key": "x"}').length >= 2);
  assert.ok(findSecrets("const k = process.env.FIREBASE_SERVICE_ACCOUNT").length === 1);
  assert.ok(findSecrets("headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }").length === 1);
  assert.ok(findSecrets("require('firebase-admin')").length === 1);
  assert.deepEqual(findSecrets("headers: { Authorization: `Bearer ${token}` }"), [], "a template that fills in the signed-in user's own token is fine");
  assert.deepEqual(findSecrets("apiKey: 'AIzaSyD-public-web-key'"), [], "Firebase's public web key is not a secret");
});

test("NO secret, key or server token in anything the browser downloads", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(js|css|html|webmanifest|json|svg)$/.test(name)) files.push(rel);
    }
  };
  for (const d of ["js", "css", "assets"]) walk(d);
  for (const f of ["index.html", "admin.html", "404.html", "offline.html", "manifest.webmanifest", "firebase-messaging-sw.js", "service-worker.js"]) files.push(f);
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  const hits = [];
  for (const f of files) for (const what of findSecrets(read(f))) hits.push(`${f}: ${what}`);
  // The places that merely TELL the admin which variable to set may name it (a name is not a secret — it is in .env.example too).
  // They may name the two variables and nothing else: no key, no token, no server SDK.
  const VARIABLE_NAMES = /credential variable|scheduler secret/;
  const explainers = new Set(["js/push/push-config.js", "js/push/push-admin-core.js", "js/admin/push/view-setup.js"]);
  const real = hits.filter((h) => { const i = h.indexOf(": "); return !(explainers.has(h.slice(0, i)) && VARIABLE_NAMES.test(h.slice(i + 2))); });
  assert.deepEqual(real, []);
  for (const f of explainers) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    assert.deepEqual(findSecrets(read(f)).filter((w) => !VARIABLE_NAMES.test(w)), [], `${f} may mention the variable names, nothing more`);
  }
});

test("the example environment file ships with placeholders only", () => {
  const env = read(".env.example");
  assert.deepEqual(findSecrets(env.replace(/FIREBASE_SERVICE_ACCOUNT(_B64)?|CRON_SECRET/g, "NAME")), []);
  for (const line of env.split("\n")) {
    const m = line.match(/^(FIREBASE_SERVICE_ACCOUNT(?:_B64)?|CRON_SECRET)=(.*)$/);
    if (m) assert.equal(m[2].trim(), "", `${m[1]} must be empty in the example file`);
  }
  assert.match(read(".gitignore"), /^\.env$/m, "the real .env must never be committed");
});

test("the page-side files never import the server SDK or the admin SDK", () => {
  for (const f of ["push-boot.js", "push-config.js", "push-core.js", "push-api.js", "push-student.js", "push-ui.js", "push-views.js"]) {
    const src = read(`js/push/${f}`);
    assert.doesNotMatch(src, /firebase-admin|require\(|google-auth-library|googleapis/, f);
    for (const m of src.matchAll(/import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./") || m[1].startsWith("../") || /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.13\.0\//.test(m[1]), `${f} imports ${m[1]}`);
    }
  }
});

test("the admin-side files never import the server SDK, never hold a secret, and only import local files or the pinned Firebase CDN", () => {
  const files = ["js/push/push-admin-core.js", "js/admin/push.js", ...fs.readdirSync(path.join(ROOT, "js/admin/push")).filter((f) => f.endsWith(".js")).map((f) => `js/admin/push/${f}`)];
  assert.ok(files.length >= 9, "the admin push modules were found");
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /firebase-admin|require\(|google-auth-library|googleapis|private_key|BEGIN PRIVATE KEY/, f);
    for (const m of src.matchAll(/import\s*(?:[^'"]*?from\s*)?["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./") || m[1].startsWith("../") || /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.13\.0\//.test(m[1]), `${f} imports ${m[1]}`);
    }
    assert.doesNotMatch(src, /initializeApp\s*\(/, `${f} must not start a second Firebase app`);
  }
});

test("ONE Firebase app: the student files reuse js/firebase-config.js and never initialise another", () => {
  for (const f of ["push-student.js", "push-api.js"]) {
    const src = read(`js/push/${f}`);
    assert.doesNotMatch(src, /initializeApp\s*\(/, f);
    assert.match(src, /from "\.\.\/firebase-config\.js"/, f);
  }
});

test("exactly one place opens the browser's permission dialog, and only from a button", () => {
  const hits = [];
  for (const f of fs.readdirSync(path.join(ROOT, "js/push"))) {
    const src = read(`js/push/${f}`);
    for (const m of src.matchAll(/requestPermission\s*\(/g)) hits.push(`${f}@${m.index}`);
  }
  assert.equal(hits.length, 1, hits.join(", "));
  assert.match(hits[0], /^push-student\.js@/);
  const student = read("js/push/push-student.js");
  const enable = student.slice(student.indexOf("export async function enable()"), student.indexOf("export async function disable()"));
  assert.match(enable, /requestPermission\(\)/);
  // it is the first thing enable() awaits (the click's "user activation" is still valid), nothing is awaited before it
  const before = enable.slice(0, enable.indexOf("await Notification.requestPermission"));
  assert.ok(before.length > 50, "found the call");
  assert.equal(/\bawait\b/.test(before), false);
  // and the only caller of enable() is a click handler
  const ui = read("js/push/push-ui.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");   // code only, not comments
  assert.equal([...ui.matchAll(/S\.enable\(\)/g)].length, 1);
  assert.match(ui, /case "enable": await onEnable\(\)/);
});

test("the worker file and the push files ship in the cache-safe places", () => {
  const sw = read("service-worker.js");
  assert.doesNotMatch(sw, /firebase-messaging-sw/, "the thin PWA worker must not know about (or cache) the push worker");
  assert.ok(fs.existsSync(path.join(ROOT, "assets/push/badge-72.png")));
  assert.ok(fs.existsSync(path.join(ROOT, "css/push.css")));
});
