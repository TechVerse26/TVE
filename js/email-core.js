// ==========================================================================
// email-core.js — the pure logic of the Email Center.
//
// No DOM, no Firebase, no network, no clock reads (the caller passes `now`), so the same code runs in the
// admin panel and in the Node unit tests (tests/unit/email.test.mjs).
//
// What lives here
//   1. small helpers      e-mail validation, escaping, safe URLs, date/time wording (English / বাংলা / both)
//   2. students           users/{uid} → a normalised student, account + enrolment eligibility
//   3. exams              which campaign types make sense for an exam that is open / upcoming / closed …
//   4. classification     "submitted / started but no submission / not attempted / excluded / could not verify"
//   5. variables          the {{template_variables}} and where every one of them comes from
//   6. campaign rows      the per-recipient delivery model (pending / accepted / failed / uncertain / skipped)
//   7. validation, fingerprint, CSV
//
// Rendering of the e-mail itself (markup → HTML / plain text) is in email-render.js; talking to EmailJS is in
// email-service.js; Firestore is in admin/email/store.js.
// ==========================================================================
import { examWindow, windowState, isExamVisibleTo, isDraftExam, toMs, toBnDigits } from "./schedule-core.js";

export const BRAND = "Tech Verse Exam";

/* ==========================================================================
   1. Small helpers
   ========================================================================== */
export const LANGUAGES = Object.freeze({ en: "English", bn: "বাংলা", both: "English + বাংলা" });
export const normLang = (l) => (l === "bn" || l === "both" ? l : "en");
/** One sentence in the campaign language: English, Bangla, or both ("English / বাংলা"). */
export const pick = (lang, en, bn) => (lang === "bn" ? bn : lang === "both" ? `${en} / ${bn}` : en);

export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export const stripTags = (html) => String(html ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
/** A header-safe single line (no CR/LF — they could otherwise smuggle extra mail headers). */
export const oneLine = (s, max = 200) => String(s ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

/** Strict, practical address check: one "@", no spaces / control characters / brackets / commas, a dotted domain. */
export function isValidEmail(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 254) return false;
  if (/[\s\u0000-\u001f<>(),;:\\"[\]]/.test(s)) return false;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) return false;
  return /\.[a-z]{2,}$/i.test(domain);
}

/** The URL as a normalised string if it is http(s), else "". javascript:, data:, file: … never pass. */
export function safeHttpUrl(value) {
  const s = String(value ?? "").trim();
  if (!s || /[\s<>"']/.test(s)) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch { return ""; }
}

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");
export const clean = (v) => { const s = String(v ?? "").trim(); return s ? s : null; };

/** Small, stable hash (FNV-1a, 32 bit) → 8 hex chars. Used to spot "the same campaign again" — not for security. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/* ---------- date / time wording ---------- */
export const DEFAULT_TZ = "Asia/Dhaka";
const fmtCache = new Map();
function formatter(zone, locale, opts) {
  const key = `${zone}|${locale}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: zone, ...opts }); fmtCache.set(key, f); }
  return f;
}
function fmtIntl(ms, tz, locale, opts) {
  const make = (zone) => formatter(zone, locale, opts).format(new Date(ms));
  try { return make(tz || DEFAULT_TZ); } catch { try { return make("UTC"); } catch { return new Date(ms).toISOString(); } }
}
/** "Sunday 25 October 2026" · "রবিবার, ২৫ অক্টোবর ২০২৬" · both. */
export function fmtDateLong(ms, tz, lang) {
  if (!Number.isFinite(ms)) return null;
  const o = { weekday: "long", day: "numeric", month: "long", year: "numeric" };
  const en = fmtIntl(ms, tz, "en-GB", o);
  const bn = fmtIntl(ms, tz, "bn-BD", o);
  return lang === "bn" ? bn : lang === "both" ? `${en} / ${bn}` : en;
}
/** "10:00 AM GMT+6" (Bangla: "১০:০০ AM (বাংলাদেশ সময়)" when the zone is Asia/Dhaka). */
const upperDayPeriod = (s) => s.replace(/\b(am|pm)\b/g, (m) => m.toUpperCase());
function zoneNameEn(ms, tz) {
  const parts = (() => { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz || DEFAULT_TZ, timeZoneName: "short" }).formatToParts(new Date(ms)); } catch { return []; } })();
  return parts.find((p) => p.type === "timeZoneName")?.value || "UTC";
}
function clockText(ms, tz, lang) {
  if (lang === "bn") {
    const t = fmtIntl(ms, tz, "bn-BD", { hour: "numeric", minute: "2-digit", hour12: true });
    return `${t} (${(tz || DEFAULT_TZ) === DEFAULT_TZ ? "বাংলাদেশ সময়" : zoneNameEn(ms, tz)})`;
  }
  return upperDayPeriod(fmtIntl(ms, tz, lang === "both" ? "en-US" : "en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }));
}
export function fmtTimeShort(ms, tz, lang) {
  if (!Number.isFinite(ms)) return null;
  return lang === "both" ? `${clockText(ms, tz, "en")} / ${clockText(ms, tz, "bn")}` : clockText(ms, tz, lang);
}
export function fmtDateTimeShort(ms, tz, lang) {
  if (!Number.isFinite(ms)) return null;
  const day = (loc) => fmtIntl(ms, tz, loc, { day: "numeric", month: "short", year: "numeric" });
  const en = `${day("en-GB")}, ${clockText(ms, tz, "en")}`;
  const bn = `${day("bn-BD")}, ${clockText(ms, tz, "bn")}`;
  return lang === "bn" ? bn : lang === "both" ? `${en} / ${bn}` : en;
}
export function fmtMinutes(min, lang) {
  const n = Math.round(Number(min));
  if (!Number.isFinite(n) || n <= 0) return null;
  return pick(lang, `${n} minute${n === 1 ? "" : "s"}`, `${toBnDigits(n)} মিনিট`);
}

/* ---------- wall-clock <input type="datetime-local"> ⇄ a real instant, in the e-mail's time zone ---------- */
function zoneParts(ms, tz) {
  const parts = formatter(tz || DEFAULT_TZ, "en-US", { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute"), s: g("second") };
}
/** "2026-10-25T20:00" typed as Dhaka wall-clock time → the real instant (ms). null when empty / invalid. */
export function zonedLocalToMs(local, tz) {
  const m = String(local ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  try {
    let guess = wall;
    for (let i = 0; i < 2; i++) { // one correction is enough except across a DST jump; two is safe
      const p = zoneParts(guess, tz);
      guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    }
    return Number.isFinite(guess) ? guess : null;
  } catch { return null; }
}
/** The reverse: an instant → "YYYY-MM-DDTHH:mm" in the e-mail's zone, for filling the input. */
export function msToZonedLocal(ms, tz) {
  if (!Number.isFinite(ms)) return "";
  try {
    const p = zoneParts(ms, tz);
    const z = (n, l = 2) => String(n).padStart(l, "0");
    return `${z(p.y, 4)}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
  } catch { return ""; }
}

/* ==========================================================================
   2. Students
   ========================================================================== */
/** users/{uid} (as returned by fetchAllUsersAdmin) → the few fields the Email Center needs. */
export function normalizeStudent(u) {
  return {
    uid: String(u?.id || u?.uid || ""),
    name: String(u?.displayName || u?.name || "").trim(),
    email: String(u?.email || "").trim(),
    roll: u?.roll ? String(u.roll).trim() : "",
    studentId: u?.studentId ? String(u.studentId).trim() : "", // no such field exists today — filled only if one is ever added
    courseIds: Array.isArray(u?.enrolledCourses) ? u.enrolledCourses.map(String) : [],
    isAdmin: u?.isAdmin === true,
    disabled: u?.disabled === true,
    createdAt: toMs(u?.createdAt) || 0,
  };
}

/** "" when the account may be e-mailed, else why not. Admin and deactivated accounts are excluded by default. */
export const accountIssue = (s) => (s.isAdmin ? "admin" : s.disabled ? "deactivated" : "");

export const REASONS = Object.freeze({
  admin: "Admin account",
  deactivated: "Deactivated account",
  not_enrolled: "Not enrolled in the exam's course",
  invalid_email: "No valid e-mail address",
  already_submitted: "Already submitted this exam",
  submitted_since: "Submitted since the list was prepared",
  missing_data: "Missing data used by the message",
  not_selected: "Not selected",
  status_changed: "Status changed since the list was prepared",
});

/** Eligibility of one student for an exam (or just for e-mail when `exam` is null). */
export function examEligibility(student, exam) {
  const issue = accountIssue(student);
  if (issue) return { eligible: false, reason: issue };
  if (exam && !isExamVisibleTo(exam, { enrolledCourses: student.courseIds })) return { eligible: false, reason: "not_enrolled" };
  return { eligible: true, reason: "" };
}

/* ==========================================================================
   3. Exams — which kind of campaign is honest for this exam right now?
   ========================================================================== */
/**
 * key: draft | cancelled | upcoming | closed | registration_closed | open | practice
 * remind   → "you have not completed it" style reminders may be sent (the exam can still be started)
 * resume   → "you started it …" reminders make sense (a running attempt may still finish)
 * schedule → "upcoming / currently available exam" reminders make sense (and a schedule exists to quote)
 */
export function examEmailState(exam, now) {
  if (!exam) return { key: "none", remind: false, resume: false, schedule: false, reason: "" };
  if (isDraftExam(exam)) return { key: "draft", remind: false, resume: false, schedule: false, reason: "এই এক্সামটি Draft — শিক্ষার্থীরা এটি দেখতে পায় না।" };
  if (exam.cancelled === true) return { key: "cancelled", remind: false, resume: false, schedule: false, reason: "এই এক্সামের সময়সূচি বাতিল করা হয়েছে।" };
  const hasSchedule = exam.examType !== "practice" && (toMs(exam.publishAt) !== null || toMs(exam.closesAt) !== null);
  if (exam.examType === "practice") return { key: "practice", remind: true, resume: true, schedule: false, hasSchedule: false, reason: "" };
  const st = windowState(exam, now);
  if (st === "closed") return { key: "closed", remind: false, resume: false, schedule: false, hasSchedule, reason: "এই এক্সামের সময় শেষ — এখন “এক্সাম দেননি” ধরনের রিমাইন্ডার পাঠালে শিক্ষার্থীরা বিভ্রান্ত হবে।" };
  if (st === "upcoming") return { key: "upcoming", remind: false, resume: false, schedule: hasSchedule, hasSchedule, reason: "এক্সাম এখনো শুরু হয়নি — “Upcoming exam reminder” ব্যবহার করুন।" };
  if (exam.registration === "closed") return { key: "registration_closed", remind: false, resume: true, schedule: false, hasSchedule, reason: "এই এক্সামে নতুন এন্ট্রি বন্ধ (Registration closed) — নতুন করে শুরু করা যাবে না।" };
  return { key: "open", remind: true, resume: true, schedule: hasSchedule, hasSchedule, reason: "" };
}

/** Whether a campaign type is allowed for the exam's current state; `reason` explains a "no". */
export function typeAllowed(type, exam, now) {
  const t = CAMPAIGN_TYPES[type];
  if (!t) return { ok: false, reason: "অজানা ক্যাম্পেইন টাইপ।" };
  if (!t.needsExam) return { ok: true, reason: "" };
  if (!exam) return { ok: false, reason: "একটি এক্সাম বাছুন।" };
  const st = examEmailState(exam, now);
  if (type === "exam_not_attempted") return st.remind ? { ok: true, reason: "" } : { ok: false, reason: st.reason };
  if (type === "exam_started_not_submitted") return st.resume ? { ok: true, reason: "" } : { ok: false, reason: st.reason };
  if (type === "exam_upcoming") {
    if (st.schedule) return { ok: true, reason: "" };
    if (st.key === "open" || st.key === "upcoming") return { ok: false, reason: "এই এক্সামে কোনো সময়সূচি (publishAt / closesAt) সেট নেই — তারিখ বানিয়ে লেখা হয় না।" };
    return { ok: false, reason: st.reason };
  }
  return { ok: true, reason: "" };
}

/** The wording of an exam's availability, built only from stored schedule fields. */
export function examStatusText(exam, now, tz, lang) {
  const st = examEmailState(exam, now);
  const w = examWindow(exam);
  switch (st.key) {
    case "open": return w.endsAt ? pick(lang, `Open now — you can start until ${fmtDateTimeShort(w.endsAt, tz, "en")}`, `এখন চালু — ${fmtDateTimeShort(w.endsAt, tz, "bn")} পর্যন্ত শুরু করা যাবে`) : pick(lang, "Open now", "এখন চালু আছে");
    case "practice": return pick(lang, "Practice exam — available any time", "প্র্যাকটিস এক্সাম — যেকোনো সময় দেওয়া যায়");
    case "upcoming": return w.startsAt ? pick(lang, `Opens on ${fmtDateTimeShort(w.startsAt, tz, "en")}`, `${fmtDateTimeShort(w.startsAt, tz, "bn")}-এ শুরু হবে`) : pick(lang, "Upcoming", "আসন্ন");
    case "closed": return pick(lang, "Closed", "বন্ধ");
    case "cancelled": return pick(lang, "Cancelled", "বাতিল");
    case "registration_closed": return pick(lang, "New entries are closed", "নতুন এন্ট্রি বন্ধ");
    default: return null;
  }
}

/* ==========================================================================
   4. Campaign types, recipient groups, classification
   ========================================================================== */
export const CAMPAIGN_TYPES = Object.freeze({
  announcement: { label: "General announcement", icon: "fa-bullhorn", needsExam: false, template: "general", modes: ["all", "course", "manual"], desc: "সব সক্রিয় শিক্ষার্থী, একটি কোর্স বা বেছে নেওয়া শিক্ষার্থীদের কাছে ঘোষণা।" },
  exam_not_attempted: { label: "Exam not attempted", icon: "fa-user-clock", needsExam: true, template: "exam_not_attempted", groups: ["not_attempted", "no_result_unverified"], desc: "যাঁদের এই এক্সামের কোনো জমা দেওয়া ফলাফল নেই।" },
  exam_started_not_submitted: { label: "Started, not submitted", icon: "fa-hourglass-half", needsExam: true, template: "exam_started_not_submitted", groups: ["started_no_submission"], desc: "যাঁরা এক্সাম শুরু করেছেন কিন্তু জমার রেকর্ড নেই (শুধু start-tracking থাকলে)।" },
  exam_upcoming: { label: "Upcoming exam reminder", icon: "fa-calendar-check", needsExam: true, template: "exam_upcoming", groups: ["not_attempted", "no_result_unverified", "started_no_submission"], desc: "সময়সূচিসহ আসন্ন বা চলমান এক্সামের রিমাইন্ডার।" },
  custom: { label: "Custom selection", icon: "fa-user-check", needsExam: false, template: "custom", modes: ["manual"], desc: "হাতে বেছে নেওয়া শিক্ষার্থীদের কাছে যেকোনো ইমেইল।" },
});

export const EXAM_GROUPS = Object.freeze({
  not_attempted: { label: "Not attempted", tone: "coral", icon: "fa-circle-xmark", desc: "জমা দেওয়া ফলাফল নেই এবং কোনো start রেকর্ডও নেই" },
  started_no_submission: { label: "Started, no submission", tone: "amber", icon: "fa-hourglass-half", desc: "এক্সাম শুরু করেছেন, কিন্তু জমা দেওয়া ফলাফল নেই" },
  no_result_unverified: { label: "No result (start unverified)", tone: "amber", icon: "fa-circle-question", desc: "জমা দেওয়া ফলাফল নেই; শুরু করেছেন কিনা যাচাই করা যায়নি (examSessions পড়া যায়নি)" },
  submitted: { label: "Submitted", tone: "teal", icon: "fa-circle-check", desc: "এই এক্সামের জমা দেওয়া ফলাফল আছে" },
  excluded: { label: "Excluded / not eligible", tone: "", icon: "fa-ban", desc: "অ্যাডমিন, deactivated, বা এক্সামের কোর্সে এনরোল নেই" },
  unverified: { label: "Could not be verified", tone: "coral", icon: "fa-triangle-exclamation", desc: "ফলাফলের ডেটা পড়া যায়নি — কিছুই যাচাই করা যায়নি" },
});
/** Groups that mean "no submitted result is on record". */
export const NOT_SUBMITTED = Object.freeze(["not_attempted", "started_no_submission", "no_result_unverified", "unverified"]);

/** Real number of submitted attempts one results/{uid}_{examId} document stands for (same rule as exam-data.countAttempts). */
export function submittedAttempts(result) {
  const byNumber = Number(result?.attemptNumber) || 0;
  const byHistory = Array.isArray(result?.attempts) ? result.attempts.length : 0;
  return Math.max(byNumber, byHistory, 1);
}

/** results documents → Map(uid → result) for ONE exam. The document id is "{uid}_{examId}", the examId field must agree. */
export function indexResults(results, examId) {
  const map = new Map();
  for (const r of results || []) {
    if (!r || !r.uid) continue;
    const byField = r.examId === examId;
    const byId = r.id === `${r.uid}_${examId}`;
    if (byField || (r.examId === undefined && byId)) map.set(String(r.uid), r);
  }
  return map;
}
/** [{ uid, starts }] → Map(uid → { starts }); null (tracking unavailable) stays null. */
export function indexSessions(rows) {
  if (!Array.isArray(rows)) return null;
  const map = new Map();
  for (const r of rows) if (r?.uid) map.set(String(r.uid), { starts: Number(r.starts) || 0 });
  return map;
}

/**
 * Where does every student stand for this exam?
 *   resultsByUid  Map | null   null = the results could not be read → NOTHING can be verified
 *   sessionsByUid Map | null   null = start tracking could not be read → "never started" cannot be claimed
 * A result for ANOTHER exam never counts: the Map was built for this examId only (indexResults).
 */
export function classifyStudents({ students, exam, resultsByUid, sessionsByUid }) {
  const resultsOk = resultsByUid instanceof Map;
  const sessionsOk = sessionsByUid instanceof Map;
  const rows = [];
  const counts = { total: 0, eligible: 0, emailable: 0, not_attempted: 0, started_no_submission: 0, no_result_unverified: 0, submitted: 0, excluded: 0, unverified: 0, notSubmitted: 0 };
  for (const s of students) {
    counts.total++;
    const el = examEligibility(s, exam);
    const emailable = isValidEmail(s.email);
    const base = { uid: s.uid, eligible: el.eligible, emailable, reason: el.reason, attempts: 0, starts: 0 };
    if (!el.eligible) { rows.push({ ...base, status: "excluded" }); counts.excluded++; continue; }
    counts.eligible++;
    if (emailable) counts.emailable++;
    if (!resultsOk) { rows.push({ ...base, status: "unverified" }); counts.unverified++; counts.notSubmitted++; continue; }
    const result = resultsByUid.get(s.uid);
    if (result) { rows.push({ ...base, status: "submitted", attempts: submittedAttempts(result), starts: sessionsOk ? sessionsByUid.get(s.uid)?.starts || 0 : 0 }); counts.submitted++; continue; }
    const session = sessionsOk ? sessionsByUid.get(s.uid) : null;
    if (session && session.starts > 0) { rows.push({ ...base, status: "started_no_submission", starts: session.starts }); counts.started_no_submission++; counts.notSubmitted++; continue; }
    if (sessionsOk) { rows.push({ ...base, status: "not_attempted" }); counts.not_attempted++; counts.notSubmitted++; continue; }
    rows.push({ ...base, status: "no_result_unverified" }); counts.no_result_unverified++; counts.notSubmitted++;
  }
  return { rows, counts, resultsOk, sessionsOk };
}

/** The wording of a classification inside the e-mail. Only claims what the data proves. */
export function statusText(status, lang, extra = {}) {
  switch (status) {
    case "submitted": return pick(lang, "Submitted — a result is recorded", "জমা দেওয়া হয়েছে — ফলাফল রেকর্ড আছে");
    case "started_no_submission": return pick(lang, "Started — no submission recorded", "শুরু করা হয়েছে — জমা দেওয়ার কোনো রেকর্ড নেই");
    case "not_attempted": return pick(lang, "Not attempted — no submitted result recorded", "অংশগ্রহণ করা হয়নি — জমা দেওয়া কোনো ফলাফল রেকর্ড নেই");
    case "no_result_unverified": return pick(lang, "No submitted result recorded", "জমা দেওয়া কোনো ফলাফল রেকর্ড নেই");
    case "unverified": return pick(lang, "Could not be verified", "যাচাই করা যায়নি");
    default: return extra.fallback || null;
  }
}

/* ==========================================================================
   5. Template variables — and exactly where each value comes from
   ========================================================================== */
/** scope: student = differs per person · exam / site / campaign = the same for every recipient. */
export const VARIABLES = Object.freeze([
  { key: "student_name", scope: "student", label: "Student name", source: "users/{uid}.displayName", sample: "Rahim Uddin" },
  { key: "student_email", scope: "student", label: "Registered e-mail", source: "users/{uid}.email", sample: "rahim@example.com" },
  { key: "student_roll", scope: "student", label: "Roll number", source: "users/{uid}.roll", sample: "0123" },
  { key: "student_id", scope: "student", label: "Student ID", source: "users/{uid}.studentId — this project has no separate student-ID field, so it stays empty unless you add one", sample: "—" },
  { key: "course_name", scope: "student", label: "Relevant course", source: "exam's course → campaign course → the student's own enrolments", sample: "Main Course" },
  { key: "exam_title", scope: "exam", label: "Exam title", source: "exams/{id}.title", sample: "Model Test 05" },
  { key: "exam_date", scope: "exam", label: "Exam date", source: "exams/{id}.publishAt (date part)", sample: "Sunday 25 October 2026" },
  { key: "exam_time", scope: "exam", label: "Exam start time", source: "exams/{id}.publishAt (time part)", sample: "10:00 AM GMT+6" },
  { key: "exam_duration", scope: "exam", label: "Exam duration", source: "exams/{id}.duration (minutes)", sample: "30 minutes" },
  { key: "exam_status", scope: "exam", label: "Exam availability", source: "exams/{id} schedule window (schedule-core.js)", sample: "Open now" },
  { key: "exam_url", scope: "exam", label: "Exam link", source: "website (footer-config.js) + #/exam?id={examId}", sample: "https://…/#/exam?id=…" },
  { key: "attempt_status", scope: "student", label: "Attempt status", source: "results/{uid}_{examId} + examSessions/{uid}_{examId}", sample: "Not attempted — no submitted result recorded" },
  { key: "attempt_count", scope: "student", label: "Submitted attempts", source: "results/{uid}_{examId} attemptNumber / attempts[]", sample: "0" },
  { key: "deadline", scope: "exam", label: "Deadline", source: "the campaign's own deadline field, else exams/{id}.closesAt (last moment to start)", sample: "25 Oct 2026, 8:00 PM GMT+6" },
  { key: "website_url", scope: "site", label: "Website", source: "js/footer-config.js → contact.website", sample: "https://tvsites.vercel.app" },
  { key: "support_email", scope: "site", label: "Support e-mail", source: "js/footer-config.js → contact.email", sample: "tv.support.info@gmail.com" },
  { key: "personal_message", scope: "campaign", label: "Personal message", source: "the campaign's “Personal message” field (optional — may be empty)", sample: "Good luck!" },
]);
export const VARIABLE_KEYS = Object.freeze(VARIABLES.map((v) => v.key));
const VAR_BY_KEY = Object.freeze(Object.fromEntries(VARIABLES.map((v) => [v.key, v])));
export const variableMeta = (key) => VAR_BY_KEY[key] || null;
/** May be empty without blocking the send (the empty paragraph simply disappears). */
export const OPTIONAL_KEYS = Object.freeze(["personal_message"]);

/** "Main Course" / "A, B, C +2 more" — never invented: only courses the exam or the student really has. */
function courseNameFor({ student, exam, courseTitleOf, campaignCourseIds }) {
  if (exam?.courseId) return clean(courseTitleOf(exam.courseId)) || clean(exam.courseName);
  const mine = student?.courseIds || [];
  const preferred = (campaignCourseIds || []).filter((id) => mine.includes(id));
  const list = (preferred.length ? preferred : mine).map((id) => clean(courseTitleOf(id))).filter(Boolean);
  if (!list.length) return null;
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3}` : list.join(", ");
}

/**
 * The value of every template variable for ONE student. `null` = no reliable source → never guessed.
 *   classification   one row of classifyStudents() (or null when the campaign has no exam)
 *   campaign         { personalMessage, deadlineMs, courseIds }
 *   site             { website, email }
 */
export function buildValues({ student, exam, courseTitleOf = () => "", classification = null, campaign = {}, site = {}, tz = DEFAULT_TZ, lang = "en", now = 0 }) {
  const L = normLang(lang);
  const v = Object.fromEntries(VARIABLE_KEYS.map((k) => [k, null]));
  v.student_name = clean(student?.name);
  v.student_email = isValidEmail(student?.email) ? String(student.email).trim() : null;
  v.student_roll = clean(student?.roll);
  v.student_id = clean(student?.studentId);
  v.course_name = courseNameFor({ student, exam, courseTitleOf, campaignCourseIds: campaign.courseIds });
  v.website_url = clean(safeHttpUrl(site.website)) ? trimSlash(safeHttpUrl(site.website)) : null;
  v.support_email = isValidEmail(site.email) ? String(site.email).trim() : null;
  v.personal_message = clean(campaign.personalMessage);
  const deadlineMs = Number(campaign.deadlineMs) > 0 ? Number(campaign.deadlineMs) : null;
  if (exam) {
    const w = examWindow(exam);
    v.exam_title = clean(exam.title);
    v.exam_date = w.startsAt !== null ? fmtDateLong(w.startsAt, tz, L) : null;
    v.exam_time = w.startsAt !== null ? fmtTimeShort(w.startsAt, tz, L) : null;
    v.exam_duration = fmtMinutes(exam.duration, L);
    v.exam_status = examStatusText(exam, now, tz, L);
    v.exam_url = v.website_url && exam.id ? `${v.website_url}/#/exam?id=${encodeURIComponent(exam.id)}` : null;
    const dl = deadlineMs ?? w.endsAt;
    v.deadline = dl !== null && dl !== undefined ? fmtDateTimeShort(dl, tz, L) : null;
    if (classification) {
      v.attempt_status = statusText(classification.status, L);
      v.attempt_count = classification.status === "unverified" ? null : String(classification.attempts || 0);
    }
  } else if (deadlineMs) {
    v.deadline = fmtDateTimeShort(deadlineMs, tz, L);
  }
  return v;
}

/* ==========================================================================
   6. Campaign rows — the per-recipient delivery model
   ========================================================================== */
/**
 * pending    queued, not tried yet
 * sending    handed to EmailJS, no answer yet (only ever stored for a moment — if the page dies, it becomes `uncertain`)
 * accepted   EmailJS answered 200 "OK": the request was ACCEPTED. This is not a promise of inbox delivery.
 * failed     EmailJS answered with an error → we know it was refused (safe to retry)
 * uncertain  no answer at all (timeout, network drop, tab closed) → it may or may not have gone out
 * skipped    deliberately not sent (invalid e-mail, missing data, removed after the final check)
 */
export const ROW_STATUS = Object.freeze({
  pending: { label: "Pending", tone: "", icon: "fa-clock" },
  sending: { label: "Sending", tone: "accent", icon: "fa-paper-plane" },
  accepted: { label: "Request accepted", tone: "teal", icon: "fa-circle-check" },
  failed: { label: "Failed", tone: "coral", icon: "fa-circle-xmark" },
  uncertain: { label: "Uncertain", tone: "amber", icon: "fa-circle-question" },
  skipped: { label: "Skipped", tone: "", icon: "fa-forward" },
});
export const CAMPAIGN_STATUS = Object.freeze({
  draft: { label: "Draft", tone: "" },
  sending: { label: "Sending", tone: "accent" },
  completed: { label: "Completed", tone: "teal" },
  completed_errors: { label: "Completed with issues", tone: "amber" },
  stopped: { label: "Stopped", tone: "amber" },
  interrupted: { label: "Interrupted", tone: "amber" },
  failed: { label: "Failed", tone: "coral" },
});

export const emptyTotals = () => ({ total: 0, pending: 0, sending: 0, accepted: 0, failed: 0, uncertain: 0, skipped: 0 });
export function totalsOf(rows) {
  const t = emptyTotals();
  for (const r of rows || []) { t.total++; if (t[r.status] !== undefined) t[r.status]++; else t.pending++; }
  return t;
}
/** Rows still `sending` when nobody is sending any more were in flight when the page died: their outcome is unknown. */
export function recoverRows(rows) {
  return (rows || []).map((r) => (r.status === "sending" ? { ...r, status: "uncertain", note: "Interrupted while sending — outcome unknown" } : r));
}
/** Which rows a (re)run should send. `accepted` is NEVER included; `uncertain` only when the admin opts in. */
export function selectForRun(rows, { includeFailed = true, includeUncertain = false, includePending = true } = {}) {
  return (rows || []).filter((r) => (includePending && r.status === "pending") || (includeFailed && r.status === "failed") || (includeUncertain && r.status === "uncertain"));
}
/** The final status of a campaign once a run has ended. */
export function campaignStatusFor(totals, { stopped = false, configError = false } = {}) {
  if (configError && totals.accepted === 0) return "failed";
  if (stopped && (totals.pending > 0)) return "stopped";
  if (totals.pending > 0 || totals.sending > 0) return "interrupted";
  if (totals.total > 0 && totals.accepted === 0 && totals.skipped < totals.total) return "failed";
  return totals.failed || totals.uncertain ? "completed_errors" : "completed";
}
/** A campaign stored as `sending` whose heartbeat stopped is really interrupted (the tab was closed / the network died). */
export function isStale(campaign, now, staleMs = 4 * 60 * 1000) {
  if (campaign?.status !== "sending") return false;
  const beat = toMs(campaign.heartbeatAt) || toMs(campaign.startedAt) || toMs(campaign.createdAt) || 0;
  return now - beat > staleMs;
}

/** How a request outcome is described to the admin. */
export function outcomeNote(o) {
  if (!o) return "";
  if (o.kind === "accepted") return "Request accepted by EmailJS";
  const bits = [o.status ? `HTTP ${o.status}` : "No response", o.text ? String(o.text).slice(0, 140) : ""].filter(Boolean);
  return bits.join(" — ");
}

/* ==========================================================================
   7. Validation, fingerprint, CSV
   ========================================================================== */
/**
 * Everything that must be true before the Send button may do anything. Blockers cannot be overridden; warnings can.
 * (All inputs are plain values so this is unit-testable.)
 */
export function validateCampaign(i) {
  const blockers = [];
  const warnings = [];
  const block = (code, message) => blockers.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  const t = CAMPAIGN_TYPES[i.type];
  if (!t) block("type", "ক্যাম্পেইন টাইপ বাছুন।");
  if (!i.configComplete) block("config", "EmailJS কনফিগারেশন অসম্পূর্ণ — Email Settings-এ Service ID, Template ID ও Public Key দিন।");
  else if (!i.configTested) block("untested", "এই কনফিগারেশন দিয়ে এখনো কোনো টেস্ট ইমেইল সফল হয়নি — Email Settings থেকে আগে একটি টেস্ট পাঠান।");
  if (t?.needsExam) {
    if (!i.exam) block("exam", "এই টাইপের জন্য একটি এক্সাম বাছুন।");
    else {
      const ok = typeAllowed(i.type, i.exam, i.now);
      if (!ok.ok) block("exam_state", ok.reason);
    }
    if (i.exam && i.resultsOk === false) block("results", "ফলাফলের ডেটা পড়া যায়নি (Firestore permission বা নেটওয়ার্ক) — তাই কে জমা দিয়েছে তা যাচাই করা যায়নি।");
    if (i.exam && i.resultsOk !== false && i.sessionsOk === false && i.type === "exam_started_not_submitted") block("sessions", "Start-tracking (examSessions) পড়া যায়নি — “শুরু করেছে কিন্তু জমা দেয়নি” তালিকা যাচাই করা যায়নি।");
    if (i.exam && i.resultsOk !== false && i.sessionsOk === false && i.type !== "exam_started_not_submitted") warn("sessions", "Start-tracking (examSessions) পড়া যায়নি: কে এক্সাম শুরু করেছিল তা যাচাই করা যায়নি। ইমেইলে শুধু “জমা দেওয়া ফলাফল রেকর্ড নেই” লেখা হবে।");
  }
  if (!String(i.subject || "").trim()) block("subject", "ইমেইলের Subject দিন।");
  if (!i.hasMessage) block("message", "ইমেইলের মূল বার্তা (Main message) লিখুন।");
  if (!i.sendableCount) block("recipients", "কোনো প্রাপক নেই — অন্তত একজন যোগ্য শিক্ষার্থী বাছুন।");
  if (i.unknownVariables?.length) block("unknown_variables", `অজানা ভেরিয়েবল: ${i.unknownVariables.map((k) => `{{${k}}}`).join(", ")} — বানান ঠিক করুন বা মুছে দিন।`);
  if (i.campaignLevelMissing?.length) block("campaign_missing", `${i.campaignLevelMissing.map((k) => `{{${k}}}`).join(", ")} এর মান কোনো প্রাপকের জন্যই নেই (যেমন এক্সামে সময়সূচি নেই)। ভেরিয়েবলটি সরান, অথবা ফলব্যাক দিন: {{${i.campaignLevelMissing[0]}|এখনো জানানো হয়নি}}।`);
  if (i.studentMissingCount && i.missingPolicy === "block") block("missing_data", `${i.studentMissingCount} জন প্রাপকের কিছু তথ্য নেই (${(i.studentMissingKeys || []).map((k) => `{{${k}}}`).join(", ")})। “Missing data” নীতিতে Skip বা Fallback বাছুন, অথবা ভেরিয়েবল সরান।`);
  if (i.studentMissingCount && i.missingPolicy === "skip") warn("missing_skip", `${i.studentMissingCount} জনকে বাদ দেওয়া হবে (প্রয়োজনীয় তথ্য নেই)।`);
  if (i.studentMissingCount && i.missingPolicy === "fallback") warn("missing_fallback", `${i.studentMissingCount} জনের ইমেইলে অনুপস্থিত তথ্যের জায়গায় “Not available” দেখাবে।`);
  if (i.oversize) block("size", "ইমেইলটি EmailJS-এর রিকোয়েস্ট সাইজ সীমার (৫০ KB) চেয়ে বড় — বার্তা ছোট করুন।");
  if (i.safetyCap > 0 && i.sendableCount > i.safetyCap) block("cap", `প্রাপক সংখ্যা (${i.sendableCount}) আপনার সেট করা নিরাপত্তা সীমা (${i.safetyCap}) ছাড়িয়েছে — Email Settings-এ সীমা বদলান অথবা প্রাপক কমান।`);
  if (i.type === "exam_not_attempted" && i.exam && i.counts && i.counts.submitted && i.selectedSubmitted) block("submitted_selected", "যাঁরা ইতিমধ্যে জমা দিয়েছেন তাঁদের “এক্সাম দেননি” ইমেইল পাঠানো যাবে না।");
  if (i.duplicateOf) warn("duplicate", `একই বিষয় ও একই প্রাপক তালিকার একটি ক্যাম্পেইন আগে পাঠানো হয়েছে (${i.duplicateOf}).`);
  return { blockers, warnings, ok: blockers.length === 0 };
}

/** Same type + subject + message + exam + exact recipient set → same fingerprint. */
export function campaignFingerprint({ type, examId, subject, message, uids }) {
  const sorted = Array.from(uids || []).sort();
  return hash32(JSON.stringify([type || "", examId || "", String(subject || "").trim(), String(message || "").trim(), sorted.length, hash32(sorted.join(","))]));
}

/** Spreadsheet programs run cells that start with = + - @ as formulas. Neutralise them (student names are user-typed). */
export function csvSafe(value) {
  const s = String(value ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
export function campaignCsv(campaign, rows) {
  const head = ["Campaign", "Type", "Exam", "Subject", "Name", "Email", "Roll", "Status", "Detail", "Attempts", "Updated"];
  const out = [head];
  for (const r of rows || []) {
    out.push([
      campaign?.name, CAMPAIGN_TYPES[campaign?.type]?.label || campaign?.type, campaign?.examTitle, campaign?.subject,
      r.name, r.email, r.roll, ROW_STATUS[r.status]?.label || r.status, r.note || "", r.tries || 0, r.at ? new Date(toMs(r.at)).toISOString() : "",
    ].map(csvSafe));
  }
  return out;
}

/** "3 min 20 s" — remaining-time wording for the progress dialog. */
export function fmtEta(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
