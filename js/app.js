// ==========================================================================
// app.js — SPA entry point for Tech Verse Exam
// ==========================================================================
import { Router } from "./router.js";
import { initExamPage } from "./exam.js";
import { initResultsPage } from "./page-results.js";
import { initProfilePage } from "./page-profile.js";
import { initLoginPage } from "./page-login.js";
import { initSignupPage } from "./page-signup.js";
import { unmountReport } from "./exam-report.js";
import { initHomePage } from "./page-home.js";
import { initExamsPage } from "./page-exams.js";
import { initSchedulePage } from "./page-schedule.js";
import { initNotificationsPage } from "./page-notifications.js";
import { initLeaderboardPage } from "./page-leaderboard.js";
import { initPerformancePage } from "./page-performance.js";
import { runPageCleanups } from "./page-lifecycle.js";
import { syncServerTime } from "./server-time.js";
import { startReminderScheduler, stopReminderScheduler } from "./reminders.js";
import { peekExamCatalog } from "./exam-data.js";
import { humanizeBn } from "./schedule-core.js";
import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const pageExam = document.getElementById("page-exam");
const pageGeneric = document.getElementById("page-generic");
const genericMount = document.getElementById("generic-page-content");

function showExam() {
  pageExam.classList.remove("hidden");
  pageGeneric.classList.add("hidden");
}
function showGeneric() {
  pageGeneric.classList.remove("hidden");
  pageExam.classList.add("hidden");
}

let examCleanup = null;
async function examRoute(params) {
  showExam();
  document.title = "Exam — Tech Verse Exam";
  if (typeof examCleanup === "function") { examCleanup(); examCleanup = null; }
  examCleanup = await initExamPage(params);
}

function genericRoute(initFn, title) {
  return async function (params) {
    showGeneric();
    document.title = title;
    await initFn(params, genericMount);
  };
}

const router = new Router(
  {
    // #/home is the dashboard; the course-by-course exam browser and the exam flow itself stay at #/exam.
    home: genericRoute(initHomePage, "Home — Tech Verse Exam"),
    exam: examRoute,
    exams: genericRoute(initExamsPage, "All Exams — Tech Verse Exam"),
    schedule: genericRoute(initSchedulePage, "Exam Schedule — Tech Verse Exam"),
    notifications: genericRoute(initNotificationsPage, "Notifications — Tech Verse Exam"),
    leaderboard: genericRoute(initLeaderboardPage, "Leaderboard — Tech Verse Exam"),
    performance: genericRoute(initPerformancePage, "My Performance — Tech Verse Exam"),
    results: genericRoute(initResultsPage, "My results — Tech Verse Exam"),
    profile: genericRoute(initProfilePage, "Profile — Tech Verse Exam"),
    login: genericRoute(initLoginPage, "Log in — Tech Verse Exam"),
    signup: genericRoute(initSignupPage, "Sign up — Tech Verse Exam"),
    404: genericRoute(async (_p, mount) => {
      mount.innerHTML = `<div class="container page"><div class="exs-empty"><h2>Page not found</h2><a href="#/home" class="btn btn-primary mt-16">Return to Home</a></div></div>`;
    }, "Page not found — Tech Verse Exam"),
  },
  null,
  {
    // Runs on every route change.
    onNavigate() {
      // Whatever the previous page started (countdown timers, window listeners) stops here.
      runPageCleanups();
      // The PDF report only lives while the post-exam result screen is showing.
      unmountReport();
      // A modal or drawer that was open when the user pressed Back (or followed
      // a link) never gets to run its own close handler — without this the page
      // would stay scroll-locked ("overflow: hidden") on every screen after it.
      document.body.style.overflow = "";
    },
  }
);

// Server clock first (one tiny same-origin request): countdowns and "Live now" are judged against it, not the phone's clock.
syncServerTime();

// "Remind me": evaluated on this device only (reminders.js) — no Firestore reads or writes. The exam list is passed
// in only when it is already in memory, so the background check can never trigger a read.
onAuthStateChanged(auth, (user) => {
  if (!user) { stopReminderScheduler(); return; }
  startReminderScheduler(() => ({
    uid: auth.currentUser?.uid || null,
    exams: peekExamCatalog()?.exams || null,
    humanize: humanizeBn,
  }));
});

router.start();
