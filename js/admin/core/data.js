// ==========================================================================
// admin/core/data.js — read-frugal data helpers for the dashboard.
// Free plan = 50,000 reads/day, so nothing here scans a whole collection:
//   • counts / sums / averages come from Firestore aggregation queries (~1 read per 1,000 docs)
//   • "recent" lists use a date-bounded, capped query — or reuse the results download another
//     tab already made (zero reads)
// Everything is cached in memory (see ../../cache.js); the ⟳ buttons pass { force: true }.
// ==========================================================================
import { db } from "../../firebase-config.js";
import * as FS from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "../../cache.js";

const { collection, query, where, orderBy, limit, getDocs, Timestamp } = FS;
// Read off the namespace on purpose (same pattern as exam-data.js): an old SDK without aggregation still loads the page.
const { getAggregateFromServer, count, sum, average } = FS;

const TTL = 5 * 60 * 1000;
const aggOk = () => !!(getAggregateFromServer && count && sum && average);
const num = (v) => Number(v) || 0;

/** { users, disabledUsers, admins, resultDocs, attempts, avgPercent, takers|null } — a handful of reads in total. */
export function dashboardCounts(opts) {
  return cache.remember("admin:dash-counts", TTL, async () => {
    if (!aggOk()) throw new Error("aggregate-unsupported");
    const safe = (p) => p.then((s) => s.data()).catch(() => null);
    const [users, off, admins, results, takers] = await Promise.all([
      getAggregateFromServer(collection(db, "users"), { n: count() }).then((s) => s.data()),
      safe(getAggregateFromServer(query(collection(db, "users"), where("disabled", "==", true)), { n: count() })),
      safe(getAggregateFromServer(query(collection(db, "users"), where("isAdmin", "==", true)), { n: count() })),
      getAggregateFromServer(collection(db, "results"), { docs: count(), attempts: sum("attemptNumber"), avg: average("percent") }).then((s) => s.data()),
      safe(getAggregateFromServer(query(collection(db, "userStats"), where("examsTaken", ">", 0)), { n: count() })),
    ]);
    return {
      users: num(users.n), disabledUsers: num(off?.n), admins: num(admins?.n),
      resultDocs: num(results.docs), attempts: Math.max(num(results.attempts), num(results.docs)),
      avgPercent: Math.round(num(results.avg)), takers: takers ? num(takers.n) : null,
    };
  }, { force: cache.wantsFresh(opts) });
}

/** Result documents whose latest attempt is within `days`, newest first, at most `cap` docs. */
export function recentResults({ days = 30, cap = 400 } = {}, opts) {
  return cache.remember(`admin:recent-${days}-${cap}`, TTL, async () => {
    const all = cache.get("admin:results"); // another tab already downloaded everything → reuse, 0 reads
    const since = Date.now() - days * 86400000;
    if (all) {
      const rows = all.filter((r) => (r.submittedAt?.seconds || 0) * 1000 >= since);
      return { rows: rows.slice(0, cap), capped: rows.length > cap, fromCache: true };
    }
    const snap = await getDocs(query(collection(db, "results"), where("submittedAt", ">=", Timestamp.fromMillis(since)), orderBy("submittedAt", "desc"), limit(cap)));
    return { rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })), capped: snap.size >= cap, fromCache: false };
  }, { force: cache.wantsFresh(opts) });
}

export function clearDashboardCache() {
  cache.delPrefix("admin:dash-counts");
  cache.delPrefix("admin:recent-");
}

/** { [uid]: userDoc } for just these uids — from the full users list if it is already in memory, else one small read each (10-min cache). */
export async function usersByIds(uids) {
  const out = {};
  const all = cache.get("admin:users");
  const need = [];
  for (const uid of new Set(uids.filter(Boolean))) {
    const hit = all?.find((u) => u.id === uid) || cache.get(`admin:user:${uid}`);
    if (hit) out[uid] = hit; else need.push(uid);
  }
  await Promise.all(need.map(async (uid) => {
    try {
      const snap = await FS.getDoc(FS.doc(db, "users", uid));
      const u = snap.exists() ? { id: snap.id, ...snap.data() } : { id: uid, missing: true };
      cache.set(`admin:user:${uid}`, u, 10 * 60 * 1000);
      out[uid] = u;
    } catch { out[uid] = { id: uid, missing: true }; }
  }));
  return out;
}

/** Every result document of ONE exam — reuses the full results download if another tab made it, else one filtered query. */
export function resultsForExam(examId, opts) {
  return cache.remember(`admin:examres:${examId}`, TTL, async () => {
    const all = cache.get("admin:results");
    if (all) return all.filter((r) => r.examId === examId);
    const snap = await getDocs(query(collection(db, "results"), where("examId", "==", examId)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, { force: cache.wantsFresh(opts) });
}
