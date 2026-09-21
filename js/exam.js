// ==========================================================================
// exam.js — the exam section's public entry point (SPA route handler).
// URL scheme: #/exam                → exam list (course picker)
//             #/exam?course=xxx     → one course's exams
//             #/exam?id=xxx         → verification → take → result
// ==========================================================================
import { requireAuth, toast, getUserProfile, getExamQuestionCount, confirmAction, closeModal, toBnDigits } from "./utils.js";
import { navigate } from "./router.js";
import { state, resetSessionState, buildQuestionPool, scoreExam } from "./exam-engine.js";
import { fetchQuestions, saveResult } from "./exam-data.js";
import { runVerification, renderRulesGate } from "./exam-guard.js";
import { renderExamCourseList, renderExamCourseHub, renderExamList, renderQuestion, renderAllQuestions, renderResult, updateSaveStatus } from "./exam-render.js";
import { startExamTimer, stopExamTimer, formatClock } from "./exam-timer.js";
import { renderNav } from "./nav.js";
import { mountReport, unmountReport } from "./exam-report.js";

let listView, verifyView, takeView, resultView, refs;

/* ---------- "Are you sure you want to leave?" guard ----------
   Armed while an exam is running (a refresh / closed tab throws the attempt
   away) and again while a finished result has not been stored yet. ---------- */
let unloadGuard = null;
function armUnloadGuard() {
  if (unloadGuard) return;
  unloadGuard = (e) => { e.preventDefault(); e.returnValue = ""; return ""; };
  window.addEventListener("beforeunload", unloadGuard);
}
function disarmUnloadGuard() {
  if (!unloadGuard) return;
  window.removeEventListener("beforeunload", unloadGuard);
  unloadGuard = null;
}

// The attempt whose result is currently on screen. Background saves compare
// against it, so a save that finishes late can never repaint the status chip
// of a NEWER attempt the student has since started and finished.
let currentAttempt = null;

let controlsBound = false;
function bindStaticControlsOnce() {
  if (controlsBound) return;
  controlsBound = true;

  document.getElementById("q-prev")?.addEventListener("click", () => {
    if (state.currentIndex > 0) { state.currentIndex--; renderQuestion(refs); }
  });
  document.getElementById("q-next")?.addEventListener("click", () => {
    if (state.currentIndex < state.questions.length - 1) { state.currentIndex++; renderQuestion(refs); }
  });
  document.getElementById("exam-submit-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitExam();
  });
  document.getElementById("exam-back-btn")?.addEventListener("click", (e) => navigate(e.currentTarget.dataset.href || "#/exam"));
}

export async function initExamPage(params) {
  const myToken = ++state.navToken;
  stopExamTimer();
  unmountReport();      // the PDF report only exists while a result screen is showing
  disarmUnloadGuard();  // whatever was in progress is being replaced
  currentAttempt = null;

  const examId = params.get("id");
  resetSessionState(examId);

  listView = document.getElementById("exam-list-view");
  verifyView = document.getElementById("exam-verify-view");
  takeView = document.getElementById("exam-take-view");
  resultView = document.getElementById("exam-result-view");

  refs = {
    questionArea: document.getElementById("question-area"),
    progressFill: document.getElementById("q-progress-fill"),
    prevBtn: document.getElementById("q-prev"),
    nextBtn: document.getElementById("q-next"),
    submitBtn: document.getElementById("q-submit"),
  };

  listView.classList.remove("hidden");
  verifyView.classList.add("hidden");
  verifyView.innerHTML = "";
  takeView.classList.add("hidden");
  resultView.classList.add("hidden");
  resultView.innerHTML = "";

  bindStaticControlsOnce();
  await renderNav("exam");

  state.currentUser = await requireAuth();
  if (myToken !== state.navToken) return cleanup;
  if (!state.currentUser) return cleanup;
  state.userProfile = await getUserProfile(state.currentUser.uid);
  if (myToken !== state.navToken) return cleanup;

  if (examId) {
    await runExamEntry(examId, myToken);
  } else {
    const grid = document.getElementById("exam-grid");
    const courseKey = params.get("course");
    const bucketKey = params.get("type");
    if (courseKey && bucketKey) await renderExamList(grid, courseKey, bucketKey);
    else if (courseKey) await renderExamCourseHub(grid, courseKey);
    else await renderExamCourseList(grid);
  }

  return cleanup;
  function cleanup() { stopExamTimer(); }
}

async function runExamEntry(examId, myToken) {
  listView.classList.add("hidden");
  verifyView.classList.remove("hidden");

  const verdict = await runVerification(verifyView, examId, myToken);
  if (myToken !== state.navToken) return;
  if (!verdict.ok) return;

  const totalMarks = getExamQuestionCount(verdict.exam);
  const gateResult = await renderRulesGate(verifyView, verdict.exam, {
    attemptsSoFar: verdict.attemptsSoFar, maxAttempts: verdict.maxAttempts, totalMarks,
  });
  if (myToken !== state.navToken) return;
  if (gateResult === "away") return;
  if (gateResult !== "confirmed") { navigate("#/exam"); return; }

  await beginAttempt(verdict.exam, myToken);
}

async function beginAttempt(exam, myToken) {
  const questionBank = await fetchQuestions(state.examId);
  if (myToken !== state.navToken) return;
  if (!questionBank.length) {
    verifyView.innerHTML = `<div class="exs-empty"><p>এই এক্সামে কোনো প্রশ্ন নেই</p></div>`;
    return;
  }

  state.exam = exam;
  state.questions = buildQuestionPool(exam, questionBank);
  state.examLayout = exam.layout === "all" ? "all" : "one";
  state.answers = {};
  state.lockedQuestions = new Set();
  state.currentIndex = 0;
  state.secondsLeft = (exam.duration || 10) * 60;
  state.submitted = false;
  armUnloadGuard();

  verifyView.classList.add("hidden");
  takeView.classList.remove("hidden");
  document.getElementById("exam-take-title").textContent = exam.title;

  const navRow = document.querySelector(".exam-nav-row");
  const progressTrack = document.querySelector(".q-progress-track");
  if (state.examLayout === "all") {
    refs.prevBtn.classList.add("hidden");
    refs.nextBtn.classList.add("hidden");
    refs.submitBtn.classList.remove("hidden");
    progressTrack.classList.add("hidden");
  } else {
    refs.prevBtn.classList.remove("hidden");
    refs.nextBtn.classList.remove("hidden");
    progressTrack.classList.remove("hidden");
  }
  navRow.classList.remove("hidden");

  const timerEl = document.getElementById("exam-timer");
  startExamTimer(
    (secondsLeft) => {
      timerEl.innerHTML = `<i class="fa-solid fa-stopwatch"></i> ${formatClock(secondsLeft)}`;
      timerEl.classList.toggle("low", secondsLeft <= 60);
    },
    () => { toast("সময় শেষ! আপনার উত্তর জমা দেওয়া হচ্ছে...", "error"); submitExam({ auto: true }); }
  );

  if (state.examLayout === "all") renderAllQuestions(refs);
  else renderQuestion(refs);
}

/* ---------- Submit ----------
   Order matters here and is the heart of the "never lose a student's result"
   design:
     1. lock (state.submitted flips synchronously → a double click, or the
        timer expiring at the same instant, can only ever submit once)
     2. score + build an immutable snapshot of the attempt
     3. SHOW the result immediately (with the mistakes + PDF button)
     4. save to Firestore in the background, with retries and a visible
        status — a slow or failed save can no longer leave the student
        staring at a frozen exam screen with no result, which is what
        happened when saveResult() was awaited before anything was drawn. ---------- */
async function submitExam({ auto = false } = {}) {
  if (state.submitted || !state.exam || !state.questions.length) return;

  // Manual submit with unanswered questions → one quick "are you sure".
  // (When the time runs out there is nothing to ask — it just submits.)
  if (!auto) {
    const unanswered = state.questions.reduce((n, q) => n + (state.answers[q.id] === undefined ? 1 : 0), 0);
    if (unanswered > 0) {
      const ok = await confirmAction(
        `${toBnDigits(unanswered)}টি প্রশ্নের উত্তর দেওয়া হয়নি। এখন জমা দিলে সেগুলো "উত্তর দেওয়া হয়নি" ধরা হবে এবং পরে আর বদলানো যাবে না।`,
        { title: "জমা দিতে চান?", confirmLabel: "হ্যাঁ, জমা দিন", cancelLabel: "ফিরে যাই" }
      );
      if (!ok) return;
      if (state.submitted) return; // time ran out while the dialog was open — already submitted
    }
  }

  state.submitted = true;
  stopExamTimer();
  closeModal();

  const attempt = buildAttemptSnapshot(state.exam, scoreExam(state.exam));
  currentAttempt = attempt;

  takeView.classList.add("hidden");
  resultView.classList.remove("hidden");

  // Drawing the result (and the PDF report) must never be able to stop the save
  // below — whatever goes wrong on screen, the attempt still gets stored and is
  // still viewable in My Activity.
  try {
    renderResult(resultView, attempt, { onRetrySave: () => persistAttempt(attempt) });

    // If the student wandered off to another page while the clock ran out, the
    // attempt is still submitted and saved below — but there is no result screen
    // in front of them, so no PDF report is mounted (it must never be printable
    // from some other page).
    const resultScreenVisible = !document.getElementById("page-exam")?.classList.contains("hidden");
    if (resultScreenVisible) {
      mountReport(attempt);
      window.scrollTo(0, 0);
      // Drop the "leave site?" prompt if the student navigates inside the app
      // (that result screen is gone then).
      window.addEventListener("hashchange", disarmUnloadGuard, { once: true });
    }
  } catch (err) {
    console.error("Could not draw the result screen:", err);
  }

  // Keep the "leave site?" prompt until the result is safely stored.
  armUnloadGuard();

  await persistAttempt(attempt);
}

/* Snapshot of exactly what THIS attempt asked and answered. Question pools can
   be randomized per attempt (buildQuestionPool), so the only reliable record
   of "what did attempt #N actually look like" is captured right now, at submit
   time. It feeds the result screen, the PDF report AND the saved review shown
   later in My Activity — one source, so all three always agree.

   Only WRONG (incl. unanswered) questions are kept in `review` — a correctly
   answered question never needs reviewing, and for a big exam this is what
   keeps the Firestore write and the review screen small. `n` remembers each
   question's original position so the numbering stays the same everywhere.
   The saved review naturally expires (REVIEW_TTL_MS / isReviewExpired() in
   exam-data.js) 48 hours after submission. */
function buildAttemptSnapshot(exam, breakdown) {
  const user = state.currentUser || {};
  const profile = state.userProfile || {};
  const review = [];
  state.questions.forEach((q, i) => {
    const selected = state.answers[q.id] !== undefined ? state.answers[q.id] : null;
    if (selected === q.correctIndex) return;
    review.push({
      id: q.id,
      n: i + 1,
      text: q.text,
      options: q.options.slice(),
      correctIndex: q.correctIndex,
      explanation: q.explanation || "",
      selected,
    });
  });

  return {
    attemptId: makeAttemptId(),
    uid: user.uid,
    examId: state.examId,
    examTitle: exam?.title || document.getElementById("exam-take-title").textContent,
    examType: exam?.examType === "practice" ? "practice" : "live",
    courseId: exam?.courseId || "",
    courseName: exam?.courseName || "",
    maxAttempts: Number(exam?.maxAttempts) || 0,
    score: breakdown.score,
    total: state.questions.length,
    percent: breakdown.percent,
    correctCount: breakdown.correctCount,
    wrongCount: breakdown.wrongCount,
    unansweredCount: breakdown.unansweredCount,
    negativeMarking: breakdown.negativeMarking,
    timeTakenSeconds: breakdown.timeTakenSeconds,
    attemptNumber: state.attemptsSoFar + 1,
    submittedAtMs: Date.now(),
    student: {
      name: profile.displayName || user.displayName || "",
      email: user.email || profile.email || "",
      roll: profile.roll || "",
    },
    answers: { ...state.answers },
    review,
    saveState: "saving", // "saving" | "saved" | "failed" | "blocked"
    saving: false,
  };
}

function makeAttemptId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ---------- Background save with retries ---------- */
const SAVE_TRIES = 3;
const SAVE_TIMEOUT_MS = 25000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("save timed out"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Retrying these can't help; anything else (network blip, timeout…) is worth another go.
function isPermanentSaveError(err) {
  return err?.code === "attempts-exhausted" || err?.code === "permission-denied";
}

function paintSaveStatus(attempt) {
  if (currentAttempt === attempt) updateSaveStatus(resultView, attempt);
}

function saveResultPayload(attempt) {
  return {
    uid: attempt.uid,
    examId: attempt.examId,
    examTitle: attempt.examTitle,
    examType: attempt.examType,
    score: attempt.score,
    total: attempt.total,
    percent: attempt.percent,
    correctCount: attempt.correctCount,
    wrongCount: attempt.wrongCount,
    unansweredCount: attempt.unansweredCount,
    negativeMarking: attempt.negativeMarking,
    timeTakenSeconds: attempt.timeTakenSeconds,
    answers: attempt.answers,
    attemptId: attempt.attemptId, // makes a retry idempotent (see saveResult)
    maxAttempts: attempt.maxAttempts,
    reviewSnapshot: attempt.review,
  };
}

async function persistAttempt(attempt) {
  if (attempt.saving) return false;
  if (attempt.saveState === "saved") return true;
  attempt.saving = true;
  attempt.saveState = "saving";
  paintSaveStatus(attempt);

  let lastError = null;
  for (let i = 1; i <= SAVE_TRIES; i++) {
    try {
      const saved = await withTimeout(saveResult(saveResultPayload(attempt)), SAVE_TIMEOUT_MS);
      attempt.saving = false;
      attempt.saveState = "saved";
      // If the stored attempt number differs from the one we guessed at the
      // start (e.g. another tab finished an attempt meanwhile), fix the PDF too.
      if (saved?.attemptNumber && saved.attemptNumber !== attempt.attemptNumber) {
        attempt.attemptNumber = saved.attemptNumber;
        if (currentAttempt === attempt) mountReport(attempt);
      }
      paintSaveStatus(attempt);
      if (currentAttempt === attempt) disarmUnloadGuard();
      return true;
    } catch (err) {
      lastError = err;
      if (isPermanentSaveError(err)) break;
      if (i < SAVE_TRIES) await wait(800 * i);
    }
  }

  console.error("Could not save the exam result:", lastError);
  attempt.saving = false;
  attempt.saveState = lastError?.code === "attempts-exhausted" ? "blocked" : "failed";
  paintSaveStatus(attempt);
  if (attempt.saveState === "blocked") {
    if (currentAttempt === attempt) disarmUnloadGuard();
  } else {
    retryWhenBackOnline(attempt);
  }
  return false;
}

// Offline when the exam ended? Try again by itself as soon as the connection is back.
function retryWhenBackOnline(attempt) {
  const onOnline = () => {
    window.removeEventListener("online", onOnline);
    if (currentAttempt === attempt && attempt.saveState === "failed") persistAttempt(attempt);
  };
  window.addEventListener("online", onOnline);
}
