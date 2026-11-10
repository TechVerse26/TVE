// ==========================================================================
// exam-session-core.js — the pure rules behind "my exam survived a refresh".
//
// No DOM, no Firebase, no storage, no clock: every function takes what it needs (including `now`)
// and returns a plain value, so tests/unit/session.test.mjs can pin the behaviour down in Node.
// The thin browser side (storage, tab lock, autosave, resume screen, banner) is js/exam-session.js.
//
// What a saved attempt is
//   One JSON document per (student, exam) in localStorage: the exact question pool of THIS attempt
//   (question order, option order, answer key — so resuming never needs the network, and still works
//   after the exam window has closed), the answers + locks + current question, the attempt id (so the
//   final save stays idempotent — see saveResult in exam-data.js) and a DEADLINE on the server clock.
//   Never a "seconds left" counter: time keeps running while the student is away, so closing the app
//   can never buy extra time.
//
// Lifecycle
//   active ──(submit)──▶ submitted ──(stored in Firestore)──▶ gone
//     │                      │
//     │                      └─ result could not be stored (offline at the very end) → "unsaved":
//     │                         saved again later, with the SAME attempt id (no duplicate attempt)
//     └─ time ran out while the student was away → "expired": the saved answers are submitted on return
//
// Integrity: `sig` (FNV-1a over a canonical form) only catches corruption and half-written data.
// It is NOT tamper-proofing — nothing kept on the student's own device can be (README → limitations).
// ==========================================================================

export const SESSION_VERSION = 1;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const KEY_PREFIX = "tvexam:s1:";        // + uid + ":" + examId   → the saved attempt
export const LOCK_PREFIX = "tvexam:s1lock:";   // + uid + ":" + examId   → which tab is running it
export const LOCK_BEAT_MS = 4 * SECOND;        // a running tab refreshes its lock this often …
export const LOCK_FRESH_MS = 12 * SECOND;      // … so a lock younger than this belongs to a live tab
export const EXPIRED_KEEP_MS = 7 * DAY;        // an unsubmitted attempt whose time ran out can still be submitted for this long
export const SUBMITTED_KEEP_MS = 3 * DAY;      // a submitted-but-unstored attempt can still be stored for this long
export const MAX_CHARS = 1000000;              // ≈ 2 MB of UTF-16 — far below the ~5 MB localStorage quota

/** Only these exam fields travel with a saved attempt: everything the take screen, the score, the result screen and the save read. */
export const EXAM_FIELDS = [
  "id", "title", "examType", "duration", "layout", "negativeMarking", "courseId", "courseName",
  "maxAttempts", "passPercent", "subjectId", "questionCount", "questionsPerAttempt", "shuffle",
];

/* ==========================================================================
   Canonical form + checksum
   ========================================================================== */

/** JSON with sorted keys, `undefined` dropped — identical for identical data, before and after a JSON round trip. */
export function stableStringify(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** FNV-1a, 32 bit, as 8 hex digits. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const withoutSig = (obj) => { const { sig, ...rest } = obj; return rest; };
const sigOf = (obj) => hash32(stableStringify(withoutSig(obj)));
const seal = (obj) => ({ ...withoutSig(obj), sig: sigOf(obj) });

/* ==========================================================================
   Building a saved attempt
   ========================================================================== */

/** The exam fields worth keeping — plain strings / numbers / booleans only (a Firestore Timestamp never sneaks in). */
export function pickExam(exam) {
  const out = {};
  for (const key of EXAM_FIELDS) {
    const v = exam?.[key];
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  return out;
}

/** The pool exactly as this attempt shows it (already shuffled), reduced to what scoring and review need. */
export function pickQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((q) => ({
    id: String(q?.id),
    text: String(q?.text ?? ""),
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => String(o ?? "")),
    correctIndex: Number.isInteger(q?.correctIndex) ? q.correctIndex : -1,
    explanation: String(q?.explanation ?? ""),
  }));
}

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)));

/** A brand-new attempt that starts at `now` (server time, ms) and must be over `durationSec` later. */
export function createSession({ uid, examId, attemptId, now, durationSec, attemptsSoFar = 0, layout = "one", exam, questions }) {
  const dur = Math.max(1, Math.floor(Number(durationSec) || 0));
  return seal({
    v: SESSION_VERSION,
    uid: String(uid),
    examId: String(examId),
    attemptId: String(attemptId),
    phase: "active",
    startedAt: now,
    deadline: now + dur * SECOND,
    durationSec: dur,
    savedAt: now,
    submittedAt: null,
    leftAtSubmit: null,
    auto: false,
    attemptsSoFar: Math.max(0, Math.floor(Number(attemptsSoFar) || 0)),
    layout: layout === "all" ? "all" : "one",
    index: 0,
    exam: pickExam(exam),
    questions: pickQuestions(questions),
    answers: {},
    locked: [],
    times: {},
  });
}

/**
 * The same attempt with the student's latest progress. Pure: `session` is never modified.
 * Unknown question ids, impossible option numbers and junk times are dropped, so what is stored is always restorable.
 */
export function updateProgress(session, { answers, locked, index, times, now }) {
  const byId = new Map(session.questions.map((q) => [q.id, q]));
  const cleanAnswers = {};
  for (const [id, v] of Object.entries(answers || {})) {
    const q = byId.get(id);
    if (q && Number.isInteger(v) && v >= 0 && v < q.options.length) cleanAnswers[id] = v;
  }
  const cleanLocked = [...(locked || [])].filter((id) => byId.has(id));
  const cleanTimes = {};
  for (const [id, v] of Object.entries(times || {})) {
    if (byId.has(id) && Number.isFinite(v) && v >= 0) cleanTimes[id] = Math.round(v * 10) / 10;
  }
  return seal({
    ...session,
    answers: cleanAnswers,
    locked: cleanLocked,
    times: cleanTimes,
    index: clampInt(index, 0, session.questions.length - 1),
    savedAt: now,
  });
}

/** The student pressed Submit (or the timer did). Keeps the attempt until it is safely stored; a second call changes nothing. */
export function markSubmitted(session, { now, leftSec, auto = false }) {
  if (session.phase === "submitted") return session;
  return seal({
    ...session,
    phase: "submitted",
    submittedAt: now,
    savedAt: now,
    leftAtSubmit: clampInt(leftSec, 0, session.durationSec),
    auto: !!auto,
  });
}

/* ==========================================================================
   Time
   ========================================================================== */

/** The latest moment this attempt may end: the stored deadline, but never later than start + duration. */
export const hardDeadline = (session) => Math.min(session.deadline, session.startedAt + session.durationSec * SECOND);

/** Whole seconds left on the clock at `now` — never negative, never more than the exam's own duration. */
export function secondsLeft(session, now) {
  return clampInt(Math.ceil((hardDeadline(session) - now) / SECOND), 0, session.durationSec);
}

export function answeredCount(session) {
  const ids = new Set(session.questions.map((q) => q.id));
  return Object.keys(session.answers || {}).filter((id) => ids.has(id)).length;
}

/**
 * What should happen with this saved attempt right now?
 *   "resume"   time is left                                  → carry on where the student stopped
 *   "expired"  time ran out while away, answers exist        → submit what was answered
 *   "unsaved"  already submitted, the result was not stored  → store it (same attempt id)
 *   "stale"    nothing worth keeping (no answers / too old)  → delete silently
 */
export function judge(session, now) {
  const total = session.questions.length;
  const answered = answeredCount(session);
  if (session.phase === "submitted") {
    const age = now - (session.submittedAt || session.savedAt || 0);
    return { state: age > SUBMITTED_KEEP_MS ? "stale" : "unsaved", left: session.leftAtSubmit ?? 0, answered, total };
  }
  const left = secondsLeft(session, now);
  if (left > 0) return { state: "resume", left, answered, total };
  const overdue = now - hardDeadline(session);
  // An attempt abandoned without a single answer is not submitted as a blank result — it would burn one of the student's attempts for nothing.
  if (answered === 0 || overdue > EXPIRED_KEEP_MS) return { state: "stale", left: 0, answered, total };
  return { state: "expired", left: 0, answered, total };
}

/** Of several saved attempts, the one the banner should talk about: running ones first (least time left first), then unsaved, then expired. */
export function pickUrgent(items) {
  const rank = { resume: 0, unsaved: 1, expired: 2 };
  const live = (items || []).filter((it) => it && rank[it.verdict?.state] !== undefined);
  live.sort((a, b) => {
    const ra = rank[a.verdict.state], rb = rank[b.verdict.state];
    if (ra !== rb) return ra - rb;
    if (a.verdict.state === "resume") return a.verdict.left - b.verdict.left;
    return (b.session.savedAt || 0) - (a.session.savedAt || 0);
  });
  return live[0] || null;
}

/** "08:24", or "1:08:24" from an hour up. */
export function clockLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

/* ==========================================================================
   Reading it back
   ========================================================================== */

function shapeProblem(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "shape";
  if (s.v !== SESSION_VERSION) return "version";
  for (const k of ["uid", "examId", "attemptId", "sig"]) if (typeof s[k] !== "string" || !s[k]) return "shape";
  if (s.phase !== "active" && s.phase !== "submitted") return "shape";
  for (const k of ["startedAt", "deadline", "durationSec", "savedAt"]) if (!Number.isFinite(s[k])) return "shape";
  if (s.durationSec <= 0) return "shape";
  if (!Array.isArray(s.questions) || s.questions.length === 0) return "shape";
  for (const q of s.questions) {
    if (!q || typeof q.id !== "string" || typeof q.text !== "string" || typeof q.explanation !== "string") return "shape";
    if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.every((o) => typeof o === "string")) return "shape";
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) return "shape";
  }
  if (!s.answers || typeof s.answers !== "object" || Array.isArray(s.answers)) return "shape";
  if (!s.times || typeof s.times !== "object" || Array.isArray(s.times)) return "shape";
  if (!Array.isArray(s.locked)) return "shape";
  if (!s.exam || typeof s.exam !== "object") return "shape";
  if (!Number.isInteger(s.index) || s.index < 0 || s.index >= s.questions.length) return "shape";
  if (sigOf(s) !== s.sig) return "sig";
  return "";
}

/**
 * Text (or an already-parsed object) from storage → { ok: true, session } or { ok: false, reason }.
 * reason: "empty" | "json" | "version" | "shape" | "sig" | "owner" (belongs to another student / exam).
 */
export function parseSession(raw, { uid, examId } = {}) {
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: "empty" };
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { ok: false, reason: "json" }; }
  }
  const problem = shapeProblem(obj);
  if (problem) return { ok: false, reason: problem };
  if ((uid !== undefined && obj.uid !== uid) || (examId !== undefined && obj.examId !== examId)) return { ok: false, reason: "owner" };
  return { ok: true, session: obj };
}

/** The text to store, or null when it would be too big for localStorage (then the attempt simply isn't saved). */
export function serializeSession(session) {
  const json = JSON.stringify(session);
  return json.length <= MAX_CHARS ? json : null;
}

/** Everything the exam screen needs to carry on — fresh copies, so the saved object is never shared with live state. */
export function toRestorePlan(session, now) {
  const byId = new Map(session.questions.map((q) => [q.id, q]));
  const answers = {};
  for (const [id, v] of Object.entries(session.answers)) {
    const q = byId.get(id);
    if (q && Number.isInteger(v) && v >= 0 && v < q.options.length) answers[id] = v;
  }
  return {
    phase: session.phase,
    exam: { ...session.exam },
    questions: session.questions.map((q) => ({ ...q, options: q.options.slice() })),
    answers,
    locked: session.locked.filter((id) => byId.has(id)),
    index: clampInt(session.index, 0, session.questions.length - 1),
    layout: session.layout === "all" ? "all" : "one",
    attemptId: session.attemptId,
    attemptsSoFar: session.attemptsSoFar || 0,
    times: { ...session.times },
    secondsLeft: session.phase === "submitted" ? clampInt(session.leftAtSubmit ?? 0, 0, session.durationSec) : secondsLeft(session, now),
    auto: !!session.auto,
  };
}

/** What the resume screen and the banner print. */
export function describe(session, now) {
  const verdict = judge(session, now);
  return {
    examId: session.examId,
    title: session.exam?.title || "পরীক্ষা",
    state: verdict.state,
    left: verdict.left,
    answered: verdict.answered,
    total: verdict.total,
  };
}

/* ==========================================================================
   Storage keys + the "one tab at a time" lock
   ========================================================================== */

export const sessionKey = (uid, examId) => `${KEY_PREFIX}${uid}:${examId}`;
export const lockKey = (uid, examId) => `${LOCK_PREFIX}${uid}:${examId}`;

/** "tvexam:s1:<uid>:<examId>" → { uid, examId }; anything else → null. */
export function parseSessionKey(key) {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { uid: rest.slice(0, cut), examId: rest.slice(cut + 1) };
}

export const makeLock = (tabId, now) => ({ tab: String(tabId), at: now });

export function parseLock(raw) {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj.tab === "string" && Number.isFinite(obj.at) ? { tab: obj.tab, at: obj.at } : null;
  } catch {
    return null;
  }
}

/** "free" (nobody runs it, or that tab went quiet) · "mine" · "other" (a live tab is running this attempt right now). */
export function lockStatus(lock, tabId, now) {
  if (!lock) return "free";
  if (lock.tab === tabId) return "mine";
  return now - lock.at < LOCK_FRESH_MS ? "other" : "free";
}
