// ==========================================================================
// home-data.js — the one extra document the new home page needs: homeFeed/main.
//
//   homeFeed/main = {
//     content:       admin-edited text + section switches          (admin → Homepage)
//     notices:       the published notices, compact mirror          (admin → Notices)
//     taxonomy:      { subjects:[{id,name}], categories:[…] } names (admin → Subjects & categories)
//     participants:  { [examId]: students } + participantsAt        (admin → Exam schedule → refresh)
//     passPercent:   site default pass mark                         (admin → Settings → Results)
//     updatedAt
//   }
//
// READ BUDGET: students read it ONCE per 5 minutes (shared by the home page, exam list, schedule,
// notification bell …). Together with examIndex/main, userStats/{uid} and leaderboard/publicStats that is
// 4 documents for a full, cold home page — no per-exam, per-notice or per-question reads, no listeners.
// WRITE BUDGET: only admins write it, and each field is replaced on its own (mergeFields), so editing
// the banner never rewrites the notices and vice versa.
// ==========================================================================
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "./cache.js";
import { normalizeContent, normalizeTaxonomy } from "./home-core.js";

const FEED_PATH = ["homeFeed", "main"];
const KEY = "home:feed";
const TTL_OK = 5 * 60 * 1000;
const TTL_RETRY = 30 * 1000;

/** Raw document → a complete, safe feed object (missing/corrupt parts fall back to defaults). */
export function normalizeFeed(d) {
  const r = d && typeof d === "object" ? d : {};
  const pass = Number(r.passPercent);
  return {
    content: normalizeContent(r.content),
    notices: Array.isArray(r.notices) ? r.notices.filter((n) => n && n.id && n.title) : [],
    taxonomy: normalizeTaxonomy(r.taxonomy),
    participants: r.participants && typeof r.participants === "object" ? r.participants : {},
    participantsAt: Number(r.participantsAt) || 0,
    passPercent: pass > 0 ? Math.min(100, pass) : 60,
    hasTaxonomy: !!(r.taxonomy && (r.taxonomy.subjects?.length || r.taxonomy.categories?.length)),
  };
}

async function loadFeed() {
  try {
    const snap = await getDoc(doc(db, ...FEED_PATH));
    return { ...normalizeFeed(snap.exists() ? snap.data() : {}), ok: true, exists: snap.exists() };
  } catch (error) {
    // Rules not published yet / offline: the home page still works with built-in defaults.
    return { ...normalizeFeed({}), ok: false, exists: false, error };
  }
}

/** Cached 5 min; `{ force: true }` (or a click Event) re-reads. Never throws. */
export function getHomeFeed(opts) {
  return cache.remember(KEY, (v) => (v.ok ? TTL_OK : TTL_RETRY), loadFeed, { force: cache.wantsFresh(opts) });
}
/** Whatever is cached right now (or undefined) — for code that must not trigger a read. */
export const peekHomeFeed = () => cache.get(KEY);
export const invalidateHomeFeed = () => cache.del(KEY);

/**
 * Admin side. Replace exactly these top-level fields of homeFeed/main and leave every other field alone.
 * e.g. writeFeedFields({ content }) · writeFeedFields({ notices }) · writeFeedFields({ taxonomy })
 */
export async function writeFeedFields(fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await setDoc(doc(db, ...FEED_PATH), { ...fields, updatedAt: serverTimestamp() }, { mergeFields: [...keys, "updatedAt"] });
  invalidateHomeFeed();
}
