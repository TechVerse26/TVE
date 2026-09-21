// ==========================================================================
// exam-data.js — every Firestore read/write the exam section needs.
// Same collections TVcourse already uses (exams, courses, users, results) —
// no new Firebase project and no Firestore rules changes required.
// ==========================================================================
import { db } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, query, where, orderBy,
  setDoc, serverTimestamp, Timestamp, runTransaction,
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

/* ---------- 48-hour lifetime for a saved wrong-answer review ----------
   A submitted attempt's `review` field (see reviewSnapshot in exam.js) only
   ever holds the questions the student got wrong. It's meant to be seen
   right after the exam and revisited for a couple of days at most — not
   kept around forever. isReviewExpired() is the single source of truth for
   "is this attempt's review still within its window", shared by the prune
   pass below and by page-results.js when deciding whether to offer the
   "reopen this attempt's review" button at all. ---------- */
export const REVIEW_TTL_MS = 48 * 60 * 60 * 1000;
function timestampToMs(ts) {
  if (ts?.toMillis) return ts.toMillis();
  if (ts?.seconds) return ts.seconds * 1000;
  return null;
}
export function isReviewExpired(submittedAt) {
  const ms = timestampToMs(submittedAt);
  if (!ms) return false; // unknown timestamp — never force-expire, just leave it be
  return Date.now() - ms > REVIEW_TTL_MS;
}
/** Milliseconds a saved review has left before it expires (null if the attempt time is unknown). */
export function reviewMsLeft(submittedAt) {
  const ms = timestampToMs(submittedAt);
  if (!ms) return null;
  return Math.max(0, REVIEW_TTL_MS - (Date.now() - ms));
}

/** Real number of attempts one results/{uid}_{examId} doc stands for (one doc per student+exam, many attempts). */
export function countAttempts(result) {
  const byNumber = Number(result?.attemptNumber) || 0;
  const byHistory = Array.isArray(result?.attempts) ? result.attempts.length : 0;
  return Math.max(byNumber, byHistory, 1);
}

/* ---------- Every result belonging to the current user (My Results page) ----------
   Query filtered by uid == request.auth.uid, matching the existing Firestore
   rule exactly — a signed-in user can list only their own result documents.

   Also does one small piece of self-cleanup on the way out: any attempt
   whose review has passed its 48-hour window gets that review wiped for
   good the next time the student opens this page — no cron job or Cloud
   Function needed. The returned list is already pruned in memory, and the
   actual database clean-up runs in the background (a transaction per
   document, so it can never overwrite an attempt saved a moment earlier),
   so opening "My Activity" never waits on it. ---------- */
function pruneExpiredReviews(attempts) {
  let changed = false;
  const next = attempts.map((a) => {
    if (a && a.review && isReviewExpired(a.submittedAt)) { changed = true; return { ...a, review: null }; }
    return a;
  });
  return { next, changed };
}

async function purgeExpiredReviews(resultId) {
  const ref = doc(db, "results", resultId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const attempts = snap.data().attempts;
    if (!Array.isArray(attempts)) return;
    const { next, changed } = pruneExpiredReviews(attempts);
    if (changed) tx.set(ref, { attempts: next }, { merge: true });
  });
}

export async function fetchMyResults(uid) {
  const snap = await getDocs(query(collection(db, "results"), where("uid", "==", uid)));
  const results = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  for (const r of results) {
    if (!Array.isArray(r.attempts)) continue;
    const { next, changed } = pruneExpiredReviews(r.attempts);
    if (!changed) continue;
    r.attempts = next; // the UI sees the pruned view immediately
    purgeExpiredReviews(r.id).catch(() => { /* best-effort — the UI already hides it */ });
  }

  return results.sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
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
   (Live exams keep this history too, not just practice ones — that is what
   lets "My Results" chart and review a live exam retaken across sittings.) ---------- */
const RESULT_HISTORY_CAP = 30;
// A big exam (hundreds of questions) retaken many times could make full
// question-snapshot detail alone approach Firestore's 1MB document limit
// long before RESULT_HISTORY_CAP is reached. Score/date history is cheap
// and kept for all RESULT_HISTORY_CAP attempts either way, but the heavier
// question-by-question review is only kept for the most recent attempts —
// older ones fall back to the "no detailed review saved" state the UI
// already handles gracefully (see page-results.js).
const REVIEW_DETAIL_CAP = 10;
// Hard safety net on top of the cap above: whatever the exam size, the
// document is kept safely under Firestore's 1MB limit by shedding the
// OLDEST reviews first. A result (score + history) must always be saved —
// the review is the optional part.
const RESULT_DOC_BUDGET_BYTES = 800 * 1024;

function approxBytes(value) {
  try { return new Blob([JSON.stringify(value)]).size; } catch { return 0; }
}

function fitAttemptsToBudget(attempts, rest) {
  const out = attempts.slice();
  let size = approxBytes({ ...rest, attempts: out });
  for (let i = 0; i < out.length && size > RESULT_DOC_BUDGET_BYTES; i++) {
    if (out[i].review) {
      out[i] = { ...out[i], review: null };
      size = approxBytes({ ...rest, attempts: out });
    }
  }
  return out;
}

/* ---------- Save one finished attempt ----------
   For a student's 2nd, 3rd … attempt at an exam the append runs as a
   transaction: read the current doc, add the attempt, write — atomically.
   The old read-then-overwrite version could silently wipe a student's whole
   history if that read happened to fail (offline blip, etc.), and two tabs
   finishing at the same moment could overwrite each other.

   Also safe to retry: every attempt carries a client-generated `attemptId`,
   so if a save "fails" after it actually reached the server (lost
   acknowledgement) and the student retries, the retry finds its own attempt
   already stored and returns instead of adding a duplicate.

   `maxAttempts` (0 = unlimited) is re-checked against the stored attempt
   count, which closes the "two tabs, one attempt left" loophole that the
   start-of-exam check alone can't.

   First-ever attempt: the results/{uid}_{examId} doc doesn't exist yet, and
   the Firestore rule for reading it (`resource.data.uid == …`) can't be
   evaluated on a missing doc — so the read is answered with
   "permission-denied", not "not found". That specific answer is therefore
   treated as "no history yet" and the doc is simply created. Any OTHER read
   failure (offline, timeout…) is re-thrown on purpose: mistaking a network
   blip for "no history" is exactly how a student's earlier attempts used to
   get overwritten. ---------- */
async function resultDocExists(ref) {
  try {
    return (await getDoc(ref)).exists();
  } catch (err) {
    if (err?.code === "permission-denied") return false;
    throw err;
  }
}

export async function saveResult(payload) {
  // reviewSnapshot only belongs inside this one attempt entry — pulling it
  // out of `rest` keeps it from also being duplicated at the top level of
  // the doc (which would double its storage cost for no reason, since the
  // top-level fields only ever need to reflect the LATEST attempt).
  const { reviewSnapshot, attemptId, maxAttempts = 0, ...rest } = payload;
  const ref = doc(db, "results", `${payload.uid}_${payload.examId}`);

  // The new results doc: everything already stored + this attempt, trimmed to fit.
  function compose(prevAttempts, priorCount) {
    const attemptNumber = priorCount + 1;
    let attempts = [...prevAttempts, {
      id: attemptId || null,
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
    attempts = fitAttemptsToBudget(attempts, rest);
    return { attemptNumber, data: { ...rest, attemptNumber, attempts, submittedAt: serverTimestamp() } };
  }

  let saved;
  if (!(await resultDocExists(ref))) {
    const { attemptNumber, data } = compose([], 0);
    await setDoc(ref, data);
    saved = { attemptNumber, duplicate: false };
  } else {
    saved = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists() ? snap.data() : null;
      const prevAttempts = Array.isArray(prev?.attempts) ? prev.attempts : [];
      const priorCount = Math.max(Number(prev?.attemptNumber) || 0, prevAttempts.length);

      if (attemptId && prevAttempts.some((a) => a && a.id === attemptId)) {
        return { attemptNumber: priorCount || 1, duplicate: true }; // this very attempt is already stored
      }
      if (Number(maxAttempts) > 0 && priorCount >= Number(maxAttempts)) {
        const err = new Error("attempts-exhausted");
        err.code = "attempts-exhausted";
        throw err;
      }
      const { attemptNumber, data } = compose(prevAttempts, priorCount);
      tx.set(ref, data);
      return { attemptNumber, duplicate: false };
    });
  }

  bumpAttemptsCache(payload.examId, saved.attemptNumber);
  return saved;
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
