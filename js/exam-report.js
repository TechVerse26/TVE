// ==========================================================================
// exam-report.js — the student's downloadable PDF result report.
//
// Exists ONLY while the result screen that follows an exam is showing:
//   mountReport(attempt)  — called when the result screen is drawn
//   unmountReport()       — called the moment the student leaves it
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
// ==========================================================================
import { escapeHtml, formatScore, formatDuration, formatDateTime } from "./utils.js";
import { normalizeReview } from "./exam-review.js";

const LOGO_SRC = "assets/logo.svg";

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

function reportHtml(attempt) {
  const s = attempt.student || {};
  const mistakes = normalizeReview(attempt.review);
  const typeLabel = attempt.examType === "practice" ? "Practice" : "Live";
  const generated = formatDateTime(new Date());

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
      ${tile("শতকরা", `${attempt.percent}%`, attempt.percent >= 60 ? "is-good" : "is-bad")}
      ${tile("সঠিক", String(attempt.correctCount), "is-good")}
      ${tile("ভুল", String(attempt.wrongCount), "is-bad")}
      ${tile("উত্তর দেওয়া হয়নি", String(attempt.unansweredCount), "is-warn")}
      ${tile("সময় লেগেছে", formatDuration(attempt.timeTakenSeconds))}
    </section>
    ${attempt.negativeMarking > 0
      ? `<p class="exs-report-note">এই এক্সামে নেগেটিভ মার্কিং সক্রিয় ছিল — প্রতিটি ভুল উত্তরে ${escapeHtml(formatScore(attempt.negativeMarking))} নম্বর কাটা হয়েছে।</p>`
      : ""}

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

export function mountReport(attempt) {
  unmountReport();
  const el = document.createElement("div");
  el.id = "exs-report";
  el.className = "exs-report";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = reportHtml(attempt);
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
