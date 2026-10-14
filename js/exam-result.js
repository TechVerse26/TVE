// ==========================================================================
// exam-result.js — the post-exam Result Experience: everything drawn after "জমা দিন".
//
//   1. Submit moment   a checkmark that DRAWS itself + "পরীক্ষা সফলভাবে জমা হয়েছে" (≈1 s, tap to skip)
//   2. Result reveal   progress ring + percent / score count-up, correct / wrong / unanswered / time cards
//   3. Analytics       accuracy, time, comparison with the previous attempt, subjects, suggestions
//                      (all from real data — see exam-analytics.js; missing data = an honest empty state)
//   4. Actions         Course exams · Retake · PDF · jump to the mistakes list (+ the shared review list)
//
// Design rules (the brief): flat navy / cobalt / green / red on neutral surfaces, light + dark theme, no glow,
// no neon, no blur, no flashing, no gradients; a short, limited stagger; prefers-reduced-motion honoured.
//
// SAFETY, in this order of importance:
//   • Nothing here scores, saves or retries anything. exam.js scores first, shows this screen, and saves in the
//     background; a slow animation can never delay or lose a result.
//   • The animation is an ENHANCEMENT: the markup always carries the final values, and every animation is
//     "from"-only CSS gated behind .rx-animate. If JS never adds that class, or throws, or the tab is hidden, or the
//     user prefers reduced motion, the finished result is simply there. A JS failsafe also removes the submit
//     overlay even if CSS animations are unavailable.
//   • If building the rich screen throws for any reason, renderFallback() draws a plain result instead — same ids,
//     same buttons, same save-status chip.
// ==========================================================================
import { escapeHtml, confirmAction } from "./utils.js";
import { navigate, reloadRoute } from "./router.js";
import { toBnDigits } from "./schedule-core.js";
import { normalizeReview, reviewListHtml, reviewTtlHours } from "./exam-review.js";
import { printReport } from "./exam-report.js";
import { buildCoreAnalytics, completeAnalytics, formatScoreText, formatClockText, formatDurationBn, deltaText } from "./exam-analytics.js";

const E = escapeHtml;
const bn = (v) => toBnDigits(v);
const bnPct = (v) => `${bn(v)}%`;
const pctText = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* How long the submit overlay is shown before the result is revealed (ms). Kept in step with the CSS delays in
   exam-result.css (--rx-stage). */
const STAGE_MS = 1000;
const COUNT_MS = 950;

/* Default theme = follow the device (light/dark). The rest of the site is dark-only today; set this to false to
   start the result screen in dark unless the student picked light with the toggle. */
const FOLLOW_SYSTEM_THEME = true;
const THEME_KEY = "tvexam:result-theme";

/* ==========================================================================
   Small helpers
   ========================================================================== */
const prefersReducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

function storedTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : null; } catch { return null; }
}
function rememberTheme(v) {
  try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode / blocked storage: the choice just lasts this screen */ }
}
function systemTheme() {
  if (!FOLLOW_SYSTEM_THEME) return "dark";
  try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { return "dark"; }
}

/** One result screen exists at a time; this is what must be cancelled when it goes away. */
let live = null;

export function disposeResult() {
  if (!live) return;
  const s = live;
  live = null;
  s.cancelled = true;
  s.timers.forEach((t) => clearTimeout(t));
  if (s.raf) cancelAnimationFrame(s.raf);
  if (s.mq && s.onMq) {
    try { s.mq.removeEventListener("change", s.onMq); } catch { try { s.mq.removeListener(s.onMq); } catch { /* ignore */ } }
  }
}

const checkSvg = (cls) =>
  `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle class="rx-check-circle" cx="32" cy="32" r="28" pathLength="100"/><path class="rx-check-tick" d="M20 33.5 29 42.5 45 24" pathLength="100"/></svg>`;

/* ==========================================================================
   Save-status chip (the result is shown at once; the save runs in the background — see persistAttempt in exam.js)
   ========================================================================== */
export function updateSaveStatus(resultView, attempt) {
  const el = resultView?.querySelector("#exs-save-status");
  if (!el) return;
  const st = attempt.saveState;
  el.className = `exs-save-status is-${st}`;
  if (st === "saving") {
    el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>ফলাফল সেভ হচ্ছে…</span>`;
  } else if (st === "saved") {
    el.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>ফলাফল সেভ হয়েছে — My Activity-তে দেখতে পাবেন</span>`;
  } else if (st === "blocked") {
    el.innerHTML = `<i class="fa-solid fa-ban"></i><span>এই এক্সামের অ্যাটেম্পট সীমা পূর্ণ, তাই এই ফলাফল সেভ হয়নি</span>`;
  } else {
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>ফলাফল সেভ করা যায়নি</span><button type="button" class="exs-save-retry">আবার চেষ্টা করুন</button>`;
  }
  // The attempt number is a guess until the save confirms it (another tab may have finished one meanwhile).
  const no = resultView.querySelector("[data-attempt-no]");
  if (no) no.textContent = bn(attempt.attemptNumber);
}

/* ==========================================================================
   Markup — every builder returns a string with the FINAL values already in it
   ========================================================================== */
const countAttrs = (to, dec = 0, suffix = "") => `data-count="${to}" data-dec="${dec}" data-suffix="${suffix}"`;

function stageHtml(attempt) {
  const sub = attempt.auto ? "সময় শেষ হওয়ায় স্বয়ংক্রিয়ভাবে জমা হয়েছে" : "আপনার ফলাফল প্রস্তুত";
  return `
    <div class="rx-stage" id="rx-stage" aria-hidden="true">
      <div class="rx-stage-inner">
        ${checkSvg("rx-check")}
        <p class="rx-stage-title">পরীক্ষা সফলভাবে জমা হয়েছে</p>
        <p class="rx-stage-sub">${sub}</p>
      </div>
    </div>`;
}

function topHtml(attempt) {
  const type = attempt.examType === "practice" ? "Practice" : "Live";
  return `
    <header class="rx-top">
      <div class="rx-top-main">
        <p class="rx-kicker">${checkSvg("rx-check rx-check--sm")}<span>পরীক্ষা সফলভাবে জমা হয়েছে</span></p>
        <h2 class="rx-exam">${E(attempt.examTitle)}</h2>
        <p class="rx-meta">
          <span class="rx-chip">${type}</span>
          <span class="rx-chip"><span>অ্যাটেম্পট #<span data-attempt-no>${bn(attempt.attemptNumber)}</span></span></span>
        </p>
      </div>
      <button type="button" class="rx-theme exs-no-print" id="rx-theme" aria-label="লাইট / ডার্ক থিম বদলান"><i class="fa-solid fa-circle-half-stroke" aria-hidden="true"></i></button>
    </header>`;
}

function heroHtml(attempt, a) {
  const { m, tier } = a;
  const scoreDec = Number.isInteger(m.score) ? 0 : 2;
  const pass = tier.pass;
  const passPill = pass.passed
    ? `<span class="rx-pill rx-pill--ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>পাস মার্ক ${bnPct(pass.percent)} — অতিক্রম করেছেন</span>`
    : `<span class="rx-pill rx-pill--info"><i class="fa-solid fa-flag" aria-hidden="true"></i>পাস মার্ক ${bnPct(pass.percent)} — আর ${bnPct(pass.gap)} বাকি</span>`;
  const summary = `শতকরা ${bn(m.percent)}, স্কোর ${bn(formatScoreText(m.score))} / ${bn(m.total)}। সঠিক ${bn(m.correct)}, ভুল ${bn(m.wrong)}, উত্তর দেওয়া হয়নি ${bn(m.unanswered)}। সময় লেগেছে ${formatDurationBn(m.takenSeconds)}।`;
  return `
    <section class="rx-card rx-hero rx-in" aria-labelledby="rx-tier-title">
      <div class="rx-ring-wrap" aria-hidden="true">
        <svg class="rx-ring" viewBox="0 0 120 120" focusable="false">
          <circle class="rx-ring-track" cx="60" cy="60" r="52"/>
          <circle class="rx-ring-bar" cx="60" cy="60" r="52" pathLength="100" style="--off:${100 - m.percent}"/>
        </svg>
        <div class="rx-ring-text"><b ${countAttrs(m.percent, 0, "%")}>${m.percent}%</b><span>শতকরা</span></div>
      </div>
      <div class="rx-hero-body">
        <h3 class="rx-tier" id="rx-tier-title" tabindex="-1">${E(tier.title)}</h3>
        <p class="rx-tier-msg">${E(tier.message)}</p>
        <p class="rx-score" aria-hidden="true">স্কোর <b ${countAttrs(m.score, scoreDec)}>${formatScoreText(m.score)}</b><span> / ${m.total}</span></p>
        <p class="sr-only">${summary}</p>
        <div class="rx-pills">${passPill}</div>
        <div id="exs-save-status" class="exs-save-status" role="status" aria-live="polite"></div>
      </div>
    </section>`;
}

function notesHtml(a) {
  const { m } = a;
  const notes = [];
  if (m.auto) {
    notes.push(`<p class="rx-note rx-note--warn rx-in"><i class="fa-solid fa-hourglass-end" aria-hidden="true"></i><span>সময় শেষ হয়ে যাওয়ায় পরীক্ষা স্বয়ংক্রিয়ভাবে জমা হয়েছে — সেই মুহূর্ত পর্যন্ত দেওয়া উত্তরগুলোই গণনা করা হয়েছে।</span></p>`);
  }
  if (m.belowZero) {
    notes.push(`<p class="rx-note rx-note--warn rx-in"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>নেগেটিভ মার্কিংয়ের কারণে স্কোর শূন্যের নিচে নেমেছে (${bn(formatScoreText(m.score))}); তাই শতকরা ০% দেখানো হচ্ছে।</span></p>`);
  }
  return notes.join("");
}

function statCard(kind, icon, valueHtml, label, sub = "") {
  return `
    <article class="rx-stat rx-stat--${kind} rx-in">
      <span class="rx-stat-ico" aria-hidden="true"><i class="fa-solid ${icon}"></i></span>
      <b class="rx-stat-num" aria-hidden="true">${valueHtml}</b>
      <span class="rx-stat-label">${label}</span>
      ${sub ? `<small class="rx-stat-sub">${sub}</small>` : ""}
    </article>`;
}

function statsHtml(a) {
  const { m } = a;
  const count = (n) => `<span ${countAttrs(n)}>${n}</span>`;
  const penaltyTxt = m.negativeMarking > 0 && m.wrong > 0 ? `${bn(formatScoreText(m.penalty))} নম্বর কাটা গেছে` : "";
  const skipTxt = m.negativeMarking > 0 && m.unanswered > 0 ? "কোনো নম্বর কাটা যায়নি" : "";
  const allowed = m.allowedSeconds > 0 ? `বরাদ্দ ${formatClockText(m.allowedSeconds)}` : "";
  const aria = `${bn(m.total)}টি প্রশ্নের মধ্যে ${bn(m.correct)}টি সঠিক, ${bn(m.wrong)}টি ভুল, ${bn(m.unanswered)}টিতে উত্তর দেওয়া হয়নি`;
  return `
    <section class="rx-stats" aria-label="ফলাফলের সারসংক্ষেপ">
      ${statCard("ok", "fa-check", count(m.correct), "সঠিক", `${bn(m.total)}টির মধ্যে`)}
      ${statCard("bad", "fa-xmark", count(m.wrong), "ভুল", penaltyTxt)}
      ${statCard("skip", "fa-minus", count(m.unanswered), "উত্তর দেওয়া হয়নি", skipTxt)}
      ${statCard("time", "fa-stopwatch", formatClockText(m.takenSeconds), "সময় লেগেছে", allowed)}
    </section>
    <div class="rx-dist rx-in" role="img" aria-label="${aria}">
      <span class="rx-dist-seg rx-dist-seg--ok" style="--w:${m.shares.correct}"></span>
      <span class="rx-dist-seg rx-dist-seg--bad" style="--w:${m.shares.wrong}"></span>
      <span class="rx-dist-seg rx-dist-seg--skip" style="--w:${m.shares.unanswered}"></span>
    </div>`;
}

function actionsHtml(attempt, courseHref, mistakes) {
  return `
    <div class="rx-actions exs-no-print rx-in">
      <button type="button" class="rx-btn rx-btn--primary" id="exs-retake"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>আবার দিন</span></button>
      <a href="${courseHref}" class="rx-btn rx-btn--outline" id="exs-course-link"><i class="fa-solid fa-list" aria-hidden="true"></i><span>কোর্সের এক্সাম</span></a>
      <button type="button" class="rx-btn rx-btn--outline" id="exs-print-result"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i><span>PDF ডাউনলোড</span></button>
      ${mistakes > 0 ? `<button type="button" class="rx-btn rx-btn--ghost" data-rx-act="review"><i class="fa-solid fa-list-check" aria-hidden="true"></i><span>ভুলগুলো দেখুন (${bn(mistakes)})</span></button>` : ""}
    </div>`;
}

/* ---------- time ---------- */
function timeHtml(a, attempt) {
  const { m, timing } = a;
  const hasLimit = m.allowedSeconds > 0;
  const kv = [];
  if (hasLimit) kv.push(`<li><span>${m.auto ? "অবস্থা" : "বাকি ছিল"}</span><b>${m.auto || m.timeLeftSeconds === 0 ? "সময় শেষ হয়েছে" : formatDurationBn(m.timeLeftSeconds)}</b></li>`);
  if (m.avgSecondsPerQuestion !== null) kv.push(`<li><span>প্রতি প্রশ্নে গড় সময়</span><b>${formatDurationBn(m.avgSecondsPerQuestion)}</b></li>`);
  if (m.allowedSecondsPerQuestion) kv.push(`<li><span>প্রতি প্রশ্নে বরাদ্দ</span><b>${formatDurationBn(m.allowedSecondsPerQuestion)}</b></li>`);

  let slow;
  if (timing.tracked) {
    const dot = (s) => (s === "correct" ? "is-ok" : s === "wrong" ? "is-bad" : "is-skip");
    const label = (s) => (s === "correct" ? "সঠিক" : s === "wrong" ? "ভুল" : "উত্তর হয়নি");
    slow = `
      <p class="rx-sub">সবচেয়ে বেশি সময় লাগা প্রশ্ন</p>
      <ol class="rx-slow">${timing.slowest.map((q) => `<li><span>প্রশ্ন ${bn(q.n)}</span><em class="rx-dot ${dot(q.status)}">${label(q.status)}</em><b>${formatDurationBn(q.sec)}</b></li>`).join("")}</ol>`;
    if (!timing.slowest.length) slow = `<p class="rx-sub">কোনো প্রশ্নেই উল্লেখযোগ্য বেশি সময় লাগেনি।</p>`;
  } else {
    slow = `<p class="rx-sub">${attempt.layout === "all" ? "এই পরীক্ষায় সব প্রশ্ন একসাথে দেখানো হয়, তাই প্রশ্ন ধরে সময় মাপা যায়নি।" : "প্রশ্ন ধরে সময়ের তথ্য পাওয়া যায়নি।"}</p>`;
  }

  return `
    <section class="rx-card rx-in" id="rx-time">
      <h3 class="rx-h"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i>সময় বিশ্লেষণ</h3>
      ${hasLimit ? `<div class="rx-meter" role="img" aria-label="বরাদ্দ সময়ের ${bn(m.timeUsedPercent)}% ব্যবহার করেছেন"><span class="rx-meter-fill" style="--w:${m.timeUsedPercent}"></span></div>
      <p class="rx-line"><b>${formatDurationBn(m.takenSeconds)}</b> সময় লেগেছে · বরাদ্দ ${formatDurationBn(m.allowedSeconds)} (${bnPct(m.timeUsedPercent)} ব্যবহৃত)</p>`
        : `<p class="rx-line"><b>${formatDurationBn(m.takenSeconds)}</b> সময় লেগেছে</p>`}
      ${kv.length ? `<ul class="rx-kv">${kv.join("")}</ul>` : ""}
      ${slow}
    </section>`;
}

/* ---------- negative marking ---------- */
function negativeHtml(a) {
  const { m } = a;
  if (!(m.negativeMarking > 0)) return "";
  const neg = bn(formatScoreText(m.negativeMarking));
  const eq = m.wrong > 0
    ? `<div class="rx-eq" role="img" aria-label="সঠিক ${bn(m.correct)} বিয়োগ কর্তন ${bn(formatScoreText(m.penalty))} সমান স্কোর ${bn(formatScoreText(m.score))}">
        <span class="rx-eq-item"><small>সঠিক</small><b>${m.correct}</b></span>
        <span class="rx-eq-op" aria-hidden="true">−</span>
        <span class="rx-eq-item is-bad"><small>${m.wrong} × ${formatScoreText(m.negativeMarking)}</small><b>${formatScoreText(m.penalty)}</b></span>
        <span class="rx-eq-op" aria-hidden="true">=</span>
        <span class="rx-eq-item is-total"><small>স্কোর</small><b>${formatScoreText(m.score)}</b></span>
      </div>`
    : "";
  return `
    <section class="rx-card rx-in" id="rx-negative">
      <h3 class="rx-h"><i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>নেগেটিভ মার্কিং</h3>
      <p class="rx-line">এই এক্সামে প্রতিটি ভুল উত্তরে <b>${neg}</b> নম্বর কাটা যায়। উত্তর না দিলে কোনো নম্বর কাটা যায় না।</p>
      ${m.wrong > 0
        ? `<p class="rx-line">আপনার ${bn(m.wrong)}টি ভুল উত্তরের জন্য মোট <b>${bn(formatScoreText(m.penalty))}</b> নম্বর কাটা গেছে।</p>${eq}`
        : `<p class="rx-line rx-good">কোনো ভুল উত্তর নেই, তাই কোনো নম্বর কাটা যায়নি।</p>`}
    </section>`;
}

/* ---------- analytics sections (the history-based ones start as "pending" and are refilled) ---------- */
const loadingHtml = (text) => `<p class="rx-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>${text}</p>`;
const emptyHtml = (icon, text) => `<div class="rx-empty"><i class="fa-solid ${icon}" aria-hidden="true"></i><p>${text}</p></div>`;

function accuracyInner(a) {
  const { m } = a;
  const acc = m.accuracy;
  return `
    <h3 class="rx-h"><i class="fa-solid fa-bullseye" aria-hidden="true"></i>নির্ভুলতা</h3>
    ${acc === null
      ? emptyHtml("fa-circle-minus", "কোনো প্রশ্নের উত্তর দেওয়া হয়নি, তাই নির্ভুলতা মাপা যায়নি।")
      : `<div class="rx-acc">
          <b class="rx-acc-num" aria-hidden="true"><span ${countAttrs(acc, Number.isInteger(acc) ? 0 : 1, "%")}>${pctText(acc)}%</span></b>
          <span class="rx-acc-cap">উত্তর দেওয়া ${bn(m.attempted)}টির মধ্যে ${bn(m.correct)}টি সঠিক</span>
        </div>
        <div class="rx-meter rx-meter--ok" role="img" aria-label="নির্ভুলতা ${bn(pctText(acc))}%"><span class="rx-meter-fill" style="--w:${acc}"></span></div>`}
    <div class="rx-rate">
      <span>উত্তর দেওয়ার হার</span>
      <b>${bn(pctText(m.attemptRate))}% <small>(${bn(m.total)}টির মধ্যে ${bn(m.attempted)}টি)</small></b>
    </div>
    <div class="rx-meter" role="img" aria-label="${bn(pctText(m.attemptRate))}% প্রশ্নের উত্তর দেওয়া হয়েছে"><span class="rx-meter-fill" style="--w:${m.attemptRate}"></span></div>`;
}

function deltaItem(label, value, goodWhen, fmt) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const dir = v === 0 ? "same" : v > 0 ? "up" : "down";
  const cls = dir === "same" || !goodWhen ? "is-same" : goodWhen === dir ? "is-good" : "is-bad";
  return `<li class="rx-delta ${cls}"><span>${label}</span><b>${fmt(v)}</b></li>`;
}

function compareInner(a) {
  const c = a.comparison;
  const head = `<h3 class="rx-h"><i class="fa-solid fa-code-compare" aria-hidden="true"></i>আগের ফলাফলের সাথে তুলনা</h3>`;
  if (c.state === "pending") return head + loadingHtml("আগের ফলাফল লোড হচ্ছে…");
  if (c.state === "unknown") return head + emptyHtml("fa-circle-question", "আগের ফলাফল এই মুহূর্তে লোড করা যায়নি, তাই তুলনা দেখানো যাচ্ছে না।");

  const others = c.vsOthers
    ? `<p class="rx-line rx-others">আপনার অন্যান্য পরীক্ষার গড় ${bnPct(c.vsOthers.avg)} — এবার ${bnPct(a.m.percent)} (${bn(deltaText(c.vsOthers.delta))})।</p>`
    : "";

  if (c.state === "first") {
    return head + emptyHtml("fa-flag-checkered", "এটি এই এক্সামে আপনার প্রথম অ্যাটেম্পট, তাই তুলনা করার মতো আগের ফলাফল নেই। পরের অ্যাটেম্পট থেকে এখানে উন্নতি-অবনতি দেখা যাবে।") + others;
  }

  const m = a.m;
  const dirIcon = c.direction === "up" ? "fa-arrow-trend-up" : c.direction === "down" ? "fa-arrow-trend-down" : "fa-arrows-left-right";
  const title = c.direction === "up" ? `আগের অ্যাটেম্পটের চেয়ে ${bnPct(c.deltaPercent)} বেশি`
    : c.direction === "down" ? `আগের অ্যাটেম্পটের চেয়ে ${bnPct(Math.abs(c.deltaPercent))} কম`
    : "আগের অ্যাটেম্পটের সমান";
  const badge = c.isNewBest
    ? `<span class="rx-badge rx-badge--ok"><i class="fa-solid fa-trophy" aria-hidden="true"></i>নতুন সেরা ফলাফল</span>`
    : c.equalsBest ? `<span class="rx-badge"><i class="fa-solid fa-equals" aria-hidden="true"></i>আপনার সেরা ফলাফলের সমান</span>` : "";

  const d = c.detail;
  const timeFmt = (v) => `${formatDurationBn(Math.abs(v))} ${v < 0 ? "কম" : "বেশি"}`;
  const deltas = d
    ? [
        deltaItem("সঠিক উত্তর", d.deltaCorrect, "up", (v) => (v > 0 ? `+${bn(v)}টি` : `−${bn(Math.abs(v))}টি`)),
        deltaItem("ভুল উত্তর", d.deltaWrong, "down", (v) => (v > 0 ? `+${bn(v)}টি` : `−${bn(Math.abs(v))}টি`)),
        deltaItem("নির্ভুলতা", d.deltaAccuracy, "up", (v) => bn(deltaText(v))),
        deltaItem("সময়", d.deltaTimeSeconds, null, timeFmt),
      ].join("")
    : "";

  const trend = c.trend && c.trend.length > 1
    ? `<p class="rx-sub">সাম্প্রতিক অ্যাটেম্পট (শতকরা)</p>
       <div class="rx-trend" role="img" aria-label="সাম্প্রতিক অ্যাটেম্পট: ${c.trend.map((p) => `${bn(p)}%`).join(", ")}">${c.trend.map((p, i) => `<span class="rx-trend-bar${i === c.trend.length - 1 ? " is-latest" : ""}" style="--h:${Math.max(6, p)}" title="${p}%"></span>`).join("")}</div>`
    : "";

  return `${head}
    <div class="rx-cmp-head">
      <span class="rx-delta-big is-${c.direction}"><i class="fa-solid ${dirIcon}" aria-hidden="true"></i><b>${c.direction === "same" ? "0%" : deltaText(c.deltaPercent)}</b></span>
      <div><p class="rx-cmp-title">${title}</p>${badge}</div>
    </div>
    <div class="rx-cmp-pair">
      <div><span>আগের অ্যাটেম্পট${c.prevAttemptNumber ? ` (#${bn(c.prevAttemptNumber)})` : ""}</span><b>${bnPct(c.prevPercent)}</b>${c.prevTotal ? `<small>${bn(formatScoreText(c.prevScore))} / ${bn(c.prevTotal)}</small>` : ""}</div>
      <div class="is-now"><span>এবার</span><b>${bnPct(m.percent)}</b><small>${bn(formatScoreText(m.score))} / ${bn(m.total)}</small></div>
    </div>
    ${deltas ? `<ul class="rx-deltas">${deltas}</ul>` : ""}
    ${trend}${others}`;
}

function subjectsInner(a) {
  const s = a.subjects;
  const head = `<h3 class="rx-h"><i class="fa-solid fa-book-open-reader" aria-hidden="true"></i>বিষয়ভিত্তিক পারফরম্যান্স</h3>`;
  if (s.state === "pending") return head + loadingHtml("বিষয়ভিত্তিক তথ্য লোড হচ্ছে…");
  if (s.state === "unknown") return head + emptyHtml("fa-circle-question", "বিষয়ভিত্তিক তথ্য এই মুহূর্তে লোড করা যায়নি, তাই বিশ্লেষণ দেখানো যাচ্ছে না।");
  if (s.state === "empty") {
    return head + emptyHtml("fa-layer-group", s.reason === "no-subject"
      ? "এই এক্সামে কোনো বিষয় ঠিক করা নেই এবং আপনার আগের পরীক্ষাতেও বিষয়ের তথ্য নেই, তাই বিষয়ভিত্তিক বিশ্লেষণ দেখানো যাচ্ছে না। বিষয় যুক্ত পরীক্ষা দিলে এখানে বিষয় ধরে আপনার গড় দেখা যাবে।"
      : "পরীক্ষাগুলোর বিষয়ের নাম পাওয়া যায়নি, তাই বিশ্লেষণ দেখানো যাচ্ছে না।");
  }
  const label = { weak: "রিভিশন দরকার", ok: "মোটামুটি", strong: "ভালো" };
  const rows = s.rows.map((r) => `
    <li class="rx-subj is-${r.status}${r.isCurrent ? " is-current" : ""}">
      <div class="rx-subj-head">
        <b>${E(r.name)}</b>${r.isCurrent ? `<span class="rx-chip rx-chip--cobalt">এই পরীক্ষা</span>` : ""}
        <span class="rx-subj-n">${bn(r.exams)}টি পরীক্ষা</span>
        <em>${bnPct(r.avg)}</em>
      </div>
      <div class="rx-meter" role="img" aria-label="${E(r.name)}: গড় ${bn(r.avg)}%"><span class="rx-meter-fill" style="--w:${r.avg}"></span></div>
      <small class="rx-subj-state">${label[r.status]}${r.status === "weak" ? ` — গড় পাস মার্ক ${bnPct(s.line)}-এর নিচে` : ""}</small>
    </li>`).join("");
  return `${head}
    <ul class="rx-subjects">${rows}</ul>
    <p class="rx-foot">প্রতিটি বিষয়ের পরীক্ষাগুলোর সর্বশেষ ফলাফলের গড় দেখানো হয়েছে।${s.partial ? " আগের ফলাফল লোড না হওয়ায় এখানে শুধু এই পরীক্ষার তথ্য আছে।" : ""}${s.hidden > 0 ? ` আরও ${bn(s.hidden)}টি বিষয় দেখানো হয়নি।` : ""}</p>`;
}

function suggestInner(a) {
  const head = `<h3 class="rx-h"><i class="fa-solid fa-lightbulb" aria-hidden="true"></i>পরামর্শ ও রিভিশন</h3>`;
  if (!a.suggestions.length) return head + emptyHtml("fa-circle-check", "এই মুহূর্তে বিশেষ কোনো পরামর্শ নেই।");
  return `${head}
    <ul class="rx-tips">${a.suggestions.map((s) => `
      <li class="rx-tip is-${s.tone}">
        <i class="fa-solid ${s.icon || "fa-circle-info"}" aria-hidden="true"></i>
        <p>${E(s.text)}${s.action === "review" ? ` <button type="button" class="rx-link" data-rx-act="review">ভুলগুলো দেখুন</button>` : ""}</p>
      </li>`).join("")}</ul>`;
}

/* ==========================================================================
   The animation layer (an enhancement only — see the header comment)
   ========================================================================== */
function schedule(fn, ms) {
  const s = live;
  if (!s) return 0;
  const t = setTimeout(() => { s.timers.delete(t); if (!s.cancelled) { try { fn(); } catch (err) { console.error(err); } } }, ms);
  s.timers.add(t);
  return t;
}

/** Puts every animated number back to exactly the text the markup was rendered with. */
function settleNumbers(root) {
  root.querySelectorAll("[data-count]").forEach((el) => { if (el.dataset.final !== undefined) el.textContent = el.dataset.final; });
}

function startCountUp(root) {
  const s = live;
  if (!s) return;
  const nodes = Array.from(root.querySelectorAll("[data-count]")).map((el) => {
    el.dataset.final = el.textContent;
    return { el, to: Number(el.dataset.count), dec: Number(el.dataset.dec) || 0, suffix: el.dataset.suffix || "" };
  });
  const paint = (n, v) => { n.el.textContent = `${n.dec ? v.toFixed(n.dec) : Math.round(v)}${n.suffix}`; };
  nodes.forEach((n) => paint(n, 0));

  const startAt = performance.now() + STAGE_MS;
  const tick = (now) => {
    if (s.cancelled || !root.isConnected) return;
    const t = clamp((now - startAt) / COUNT_MS, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    nodes.forEach((n) => paint(n, n.to * eased));
    if (t < 1) s.raf = requestAnimationFrame(tick);
    else settleNumbers(root);
  };
  s.raf = requestAnimationFrame(tick);
  // rAF is paused in a background tab — the timer guarantees the true numbers are always put back.
  schedule(() => settleNumbers(root), STAGE_MS + COUNT_MS + 350);
}

/** Final state, immediately: no overlay, no motion, the real numbers. Used for skip, reduced motion and any failure. */
function makeStatic(root) {
  root.classList.remove("rx-animate");
  root.classList.add("rx-static", "rx-stage-done");
  const s = live;
  if (s?.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
  settleNumbers(root);
}

function startAnimation(root) {
  root.classList.add("rx-animate");
  startCountUp(root);
  // The overlay leaves by CSS at ≈1.0–1.3 s; this removes it for good even if CSS animations are unavailable.
  schedule(() => root.classList.add("rx-stage-done"), STAGE_MS + 420);
  schedule(() => root.querySelector("#rx-tier-title")?.focus({ preventScroll: true }), STAGE_MS + 450);
  root.querySelector("#rx-stage")?.addEventListener("click", () => makeStatic(root), { once: true });
}

/* ==========================================================================
   Public: the screen itself
   ========================================================================== */
export function renderResult(resultView, attempt, hooks = {}) {
  disposeResult();
  try {
    return renderRich(resultView, attempt, hooks);
  } catch (err) {
    console.error("Result screen: the rich layout failed, drawing the plain one instead:", err);
    disposeResult();
    return renderFallback(resultView, attempt, hooks);
  }
}

function renderRich(resultView, attempt, hooks) {
  const { onRetrySave, loadContext, onAnalytics } = hooks;
  const core = buildCoreAnalytics(attempt);
  const review = normalizeReview(attempt.review);
  const courseHref = `#/exam?course=${encodeURIComponent(attempt.courseId || "general")}`;
  const theme = storedTheme() || systemTheme();

  resultView.classList.add("exam-result-wrap");
  resultView.innerHTML = `
    <div class="rx" id="rx-root" lang="bn" data-theme="${theme}" data-pass="${core.tier.pass.passed ? "yes" : "no"}">
      ${stageHtml(attempt)}
      ${topHtml(attempt)}
      ${heroHtml(attempt, core)}
      ${notesHtml(core)}
      ${statsHtml(core)}
      ${actionsHtml(attempt, courseHref, review.length)}
      <div class="rx-grid">
        ${timeHtml(core, attempt)}
        ${negativeHtml(core)}
      </div>
      <h2 class="rx-section-title rx-in">বিশ্লেষণ <small>আপনার আসল ফলাফল ও আগের ডেটার ভিত্তিতে</small></h2>
      <div class="rx-grid">
        <section class="rx-card rx-in" id="rx-accuracy">${accuracyInner(core)}</section>
        <section class="rx-card rx-in" id="rx-compare">${compareInner(core)}</section>
        <section class="rx-card rx-in" id="rx-subjects">${subjectsInner(core)}</section>
        <section class="rx-card rx-in" id="rx-suggest">${suggestInner(core)}</section>
      </div>
      <p class="exs-result-note exs-no-print"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>"PDF ডাউনলোড"-এ চাপলে প্রিন্ট ডায়ালগ খুলবে — সেখানে <b>Save as PDF</b> বেছে নিন। PDF শুধু এই পেজ থেকেই পাওয়া যায়; পেজ ছেড়ে গেলে <b>My Activity</b>-তে শুধু ভুলগুলো দেখা যাবে (${bn(reviewTtlHours())} ঘণ্টা পর্যন্ত), PDF নয়।</span></p>
      <div id="rx-review" tabindex="-1">${reviewListHtml(review)}</div>
      <p class="sr-only" id="rx-live" role="status" aria-live="polite"></p>
    </div>`;

  const root = resultView.querySelector("#rx-root");
  live = { root, timers: new Set(), raf: 0, cancelled: false, mq: null, onMq: null };

  // Limited stagger: at most 8 steps, so a long page never makes anyone wait.
  root.querySelectorAll(".rx-in").forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, 7))));

  updateSaveStatus(resultView, attempt);

  // ---- theme toggle ----
  const themeBtn = root.querySelector("#rx-theme");
  const syncThemeBtn = () => {
    const t = root.dataset.theme;
    themeBtn.setAttribute("aria-pressed", String(t === "dark"));
    themeBtn.title = t === "dark" ? "লাইট থিমে দেখুন" : "ডার্ক থিমে দেখুন";
    themeBtn.querySelector("i").className = `fa-solid ${t === "dark" ? "fa-sun" : "fa-moon"}`;
  };
  syncThemeBtn();
  themeBtn.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    rememberTheme(next);
    syncThemeBtn();
  });
  // Until the student picks a theme themselves, follow the device if its setting changes.
  try {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    live.mq = mq;
    live.onMq = () => { if (!storedTheme() && FOLLOW_SYSTEM_THEME) { root.dataset.theme = systemTheme(); syncThemeBtn(); } };
    mq.addEventListener("change", live.onMq);
  } catch { /* old browser: no live theme following */ }

  // ---- buttons ----
  let leaving = false;
  async function leaveIfSure(go) {
    if (leaving) return;
    // Leaving with a result that isn't stored yet would lose it — ask first.
    if (attempt.saveState !== "saved" && attempt.saveState !== "blocked") {
      const ok = await confirmAction(
        "এই ফলাফল এখনো সেভ হয়নি। এখন চলে গেলে এটি হারিয়ে যেতে পারে।",
        { title: "সেভ হয়নি", confirmLabel: "তবুও যাব", cancelLabel: "থাকি" }
      );
      if (!ok) return;
    }
    leaving = true;
    go();
  }
  bindCommonActions(resultView, root, { courseHref, leaveIfSure, onRetrySave });

  // ---- animation (enhancement) ----
  if (!prefersReducedMotion() && !document.hidden) {
    try { startAnimation(root); } catch (err) { console.error("Result animation failed — showing the finished result:", err); makeStatic(root); }
  } else {
    makeStatic(root);
    schedule(() => { root.querySelector("#rx-tier-title")?.focus({ preventScroll: true }); }, 30);
  }
  schedule(() => { const lv = root.querySelector("#rx-live"); if (lv) lv.textContent = "পরীক্ষা সফলভাবে জমা হয়েছে"; }, 60);

  // ---- history-based analytics (arrives a moment later; the screen never waits for it) ----
  let analytics = core;
  const renderedAt = performance.now();
  if (typeof loadContext === "function") {
    Promise.resolve()
      .then(() => loadContext())
      .then((ctx) => ctx || null, () => null)
      .then((ctx) => {
        const s = live;
        if (!s || s.root !== root || !root.isConnected) return;
        analytics = completeAnalytics(attempt, core, ctx);
        fillAnalytics(root, analytics, { late: performance.now() - renderedAt > STAGE_MS + 600 });
        try { onAnalytics?.(analytics); } catch (err) { console.error(err); }
      })
      .catch((err) => console.error("Result analytics:", err));
  }

  return { analytics: () => analytics, dispose: disposeResult };
}

/** `late` = the entrance has already played, so the new content fades in on its own instead of waiting for the stage delays. */
function fillAnalytics(root, a, { late = false } = {}) {
  const put = (id, html) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle("rx-fresh", late);
  };
  put("#rx-compare", compareInner(a));
  put("#rx-subjects", subjectsInner(a));
  put("#rx-suggest", suggestInner(a));
}

/** Buttons shared by the rich screen and the plain fallback. */
function bindCommonActions(resultView, root, { courseHref, leaveIfSure, onRetrySave }) {
  resultView.querySelector("#exs-print-result")?.addEventListener("click", async () => {
    let ok = false;
    try { ok = await printReport(); } catch (err) { console.error(err); }
    // No report block could be mounted (it should never happen): print the page itself — it has its own print layout.
    if (!ok) window.print();
  });
  resultView.querySelector("#exs-retake")?.addEventListener("click", () => leaveIfSure(() => reloadRoute()));
  resultView.querySelector("#exs-course-link")?.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // "open in new tab" etc. — leave it to the browser
    e.preventDefault();
    leaveIfSure(() => navigate(courseHref));
  });
  resultView.querySelector("#exs-save-status")?.addEventListener("click", (e) => {
    if (e.target.closest(".exs-save-retry")) onRetrySave?.();
  });
  // "Show me the mistakes" buttons / links (also inside the suggestions that get refilled later) → one delegated listener.
  // Bound on `root` (re-created for every result screen), never on the long-lived resultView, so listeners cannot pile up.
  root.addEventListener("click", (e) => {
    if (!e.target.closest("[data-rx-act='review']")) return;
    const target = root.querySelector("#rx-review");
    if (!target) return;
    target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  });
}

/* ==========================================================================
   Plain fallback — used only if the rich screen throws. No animation, no analytics, same ids and buttons.
   ========================================================================== */
function renderFallback(resultView, attempt, hooks) {
  const { onRetrySave } = hooks;
  const total = Number(attempt.total) || 0;
  const percent = clamp(Math.round(Number(attempt.percent) || 0), 0, 100);
  const courseHref = `#/exam?course=${encodeURIComponent(attempt.courseId || "general")}`;
  let review = [];
  try { review = normalizeReview(attempt.review); } catch { /* leave the list empty */ }
  let reviewHtml = "";
  try { reviewHtml = reviewListHtml(review); } catch { /* the list is optional */ }

  resultView.classList.add("exam-result-wrap");
  resultView.innerHTML = `
    <div class="rx rx-static rx-stage-done rx-fallback" id="rx-root" lang="bn" data-theme="${storedTheme() || systemTheme()}">
      <section class="rx-card rx-hero">
        <div class="rx-hero-body">
          <p class="rx-kicker"><span>পরীক্ষা সফলভাবে জমা হয়েছে</span></p>
          <h2 class="rx-exam">${E(attempt.examTitle)}</h2>
          <h3 class="rx-tier">${percent}%</h3>
          <p class="rx-score">স্কোর <b>${formatScoreText(attempt.score)}</b><span> / ${total}</span></p>
          <p class="rx-line">সঠিক ${Number(attempt.correctCount) || 0} · ভুল ${Number(attempt.wrongCount) || 0} · উত্তর দেওয়া হয়নি ${Number(attempt.unansweredCount) || 0} · সময় লেগেছে ${formatClockText(attempt.timeTakenSeconds)}</p>
          <div id="exs-save-status" class="exs-save-status" role="status" aria-live="polite"></div>
        </div>
      </section>
      <div class="rx-actions exs-no-print">
        <button type="button" class="rx-btn rx-btn--primary" id="exs-retake"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>আবার দিন</span></button>
        <a href="${courseHref}" class="rx-btn rx-btn--outline" id="exs-course-link"><i class="fa-solid fa-list" aria-hidden="true"></i><span>কোর্সের এক্সাম</span></a>
        <button type="button" class="rx-btn rx-btn--outline" id="exs-print-result"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i><span>PDF ডাউনলোড</span></button>
      </div>
      <div id="rx-review" tabindex="-1">${reviewHtml}</div>
    </div>`;

  const root = resultView.querySelector("#rx-root");
  live = { root, timers: new Set(), raf: 0, cancelled: false, mq: null, onMq: null };
  updateSaveStatus(resultView, attempt);

  let leaving = false;
  async function leaveIfSure(go) {
    if (leaving) return;
    if (attempt.saveState !== "saved" && attempt.saveState !== "blocked") {
      const ok = await confirmAction("এই ফলাফল এখনো সেভ হয়নি। এখন চলে গেলে এটি হারিয়ে যেতে পারে।", { title: "সেভ হয়নি", confirmLabel: "তবুও যাব", cancelLabel: "থাকি" });
      if (!ok) return;
    }
    leaving = true;
    go();
  }
  bindCommonActions(resultView, root, { courseHref, leaveIfSure, onRetrySave });
  return { analytics: () => null, dispose: disposeResult };
}
