// ==========================================================================
// schedule-core.js — everything about "when is this exam, and what can a student do with it
// right now?" in ONE place. Pure functions only: no DOM, no Firebase, no clock reads (the
// caller passes `now`), so the same logic runs on the student site, in the admin panel and
// in the Node unit tests (tests/).
//
// Field map (all on exams/{id}; every new field is optional, so old exams keep working):
//   publishAt      Timestamp  when students may start            (existing)
//   closesAt       Timestamp  last moment a student may START    (existing; null = never closes)
//   duration       minutes    time limit once started             (existing)
//   status         "draft" | "published"                          (existing; missing = published)
//   examType       "live" | "practice"                            (existing; practice = no schedule)
//   maxAttempts    number     0 = unlimited                       (existing)
//   -- added by the exam-platform upgrade --
//   cancelled        boolean   schedule cancelled by an admin → shown as "Not Available"
//   registration     "open" | "closed"   admin can stop NEW entries early (running attempts finish)
//   visibility       "public" | "unlisted"  unlisted = not listed anywhere, direct link only
//   reminderEnabled  boolean   false hides the "Remind me" button (default true)
//   featured         boolean   shown in the Featured section of the home page
//   difficulty       "easy" | "medium" | "hard" | ""
//   scheduleUpdatedAt Timestamp stamped when the schedule changes → "Schedule update" notification
// ==========================================================================

export const SOON_MS = 60 * 60 * 1000; // "Starting soon" = starts within the next hour
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** What a student sees on an exam, in priority order. */
export const STATUS = Object.freeze({
  live: { key: "live", label: "Live Now", bn: "এখন চলছে", tone: "live" },
  soon: { key: "soon", label: "Starting Soon", bn: "শীঘ্রই শুরু", tone: "soon" },
  upcoming: { key: "upcoming", label: "Upcoming", bn: "আসন্ন", tone: "upcoming" },
  open: { key: "open", label: "Available", bn: "উপলব্ধ", tone: "open" },
  completed: { key: "completed", label: "Completed", bn: "সম্পন্ন", tone: "done" },
  closed: { key: "closed", label: "Closed", bn: "বন্ধ", tone: "closed" },
  unavailable: { key: "unavailable", label: "Not Available", bn: "পাওয়া যাচ্ছে না", tone: "muted" },
});

export const DIFFICULTY = Object.freeze({
  easy: { label: "Easy", bn: "সহজ" },
  medium: { label: "Medium", bn: "মাঝারি" },
  hard: { label: "Hard", bn: "কঠিন" },
});

/* ==========================================================================
   Numbers / text
   ========================================================================== */
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
/** Bengali numerals (০-৯) for sentences written in Bengali, e.g. "৪৮ ঘণ্টা". */
export function toBnDigits(value) {
  return String(value).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
}

/** Questions a student actually sees per attempt (random pool aware). */
export function getExamQuestionCount(exam = {}) {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  const pool = Number(exam.questionCount) || 0;
  return perAttempt > 0 && perAttempt < pool ? perAttempt : pool;
}
export function isExamRandomPool(exam = {}) {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  return perAttempt > 0 && perAttempt < (Number(exam.questionCount) || 0);
}

/** Pass line in percent: the exam's own, else the site default, else 60. */
export function passPercentFor(exam, fallback = 60) {
  const own = Number(exam?.passPercent);
  if (own > 0) return Math.min(100, own);
  const def = Number(fallback);
  return def > 0 ? Math.min(100, def) : 60;
}
/** Marks needed to pass (1 mark per correct answer → marks = questions per attempt). */
export function passMarksFor(exam, fallback = 60) {
  return Math.ceil((getExamQuestionCount(exam) * passPercentFor(exam, fallback)) / 100 - 1e-9);
}

/* ==========================================================================
   Time conversion
   ========================================================================== */
/** Firestore Timestamp | {seconds} | Date | number | ISO string → epoch ms, or null. */
export function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") { const d = v.toDate(); return d ? d.getTime() : null; }
  if (typeof v.seconds === "number") return v.seconds * 1000 + Math.floor((Number(v.nanoseconds) || 0) / 1e6);
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Local-calendar-day helpers (the student's own device time zone decides what "today" means). */
export function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** Local midnight `n` calendar days after the day containing `ms` (n may be 0 or negative). DST-safe: a day may be 23 or 25 hours long. */
export function addDays(ms, n) { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() + n); return d.getTime(); }
/** Start of the NEXT local day — the exclusive end of "today". */
export const endOfDay = (ms) => addDays(ms, 1);
export function dayDiff(ms, now) {
  const a = new Date(startOfDay(ms)), b = new Date(startOfDay(now));
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
}

/* ==========================================================================
   Countdown formatting
   ========================================================================== */
export function splitDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    totalSeconds: total,
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}
const p2 = (n) => String(n).padStart(2, "0");

/** "02 Days : 05 Hours : 32 Minutes : 18 Seconds" pieces → [{ value: "02", unit: "Days" }, …]. */
export function countdownParts(ms) {
  const s = splitDuration(ms);
  return [
    { value: p2(s.days), unit: "Days" },
    { value: p2(s.hours), unit: "Hours" },
    { value: p2(s.minutes), unit: "Minutes" },
    { value: p2(s.seconds), unit: "Seconds" },
  ];
}

/** Compact "1d 4h" / "2h 15m" / "12m 5s" / "42s" for small chips (the exact format the exam list always used). */
export function countdownShort(ms) {
  const s = splitDuration(ms);
  if (s.days > 0) return `${s.days}d ${s.hours}h`;
  if (s.hours > 0) return `${s.hours}h ${s.minutes}m`;
  if (s.minutes > 0) return `${s.minutes}m ${s.seconds}s`;
  return `${s.seconds}s`;
}

/** Bengali sentence fragment: "২ ঘণ্টা ১৫ মিনিট", "১ দিন ৪ ঘণ্টা", "১২ মিনিট", "এক মিনিটেরও কম". */
export function humanizeBn(ms) {
  const s = splitDuration(ms);
  if (s.days > 0) return s.hours ? `${toBnDigits(s.days)} দিন ${toBnDigits(s.hours)} ঘণ্টা` : `${toBnDigits(s.days)} দিন`;
  if (s.hours > 0) return s.minutes ? `${toBnDigits(s.hours)} ঘণ্টা ${toBnDigits(s.minutes)} মিনিট` : `${toBnDigits(s.hours)} ঘণ্টা`;
  if (s.minutes > 0) return `${toBnDigits(s.minutes)} মিনিট`;
  return "এক মিনিটেরও কম";
}

/** "আজ", "আগামীকাল", "গতকাল" or a short date — for schedule group headings. */
export function dayLabelBn(ms, now) {
  const diff = dayDiff(ms, now);
  if (diff === 0) return "আজ";
  if (diff === 1) return "আগামীকাল";
  if (diff === -1) return "গতকাল";
  return null; // caller formats the real date
}

/* ==========================================================================
   The exam window and its state
   ========================================================================== */
/** { startsAt, endsAt, practice } in epoch ms. Practice exams ignore any leftover schedule. */
export function examWindow(exam) {
  if (exam?.examType === "practice") return { startsAt: null, endsAt: null, practice: true };
  return { startsAt: toMs(exam?.publishAt), endsAt: toMs(exam?.closesAt), practice: false };
}

/**
 * "upcoming" | "open" | "closed" — the original, time-only rule (same boundaries the exam-start
 * guard has always used: before publishAt = upcoming; after closesAt = closed; both ends inclusive of "open").
 */
export function windowState(exam, now) {
  const w = examWindow(exam);
  if (w.startsAt !== null && now < w.startsAt) return "upcoming";
  if (w.endsAt !== null && now > w.endsAt) return "closed";
  return "open";
}

/** What utils.getExamAvailability has always returned (Dates, not ms), now computed from one place. */
export function availabilityOf(exam, now) {
  const w = examWindow(exam);
  return {
    state: windowState(exam, now),
    publishAt: w.startsAt === null ? null : new Date(w.startsAt),
    closesAt: w.endsAt === null ? null : new Date(w.endsAt),
  };
}

/** Does this student's enrolment let them see the exam at all? (No course = open to everyone.) */
export function isExamVisibleTo(exam, profile) {
  if (!exam?.courseId) return true;
  return Array.isArray(profile?.enrolledCourses) && profile.enrolledCourses.includes(exam.courseId);
}
/** "unlisted" exams are reachable by direct link only — never listed, scheduled or featured. */
export const isListed = (exam) => exam?.visibility !== "unlisted";
export const isDraftExam = (exam) => exam?.status === "draft";

/**
 * The full student-facing verdict for one exam at time `now`.
 *   ctx: { hasResult, attemptsUsed, maintenance, disabled }
 * Returns { key, label, bn, tone, reason, canStart, cta, startsAt, endsAt, msToStart, msToEnd, countdownTo }.
 *   cta: "start" | "retake" | "result" | "soon" | "none"
 */
export function computeStatus(exam, now, ctx = {}) {
  const { hasResult = false, attemptsUsed = 0, maintenance = false, disabled = false } = ctx;
  const maxAttempts = Number(exam?.maxAttempts) || 0;
  const exhausted = maxAttempts > 0 && attemptsUsed >= maxAttempts;
  const w = examWindow(exam);
  const base = { startsAt: w.startsAt, endsAt: w.endsAt, msToStart: null, msToEnd: null, countdownTo: null, reason: "", canStart: false };
  const done = (meta, extra) => ({ ...meta, ...base, ...extra });
  const afterwards = hasResult ? "result" : "none";

  if (exam?.cancelled === true) return done(STATUS.unavailable, { reason: "cancelled", cta: afterwards });

  const state = windowState(exam, now);
  if (state === "upcoming") {
    const msToStart = w.startsAt - now;
    return done(msToStart <= SOON_MS ? STATUS.soon : STATUS.upcoming, { reason: "upcoming", cta: "soon", msToStart, countdownTo: w.startsAt });
  }
  if (state === "closed") return done(hasResult ? STATUS.completed : STATUS.closed, { reason: "window-closed", cta: afterwards });

  // The window is open from here on.
  if (exhausted) return done(STATUS.completed, { reason: "attempts", cta: afterwards });
  if (!w.practice && exam?.registration === "closed") return done(STATUS.closed, { reason: "registration-closed", cta: afterwards });

  const timed = !w.practice && w.endsAt !== null;
  const canStart = !maintenance && !disabled;
  return done(timed ? STATUS.live : STATUS.open, {
    reason: maintenance ? "maintenance" : disabled ? "disabled" : "",
    canStart,
    cta: canStart ? (hasResult ? "retake" : "start") : afterwards,
    msToEnd: timed ? Math.max(0, w.endsAt - now) : null,
    countdownTo: timed ? w.endsAt : null,
  });
}

/** Admin-side status of the SCHEDULE itself: Draft / Scheduled / Live / Completed / Cancelled. */
export function adminScheduleState(exam, now) {
  if (exam?.cancelled === true) return "cancelled";
  if (isDraftExam(exam)) return "draft";
  if (exam?.examType === "practice") return "practice";
  const s = windowState(exam, now);
  if (s === "upcoming") return "scheduled";
  if (s === "closed") return "completed";
  return "live";
}
export const ADMIN_SCHEDULE_META = Object.freeze({
  draft: { label: "Draft", tone: "" },
  scheduled: { label: "Scheduled", tone: "amber" },
  live: { label: "Live", tone: "teal" },
  completed: { label: "Completed", tone: "accent" },
  cancelled: { label: "Cancelled", tone: "coral" },
  practice: { label: "Practice", tone: "" },
});

/* ==========================================================================
   Stats helpers (userStats/{uid}.exams[examId] = { n, s, t, p, b?, at, ty, ti })
   ========================================================================== */
export function statsFor(stats, examId) {
  const e = stats?.exams?.[examId];
  return e ? { hasResult: true, attemptsUsed: Number(e.n) || 0, entry: e } : { hasResult: false, attemptsUsed: 0, entry: null };
}

/** The exam as the window logic sees it, with the student's own history folded in. */
export function decorateExam(exam, now, { stats = null, maintenance = false, disabled = false } = {}) {
  const mine = statsFor(stats, exam.id);
  const status = computeStatus(exam, now, { hasResult: mine.hasResult, attemptsUsed: mine.attemptsUsed, maintenance, disabled });
  return { exam, status, last: mine.entry, attemptsUsed: mine.attemptsUsed };
}
