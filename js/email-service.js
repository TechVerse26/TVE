// ==========================================================================
// email-service.js — the ONLY file that talks to EmailJS.
//
//   SDK        the official browser SDK  @emailjs/browser  (pinned below), loaded on demand from jsDelivr — no build step,
//              nothing is downloaded until someone opens the Email Center and sends.
//   API used   emailjs.send(serviceID, templateID, templateParams, { publicKey })  →  Promise<{ status, text }>
//              success = status 200 "OK" (the REQUEST WAS ACCEPTED — not a promise that the inbox received it);
//              failure = a rejected EmailJSResponseStatus { status, text }, or a plain Error when there was no answer.
//   Limits     EmailJS documents 1 request per second per account → the queue below is strictly sequential,
//              ≥ 1.1 s apart, and backs off on HTTP 429. Nothing here sends in parallel.
//   Secrets    only the PUBLIC key is ever used in the browser. A private key / accessToken must never be put here.
//
// Everything that can be tested without a browser is exported as a pure function (config checks, error
// classification, the queue) and takes its dependencies (sdk, sleep, now) as arguments.
// ==========================================================================
import { isValidEmail, safeHttpUrl, hash32, DEFAULT_TZ, oneLine } from "./email-core.js";

export const SDK_VERSION = "4.4.1";
export const SDK_URL = `https://cdn.jsdelivr.net/npm/@emailjs/browser@${SDK_VERSION}/dist/email.min.js`;
export const MIN_INTERVAL_MS = 1000;        // EmailJS: 1 request / second
export const DEFAULT_INTERVAL_MS = 1100;    // a small safety margin on top
export const MAX_INTERVAL_MS = 10000;
export const REQUEST_TIMEOUT_MS = 25000;

/* ==========================================================================
   Settings (Firestore: emailSettings/main — only admins who may manage e-mail can read it)
   ========================================================================== */
export const DEFAULT_SETTINGS = Object.freeze({
  serviceId: "", templateId: "", publicKey: "",
  senderName: "Tech Verse Exam",
  replyTo: "",            // empty → the support address of js/footer-config.js is used
  intervalMs: DEFAULT_INTERVAL_MS,
  safetyCap: 0,           // 0 = no cap; otherwise a campaign with more recipients than this cannot be started
  timeZone: DEFAULT_TZ,
  testEmail: "",
  showLogo: true,         // false → a plain text wordmark in the header instead of an image
  logoUrl: "",            // optional https image URL; empty → the site's own assets/email-logo.png (website from footer-config.js)
  lastTest: null,         // { ok, at, fp, to, status, text } — the last real test request and the config it ran with
});

const intIn = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
export function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const lt = r.lastTest && typeof r.lastTest === "object"
    ? { ok: r.lastTest.ok === true, at: Number(r.lastTest.at) || 0, fp: s(r.lastTest.fp, 16), to: s(r.lastTest.to, 254), status: Number(r.lastTest.status) || 0, text: s(r.lastTest.text, 200) }
    : null;
  return {
    serviceId: s(r.serviceId, 100), templateId: s(r.templateId, 100), publicKey: s(r.publicKey, 120),
    senderName: s(r.senderName, 80) || DEFAULT_SETTINGS.senderName,
    replyTo: s(r.replyTo, 254),
    intervalMs: intIn(r.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    safetyCap: intIn(r.safetyCap, 0, 100000, 0),
    timeZone: s(r.timeZone, 60) || DEFAULT_TZ,
    testEmail: s(r.testEmail, 254),
    showLogo: r.showLogo !== false,
    logoUrl: s(r.logoUrl, 500),
    lastTest: lt,
  };
}

const idLike = (v) => /^[A-Za-z0-9_-]{3,100}$/.test(v);
const validZone = (z) => { try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; } };

/** What is wrong with the configuration. `required: true` problems stop all sending. */
export function settingsIssues(s) {
  const out = [];
  const need = (field, label, value) => {
    if (!value) out.push({ field, required: true, message: `${label} দেওয়া হয়নি` });
    else if (!idLike(value)) out.push({ field, required: true, message: `${label} ঠিক নয় (শুধু অক্ষর, সংখ্যা, _ ও - থাকতে পারে, ফাঁকা নয়)` });
  };
  need("serviceId", "Service ID", s.serviceId);
  need("templateId", "Template ID", s.templateId);
  need("publicKey", "Public Key", s.publicKey);
  if (s.replyTo && !isValidEmail(s.replyTo)) out.push({ field: "replyTo", required: true, message: "Reply-to ইমেইল ঠিক নয়" });
  if (s.testEmail && !isValidEmail(s.testEmail)) out.push({ field: "testEmail", required: false, message: "টেস্ট ইমেইল ঠিকানা ঠিক নয়" });
  if (s.logoUrl && !safeHttpUrl(s.logoUrl)) out.push({ field: "logoUrl", required: false, message: "লোগো URL ঠিক নয় (https://… হতে হবে)" });
  if (!validZone(s.timeZone)) out.push({ field: "timeZone", required: true, message: "Time zone ঠিক নয় (যেমন Asia/Dhaka)" });
  if (s.serviceId && idLike(s.serviceId) && !/^service_/i.test(s.serviceId) && s.serviceId !== "default_service") out.push({ field: "serviceId", required: false, message: "সাধারণত Service ID “service_…” দিয়ে শুরু হয় — Dashboard থেকে ঠিকঠাক কপি করেছেন তো?" });
  if (s.templateId && idLike(s.templateId) && !/^template_/i.test(s.templateId)) out.push({ field: "templateId", required: false, message: "সাধারণত Template ID “template_…” দিয়ে শুরু হয়" });
  return out;
}
export const isConfigured = (s) => !settingsIssues(s).some((i) => i.required);
/** Identifies the (service, template, key) combination — a test result only counts for the config it ran with. */
export const configFingerprint = (s) => hash32(`${s.serviceId}|${s.templateId}|${s.publicKey}`);
export const isTested = (s) => !!(s.lastTest && s.lastTest.ok && s.lastTest.fp === configFingerprint(s));
export const maskKey = (k) => { const v = String(k || ""); return v.length <= 8 ? (v ? "••••••" : "") : `${v.slice(0, 3)}${"•".repeat(Math.min(10, v.length - 6))}${v.slice(-3)}`; };

/* ==========================================================================
   SDK loading
   ========================================================================== */
let sdkPromise = null;
export function loadSdk({ url = SDK_URL } = {}) {
  if (typeof window !== "undefined" && window.emailjs && typeof window.emailjs.send === "function") return Promise.resolve(window.emailjs);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url; el.async = true; el.crossOrigin = "anonymous"; el.dataset.emailjsSdk = SDK_VERSION;
    el.onload = () => (window.emailjs && typeof window.emailjs.send === "function" ? resolve(window.emailjs) : (sdkPromise = null, reject(new Error("EmailJS SDK loaded but window.emailjs is missing"))));
    el.onerror = () => { sdkPromise = null; el.remove(); reject(new Error("EmailJS SDK could not be loaded (offline, or blocked by the browser)")); };
    document.head.appendChild(el);
  });
  return sdkPromise;
}

/* ==========================================================================
   One request, and what its outcome means
   ========================================================================== */
/**
 * kind "failed"    EmailJS ANSWERED with an error → the e-mail was refused → safe to retry later.
 * kind "uncertain" there was NO answer (timeout / network drop) → it may or may not have been sent → never retry blindly.
 */
export function classifyError(err) {
  const status = Number(err?.status);
  const text = oneLine(err?.text ?? err?.message ?? "", 300);
  if (err?.sdkError) return { kind: "failed", status: 0, text, fatal: true, reason: "sdk" };
  if (Number.isFinite(status) && status > 0) {
    if (status === 429) return { kind: "failed", status, text, rateLimited: true, reason: "rate_limited" };
    if (status === 401 || status === 403 || status === 451) return { kind: "failed", status, text, fatal: true, reason: "not_allowed" };
    if (status >= 500) return { kind: "failed", status, text, reason: "server" };
    return { kind: "failed", status, text, reason: "refused" };
  }
  if (err?.timeout) return { kind: "uncertain", status: 0, text: "No answer from EmailJS within the time limit", reason: "timeout" };
  return { kind: "uncertain", status: 0, text: text || "Network error — no answer from EmailJS", reason: "network" };
}

/** A short, plain explanation for the admin (Bangla), always followed by EmailJS' own words in the UI. */
export function explainOutcome(o) {
  if (!o || o.ok) return "";
  switch (o.reason) {
    case "sdk": return "EmailJS SDK লোড হয়নি — ইন্টারনেট/ব্লকার দেখুন। কোনো ইমেইল পাঠানো হয়নি।";
    case "rate_limited": return "EmailJS রেট লিমিট (প্রতি সেকেন্ডে ১টি) — গতি কমিয়ে আবার চেষ্টা করুন।";
    case "not_allowed": return "EmailJS অনুরোধ আটকে দিয়েছে (401/403/451) — Public Key, Allowed domains এবং Account → Security সেটিং দেখুন।";
    case "server": return "EmailJS সার্ভারে সাময়িক সমস্যা — পরে আবার চেষ্টা করুন।";
    case "refused": return "EmailJS অনুরোধটি গ্রহণ করেনি — Service/Template ID, প্রাপকের ঠিকানা বা সংযুক্ত ইমেইল সার্ভিসের অনুমতি দেখুন (নিচে EmailJS-এর বার্তা)।";
    case "timeout": return "সময়মতো কোনো উত্তর আসেনি — ইমেইলটি গিয়ে থাকতেও পারে, নাও পারে। আবার পাঠানোর আগে EmailJS Dashboard → Email History দেখুন।";
    case "network": return "নেটওয়ার্ক সমস্যা — কোনো উত্তর আসেনি। ইমেইলটি গিয়েছে কিনা নিশ্চিত নয়।";
    default: return "";
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { timeout: true })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Send one e-mail. Never throws — always resolves to { ok, kind, status, text, … }. */
export async function sendOne(settings, params, { sdk = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let api = sdk;
  if (!api) {
    try { api = await loadSdk(); } catch (err) { return { ok: false, ...classifyError({ message: err.message, sdkError: true }) }; }
  }
  try {
    const res = await withTimeout(Promise.resolve(api.send(settings.serviceId, settings.templateId, params, { publicKey: settings.publicKey })), timeoutMs);
    const status = Number(res?.status);
    if (status >= 200 && status < 300) return { ok: true, kind: "accepted", status, text: oneLine(res?.text || "OK", 100) };
    return { ok: false, ...classifyError(res && Number.isFinite(status) ? res : { message: "Unexpected answer from EmailJS" }) };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

/* ==========================================================================
   The controlled queue
   ========================================================================== */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends `items` ONE AT A TIME, never closer together than `intervalMs`.
 *   send(item)     → Promise<outcome> (use sendOne). Must not throw.
 *   shouldStop()   → true once the admin pressed Stop (checked before every request; the request in flight finishes).
 *   onUpdate(ev)   → { type: "start" | "done" | "wait", … } for progress UIs and for persisting results.
 * HTTP 429 is retried up to `maxRateRetries` times with a growing pause (the request was REFUSED, so a retry cannot duplicate).
 * Nothing else is retried automatically. After `breakAfter` identical consecutive failures the run stops: that is a
 * configuration problem, not bad luck, and hammering EmailJS would only burn the quota.
 */
export async function runQueue({
  items, send, intervalMs = DEFAULT_INTERVAL_MS, shouldStop = () => false, onUpdate = () => {},
  sleep = defaultSleep, now = Date.now, maxRateRetries = 3, rateBackoffMs = 2500, breakAfter = 3,
}) {
  const gap = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  let last = 0, processed = 0, stopped = false, tripped = null, streak = 0, sig = "";
  for (let i = 0; i < items.length; i++) {
    if (shouldStop()) { stopped = true; break; }
    const wait = last ? Math.max(0, last + gap - now()) : 0;
    if (wait) { onUpdate({ type: "wait", ms: wait }); await sleep(wait); }
    if (shouldStop()) { stopped = true; break; }
    onUpdate({ type: "start", item: items[i], index: i });
    let outcome, tries = 0;
    for (;;) {
      const before = last;
      last = now();
      outcome = await send(items[i]);
      if (outcome.skipped) last = before; // nothing was sent (e.g. the student submitted meanwhile) → no need to wait before the next one
      tries++;
      if (!outcome.ok && outcome.rateLimited && tries <= maxRateRetries && !shouldStop()) {
        const pause = rateBackoffMs * tries;
        onUpdate({ type: "wait", ms: pause, reason: "rate_limited" });
        await sleep(pause);
        continue;
      }
      break;
    }
    processed++;
    onUpdate({ type: "done", item: items[i], index: i, outcome, tries });
    if (outcome.skipped) continue;
    if (!outcome.ok && outcome.kind === "failed") {
      const now_sig = `${outcome.status}|${outcome.text}`;
      streak = now_sig === sig ? streak + 1 : 1;
      sig = now_sig;
      if (streak >= breakAfter || outcome.fatal) { tripped = { status: outcome.status, text: outcome.text, reason: outcome.reason, streak }; break; }
    } else { streak = 0; sig = ""; }
  }
  return { processed, stopped, tripped, remaining: items.length - processed };
}

/** Rough, honest duration of a run: n requests at one per `intervalMs`. */
export const estimateMs = (n, intervalMs = DEFAULT_INTERVAL_MS) => Math.max(0, n) * Math.max(MIN_INTERVAL_MS, intervalMs);
