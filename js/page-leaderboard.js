// ==========================================================================
// page-leaderboard.js — Leaderboard (#/leaderboard): the student's own standing + the published Top 10.
//
// Source: leaderboard/publicStats (1 read, cached) = anonymous percents of everyone + the top list the admin
// publishes whenever the Leaderboard tab is opened. The full ranked list stays admin-only by design.
// Ranking rule (same as the admin Leaderboard): average of the BEST result in each live exam.
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { onPageLeave } from "./page-lifecycle.js";
import { toMs } from "./schedule-core.js";
import * as H from "./home-core.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, fmtDate, fmtTime, initials, pageHead } from "./home-ui.js";

let renderToken = 0;

export async function initLeaderboardPage(params, mount) {
  const my = ++renderToken;
  await renderNav("leaderboard");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  mount.innerHTML = `<div class="container page">
    ${pageHead("Leaderboard", "লাইভ পরীক্ষায় প্রতিটি পরীক্ষার সেরা ফলাফলের গড় অনুযায়ী র‍্যাঙ্কিং।")}
    <div id="lb-body">${skeleton("card", 2)}</div>
  </div>`;
  const body = mount.querySelector("#lb-body");

  async function load(force) {
    const M = await loadStudentContext(user, { force, rank: true });
    if (my !== renderToken) return;
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    const m = buildStudentModel(M);
    const perf = M.stats ? H.performanceFromStats(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent }) : null;
    const rk = H.rankOf(M.pct?.percents, perf?.ownLiveAvg);
    const top = H.topPerformers(M.pct, m.content.leaderboardNames, 10);
    const updated = toMs(M.pct?.updatedAt);

    if (!M.pct && !perf?.liveTaken) { body.innerHTML = emptyBlock("fa-trophy", "লিডারবোর্ড এখনো প্রস্তুত হয়নি। লাইভ পরীক্ষা দিলে এখানে আপনার অবস্থান দেখা যাবে।", '<a class="btn btn-outline btn-sm" href="#/exams?type=live">লাইভ পরীক্ষা দেখুন</a>'); return; }

    const me = perf?.ownLiveAvg === null || perf?.ownLiveAvg === undefined
      ? `<div class="lbp-me lbp-me--empty card"><i class="fa-regular fa-circle-question" aria-hidden="true"></i><div><b>আপনার র‍্যাঙ্ক এখনো নেই</b><p>র‍্যাঙ্কিংয়ে আসতে অন্তত একটি লাইভ পরীক্ষা দিন।</p></div></div>`
      : `<div class="lbp-me card card--highlight"><div class="lbp-rank"><span>Your rank</span><b>${rk ? `#${rk.rank}` : "—"}</b>${rk ? `<small>of ${rk.total}</small>` : ""}</div>
          <div class="lbp-meta"><div><span>Your average</span><b>${perf.ownLiveAvg}%</b></div><div><span>Live exams</span><b>${perf.liveTaken}</b></div>${rk ? `<div><span>Top</span><b>${Math.max(1, Math.round((rk.rank / rk.total) * 100))}%</b></div>` : ""}</div></div>`;
    body.innerHTML = `${me}
      <section class="section" aria-labelledby="h-top">
        <div class="section-head"><div class="section-head-text"><h2 class="section-title" id="h-top"><i class="fa-solid fa-trophy" aria-hidden="true"></i>Top Performers</h2></div></div>
        ${top.length ? `<div class="list-card"><ol class="lb-list lb-list--big">${top.map((t) => {
          const mine = !!rk && perf?.ownLiveAvg === t.percent && rk.rank === t.rank && top.filter((x) => x.percent === t.percent).length === 1; // only when it is unambiguously me
          return `<li class="lb-row lb-row--${t.rank <= 3 ? t.rank : "n"}${mine ? " is-me" : ""}"><span class="lb-rank">${t.rank}</span><span class="lb-avatar" aria-hidden="true">${esc(initials(t.name))}</span><span class="lb-name">${esc(t.name)}${mine ? ' <span class="badge badge-accent lb-you">You</span>' : ""}<small>${t.exams} live exam${t.exams === 1 ? "" : "s"}</small></span><b class="lb-pct">${t.percent}%</b></li>`;
        }).join("")}</ol></div>`
          : emptyBlock("fa-ranking-star", "টপ পারফর্মারদের তালিকা এখনো প্রকাশ করা হয়নি।")}
        <p class="lbp-note">${updated ? `Last updated ${esc(fmtDate(updated))}, ${esc(fmtTime(updated))}. ` : ""}তালিকাটি অ্যাডমিন নিয়মিত হালনাগাদ করেন, তাই সাম্প্রতিক পরীক্ষার ফল যুক্ত হতে কিছু সময় লাগতে পারে।</p>
      </section>`;
  }

  try { await load(false); } catch { body.innerHTML = errorBlock("lb"); }
  if (my !== renderToken) return;
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 2); try { await load(true); } catch { body.innerHTML = errorBlock("lb"); } });
  onPageLeave(() => {});
}
