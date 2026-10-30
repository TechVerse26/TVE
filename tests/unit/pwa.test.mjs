// Unit tests for the install experience: js/pwa-core.js (pure helpers), js/pwa-config.js and the static PWA files
// (manifest, icons, offline page, service worker). Run:  node --test tests/unit/pwa.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import * as C from "../../js/pwa-core.js";
import * as CONFIG from "../../js/pwa-config.js";

const root = (p) => new URL(`../../${p}`, import.meta.url);
const read = (p) => readFileSync(root(p), "utf8");

/* ---------- screenshot link ---------- */
test("resolvePreviewImageUrl: missing, placeholder and unsafe values are rejected", () => {
  for (const bad of [undefined, null, 42, "", "   ", "PASTE_MY_APP_SCREENSHOT_URL_HERE", "paste_anything", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://x/y.png", "blob:https://x/1"]) {
    assert.equal(C.resolvePreviewImageUrl(bad), null, String(bad));
  }
});

test("resolvePreviewImageUrl: a valid link is returned EXACTLY as written (only trimmed)", () => {
  const exact = [
    "https://i.ibb.co/abc123/app-screen.png",
    "https://example.com/a%20b.png?x=1&y=2#frag",
    "assets/pwa/screenshot.png",
    "/assets/shot.webp",
    "//cdn.example.com/x.jpg",
    "data:image/png;base64,iVBORw0KGgo=",
  ];
  for (const url of exact) assert.equal(C.resolvePreviewImageUrl(url), url);
  assert.equal(C.resolvePreviewImageUrl("  https://example.com/a.png \n"), "https://example.com/a.png");
});

test("pwa-config.js exposes the documented settings and ships with the placeholder", () => {
  assert.equal(typeof CONFIG.PWA_PREVIEW_IMAGE_URL, "string");
  assert.equal(CONFIG.PWA_PREVIEW_IMAGE_URL, "PASTE_MY_APP_SCREENSHOT_URL_HERE");
  assert.equal(C.resolvePreviewImageUrl(CONFIG.PWA_PREVIEW_IMAGE_URL), null);   // → the popup shows the neutral fallback
  assert.ok(CONFIG.PWA_PREVIEW_IMAGE_ALT.length > 5);
});

/* ---------- standalone detection ---------- */
const fakeWin = ({ modes = [], standalone, referrer = "" } = {}) => ({
  matchMedia: (q) => ({ matches: modes.some((m) => q === `(display-mode: ${m})`) }),
  navigator: { standalone },
  document: { referrer },
});

test("isStandaloneDisplay: installed-app signals are detected, plain tabs and browser fullscreen are not", () => {
  assert.equal(C.isStandaloneDisplay(fakeWin({ modes: ["standalone"] })), true);
  assert.equal(C.isStandaloneDisplay(fakeWin({ modes: ["minimal-ui"] })), true);
  assert.equal(C.isStandaloneDisplay(fakeWin({ modes: ["window-controls-overlay"] })), true);
  assert.equal(C.isStandaloneDisplay(fakeWin({ standalone: true })), true);                       // iOS Home-Screen app
  assert.equal(C.isStandaloneDisplay(fakeWin({ referrer: "android-app://com.example/" })), true); // trusted web activity
  assert.equal(C.isStandaloneDisplay(fakeWin({ modes: ["browser"] })), false);
  assert.equal(C.isStandaloneDisplay(fakeWin({ modes: ["fullscreen"] })), false);                 // F11 / video fullscreen ≠ installed
  assert.equal(C.isStandaloneDisplay(fakeWin()), false);
  assert.equal(C.isStandaloneDisplay(null), false);
  assert.equal(C.isStandaloneDisplay({ matchMedia() { throw new Error("blocked"); }, navigator: {}, document: {} }), false);
});

/* ---------- platform detection + guides ---------- */
const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
  iphoneInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 330.0.0.0.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  androidEdge: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0",
  androidFacebook: "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]",
  winChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
};
const detect = (ua, platform = "", maxTouchPoints = 0) => C.detectPlatform({ ua, platform, maxTouchPoints });

test("detectPlatform: iOS, iPadOS (desktop-class UA), Android and desktop are told apart", () => {
  assert.deepEqual(pick(detect(UA.iphoneSafari)), { isIOS: true, isAndroid: false, browser: "safari", inApp: false });
  assert.deepEqual(pick(detect(UA.iphoneChrome)), { isIOS: true, isAndroid: false, browser: "chrome", inApp: false });
  assert.deepEqual(pick(detect(UA.iphoneInstagram)), { isIOS: true, isAndroid: false, browser: "safari", inApp: true });
  assert.equal(detect(UA.macSafari, "MacIntel", 5).isIOS, true);                    // iPad pretending to be a Mac
  assert.equal(detect(UA.macSafari, "MacIntel", 0).isIOS, false);                   // a real Mac
  assert.deepEqual(pick(detect(UA.androidChrome)), { isIOS: false, isAndroid: true, browser: "chrome", inApp: false });
  assert.equal(detect(UA.androidSamsung).browser, "samsung");
  assert.equal(detect(UA.androidFirefox).browser, "firefox");
  assert.equal(detect(UA.androidEdge).browser, "edge");
  assert.equal(detect(UA.androidFacebook).inApp, true);
  assert.equal(detect(UA.winChrome).isDesktop, true);
  assert.equal(detect(UA.winEdge).browser, "edge");
  assert.equal(detect(UA.winFirefox).browser, "firefox");
  assert.equal(detect(UA.macSafari, "MacIntel", 0).browser, "safari");
  assert.equal(detect("").browser, "other");
});
function pick(p) { return { isIOS: p.isIOS, isAndroid: p.isAndroid, browser: p.browser, inApp: p.inApp }; }

test("getInstallGuide: iOS explains Share → Add to Home Screen; others get their own browser's steps", () => {
  const ios = C.getInstallGuide(detect(UA.iphoneSafari)).steps.join(" ");
  assert.match(ios, /Share/); assert.match(ios, /Add to Home Screen/);
  assert.match(C.getInstallGuide(detect(UA.iphoneChrome)).note, /iOS 16\.4/);
  assert.match(C.getInstallGuide(detect(UA.iphoneInstagram)).title, /Safari/);
  assert.match(C.getInstallGuide(detect(UA.androidChrome)).steps.join(" "), /Install app/);
  assert.match(C.getInstallGuide(detect(UA.androidSamsung)).steps.join(" "), /Home screen/);
  assert.match(C.getInstallGuide(detect(UA.androidFacebook)).title, /Chrome/);
  assert.match(C.getInstallGuide(detect(UA.winChrome)).steps.join(" "), /Install/);
  assert.match(C.getInstallGuide(detect(UA.winEdge)).steps.join(" "), /Apps/);
  assert.match(C.getInstallGuide(detect(UA.macSafari, "MacIntel", 0)).steps.join(" "), /Dock/);
  assert.match(C.getInstallGuide(detect(UA.winFirefox)).title, /Not available/);
});

test("getInstallGuide: every guide has steps, balanced **emphasis** markers and never claims success", () => {
  const platforms = [...Object.values(UA).map((ua) => detect(ua)), detect(""), detect(UA.macSafari, "MacIntel", 5)];
  for (const p of platforms) {
    const g = C.getInstallGuide(p);
    assert.ok(g.title && g.steps.length >= 1);
    for (const line of [...g.steps, g.note || ""]) {
      assert.equal(((line.match(/\*\*/g) || []).length) % 2, 0, line);
      assert.doesNotMatch(line, /installed successfully|you're all set/i);
    }
  }
});

/* ---------- static PWA files ---------- */
const pngSize = (p) => { const b = readFileSync(root(p)); assert.equal(b.toString("latin1", 1, 4), "PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test("manifest.webmanifest is valid, complete and every file it references exists with the right size", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.name, "Tech Verse Exam");
  assert.equal(m.short_name, "Tech Verse");
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "./"); assert.equal(m.scope, "./");
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i); assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  assert.notEqual(m.prefer_related_applications, true);

  const has = (size, purpose) => m.icons.some((i) => i.sizes === size && i.purpose === purpose && i.type === "image/png");
  assert.ok(has("192x192", "any") && has("512x512", "any"), "192 + 512 'any' icons");
  assert.ok(has("512x512", "maskable"), "a maskable icon");
  for (const icon of m.icons) {
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(icon.src), [w, h], icon.src);
  }
  for (const s of m.shortcuts) assert.match(s.url, /^\.\/#\/(exams|schedule|results)$/);   // routes that exist in app.js
  assert.deepEqual(pngSize("assets/pwa/apple-touch-icon.png"), [180, 180]);
});

test("index.html links the manifest, the Apple icon, the popup stylesheet and the early listener (once each)", () => {
  const html = read("index.html");
  for (const needle of ['rel="manifest" href="manifest.webmanifest"', 'rel="apple-touch-icon" href="assets/pwa/apple-touch-icon.png"', 'href="css/pwa-install.css"', 'src="js/pwa-early.js"']) {
    assert.equal(html.split(needle).length - 1, 1, needle);
  }
  assert.ok(html.indexOf("js/pwa-early.js") < html.indexOf("css/base.css"), "early listener comes first");
});

test("nav.js: the install icon is a plain .nav-icon-btn, rendered for signed-in AND signed-out visitors", () => {
  const nav = read("js/nav.js");
  assert.match(nav, /const INSTALL_BTN = `<button type="button" class="nav-icon-btn nav-install" data-pwa-install aria-label="[^"]+" title="[^"]+"/);
  assert.match(nav, /fa-solid fa-download/);
  assert.equal(nav.split("${INSTALL_BTN}").length - 1, 2, "once in the signed-in tools, once in the signed-out tools");
  assert.ok(nav.indexOf('nav-schedule') < nav.indexOf("${INSTALL_BTN}"), "directly after the Schedule icon");
});

test("service worker: scoped to the site, never caches pages/scripts/styles, never touches non-GET or cross-origin", () => {
  const sw = read("service-worker.js");
  assert.match(sw, /request\.method !== "GET"\) return;/);
  assert.match(sw, /url\.origin !== self\.location\.origin\) return;/);
  assert.match(sw, /request\.mode === "navigate"/);
  assert.match(sw, /offline\.html/);
  // the only things ever stored: offline.html (install) and same-origin images under /assets/ (runtime)
  assert.equal((sw.match(/\.addAll\(/g) || []).length, 0, "no bulk precache list");
  assert.equal((sw.match(/\.add\(/g) || []).length, 1, "exactly one precached file …");
  assert.match(sw, /cache\.add\(new Request\(OFFLINE_URL/);                 // … and it is the offline page
  assert.equal((sw.match(/\.put\(/g) || []).length, 1, "exactly one runtime cache write …");
  assert.match(sw, /request\.destination === "image" && url\.pathname\.startsWith\(IMAGE_PREFIX\)/);   // … and it is for /assets/ images only
  assert.ok(existsSync(root("offline.html")));
  const offline = read("offline.html");
  assert.doesNotMatch(offline, /<link[^>]+href="https?:/); assert.doesNotMatch(offline, /<script[^>]+src=/);   // fully self-contained
});

test("app.js loads the PWA modules in isolation (a failure there can never stop the site)", () => {
  const app = read("js/app.js");
  assert.match(app, /import\("\.\/pwa-install\.js"\)[^\n]*\.catch\(/);
  assert.match(app, /import\("\.\/pwa-register\.js"\)[^\n]*\.catch\(/);
  assert.doesNotMatch(app, /^import .*pwa-/m);
});
