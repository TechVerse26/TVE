// ==========================================================================
// exam.js — the exam section's public entry point (SPA route handler).
// URL scheme: #/exam                → exam list (course picker)
//             #/exam?course=xxx     → one course's exams
//             #/exam?id=xxx         → verification → take → result
// ==========================================================================
import { requireAuth, toast, getUserProfile, getExamQuestionCount, confirmAction, closeModal, toBnDigits } from "./utils.js";
import { navigate } from "./router.js";
import { state, resetSessionState, buildQuestionPool, scoreExam, stopQuestionClock } from "./exam-engine.js";
import { fetchQuestions, saveResult, recordExamStart, fetchUserStats, getExamCatalog } from "./exam-data.js";
import { runVerification, renderRulesGate, recheckWindow, failScreen } from "./exam-guard.js";
import { renderExamCourseList, renderExamCourseHub, renderExamList, renderQuestion, renderAllQuestions, renderResult, updateSaveStatus, renderExamLoading, disposeResult } from "./exam-render.js";
import { startExamTimer, stopExamTimer, formatClock } from "./exam-timer.js";
import { renderNav } from "./nav.js";
import { mountReport, unmountReport, isReportMounted } from "./exam-report.js";
import { getHomeFeed, peekHomeFeed } from "./home-data.js";
import { passPercentFor } from "./schedule-core.js";
import { entryFromAttempt, pickPrevious } from "./exam-analytics.js";

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

/* What the student's history looked like BEFORE this attempt: their results summary, the exam list's subjects, the
   subject names and the site pass mark. Fetched in the background when the exam starts — all three are normally
   already cached by the exam list, so this is usually 0 extra reads — and used ONLY by the result screen's
   comparison / subject analytics. Taken at the START on purpose: the summary cache can expire during a long exam,
   and by the time of the result it must not already contain this attempt (it would be compared with itself). */
let attemptCtx = null;        // the captured context, once it has arrived
let attemptCtxPromise = null; // …and the capture that is still running

/* The last attempt finished in THIS browser session, per exam (summary-shaped). A quick retake can then be compared
   with it even if the stored summary has not caught up yet (its save is still pending, or it failed). */
const sessionAttempts = new Map(); // examId → summary-shaped entry

/** Never lets a slow lookup hold the result screen hostage: resolves null after `ms`. */
const withCap = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null);

async function captureAttemptContext(examId) {
  const uid = state.currentUser?.uid;
  const sessionEntry = sessionAttempts.get(examId) || null; // read NOW — before this attempt can be remembered
  const [stats, feed, catalog] = await Promise.all([
    uid ? fetchUserStats(uid).catch(() => null) : null,
    getHomeFeed().catch(() => null),
    getExamCatalog().catch(() => null),
  ]);
  // A copy: the live summary is updated (in memory) the moment this attempt is saved.
  const entries = stats?.exams ? Object.fromEntries(Object.entries(stats.exams).map(([id, e]) => [id, { ...e }])) : null;
  const examsById = {};
  (catalog?.exams || []).forEach((e) => { examsById[e.id] = { subjectId: e.subjectId || "" }; });
  return {
    statsOk: !!entries,
    entries: entries || {},
    sessionEntry,
    examsById,
    taxonomy: feed?.taxonomy || null,
    defaultPass: feed?.passPercent || 60,
  };
}

/** For the result screen: the context captured when the exam started; if that did not work out, one fresh try. Never longer than ~5 s. */
function loadAttemptContext(examId) {
  return withCap((async () => {
    if (attemptCtx) return attemptCtx;
    const early = attemptCtxPromise ? await attemptCtxPromise : null;
    return early || captureAttemptContext(examId);
  })(), 5000);
}

/** Keep this attempt as "the previous one" for a quick retake in the same session (see sessionAttempts). */
function rememberSessionAttempt(attempt, ctx) {
  const prev = ctx
    ? pickPrevious(ctx.entries?.[attempt.examId], ctx.sessionEntry)
    : sessionAttempts.get(attempt.examId) || null;
  sessionAttempts.set(attempt.examId, entryFromAttempt(attempt, prev));
}

// The latest analytics shown on the result screen — the PDF report prints exactly the same numbers and words.
let currentAnalytics = null;

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
  disposeResult();      // a previous result screen's timers / animation frames stop here
  document.body.classList.remove("exam-taking");
  currentAttempt = null;
  attemptCtx = null;
  attemptCtxPromise = null;
  currentAnalytics = null;

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
  await renderNav(params?.get?.("id") ? "exams" : "courses");

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
  function cleanup() { stopExamTimer(); document.body.classList.remove("exam-taking"); }
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

  // The window may have closed (or the exam been cancelled) while the student was reading the rules.
  if (!recheckWindow(verifyView, verdict.exam, !!state.userProfile?.isAdmin)) return;

  await beginAttempt(verdict.exam, myToken);
}

async function beginAttempt(exam, myToken) {
  // fetchQuestions() below is a single Firestore read (the whole question bank is one
  // bundle document, and it is cached for a retake) with no progress of its
  // own to report — renderExamLoading() gives the student an immediate, honest
  // "it's working" cue instead of a frozen rules card. wait(600) is just a
  // floor so the animation can never flash by half-finished on a fast
  // connection; on a slow one it costs nothing (Promise.all takes the longer
  // of the two).
  const loading = renderExamLoading(verifyView, exam);
  let questionBank;
  try {
    [questionBank] = await Promise.all([fetchQuestions(state.examId, exam), wait(600)]);
    loading.finish(true);
  } catch (err) {
    loading.finish(false);
    if (myToken !== state.navToken) return;
    // permission-denied = the server itself says the exam is not open right now (firestore.rules checks the exam window).
    const closed = err?.code === "permission-denied";
    failScreen(verifyView, {
      title: closed ? "Exam not available." : "প্রশ্ন লোড করা যায়নি।",
      message: closed
        ? "এই মুহূর্তে এক্সামটি খোলা নেই — সময় শেষ হয়ে গেছে, বন্ধ করা হয়েছে অথবা এখনো শুরু হয়নি।"
        : "ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
      backLabel: "সব এক্সাম দেখুন", backHref: "#/exam",
    });
    return;
  }
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
  state.submitting = false;
  // The student's history as it is RIGHT NOW (before this attempt) — fetched quietly while they answer.
  attemptCtx = null;
  attemptCtxPromise = captureAttemptContext(state.examId)
    .then((ctx) => { if (myToken === state.navToken) attemptCtx = ctx; return ctx; })
    .catch(() => null);
  armUnloadGuard();
  recordExamStart(state.currentUser?.uid, state.examId); // one tiny write per start (admin analytics: abandoned attempts)
  document.body.classList.add("exam-taking");             // hides the phone bottom bar so nothing is tapped by accident

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
        timer expiring at the same instant, can only ever submit once; while
        the "unanswered questions" dialog is open state.submitting makes an
        extra tap on Submit do nothing — the timer's auto-submit is never
        blocked by it)
     2. score + build an immutable snapshot of the attempt
     3. SHOW the result immediately (the submit animation, the stat cards, the
        mistakes + PDF button) — the animation is only decoration on top of an
        already-complete screen and never waits for, or delays, anything below
     4. save to Firestore in the background, with retries and a visible
        status — a slow or failed save can no longer leave the student
        staring at a frozen exam screen with no result, which is what
        happened when saveResult() was awaited before anything was drawn. ---------- */
async function submitExam({ auto = false } = {}) {
  if (state.submitted || !state.exam || !state.questions.length) return;
  if (!auto && state.submitting) return; // the confirm dialog of an earlier tap is still open

  // Manual submit with unanswered questions → one quick "are you sure".
  // (When the time runs out there is nothing to ask — it just submits.)
  if (!auto) {
    const unanswered = state.questions.reduce((n, q) => n + (state.answers[q.id] === undefined ? 1 : 0), 0);
    if (unanswered > 0) {
      state.submitting = true;
      let ok = false;
      try {
        ok = await confirmAction(
          `${toBnDigits(unanswered)}টি প্রশ্নের উত্তর দেওয়া হয়নি। এখন জমা দিলে সেগুলো "উত্তর দেওয়া হয়নি" ধরা হবে এবং পরে আর বদলানো যাবে না।`,
          { title: "জমা দিতে চান?", confirmLabel: "হ্যাঁ, জমা দিন", cancelLabel: "ফিরে যাই" }
        );
      } finally {
        state.submitting = false;
      }
      if (!ok) return;
      if (state.submitted) return; // time ran out while the dialog was open — already submitted
    }
  }

  state.submitted = true;
  document.body.classList.remove("exam-taking");
  stopExamTimer();
  closeModal();
  const questionTimes = stopQuestionClock(); // per-question screen time (result analytics only)

  const attempt = buildAttemptSnapshot(state.exam, scoreExam(state.exam), { auto, questionTimes });
  currentAttempt = attempt;
  currentAnalytics = null;

  // History for the comparison / subject analytics: started NOW so it reads "the previous result" before this attempt
  // is remembered below, and so a slow lookup can only ever delay those two cards — never the score.
  const contextPromise = loadAttemptContext(attempt.examId);
  contextPromise.then((ctx) => rememberSessionAttempt(attempt, ctx), () => rememberSessionAttempt(attempt, null));

  takeView.classList.add("hidden");
  resultView.classList.remove("hidden");

  // Drawing the result (and the PDF report) must never be able to stop the save
  // below — whatever goes wrong on screen, the attempt still gets stored and is
  // still viewable in My Results.
  try {
    const view = renderResult(resultView, attempt, {
      onRetrySave: () => persistAttempt(attempt),
      loadContext: () => contextPromise,
      // The comparison / subject sections arrived: the PDF report gets the same finished analysis.
      onAnalytics: (analytics) => {
        if (currentAttempt !== attempt) return;
        currentAnalytics = analytics;
        if (isReportMounted()) mountReport(attempt, analytics);
      },
    });
    currentAnalytics = view?.analytics?.() || null;

    // If the student wandered off to another page while the clock ran out, the
    // attempt is still submitted and saved below — but there is no result screen
    // in front of them, so no PDF report is mounted (it must never be printable
    // from some other page).
    const resultScreenVisible = !document.getElementById("page-exam")?.classList.contains("hidden");
    if (resultScreenVisible) {
      mountReport(attempt, currentAnalytics);
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
   later in My Results — one source, so all three always agree.

   Only WRONG (incl. unanswered) questions are kept in `review` — a correctly
   answered question never needs reviewing, and for a big exam this is what
   keeps the Firestore write and the review screen small. `n` remembers each
   question's original position so the numbering stays the same everywhere.
   The saved review naturally expires (REVIEW_TTL_MS / isReviewExpired() in
   exam-data.js) 48 hours after submission.

   The fields after `saving` exist for the result screen only (analytics, PDF) and are NOT part of what gets saved
   (see saveResultPayload, which lists its fields one by one). */
function buildAttemptSnapshot(exam, breakdown, { auto = false, questionTimes = {} } = {}) {
  const user = state.currentUser || {};
  const profile = state.userProfile || {};
  const review = [];
  const qStats = [];
  const timed = state.examLayout === "one"; // only this layout shows one question at a time, so only it can be timed
  state.questions.forEach((q, i) => {
    const selected = state.answers[q.id] !== undefined ? state.answers[q.id] : null;
    if (timed) qStats.push({ n: i + 1, sec: Math.round(questionTimes[q.id] || 0), status: selected === null ? "skipped" : selected === q.correctIndex ? "correct" : "wrong" });
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
    // ---- result screen only ----
    auto: !!auto,                                              // submitted by the timer, not by the student
    layout: state.examLayout,                                  // "one" | "all"
    durationSeconds: (exam?.duration || 10) * 60,              // the time limit (same figure scoreExam uses)
    passPercent: passPercentFor(exam, peekHomeFeed()?.passPercent || 60), // the exam's pass line, else the site default
    subjectId: exam?.subjectId || "",
    qStats,                                                    // [{ n, sec, status }] — [] when not timed
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
        // Only while the result screen is still showing: leaving it unmounted the report, and it must not come back on another page.
        if (currentAttempt === attempt && isReportMounted()) mountReport(attempt, currentAnalytics);
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
