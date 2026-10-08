// ==========================================================================
// notify.js — the student notification centre (the bell in the nav + #/notifications).
//
// There is deliberately NO new "notifications" collection and no listener. The feed is DERIVED, on the
// student's device, from data the site already holds in memory:
//   • notices        homeFeed/main.notices           (admin → Notices; includes "announcements")
//   • new exam       exam catalog: created in the last 3 days
//   • starting soon  exam catalog: starts within the hour
//   • live now       exam catalog: window open, student can start
//   • schedule update exam.scheduleUpdatedAt within 3 days (stamped by admin → Exam schedule)
//   • result ready   userStats: a result saved in the last 7 days
//   • reminders      filed locally by reminders.js
// → 0 extra Firestore reads. "Read" and "dismissed" marks live in localStorage (0 writes).
//
// The legacy `notifications` collection (course-site broadcasts) is untouched and not read here.
// ==========================================================================
import { toMs, DAY, SOON_MS, computeStatus, humanizeBn, getExamQuestionCount } from "./schedule-core.js";
import { visibleNotices, noticePriority, noticeCategory, studentExams } from "./home-core.js";
import { lsGet, lsSet } from "./local-store.js";
import { addReminderChannel } from "./reminders.js";
import { serverNow } from "./server-time.js";
import { getExamCatalog, fetchUserStats, peekExamCatalog, peekUserStats } from "./exam-data.js";
import { getHomeFeed, peekHomeFeed } from "./home-data.js";

const NEW_EXAM_MS = 3 * DAY;
const SCHEDULE_UPDATE_MS = 3 * DAY;
const RESULT_MS = 7 * DAY;
const KEEP_READ_MS = 45 * DAY;

const READ_KEY = (uid) => `tvexam_read_v1:${uid}`;
const DISMISS_KEY = (uid) => `tvexam_dismiss_v1:${uid}`;
const LOCAL_KEY = (uid) => `tvexam_localnotif_v1:${uid}`;

/* ---------- read / dismissed marks (device-local) ---------- */
export function loadReadMap(uid) {
  const m = lsGet(READ_KEY(uid), {}) || {};
  const now = Date.now();
  let pruned = false;
  for (const [k, t] of Object.entries(m)) if (now - Number(t) > KEEP_READ_MS) { delete m[k]; pruned = true; }
  if (pruned) lsSet(READ_KEY(uid), m);
  return m;
}
export function markRead(uid, ids) {
  const m = loadReadMap(uid);
  const t = Date.now();
  (Array.isArray(ids) ? ids : [ids]).forEach((id) => { m[id] = t; });
  lsSet(READ_KEY(uid), m);
  announce();
}
export function markAllRead(uid, items) { markRead(uid, items.map((i) => i.id)); }
export const unreadCount = (items, readMap) => items.filter((i) => !readMap[i.id]).length;

export const dismissedNotices = (uid) => new Set(Object.keys(lsGet(DISMISS_KEY(uid), {}) || {}));
export function dismissNotice(uid, noticeId) {
  const m = lsGet(DISMISS_KEY(uid), {}) || {};
  m[noticeId] = Date.now();
  lsSet(DISMISS_KEY(uid), m);
}

/* ---------- locally filed items (reminders) ---------- */
function loadLocal(uid) {
  const list = lsGet(LOCAL_KEY(uid), []) || [];
  const now = Date.now();
  return Array.isArray(list) ? list.filter((i) => i && now - Number(i.at) < RESULT_MS) : [];
}
export function pushLocalNotification(uid, item) {
  const list = loadLocal(uid).filter((i) => i.id !== item.id);
  list.unshift(item);
  lsSet(LOCAL_KEY(uid), list.slice(0, 30));
  announce();
}

// Reminders (reminders.js) file themselves into the bell.
addReminderChannel((ev) => pushLocalNotification(ev.uid, {
  id: `rem:${ev.examId}:${ev.kind}:${ev.startsAt}`,
  kind: "reminder",
  tone: ev.kind === "start" ? "live" : ev.kind === "pre" ? "soon" : "important",
  icon: "fa-bell",
  title: ev.kind === "cancelled" ? `সময়সূচি বাতিল: ${ev.title}` : ev.kind === "changed" ? `সময় পরিবর্তন: ${ev.title}` : `রিমাইন্ডার: ${ev.title}`,
  text: ev.text,
  at: Date.now(),
  href: ev.href,
}));

/** Tell the bell (and the notifications page) that something changed. */
function announce() {
  try { window.dispatchEvent(new CustomEvent("tvexam:notifications")); } catch { /* ignore */ }
}

/* ==========================================================================
   Building the feed (pure apart from reading localStorage through `local`)
   ========================================================================== */
const TONE_WEIGHT = { urgent: 4, live: 4, important: 3, soon: 3, info: 1, normal: 1 };

export function buildFeed({ now, profile, catalog, stats, feed, local = [] }) {
  const items = [];
  const allExams = catalog?.exams || [];
  const exams = studentExams(allExams, profile);
  const categories = feed?.taxonomy?.categories || [];

  // 1. Notices
  visibleNotices(feed?.notices, { now, profile, exams: allExams, categories }).forEach((n) => {
    const p = noticePriority(n.priority);
    items.push({
      id: `notice:${n.id}`, kind: "notice", noticeId: n.id,
      tone: n.priority === "urgent" ? "urgent" : n.priority === "important" ? "important" : "normal",
      icon: noticeCategory(n.category).icon,
      title: n.title, text: n.body, full: true, priorityLabel: p.label,
      at: n.publishAt || n.createdAt || now,
      href: n.examId ? `#/exams?open=${encodeURIComponent(n.examId)}` : "",
    });
  });

  // 2. Exam events
  let newCount = 0;
  for (const e of exams) {
    const mine = stats?.exams?.[e.id];
    const st = computeStatus(e, now, { hasResult: !!mine, attemptsUsed: Number(mine?.n) || 0 });
    const open = `#/exams?open=${encodeURIComponent(e.id)}`;
    let covered = false;
    if (st.key === "live" && st.canStart) {
      covered = true;
      items.push({ id: `live:${e.id}:${st.startsAt}`, kind: "exam-live", tone: "live", icon: "fa-tower-broadcast", title: `এখন চলছে: ${e.title}`, text: "পরীক্ষা চলছে — এখনই শুরু করতে পারবেন।", at: st.startsAt || now, href: `#/exam?id=${encodeURIComponent(e.id)}` });
    } else if (st.key === "soon") {
      covered = true;
      items.push({ id: `soon:${e.id}:${st.startsAt}`, kind: "exam-soon", tone: "soon", icon: "fa-hourglass-half", title: `শীঘ্রই শুরু: ${e.title}`, text: `${humanizeBn(st.msToStart)} পরে শুরু হবে।`, at: Math.max(st.startsAt - SOON_MS, 0), href: open });
    }
    const su = toMs(e.scheduleUpdatedAt);
    const active = st.key === "live" || st.key === "soon" || st.key === "upcoming" || st.key === "unavailable";
    if (su && now - su < SCHEDULE_UPDATE_MS && active) {
      covered = true;
      items.push({ id: `sched:${e.id}:${su}`, kind: "schedule", tone: "important", icon: "fa-calendar-check", title: `সময়সূচি আপডেট: ${e.title}`, text: st.key === "unavailable" ? "এই পরীক্ষার সময়সূচি বাতিল করা হয়েছে।" : "পরীক্ষার সময় বা নিয়ম পরিবর্তন হয়েছে — বিস্তারিত দেখুন।", at: su, href: open });
    }
    const created = toMs(e.createdAt) || 0;
    if (!covered && created && now - created < NEW_EXAM_MS && newCount < 5 && st.key !== "closed" && st.key !== "completed" && st.key !== "unavailable") {
      newCount++;
      items.push({ id: `new:${e.id}`, kind: "exam-new", tone: "info", icon: "fa-file-circle-plus", title: `নতুন পরীক্ষা: ${e.title}`, text: `${getExamQuestionCount(e)} প্রশ্ন · ${Number(e.duration) || 0} মিনিট`, at: created, href: open });
    }
  }

  // 3. Results (the three most recent)
  Object.entries(stats?.exams || {})
    .filter(([, r]) => r && Number(r.at) && now - Number(r.at) < RESULT_MS)
    .sort((a, b) => Number(b[1].at) - Number(a[1].at))
    .slice(0, 3)
    .forEach(([id, r]) => items.push({ id: `res:${id}:${r.at}`, kind: "result", tone: "info", icon: "fa-square-poll-vertical", title: `ফলাফল প্রস্তুত: ${r.ti || "Exam"}`, text: `স্কোর ${r.s}/${r.t} — ${r.p}%`, at: Number(r.at), href: "#/results" }));

  // 4. Reminders filed on this device
  local.forEach((l) => items.push(l));

  return items.sort((a, b) => (TONE_WEIGHT[b.tone] || 0) - (TONE_WEIGHT[a.tone] || 0) || (b.at || 0) - (a.at || 0));
}

// The last copy of each source we saw. The 5-minute caches expire while a student sits on a page; the badge must
// keep working (a reminder just fired!) without triggering a re-read, so we fall back to the last known data.
const remembered = {};

/** Feed from what is ALREADY in memory — never triggers a read. null = nothing known yet (no badge). */
export function peekNotificationFeed(uid, profile) {
  const catalog = peekExamCatalog() || remembered.catalog;
  const feed = peekHomeFeed() || remembered.feed;
  const stats = peekUserStats(uid) || remembered.stats;
  const local = loadLocal(uid);
  if (catalog) remembered.catalog = catalog;
  if (feed) remembered.feed = feed;
  if (stats) remembered.stats = stats;
  if (!catalog && !feed && !stats && !local.length) return null;
  return buildFeed({ now: serverNow(), profile, catalog, stats, feed, local });
}

/** Loads whatever is missing (each piece is cached and shared with the pages) and builds the feed. */
export async function loadNotificationFeed(uid, profile, opts) {
  const [catalog, feed, stats] = await Promise.all([
    getExamCatalog(opts).catch(() => null),
    getHomeFeed(opts),
    fetchUserStats(uid, opts).catch(() => null),
  ]);
  if (catalog) remembered.catalog = catalog;
  if (feed) remembered.feed = feed;
  if (stats) remembered.stats = stats;
  return buildFeed({ now: serverNow(), profile, catalog, stats, feed, local: loadLocal(uid) });
}
