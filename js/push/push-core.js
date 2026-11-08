// ==========================================================================
// push-core.js — the pure rules of the student side of push notifications.
// No DOM, no network, no Firebase here, so every rule below is unit-tested in plain Node (tests/unit/push.test.mjs).
// ==========================================================================

/* ---------- where a notification may lead (mirrors server/push/validate.js and firebase-messaging-sw.js) ---------- */
export const ROUTES = ["home", "exam", "exams", "categories", "schedule", "notifications", "leaderboard", "performance", "results", "profile", "about", "faq", "help", "privacy", "terms", "credits"];
export const CATEGORIES = ["announcement", "exam", "result"];
export const CATEGORY_LABEL = { announcement: "ঘোষণা", exam: "পরীক্ষা", result: "ফলাফল" };
export const CATEGORY_HINT = {
  announcement: "নোটিশ ও জরুরি ঘোষণা",
  exam: "নতুন পরীক্ষা, সময়সূচি ও রিমাইন্ডার",
  result: "ফলাফল প্রকাশের খবর",
};
const ROUTE_RE = new RegExp(`^#/(?:${ROUTES.join("|")})(?:\\?[A-Za-z0-9_=&%.-]{1,200})?$`);

/** "#/results" → "#/results"; anything that is not a known page of this site → "" */
export function safeRoute(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  return s.length <= 260 && ROUTE_RE.test(s) ? s : "";
}

const clip = (v, max, keepNewlines) => {
  if (typeof v !== "string") return "";
  const flat = keepNewlines ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ") : v.replace(/[\u0000-\u001F\u007F]/g, " ");
  return Array.from(flat.trim()).slice(0, max).join("");
};

/** The data part of a message that reached an OPEN page → what is safe to show, or null (not ours / malformed). */
export function normalizeIncoming(d) {
  if (!d || typeof d !== "object") return null;
  const nid = typeof d.nid === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(d.nid) ? d.nid : "";
  const title = clip(d.title, 120, false);
  if (!nid || !title) return null;
  const ts = Number(d.ts);
  return {
    nid, title, body: clip(d.body, 400, true), url: safeRoute(d.url) || "#/home",
    cat: CATEGORIES.includes(d.cat) ? d.cat : "announcement", ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
  };
}

/* ---------- this device ---------- */
/** A random, URL-safe id for this browser profile (the server stores it only as part of a hash with the student's id). */
export function randomKey(cryptoObj = globalThis.crypto, bytes = 24) {
  const a = new Uint8Array(bytes);
  if (cryptoObj && cryptoObj.getRandomValues) cryptoObj.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256); // very old browsers only; the key is not a secret
  let bin = "";
  a.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const OS = [[/android/i, "android", "Android"], [/iphone|ipad|ipod/i, "ios", "iPhone/iPad"], [/windows/i, "windows", "Windows"], [/cros/i, "chromeos", "Chromebook"],
  [/macintosh|mac os x/i, "mac", "Mac"], [/linux|x11/i, "linux", "Linux"]];
const BROWSERS = [[/edg(e|a|ios)?\//i, "edge", "Edge"], [/opr\/|opera/i, "opera", "Opera"], [/samsungbrowser/i, "samsung", "Samsung Internet"],
  [/firefox|fxios/i, "firefox", "Firefox"], [/chrome|crios|chromium/i, "chrome", "Chrome"], [/safari/i, "safari", "Safari"]];

/** { platform, browser, standalone, label } — a readable name for "my devices" (e.g. "Chrome · Android"). */
export function detectDevice({ ua = "", standalone = false, touchPoints = 0, navPlatform = "" } = {}) {
  let os = OS.find(([re]) => re.test(ua));
  if (!os && navPlatform === "MacIntel" && touchPoints > 1) os = OS[1];                 // iPadOS asks for the desktop site
  if (os && os[1] === "mac" && touchPoints > 1) os = OS[1];
  const br = BROWSERS.find(([re]) => re.test(ua));
  const platform = os ? os[1] : "other";
  const browser = br ? br[1] : "other";
  const label = `${br ? br[2] : "Browser"} · ${os ? os[2] : "Device"}${standalone ? " (app)" : ""}`.slice(0, 60);
  return { platform, browser, standalone: !!standalone, label };
}

/** Can this device receive push at all?  → { ok, reason }   (reason: ok · insecure · ios-install · no-sw · no-push) */
export function supportState({ secure, hasSW, hasPush, hasNotification, ios, standalone }) {
  if (!secure) return { ok: false, reason: "insecure" };
  if (ios && !standalone) return { ok: false, reason: "ios-install" };      // iPhone / iPad: Web Push exists only inside the installed app
  if (!hasSW) return { ok: false, reason: "no-sw" };
  if (!hasPush || !hasNotification) return { ok: false, reason: "no-push" };
  return { ok: true, reason: "ok" };
}

/* ---------- when may we ask? ---------- */
export const PROMPT_ROUTES = new Set(["home", "notifications", "schedule", "exams"]);
const DAY = 86400000;
/** After a "not now" the card stays away this long; the 3rd time it never returns by itself (the settings entry remains). */
export const promptBackoffMs = (n) => (n <= 0 ? 0 : n === 1 ? 7 * DAY : n === 2 ? 30 * DAY : Infinity);

/**
 * Should the explaining card be shown right now?  → { show, reason }
 * Every rule is a reason NOT to disturb the student; the first one that applies wins.
 */
export function promptDecision(s) {
  if (!s.configured) return { show: false, reason: "not-configured" };
  if (!s.support || !s.support.ok) return { show: false, reason: "unsupported" };
  if (!s.signedIn) return { show: false, reason: "signed-out" };
  if (s.permission === "denied") return { show: false, reason: "denied" };          // never nag about something the browser blocks
  if (s.enabledHere) return { show: false, reason: "already-on" };
  if (s.examTaking || s.overlayOpen || s.resumeBar) return { show: false, reason: "busy" };   // an exam, a dialog or an unfinished attempt comes first
  if (!PROMPT_ROUTES.has(s.route)) return { show: false, reason: "route" };
  const rec = s.rec || {};
  if (rec.never) return { show: false, reason: "never" };
  if ((s.visits || 0) < 2) return { show: false, reason: "too-early" };             // not on a first visit
  if (rec.n > 0 && s.now - (rec.at || 0) < promptBackoffMs(rec.n)) return { show: false, reason: "cooling-down" };
  return { show: true, reason: "ok" };
}

export const afterLater = (rec, now) => ({ n: ((rec && rec.n) || 0) + 1, at: now, never: false });
export const afterNever = (rec, now) => ({ n: ((rec && rec.n) || 0) + 1, at: now, never: true });

/* ---------- words ---------- */
export const ERR = {
  not_configured: "নোটিফিকেশন সুবিধা এখনো চালু করা হয়নি।",
  unsupported: "এই ব্রাউজারে পুশ নোটিফিকেশন কাজ করে না।",
  permission_denied: "ব্রাউজার অনুমতি দেয়নি। চাইলে ব্রাউজারের সাইট সেটিংস থেকে পরে চালু করতে পারবেন।",
  permission_dismissed: "অনুমতির বার্তাটি বন্ধ করা হয়েছে। চাইলে আবার চেষ্টা করতে পারেন।",
  sw_failed: "নোটিফিকেশন সার্ভিস চালু করা যায়নি। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।",
  fcm_failed: "নোটিফিকেশন নিবন্ধন করা যায়নি। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
  vapid_invalid: "পুশ কী (VAPID) ঠিক নেই — সাইটের মালিককে জানান।",
  network: "ইন্টারনেট সংযোগ নেই — সংযোগ ফিরলে আবার চেষ্টা করুন।",
  timeout: "সার্ভার সাড়া দিতে দেরি করছে — আবার চেষ্টা করুন।",
  unauthenticated: "আবার লগইন করুন।",
  token_expired: "সেশন শেষ হয়ে গেছে — পেজ রিফ্রেশ করুন।",
  invalid_token: "আবার লগইন করুন।",
  token_revoked: "আবার লগইন করুন।",
  account_disabled: "এই অ্যাকাউন্ট নিষ্ক্রিয় করা আছে।",
  rate_limited: "অনেকবার চেষ্টা হয়েছে — একটু পরে আবার চেষ্টা করুন।",
  server_not_configured: "নোটিফিকেশন সার্ভার এখনো প্রস্তুত নয়।",
  firestore_quota: "আজকের ফ্রি সীমা শেষ — কাল আবার চেষ্টা করুন।",
  auth_unavailable: "লগইন যাচাই করা যাচ্ছে না — একটু পরে আবার চেষ্টা করুন।",
  device_not_found: "এই ডিভাইস এখনো নিবন্ধিত নয়।",
  internal_error: "সার্ভারে সমস্যা হয়েছে — পরে আবার চেষ্টা করুন।",
};
export const errorText = (code) => ERR[code] || (/^http_(404|405)$/.test(code || "") ? ERR.server_not_configured : "কিছু একটা সমস্যা হয়েছে — আবার চেষ্টা করুন।");

/** Map a Firebase Messaging / browser error to one of our codes. */
export function classifyFcmError(err) {
  const text = `${String((err && (err.code || err.name)) || "")} ${String((err && err.message) || "")}`;
  if (/permission-blocked|NotAllowedError/i.test(text)) return "permission_denied";
  if (/unsupported-browser/i.test(text)) return "unsupported";
  if (/vapid|applicationServerKey|InvalidAccessError/i.test(text)) return "vapid_invalid";
  if (/service-?worker/i.test(text)) return "sw_failed";
  return "fcm_failed";
}

/** "5 মিনিট আগে" etc. — tiny, for the device list. */
export function agoBn(ms, now = Date.now()) {
  const bn = (n) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);
  const s = Math.max(0, (now - ms) / 1000);
  if (!ms || s < 60) return "এইমাত্র";
  if (s < 3600) return `${bn(Math.floor(s / 60))} মিনিট আগে`;
  if (s < 86400) return `${bn(Math.floor(s / 3600))} ঘণ্টা আগে`;
  return `${bn(Math.floor(s / 86400))} দিন আগে`;
}
