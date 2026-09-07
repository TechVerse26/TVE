// ==========================================================================
// exam-data.js — every Firestore read/write the exam section needs.
// Same collections TVcourse already uses (exams, courses, users, results) —
// no new Firebase project and no Firestore rules changes required.
// ==========================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, query, where, orderBy,
  setDoc, serverTimestamp,
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

export async function saveResult(payload) {
  await setDoc(doc(db, "results", `${payload.uid}_${payload.examId}`), {
    ...payload,
    submittedAt: serverTimestamp(),
  });
  bumpAttemptsCache(payload.examId, payload.attemptNumber);
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
