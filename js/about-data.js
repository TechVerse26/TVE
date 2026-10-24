// ==========================================================================
// about-data.js — the words on the About Us page (#/about). Edit the text here; the layout lives in page-about.js.
//
// Everything below describes what the platform really does today. There is no company history, no number, no award,
// no partnership and no certification in it — none of those are stated anywhere in the project, so none are claimed.
// The mission, vision and values are drafted from how the platform behaves: replace them with your own wording any time.
//
// Text may use  **bold**  ·  [label](#/route)  ·  {email}  (see info-core.js). icon = a Font Awesome solid icon name.
// ==========================================================================
export const ABOUT = {
  hero: {
    kicker: "About Us",
    title: "About Tech Verse Exam",
    lead: "An online exam platform for Tech Verse students — practise at your own pace, sit scheduled exams and see exactly how you are doing.",
  },

  story: {
    title: "Our Story",
    sub: "Why the platform exists and what it is built around.",
    paragraphs: [
      "Tech Verse Exam is the examination side of Tech Verse. Students of the Tech Verse Course sign in here with the same account to test what they have learned — in scheduled live exams, or in practice exams that are always open.",
      "The platform is built around three simple ideas. **Fair timing:** exam windows follow a server clock, not the clock on your phone. **Safe progress:** an attempt in progress is saved on your device, so a refresh or a closed app does not lose your answers. **Useful results:** every submission comes with a clear score, a review of the questions you missed and a history you can look back on.",
    ],
    glanceTitle: "At a glance",
    glance: [
      { icon: "fa-file-pen", title: "Two kinds of exam", text: "Scheduled live exams and practice exams that are always open." },
      { icon: "fa-clock", title: "One fair clock", text: "Opening and closing times follow the server’s time." },
      { icon: "fa-square-poll-vertical", title: "Instant feedback", text: "A score on submission, plus a review of the questions you missed." },
      { icon: "fa-mobile-screen", title: "Works on any screen", text: "Designed for phones, tablets and computers." },
    ],
  },

  purpose: [
    { id: "mission", icon: "fa-bullseye", title: "Our Mission", text: "To give every Tech Verse student a fair, clear and low-pressure way to test what they know — and to show them, with real results, what to work on next." },
    { id: "vision", icon: "fa-binoculars", title: "Our Vision", text: "A learning journey where practice, feedback and progress sit side by side, so every student can see how far they have come." },
  ],

  offer: {
    title: "What We Offer",
    sub: "Four things, done properly.",
    items: [
      { icon: "fa-satellite-dish", tone: "coral", title: "Live exams", text: "Scheduled exams with a fixed opening and closing time and a visible timer. Where an exam sets them, negative marking and an attempt limit apply." },
      { icon: "fa-clipboard-check", tone: "teal", title: "Practice exams", text: "Always open and free of negative marking, so you can practise whenever it suits you." },
      { icon: "fa-square-poll-vertical", tone: "green", title: "Results and review", text: "An instant score, a review of the questions you missed (kept for 48 hours) and a printable PDF report on the result screen." },
      { icon: "fa-ranking-star", tone: "amber", title: "Progress and leaderboard", text: "A summary of every exam you have taken, and a leaderboard ranked by each student’s best live-exam results." },
    ],
  },

  features: {
    title: "Key Platform Features",
    sub: "What you can do on the platform today.",
    items: [
      { icon: "fa-calendar-days", title: "Exam schedule", text: "See upcoming, live and past exams in one timetable, shown in your own time zone." },
      { icon: "fa-bell", title: "Notices and reminders", text: "Notices and exam alerts in the notification centre, plus optional reminders before an exam starts." },
      { icon: "fa-shuffle", title: "Randomised questions", text: "Exams can shuffle questions and answer options, or draw a different set of questions for each attempt." },
      { icon: "fa-floppy-disk", title: "Auto-save and resume", text: "Answers are saved on your device as you go, so you can resume an unfinished attempt." },
      { icon: "fa-stopwatch", title: "Server-based timing", text: "Exam windows and countdowns follow the server clock, not your device’s." },
      { icon: "fa-chart-column", title: "Result analysis", text: "Correct, wrong and unanswered counts, time used and a comparison with your previous attempt." },
      { icon: "fa-chart-line", title: "My Performance", text: "Your average, best score and pass rate, with a line for every exam you have taken." },
      { icon: "fa-trophy", title: "Leaderboard", text: "Top performers overall and exam by exam, plus your own position." },
      { icon: "fa-layer-group", title: "Courses and categories", text: "Find exams by course, subject or category, or search and filter the full list." },
    ],
  },

  how: {
    title: "How It Works",
    sub: "From sign-up to feedback in four steps.",
    steps: [
      { title: "Create your account", text: "Sign up with your name, email and a password, or continue with Google. Use the same email as your Tech Verse Course." },
      { title: "Find an exam", text: "Browse All Exams, a course or the schedule. Live exams open at a set time; practice exams are always open." },
      { title: "Take the exam", text: "Read the rules, press Start and answer before the timer ends. Your progress is saved on your device." },
      { title: "Review and improve", text: "See your score straight away, review your mistakes and follow your progress in Results and Performance." },
    ],
  },

  commitment: {
    title: "Our Commitment to Students",
    sub: "How we try to treat the people who use the platform.",
    items: [
      { icon: "fa-scale-balanced", title: "Fair timing", text: "Exam windows and countdowns are judged against the server clock, so everyone plays by the same time." },
      { icon: "fa-eye", title: "No surprises", text: "You see an exam’s duration, marks, pass mark and rules before you press Start." },
      { icon: "fa-circle-check", title: "Honest results", text: "Scores and analysis come from your real attempt data. When something cannot be known, the page says so instead of inventing a number." },
      { icon: "fa-lock", title: "Care with your data", text: "The [Privacy Policy](#/privacy) explains what is stored and why. The platform carries no advertising or tracking scripts." },
      { icon: "fa-headset", title: "Help when you need it", text: "Find answers in the [Help Center](#/help) and the [FAQ](#/faq), or email {email}." },
    ],
  },

  accessibility: {
    title: "Accessible Learning",
    sub: "Everyone should be able to prepare for and sit an exam comfortably.",
    intro: "We design with accessibility in mind and keep improving it. Here is what is in place today:",
    points: [
      "Layouts adapt to phones, tablets and computers.",
      "Buttons and links are sized for touch and show a clear outline when you move through the page with a keyboard.",
      "Pages use headings, labels and descriptions that assistive technology can read.",
      "Movement is kept small, and it is reduced when your device asks for less motion.",
      "The result screen offers a light and a dark theme.",
    ],
    note: "This page does not claim conformance with any accessibility standard. If something gets in your way, email {email} and tell us which page and device you were using, so it can be looked into.",
  },

  values: {
    title: "Our Values",
    sub: "The principles behind the decisions.",
    items: [
      { icon: "fa-scale-balanced", title: "Fairness", text: "Every student is measured by the same rules and the same clock." },
      { icon: "fa-lightbulb", title: "Clarity", text: "Rules, scores and feedback are shown plainly, in words you can act on." },
      { icon: "fa-user-shield", title: "Privacy", text: "We keep what we store to what the platform needs, and we explain it." },
      { icon: "fa-handshake", title: "Honesty", text: "We say what the platform can and cannot do." },
      { icon: "fa-universal-access", title: "Inclusion", text: "Learning tools should be usable by as many students as possible." },
      { icon: "fa-seedling", title: "Growth", text: "Practice, review and progress belong together, and the platform keeps improving with students in mind." },
    ],
  },

  cta: {
    title: "Ready to try an exam?",
    textSignedOut: "Create an account to start taking exams. Already registered? [Log in](#/login) and pick up where you left off.",
    textSignedIn: "Pick an exam and start, or look back at how you have done so far.",
  },
};
