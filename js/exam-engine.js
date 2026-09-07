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

/* ---------- Scoring: +1 per correct, −negativeMarking per wrong ---------- */
export function scoreExam(exam) {
  const negativeMarking = Math.max(0, Number(exam?.negativeMarking) || 0);
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
