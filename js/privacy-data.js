// ==========================================================================
// privacy-data.js — the TEXT of the Privacy Policy (#/privacy). Edit the wording here.
//
// Every statement was written from what the platform's code really does (auth.js, exam-data.js, exam.js, exam-session-core.js,
// reminders.js, notify.js, server-time.js, firebase-config.js, firestore.rules, the admin panel …). Nothing is assumed.
// Facts the code cannot show are NOT written as facts: they use {owner:key} and print a marked "To be confirmed" note until
// the owner types the confirmed text into info-config.js → OWNER_DETAILS (the page then shows it as ordinary text).
//
// Mark-up (see info-core.js):  **bold** · [label](#/route · https://… · mailto:…) · {email} {site} {name} {owner:key}
// Blocks: "paragraph" · { h } · { ul } · { ol } · { note, tone } · { dl } · { table }
// The "Last updated" date is LEGAL_DATES.privacy in info-config.js — change it whenever this wording changes.
// Section ids are part of the web addresses (#/privacy?section=your-rights); the FAQ and the Help Center link to some of
// them (your-rights, sharing, device-storage), so keep those ids when you rename a heading.
// ==========================================================================
import { SITE } from "./info-config.js";
import { mailtoHref } from "./info-core.js";

/** A ready-made email for privacy questions and requests (subject + short template). */
const REQUEST_MAIL = mailtoHref({
  to: SITE.email,
  subject: "Tech Verse Exam — privacy request",
  body: ["Hello,", "", "Name:", "Email address of my account:", "", "What I would like to know or change:", "", "(Please do not write your password in this email.)"].join("\n"),
});

export const PRIVACY = {
  kicker: "Legal",
  title: "Privacy Policy",
  lead: "What Tech Verse Exam keeps about you, why it keeps it, who can see it, and what you can do about it.",

  /** Shown above section 1: the short version. */
  intro: [
    { ul: [
      "**What the platform keeps:** your account details, your roll number, and your exam attempts, results and progress.",
      "**Who can see it:** you and the platform's administrators. Other students see only what a published leaderboard shows.",
      "**What it does not use:** the platform's own code sets no cookies and has no advertising or analytics scripts.",
      "**Your choices:** you can edit your name, phone number and organisation yourself. For anything else, email {email}.",
    ] },
  ],

  sections: [
    /* ---------------------------------------------------------------- 1 */
    {
      id: "introduction", title: "Introduction",
      blocks: [
        "{name} is an online examination platform. Students use it to take live and practice exams, see their results and follow their progress. The platform is operated by {owner:operator} (“we”, “us”).",
        "This policy explains what information the platform records about you, why it does so, who can see it, how long it stays, and what you can do about it. It describes how the platform works today, based on how it is built. It is not a promise about features that may be added later.",
        "Please read it together with the [Terms & Conditions](#/terms). If something is unclear, the [FAQ](#/faq) and the [Help Center](#/help) give plain-language answers, and you can always [contact us](#/privacy?section=contact).",
      ],
    },

    /* ---------------------------------------------------------------- 2 */
    {
      id: "scope", title: "Scope",
      blocks: [
        "This policy covers the {name} website at {site} and everything on it: sign-in, your profile, exams, results, performance pages, notifications, reminders and the leaderboard.",
        "It does not cover:",
        { ul: [
          "**The Tech Verse Course website.** It uses the same sign-in and the same account record as this platform, but it is a separate website. What it collects, and what it does with that information, is outside this policy.",
          "**Other websites and services** that this platform links to or relies on. See [Third-Party Services and External Links](#/privacy?section=third-parties).",
        ] },
      ],
    },

    /* ---------------------------------------------------------------- 3 */
    {
      id: "information-we-collect", title: "Information We Collect",
      blocks: [
        "The platform deals with three kinds of information: what you **give** it, what it **creates** while you use it, and what it does **not** collect at all. The table lists what the platform keeps about you, and where. The sections after it explain each item.",
        { table: {
          caption: "Information the platform keeps, how it comes about and where it is kept",
          cols: ["Information", "How it comes about", "Where it is kept"],
          rows: [
            ["Name and email address", "**You give it** when you sign up. If you use Continue With Google, Google supplies it.", "Firebase Authentication and your account record"],
            ["Password", "**You give it** when you sign up with email. It is not needed if you use Google.", "Firebase Authentication only — not in the platform's own records"],
            ["Profile photo link", "**Google supplies it** if you sign in with Google. The platform has no photo upload.", "Your account record"],
            ["Phone number and organisation", "**You give them**, if you choose to, in Profile → Settings.", "Your account record"],
            ["Roll number", "**Created by the platform** when you press Sync, or set by an administrator.", "Your account record"],
            ["Account status and course enrolments", "**Set by administrators.** Course enrolments are made in the Tech Verse Course, not on this platform.", "Your account record"],
            ["Exam attempts and results", "**Created when you submit an exam:** scores, counts, time taken, dates and the answers you selected.", "Your results record in the database"],
            ["Review of questions you got wrong", "**Created when you submit an exam.** Removed after 48 hours.", "Your results record in the database"],
            ["Performance summary", "**Calculated from your results.**", "Your summary record in the database"],
            ["Exam start counter", "**Counted by the platform** each time you press Start on an exam.", "A record for you and that exam in the database"],
            ["Activity-log entries", "**Written when an administrator** changes your roll number or activates or deactivates your account.", "The administrators' activity log in the database"],
            ["Emails to support", "**You give them** when you write to {email}.", "The support mailbox"],
            ["Saved exam attempt, reminders and small preferences", "**Created on your device** while you use the platform.", "Your browser's storage, on your device"],
            ["Sign-in session", "**Created by Firebase** when you log in.", "Your browser's storage, on your device"],
          ],
        } },
        { h: "Technical information" },
        "Whenever a browser asks a website for a page, the servers receive technical details such as an IP address, the type of browser and device, and the time of the request. For this platform that happens at the hosting provider and at the Google services it relies on (see [Data Storage and Service Providers](#/privacy?section=storage-providers)). The platform's own code does not read, store or analyse these details.",
        { h: "What the platform does not collect" },
        "The platform's own code does not ask for, and has no field for:",
        { ul: [
          "payment card or bank details;",
          "government ID numbers, your home address, your date of birth or your gender;",
          "your location — the platform never asks your browser for it;",
          "camera, microphone or screen recordings — the platform does not watch you while you take an exam;",
          "advertising identifiers or analytics about how you browse — the platform's own code has no advertising or analytics scripts; and",
          "your contacts, files or other data from your device.",
        ] },
      ],
    },

    /* ---------------------------------------------------------------- 4 */
    {
      id: "account-information", title: "Account and Authentication Information",
      blocks: [
        "You can create an account in two ways. Both are handled by **Firebase Authentication**, a sign-in service from Google.",
        { dl: [
          ["Email and password", "You enter your name, your email address and a password of at least 6 characters. The password is sent to Firebase Authentication. The platform's own account record does not contain it."],
          ["Continue With Google", "You sign in through a Google pop-up. Google tells the platform your name, your email address and the link to your profile photo. The platform never receives your Google password."],
          ["Forgot password?", "If you ask for a reset, Firebase sends a reset email to the address you entered. The platform gives the same answer whether or not an account exists for that address, so the page does not reveal who has an account. To limit repeat requests it holds back a new email for a short time, and that waiting time is remembered on your device."],
          ["Staying signed in", "Firebase keeps you signed in on your device until you sign out (see [Cookies, Local Storage and Similar Technologies](#/privacy?section=device-storage)). On a shared or public computer, always choose Sign Out when you finish."],
        ] },
        "Firebase Authentication also keeps its own technical record of each account — for example which sign-in method it uses and when it was created and last used. Google manages that record, not the platform's own code.",
        "The only emails the platform triggers are password-reset emails, which Firebase sends when you ask for one.",
      ],
    },

    /* ---------------------------------------------------------------- 5 */
    {
      id: "profile-data", title: "Profile and Account Data",
      blocks: [
        "When you create an account, the platform creates an **account record** for you in its database. It holds:",
        { ul: [
          "your name, as you typed it or as Google supplies it;",
          "your email address;",
          "a link to your Google profile photo, if you signed in with Google;",
          "your phone number and organisation, if you have added them;",
          "your roll number, once you have one;",
          "whether your account is active, whether it belongs to an administrator, and the courses you are enrolled in — all set by administrators; and",
          "the date the account was created.",
        ] },
        "You can change your name, phone number and organisation yourself in [Profile → Settings](#/profile?view=settings). Your email address and roll number are read-only. A roll number is a sequential number that is assigned once; only an administrator can change it.",
        "The exam platform and the Tech Verse Course website use the same account record. The details you change here are the details the course website holds, and the course website may add information of its own to the record.",
        "Inside the platform your name and profile photo (or your initials) show that you are signed in. Your name — and, depending on the leaderboard setting, your roll number and photo — may be shown to other students on a published leaderboard. See [Data Sharing and Disclosure](#/privacy?section=sharing).",
      ],
    },

    /* ---------------------------------------------------------------- 6 */
    {
      id: "exam-data", title: "Exam Attempts, Results and Performance Information",
      blocks: [
        "This is information the platform **creates** while you use it, rather than information you type in.",
        { h: "When you start an exam" },
        "The platform adds one to a counter kept for you and that exam, and notes the time of your latest start. Administrators use these counters to see how many attempts were started but never finished. While the exam runs, a copy of the attempt — the questions, your answers and the time left — is kept on your device, so a refresh or a lost connection does not lose your work (see [Cookies, Local Storage and Similar Technologies](#/privacy?section=device-storage)).",
        { h: "When you submit an exam" },
        "The platform scores your answers and saves a **results record**. There is one record for each exam you take, and it holds all your attempts at that exam. It contains:",
        { ul: [
          "the exam's title and whether it is a live or a practice exam;",
          "for every attempt: your score, the total, your percentage, the number of correct, wrong and unanswered answers, whether negative marking applied, the time you took and when you submitted;",
          "the answers you selected; and",
          "a **review** of the questions you answered wrongly or skipped: the question, its options, the correct answer, the explanation and the option you chose.",
        ] },
        "The record is linked to your account by an identifier. Your name and email address are not copied into it.",
        "The review is removed after 48 hours (see [Data Retention](#/privacy?section=retention)). The platform keeps the latest 30 attempts for each exam; when another is saved, the oldest is dropped, and only the most recent attempts keep a review.",
        { h: "Performance summary" },
        "From your results the platform keeps one **summary record** for you, so that Home, Results and My Performance load quickly. For each exam it holds the number of attempts, your latest and best percentage, how many answers were correct, wrong and unanswered and how long you took in your latest attempt, the exam's title and type, the date of your latest attempt and, for practice exams, your recent scores for the progress chart. It adds nothing that is not already in your results.",
        { h: "On the result screen" },
        "When an exam shows one question at a time, the platform measures the time you spend on each question and uses it on your result screen and in the PDF report. This per-question timing is not saved to the database. The PDF is created in your browser when you choose Save as PDF in the print dialog; the platform does not upload it.",
      ],
    },

    /* ---------------------------------------------------------------- 7 */
    {
      id: "how-we-use", title: "How Information Is Used",
      blocks: [
        "The platform uses the information described above only to run the platform:",
        { ul: [
          "to let you create an account, sign in and recover your password;",
          "to decide which exams you can see and start — for example whether your account is active, whether you are enrolled in an exam's course and how many attempts you have left;",
          "to score your exams, store your results and show them to you, including the review, the performance pages and the PDF report;",
          "to show your reminders and notifications;",
          "to work out and publish leaderboard rankings;",
          "to let administrators manage students, exams and results, and to see how exams are going — for example how many students started an exam and how many finished it;",
          "to keep the platform working and secure, and to look into a problem you report; and",
          "to answer the emails you send to support.",
        ] },
        "The platform shows no advertising, and it does not use your information to profile you for advertising.",
      ],
    },

    /* ---------------------------------------------------------------- 8 */
    {
      id: "storage-providers", title: "Data Storage and Service Providers",
      blocks: [
        "The platform does not run its own servers for your data. It is built on services from other companies:",
        { dl: [
          ["Firebase Authentication (Google)", "Holds your sign-in details and sends password-reset emails."],
          ["Cloud Firestore (Google)", "The database that holds account records, results, performance summaries, leaderboard lists and the platform's exams and announcements."],
          ["Web hosting", "Delivers the website from {site}. {owner:hostingLogs}"],
          ["Google Fonts, Font Awesome and Firebase code", "Your browser loads the typeface from Google Fonts, the icons from the cdnjs network and the code that talks to Firebase from Google's servers. Those servers therefore receive your IP address, as any website you visit would."],
        ] },
        { h: "Where the data is kept" },
        "Account records, results and the other database records described in this policy are stored in the platform's Cloud Firestore database, in this region: {owner:dataLocation}. It is the same Firebase project that the Tech Verse Course website uses.",
        "Because these services are run by other companies, some of your information may also be handled on their systems in other places. Their policies, linked under [Third-Party Services and External Links](#/privacy?section=third-parties), say more.",
      ],
    },

    /* ---------------------------------------------------------------- 9 */
    {
      id: "sharing", title: "Data Sharing and Disclosure",
      blocks: [
        "The platform shows no advertising and has no feature that sells your information or passes it to advertisers.",
        { h: "Who can see what" },
        { table: {
          caption: "Who can see which information",
          cols: ["Who", "What they can see"],
          rows: [
            ["You", "Your account record, your results and review (while it is kept), your performance summary and your reminders."],
            ["Administrators", "Student accounts and their details — name, email address, phone number, organisation, roll number and courses — together with results, attempt counts, exam-start counters and the administrators' activity log. Administrators manage exams and students: they can set a roll number and activate or deactivate an account, and they can export student lists as spreadsheet files."],
            ["Other students", "Nothing from your account or results. They see only what a published leaderboard shows (below)."],
            ["People who are not signed in", "No account or result data. Those records can be read only by the signed-in owner and by administrators."],
          ],
        } },
        { h: "The leaderboard" },
        "The leaderboard ranks students by the average of their best result in each live exam. Practice exams do not count. It is **published by an administrator** — it is not updated live — and every signed-in student can open the published lists. For each student in a list the platform shows the name, the percentage, the number of live exams and the score, and — depending on the setting below — the roll number and profile photo.",
        "Administrators choose how names appear for everybody:",
        { dl: [
          ["Full", "Name, roll number and profile photo (where there is one). This is the platform's default setting."],
          ["First name and initial", "A shortened name, without roll number or photo."],
          ["Hidden", "Nothing is published."],
        ] },
        "The lists never show anyone's individual answers. Each student also sees their own position, which the platform works out from a list of percentages that carries no names. There is no personal opt-out: how names appear is decided for the whole platform. If you have a concern about how you appear, email {email}.",
        { h: "Service providers and the law" },
        "The services listed under [Data Storage and Service Providers](#/privacy?section=storage-providers) handle information on the platform's behalf. The platform may also have to disclose information if a court or another authority lawfully requires it.",
      ],
    },

    /* ---------------------------------------------------------------- 10 */
    {
      id: "device-storage", title: "Cookies, Local Storage and Similar Technologies",
      blocks: [
        "**Cookies.** The platform's own code does not set cookies. The sign-in and database services it relies on may store their own data in your browser; their policies apply to that.",
        "**Local storage and session storage.** The platform keeps a few small items in your browser. They stay on your device. The names of the platform's own items begin with “tvexam”.",
        { table: {
          caption: "Items the platform and its services keep in your browser",
          cols: ["Item", "What it holds", "How long it stays"],
          rows: [
            ["Saved exam attempt", "A copy of an exam in progress — the questions, your answers and the time left — so a refresh does not lose your work. A small marker also shows which browser tab is running the exam.", "Until the attempt is stored in the database. An unfinished attempt whose time ran out can still be submitted for 7 days; a finished attempt that could not be stored, for 3 days."],
            ["Reminders", "The exams you pressed Remind me on.", "Tidied away about a day after the exam starts."],
            ["Notification state", "Which notifications you have read or dismissed, and the reminder messages shown on this device.", "Until you clear site data; old entries are tidied away automatically."],
            ["Browser-notification prompt", "A note that the platform has already asked you about browser notifications.", "Until you clear site data."],
            ["“What's new” notice", "Which version of the notice you have already seen.", "Until you clear site data."],
            ["Result-screen theme", "Whether you chose the light or the dark look for your result screen.", "Until you clear site data."],
            ["Password-reset wait", "The email address you asked a reset for, and when the next email may be requested.", "Until you clear site data. It matters only during the short waiting time."],
            ["After-login destination (session storage)", "The page you were trying to open before you were asked to log in.", "Until you log in or close the browser tab."],
            ["Server clock (session storage)", "The difference between your device's clock and the platform's clock, so countdowns are right. The platform reads the server's time with one small request to its own address.", "Until you close the browser tab."],
            ["Sign-in session", "Kept by Firebase Authentication so that you stay signed in.", "Until you sign out or clear site data."],
            ["Offline copy of records", "Kept by the database service: a copy of records you have recently viewed, such as your profile, your results and the exam list, so pages load faster and cope with a weak connection.", "Until you clear site data."],
          ],
        } },
        "While you use the platform it also keeps some data in the page's memory for a few minutes, so it does not ask the database again and again. That memory is cleared when you sign out or close the page.",
        { note: "On a shared or public computer, sign out when you finish. The offline copy of records may stay in the browser after you sign out, so use a private window for the session or clear the site's data in your browser settings.", tone: "warn" },
        "**You are in control.** You can clear this data in your browser's settings at any time. Doing so signs you out, removes your reminders and read marks, and deletes any copy of an exam attempt that has not yet been saved to the database — so finish and submit your exam first.",
        "A private or incognito window may block local storage. In that case an exam in progress cannot be saved on your device.",
      ],
    },

    /* ---------------------------------------------------------------- 11 */
    {
      id: "security", title: "Data Security",
      blocks: [
        "The platform depends on the security features of the services it is built on, and adds some measures of its own:",
        { ul: [
          "**Sign-in** is handled by Firebase Authentication. The platform's own records do not contain passwords.",
          "**Database rules** limit who can read what. Your account record, results, performance summary and exam-start record can be read only by you and by administrators.",
          "**Connections:** the website address and the Firebase services it connects to use HTTPS.",
          "**Signing out** clears what the platform keeps in memory for your account.",
        ] },
        "No website or online service can promise perfect security, and this platform cannot either. If you think someone else has used your account, change your password at once and email {email}.",
        { h: "What you can do" },
        { ul: [
          "Choose a password you do not use anywhere else, and keep it to yourself. Nobody needs your password to help you, so never send it to anyone — not even to support.",
          "Sign out when you finish on a shared or public computer.",
          "Keep your browser up to date.",
          "To report a security problem, email {email} and say what you found and where. Please do not include passwords, and do not look at other people's data while investigating.",
        ] },
      ],
    },

    /* ---------------------------------------------------------------- 12 */
    {
      id: "retention", title: "Data Retention",
      blocks: [
        "The platform sets only a few automatic limits on how long information stays. This is what it does today:",
        { table: {
          caption: "How long information stays",
          cols: ["Information", "What happens"],
          rows: [
            ["Review of questions you got wrong", "No longer shown 48 hours after you submit, and removed from the database the next time you open My Results."],
            ["Attempt history", "The latest 30 attempts for each exam are kept. When another is saved, the oldest is dropped."],
            ["Items on your device", "Tidied away automatically, or kept until you clear your browser's site data. See [Cookies, Local Storage and Similar Technologies](#/privacy?section=device-storage)."],
            ["Account record, results record, performance summary and exam-start counters", "The platform's code does not delete these on a schedule. They stay until they are removed — by an administrator, or after a request (see [User Rights and Account Controls](#/privacy?section=your-rights))."],
            ["Inactive accounts", "The platform's code does not close or delete them."],
            ["Administrators' activity log", "Kept until a super administrator deletes old entries. There is no fixed period."],
          ],
        } },
        "The period for which the operator keeps account and result records: {owner:retention}",
      ],
    },

    /* ---------------------------------------------------------------- 13 */
    {
      id: "your-rights", title: "User Rights and Account Controls",
      blocks: [
        { h: "What you can do yourself" },
        { ul: [
          "**See your information** — your details in [Profile](#/profile), your results in [Results](#/results) and your progress in [My Performance](#/performance).",
          "**Correct your details** — edit your name, phone number and organisation in [Profile → Settings](#/profile?view=settings).",
          "**Change your password** — in Profile → Settings, or with **Forgot password?** on the [login page](#/login). If you use Google sign-in, your password is managed by Google.",
          "**Sign out** — choose **Sign Out** in the menu, or **Log Out** on your profile page.",
          "**Clear what is stored on your device** — in your browser's settings. See [Cookies, Local Storage and Similar Technologies](#/privacy?section=device-storage).",
          "**Choose reminders and alerts** — reminders exist only for exams where you pressed **Remind me**, and browser notifications appear only if you allow them in your browser.",
        ] },
        { h: "What you can ask us to do" },
        "The platform has no delete button, no data-download tool and no request form. To correct something you cannot change yourself (such as your email address or roll number), to ask what the platform holds about you, or to ask for your account or information to be removed, email {email} from the address you registered with. [This ready-made email](" + REQUEST_MAIL + ") has the details we need.",
        "How requests are handled, and how long they take: {owner:deletion}",
        "To protect your account, we may ask you to confirm who you are before acting on a request. Because the exam platform and the Tech Verse Course website share one account record, a request may also affect your account on the course website.",
        { h: "Other rights under the law" },
        "Depending on where you live, data-protection law may give you further rights, for example to access, correct or erase your information. The laws that apply to this platform, and the rights they give you: {owner:dataLaw}",
      ],
    },

    /* ---------------------------------------------------------------- 14 */
    {
      id: "children", title: "Children’s Privacy",
      blocks: [
        "{name} is meant for students. Who may use it: {owner:minimumAge}",
        "The platform does not ask for a date of birth or an age, so it cannot tell how old a student is.",
        "If you are a parent or guardian and you believe a child has an account that you did not agree to, email {email} so that the matter can be looked into.",
      ],
    },

    /* ---------------------------------------------------------------- 15 */
    {
      id: "third-parties", title: "Third-Party Services and External Links",
      blocks: [
        "The platform relies on services from other companies. Each has its own privacy policy, which governs what it does with the information it receives.",
        { dl: [
          ["Google — Firebase Authentication, Cloud Firestore, Google sign-in and Google Fonts", "Read the [Google Privacy Policy](https://policies.google.com/privacy) and the [Firebase privacy information](https://firebase.google.com/support/privacy)."],
          ["cdnjs — Font Awesome icons", "The icon files are delivered by the cdnjs network. Its own privacy policy applies to that."],
          ["Web hosting provider", "{owner:hostingLogs}"],
        ] },
        { h: "Links to other websites" },
        "Some pages link to websites outside the platform — for example to Google's privacy information. The platform does not control those websites and is not responsible for what they do with your information. Read their policies before you share anything with them.",
      ],
    },

    /* ---------------------------------------------------------------- 16 */
    {
      id: "updates", title: "Policy Updates",
      blocks: [
        "The platform changes over time, and this policy will change with it. The “Last updated” date at the top of this page shows when the wording last changed. An updated policy applies from that date.",
        "If a change matters to you, the platform may say so in its “What's new” notice or in your notifications. Checking this page from time to time is the surest way to stay informed.",
      ],
    },

    /* ---------------------------------------------------------------- 17 */
    {
      id: "contact", title: "Contact",
      blocks: [
        "For questions about this policy, or to ask about your information, write to us. Support is by email only, and no reply time is promised.",
        { dl: [
          ["Email", "{email}"],
          ["Website", "{site}"],
          ["Operator", "{owner:operator}"],
        ] },
        "Please include your name and the email address of your account, and say what you would like to know or change. Never include your password. [A ready-made email](" + REQUEST_MAIL + ") is one click away, and the [Help Center](#/help?section=contact) explains what else helps us look into a problem.",
      ],
    },
  ],

  /** Shown below the last section. */
  footer: [
    "See also: [Terms & Conditions](#/terms) · [FAQ](#/faq) · [Help Center](#/help).",
  ],
};
