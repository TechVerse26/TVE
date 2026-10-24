// ==========================================================================
// faq-data.js — every question and answer on the FAQ page (#/faq), and the quick answers the Help Center search suggests.
// Edit the words here; nothing else needs to change. Add a question = add one object to FAQ.
//
//   id   short, unique, lower-case-with-dashes (it is also the #anchor of the question)
//   cat  one of the FAQ_CATEGORIES ids below
//   q    the question (as a student would type it)
//   a    the answer: a string = a paragraph, or a list of blocks —
//          "text" · { p } · { ul: [] } · { ol: [] } · { dl: [[term, description]] } · { note, tone: "info"|"warn" } · { table }
//   kw   extra words people might search for that the question itself does not contain
//
// Text may use  **bold**  ·  [label](#/route)  ·  {email}  (the support address — see info-config.js).
//
// Every answer describes what the platform does today (checked against the code). Where something depends on a decision
// the owner has not published — a reply time, a retention period, a fee — the answer says nothing rather than guess.
// ==========================================================================
export const FAQ_CATEGORIES = [
  { id: "general", title: "General", icon: "fa-circle-info" },
  { id: "account", title: "Account & Authentication", icon: "fa-user-lock" },
  { id: "exams", title: "Exams & Participation", icon: "fa-file-pen" },
  { id: "rules", title: "Exam Rules & Attempts", icon: "fa-clipboard-list" },
  { id: "results", title: "Results & Performance", icon: "fa-chart-simple" },
  { id: "leaderboard", title: "Leaderboard", icon: "fa-trophy" },
  { id: "technical", title: "Technical Issues", icon: "fa-screwdriver-wrench" },
  { id: "privacy", title: "Privacy & Security", icon: "fa-shield-halved" },
  { id: "support", title: "Contact & Support", icon: "fa-headset" },
];

/** The exam status labels — shared with the Help Center ([label, meaning] pairs, in the words the exam cards use). */
export const STATUS_LEGEND = [
  ["Live Now", "A scheduled exam that is open right now. The countdown shows when its window closes."],
  ["Starting Soon", "A scheduled exam that opens within the next hour."],
  ["Upcoming", "A scheduled exam that opens later."],
  ["Available", "An exam that is open and has no closing time, such as a practice exam."],
  ["Completed", "You have used all your attempts, or the exam has closed and you have a result."],
  ["Closed", "The exam has closed and you have no result, or new entries were stopped early."],
  ["Not Available", "The exam was cancelled."],
];

export const FAQ = [
  /* ---------- General ---------- */
  {
    id: "what-is-tve", cat: "general", q: "What is Tech Verse Exam?",
    a: [
      "Tech Verse Exam is an online platform for taking live and practice exams, seeing your result straight away and following your progress over time. It runs alongside the Tech Verse Course, and you sign in with the same account.",
      "Read more on the [About Us](#/about) page.",
    ],
    kw: ["about", "platform", "purpose", "tech verse", "overview"],
  },
  {
    id: "who-can-use", cat: "general", q: "Who can use the platform?",
    a: [
      "The platform is made for students of the Tech Verse Course, who sign in with their course account. An exam that belongs to a course is visible only to students enrolled in that course; an exam that is not linked to a course is visible to every signed-in student.",
    ],
    kw: ["eligible", "eligibility", "students", "enrolled", "enrolment", "access", "allowed"],
  },
  {
    id: "account-needed", cat: "general", q: "Do I need an account?",
    a: [
      "Yes — to see the exam list, take an exam or view your results. The About Us, FAQ, Help Center, Privacy Policy, Terms & Conditions and Credits pages can be read without one.",
      "[Create an account](#/signup) or [log in](#/login).",
    ],
    kw: ["register", "sign up", "login", "public", "guest"],
  },
  {
    id: "devices", cat: "general", q: "Which devices can I use?",
    a: [
      "Tech Verse Exam runs in a web browser on phones, tablets and computers — there is nothing to install. Use an up-to-date browser with JavaScript turned on.",
    ],
    kw: ["mobile", "phone", "tablet", "laptop", "desktop", "browser", "app", "install", "android", "iphone"],
  },
  {
    id: "same-as-course", cat: "general", q: "Is my exam account the same as my Tech Verse Course account?",
    a: [
      "Yes. The exam platform uses the same sign-in system as the Tech Verse Course website, so you can log in with the same account. When you sign up, use the email address you used to enrol in the course.",
    ],
    kw: ["course", "same account", "email", "enrol", "enroll", "one account"],
  },

  /* ---------- Account & Authentication ---------- */
  {
    id: "create-account", cat: "account", q: "How do I create an account?",
    a: [
      { ol: [
        "Open [Sign up](#/signup).",
        "Enter your name, your email address and a password of at least 6 characters, then press **Create an account** — or press **Continue With Google**.",
        "You are signed in straight away and taken to the home page.",
      ] },
      "Use the same email address you used to enrol in the Tech Verse Course.",
    ],
    kw: ["register", "sign up", "signup", "new account", "join", "start"],
  },
  {
    id: "google-signin", cat: "account", q: "Can I sign in with Google?",
    a: [
      "Yes. Press **Continue With Google** on the [log in](#/login) or [sign-up](#/signup) page. Google opens in a pop-up window, so if nothing happens, allow pop-ups for this site and try again.",
    ],
    kw: ["google", "gmail", "popup", "pop-up", "single sign-on"],
  },
  {
    id: "forgot-password", cat: "account", q: "I forgot my password. How do I reset it?",
    a: [
      { ol: [
        "On the [log in](#/login) page, press **Forgot password?**.",
        "Enter your account email and press **Send reset link**.",
        "Open the email, follow its link and choose a new password. If you cannot see the email, check your Spam or Promotions folder.",
        "Come back and log in with the new password.",
      ] },
      "For privacy, the page gives the same answer whether or not an account exists for the address you typed. After a link is sent you can ask for another one after about a minute.",
      "Signed up with Google? You have no password on this platform — press **Continue With Google** instead.",
    ],
    kw: ["reset", "password", "forgot", "email link", "cannot log in", "can't log in", "recover", "locked out"],
  },
  {
    id: "change-password", cat: "account", q: "How do I change my password?",
    a: [
      "Log in, open [Profile → Settings](#/profile?view=settings) and use the **Password** section: enter your current password and the new one (at least 6 characters). If you signed in with Google, your password is managed by your Google account instead.",
    ],
    kw: ["password", "security", "update password", "new password", "settings"],
  },
  {
    id: "edit-profile", cat: "account", q: "Can I change my name, phone number or organisation?",
    a: [
      "Yes. Open [Profile → Settings](#/profile?view=settings), edit **Personal information** and save. Your email address and roll number are read-only.",
    ],
    kw: ["profile", "edit", "name", "phone", "institution", "update details", "change email"],
  },
  {
    id: "roll-number", cat: "account", q: "What is a roll number and how do I get one?",
    a: [
      "A roll number is a sequential number (for example 0001) that identifies you on the platform. Open [Profile → Settings](#/profile?view=settings) and press **Sync** next to Roll Number to receive yours. It is assigned once and cannot be edited afterwards.",
      "If the roll number on your profile looks wrong, email {email}.",
    ],
    kw: ["roll", "id", "number", "sync", "student id", "serial"],
  },
  {
    id: "sign-out", cat: "account", q: "How do I log out?",
    a: [
      "Choose **Sign Out** in the menu, or **Log Out** at the bottom of your [Profile](#/profile). On a shared or public computer, always log out when you finish.",
    ],
    kw: ["logout", "sign out", "shared computer", "public computer"],
  },
  {
    id: "email-verification", cat: "account", q: "Do I need to verify my email address?",
    a: [
      "No. Signing up does not send a verification email, so there is nothing to confirm before you start.",
    ],
    kw: ["verify", "verification", "confirm email", "confirmation", "activation"],
  },
  {
    id: "delete-account", cat: "account", q: "Can I delete my account?",
    a: [
      "There is no delete button in the platform. To ask about removing your account or correcting your details, email {email} from the address you registered with. See [Your Rights and Account Controls](#/privacy?section=your-rights) in the Privacy Policy.",
    ],
    kw: ["delete", "remove", "close account", "erase", "data deletion", "deactivate"],
  },

  /* ---------- Exams & Participation ---------- */
  {
    id: "find-exam", cat: "exams", q: "How do I find an exam?",
    a: [
      { ul: [
        "**All Exams** lists every exam you can see. Search by name, subject or course, and filter by type, status, date or difficulty.",
        "**Courses** takes you to your course's exams: upcoming, live and practice.",
        "**Schedule** shows upcoming and recent exams on a timetable.",
      ] },
      "Start at [All Exams](#/exams) or the [Schedule](#/schedule).",
    ],
    kw: ["search", "filter", "list", "courses", "schedule", "where", "browse"],
  },
  {
    id: "live-vs-practice", cat: "exams", q: "What is the difference between a live exam and a practice exam?",
    a: [
      { table: {
        caption: "Live exams compared with practice exams",
        cols: ["Aspect", "Live exam", "Practice exam"],
        rows: [
          ["When it is open", "Between a set opening and closing time", "Always open"],
          ["Negative marking", "Only if the exam sets it", "Never"],
          ["Leaderboard", "Counts", "Never counts"],
        ],
      } },
      "Either kind can limit the number of attempts. The rules page tells you before you start.",
    ],
    kw: ["live", "practice", "difference", "types", "scheduled", "mock", "compare"],
  },
  {
    id: "status-labels", cat: "exams", q: "What do the exam status labels mean?",
    a: [
      { dl: STATUS_LEGEND },
    ],
    kw: ["status", "badge", "label", "live now", "starting soon", "upcoming", "available", "completed", "closed", "not available", "meaning"],
  },
  {
    id: "exam-not-visible", cat: "exams", q: "Why can't I see an exam I was told about?",
    a: [
      "An exam may not appear for you if:",
      { ul: [
        "it belongs to a course you are not enrolled in;",
        "it has not been published yet, or it has been removed;",
        "it is unlisted and can be opened only through its direct link.",
      ] },
      "If you believe you should have access, email {email} with the exam name.",
    ],
    kw: ["missing", "hidden", "not showing", "cannot find", "can't find", "enrolled", "course", "link"],
  },
  {
    id: "cannot-start", cat: "exams", q: "Why can't I start an exam?",
    a: [
      "Before an exam opens, the platform checks your account, your enrolment, the exam window and the number of attempts you have left. You may see one of these messages:",
      { dl: [
        ["The exam hasn't started yet.", "The opening time has not arrived. The message shows when it starts."],
        ["Exam time is over.", "The closing time has passed."],
        ["Attempt ended", "You have used every attempt the exam allows."],
        ["Registration closed.", "New entries to this exam were stopped."],
        ["Exam not available.", "The exam was cancelled."],
        ["Exam not found.", "The exam was removed, or it is not open to your account."],
      ] },
      "New exams also cannot be started while the platform is under maintenance, or if your account has been deactivated. In either case, email {email}.",
    ],
    kw: ["blocked", "error", "start", "begin", "access", "denied", "maintenance", "deactivated", "disabled"],
  },
  {
    id: "reminders", cat: "exams", q: "Can I get a reminder before an exam?",
    a: [
      "Yes. On an upcoming scheduled exam, choose **Remind me**. You are reminded 15 minutes before the start and again at the start, in the notification bell and as a message on screen while the site is open. If you allow browser notifications, you also get one when the tab is in the background.",
      "Reminders are stored on your device only, so they work in the browser where you set them and are not shared with your other devices. Practice exams do not need reminders.",
    ],
    kw: ["notification", "alert", "remind", "reminder", "notify", "before exam"],
  },
  {
    id: "notices", cat: "exams", q: "Where do I see notices and exam alerts?",
    a: [
      "Open the bell icon in the top bar, or the full [Notifications](#/notifications) page. It gathers notices, new, starting-soon and live exams, schedule changes, results and your reminders. Which items you have read is remembered on your device.",
    ],
    kw: ["notifications", "bell", "announcements", "updates", "news"],
  },
  {
    id: "one-tab", cat: "exams", q: "Can I take an exam on two devices or in two tabs at once?",
    a: [
      "No. An attempt runs in one browser tab at a time, so the same attempt open in two tabs cannot overwrite itself. Your saved attempt lives on the device and browser where you started it, so finish it there.",
    ],
    kw: ["two tabs", "multiple tabs", "two devices", "another device", "same time", "duplicate"],
  },

  /* ---------- Exam Rules & Attempts ---------- */
  {
    id: "rules-page", cat: "rules", q: "Where do I see an exam's rules before I start?",
    a: [
      "After the access checks, a rules page shows the exam's time limit, total marks and pass mark, plus any negative marking, closing time or attempt count, and any instructions the exam sets. The timer does not begin until you press **Start**.",
    ],
    kw: ["rules", "instructions", "before start", "pass mark", "total marks", "duration"],
  },
  {
    id: "timer", cat: "rules", q: "When does the timer start, and can I pause it?",
    a: [
      "The timer starts the moment you press **Start** and cannot be paused. It keeps running if you refresh the page, close the tab or lose your connection, so be ready before you begin.",
      "Exam windows and countdowns use the server's time, which the platform compares with your device's clock whenever pages load.",
    ],
    kw: ["time", "duration", "countdown", "pause", "stop", "clock", "minutes", "timer"],
  },
  {
    id: "time-up", cat: "rules", q: "What happens when time runs out?",
    a: [
      "Your answers are submitted automatically, and any question you have not answered counts as unanswered. If time ran out while you were away, the answers saved on your device are submitted when you come back.",
    ],
    kw: ["auto submit", "automatic", "time over", "expired", "end of exam", "submitted"],
  },
  {
    id: "change-answer", cat: "rules", q: "Can I change an answer after selecting it?",
    a: [
      "No. In an exam, an answer is locked as soon as you select it, so check before you tap. The rules page says this before you press Start. You can move between questions in any order.",
    ],
    kw: ["edit answer", "undo", "lock", "locked", "wrong tap", "mistake", "change"],
  },
  {
    id: "unanswered", cat: "rules", q: "What happens to questions I do not answer?",
    a: [
      "They count as unanswered: they earn no marks and — where an exam has negative marking — they are not penalised, because only wrong answers lose marks. Before you submit, the platform tells you how many questions are still unanswered and asks you to confirm.",
    ],
    kw: ["skip", "blank", "unanswered", "leave", "submit early", "finish"],
  },
  {
    id: "negative-marking", cat: "rules", q: "What is negative marking?",
    a: [
      "Some live exams deduct marks for each wrong answer. If an exam does, its rules page tells you the deduction before you start. Practice exams never use negative marking.",
    ],
    kw: ["negative", "penalty", "deduct", "wrong answer", "minus marks"],
  },
  {
    id: "attempts", cat: "rules", q: "How many attempts do I get?",
    a: [
      "It depends on the exam. If an exam limits attempts, its rules page shows which attempt you are about to start (for example, attempt 2 of 3), and once you have used them all you cannot start it again. An exam with no limit can be retaken while it is open.",
    ],
    kw: ["attempt", "retake", "again", "limit", "how many times", "retry", "re-attempt"],
  },
  {
    id: "which-attempt-counts", cat: "rules", q: "Which attempt counts if I retake an exam?",
    a: [
      "Each attempt is kept in your history for that exam (the most recent 30 are kept). For the leaderboard, your best attempt in each live exam counts, so a retake can only help your rank. Practice exams never count towards the leaderboard.",
    ],
    kw: ["best", "latest", "retake", "history", "highest", "score counts"],
  },
  {
    id: "closing-time", cat: "rules", q: "What does an exam's closing time mean?",
    a: [
      "For a live exam, the closing time is the last moment you can start it. If you start before it, you still get the exam's full duration.",
    ],
    kw: ["deadline", "closes", "last time", "end time", "window", "too late"],
  },
  {
    id: "copy-print", cat: "rules", q: "Why can't I copy or print the questions?",
    a: [
      "While an exam is on screen, question text cannot be selected, copied, dragged or printed. This is deliberate and applies to every student.",
    ],
    kw: ["copy", "paste", "select", "right click", "print", "screenshot", "protection"],
  },

  /* ---------- Results & Performance ---------- */
  {
    id: "see-result", cat: "results", q: "When do I see my result?",
    a: [
      "Immediately after you submit. The result screen shows your score, how many answers were correct, wrong and unanswered, the time you used and — when you have a previous attempt — how you compare with it.",
    ],
    kw: ["result", "score", "marks", "outcome", "after exam", "percentage"],
  },
  {
    id: "past-results", cat: "results", q: "Where can I find my past results?",
    a: [
      "Open [Results](#/results). You will see a card for every exam you have taken; tap one to open its attempt history, including a chart once you have two or more attempts. [My Performance](#/performance) summarises your averages across all exams.",
    ],
    kw: ["history", "previous", "old results", "my results", "attempts list"],
  },
  {
    id: "review-mistakes", cat: "results", q: "How long can I review the questions I got wrong?",
    a: [
      "For 48 hours after you submit. After that, the saved review is removed; your scores and attempt history stay. Only the questions you answered wrongly are kept for review, and detailed reviews are kept for your most recent attempts.",
    ],
    kw: ["review", "mistakes", "wrong answers", "explanation", "48 hours", "expired", "correct answers"],
  },
  {
    id: "pdf-report", cat: "results", q: "Can I download my result as a PDF?",
    a: [
      "A **PDF** button appears on the result screen right after you finish an exam. It opens your browser's print dialog, where you choose **Save as PDF**. The PDF is available only from that screen, not later from Results, so save it before you leave the page.",
    ],
    kw: ["pdf", "download", "print", "report", "save", "certificate"],
  },
  {
    id: "score-calc", cat: "results", q: "How is my score worked out?",
    a: [
      "Correct answers earn marks. Where an exam has negative marking, each wrong answer loses marks; unanswered questions earn none. Your result shows your score and percentage, and the rules page shows the exam's total marks and pass mark before you start.",
    ],
    kw: ["calculate", "marks", "percentage", "pass", "fail", "pass mark", "grading"],
  },
  {
    id: "my-performance", cat: "results", q: "What is My Performance?",
    a: [
      "[My Performance](#/performance) summarises your progress: your average and best scores and your pass rate, with a line for every exam you have taken.",
    ],
    kw: ["performance", "progress", "average", "statistics", "analysis", "chart"],
  },
  {
    id: "others-results", cat: "results", q: "Can other students see my results?",
    a: [
      "No. Your results are visible to you and to the platform's administrators. Other students see only what a published leaderboard shows — see the Leaderboard questions in this FAQ.",
    ],
    kw: ["private", "who can see", "visible", "share", "other students"],
  },
  {
    id: "result-not-saved", cat: "results", q: "My result says it could not be saved. What should I do?",
    a: [
      "Your finished attempt is kept on your device. Once you are back online, press the retry button on the result screen. If you leave, a slim bar at the top of every page tells you an attempt is waiting; opening it saves the attempt again without creating a second one. Keep using the same browser until it is saved.",
    ],
    kw: ["not saved", "unsaved", "save failed", "offline", "lost result", "missing result", "retry"],
  },

  /* ---------- Leaderboard ---------- */
  {
    id: "lb-rank-rule", cat: "leaderboard", q: "How is the leaderboard ranked?",
    a: [
      "Students are ranked by the average of their best result in each live exam they have taken. Practice exams do not count, and a retake can only improve your best result for an exam.",
    ],
    kw: ["rank", "ranking", "position", "top", "average", "score", "how calculated"],
  },
  {
    id: "lb-not-listed", cat: "leaderboard", q: "Why am I not on the leaderboard?",
    a: [
      "You need at least one live-exam result to be ranked — until then the page says you do not have a rank yet. The Top Performers list shows only the highest-ranked students, and it is updated by the administrators, so a recent result may take a little while to appear.",
    ],
    kw: ["missing", "no rank", "not showing", "not listed", "where am i", "my rank"],
  },
  {
    id: "lb-updates", cat: "leaderboard", q: "How often is the leaderboard updated?",
    a: [
      "The published lists are updated by the platform's administrators rather than live, so recent exam results may take a little while to appear. The page shows when it was last updated.",
    ],
    kw: ["update", "refresh", "live", "delay", "old", "latest", "when"],
  },
  {
    id: "lb-exam-wise", cat: "leaderboard", q: "What are Exam-wise Leaders?",
    a: [
      "Below the overall list, the [Leaderboard](#/leaderboard) shows the top students for each live exam, ranked by their best attempt in that exam: higher score first, then faster time.",
    ],
    kw: ["exam wise", "per exam", "each exam", "leaders", "top students"],
  },
  {
    id: "lb-what-shown", cat: "leaderboard", q: "What do other students see about me on the leaderboard?",
    a: [
      "Only if you are in a published list. The administrators choose how names are shown for everyone: **full names** (with roll number and profile photo, where you have one), **first name and initial** (without roll number or photo), or **hidden**. The lists show percentages and the number of live exams — never your individual answers.",
      "See [Data Sharing and Disclosure](#/privacy?section=sharing) in the Privacy Policy.",
    ],
    kw: ["name", "photo", "roll", "visible", "public", "privacy", "shown"],
  },
  {
    id: "lb-opt-out", cat: "leaderboard", q: "Can I opt out of the leaderboard?",
    a: [
      "There is no personal opt-out switch. How names appear is decided for the whole platform by the administrators, and practice exams never count. If you have a concern about how you appear, email {email}.",
    ],
    kw: ["hide", "remove my name", "anonymous", "opt out", "private"],
  },

  /* ---------- Technical Issues ---------- */
  {
    id: "page-blank", cat: "technical", q: "A page is blank, stuck or shows an error. What can I try?",
    a: [
      { ol: [
        "Check your internet connection and refresh the page.",
        "Make sure your browser is up to date, with JavaScript and local storage turned on.",
        "Try another browser or device.",
        "If the problem continues, email {email} with the page address, what you expected, and your device and browser.",
      ] },
      { note: "Do not clear your browser's site data in the middle of an exam: an unfinished attempt is saved there.", tone: "warn" },
    ],
    kw: ["blank", "white screen", "not loading", "stuck", "error", "broken", "bug", "slow", "crash"],
  },
  {
    id: "lost-connection", cat: "technical", q: "My connection dropped during an exam.",
    a: [
      "Your answers are saved on your device as you go, so a dropped connection does not lose them. Reconnect and reopen the exam to carry on. The timer keeps running while you are offline. If you cannot reconnect before time is up, the saved answers are submitted when you next open the exam.",
    ],
    kw: ["offline", "internet", "disconnected", "wifi", "network", "data", "signal"],
  },
  {
    id: "refresh-exam", cat: "technical", q: "I refreshed the page or closed the app during an exam.",
    a: [
      "Open the exam again in the same browser on the same device. A resume screen lets you carry on with your saved answers. The timer did not stop while you were away. A saved attempt belongs to that browser on that device, so it does not follow you to another device.",
    ],
    kw: ["refresh", "reload", "closed", "resume", "continue", "browser closed", "battery", "phone died"],
  },
  {
    id: "clock-wrong", cat: "technical", q: "The countdown or exam time looks wrong.",
    a: [
      "Exam windows and countdowns use the server's time, which the platform compares with your device's clock whenever pages load. Refresh the page and set your device's date and time to update automatically. If it is still wrong, email {email} with the exam name and what you see.",
    ],
    kw: ["clock", "time zone", "timezone", "wrong time", "countdown", "date", "device time"],
  },
  {
    id: "google-popup", cat: "technical", q: "The Google sign-in window does not open or closes by itself.",
    a: [
      "Allow pop-ups for this site, then press **Continue With Google** again. If it still fails, try another browser.",
    ],
    kw: ["google", "popup", "pop-up", "blocked", "sign in", "login fails"],
  },
  {
    id: "private-mode", cat: "technical", q: "Does a private or incognito window work?",
    a: [
      "You can browse in one, but some browsers block local storage there. In that case an exam attempt cannot be saved on your device and would be lost if the page closed. For exams, use a normal browser window.",
    ],
    kw: ["incognito", "private", "private browsing", "storage", "cookies blocked"],
  },
  {
    id: "alerts-off", cat: "technical", q: "I am not getting exam alerts.",
    a: [
      "Reminders appear on screen and in the notification bell while the site is open. Browser notifications also need your permission — if you blocked them, switch them on in your browser's site settings. Reminders are kept on the device where you set them.",
    ],
    kw: ["notifications", "reminder", "browser alerts", "permission", "blocked", "not working"],
  },

  /* ---------- Privacy & Security ---------- */
  {
    id: "data-kept", cat: "privacy", q: "What information does the platform keep about me?",
    a: [
      "In short: your account details (name and email address, and — if you add them — phone number and organisation), your roll number, your profile photo if you sign in with Google, and your exam attempts, results and progress. The [Privacy Policy](#/privacy) explains each item, why it is kept and who can see it.",
    ],
    kw: ["data", "personal information", "collect", "collected", "stored", "what do you know"],
  },
  {
    id: "who-sees-data", cat: "privacy", q: "Who can see my results and personal details?",
    a: [
      "You can. The platform's administrators can too, because they manage exams and students. Other students cannot open your profile or results; they only see what a published leaderboard shows.",
    ],
    kw: ["who can see", "access", "administrators", "admin", "teachers", "visible"],
  },
  {
    id: "cookies-tracking", cat: "privacy", q: "Does the platform use cookies, advertising or tracking?",
    a: [
      "The platform's own code does not set cookies or load advertising or analytics scripts. It keeps a few small items in your browser's local storage — for example a saved exam attempt, your reminders and the colour theme you choose on the result screen. The sign-in and database services the platform relies on may store their own data in your browser. Details are in [Cookies and Local Storage](#/privacy?section=device-storage).",
    ],
    kw: ["cookies", "tracking", "ads", "advertising", "analytics", "local storage", "third party"],
  },
  {
    id: "password-storage", cat: "privacy", q: "Does the platform store my password?",
    a: [
      "Passwords are handled by Firebase Authentication, a sign-in service from Google. The platform's own records of your account do not contain your password. Never send your password to anyone by email, including support.",
    ],
    kw: ["password", "stored", "safe", "secure", "hash", "encrypted"],
  },
  {
    id: "correct-delete-data", cat: "privacy", q: "How can I correct or delete my information?",
    a: [
      "You can edit your name, phone number and organisation yourself in [Profile → Settings](#/profile?view=settings). For anything else — such as your roll number, or removing your account — email {email}. See [Your Rights and Account Controls](#/privacy?section=your-rights).",
    ],
    kw: ["correct", "delete", "erase", "remove data", "rights", "update details", "gdpr"],
  },
  {
    id: "security-report", cat: "privacy", q: "How do I report a security problem?",
    a: [
      "Email {email} and describe what you found and where. Please do not include passwords, and do not access other people's data while investigating.",
    ],
    kw: ["vulnerability", "security", "hack", "bug", "report", "responsible disclosure"],
  },

  /* ---------- Contact & Support ---------- */
  {
    id: "contact-support", cat: "support", q: "How do I contact support?",
    a: [
      "Email {email}. Support is by email only, and no reply time is promised. The [Help Center](#/help?section=contact) has a ready-made email that lists the details that help us look into a problem.",
    ],
    kw: ["contact", "email", "help", "support", "reach", "write to"],
  },
  {
    id: "what-to-include", cat: "support", q: "What should I include in a support email?",
    a: [
      { ul: [
        "Your name and the email address you registered with.",
        "Your roll number, if you have one.",
        "The exam name, if it is about an exam, and the date and time it happened.",
        "Your device and browser — for example, Android phone, Chrome.",
        "What happened and what you expected, with a screenshot if you can.",
      ] },
      { note: "Never write your password in an email.", tone: "warn" },
    ],
    kw: ["details", "information", "screenshot", "email template", "report problem"],
  },
  {
    id: "where-help", cat: "support", q: "Where can I find step-by-step help?",
    a: [
      "The [Help Center](#/help) has guides for getting started, signing in, finding and taking an exam, results, the leaderboard and troubleshooting.",
    ],
    kw: ["guide", "tutorial", "how to", "help center", "steps"],
  },
  {
    id: "question-error", cat: "support", q: "I think a question or my score is wrong.",
    a: [
      "Email {email} with the exam name, the question number or the score you expected, and what you believe is wrong. Whether a question or result is changed is decided by the exam administrators; no outcome is guaranteed.",
    ],
    kw: ["wrong question", "mistake", "incorrect", "dispute", "complaint", "appeal", "score error"],
  },
  {
    id: "no-chat", cat: "support", q: "Is there live chat, a phone line or a ticket form?",
    a: [
      "No. Email is the only support channel at the moment.",
    ],
    kw: ["chat", "phone", "call", "ticket", "live support", "whatsapp", "number"],
  },
];
