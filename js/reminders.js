// ==========================================================================
// reminders.js — "Remind me" for upcoming exams.
//
// STORAGE: on the student's own device (localStorage, per account) — ZERO Firestore reads or writes,
// no matter how often a reminder is set, cancelled or fired. See `adapter` below: swapping it for a
// Firestore / push-subscription adapter later is a one-object change; nothing else needs to move.
//
// DELIVERY goes through "channels". Today there are three, all optional and independent:
//   1. in-app toast        (always, while the site is open)
//   2. notification bell   (notify.js registers a channel that files the reminder in the bell)
//   3. browser notification (only if the student allowed it AND the tab is in the background)
// A future PWA / web-push channel is just another function passed to addReminderChannel().
//
// WHEN: 15 minutes before the start ("pre") and at the start ("start"). The scheduler re-checks every
// 20 s while the site is open and once whenever the tab becomes visible, so a reminder that came due
// while the phone was asleep is still delivered (once) the moment the student comes back.
// If the admin reschedules or cancels the exam, the reminder follows it automatically.
// ==========================================================================
import { toMs, DAY, MINUTE } from "./schedule-core.js";
import { lsGet, lsSet } from "./local-store.js";
import { serverNow } from "./server-time.js";
import { toast } from "./utils.js";

export const REMIND_LEAD_MS = 15 * MINUTE;
const KEY = (uid) => `tvexam_rem_v1:${uid}`;
const ASKED_KEY = "tvexam_notif_asked_v1";

/** Where reminders live. Replace both functions to sync across devices (e.g. a Firestore doc per student). */
export const adapter = {
  load: (uid) => lsGet(KEY(uid), {}) || {},
  save: (uid, data) => lsSet(KEY(uid), data),
};

const listeners = new Set();
const emitChange = () => listeners.forEach((fn) => { try { fn(); } catch { /* a bad listener must not break others */ } });
/** Subscribe to "a reminder was set / cancelled / dropped". Returns an unsubscribe function. */
export function onRemindersChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const readAll = (uid) => { const d = adapter.load(uid); return d && typeof d === "object" ? d : {}; };

export const hasReminder = (uid, examId) => !!readAll(uid)[examId];
export const reminderIds = (uid) => new Set(Object.keys(readAll(uid)));
export const reminderCount = (uid) => Object.keys(readAll(uid)).length;

/** Can a reminder be set for this exam right now? (scheduled in the future, not cancelled, not switched off by the admin) */
export function canRemind(exam, now = serverNow()) {
  if (!exam || exam.examType === "practice" || exam.cancelled === true || exam.reminderEnabled === false) return false;
  const startsAt = toMs(exam.publishAt);
  return startsAt !== null && startsAt > now;
}

export function setReminder(uid, exam, now = serverNow()) {
  if (!uid || !canRemind(exam, now)) return false;
  const all = readAll(uid);
  all[exam.id] = { startsAt: toMs(exam.publishAt), title: String(exam.title || "Exam").slice(0, 120), setAt: now, fired: {} };
  adapter.save(uid, all);
  emitChange();
  return true;
}

export function cancelReminder(uid, examId) {
  const all = readAll(uid);
  if (!all[examId]) return false;
  delete all[examId];
  adapter.save(uid, all);
  emitChange();
  return true;
}

/* ---------- channels ---------- */
const channels = [];
/** fn(event) — event = { uid, kind: "pre"|"start"|"changed"|"cancelled", examId, title, startsAt, text, href } */
export function addReminderChannel(fn) {
  if (!channels.includes(fn)) channels.push(fn);
  return () => { const i = channels.indexOf(fn); if (i >= 0) channels.splice(i, 1); };
}
const deliver = (ev) => channels.forEach((fn) => { try { fn(ev); } catch { /* one broken channel never blocks the rest */ } });

const toastChannel = (ev) => toast(`${ev.title} — ${ev.text}`, ev.kind === "cancelled" ? "error" : "info");

function browserChannel(ev) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && document.visibilityState === "visible") return; // the toast already covers it
    const n = new Notification(ev.title, { body: ev.text, tag: `exam-${ev.examId}-${ev.kind}` });
    n.onclick = () => { try { window.focus(); window.location.hash = ev.href; n.close(); } catch { /* ignore */ } };
  } catch { /* unsupported (e.g. iOS Safari outside a PWA) */ }
}
addReminderChannel(toastChannel);
addReminderChannel(browserChannel);

/** Ask for browser-notification permission — at most once per device, only after the student set a reminder. */
export async function maybeAskBrowserPermission() {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return Notification?.permission || "unsupported";
    if (lsGet(ASKED_KEY, false)) return Notification.permission;
    lsSet(ASKED_KEY, true);
    return await Notification.requestPermission();
  } catch { return "unsupported"; }
}
export const browserPermission = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

/* ---------- evaluation ---------- */
const examHref = (id) => `#/exams?open=${encodeURIComponent(id)}`;

/**
 * Walk the stored reminders against `now` (and, when known, the live exam list) and return the events
 * that are due. Pure apart from persisting the "already told you" flags — easy to unit test.
 * `exams` may be null (catalog not in memory): then only the clock is used, nothing is reconciled.
 */
export function evaluateReminders(uid, now, exams, { humanize = (ms) => `${Math.round(ms / MINUTE)} min` } = {}) {
  const all = readAll(uid);
  const events = [];
  let dirty = false;
  for (const [examId, r] of Object.entries(all)) {
    const ex = exams ? exams.find((e) => e.id === examId) : undefined;
    if (exams) {
      if (!ex || ex.cancelled === true || ex.reminderEnabled === false) {
        events.push({ uid, kind: "cancelled", examId, title: r.title, startsAt: r.startsAt, text: "এই পরীক্ষার সময়সূচি বাতিল বা সরানো হয়েছে।", href: "#/schedule" });
        delete all[examId]; dirty = true; continue;
      }
      const startsAt = toMs(ex.publishAt);
      if (startsAt === null) { delete all[examId]; dirty = true; continue; }
      if (startsAt !== r.startsAt) {
        r.startsAt = startsAt; r.fired = {}; r.title = String(ex.title || r.title).slice(0, 120); dirty = true;
        events.push({ uid, kind: "changed", examId, title: r.title, startsAt, text: "পরীক্ষার সময় পরিবর্তন হয়েছে — নতুন সময় দেখে নিন।", href: examHref(examId) });
      }
    }
    r.fired = r.fired || {};
    if (!r.fired.pre && now >= r.startsAt - REMIND_LEAD_MS && now < r.startsAt) {
      r.fired.pre = true; dirty = true;
      events.push({ uid, kind: "pre", examId, title: r.title, startsAt: r.startsAt, text: `${humanize(r.startsAt - now)} পরে শুরু হবে।`, href: examHref(examId) });
    }
    if (!r.fired.start && now >= r.startsAt) {
      r.fired.start = true; r.fired.pre = true; dirty = true;
      events.push({ uid, kind: "start", examId, title: r.title, startsAt: r.startsAt, text: "পরীক্ষা এখন শুরু হয়েছে।", href: examHref(examId) });
    }
    if (now > r.startsAt + DAY) { delete all[examId]; dirty = true; } // tidy up old reminders
  }
  if (dirty) { adapter.save(uid, all); emitChange(); }
  return events;
}

/* ---------- scheduler ---------- */
let timer = null;
let visHandler = null;

/**
 * Start (or restart) the background check. `ctx()` returns { uid, exams|null, humanize } and must NOT trigger
 * Firestore reads — pass the exams only if they are already in memory.
 */
export function startReminderScheduler(ctx) {
  stopReminderScheduler();
  const tick = () => {
    const { uid, exams, humanize } = ctx() || {};
    if (!uid) return;
    evaluateReminders(uid, serverNow(), exams || null, { humanize }).forEach(deliver);
  };
  tick();
  timer = setInterval(tick, 20 * 1000);
  visHandler = () => { if (document.visibilityState === "visible") tick(); };
  document.addEventListener("visibilitychange", visHandler);
}

export function stopReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  if (visHandler) document.removeEventListener("visibilitychange", visHandler);
  visHandler = null;
}
