// ==========================================================================
// student-data.js — loads everything the student pages share and turns it into ONE model.
//
//   loadStudentContext(user)  → the 4-5 cached documents (profile, catalog, home feed, my stats, rank pool)
//   buildStudentModel(M)      → { now, items, ctx, … } with every exam judged against the SERVER clock
//
// Home, All Exams, Schedule, Notifications, Leaderboard and Performance all call these, so they agree on what
// is live / upcoming / closed, and a screen that follows another one costs no extra reads (everything is cached
// in cache.js for 5–10 minutes).
// ==========================================================================
import { getUserProfile } from "./utils.js";
import { getExamCatalog, fetchUserStats, fetchPercentileStats } from "./exam-data.js";
import { getHomeFeed } from "./home-data.js";
import { serverNow, syncServerTimeSoon } from "./server-time.js";
import { reminderIds } from "./reminders.js";
import * as H from "./home-core.js";

/**
 * @param {object} user  Firebase auth user
 * @param {{force?:boolean, rank?:boolean}} opts  force = re-read from the server; rank = also load the leaderboard pool
 */
export async function loadStudentContext(user, { force = false, rank = false } = {}) {
  const [profile, catalog, feed, stats, pct] = await Promise.allSettled([
    getUserProfile(user.uid),
    getExamCatalog({ force }),
    getHomeFeed({ force }),
    fetchUserStats(user.uid, { force }),
    rank ? fetchPercentileStats() : Promise.resolve(null),
    syncServerTimeSoon(),
  ]);
  const prof = profile.status === "fulfilled" ? profile.value || {} : {};
  const catalogOk = catalog.status === "fulfilled" && catalog.value;
  return {
    uid: user.uid,
    profile: prof,
    name: prof.displayName || user.displayName || "",
    catalog: catalogOk ? catalog.value : null,
    catalogError: !catalogOk,
    feed: feed.status === "fulfilled" ? feed.value : await getHomeFeed(),
    stats: stats.status === "fulfilled" ? stats.value : null,
    pct: pct.status === "fulfilled" ? pct.value : null,
    reminders: reminderIds(user.uid),
  };
}

export function buildStudentModel(M) {
  const now = serverNow();
  const profile = M.profile || {};
  const all = M.catalog?.exams || [];
  const exams = H.studentExams(all, profile);
  const site = M.catalog?.site || { maintenance: false, message: "" };
  const maintenance = !!site.maintenance && !profile.isAdmin; // admins can always test
  const items = H.decorateAll(exams, now, { stats: M.stats, maintenance, disabled: !!profile.disabled && !profile.isAdmin });
  return {
    now, items, maintenance, site,
    examsById: Object.fromEntries(all.map((e) => [e.id, e])),
    ctx: { tax: M.feed.taxonomy, now, reminders: M.reminders, loggedIn: true, uid: M.uid, participants: M.feed.participants, defaultPass: M.feed.passPercent },
    content: M.feed.content,
    feed: M.feed,
  };
}
