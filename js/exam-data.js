// ==========================================================================
// exam-data.js — every Firestore read/write the exam section needs.
// Same collections TVcourse already uses (exams, courses, users, results) —
// no new Firebase project and no Firestore rules changes required.
// ==========================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, query, where, orderBy,
  setDoc, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export async function fetchAllExams() {
  // No orderBy() on purpose — Firestore silently drops a doc missing the
  // sorted field, which would make an exam saved without createdAt vanish.
  const snap = await getDocs(collection(db, "exams"));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

export async function fetchExam(examId) {
  const snap = await getDoc(doc(db, "exams", examId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function fetchQuestions(examId) {
  const snap = await getDocs(query(collection(db, "exams", examId, "questions"), orderBy("order", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function fetchResult(uid, examId) {
  try {
    const snap = await getDoc(doc(db, "results", `${uid}_${examId}`));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

/* ---------- Every result belonging to the current user (My Results page) ----------
   Query filtered by uid == request.auth.uid, matching the existing Firestore
   rule exactly — a signed-in user can list only their own result documents. */
export async function fetchMyResults(uid) {
  const snap = await getDocs(query(collection(db, "results"), where("uid", "==", uid)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
}

const attemptsCache = {};
export async function getAttemptsCount(uid, examId) {
  if (attemptsCache[examId] !== undefined) return attemptsCache[examId];
  const result = await fetchResult(uid, examId);
  const count = Number(result?.attemptNumber || 0);
  attemptsCache[examId] = count;
  return count;
}
export function bumpAttemptsCache(examId, attemptNumber) {
  attemptsCache[examId] = attemptNumber;
}

/* ---------- Course info + whether THIS exam should even be visible ----------
   Rule (per product decision): if an exam is tied to a course (exam.courseId),
   it only shows up for students enrolled in that course — free or paid makes
   no difference, unenrolled means invisible, not just "locked". Exams with no
   courseId at all are open to every signed-in student. ---------- */
const courseInfoCache = {};
export async function checkExamVisibility(courseId, userProfile) {
  if (!courseId) return { visible: true, title: "", coverImage: "" };
  let info = courseInfoCache[courseId];
  if (!info) {
    try {
      const courseSnap = await getDoc(doc(db, "courses", courseId));
      info = courseSnap.exists()
        ? { title: courseSnap.data().title || "", coverImage: courseSnap.data().coverImage || "" }
        : { title: "", coverImage: "" };
    } catch {
      info = { title: "", coverImage: "" };
    }
    courseInfoCache[courseId] = info;
  }
  const enrolled = !!userProfile?.enrolledCourses?.includes(courseId);
  return { visible: enrolled, title: info.title, coverImage: info.coverImage };
}

export async function fetchAllCourses() {
  const snap = await getDocs(collection(db, "courses"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ---------- Every exam (live AND practice) keeps a capped history of every
   attempt ---------- Stored as an array field on the same
   results/{uid}_{examId} doc — no new collection and no Firestore rules
   changes needed. Capped at 30 so the document can't grow without bound.
   (Previously this only ran for practice exams, which meant a live exam
   retaken across several sittings had no attempt-by-attempt record — only
   the latest score survived. That's the root cause behind "My Results"
   only ever being able to chart practice exams: live results simply never
   carried the history to chart. Tracking history for both fixes it at the
   source instead of papering over it in the UI.) ---------- */
const RESULT_HISTORY_CAP = 30;
// A big exam (hundreds of questions) retaken many times could make full
// question-snapshot detail alone approach Firestore's 1MB document limit
// long before RESULT_HISTORY_CAP is reached. Score/date history is cheap
// and kept for all RESULT_HISTORY_CAP attempts either way, but the heavier
// question-by-question review is only kept for the most recent attempts —
// older ones fall back to the "no detailed review saved" lock state the UI
// already handles gracefully (see page-results.js reviewQuestionHtml).
const REVIEW_DETAIL_CAP = 10;

export async function saveResult(payload) {
  // reviewSnapshot only belongs inside this one attempt entry — pulling it
  // out of `rest` keeps it from also being duplicated at the top level of
  // the doc (which would double its storage cost for no reason, since the
  // top-level fields only ever need to reflect the LATEST attempt).
  const { reviewSnapshot, ...rest } = payload;
  const ref = doc(db, "results", `${payload.uid}_${payload.examId}`);
  let prevAttempts = [];
  try {
    const prevSnap = await getDoc(ref);
    prevAttempts = prevSnap.exists() ? (prevSnap.data().attempts || []) : [];
  } catch {
    prevAttempts = [];
  }
  let attempts = [...prevAttempts, {
    score: payload.score, total: payload.total, percent: payload.percent,
    correctCount: payload.correctCount, wrongCount: payload.wrongCount,
    unansweredCount: payload.unansweredCount, timeTakenSeconds: payload.timeTakenSeconds,
    submittedAt: Timestamp.now(),
    review: reviewSnapshot || null,
  }];
  if (attempts.length > RESULT_HISTORY_CAP) attempts = attempts.slice(attempts.length - RESULT_HISTORY_CAP);
  attempts = attempts.map((a, i) =>
    i < attempts.length - REVIEW_DETAIL_CAP ? { ...a, review: null } : a
  );

  await setDoc(ref, {
    ...rest,
    attempts,
    submittedAt: serverTimestamp(),
  });
  bumpAttemptsCache(payload.examId, payload.attemptNumber);
}

/* ---------- Anonymous percentile stats for the student-facing "my rank" card ----------
   Listing every result document (fetchAllResultsAdmin) is admin-gated by
   Firestore rules on purpose — a live exam's questions/answers are inside
   those docs (see reviewSnapshot above), so letting any signed-in student
   list the whole `results` collection would leak every other student's
   answers and every exam's question bank, not just scores.

   So a student's own rank is built from two pieces instead:
   1) Their OWN average (computed client-side from fetchMyResults — a
      query they're already allowed to run, filtered to their own uid).
   2) An ANONYMOUS array of every student's average percent — just numbers,
      no uid, no name, no exam content — published to this one small
      `leaderboard/publicStats` doc whenever an admin opens the Leaderboard
      tab (see admin/leaderboard.js). Any signed-in student may read that
      doc, but it carries nothing identifying or content-bearing to leak.

   Needs one narrow Firestore rule addition (same pattern as the existing
   counters/students rule documented in README.md):
     match /leaderboard/{docId} {
       allow read: if request.auth != null;
       allow write: if request.auth != null
         && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
     }
---------- */
export async function publishPercentileStats(percents) {
  await setDoc(doc(db, "leaderboard", "publicStats"), {
    percents: percents.map((p) => Math.round(Number(p) || 0)),
    updatedAt: serverTimestamp(),
  });
}

export async function fetchPercentileStats() {
  try {
    const snap = await getDoc(doc(db, "leaderboard", "publicStats"));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

/* ---------- Admin-only reads ---------- */
export async function fetchAllResultsAdmin() {
  const snap = await getDocs(collection(db, "results"));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
}

export async function fetchAllUsersAdmin() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
