// ==========================================================================
// home-core.js — pure logic behind the student home dashboard, the exam list / schedule pages,
// the notification centre and the admin "Homepage" / "Notices" pages. No DOM, no Firebase, no
// clock reads (callers pass `now`), so every rule here is unit-tested in Node (tests/unit).
//
// Data it works on (all of it arrives through documents the student site ALREADY reads, so none
// of these helpers costs a Firestore read):
//   examIndex/main.exams[]        the exam catalog (slim exam docs)
//   homeFeed/main                 admin-managed home content, published notices, category names,
//                                 participant counts, default pass %         (see home-data.js)
//   userStats/{uid}.exams{}       the student's own result summary
//   leaderboard/publicStats       anonymous percents + top performers
// ==========================================================================
import {
  toMs, startOfDay, addDays, endOfDay, dayDiff, DAY, passPercentFor, isListed, isExamVisibleTo, decorateExam,
} from "./schedule-core.js";

/* ==========================================================================
   Home content (admin → Homepage)
   ========================================================================== */
export const SECTION_KEYS = [
  "banner", "info", "notices", "live", "next", "schedule", "quick", "featured",
  "categories", "performance", "results", "leaderboard", "motivation", "guidelines",
];
export const SECTION_LABELS = {
  banner: "Promotional banner", info: "Important information", notices: "Notice board", live: "Live now",
  next: "Next exam + countdown", schedule: "Exam schedule", quick: "Quick actions", featured: "Featured exams",
  categories: "Categories / subjects", performance: "My performance", results: "Recent results",
  leaderboard: "Top performers", motivation: "Today's motivation", guidelines: "Exam guidelines",
};

export const DEFAULT_GUIDELINES = Object.freeze([
  "পরীক্ষা শুরু করার আগে ইন্টারনেট সংযোগ ঠিক আছে কিনা দেখে নিন।",
  "একবার পরীক্ষা শুরু করলে নির্ধারিত সময়ের মধ্যেই শেষ করতে হবে।",
  "একাধিক অ্যাটেম্পট থাকলে নিয়ম অনুযায়ী অ্যাটেম্পট গণনা হবে।",
  "নেগেটিভ মার্কিং থাকলে শুরুর আগেই দেখে নিন।",
  "পরীক্ষা চলাকালে পেজ রিফ্রেশ না করার পরামর্শ দেওয়া হচ্ছে।",
  "জমা দেওয়ার আগে উত্তরগুলো আরেকবার দেখে নিন।",
]);

export const DEFAULT_MOTIVATIONS = Object.freeze([
  "আজ অনুশীলন করুন, আগামীকাল আরও ভালো করুন।",
  "Practice today. Perform better tomorrow.",
  "প্রতিটি ভুলই একটি শিক্ষা — রিভিউ দেখে নিজেকে শুধরে নিন।",
  "Small steps every day add up to big results.",
  "নিয়মিত অনুশীলনই সাফল্যের সবচেয়ে সহজ পথ।",
  "Stay calm, read carefully, answer confidently.",
  "প্রস্তুতি যত ভালো, পরীক্ষা তত সহজ।",
]);

export const DEFAULT_CONTENT = Object.freeze({
  heroTitle: "প্রস্তুত তো? আজকের পরীক্ষা শুরু করুন।",
  heroSubtitle: "",
  ctaText: "Start Exam",
  info: "",
  banner: { enabled: false, title: "", text: "", linkText: "", link: "" },
  motivation: { pinned: "", rotation: [] },
  guidelines: [],
  sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, true])),
  leaderboardNames: "full", // "full" | "first" (first name + initial) | "hidden"
});

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v, max, each) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : []);

/** Any stored value → a complete, type-safe content object (a corrupt doc can never break the home page). */
export function normalizeContent(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const b = r.banner && typeof r.banner === "object" ? r.banner : {};
  const m = r.motivation && typeof r.motivation === "object" ? r.motivation : {};
  const sections = {};
  SECTION_KEYS.forEach((k) => { sections[k] = r.sections && typeof r.sections[k] === "boolean" ? r.sections[k] : true; });
  return {
    heroTitle: str(r.heroTitle, 120) || DEFAULT_CONTENT.heroTitle,
    heroSubtitle: str(r.heroSubtitle, 220),
    ctaText: str(r.ctaText, 30) || DEFAULT_CONTENT.ctaText,
    info: str(r.info, 400),
    banner: { enabled: b.enabled === true, title: str(b.title, 90), text: str(b.text, 240), linkText: str(b.linkText, 30), link: str(b.link, 300) },
    motivation: { pinned: str(m.pinned, 200), rotation: strList(m.rotation, 60, 200) },
    guidelines: strList(r.guidelines, 20, 240),
    sections,
    leaderboardNames: r.leaderboardNames === "first" || r.leaderboardNames === "hidden" ? r.leaderboardNames : "full",
  };
}

export const guidelinesOf = (content) => (content?.guidelines?.length ? content.guidelines : DEFAULT_GUIDELINES);

/** Local calendar day number — changes at the viewer's midnight, so "today's" message flips with the day. */
export function dayNumber(now) {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/** Admin-pinned message wins; otherwise the list (or the built-in one) rotates once a day. */
export function pickMotivation(content, now) {
  const pinned = content?.motivation?.pinned;
  if (pinned) return { text: pinned, pinned: true };
  const list = content?.motivation?.rotation?.length ? content.motivation.rotation : DEFAULT_MOTIVATIONS;
  const i = ((dayNumber(now) % list.length) + list.length) % list.length;
  return { text: list[i], pinned: false };
}

/** Only in-app hash routes and http(s) links are allowed from admin-entered banner links. */
export function safeHref(link) {
  const s = String(link || "").trim();
  if (!s) return "";
  if (/^#\/[A-Za-z0-9_\-/?=&%.]*$/.test(s)) return s;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return "";
}

export const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** "Rahim Uddin" → "Rahim U." (used when the admin chose to shorten names on the public leaderboard). */
export function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Student";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.`;
}

/* ==========================================================================
   Notices (admin → Notices; students read the mirror inside homeFeed/main)
   ========================================================================== */
export const NOTICE_PRIORITY = Object.freeze({
  normal: { label: "Normal", bn: "সাধারণ", rank: 0 },
  important: { label: "Important", bn: "গুরুত্বপূর্ণ", rank: 1 },
  urgent: { label: "Urgent", bn: "জরুরি", rank: 2 },
});
export const NOTICE_CATEGORIES = Object.freeze([
  { id: "general", label: "General", icon: "fa-circle-info" },
  { id: "exam", label: "Exam", icon: "fa-file-pen" },
  { id: "schedule", label: "Schedule", icon: "fa-calendar-days" },
  { id: "result", label: "Result", icon: "fa-square-poll-vertical" },
  { id: "course", label: "Course", icon: "fa-graduation-cap" },
  { id: "maintenance", label: "Maintenance", icon: "fa-screwdriver-wrench" },
]);
export const AUDIENCE_TYPES = Object.freeze({
  all: "All students", course: "Specific course", exam: "Specific exam", category: "Specific category",
});
export const noticeCategory = (id) => NOTICE_CATEGORIES.find((c) => c.id === id) || NOTICE_CATEGORIES[0];
export const noticePriority = (id) => NOTICE_PRIORITY[id] || NOTICE_PRIORITY.normal;

export function normalizeAudience(a) {
  const type = a && AUDIENCE_TYPES[a.type] ? a.type : "all";
  const ids = Array.isArray(a?.ids) ? a.ids.map(String).filter(Boolean).slice(0, 30) : [];
  return type === "all" || !ids.length ? { type: "all", ids: [] } : { type, ids };
}

/** Admin document (Timestamps) → the compact item students download (times as plain ms). */
export function toMirrorNotice(id, d) {
  return {
    id: String(id),
    title: str(d.title, 100),
    body: str(d.body, 1200),
    category: NOTICE_CATEGORIES.some((c) => c.id === d.category) ? d.category : "general",
    priority: NOTICE_PRIORITY[d.priority] ? d.priority : "normal",
    publishAt: toMs(d.publishAt) || 0,
    expiresAt: toMs(d.expiresAt) || 0,
    audience: normalizeAudience(d.audience),
    examId: str(d.examId, 60),
    courseId: str(d.courseId, 60),
    createdAt: toMs(d.createdAt) || 0,
  };
}

/** "draft" | "scheduled" | "live" | "expired" — works for admin docs (status) and mirror items (always published). */
export function noticeState(n, now) {
  if (n?.status === "draft") return "draft";
  const from = toMs(n?.publishAt) || 0;
  const to = toMs(n?.expiresAt) || 0;
  if (from && now < from) return "scheduled";
  if (to && now >= to) return "expired";
  return "live";
}

/** Every id of the given categories plus all their sub-categories. */
export function categoryDescendants(categories, ids) {
  const out = new Set(ids);
  let grew = true;
  for (let guard = 0; grew && guard < 12; guard++) {
    grew = false;
    for (const c of categories || []) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
  }
  return out;
}

export function audienceMatches(notice, { profile = null, exams = [], categories = [] } = {}) {
  const a = normalizeAudience(notice.audience);
  if (a.type === "all") return true;
  if (a.type === "course") return a.ids.some((id) => profile?.enrolledCourses?.includes(id));
  const seen = exams.filter((e) => isListed(e) && isExamVisibleTo(e, profile));
  if (a.type === "exam") return seen.some((e) => a.ids.includes(e.id));
  const cats = categoryDescendants(categories, a.ids);
  return seen.some((e) => e.categoryId && cats.has(e.categoryId));
}

/** Notices a student should see right now: live window, right audience, most urgent first. */
export function visibleNotices(list, { now, profile, exams, categories } = {}) {
  return (list || [])
    .filter((n) => n && n.title && noticeState(n, now) === "live" && audienceMatches(n, { profile, exams, categories }))
    .sort((a, b) => noticePriority(b.priority).rank - noticePriority(a.priority).rank
      || (b.publishAt || b.createdAt || 0) - (a.publishAt || a.createdAt || 0));
}

/* ==========================================================================
   Exams: visibility, decoration, filters
   ========================================================================== */
/** Exams this student may see in lists: published (index never holds drafts), listed, enrolled. */
export function studentExams(exams, profile) {
  return (exams || []).filter((e) => e && e.id && isListed(e) && isExamVisibleTo(e, profile));
}

export function decorateAll(exams, now, ctx) {
  return exams.map((e) => decorateExam(e, now, ctx));
}

/** One of: live | upcoming | available | completed | closed — what the status filter and tabs speak. */
export function statusGroup(statusKey) {
  if (statusKey === "live") return "live";
  if (statusKey === "soon" || statusKey === "upcoming") return "upcoming";
  if (statusKey === "open") return "available";
  if (statusKey === "completed") return "completed";
  return "closed"; // closed + unavailable
}

const refTime = (it) => it.status.startsAt ?? toMs(it.exam.createdAt) ?? 0;

export function filterExams(items, f = {}, { categories = [], now = 0 } = {}) {
  const q = String(f.q || "").trim().toLowerCase();
  const catSet = f.category ? categoryDescendants(categories, [f.category]) : null;
  const today = startOfDay(now);
  return items.filter((it) => {
    const e = it.exam;
    const practice = e.examType === "practice";
    if (f.type === "practice" && !practice) return false;
    if (f.type === "live" && practice) return false;
    if (f.status && statusGroup(it.status.key) !== f.status) return false;
    if (f.subject && e.subjectId !== f.subject) return false;
    if (catSet && !catSet.has(e.categoryId)) return false;
    if (f.difficulty && e.difficulty !== f.difficulty) return false;
    if (f.date) {
      const t = it.status.startsAt;
      const g = statusGroup(it.status.key);
      if (f.date === "today" && !(g === "live" || (t !== null && t >= today && t < endOfDay(today)))) return false;
      if (f.date === "week" && !(g === "live" || (t !== null && t >= now && t < addDays(today, 7)))) return false;
      if (f.date === "upcoming" && g !== "upcoming") return false;
      if (f.date === "past" && g !== "completed" && g !== "closed") return false;
    }
    if (q) {
      const hay = `${e.title || ""} ${e.courseName || ""} ${e.description || ""} ${f._names?.(e) || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const STATUS_ORDER = { live: 0, soon: 1, upcoming: 2, open: 3, completed: 4, closed: 5, unavailable: 6 };
export function sortExams(items, mode = "smart") {
  const list = items.slice();
  if (mode === "newest") return list.sort((a, b) => (toMs(b.exam.createdAt) || 0) - (toMs(a.exam.createdAt) || 0));
  if (mode === "title") return list.sort((a, b) => String(a.exam.title).localeCompare(String(b.exam.title), "bn"));
  // smart: live → starting soon → upcoming (soonest first) → available (newest first) → the rest (newest first)
  return list.sort((a, b) => {
    const oa = STATUS_ORDER[a.status.key], ob = STATUS_ORDER[b.status.key];
    if (oa !== ob) return oa - ob;
    if (a.status.key === "live") return (a.status.endsAt ?? Infinity) - (b.status.endsAt ?? Infinity);
    if (a.status.key === "soon" || a.status.key === "upcoming") return (a.status.startsAt || 0) - (b.status.startsAt || 0);
    return (toMs(b.exam.createdAt) || 0) - (toMs(a.exam.createdAt) || 0);
  });
}

/* ---------- Schedule ---------- */
/** Does this exam have a real schedule (a start or an end)? Practice exams never do. */
export const hasSchedule = (e) => e?.examType !== "practice" && (toMs(e?.publishAt) !== null || toMs(e?.closesAt) !== null);

/**
 * Items for the schedule views. Upcoming / starting soon / live always; a cancelled schedule while it
 * still matters (starts in the future, or ended less than `pastMs` ago); finished ones only with includePast.
 */
export function scheduleItems(items, now, { includePast = false, pastMs = DAY } = {}) {
  const rows = items.filter((it) => {
    if (!hasSchedule(it.exam)) return false;
    const k = it.status.key;
    if (k === "live" || k === "soon" || k === "upcoming") return true;
    const s = it.status.startsAt, e = it.status.endsAt;
    const recent = (e ?? s ?? 0) >= now - pastMs;
    if (k === "unavailable") return (s !== null && s >= now - pastMs) || recent;
    if (k === "completed" || k === "closed") return includePast ? true : false;
    return false; // "open" with a start in the past and no end = just available, not a scheduled event
  });
  return rows.sort((a, b) => {
    if ((a.status.key === "live") !== (b.status.key === "live")) return a.status.key === "live" ? -1 : 1;
    return (a.status.startsAt ?? a.status.endsAt ?? 0) - (b.status.startsAt ?? b.status.endsAt ?? 0);
  });
}

/** [{ key, dayStart, diff, rows }] — one heading per local calendar day, in the order given. */
export function groupByDay(items, now) {
  const groups = [];
  for (const it of items) {
    const t = it.status.startsAt ?? it.status.endsAt ?? now;
    const ds = startOfDay(t);
    let g = groups[groups.length - 1];
    if (!g || g.dayStart !== ds) { g = { key: String(ds), dayStart: ds, diff: dayDiff(t, now), rows: [] }; groups.push(g); }
    g.rows.push(it);
  }
  return groups;
}

/** The next exam that has not started yet (cancelled ones never count). */
export function nextExamItem(items) {
  return items
    .filter((it) => it.status.key === "soon" || it.status.key === "upcoming")
    .sort((a, b) => a.status.startsAt - b.status.startsAt)[0] || null;
}
export const liveItems = (items) => items
  .filter((it) => it.status.key === "live")
  .sort((a, b) => (a.status.endsAt ?? Infinity) - (b.status.endsAt ?? Infinity));

/** Numbers for the hero strip + personalised sentence. */
export function heroNumbers(items, now) {
  const endToday = endOfDay(now);
  const live = items.filter((it) => it.status.key === "live");
  const upcoming = items.filter((it) => it.status.key === "soon" || it.status.key === "upcoming");
  const available = items.filter((it) => it.status.canStart);
  const today = items.filter((it) => {
    if (it.exam.examType === "practice") return false;
    const k = it.status.key;
    if (k === "live") return it.status.canStart;
    return (k === "soon" || k === "upcoming") && it.status.startsAt < endToday;
  });
  return { live: live.length, upcoming: upcoming.length, available: available.length, today: today.length };
}

/* ==========================================================================
   Taxonomy mirror (admin examTaxonomy/main → homeFeed/main.taxonomy; names only)
   ========================================================================== */
export function normalizeTaxonomy(t) {
  const subjects = Array.isArray(t?.subjects) ? t.subjects.filter((s) => s && s.id).map((s) => ({ id: String(s.id), name: str(s.name, 80) })) : [];
  const categories = Array.isArray(t?.categories)
    ? t.categories.filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: str(c.name, 80), parentId: c.parentId ? String(c.parentId) : null }))
    : [];
  return { subjects, categories };
}

export const subjectNameOf = (tax, id) => tax?.subjects?.find((s) => s.id === id)?.name || "";
export function categoryPathOf(tax, id) {
  const names = [];
  let node = tax?.categories?.find((c) => c.id === id);
  for (let guard = 0; node && guard < 12; guard++) {
    names.unshift(node.name);
    node = node.parentId ? tax.categories.find((c) => c.id === node.parentId) : null;
  }
  return names.join(" › ");
}
export function categoryNameOf(tax, id) {
  return tax?.categories?.find((c) => c.id === id)?.name || "";
}

/** Subject tiles: [{ id, name, count }] — only subjects that have at least one visible exam. */
export function subjectRollup(tax, exams) {
  const counts = new Map();
  exams.forEach((e) => { if (e.subjectId) counts.set(e.subjectId, (counts.get(e.subjectId) || 0) + 1); });
  return (tax?.subjects || [])
    .filter((s) => counts.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, count: counts.get(s.id) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "bn"));
}

/** Category chips: [{ id, name, count }] — a parent counts its sub-categories' exams too. */
export function categoryRollup(tax, exams) {
  const cats = tax?.categories || [];
  return cats
    .map((c) => {
      const set = categoryDescendants(cats, [c.id]);
      return { id: c.id, name: c.name, parentId: c.parentId, count: exams.filter((e) => e.categoryId && set.has(e.categoryId)).length };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "bn"));
}

/* ==========================================================================
   Student performance (from userStats/{uid}.exams — no extra reads)
   entry = { n attempts, s score, t total, p latest %, b best % (new, optional), at ms, ty, ti }
   ========================================================================== */
export const bestOf = (entry) => (Number.isFinite(Number(entry?.b)) ? Number(entry.b) : Number(entry?.p) || 0);

export function performanceFromStats(stats, { examsById = {}, defaultPass = 60 } = {}) {
  const rows = Object.entries(stats?.exams || {}).map(([examId, e]) => ({ examId, ...e }));
  const live = rows.filter((r) => r.ty !== "practice");
  const basis = live.length ? live : rows;
  const passLine = (r) => passPercentFor(examsById[r.examId], defaultPass);
  const passed = basis.filter((r) => bestOf(r) >= passLine(r)).length;
  return {
    rows,
    taken: rows.length,
    liveTaken: live.length,
    attempts: rows.reduce((s, r) => s + (Number(r.n) || 0), 0),
    basis: live.length ? "live" : "practice",
    avg: basis.length ? Math.round(basis.reduce((s, r) => s + bestOf(r), 0) / basis.length) : 0,
    best: basis.length ? Math.max(...basis.map(bestOf)) : 0,
    passRate: basis.length ? Math.round((passed * 100) / basis.length) : null,
    ownLiveAvg: live.length ? Math.round(live.reduce((s, r) => s + bestOf(r), 0) / live.length) : null,
  };
}

/** Standing among everyone's published averages. Same ordering rule as the admin leaderboard (average of best per live exam). */
export function rankOf(percents, ownAvg) {
  if (!Array.isArray(percents) || percents.length < 2 || ownAvg === null || ownAvg === undefined) return null;
  const better = percents.filter((p) => Number(p) > ownAvg).length;
  return { rank: better + 1, total: Math.max(percents.length, better + 1) };
}

export function recentResultRows(stats, { examsById = {}, defaultPass = 60, limit = 5 } = {}) {
  return Object.entries(stats?.exams || {})
    .map(([examId, e]) => ({
      examId,
      title: e.ti || examsById[examId]?.title || "Exam",
      score: Number(e.s) || 0, total: Number(e.t) || 0, percent: Number(e.p) || 0,
      at: Number(e.at) || 0, type: e.ty === "practice" ? "practice" : "live", attempts: Number(e.n) || 0,
      pass: (Number(e.p) || 0) >= passPercentFor(examsById[examId], defaultPass),
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Top performers list → what the student sees, honouring the admin's name-privacy choice. */
export function topPerformers(publicStats, mode = "full", limit = 5) {
  const top = Array.isArray(publicStats?.top) ? publicStats.top : [];
  return top.slice(0, limit).map((t, i) => ({
    rank: i + 1,
    name: mode === "hidden" ? `Student ${i + 1}` : mode === "first" ? shortName(t.n) : String(t.n || "Student"),
    percent: Number(t.p) || 0,
    exams: Number(t.e) || 0,
  }));
}

/* ==========================================================================
   Leaderboard publishing (admin side) — what goes into leaderboard/publicStats.top
   ========================================================================== */
/**
 * `mode` is the admin's privacy choice (Admin → Homepage): "full" names, "first" = "Rahim U.", "hidden" = publish no
 * names at all (an empty list — masking at READ time would still leave the real names inside the document).
 */
export function buildTopList(rankedRows, size = 10, mode = "full") {
  if (mode === "hidden") return [];
  return rankedRows.slice(0, size).map((r) => ({
    n: (mode === "first" ? shortName(r.displayName) : String(r.displayName || "Student")).slice(0, 60),
    p: Math.round(Number(r.avgPercent) || 0),
    e: Number(r.examsTaken) || 0,
  }));
}

/* ==========================================================================
   Greeting + hero sentence
   ========================================================================== */
export function greetingBn(now) {
  const h = new Date(now).getHours();
  if (h < 5) return "শুভ রাত্রি";
  if (h < 12) return "শুভ সকাল";
  if (h < 16) return "শুভ দুপুর";
  if (h < 18) return "শুভ অপরাহ্ন";
  return "শুভ সন্ধ্যা";
}

