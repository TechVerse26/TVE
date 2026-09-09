// ==========================================================================
// page-results.js — "আমার ফলাফল"
//
// Sections, top to bottom:
//   1. "আপনার র‍্যাংক" — student's own standing vs. an ANONYMOUS percentile
//      pool (see the long comment on fetchPercentileStats/publishPercentileStats
//      in exam-data.js for why it's built this way instead of just listing
//      every student's results client-side).
//   2. Two overview progress graphs — Live / Practice, each an aggregate
//      across every exam of that type.
//   3. One card per exam. Tapping a card opens a modal with that exam's
//      full attempt history — chart, stat line, and a row per attempt.
//      Each row expands into a full question-by-question review (using the
//      per-attempt snapshot saved in exam-data.js — see reviewSnapshot in
//      exam.js), so a student isn't limited to reviewing only their most
//      recent sitting.
//
// Every chart is pure CSS: bar height comes from the --pct custom property
// via calc(), gridlines are a single repeating-linear-gradient background
// (no extra DOM), and tooltips are a ::after using content: attr(data-tip)
// positioned with calc(var(--pct) * 1% + Npx). No SVG, canvas, or chart
// library. Bars animate in from 0% on first paint (rAF-driven, staggered
// per bar) and the stat numbers count up rather than snapping in — the
// only "JavaScript" involved is toggling a CSS custom property and text
// content on a timer, so it stays cheap and dependency-free.
// ==========================================================================
import { requireAuth, escapeHtml, formatScore, formatDateTime } from "./utils.js";
import { fetchMyResults, fetchPercentileStats, isReviewExpired } from "./exam-data.js";
import { renderNav } from "./nav.js";

const OVERVIEW_MAX_BARS = 40;
const COUNT_UP_MS = 650;
const BAR_GROW_MS = 620;
const BAR_STAGGER_MS = 16;

/* ==========================================================================
   Small, dependency-free animation helpers. Kept generic on purpose so both
   the overview graphs and the per-exam modal chart share the same engine.
   ========================================================================== */
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Animate a number counting up inside `el`, formatted through `format`. */
function animateCount(el, target, { duration = COUNT_UP_MS, format = (n) => String(Math.round(n)) } = {}) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(from + (target - from) * easeOutCubic(t));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** Grow every `.ov-bar-fill` inside `root` from 0 to its --pct, staggered. */
function animateBars(root) {
  const bars = root.querySelectorAll(".ov-bar-fill[data-pct]");
  // Two rAFs: the first lets the browser commit the "height: 0" paint the
  // bars were server-rendered with; only then do we flip on the transition
  // by setting the real value, or the browser may coalesce both states into
  // one frame and skip the animation entirely.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bars.forEach((bar, i) => {
      bar.style.transitionDelay = `${i * BAR_STAGGER_MS}ms`;
      bar.style.setProperty("--pct", bar.dataset.pct);
    });
  }));
}

function safeId(raw) {
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "-");
}
function clampPct(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}
function resultType(r) {
  return r.examType === "practice" ? "practice" : "live";
}

/* ---------- Fall back to a synthetic single-entry history for older docs
   saved before per-attempt tracking existed. ---------- */
function normalizeAttempts(r) {
  if (Array.isArray(r.attempts) && r.attempts.length) return r.attempts;
  return [{ score: r.score, total: r.total, percent: r.percent, submittedAt: r.submittedAt, review: null }];
}

/* ---------- Best attempt per exam — mirrors admin/leaderboard.js's ranking
   rule exactly (a retake can only help, never hurt), so a student's own
   number is directly comparable to the anonymous pool it's measured against. ---------- */
function bestPercentPerExam(r) {
  return Math.max(...normalizeAttempts(r).map((a) => clampPct(a.percent)));
}

/* ---------- Flatten every attempt of one type (live/practice) across all
   exams, sorted chronologically — this is what the overview graphs chart. ---------- */
function flattenByType(results, type) {
  const flat = [];
  results.filter((r) => resultType(r) === type).forEach((r) => {
    normalizeAttempts(r).forEach((a, i) => {
      flat.push({ ...a, examTitle: r.examTitle || "এক্সাম", attemptInExam: i + 1 });
    });
  });
  flat.sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0));
  return flat;
}

/* ---------- Stat chips: attempts / best / average / latest change.
   Numbers are written with data-count so the caller can animate them in
   after the HTML lands in the DOM. ---------- */
function statsHtml(points) {
  const pcts = points.map((p) => clampPct(p.percent));
  const best = Math.max(...pcts);
  const avg = Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length);
  const latest = pcts[pcts.length - 1];
  const prev = pcts.length > 1 ? pcts[pcts.length - 2] : null;
  const trendClass = prev === null ? "" : latest > prev ? "trend-up" : latest < prev ? "trend-down" : "";
  const trendIcon = prev === null ? "fa-minus" : latest > prev ? "fa-arrow-trend-up" : latest < prev ? "fa-arrow-trend-down" : "fa-minus";
  const trendText = prev === null ? "—" : `${latest > prev ? "+" : ""}${latest - prev}%`;
  return `
    <div class="rc-stats">
      <div class="rc-stat"><span>মোট অ্যাটেম্পট</span><b data-count="${points.length}" data-suffix="">0</b></div>
      <div class="rc-stat"><span>সেরা স্কোর</span><b data-count="${best}" data-suffix="%">0%</b></div>
      <div class="rc-stat"><span>গড় স্কোর</span><b data-count="${avg}" data-suffix="%">0%</b></div>
      <div class="rc-stat ${trendClass}"><span>সর্বশেষ পরিবর্তন</span><b><i class="fa-solid ${trendIcon}"></i> ${trendText}</b></div>
    </div>`;
}

/** Find every [data-count] chip inside `root` and animate it in. */
function animateStats(root) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const suffix = el.dataset.suffix || "";
    animateCount(el, target, { format: (n) => `${Math.round(n)}${suffix}` });
  });
}

/* ---------- The shared pure-CSS bar chart. `tip(p, i)` builds each bar's
   tooltip text; `label(p, i)` builds its x-axis label (return "" to skip).
   Bars render at --pct:0 with the real value stashed in data-pct; call
   animateBars() once this HTML is attached to the DOM to grow them in. ---------- */
function barChartHtml(points, { tip, label }) {
  const n = points.length;
  const bars = points.map((p, i) => {
    const pct = clampPct(p.percent);
    const isLatest = i === n - 1;
    const fillClass = isLatest ? "is-latest" : pct < 60 ? "is-fail" : "";
    const lbl = label(p, i);
    return `
      <div class="ov-bar" data-tip="${escapeHtml(tip(p, i))}">
        <div class="ov-bar-fill ${fillClass}" style="--pct:0" data-pct="${pct}"></div>
        ${lbl ? `<span class="ov-xlabel">${escapeHtml(lbl)}</span>` : ""}
      </div>`;
  }).join("");

  return `
    <div class="ov-chart-scroll">
      <div class="ov-chart-grid">
        <div class="ov-yaxis"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
        <div class="ov-bars">${bars}</div>
      </div>
    </div>`;
}

/* ==========================================================================
   Rank card — student's own best-per-exam average vs. an anonymous pool of
   every student's average (published by admin/leaderboard.js). No identity
   or exam content ever reaches the client for anyone but the signed-in
   student themself.
   ========================================================================== */
function rankCardHtml(liveResults, stats) {
  if (!liveResults.length) {
    return `
      <div class="ov-card ov-card--rank">
        <div class="ov-card-head">
          <div class="ov-card-icon"><i class="fa-solid fa-ranking-star"></i></div>
          <div><h2>আপনার র‍্যাংক</h2><p>লাইভ এক্সাম দিলে এখানে আপনার অবস্থান দেখা যাবে</p></div>
        </div>
      </div>`;
  }

  const ownAvg = Math.round(
    liveResults.reduce((s, r) => s + bestPercentPerExam(r), 0) / liveResults.length
  );

  const pool = Array.isArray(stats?.percents) ? stats.percents : null;
  if (!pool || pool.length < 2) {
    return `
      <div class="ov-card ov-card--rank">
        <div class="ov-card-head">
          <div class="ov-card-icon"><i class="fa-solid fa-ranking-star"></i></div>
          <div><h2>আপনার র‍্যাংক</h2><p>যথেষ্ট ডেটা জমা হলে এখানে দেখা যাবে</p></div>
        </div>
        <div class="rank-own"><span>আপনার গড় স্কোর</span><b data-count="${ownAvg}" data-suffix="%">0%</b></div>
      </div>`;
  }

  const total = pool.length;
  const better = pool.filter((p) => p > ownAvg).length;
  const topPercent = Math.max(1, Math.round((better / total) * 100));
  const classAvg = Math.round(pool.reduce((s, p) => s + p, 0) / total);
  const diff = ownAvg - classAvg;
  const diffClass = diff > 0 ? "trend-up" : diff < 0 ? "trend-down" : "";
  const diffIcon = diff > 0 ? "fa-arrow-up" : diff < 0 ? "fa-arrow-down" : "fa-minus";

  return `
    <div class="ov-card ov-card--rank">
      <div class="ov-card-head">
        <div class="ov-card-icon"><i class="fa-solid fa-ranking-star"></i></div>
        <div><h2>আপনার র‍্যাংক</h2><p>${total} জন শিক্ষার্থীর মধ্যে তুলনা করা হয়েছে</p></div>
      </div>
      <div class="rank-grid">
        <div class="rank-own">
          <span>আপনার গড় স্কোর</span>
          <b data-count="${ownAvg}" data-suffix="%">0%</b>
        </div>
        <div class="rank-top">
          <span>আপনি আছেন</span>
          <b>টপ <em data-count="${topPercent}" data-suffix="%">0%</em>-এ</b>
        </div>
        <div class="rank-diff ${diffClass}">
          <span>ক্লাসের গড়ের তুলনায়</span>
          <b><i class="fa-solid ${diffIcon}"></i> ${Math.abs(diff)}%</b>
        </div>
      </div>
    </div>`;
}

/* ---------- One overview card (Live or Practice) ---------- */
function overviewCardHtml(type, results) {
  const filtered = results.filter((r) => resultType(r) === type);
  const isLive = type === "live";
  const icon = isLive ? "fa-satellite-dish" : "fa-dumbbell";
  const title = isLive ? "লাইভ এক্সাম অগ্রগতি" : "প্র্যাকটিস এক্সাম অগ্রগতি";

  if (!filtered.length) {
    return `
      <div class="ov-card ov-card--${type}">
        <div class="ov-card-head">
          <div class="ov-card-icon"><i class="fa-solid ${icon}"></i></div>
          <div><h2>${title}</h2><p>${isLive ? "লাইভ" : "প্র্যাকটিস"} এক্সামের ট্রেন্ড এখানে দেখা যাবে</p></div>
        </div>
        <div class="ov-empty"><i class="fa-solid fa-chart-column"></i><p>এখনো কোনো ${isLive ? "লাইভ" : "প্র্যাকটিস"} এক্সাম দেননি</p></div>
      </div>`;
  }

  const flatFull = flattenByType(results, type);
  const truncated = flatFull.length > OVERVIEW_MAX_BARS;
  const flat = truncated ? flatFull.slice(flatFull.length - OVERVIEW_MAX_BARS) : flatFull;

  const chart = barChartHtml(flat, {
    tip: (p) => `${p.examTitle} · অ্যাটেম্পট #${p.attemptInExam} · ${formatScore(p.score)}/${p.total} (${Math.round(clampPct(p.percent))}%) · ${formatDateTime(p.submittedAt)}`,
    label: (p, i) => (i % Math.max(1, Math.ceil(flat.length / 10)) === 0 || i === flat.length - 1) ? String(i + 1) : "",
  });

  return `
    <div class="ov-card ov-card--${type}">
      <div class="ov-card-head">
        <div class="ov-card-icon"><i class="fa-solid ${icon}"></i></div>
        <div><h2>${title}</h2><p>${filtered.length} টি এক্সাম · সর্বমোট ${flatFull.length} বার দিয়েছেন</p></div>
      </div>
      ${statsHtml(flatFull)}
      ${chart}
      ${truncated ? `<p class="ov-note">সাম্প্রতিক ${OVERVIEW_MAX_BARS}টি অ্যাটেম্পট দেখানো হচ্ছে</p>` : ""}
    </div>`;
}

/* ---------- Per-exam card in the list below the graphs ---------- */
function resultCardHtml(r) {
  const attempts = normalizeAttempts(r);
  const typeBadge = resultType(r) === "practice"
    ? `<span class="exs-type-badge exs-type-badge--practice">Practice</span>`
    : `<span class="exs-type-badge exs-type-badge--live">Live</span>`;
  return `
    <button type="button" class="result-row-card" data-open-history="${escapeHtml(r.id)}">
      <div class="result-row-top">
        <div class="result-row-main">
          <h3>${escapeHtml(r.examTitle || "এক্সাম")}</h3>
          <span class="exs-muted exs-small">${formatDateTime(r.submittedAt)} ${typeBadge}</span>
        </div>
        <div class="result-row-score">
          <b>${formatScore(r.score)} / ${r.total}</b>
          <span class="exs-tag ${r.percent >= 60 ? "exs-tag--teal" : "exs-tag--coral"}">${r.percent}%</span>
        </div>
      </div>
      <div class="result-row-hint">
        <span><i class="fa-solid fa-clock-rotate-left"></i> ${attempts.length} বার পরীক্ষা দেওয়া হয়েছে</span>
        <i class="fa-solid fa-chevron-right"></i>
      </div>
    </button>`;
}

/* ---------- One question inside a per-attempt review (reuses the same
   classes as the post-submit review screen in exam-render.js, so it looks
   and behaves identically whether you're reviewing today's attempt or one
   from three months ago). ---------- */
function reviewQuestionHtml(q, i) {
  const answered = q.selected !== null && q.selected !== undefined;
  const correct = answered && q.selected === q.correctIndex;
  return `
    <div class="exs-review-item">
      <div class="exs-review-q">${i + 1}. ${escapeHtml(q.text)}</div>
      <div class="exs-review-answer ${correct ? "is-correct" : "is-wrong"}">
        ${correct ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'} আপনার উত্তর: ${answered ? escapeHtml(q.options[q.selected]) : "উত্তর দেওয়া হয়নি"}
      </div>
      ${!correct ? `<div class="exs-review-answer is-correct"><i class="fa-solid fa-check"></i> সঠিক উত্তর: ${escapeHtml(q.options[q.correctIndex])}</div>` : ""}
      ${q.explanation && q.explanation.trim() ? `<div class="exs-review-explain"><i class="fa-solid fa-lightbulb"></i><span><b>ব্যাখ্যা:</b> ${escapeHtml(q.explanation)}</span></div>` : ""}
    </div>`;
}

/* ---------- History modal body: stats + chart (if 2+ attempts) + a
   collapsible row per attempt, each expandable into its own question review. ---------- */
function historyModalBodyHtml(r) {
  const attempts = normalizeAttempts(r).map((a, i) => ({ ...a, attemptInExam: i + 1 }));
  const rid = safeId(r.id);

  const chart = attempts.length > 1
    ? `<div class="result-modal-chart">${barChartHtml(attempts, {
        tip: (p) => `অ্যাটেম্পট #${p.attemptInExam} · ${formatScore(p.score)}/${p.total} (${Math.round(clampPct(p.percent))}%) · ${formatDateTime(p.submittedAt)}`,
        label: (p, i) => (i % Math.max(1, Math.ceil(attempts.length / 10)) === 0 || i === attempts.length - 1) ? String(p.attemptInExam) : "",
      })}</div>`
    : "";

  const rows = attempts.slice().reverse().map((a, idx) => {
    const isLatest = idx === 0;
    const prev = attempts[attempts.length - 1 - idx - 1];
    let deltaHtml = `<span class="rm-row-delta flat">—</span>`;
    if (prev) {
      const d = Math.round(clampPct(a.percent) - clampPct(prev.percent));
      const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
      const icon = d > 0 ? "fa-arrow-up" : d < 0 ? "fa-arrow-down" : "fa-minus";
      deltaHtml = `<span class="rm-row-delta ${cls}"><i class="fa-solid ${icon}"></i> ${d === 0 ? "" : Math.abs(d) + "%"}</span>`;
    }
    // Defensive filter: only ever offer the questions the student got
    // wrong, even for an older doc saved before reviewSnapshot switched to
    // storing wrong-only (a pre-existing full snapshot could still have
    // correct ones mixed in). Combined with isReviewExpired(), this is
    // also the second (client-side) half of the 48-hour cutoff — the first
    // half already ran in fetchMyResults, which wipes a.review to null
    // once it's past its window, so this mostly guards the rare case where
    // that write hasn't landed yet.
    const wrongOnly = Array.isArray(a.review) ? a.review.filter((q) => q.selected !== q.correctIndex) : [];
    const expired = isReviewExpired(a.submittedAt);
    const hasReview = wrongOnly.length > 0 && !expired;

    let lockIcon = "fa-lock", lockTitle = "এই অ্যাটেম্পটের বিস্তারিত রিভিউ সংরক্ষিত নেই";
    if (a.review != null && wrongOnly.length === 0) {
      lockIcon = "fa-circle-check";
      lockTitle = "অভিনন্দন! এই অ্যাটেম্পটে সব উত্তর সঠিক ছিল";
    } else if (a.review != null && expired) {
      lockIcon = "fa-clock-rotate-left";
      lockTitle = "ভুল উত্তরের রিভিউ শুধু জমা দেওয়ার ৪৮ ঘণ্টা পর্যন্ত দেখা যায় — এই অ্যাটেম্পটের মেয়াদ শেষ হয়ে গেছে";
    }

    const panelId = `rm-review-${rid}-${a.attemptInExam}`;
    return `
      <div class="rm-row-wrap">
        <button type="button" class="rm-row${isLatest ? " is-latest" : ""}" ${hasReview ? `data-toggle-review="${panelId}"` : "disabled"}>
          <span class="rm-row-n">#${a.attemptInExam}</span>
          <span class="rm-row-when">${formatDateTime(a.submittedAt)}</span>
          <span class="rm-row-score">${formatScore(a.score)}/${a.total} · ${Math.round(clampPct(a.percent))}%</span>
          ${deltaHtml}
          ${hasReview ? `<i class="fa-solid fa-chevron-down rm-row-arrow"></i>` : `<i class="fa-solid ${lockIcon} rm-row-lock" title="${lockTitle}"></i>`}
        </button>
        ${hasReview ? `<div class="rm-review-panel" id="${panelId}" hidden>${wrongOnly.map(reviewQuestionHtml).join("")}</div>` : ""}
      </div>`;
  }).join("");

  return `
    ${statsHtml(attempts)}
    ${chart}
    <div class="result-modal-list">${rows}</div>`;
}

export async function initResultsPage(params, container) {
  await renderNav("results");
  const user = await requireAuth();
  if (!user) return;

  container.innerHTML = `
    <div class="container page-pad">
      <div class="page-head"><h1><i class="fa-solid fa-chart-simple"></i> আমার ফলাফল</h1><p>আপনার দেওয়া সব এক্সামের ফলাফল এখানে দেখতে পাবেন</p></div>
      <div id="my-results-list" class="exs-loading"><span class="exs-spinner"></span> লোড হচ্ছে...</div>
    </div>
    <div class="result-modal-overlay" id="result-modal">
      <div class="result-modal" role="dialog" aria-modal="true">
        <div class="result-modal-head">
          <h3 id="result-modal-title"></h3>
          <button type="button" class="result-modal-close" id="result-modal-close" aria-label="বন্ধ করুন"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="result-modal-body"></div>
      </div>
    </div>`;

  const listEl = container.querySelector("#my-results-list");
  const modalOverlay = container.querySelector("#result-modal");
  const modalTitle = container.querySelector("#result-modal-title");
  const modalBody = container.querySelector("#result-modal-body");
  let resultsById = {};

  function openHistory(id) {
    const r = resultsById[id];
    if (!r) return;
    modalTitle.textContent = r.examTitle || "এক্সাম";
    modalBody.innerHTML = historyModalBodyHtml(r);
    modalOverlay.classList.add("is-open");
    document.body.style.overflow = "hidden";
    animateBars(modalBody);
    animateStats(modalBody);

    modalBody.querySelectorAll("[data-toggle-review]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = document.getElementById(btn.dataset.toggleReview);
        if (!panel) return;
        const willOpen = panel.hidden;
        panel.hidden = !willOpen;
        btn.classList.toggle("is-open", willOpen);
      });
    });
  }
  function closeHistory() {
    modalOverlay.classList.remove("is-open");
    document.body.style.overflow = "";
  }
  container.querySelector("#result-modal-close").addEventListener("click", closeHistory);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeHistory(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeHistory(); });

  try {
    const [results, percentileStats] = await Promise.all([
      fetchMyResults(user.uid),
      fetchPercentileStats(),
    ]);

    if (!results.length) {
      listEl.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এখনো কোনো এক্সাম দেননি</p></div>`;
      return;
    }
    resultsById = Object.fromEntries(results.map((r) => [r.id, r]));
    const liveResults = results.filter((r) => resultType(r) === "live");

    listEl.className = "";
    listEl.innerHTML = `
      <div class="results-overview">
        ${rankCardHtml(liveResults, percentileStats)}
      </div>
      <div class="results-overview">
        ${overviewCardHtml("live", results)}
        ${overviewCardHtml("practice", results)}
      </div>
      <div class="results-grid">${results.map(resultCardHtml).join("")}</div>`;

    animateBars(listEl);
    animateStats(listEl);

    listEl.querySelectorAll("[data-open-history]").forEach((btn) => {
      btn.addEventListener("click", () => openHistory(btn.dataset.openHistory));
    });
  } catch {
    listEl.innerHTML = `<div class="exs-empty"><p>ফলাফল লোড করা যায়নি</p></div>`;
  }
}
