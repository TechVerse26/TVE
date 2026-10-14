// ==========================================================================
// exam-engine.js — the single shared state object for one exam-taking
// session, plus pure logic around it (shuffling, scoring).
// ==========================================================================
export const state = {
  navToken: 0,
  currentUser: null,
  userProfile: null,
  examId: null,
  exam: null,
  questions: [],
  currentIndex: 0,
  answers: {},
  lockedQuestions: new Set(),
  secondsLeft: 0,
  examLayout: "one",
  attemptsSoFar: 0,
  submitted: false, // flips to true (synchronously) the moment the final submit starts — blocks double submits
  submitting: false, // true from the instant a MANUAL submit is requested until it is confirmed or cancelled
};

export function resetSessionState(examId) {
  state.examId = examId;
  state.exam = null;
  state.questions = [];
  state.currentIndex = 0;
  state.answers = {};
  state.lockedQuestions = new Set();
  state.secondsLeft = 0;
  state.examLayout = "one";
  state.attemptsSoFar = 0;
  state.submitted = false;
  state.submitting = false;
  resetQuestionClock();
}

/* ---------- Per-question screen time ----------
   Feeds the result's time analysis ONLY — it never touches scoring, saving or the timer. Recorded for the
   one-question-at-a-time layout; with "all questions on one page" nothing is tracked (and the result says so).
   Time while the tab is hidden is not counted (a phone call or an app switch is not "thinking time"). */
const qClock = { id: null, since: null, times: {} }; // since === null → not running right now
const clockNow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const tabHidden = () => typeof document !== "undefined" && document.hidden === true;

function flushQuestionClock() {
  if (qClock.id !== null && qClock.since !== null) {
    qClock.times[qClock.id] = (qClock.times[qClock.id] || 0) + Math.max(0, clockNow() - qClock.since) / 1000;
  }
  qClock.since = null;
}

export function resetQuestionClock() {
  qClock.id = null;
  qClock.since = null;
  qClock.times = {};
}

/** Call whenever a question is put on screen. Re-drawing the same question (after an answer) keeps its clock running. */
export function markQuestionShown(id) {
  if (id === qClock.id) {
    if (qClock.since === null && !tabHidden()) qClock.since = clockNow();
    return;
  }
  flushQuestionClock();
  qClock.id = id;
  qClock.since = tabHidden() ? null : clockNow();
}

/** Stops timing (submit) and returns { [questionId]: seconds }. */
export function stopQuestionClock() {
  flushQuestionClock();
  qClock.id = null;
  return { ...qClock.times };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushQuestionClock();
    else if (qClock.id !== null && qClock.since === null) qClock.since = clockNow();
  });
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- Builds the actual question set for this attempt ---------- */
export function buildQuestionPool(exam, questionBank) {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  let pool = perAttempt > 0 && perAttempt < questionBank.length
    ? shuffleArray(questionBank).slice(0, perAttempt)
    : questionBank.slice();

  if (exam.shuffle !== false) {
    pool = shuffleArray(pool).map((q) => {
      const optionOrder = shuffleArray(q.options.map((_, i) => i));
      return {
        ...q,
        options: optionOrder.map((oi) => q.options[oi]),
        correctIndex: optionOrder.indexOf(q.correctIndex),
      };
    });
  }
  return pool;
}

/* ---------- Scoring: +1 per correct, −negativeMarking per wrong ----------
   Practice exams are risk-free by design — negative marking never applies
   during practice, no matter what's set on the exam, so retrying doesn't
   punish a wrong guess the way a real Live exam does. ---------- */
export function scoreExam(exam) {
  const negativeMarking = exam?.examType === "practice" ? 0 : Math.max(0, Number(exam?.negativeMarking) || 0);
  let correctCount = 0;
  let wrongCount = 0;
  state.questions.forEach((q) => {
    if (state.answers[q.id] === undefined) return;
    if (state.answers[q.id] === q.correctIndex) correctCount++;
    else wrongCount++;
  });
  const unansweredCount = state.questions.length - correctCount - wrongCount;
  const rawScore = correctCount - wrongCount * negativeMarking;
  const score = Math.round(rawScore * 100) / 100;
  const percent = Math.max(0, Math.min(100, Math.round((rawScore / state.questions.length) * 100)));

  const totalSeconds = (exam?.duration || 10) * 60;
  const timeTakenSeconds = Math.max(0, Math.min(totalSeconds, totalSeconds - state.secondsLeft));

  return { correctCount, wrongCount, unansweredCount, negativeMarking, score, percent, timeTakenSeconds };
}
