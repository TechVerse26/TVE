// ==========================================================================
// whats-new-data.js — what the "What's new" popup says. ONE release at a time (the latest).
//
// To announce a new update later:
//   1. change `version` (any new text — a date is easiest) and `date`,
//   2. rewrite `title`, `lead` and `items`.
// Every user (signed in or not) then sees the popup once more, the next time they open the site.
// Set `enabled: false` to switch the popup (and the "What's New" entry in Profile) off completely.
//
// icon = any Font Awesome solid icon name · tone = blue | purple | green | orange | teal | red
// ==========================================================================
export const WHATS_NEW = {
  enabled: true,
  version: "2026-10-17",
  date: "2026-10-17",
  title: "Tech Verse Exam-এ নতুন কী আছে",
  lead: "পুরো প্ল্যাটফর্ম নতুন চেহারায় — আরও সহজ, দ্রুত ও আধুনিক।",
  items: [
    { icon: "fa-palette", tone: "blue", title: "নতুন ডিজাইন", text: "নীল ও নেভি থিমে সব পেজ একই স্টাইলে — ফোনে ও কম্পিউটারে সমান সুন্দর।" },
    { icon: "fa-house", tone: "purple", title: "নতুন হোম পেজ", text: "সার্চ বার, Popular Categories ও How It Works — যা খুঁজছেন এক ট্যাপেই।" },
    { icon: "fa-layer-group", tone: "green", title: "All Categories", text: "বিষয় ও ক্যাটাগরি ধরে পরীক্ষা খুঁজুন এবং সরাসরি Start Exam করুন।" },
    { icon: "fa-calendar-days", tone: "orange", title: "Schedule এক ট্যাপে", text: "উপরের ক্যালেন্ডার আইকন থেকে যেকোনো পেজ থেকেই পরীক্ষার সময়সূচি দেখুন।" },
    { icon: "fa-stopwatch", tone: "teal", title: "নতুন পরীক্ষার স্ক্রিন", text: "টাইমার, প্রগ্রেস বার ও সবুজ সিলেক্ট — প্রশ্ন ও অপশন আরও পরিষ্কার।" },
    { icon: "fa-chart-column", tone: "blue", title: "রেজাল্টে “বিস্তারিত ফলাফল দেখুন”", text: "এক ট্যাপে সময়, সঠিক-ভুল ও বিষয়ভিত্তিক বিশ্লেষণ।" },
    { icon: "fa-user-gear", tone: "red", title: "নতুন প্রোফাইল ও Settings", text: "প্রোফাইল পেজ নতুন রূপে; পাসওয়ার্ড বদল ও তথ্য এডিট এখন Settings-এ।" },
  ],
};
