// ==========================================================================
// exam.js — the exam section's public entry point (SPA route handler).
// URL scheme: #/exam                → exam list (course picker)
//             #/exam?course=xxx     → one course's exams
//             #/exam?id=xxx         → verification → take → result
// ==========================================================================
import { requireAuth, toast, getUserProfile, getExamQuestionCount } from "./utils.js";
import { navigate } from "./router.js";
import { state, resetSessionState, buildQuestionPool, scoreExam } from "./exam-engine.js";
import { fetchQuestions, saveResult } from "./exam-data.js";
import { runVerification, renderRulesGate } from "./exam-guard.js";
import { renderExamCourseList, renderExamCourseHub, renderExamList, renderQuestion, renderAllQuestions, renderResult } from "./exam-render.js";
import { startExamTimer, stopExamTimer, formatClock } from "./exam-timer.js";
import { renderNav } from "./nav.js";

let listView, verifyView, takeView, resultView, refs;

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
    verifyView.innerHTML = `<div class="exs-empty"><p>No Questions Available in This Exam ml</p></div>`;
    return;
  }

  state.exam = exam;
  state.questions = buildQuestionPool(exam, questionBank);
  state.examLayout = exam.layout === "all" ? "all" : "one";
  state.answers = {};
  state.lockedQuestions = new Set();
  state.currentIndex = 0;
  state.secondsLeft = (exam.duration || 10) * 60;

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
    () => { toast("Time Over!We are are Submitted.thank you!", "error"); submitExam(); }
  );

  if (state.examLayout === "all") renderAllQuestions(refs);
  else renderQuestion(refs);
}

async function submitExam() {
  stopExamTimer();
  const exam = state.exam;
  const breakdown = scoreExam(exam);
  const attemptNumber = state.attemptsSoFar + 1;
  const examTitle = exam?.title || document.getElementById("exam-take-title").textContent;

  // Snapshot of exactly what THIS attempt asked and answered — question
  // pools can be randomized per attempt (buildQuestionPool), so the only
  // reliable record of "what did attempt #N actually look like" is captured
  // right now, at submit time. Stored per-attempt (exam-data.js saveResult)
  // so "আমার ফলাফল" can show a question-by-question review for ANY
  // past attempt later, not just the most recent one.
  //
  // Only WRONG (incl. unanswered) questions are kept here — a correctly
  // answered question never needs reviewing, and for a big exam this is
  // what actually keeps things fast: a smaller snapshot means a smaller
  // Firestore write, a smaller doc to fetch on every visit to "আমার
  // ফলাফল", and a review screen that renders only a handful of cards
  // instead of the whole question bank. It also naturally expires — see
  // REVIEW_TTL_MS / isReviewExpired() in exam-data.js — so this review
  // detail is only ever kept around for 48 hours after submission.
  const reviewSnapshot = state.questions
    .filter((q) => {
      const selected = state.answers[q.id] !== undefined ? state.answers[q.id] : null;
      return selected !== q.correctIndex;
    })
    .map((q) => ({
      id: q.id,
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation || "",
      selected: state.answers[q.id] !== undefined ? state.answers[q.id] : null,
    }));

  await saveResult({
    uid: state.currentUser.uid,
    examId: state.examId,
    examTitle,
    examType: exam?.examType === "practice" ? "practice" : "live",
    score: breakdown.score,
    total: state.questions.length,
    percent: breakdown.percent,
    correctCount: breakdown.correctCount,
    wrongCount: breakdown.wrongCount,
    unansweredCount: breakdown.unansweredCount,
    negativeMarking: breakdown.negativeMarking,
    timeTakenSeconds: breakdown.timeTakenSeconds,
    answers: state.answers,
    attemptNumber,
    reviewSnapshot,
  });

  takeView.classList.add("hidden");
  resultView.classList.remove("hidden");
  renderResult(resultView, { score: breakdown.score, total: state.questions.length, percent: breakdown.percent, examTitle, breakdown });
}
