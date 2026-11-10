import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import * as cache from "../cache";
import { normalizeContent, normalizeTaxonomy } from "../shared";
import type { HomeFeed } from "../types";

const FEED_PATH = ["homeFeed", "main"] as const;
const KEY = "home:feed";

/** Raw document → a complete, safe feed object (missing/corrupt parts fall back to defaults) — same as js/home-data.js. */
export function normalizeFeed(d: any): Omit<HomeFeed, "ok" | "exists"> {
  const r = d && typeof d === "object" ? d : {};
  const pass = Number(r.passPercent);
  return {
    content: normalizeContent(r.content),
    notices: Array.isArray(r.notices) ? r.notices.filter((n: any) => n && n.id && n.title) : [],
    taxonomy: normalizeTaxonomy(r.taxonomy),
    participants: r.participants && typeof r.participants === "object" ? r.participants : {},
    participantsAt: Number(r.participantsAt) || 0,
    passPercent: pass > 0 ? Math.min(100, pass) : 60,
    hasTaxonomy: !!(r.taxonomy && (r.taxonomy.subjects?.length || r.taxonomy.categories?.length)),
  };
}

async function loadFeed(): Promise<HomeFeed> {
  try {
    const snap = await getDoc(doc(db, ...FEED_PATH));
    return { ...normalizeFeed(snap.exists() ? snap.data() : {}), ok: true, exists: snap.exists() };
  } catch { return { ...normalizeFeed({}), ok: false, exists: false }; }
}

/** Cached 5 min; never throws. */
export const getHomeFeed = (opts: { force?: boolean } = {}) => cache.remember(KEY, (v: HomeFeed) => (v.ok ? 5 * 60_000 : 30_000), loadFeed, opts);
export const invalidateHomeFeed = () => cache.del(KEY);

/** Admin side: replace exactly these top-level fields of homeFeed/main and leave every other field alone. */
export async function writeFeedFields(fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await setDoc(doc(db, ...FEED_PATH), { ...fields, updatedAt: serverTimestamp() }, { mergeFields: [...keys, "updatedAt"] });
  invalidateHomeFeed();
}

/** leaderboard/publicStats — anonymous percent list + the published top lists (admin publishes it, students read it). */
export const fetchPublicStats = () => cache.remember("percentile", (v: any) => (v ? 10 * 60_000 : 30_000), async () => {
  try { const snap = await getDoc(doc(db, "leaderboard", "publicStats")); return snap.exists() ? (snap.data() as any) : null; } catch { return null; }
});
