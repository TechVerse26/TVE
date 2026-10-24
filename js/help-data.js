// ==========================================================================
// help-data.js — the words on the Help Center (#/help). Edit the text here; the layout lives in page-help.js.
//
// Every guide describes what the platform does today, using the same labels the screens use (Start Exam, Retake Exam,
// Sign Out, Sync …). Nothing here promises a reply time, a fix or an outcome. Support is by email only — there is no
// ticket form, chat or phone line, and none is shown.
//
// Text may use  **bold**  ·  [label](#/route)  ·  {email}.  `related` = ids of FAQ questions (faq-data.js) to list beside a section.
// ==========================================================================
import { STATUS_LEGEND } from "./faq-data.js";

export const HELP = {
  hero: {
    kicker: "Help Center",
    title: "How can we help?",
    lead: "Search the answers, follow a short guide, or email support. Everything here describes how the platform works today.",
  },

  search: {
    label: "Search for help",
    placeholder: "Search help, e.g. reset password",
    // "Popular" quick links under the search box: [label, href, jumpTo?]
    popular: [
      ["Reset my password", "#/faq?open=forgot-password"],
      ["Start an exam", "#/faq?open=cannot-start"],
      ["Where are my results?", "#/faq?open=past-results"],
      ["Contact support", "#/help?section=contact", "contact"],
    ],
  },

  topics: [
    { id: "getting-started", icon: "fa-rocket", title: "Getting started", text: "Create an account and take your first exam." },
    { id: "account", icon: "fa-user-lock", title: "Account & sign-in", text: "Sign up, log in, reset or change a password." },
    { id: "exams", icon: "fa-file-pen", title: "Finding & starting an exam", text: "Where exams are and what the labels mean." },
    { id: "rules", icon: "fa-clipboard-list", title: "Exam rules", text: "Timer, answers, attempts and negative marking." },
    { id: "results", icon: "fa-chart-simple", title: "Results & performance", text: "Scores, reviews, PDF reports and progress." },
    { id: "leaderboard", icon: "fa-trophy", title: "Leaderboard", text: "How ranking works and what others can see." },
    { id: "troubleshooting", icon: "fa-screwdriver-wrench", title: "Troubleshooting", text: "Fixes for the problems students meet most." },
    { id: "contact", icon: "fa-envelope", title: "Contact support", text: "Email us, and what to include." },
  ],

  /* ---------- Getting Started ---------- */
  gettingStarted: {
    id: "getting-started",
    title: "Getting Started",
    sub: "From a new account to your first result.",
    steps: [
      { title: "Create your account", text: "Open [Sign up](#/signup), enter your name, email and a password (at least 6 characters) — or choose **Continue With Google**. Use the email address you used to enrol in the Tech Verse Course." },
      { title: "Check your profile", text: "In [Profile → Settings](#/profile?view=settings) you can add a phone number and organisation, and press **Sync** to receive your roll number." },
      { title: "Find an exam", text: "Open [All Exams](#/exams) to search and filter, or the [Schedule](#/schedule) to see what is coming up. Live exams open at set times; practice exams are always open." },
      { title: "Take the exam", text: "Choose **Start Exam**, read the rules page and press **Start**. Answer before the timer ends — your answers are saved on your device as you go." },
      { title: "See how you did", text: "Your score appears as soon as you submit. Find it again later in [Results](#/results), and follow your progress in [My Performance](#/performance)." },
    ],
    related: ["create-account", "find-exam", "roll-number", "see-result"],
  },

  /* ---------- Account & Sign-in ---------- */
  account: {
    id: "account",
    title: "Account & Sign-in",
    sub: "Getting in, and staying in.",
    cards: [
      { title: "Sign up", steps: [
        "Open [Sign up](#/signup).",
        "Type your name, your email address and a password of at least 6 characters.",
        "Press **Create an account** — or **Continue With Google**.",
        "You are signed in and taken to the home page.",
      ] },
      { title: "Log in", steps: [
        "Open [Log in](#/login).",
        "Enter your email and password and press **Login** — or press **Continue With Google**.",
        "You are taken to the home page.",
      ] },
      { title: "Reset a forgotten password", steps: [
        "On [Log in](#/login), press **Forgot password?**.",
        "Enter your account email and press **Send reset link**.",
        "Open the email (check Spam or Promotions too) and follow its link to choose a new password.",
        "Log in with the new password. You can ask for another link after about a minute.",
      ] },
      { title: "Change your password", steps: [
        "Log in and open [Profile → Settings](#/profile?view=settings).",
        "Under **Password**, enter your current password and the new one twice (at least 6 characters).",
        "Press **Update password**.",
        "Signed in with Google? Your password is managed by your Google account.",
      ] },
      { title: "Update your details", steps: [
        "Open [Profile → Settings](#/profile?view=settings).",
        "Under **Personal information**, edit your name, phone number or organisation, and save.",
        "Your email address and roll number are read-only.",
      ] },
      { title: "Get your roll number", steps: [
        "Open [Profile → Settings](#/profile?view=settings).",
        "Press **Sync** next to Roll Number.",
        "Your number (for example 0001) is assigned once and cannot be edited.",
        "A copy button appears next to it once it is assigned.",
      ] },
    ],
    related: ["forgot-password", "google-signin", "change-password", "roll-number", "same-as-course"],
  },

  /* ---------- Finding & Starting an Exam ---------- */
  exams: {
    id: "exams",
    title: "Finding and Starting an Exam",
    sub: "Where exams live, what the labels mean, and what happens when you press Start.",
    where: [
      { icon: "fa-file-pen", title: "All Exams", text: "Every exam you can see. Search by name, subject or course; filter by type, status, date or difficulty. [Open All Exams](#/exams)." },
      { icon: "fa-graduation-cap", title: "Courses", text: "Your course's exams, split into upcoming, live and practice. [Open Courses](#/exam)." },
      { icon: "fa-calendar-days", title: "Schedule", text: "A timetable of upcoming and recent exams, shown in your own time zone. [Open the Schedule](#/schedule)." },
      { icon: "fa-bell", title: "Notifications", text: "New exams, schedule changes, results and your reminders. [Open Notifications](#/notifications)." },
    ],
    legendTitle: "What the status labels mean",
    legend: STATUS_LEGEND,
    startTitle: "Starting an exam",
    start: [
      "Choose **Start Exam** on an exam card. After a first attempt it reads **Retake Exam** — or **Continue Practice** for a practice exam.",
      "The platform checks your account, your enrolment, the exam window and your remaining attempts.",
      "Read the rules page: time limit, total and pass marks, negative marking, closing time and which attempt this is.",
      "Press **Start**. The timer begins at once and cannot be paused.",
    ],
    greyedTitle: "If the button is greyed out",
    greyed: [
      ["Coming Soon", "The exam has not opened yet. On an upcoming scheduled exam you can choose **Remind me**."],
      ["Closed", "The exam window has ended."],
      ["Registration Closed", "New entries to this exam were stopped."],
      ["Not Available", "The exam was cancelled."],
      ["Under Maintenance", "New exams cannot be started at the moment. Try again later."],
      ["Account Disabled", "Your account has been deactivated. Email {email}."],
    ],
    related: ["find-exam", "status-labels", "exam-not-visible", "cannot-start", "reminders"],
  },

  /* ---------- Exam Rules ---------- */
  rules: {
    id: "rules",
    title: "Exam Rules",
    sub: "What applies once you press Start.",
    items: [
      { icon: "fa-stopwatch", title: "The timer never stops", text: "It starts when you press Start and keeps running if you refresh, close the tab or lose your connection." },
      { icon: "fa-lock", title: "Answers lock when you select them", text: "Check before you tap: a selected answer cannot be changed. You can move between questions in any order." },
      { icon: "fa-floppy-disk", title: "Progress is saved on your device", text: "A refresh or a closed app does not lose your answers. Reopen the exam in the same browser to resume." },
      { icon: "fa-flag-checkered", title: "Time up means submitted", text: "When time runs out your answers are submitted automatically. Unanswered questions count as unanswered." },
      { icon: "fa-circle-minus", title: "Negative marking", text: "Some live exams deduct marks for each wrong answer; the rules page tells you. Practice exams never do." },
      { icon: "fa-rotate-right", title: "Attempts", text: "Some exams limit attempts. The rules page shows which attempt you are about to start." },
      { icon: "fa-door-closed", title: "Closing time", text: "For a live exam it is the last moment you can start. Once you have started, you get the full duration." },
      { icon: "fa-ban", title: "Copying and printing", text: "Question text cannot be selected, copied or printed while an exam is on screen." },
    ],
    related: ["rules-page", "timer", "change-answer", "attempts", "negative-marking", "time-up"],
  },

  /* ---------- Results & Performance ---------- */
  results: {
    id: "results",
    title: "Results & Performance",
    sub: "Where your scores go, and how to use them.",
    items: [
      { icon: "fa-square-poll-vertical", title: "Right after you submit", text: "Your score, the correct, wrong and unanswered counts, the time you used and — when you have an earlier attempt — a comparison with it." },
      { icon: "fa-clock-rotate-left", title: "Your results", text: "[Results](#/results) has a card for every exam you have taken. Open one for its attempt history and, from two attempts on, a chart." },
      { icon: "fa-eye", title: "Reviewing your mistakes", text: "The questions you got wrong stay available for 48 hours after you submit. Your scores and history stay after that." },
      { icon: "fa-file-pdf", title: "PDF report", text: "Press the PDF button on the result screen, then choose **Save as PDF** in the print window. It is not available later, so save it before you leave the page." },
      { icon: "fa-chart-line", title: "My Performance", text: "[My Performance](#/performance) shows your average, best score and pass rate, with a line for every exam you have taken." },
      { icon: "fa-floppy-disk", title: "If a result was not saved", text: "Your finished attempt stays on your device. Press the retry button on the result screen once you are online, in the same browser." },
    ],
    related: ["see-result", "past-results", "review-mistakes", "pdf-report", "result-not-saved"],
  },

  /* ---------- Leaderboard ---------- */
  leaderboard: {
    id: "leaderboard",
    title: "Leaderboard",
    sub: "How the ranking works.",
    points: [
      "Students are ranked by the **average of their best result in each live exam**. Practice exams do not count.",
      "A retake can only improve your best result for an exam.",
      "The lists are **published by the platform's administrators**, so a new result may take a little while to appear. The page shows when it was last updated.",
      "You are ranked after your first live exam. Until then the page says you do not have a rank yet.",
      "If you appear in a published list, others may see your name — and, depending on the platform's setting, your roll number and photo. They never see your answers.",
    ],
    cta: ["Open the leaderboard", "#/leaderboard"],
    related: ["lb-rank-rule", "lb-not-listed", "lb-updates", "lb-what-shown", "lb-exam-wise"],
  },

  /* ---------- Troubleshooting (each item opens like an FAQ answer) ---------- */
  troubleshooting: {
    id: "troubleshooting",
    title: "Troubleshooting",
    sub: "Open a problem to see what to try.",
    items: [
      { id: "cant-log-in", q: "I can't log in", a: [
        { ol: [
          "Check the email address for typos, and that Caps Lock is off.",
          "Forgotten your password? Press **Forgot password?** on the [log in](#/login) page.",
          "Signed up with Google? You have no password here — press **Continue With Google**.",
          "If you see “too many attempts”, wait a little while before trying again.",
        ] },
        "Still stuck? Email {email} with your registered email address — never your password.",
      ] },
      { id: "no-reset-email", q: "The password reset email did not arrive", a: [
        { ol: [
          "Look in your Spam and Promotions folders.",
          "Check you typed the address you registered with. The page answers the same way whether or not an account exists for the address, so a typo or a different address is a common reason.",
          "Wait about a minute, then press **Resend link**.",
          "Registered with Google? You do not need a password — press **Continue With Google**.",
        ] },
      ] },
      { id: "google-popup", q: "The Google sign-in window does not open", a: [
        "Allow pop-ups for this site in your browser, then press **Continue With Google** again. If it still fails, try another browser.",
      ] },
      { id: "cannot-start", q: "I can't start an exam", a: [
        "Check the button on the exam card and the message on the screen — they say why (see the labels above). The usual reasons are that the exam has not opened or has closed, you have used all your attempts, it belongs to a course you are not enrolled in, or the platform is under maintenance.",
        "More detail: [Why can't I start an exam?](#/faq?open=cannot-start). If you believe you should have access, email {email} with the exam name.",
      ] },
      { id: "blank-page", q: "A page is blank, stuck or shows an error", a: [
        { ol: [
          "Check your internet connection and refresh the page.",
          "Make sure your browser is up to date, with JavaScript and local storage turned on.",
          "Try another browser or device.",
          "If it continues, email {email} with the page address, what you expected, and your device and browser.",
        ] },
        { note: "Do not clear your browser's site data in the middle of an exam: an unfinished attempt is saved there.", tone: "warn" },
      ] },
      { id: "dropped-connection", q: "My connection dropped, or I refreshed, during an exam", a: [
        { ol: [
          "Reconnect, then open the exam again in the same browser on the same device.",
          "A resume screen lets you carry on with your saved answers.",
          "The timer did not stop while you were away. If time ran out, your saved answers are submitted when you return.",
        ] },
        "A saved attempt belongs to that browser on that device — it does not follow you to another device.",
      ] },
      { id: "wrong-time", q: "The countdown or exam time looks wrong", a: [
        "Refresh the page, and set your device's date and time to update automatically. Exam windows and countdowns use the server's time, compared with your device's clock whenever pages load. If it is still wrong, email {email} with the exam name and what you see.",
      ] },
      { id: "result-unsaved", q: "My result says it could not be saved", a: [
        { ol: [
          "Stay in the same browser — your finished attempt is kept on your device.",
          "When you are online, press the retry button on the result screen.",
          "If you left the page, a slim bar at the top of every page tells you an attempt is waiting. Open it to save the attempt again — it will not count twice.",
        ] },
      ] },
      { id: "missing-exam", q: "An exam I expected is missing", a: [
        { ul: [
          "It may belong to a course you are not enrolled in.",
          "It may not be published yet, or may have been removed.",
          "It may be unlisted, reachable only through its direct link.",
        ] },
        "If you believe you should have access, email {email} with the exam name.",
      ] },
      { id: "no-alerts", q: "I am not getting reminders or alerts", a: [
        "Reminders appear on screen and in the notification bell while the site is open. Browser notifications need your permission — if you blocked them, switch them on in your browser's site settings. Reminders are stored on the device where you set them.",
      ] },
      { id: "wrong-score", q: "I think a question or my score is wrong", a: [
        "Email {email} with the exam name, the question number or the score you expected, and what you believe is wrong. Whether a question or result is changed is decided by the exam administrators; no outcome is guaranteed.",
      ] },
    ],
  },

  /* ---------- Account & Privacy guidance ---------- */
  privacy: {
    id: "privacy",
    title: "Account & Privacy Guidance",
    sub: "Simple habits that keep your account and your data safe.",
    items: [
      { icon: "fa-key", title: "Keep your password to yourself", text: "Never share it, and never write it in an email to support." },
      { icon: "fa-right-from-bracket", title: "Log out on shared devices", text: "Choose **Sign Out** in the menu, or **Log Out** on your [Profile](#/profile), when you finish on a shared or public computer." },
      { icon: "fa-user-pen", title: "Keep your details correct", text: "Update your name, phone number and organisation in [Profile → Settings](#/profile?view=settings). Your email address and roll number are read-only." },
      { icon: "fa-eye", title: "Know what others can see", text: "Other students cannot open your profile or results. If you appear in a published leaderboard list, others may see your name — and, depending on the platform's setting, your roll number and photo." },
      { icon: "fa-file-shield", title: "Read the policies", text: "The [Privacy Policy](#/privacy) explains what is stored and why. The [Terms & Conditions](#/terms) set out the rules for using the platform." },
    ],
    related: ["data-kept", "who-sees-data", "cookies-tracking", "correct-delete-data"],
  },

  /* ---------- Contact Support ---------- */
  contact: {
    id: "contact",
    title: "Contact Support",
    sub: "How to reach us, and what to tell us.",
    lead: "Support is by email only — there is no live chat, phone line or ticket form — and no reply time is promised. Including the details listed under “What to include” helps us look into your problem.",
    includeTitle: "What to include",
    include: [
      "Your name and the email address you registered with.",
      "Your roll number, if you have one.",
      "The exam name, and the date and time it happened, if it is about an exam.",
      "Your device and browser — for example, Android phone, Chrome.",
      "What happened and what you expected, with a screenshot if you can.",
    ],
    warn: "Never write your password in an email.",
    mailNote: "The button opens an email addressed to support with a ready-made subject and a short list of details to fill in.",
  },

  /* ---------- More help ---------- */
  more: [
    { icon: "fa-circle-question", title: "Frequently Asked Questions", text: "Quick answers, searchable and grouped by topic.", href: "#/faq" },
    { icon: "fa-shield-halved", title: "Privacy Policy", text: "What the platform stores, why, and who can see it.", href: "#/privacy" },
    { icon: "fa-file-contract", title: "Terms & Conditions", text: "The rules for using Tech Verse Exam.", href: "#/terms" },
  ],
};
