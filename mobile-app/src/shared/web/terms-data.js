// ==========================================================================
// terms-data.js — the TEXT of the Terms & Conditions (#/terms). Edit the wording here.
//
// The rules about exams (checks before a start, the timer, locked answers, attempts, scoring, the leaderboard) describe what the
// platform really does today — they were read from the code. What only the owner can know (who operates the site, the minimum
// age, who owns the exam content, which law applies) is NOT invented: it uses {owner:key} and prints a marked "To be confirmed"
// note until the owner types the confirmed text into info-config.js → OWNER_DETAILS.
//
// Nothing here promises uninterrupted service, perfect accuracy, permanent storage or any outcome — and nothing claims that a
// clause is enforceable. It is a plain-language draft: the operator should have it reviewed by a legal adviser before relying on it.
//
// Mark-up (see info-core.js):  **bold** · [label](#/route · https://… · mailto:…) · {email} {site} {name} {owner:key}
// Blocks: "paragraph" · { h } · { ul } · { ol } · { note, tone } · { dl } · { table }
// The "Last updated" date is LEGAL_DATES.terms in info-config.js — change it whenever this wording changes.
// ==========================================================================
import { SITE } from "./info-config.js";
import { mailtoHref } from "./info-core.js";

/** A ready-made email for a problem with an exam, a score or an account. */
const PROBLEM_MAIL = mailtoHref({
  to: SITE.email,
  subject: "Tech Verse Exam — exam or result problem",
  body: ["Hello,", "", "Name:", "Email address of my account:", "Exam name:", "Date and time it happened:", "", "What happened:", "", "(Please do not write your password in this email.)"].join("\n"),
});

export const TERMS = {
  kicker: "Legal",
  title: "Terms & Conditions",
  lead: "The rules for using Tech Verse Exam — for students and for everyone else who uses the platform.",

  /** Shown above section 1: the short version. */
  intro: [
    { ul: [
      "**Your account is yours.** Keep your password safe, and never let anyone else take an exam for you.",
      "**Exams have rules.** Each exam shows its rules before you start, and the timer cannot be paused.",
      "**Results are automatic.** Scores and rankings follow fixed rules. Mistakes can happen — tell us if you spot one.",
      "**No guarantees.** The platform can be unavailable at times, and it promises no particular outcome.",
    ] },
  ],

  sections: [
    /* ---------------------------------------------------------------- 1 */
    {
      id: "acceptance", title: "Acceptance of Terms",
      blocks: [
        "These Terms & Conditions (“Terms”) govern your use of {name} at {site} (“the platform”). The platform is operated by {owner:operator} (“we”, “us”).",
        "By creating an account, logging in or otherwise using the platform, you agree to these Terms. If you do not agree, please do not use the platform.",
        "Please read the Terms together with the [Privacy Policy](#/privacy), which explains what information the platform keeps and why.",
      ],
    },

    /* ---------------------------------------------------------------- 2 */
    {
      id: "eligibility", title: "Eligibility and Registration",
      blocks: [
        "Who may use the platform: {owner:minimumAge}",
        "You need an account to take exams. You can register with your name, an email address and a password, or with Continue With Google.",
        "Some exams are open only to students who are enrolled in a course. The sign-up page asks you to use the email address you used to enrol in the Tech Verse Course, so that your enrolment is recognised.",
        "Give accurate details and keep them up to date. You can edit your name, phone number and organisation in [Profile → Settings](#/profile?view=settings). Your email address and roll number are set by the platform and cannot be edited by you.",
        "Your account is for you. Do not create an account in someone else's name, and do not use an email address that is not yours.",
      ],
    },

    /* ---------------------------------------------------------------- 3 */
    {
      id: "account-security", title: "Account Security and Responsibilities",
      blocks: [
        "You are responsible for what happens under your account. That means:",
        { ul: [
          "keeping your password to yourself, and never sending it to anyone — not even to support;",
          "signing out when you finish on a shared or public computer;",
          "not sharing your account, and not letting anyone else take an exam for you; and",
          "if you use Continue With Google, keeping your Google account secure too.",
        ] },
        "If you think someone else has used your account, change your password at once and email {email}.",
      ],
    },

    /* ---------------------------------------------------------------- 4 */
    {
      id: "acceptable-use", title: "Acceptable Use",
      blocks: [
        "You agree not to:",
        { ul: [
          "use the platform to break the law or to harm other people;",
          "try to reach accounts, exams, results or data that are not yours, or to get round the platform's access rules;",
          "disturb the platform or the services it relies on — for example by overloading it, probing it for weaknesses or introducing harmful code;",
          "use scripts, bots or other automatic tools to take exams, copy content or collect data from the platform;",
          "give false information, or use another person's name, email address or identity; or",
          "send abusive or harmful messages to support.",
        ] },
        "If you find a security problem, please report it to {email} instead of using it. Do not include passwords, and do not look at other people's data while investigating.",
      ],
    },

    /* ---------------------------------------------------------------- 5 */
    {
      id: "exam-participation", title: "Examination Participation and Rules",
      blocks: [
        { h: "Starting an exam" },
        "Whether you can start an exam depends on checks the platform makes when you press Start: your account must be active, you must be enrolled in the exam's course (if the exam belongs to one), the exam must be open at that time, and you must have an attempt left. Site maintenance, a cancelled schedule or stopped registration can also stop a start.",
        { h: "The rules of each exam" },
        "Every exam has a rules page that appears before you start. It shows the time limit, the total and pass marks, whether wrong answers lose marks (negative marking), the last time you can start, which attempt this will be and any instructions. Read it carefully. The rules shown for an exam apply to that exam, and by pressing **Start** you accept them.",
        { h: "While the exam runs" },
        { ul: [
          "The timer starts when you press Start and cannot be paused. It keeps running if you refresh, close the tab or lose your connection.",
          "When the time ends, your answers are submitted automatically.",
          "An answer you select is locked and cannot be changed afterwards. You can move between questions in any order.",
          "An exam can run in one browser tab at a time.",
          "While an exam is on screen, selecting, copying, dragging and printing the question text is blocked.",
        ] },
        { h: "Your device and connection" },
        "The platform saves your progress on your device as you go, so that a refresh does not lose your answers. It cannot guarantee that a device, a browser or a connection will keep working. Use a working device with a stable connection, and see the [Help Center](#/help?section=troubleshooting) if something goes wrong.",
      ],
    },

    /* ---------------------------------------------------------------- 6 */
    {
      id: "results", title: "Attempts, Scoring, Results and Leaderboard",
      blocks: [
        { h: "Attempts" },
        "Some exams limit the number of attempts. The rules page shows the limit and which attempt you are about to start. The platform checks the limit again when a result is saved, and once you have used all your attempts you cannot start another.",
        { h: "Scoring" },
        "Scores are calculated automatically by comparing your answers with the exam's answer key, using the marks and the negative-marking rule shown on the rules page. Questions you leave unanswered are not counted as correct.",
        { h: "Results" },
        "Your result appears when you submit. A saved result is listed in [Results](#/results). If a result cannot be stored straight away, the attempt waits on your device until it can be saved — keep using the same browser until it is. The review of questions you got wrong is available for 48 hours after you submit.",
        { h: "Mistakes" },
        "The platform tries to score correctly, but questions, answer keys and explanations can contain mistakes. If you think a question or a score is wrong, [email us](" + PROBLEM_MAIL + ") with the exam name, the question and the date. We may review it and may correct a question, a score or a ranking.",
        { h: "The leaderboard" },
        "The leaderboard ranks students by the average of their best result in each live exam; practice exams do not count (see [How is the leaderboard ranked?](#/faq?open=lb-rank-rule)). An administrator publishes it, so it may be out of date, and rankings can change when results are corrected or exams are added. Administrators decide how names appear (see the [Privacy Policy](#/privacy?section=sharing)).",
        "A result, a rank or a PDF report from the platform is a record of how you did on the platform. Unless the operator tells you otherwise, it is not an official certificate or qualification.",
      ],
    },

    /* ---------------------------------------------------------------- 7 */
    {
      id: "integrity", title: "Academic Integrity and Misconduct",
      blocks: [
        "Exams measure your own knowledge. You agree to:",
        { ul: [
          "take every exam yourself, without help from other people or from sources the exam does not allow;",
          "not let anyone else take an exam for you, and not use more than one account;",
          "not share exam questions or answers with other students while an exam is open;",
          "not try to read, copy, capture or print question text in a way the platform blocks; and",
          "not use scripts, bots or other tools to answer questions or to interfere with the timer, the attempt limit or the scoring.",
        ] },
        "The platform does not watch you while you take an exam — it has no camera or microphone access — so a concern about misconduct is looked at using the information the platform holds and what students and administrators report. If misconduct is found, we may act as described under [Account Restrictions and Suspension](#/terms?section=restrictions), for example by removing a result or a ranking.",
      ],
    },

    /* ---------------------------------------------------------------- 8 */
    {
      id: "content", title: "Content and Intellectual Property",
      blocks: [
        "Exam questions, answer keys, explanations, course material and the platform's design and code are provided for your personal study on the platform. Who owns them, and under what licence: {owner:contentOwnership}",
        "Unless the owner has given permission, do not copy, republish, sell or share exam questions, answers or explanations, or the platform's design or code.",
        "You keep any rights you have in the answers you submit. By submitting them you allow the platform to store and process them in order to score them, show you your results and run the leaderboard (see the [Privacy Policy](#/privacy?section=exam-data)).",
        "Third-party components used by the platform, such as Font Awesome icons, Google Fonts and Firebase, belong to their owners. See [Credits](#/credits).",
      ],
    },

    /* ---------------------------------------------------------------- 9 */
    {
      id: "availability", title: "Availability and Technical Interruptions",
      blocks: [
        "The platform is provided as it is. It can be unavailable or slow at times — for example during maintenance, when a service it relies on fails, or because of your own device or connection. The platform does not promise that it will be available at all times or free of errors.",
        "Exams are timed, and a technical problem can happen during one. The platform tries to keep your progress on your device and to save a finished attempt again when you are back online, but it cannot guarantee that this will work. If a problem affects your exam, [email us](" + PROBLEM_MAIL + ") as soon as you can with the exam name, the time and what happened. Whether anything can be done depends on the circumstances.",
        "Exam times can change, and times are shown in your own time zone. Check the [Schedule](#/schedule) before an exam.",
      ],
    },

    /* ---------------------------------------------------------------- 10 */
    {
      id: "restrictions", title: "Account Restrictions and Suspension",
      blocks: [
        "An administrator can deactivate an account. A deactivated account cannot start exams, and the platform shows “Account Disabled”.",
        "We may restrict, suspend or close an account, remove a result or a leaderboard entry, or limit access to an exam if you break these Terms or an exam's rules, if there is a security concern, or if the law requires it.",
        "If your account has been deactivated and you think this is a mistake, email {email}.",
        "You may stop using the platform at any time. To ask for your account or information to be removed, see [User Rights and Account Controls](#/privacy?section=your-rights) in the Privacy Policy, which also explains what happens to your information.",
      ],
    },

    /* ---------------------------------------------------------------- 11 */
    {
      id: "third-party", title: "Third-Party Services",
      blocks: [
        "The platform relies on services from other companies: Google's Firebase for sign-in and the database, Google Fonts, the cdnjs network for Font Awesome icons, and a web hosting provider. Google's own terms and policies also apply to Google sign-in.",
        "We are not responsible for those services. If one of them fails, parts of the platform may stop working. See [Third-Party Services and External Links](#/privacy?section=third-parties) in the Privacy Policy.",
        "The platform may link to other websites. They are not under our control, and their own terms apply when you use them.",
      ],
    },

    /* ---------------------------------------------------------------- 12 */
    {
      id: "platform-changes", title: "Changes to the Platform",
      blocks: [
        "The platform changes over time. Features, pages, exams, scoring and ranking rules and the way the platform looks can be added, changed or removed, and exams can be scheduled, rescheduled, cancelled or withdrawn.",
        "The [Help Center](#/help) and the [FAQ](#/faq) describe how the platform works today. Nothing in them is a promise that a feature or an exam will continue to be offered.",
      ],
    },

    /* ---------------------------------------------------------------- 13 */
    {
      id: "terms-changes", title: "Changes to These Terms",
      blocks: [
        "We may change these Terms. The “Last updated” date at the top of this page shows when the wording last changed, and an updated version applies from that date.",
        "If a change matters to you, the platform may say so in its “What's new” notice or in your notifications. If you do not agree with a change, stop using the platform.",
      ],
    },

    /* ---------------------------------------------------------------- 14 */
    {
      id: "disclaimers", title: "Disclaimers and Limitation of Liability",
      blocks: [
        "The platform is provided “as is” and “as available”. We do not promise that:",
        { ul: [
          "it will always be available, or work without interruption or errors;",
          "questions, answer keys, explanations, scores, rankings or other content will be free of mistakes;",
          "your results or other data will be stored permanently or can always be recovered; or",
          "using the platform will lead to any particular grade, score, rank, qualification, admission, job or other outcome.",
        ] },
        "To the extent the law allows, we are not responsible for loss that comes from things outside our reasonable control — such as the failure of a service the platform relies on, a problem with your device or connection, or someone else using your account because your password was not kept safe.",
        "Nothing in these Terms limits any right you have under the law that cannot be limited.",
        { h: "Governing law" },
        "The law that applies to these Terms, and where disputes are handled: {owner:governingLaw}",
      ],
    },

    /* ---------------------------------------------------------------- 15 */
    {
      id: "contact", title: "Contact",
      blocks: [
        "For questions about these Terms, or about an exam, a result or an account, write to us. Support is by email only, and no reply time is promised.",
        { dl: [
          ["Email", "{email}"],
          ["Website", "{site}"],
          ["Operator", "{owner:operator}"],
        ] },
        "Please include your name and the email address of your account. Never include your password. The [Help Center](#/help?section=contact) explains what else helps us look into a problem.",
      ],
    },
  ],

  /** Shown below the last section. */
  footer: [
    "See also: [Privacy Policy](#/privacy) · [FAQ](#/faq) · [Help Center](#/help).",
  ],
};
