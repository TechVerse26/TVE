// ==========================================================================
// exam-report.js — the student's downloadable PDF result report.
//
// Exists ONLY while the result screen that follows an exam is showing:
//   mountReport(attempt, analytics?)  — called when the result screen is drawn (and again when the comparison /
//                                       subject analysis has arrived, so the PDF carries the same analysis)
//   unmountReport()                   — called the moment the student leaves it
// so the PDF can be produced right after the exam and never again from
// "My Activity" (which is view-only by design).
//
// How the PDF is made: the browser's own print pipeline ("Save as PDF") —
// no PDF library, so Bengali text is shaped perfectly, the file is tiny and
// its text is selectable. The old approach printed the on-screen result page
// itself, which dragged the dark theme into the PDF (pale text on white, no
// logo, no exam name, the score ring vanished). Instead a dedicated light,
// report-styled block (#exs-report) is built once, kept hidden on screen, and
// — while the `exs-has-report` class is on <body> — is the ONLY thing the
// print view shows (see the @media print rules in exam.css). Because it is
// pre-built and its logo is already loaded, both the "PDF ডাউনলোড" button and
// a plain Ctrl+P produce exactly the same clean report.
//
// The report is static paper: no animation, no buttons, no theme toggle, nothing that only makes sense on a
// screen. Its numbers and sentences come from exam-analytics.js — the same source as the on-screen result — so the
// two can never disagree; a section whose data is not known (history that never loaded) is simply left out.
// ==========================================================================
import { escapeHtml, formatScore, formatDateTime } from "./utils.js";
import { toBnDigits } from "./schedule-core.js";
import { normalizeReview } from "./exam-review.js";
import { buildCoreAnalytics, formatClockText, formatDurationBn, formatScoreText, deltaText } from "./exam-analytics.js";

const LOGO_SRC = "assets/logo.svg";
const bn = (v) => toBnDigits(v);

let mounted = null; // { el, fileName, prevTitle }

function fileNameFor(attempt) {
  const d = new Date(attempt.submittedAtMs || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const title = String(attempt.examTitle || "Exam").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `TVexam Result - ${title} - ${day}`;
}

function metaRow(label, value) {
  if (!value) return "";
  return `<div class="exs-report-meta-row"><span>${label}</span><b>${escapeHtml(value)}</b></div>`;
}

function tile(label, value, tone = "") {
  return `<div class="exs-report-tile ${tone}"><span>${label}</span><b>${escapeHtml(value)}</b></div>`;
}

function mistakeHtml(q) {
  const answered = q.selected !== null && q.selected !== undefined;
  const hasExplanation = q.explanation && String(q.explanation).trim();
  return `
    <article class="exs-report-q">
      <div class="exs-report-q-text">${q.n}. ${escapeHtml(q.text)}</div>
      <div class="exs-report-ans is-wrong"><span>আপনার উত্তর:</span> ${answered ? escapeHtml(q.options[q.selected]) : "উত্তর দেওয়া হয়নি"}</div>
      <div class="exs-report-ans is-right"><span>সঠিক উত্তর:</span> ${escapeHtml(q.options[q.correctIndex])}</div>
      ${hasExplanation ? `<div class="exs-report-explain"><b>ব্যাখ্যা:</b> ${escapeHtml(q.explanation)}</div>` : ""}
    </article>`;
}

/* ---------- the analysis block (only what is really known) ---------- */
function analysisRow(label, value, note = "") {
  return `<div class="exs-report-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function analysisHtml(a) {
  const { m, tier, comparison: c, subjects: s, suggestions } = a;
  const rows = [];

  rows.push(analysisRow("পাস মার্ক", `${bn(tier.pass.percent)}%`, tier.pass.passed ? "অতিক্রম করেছেন" : `আর ${bn(tier.pass.gap)}% বাকি`));
  if (m.accuracy !== null) rows.push(analysisRow("নির্ভুলতা", `${bn(m.accuracy)}%`, `উত্তর দেওয়া ${bn(m.attempted)}টির মধ্যে ${bn(m.correct)}টি সঠিক`));
  rows.push(analysisRow("উত্তর দেওয়ার হার", `${bn(m.attemptRate)}%`, `${bn(m.total)}টির মধ্যে ${bn(m.attempted)}টি`));
  rows.push(analysisRow("সময় ব্যবহার", formatDurationBn(m.takenSeconds),
    [m.allowedSeconds > 0 ? `বরাদ্দ ${formatDurationBn(m.allowedSeconds)} (${bn(m.timeUsedPercent)}% ব্যবহার)` : "", m.auto ? "সময় শেষ হওয়ায় স্বয়ংক্রিয়ভাবে জমা" : ""].filter(Boolean).join(" · ")));
  if (m.negativeMarking > 0 && m.wrong > 0) {
    rows.push(analysisRow("নেগেটিভ মার্কিং", `${bn(formatScoreText(m.penalty))} নম্বর কাটা গেছে`, `${bn(m.wrong)} ভুল × ${bn(formatScoreText(m.negativeMarking))}`));
  }
  if (m.belowZero) rows.push(analysisRow("স্কোর", "শূন্যের নিচে", "তাই শতকরা ০% দেখানো হয়েছে"));

  if (c.state === "ok") {
    rows.push(analysisRow("আগের অ্যাটেম্পটের সাথে", `${bn(c.prevPercent)}% → ${bn(m.percent)}%`,
      c.direction === "same" ? "অপরিবর্তিত" : `${bn(deltaText(c.deltaPercent))}${c.isNewBest ? " · নতুন সেরা ফলাফল" : ""}`));
  } else if (c.state === "first") {
    rows.push(analysisRow("আগের অ্যাটেম্পটের সাথে", "প্রযোজ্য নয়", "এটি এই এক্সামে আপনার প্রথম অ্যাটেম্পট"));
  }

  const subjectBlock = s.state === "ok"
    ? `<h3 class="exs-report-h3">বিষয়ভিত্তিক পারফরম্যান্স</h3>
       <ul class="exs-report-subj">${s.rows.map((r) => `<li><span>${escapeHtml(r.name)}${r.isCurrent ? " (এই পরীক্ষা)" : ""}</span><em>${bn(r.exams)}টি পরীক্ষা</em><b>${bn(r.avg)}%</b><small>${r.status === "weak" ? "রিভিশন দরকার" : r.status === "strong" ? "ভালো" : "মোটামুটি"}</small></li>`).join("")}</ul>`
    : "";

  const tips = suggestions.length
    ? `<h3 class="exs-report-h3">পরামর্শ</h3><ul class="exs-report-tips">${suggestions.map((t) => `<li>${escapeHtml(t.text)}</li>`).join("")}</ul>`
    : "";

  return `
    <section class="exs-report-analysis">
      <h2 class="exs-report-h2">বিশ্লেষণ</h2>
      <div class="exs-report-rows">${rows.join("")}</div>
      ${subjectBlock}
      ${tips}
    </section>`;
}

function reportHtml(attempt, analytics) {
  const s = attempt.student || {};
  const mistakes = normalizeReview(attempt.review);
  const typeLabel = attempt.examType === "practice" ? "Practice" : "Live";
  const generated = formatDateTime(new Date());
  const a = analytics || buildCoreAnalytics(attempt);
  const passed = a.tier.pass.passed;

  return `
    <div class="exs-report-watermark"><img src="${LOGO_SRC}" alt=""></div>

    <header class="exs-report-head">
      <img src="${LOGO_SRC}" alt="TVexam" class="exs-report-logo">
      <div class="exs-report-title">
        <h1>ফলাফল রিপোর্ট</h1>
        <p>${escapeHtml(attempt.examTitle)}</p>
      </div>
    </header>

    <section class="exs-report-meta">
      ${metaRow("শিক্ষার্থী", s.name)}
      ${metaRow("রোল", s.roll)}
      ${metaRow("ইমেইল", s.email)}
      ${metaRow("এক্সাম", attempt.examTitle)}
      ${metaRow("কোর্স", attempt.courseName)}
      ${metaRow("ধরন", typeLabel)}
      ${metaRow("অ্যাটেম্পট", `#${attempt.attemptNumber}`)}
      ${metaRow("জমা দেওয়ার সময়", formatDateTime(new Date(attempt.submittedAtMs || Date.now())))}
    </section>

    <section class="exs-report-summary">
      ${tile("স্কোর", `${formatScore(attempt.score)} / ${attempt.total}`)}
      ${tile("শতকরা", `${attempt.percent}%`, passed ? "is-good" : "is-info")}
      ${tile("সঠিক", String(attempt.correctCount), "is-good")}
      ${tile("ভুল", String(attempt.wrongCount), "is-bad")}
      ${tile("উত্তর দেওয়া হয়নি", String(attempt.unansweredCount), "is-neutral")}
      ${tile("সময় লেগেছে (মি:সে)", formatClockText(attempt.timeTakenSeconds))}
    </section>
    ${attempt.negativeMarking > 0
      ? `<p class="exs-report-note">এই এক্সামে নেগেটিভ মার্কিং সক্রিয় ছিল — প্রতিটি ভুল উত্তরে ${escapeHtml(formatScore(attempt.negativeMarking))} নম্বর কাটা হয়েছে।</p>`
      : ""}

    ${analysisHtml(a)}

    <section class="exs-report-mistakes">
      ${mistakes.length
        ? `<h2 class="exs-report-h2">ভুল করা ও উত্তর না দেওয়া প্রশ্ন (${mistakes.length}টি)</h2>${mistakes.map(mistakeHtml).join("")}`
        : `<p class="exs-report-clear">অভিনন্দন! আপনি সব প্রশ্নের সঠিক উত্তর দিয়েছেন — রিভিউ করার মতো কোনো ভুল নেই।</p>`}
    </section>

    <footer class="exs-report-foot">Tech Verse Exam — স্বয়ংক্রিয়ভাবে তৈরি ফলাফল রিপোর্ট • ${escapeHtml(generated)}</footer>`;
}

/* While a print dialog is open the browser uses <title> as the suggested
   file name, so swap in a meaningful one and put the real title back after. */
function onBeforePrint() {
  if (!mounted) return;
  mounted.prevTitle = document.title;
  document.title = mounted.fileName;
}
function onAfterPrint() {
  if (mounted?.prevTitle != null) { document.title = mounted.prevTitle; mounted.prevTitle = null; }
}

export function mountReport(attempt, analytics = null) {
  unmountReport();
  const el = document.createElement("div");
  el.id = "exs-report";
  el.className = "exs-report";
  el.setAttribute("aria-hidden", "true");
  try {
    el.innerHTML = reportHtml(attempt, analytics);
  } catch (err) {
    // The analysis block is a bonus: if anything in it ever fails, the plain report (summary + mistakes) must still exist.
    console.error("PDF report: the analysis block failed, building the plain report:", err);
    el.innerHTML = reportHtml(attempt, buildCoreAnalytics({ ...attempt, qStats: [] }));
  }
  document.body.appendChild(el);
  document.body.classList.add("exs-has-report");
  mounted = { el, fileName: fileNameFor(attempt), prevTitle: null };
  window.addEventListener("beforeprint", onBeforePrint);
  window.addEventListener("afterprint", onAfterPrint);
}

export function unmountReport() {
  window.removeEventListener("beforeprint", onBeforePrint);
  window.removeEventListener("afterprint", onAfterPrint);
  if (mounted) {
    if (mounted.prevTitle != null) document.title = mounted.prevTitle;
    mounted.el.remove();
    mounted = null;
  }
  document.body.classList.remove("exs-has-report");
}

export function isReportMounted() {
  return !!mounted;
}

/** Opens the print dialog on the report (choose "Save as PDF"). False when there is no report to print. */
export async function printReport() {
  if (!mounted) return false;
  // The logo was preloaded when the report was mounted, but make sure it is
  // decoded before the print snapshot is taken — never a PDF with a hole in it.
  const imgs = Array.from(mounted.el.querySelectorAll("img"));
  const decoded = Promise.all(imgs.map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
  await Promise.race([decoded, new Promise((resolve) => setTimeout(resolve, 1500))]);
  window.print();
  return true;
}
