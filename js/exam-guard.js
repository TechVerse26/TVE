// ==========================================================================
// exam-guard.js — the exam section's own entry gate. Not a role check, but
// exam-specific eligibility — visibility (enrollment), publish/close
// window, and attempts left — shown to the student step-by-step. Only
// after every step passes AND the student explicitly accepts the exam
// rules does this resolve "confirmed".
// ==========================================================================
import { escapeHtml, formatDateTime } from "./utils.js";
import { checkExamVisibility, getAttemptsCount, fetchExam, getSiteStatus } from "./exam-data.js";
import { computeStatus, passMarksFor, toMs } from "./schedule-core.js";
import { serverNow } from "./server-time.js";
import { peekHomeFeed } from "./home-data.js";
import { navigate } from "./router.js";
import { state } from "./exam-engine.js";

const STEP_LABELS = [
  { key: "auth", label: "অ্যাকাউন্ট যাচাই" },
  { key: "access", label: "এনরোলমেন্ট যাচাই" },
  { key: "window", label: "এক্সামের সময়সীমা" },
  { key: "attempts", label: "অ্যাটেম্পট সংখ্যা" },
];

function stepRowHtml(key, label, status) {
  const icon = status === "ok" ? '<i class="fa-solid fa-circle-check"></i>'
    : status === "fail" ? '<i class="fa-solid fa-circle-xmark"></i>'
    : '<i class="fa-solid fa-spinner fa-spin"></i>';
  return `<div class="exs-verify-step exs-verify-step--${status}" data-step="${key}">
    <span class="exs-verify-step-icon">${icon}</span>
    <span class="exs-verify-step-label">${label}</span>
  </div>`;
}
function renderStepList(container, statuses) {
  container.innerHTML = `
    <div class="exs-verify-card">
      <div class="exs-verify-head">
        <i class="fa-solid fa-shield-halved"></i>
        <div><h2>অ্যাক্সেস যাচাই হচ্ছে</h2><p>এক্সামে ঢোকার আগে কিছু বিষয় নিশ্চিত করা হচ্ছে</p></div>
      </div>
      <div class="exs-verify-steps">${STEP_LABELS.map((s) => stepRowHtml(s.key, s.label, statuses[s.key] || "pending")).join("")}</div>
    </div>`;
}
function setStep(container, key, status) {
  const row = container.querySelector(`[data-step="${key}"]`);
  if (!row) return;
  row.className = `exs-verify-step exs-verify-step--${status}`;
  row.querySelector(".exs-verify-step-icon").innerHTML =
    status === "ok" ? '<i class="fa-solid fa-circle-check"></i>'
    : status === "fail" ? '<i class="fa-solid fa-circle-xmark"></i>'
    : '<i class="fa-solid fa-spinner fa-spin"></i>';
}
export function failScreen(container, { title, message, backLabel, backHref }) {
  container.innerHTML = `
    <div class="exs-verify-card exs-verify-card--fail">
      <div class="exs-verify-head exs-verify-head--fail">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div>
      </div>
      <a href="${backHref}" class="btn btn-outline btn-block">${escapeHtml(backLabel)}</a>
    </div>`;
}

/**
 * Is this exam closed to the student right now? → { title, message } for the fail screen, or null when they may go in.
 * Judged against the SERVER clock (server-time.js). The schedule applies to everyone (as it always has);
 * "cancelled" and "registration closed" are bypassed for admins so they can still test an exam.
 */
export function windowBlock(exam, isAdminUser = false) {
  const st = computeStatus(exam, serverNow());
  if (st.reason === "upcoming") return { title: "The exam hasn't started yet.", message: `This exam starts on ${formatDateTime(st.startsAt)}.` };
  if (st.reason === "window-closed") return { title: "Exam time is over.", message: `This exam closed on ${formatDateTime(st.endsAt)}.` };
  if (!isAdminUser && st.reason === "cancelled") return { title: "Exam not available.", message: "এই পরীক্ষার সময়সূচি বাতিল করা হয়েছে।" };
  if (!isAdminUser && st.reason === "registration-closed") return { title: "Registration closed.", message: "এই পরীক্ষায় নতুন করে অংশগ্রহণের সুযোগ বন্ধ করা হয়েছে।" };
  return null;
}

/** The student sat on the rules page while the window closed (or the exam was cancelled)? Caught here, at "Start". */
export function recheckWindow(container, exam, isAdminUser) {
  const blocked = windowBlock(exam, isAdminUser);
  if (!blocked) return true;
  failScreen(container, { ...blocked, backLabel: "Go back", backHref: `#/exam?course=${encodeURIComponent(exam.courseId || "general")}` });
  return false;
}

export async function runVerification(container, examId, myToken) {
  const statuses = {};
  renderStepList(container, statuses);

  const isAdminUser = !!state.userProfile?.isAdmin;

  // A deactivated account (Admin → Students) can browse but never start an exam.
  if (state.userProfile?.disabled && !isAdminUser) {
    setStep(container, "auth", "fail");
    failScreen(container, { title: "অ্যাকাউন্ট নিষ্ক্রিয়", message: "আপনার অ্যাকাউন্টটি বর্তমানে নিষ্ক্রিয় করা আছে, তাই এক্সাম শুরু করা যাবে না। বিস্তারিত জানতে অ্যাডমিনের সাথে যোগাযোগ করুন।", backLabel: "সব এক্সাম দেখুন", backHref: "#/exam" });
    return { ok: false };
  }
  setStep(container, "auth", "ok");

  // Maintenance mode (Admin → Settings → General): no new exam starts, except for admins testing the site.
  const site = await getSiteStatus().catch(() => ({ maintenance: false }));
  if (myToken !== state.navToken) return { ok: false };
  if (site.maintenance && !isAdminUser) {
    failScreen(container, { title: "রক্ষণাবেক্ষণ চলছে", message: site.message || "এই মুহূর্তে নতুন এক্সাম শুরু করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।", backLabel: "সব এক্সাম দেখুন", backHref: "#/exam" });
    return { ok: false };
  }

  const exam = await fetchExam(examId);
  if (myToken !== state.navToken) return { ok: false };
  // Draft exams are invisible to students (admins can still open one to preview it).
  if (exam && exam.status === "draft" && !isAdminUser) {
    failScreen(container, { title: "এক্সাম পাওয়া যায়নি", message: "এই এক্সামটি সরিয়ে ফেলা হয়েছে, অথবা লিংকটি সঠিক নয়।", backLabel: "সব এক্সাম দেখুন", backHref: "#/exam" });
    return { ok: false };
  }
  if (!exam) {
    failScreen(container, { title: "এক্সাম পাওয়া যায়নি", message: "এই এক্সামটি সরিয়ে ফেলা হয়েছে, অথবা লিংকটি সঠিক নয়।", backLabel: "সব এক্সাম দেখুন", backHref: "#/exam" });
    return { ok: false };
  }

  // Step 2 — enrollment/visibility. A course-linked exam a student isn't
  // enrolled in behaves exactly like "not found" — no course name or any
  // other detail about it is revealed.
  const { visible } = await checkExamVisibility(exam.courseId, state.userProfile);
  if (myToken !== state.navToken) return { ok: false };
  if (!visible) {
    setStep(container, "access", "fail");
    failScreen(container, { title: "Exam not found.", message: "This exam has been removed, or the link is incorrect.", backLabel: "View all exams", backHref: "#/exam" });
    return { ok: false };
  }
  setStep(container, "access", "ok");

  const courseBackHref = `#/exam?course=${encodeURIComponent(exam.courseId || "general")}`;
  const blocked = windowBlock(exam, isAdminUser);
  if (blocked) {
    setStep(container, "window", "fail");
    failScreen(container, { ...blocked, backLabel: "Go back", backHref: courseBackHref });
    return { ok: false };
  }
  setStep(container, "window", "ok");

  const maxAttempts = Number(exam.maxAttempts || 0);
  let attemptsSoFar = 0;
  if (maxAttempts > 0) {
    attemptsSoFar = await getAttemptsCount(state.currentUser.uid, examId);
    if (myToken !== state.navToken) return { ok: false };
    if (attemptsSoFar >= maxAttempts) {
      setStep(container, "attempts", "fail");
      failScreen(container, { title: "Attempt ended", message: `এই এক্সামে সর্বোচ্চ ${maxAttempts} বার অ্যাটেম্পট দেওয়া যায় — আপনি ইতিমধ্যে সবগুলো ব্যবহার করে ফেলেছেন।`, backLabel: "এই কোর্সের এক্সামে ফিরে যান", backHref: courseBackHref });
      return { ok: false };
    }
  }
  setStep(container, "attempts", "ok");
  state.attemptsSoFar = attemptsSoFar;

  return { ok: true, exam, attemptsSoFar, maxAttempts };
}

export function renderRulesGate(container, exam, { attemptsSoFar, maxAttempts, totalMarks }) {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      window.removeEventListener("hashchange", onNavigateAway);
      resolve(result);
    }
    function onNavigateAway() { finish("away"); }
    window.addEventListener("hashchange", onNavigateAway);

    const passMarks = passMarksFor(exam, peekHomeFeed()?.passPercent || 60);
    const negative = exam.examType === "practice" ? 0 : Math.max(0, Number(exam.negativeMarking) || 0);
    const closesAt = exam.examType === "practice" ? null : toMs(exam.closesAt);
    const negativeLine = negative > 0 ? `<li><b>নেগেটিভ মার্কিং আছে:</b> প্রতিটি ভুল উত্তরে ${negative} নম্বর কাটা যাবে।</li>` : "";
    const closesLine = closesAt ? `<li>এই এক্সাম শুরু করার শেষ সময়: <b>${escapeHtml(formatDateTime(closesAt))}</b>।</li>` : "";
    const attemptLine = maxAttempts > 0
      ? `<li>এটি হবে <b>${maxAttempts}</b> টির মধ্যে <b>${attemptsSoFar + 1}</b> নম্বর অ্যাটেম্পট।</li>` : "";

    container.innerHTML = `
      <div class="exs-verify-card exs-rules-card">
        <div class="exs-verify-head exs-verify-head--ok">
          <i class="fa-solid fa-clipboard-check"></i>
          <div><h2>${escapeHtml(exam.title)}</h2><p>অ্যাক্সেস নিশ্চিত হয়েছে — শুরু করার আগে নিয়মগুলো পড়ে নিন</p></div>
        </div>
        <div class="exs-rules-stats">
          <div class="exs-rules-stat"><span>সময়সীমা</span><b>${exam.duration || 10} মিনিট</b></div>
          <div class="exs-rules-stat"><span>মোট নম্বর</span><b>${totalMarks}</b></div>
          <div class="exs-rules-stat"><span>পাস নম্বর</span><b>${passMarks}</b></div>
        </div>
        <ul class="exs-rules-list">
          <li>একবার এক্সাম শুরু হলে টাইমার থামবে না — শুরু করার আগে প্রস্তুত থাকুন।</li>
          <li>"Start" চাপার সাথে সাথেই ${exam.duration || 10} মিনিটের টাইমার শুরু হয়ে যাবে।</li>
          <li>প্রশ্ন যেকোনো ক্রমে দেখা যাবে, তবে উত্তর সিলেক্ট করার সাথে সাথেই সেটা লক হয়ে যাবে — পরে বদলানো যাবে না।</li>
          <li>এক্সাম চলাকালীন পেজ রিফ্রেশ বা বন্ধ করবেন না — অগ্রগতি শুধু এই সেশনের জন্যই সংরক্ষিত থাকে।</li>
          <li>সময় শেষ হয়ে গেলে যা উত্তর দেওয়া হয়েছে তা স্বয়ংক্রিয়ভাবে জমা হয়ে যাবে।</li>
          ${negativeLine}
          ${closesLine}
          ${attemptLine}
          ${exam.instructions ? `<li><b>নির্দেশনা:</b> ${escapeHtml(String(exam.instructions)).replace(/\n/g, "<br>")}</li>` : ""}
        </ul>
        <div class="exs-rules-actions">
          <a href="#/exam?course=${encodeURIComponent(exam.courseId || "general")}" class="btn btn-outline btn-block">Go back</a>
          <button type="button" class="btn btn-primary btn-block" id="exs-start-confirm">Start<i class="fa-solid fa-arrow-right"></i></button>
        </div>
      </div>`;

    container.querySelector("#exs-start-confirm").addEventListener("click", () => finish("confirmed"));
  });
}
