// ==========================================================================
// auth-reset-core.js — the pure rules behind "Forgot password?" (login page).
//
// No DOM, no Firebase, no storage, no clock — tests/unit/reset.test.mjs runs it in Node.
// The browser side is auth.js (sendPasswordReset) and page-login.js (the panel).
//
// Design decisions
//   • An unknown email looks EXACTLY like a known one ("if an account exists, a link was sent").
//     Telling the two apart would let anyone probe which emails have an account.
//   • A resend is held back for a minute per address (and five minutes after Firebase says
//     "too many requests"), so a nervous double-tap can't flood an inbox or trip Firebase's limiter.
//   • A mistyped domain (gmial.com, gmail.con …) is caught BEFORE sending — on a phone keyboard
//     this is by far the commonest reason a reset mail "never arrives".
// ==========================================================================

export const RESET_COOLDOWN_MS = 60 * 1000;
export const RESET_FLOOD_COOLDOWN_MS = 5 * 60 * 1000;

/** Invisible characters that creep in when an address is pasted from a chat or a PDF. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00A0]/g;
/** Deliberately loose — Firebase is the real validator; this only stops obvious slips before a network call. */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\"]+\.[^\s@,;:<>()[\]\\".]{2,}$/;

export function normalizeEmail(raw) {
  return String(raw ?? "").replace(INVISIBLE, "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** domain typo → the domain people meant */
const DOMAIN_FIXES = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmil.com": "gmail.com", "gamil.com": "gmail.com", "gmail.co": "gmail.com",
  "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com", "gmaill.com": "gmail.com", "gnail.com": "gmail.com",
  "gmail.comm": "gmail.com", "gmail.vom": "gmail.com", "gmail.xom": "gmail.com", "gmeil.com": "gmail.com", "gimail.com": "gmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com", "yhoo.com": "yahoo.com", "yahoo.co": "yahoo.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotnail.com": "hotmail.com",
  "outlok.com": "outlook.com", "outlook.con": "outlook.com", "outllook.com": "outlook.com",
  "icloud.con": "icloud.com", "iclould.com": "icloud.com",
};

/** "rahim@gmial.com" → "rahim@gmail.com"; "" when nothing looks wrong. */
export function suggestEmailFix(raw) {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  if (at < 1) return "";
  const fixed = DOMAIN_FIXES[email.slice(at + 1)];
  return fixed ? `${email.slice(0, at)}@${fixed}` : "";
}

/**
 * What the student typed → { ok, email, error, suggestion }.
 * `error` is a Bengali sentence for the field; `suggestion` (only when ok) is a likely-intended address.
 */
export function validateResetEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, email, error: "ইমেইল ঠিকানা লিখুন।", suggestion: "" };
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, email, error: "ইমেইল ঠিকানাটি সঠিক মনে হচ্ছে না — এভাবে লিখুন: name@gmail.com", suggestion: "" };
  }
  return { ok: true, email, error: "", suggestion: suggestEmailFix(email) };
}

/* ---------- Firebase error codes ---------- */

/** The "continue URL" (where Firebase's mail sends the student afterwards) was refused → just send without it. */
export function isContinueUrlProblem(code) {
  return code === "auth/unauthorized-continue-uri" || code === "auth/invalid-continue-uri" || code === "auth/missing-continue-uri";
}

/** Where the mail's "continue" button should lead: this very site's login screen. "" when there is no real web origin (file://). */
export function buildContinueUrl({ protocol, origin, pathname } = {}) {
  if (protocol !== "https:" && protocol !== "http:") return "";
  if (!origin || origin === "null") return "";
  return `${origin}${pathname || "/"}#/login`;
}

/**
 * Firebase error code ("" = success) → what the panel does.
 *   kind "sent"  → show the "check your inbox" state (also for an unknown email — see the header comment)
 *   kind "error" → show `message` under the field; `cooldownMs` > 0 holds the button back
 */
export function resetOutcome(code) {
  const err = (message, cooldownMs = 0) => ({ kind: "error", message, cooldownMs });
  switch (code || "") {
    case "":
    case "auth/user-not-found":
      return { kind: "sent", message: "", cooldownMs: RESET_COOLDOWN_MS };
    case "auth/invalid-email":
    case "auth/missing-email":
      return err("ইমেইল ঠিকানাটি সঠিক নয় — আবার দেখে লিখুন।");
    case "auth/too-many-requests":
      return err("অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।", RESET_FLOOD_COOLDOWN_MS);
    case "auth/network-request-failed":
      return err("ইন্টারনেট সংযোগ নেই বা খুব দুর্বল। সংযোগ দেখে আবার চেষ্টা করুন।");
    case "auth/operation-not-allowed":
      return err("এই মুহূর্তে পাসওয়ার্ড রিসেট চালু নেই। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।");
    case "auth/user-disabled":
      return err("এই অ্যাকাউন্টটি নিষ্ক্রিয় করা আছে। অ্যাডমিনের সাথে যোগাযোগ করুন।");
    default:
      return err("রিসেট লিংক পাঠানো যায়নি। একটু পরে আবার চেষ্টা করুন।");
  }
}

/* ---------- Resend cooldown ---------- */

/**
 * What is kept between page loads (so a refresh cannot skip the wait): the address, when the wait ends, and WHY we wait —
 * "sent" (a mail is on its way: say so instead of sending another) or "flood" (Firebase refused: hold the button back).
 */
export const cooldownRecord = (email, now, ms, kind = "sent") => ({ email: normalizeEmail(email), until: now + Math.max(0, ms), kind: kind === "flood" ? "flood" : "sent" });

/** Milliseconds this address still has to wait (0 = it may be sent now). Another address is never held back by this one. */
export function cooldownLeft(record, email, now) {
  if (!record || typeof record.until !== "number" || !Number.isFinite(record.until)) return 0;
  if (record.email !== normalizeEmail(email)) return 0;
  const left = record.until - now;
  // A record from the far future (device clock fiddled with) is ignored rather than trusted.
  return left > 0 && left <= RESET_FLOOD_COOLDOWN_MS ? left : 0;
}

/** 45000 → "0:45", 125000 → "2:05". */
export function waitLabel(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
