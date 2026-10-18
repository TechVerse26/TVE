// ==========================================================================
// page-leaderboard.js — Leaderboard (#/leaderboard): the student's own standing + the published Top 10.
//
// Source: leaderboard/publicStats (1 read, cached) = anonymous percents of everyone + the top list the admin
// publishes whenever the Leaderboard tab is opened. The full ranked list stays admin-only by design.
// Ranking rule (same as the admin Leaderboard): average of the BEST result in each live exam.
//
// Each row shows the student's name, their roll under it, and their photo (initials when there is none). Under the
// overall list sits "Exam-wise Leaders": the same kind of list for every live exam (best attempt in that exam).
// Roll + photo appear only while Admin → Homepage → leaderboard names is "Full names"; the other two choices keep
// them private, exactly like the names. Everything comes from the same document — no extra Firestore read.
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { onPageLeave } from "./page-lifecycle.js";
import { toMs } from "./schedule-core.js";
import * as H from "./home-core.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, fmtDate, fmtTime, initials, pageHeadBack } from "./home-ui.js";

let renderToken = 0;

/** Photo when the student has one (https only — see H.safePhotoUrl), otherwise the initials this list always showed. */
const avatarHtml = (photo, name) => {
  const letters = esc(initials(name));
  return photo ? `<img src="${esc(photo)}" alt="" data-fb="${letters}" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : letters;
};
const rollText = (roll) => (roll ? `Roll ${esc(roll)}` : "");
const numText = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
/** Shorten a long exam title for its chip (by whole characters, so Bengali letters are never cut in half). */
function clip(text, max) {
  const str = String(text);
  const parts = typeof Intl !== "undefined" && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(str), (x) => x.segment)
    : Array.from(str);
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : str;
}
const youBadge = ' <span class="badge badge-accent lb-you">You</span>';

export async function initLeaderboardPage(params, mount) {
  const my = ++renderToken;
  await renderNav("leaderboard");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  mount.innerHTML = `<div class="container page">
    ${pageHeadBack("Leaderboard", "লাইভ পরীক্ষায় প্রতিটি পরীক্ষার সেরা ফলাফলের গড় অনুযায়ী র‍্যাঙ্কিং।")}
    <div id="lb-body">${skeleton("card", 2)}</div>
  </div>`;
  const body = mount.querySelector("#lb-body");

  // Exam-wise Leaders state: which exam's list is open. Tapping a chip only repaints that list (no re-fetch).
  let boards = [];
  let selected = "";
  let myRoll = "";
  function paintExam() {
    const board = boards.find((b) => b.id === selected) || boards[0];
    const view = body.querySelector("#lb-exam-view");
    if (!board || !view) return;
    body.querySelectorAll("[data-lb-exam]").forEach((chip) => {
      const on = chip.dataset.lbExam === board.id;
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
    view.innerHTML = `<div class="list-card"><ol class="lb-list lb-list--big">${board.top.map((t) => {
      const mine = !!myRoll && t.roll === myRoll; // roll is unique per student, so this is exact
      const sub = [rollText(t.roll), t.total ? `${numText(t.score)}/${numText(t.total)}` : ""].filter(Boolean).join(" · ");
      return `<li class="lb-row lb-row--${t.rank <= 3 ? t.rank : "n"}${mine ? " is-me" : ""}"><span class="lb-rank">${t.rank}</span><span class="lb-avatar" aria-hidden="true">${avatarHtml(t.photo, t.name)}</span><span class="lb-name">${esc(t.name)}${mine ? youBadge : ""}${sub ? `<small>${sub}</small>` : ""}</span><b class="lb-pct">${t.percent}%</b></li>`;
    }).join("")}</ol></div>
      <p class="lbp-note"><b>${esc(board.title)}</b>${board.count ? ` — ${board.count} Participants
` : ""} Each participant’s best attempt is counted.
</p>`;
  }
  body.addEventListener("click", (e) => {
    const chip = e.target.closest?.("[data-lb-exam]");
    if (!chip) return;
    selected = chip.dataset.lbExam;
    paintExam();
  });
  // A photo that fails to load (deleted / blocked) quietly becomes the initials again.
  body.addEventListener("error", (e) => {
    const img = e.target;
    if (img?.tagName === "IMG" && img.closest(".lb-avatar")) img.replaceWith(document.createTextNode(img.dataset.fb || "?"));
  }, true);

  async function load(force) {
    const M = await loadStudentContext(user, { force, rank: true });
    if (my !== renderToken) return;
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    const m = buildStudentModel(M);
    const perf = M.stats ? H.performanceFromStats(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent }) : null;
    const rk = H.rankOf(M.pct?.percents, perf?.ownLiveAvg);
    const top = H.topPerformers(M.pct, m.content.leaderboardNames, 10);
    boards = H.examLeadersFrom(M.pct, m.content.leaderboardNames, 10);
    if (!boards.some((b) => b.id === selected)) selected = boards[0]?.id || ""; // newest exam first by default
    myRoll = String(M.profile?.roll || "");
    const updated = toMs(M.pct?.updatedAt);

    if (!M.pct && !perf?.liveTaken) { body.innerHTML = emptyBlock("fa-trophy", "The leaderboard isn't ready yet. Your rank will appear here once you take the live exam.", '<a class="btn btn-outline btn-sm" href="#/exams?type=live">View Live Exams
</a>'); return; }

    const me = perf?.ownLiveAvg === null || perf?.ownLiveAvg === undefined
      ? `<div class="lbp-me lbp-me--empty card"><i class="fa-regular fa-circle-question" aria-hidden="true"></i><div><b>You haven't ranked yet.</b><p>Take at least one live exam to appear on the leaderboard.
      </p></div></div>`
      : `<div class="lbp-me card card--highlight"><div class="lbp-rank"><span>Your rank</span><b>${rk ? `#${rk.rank}` : "—"}</b>${rk ? `<small>of ${rk.total}</small>` : ""}</div>
          <div class="lbp-meta"><div><span>Your average</span><b>${perf.ownLiveAvg}%</b></div><div><span>Live exams</span><b>${perf.liveTaken}</b></div>${rk ? `<div><span>Top</span><b>${Math.max(1, Math.round((rk.rank / rk.total) * 100))}%</b></div>` : ""}</div></div>`;
    body.innerHTML = `${me}
      <section class="section" aria-labelledby="h-top">
        <div class="section-head"><div class="section-head-text"><h2 class="section-title" id="h-top"><i class="fa-solid fa-trophy" aria-hidden="true"></i>Top Performers</h2></div></div>
        ${top.length ? `<div class="list-card"><ol class="lb-list lb-list--big">${top.map((t) => {
          // With a roll on the row the match is exact; without one, only when it is unambiguously me.
          const mine = myRoll && t.roll ? t.roll === myRoll
            : !!rk && perf?.ownLiveAvg === t.percent && rk.rank === t.rank && top.filter((x) => x.percent === t.percent).length === 1;
          const sub = [rollText(t.roll), `${t.exams} live exam${t.exams === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
          return `<li class="lb-row lb-row--${t.rank <= 3 ? t.rank : "n"}${mine ? " is-me" : ""}"><span class="lb-rank">${t.rank}</span><span class="lb-avatar" aria-hidden="true">${avatarHtml(t.photo, t.name)}</span><span class="lb-name">${esc(t.name)}${mine ? youBadge : ""}<small>${sub}</small></span><b class="lb-pct">${t.percent}%</b></li>`;
        }).join("")}</ol></div>`
          : emptyBlock("fa-ranking-star", "The leaderboard hasn’t been published yet.
")}
        <p class="lbp-note">${updated ? `Last updated ${esc(fmtDate(updated))}, ${esc(fmtTime(updated))}. ` : ""}Results are updated regularly by the admin. Recent results may take time to appear.
        </p>
      </section>
      ${boards.length ? `<section class="section" aria-labelledby="h-exam">
        <div class="section-head"><div class="section-head-text"><h2 class="section-title" id="h-exam"><i class="fa-solid fa-medal" aria-hidden="true"></i>Exam-wise Leaders</h2></div></div>
        <div class="fl-chips" role="group" aria-label="Choose an exam">${boards.map((b) => `<button type="button" class="fl-chip${b.id === selected ? " is-on" : ""}" data-lb-exam="${esc(b.id)}" aria-pressed="${b.id === selected ? "true" : "false"}" title="${esc(b.title)}">${esc(clip(b.title, 28))}</button>`).join("")}</div>
        <div id="lb-exam-view" class="lb-exam-view" aria-live="polite"></div>
      </section>` : ""}`;
    paintExam();
  }

  try { await load(false); } catch { body.innerHTML = errorBlock("lb"); }
  if (my !== renderToken) return;
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 2); try { await load(true); } catch { body.innerHTML = errorBlock("lb"); } });
  onPageLeave(() => {});
}
