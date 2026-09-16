// ==========================================================================
// app.js — SPA entry point for Tech Verse Exam
// URL scheme: #/home (= exam course picker)   #/exam?course=xxx   #/exam?id=xxx
//             #/results   #/login   #/signup
// ==========================================================================
import { Router } from "./router.js";
import { initExamPage } from "./exam.js";
import { initResultsPage } from "./page-results.js";
import { initProfilePage } from "./page-profile.js";
import { initLoginPage } from "./page-login.js";
import { initSignupPage } from "./page-signup.js";

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

async function homeRoute(params) {
  await examRoute(new URLSearchParams());
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
    home: homeRoute,
    exam: examRoute,
    results: genericRoute(initResultsPage, "My results — Tech Verse Exam"),
    profile: genericRoute(initProfilePage, "Profile — Tech Verse Exam"),
    login: genericRoute(initLoginPage, "Log in — Tech Verse Exam"),
    signup: genericRoute(initSignupPage, "Sign up — Tech Verse Exam"),
    404: genericRoute(async (_p, mount) => {
      mount.innerHTML = `<div class="container page-pad"><div class="exs-empty"><h2>Page not found</h2><a href="#/home" class="btn btn-primary mt-16">Return to Home</a></div></div>`;
    }, "Page not found — Tech Verse Exam"),
  },
  null
);

router.start();
