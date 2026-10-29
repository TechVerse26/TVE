// ==========================================================================
// email-templates-data.js — the ready-to-edit starting points of the Email Center.
//
// Pure data + one tiny merge function (no DOM, no Firebase). Each template carries its words in English and in
// Bangla; "both" puts the English text first and the Bangla text after it.
// These are DEFAULTS, not hard-coded final e-mails: the admin edits everything in Compose before sending, and can
// save own versions (Firestore: emailTemplates).
//
// Rules the wording follows
//   • It only states what the records can prove: "no SUBMITTED RESULT has been recorded" — never "you did not take the exam".
//   • It invents no exam rules (nothing like "do not refresh the page" — the app can resume an exam after a refresh).
//   • Dates, times and the deadline come from variables, so a missing schedule blocks the send instead of being guessed.
//   • {{student_name|Student}}: the text after "|" is the fallback when a name is missing.
// ==========================================================================
import { emptyContent } from "./email-render.js";

const SUPPORT_EN = "If you believe this information is incorrect, please contact our support team at {{support_email}}.";
const SUPPORT_BN = "এই তথ্য ভুল মনে হলে অনুগ্রহ করে আমাদের সাপোর্ট টিমের সাথে যোগাযোগ করুন: {{support_email}}।";
const SIGN_EN = "Best regards,\nTech Verse Exam Team";
const SIGN_BN = "শুভেচ্ছান্তে,\nTech Verse Exam টিম";
const HI_EN = "Dear {{student_name|Student}},";
const HI_BN = "প্রিয় {{student_name|শিক্ষার্থী}},";

const ALL_INFO = ["name", "email", "roll", "course", "status", "attempts"];
const BASIC_INFO = ["name", "email", "roll", "course"];

/** type = the campaign type this template suits best. */
export const BUILTIN_TEMPLATES = Object.freeze([
  {
    id: "general", name: "General Announcement", type: "announcement", icon: "fa-bullhorn",
    desc: "সাধারণ ঘোষণা — আপনার বার্তা + শিক্ষার্থীর নিজের তথ্য।",
    en: {
      subject: "Important Announcement from Tech Verse Exam", greeting: HI_EN,
      message: "We would like to inform you of an important update from Tech Verse Exam.\n\n{{personal_message}}\n\nPlease check the official website for further information.",
      instructions: "", closing: "", signature: SIGN_EN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "Visit the website", ctaUrl: "{{website_url}}",
    },
    bn: {
      subject: "Tech Verse Exam-এর পক্ষ থেকে গুরুত্বপূর্ণ ঘোষণা", greeting: HI_BN,
      message: "Tech Verse Exam-এর পক্ষ থেকে আপনাকে একটি গুরুত্বপূর্ণ বিষয় জানানো হচ্ছে।\n\n{{personal_message}}\n\nআরও তথ্যের জন্য অনুগ্রহ করে আমাদের অফিসিয়াল ওয়েবসাইট দেখুন।",
      instructions: "", closing: "", signature: SIGN_BN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "ওয়েবসাইটে যান", ctaUrl: "{{website_url}}",
    },
  },
  {
    id: "important_notice", name: "Important Notice", type: "announcement", icon: "fa-triangle-exclamation",
    desc: "গুরুত্বপূর্ণ নোটিশ — নির্দেশনা বক্সসহ, শিক্ষার্থীর তথ্য ছাড়া।",
    en: {
      subject: "Important Notice | Tech Verse Exam", greeting: HI_EN,
      message: "Please read this notice carefully.\n\n{{personal_message}}",
      instructions: "Please visit the official website for the latest information.", closing: "", signature: SIGN_EN,
      showStudentInfo: false, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "Visit the website", ctaUrl: "{{website_url}}",
    },
    bn: {
      subject: "গুরুত্বপূর্ণ নোটিশ | Tech Verse Exam", greeting: HI_BN,
      message: "অনুগ্রহ করে এই নোটিশটি মনোযোগ দিয়ে পড়ুন।\n\n{{personal_message}}",
      instructions: "সর্বশেষ তথ্যের জন্য অফিসিয়াল ওয়েবসাইট দেখুন।", closing: "", signature: SIGN_BN,
      showStudentInfo: false, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "ওয়েবসাইটে যান", ctaUrl: "{{website_url}}",
    },
  },
  {
    id: "exam_not_attempted", name: "Exam Not Attempted Reminder", type: "exam_not_attempted", icon: "fa-user-clock",
    desc: "যাঁদের এই এক্সামের কোনো জমা দেওয়া ফলাফল নেই — শিক্ষার্থীর তথ্য ও এক্সামের তথ্যসহ।",
    en: {
      subject: "Reminder: You Have Not Completed Your Exam | Tech Verse Exam", greeting: HI_EN,
      message: "This is a friendly reminder regarding your examination, **{{exam_title}}**.\n\nAccording to the currently available examination records, no submitted result has been recorded for this examination under your account.\n\nPlease review the examination details below and follow the instructions.\n\n{{personal_message}}",
      instructions: "Please visit the official website for the latest instructions and examination availability.",
      closing: SUPPORT_EN, signature: SIGN_EN,
      showStudentInfo: true, infoFields: ALL_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "Open the exam", ctaUrl: "{{exam_url}}",
    },
    bn: {
      subject: "রিমাইন্ডার: আপনার পরীক্ষাটি এখনো সম্পন্ন হয়নি | Tech Verse Exam", greeting: HI_BN,
      message: "আপনার পরীক্ষা **{{exam_title}}** সম্পর্কে একটি বন্ধুত্বপূর্ণ রিমাইন্ডার।\n\nবর্তমানে উপলব্ধ পরীক্ষার রেকর্ড অনুযায়ী, আপনার অ্যাকাউন্টে এই পরীক্ষার কোনো জমা দেওয়া ফলাফল রেকর্ড করা নেই।\n\nঅনুগ্রহ করে নিচের পরীক্ষার তথ্য দেখে নির্দেশনা অনুসরণ করুন।\n\n{{personal_message}}",
      instructions: "সর্বশেষ নির্দেশনা ও পরীক্ষার সময়সূচির জন্য অফিসিয়াল ওয়েবসাইট দেখুন।",
      closing: SUPPORT_BN, signature: SIGN_BN,
      showStudentInfo: true, infoFields: ALL_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "পরীক্ষাটি খুলুন", ctaUrl: "{{exam_url}}",
    },
  },
  {
    id: "exam_started_not_submitted", name: "Started but Not Submitted Reminder", type: "exam_started_not_submitted", icon: "fa-hourglass-half",
    desc: "যাঁরা এক্সাম শুরু করেছেন কিন্তু জমার রেকর্ড নেই — “জমা দেননি” দাবি করে না, শুধু রেকর্ডের কথা বলে।",
    en: {
      subject: "Please review your exam status: {{exam_title}} | Tech Verse Exam", greeting: HI_EN,
      message: "Our records show that you started the examination **{{exam_title}}**, but no submitted result has been recorded for it under your account.\n\nIf your attempt was interrupted, please review the examination details below and follow the instructions. If you believe you have already submitted it, please check your results page.\n\n{{personal_message}}",
      instructions: "Please visit the official website for the latest instructions and examination availability.",
      closing: SUPPORT_EN, signature: SIGN_EN,
      showStudentInfo: true, infoFields: ALL_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "Review the exam", ctaUrl: "{{exam_url}}",
    },
    bn: {
      subject: "আপনার পরীক্ষার অবস্থা যাচাই করুন: {{exam_title}} | Tech Verse Exam", greeting: HI_BN,
      message: "আমাদের রেকর্ড অনুযায়ী আপনি **{{exam_title}}** পরীক্ষাটি শুরু করেছিলেন, কিন্তু আপনার অ্যাকাউন্টে এর কোনো জমা দেওয়া ফলাফল রেকর্ড করা নেই।\n\nআপনার অংশগ্রহণ মাঝপথে বন্ধ হয়ে থাকলে অনুগ্রহ করে নিচের পরীক্ষার তথ্য দেখে নির্দেশনা অনুসরণ করুন। আপনি যদি মনে করেন পরীক্ষাটি ইতিমধ্যে জমা দিয়েছেন, তাহলে আপনার ফলাফল পেজটি দেখুন।\n\n{{personal_message}}",
      instructions: "সর্বশেষ নির্দেশনা ও পরীক্ষার সময়সূচির জন্য অফিসিয়াল ওয়েবসাইট দেখুন।",
      closing: SUPPORT_BN, signature: SIGN_BN,
      showStudentInfo: true, infoFields: ALL_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "পরীক্ষাটি দেখুন", ctaUrl: "{{exam_url}}",
    },
  },
  {
    id: "exam_upcoming", name: "Upcoming Exam Reminder", type: "exam_upcoming", icon: "fa-calendar-check",
    desc: "আসন্ন বা চলমান এক্সামের রিমাইন্ডার — তারিখ, সময়, সময়সীমা এক্সামের আসল তথ্য থেকে।",
    en: {
      subject: "Upcoming exam: {{exam_title}} | Tech Verse Exam", greeting: HI_EN,
      message: "This is a reminder about the examination **{{exam_title}}**.\n\nPlease check the schedule below and make sure you are ready.\n\n{{personal_message}}",
      instructions: "Please log in with your registered account and open the exam from the official website.",
      closing: "", signature: SIGN_EN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "Open the exam", ctaUrl: "{{exam_url}}",
    },
    bn: {
      subject: "আসন্ন পরীক্ষা: {{exam_title}} | Tech Verse Exam", greeting: HI_BN,
      message: "**{{exam_title}}** পরীক্ষা সম্পর্কে একটি রিমাইন্ডার।\n\nনিচের সময়সূচি দেখে নিন এবং প্রস্তুত থাকুন।\n\n{{personal_message}}",
      instructions: "আপনার নিবন্ধিত অ্যাকাউন্টে লগইন করে অফিসিয়াল ওয়েবসাইট থেকে পরীক্ষাটি খুলুন।",
      closing: "", signature: SIGN_BN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "পরীক্ষাটি খুলুন", ctaUrl: "{{exam_url}}",
    },
  },
  {
    id: "deadline_reminder", name: "Deadline Reminder", type: "announcement", icon: "fa-clock",
    desc: "যেকোনো সময়সীমার রিমাইন্ডার — Compose-এ “Deadline” ঘরটি পূরণ করুন (বা এক্সামের শেষ সময় ব্যবহার হবে)।",
    en: {
      subject: "Deadline reminder | Tech Verse Exam", greeting: HI_EN,
      message: "This is a reminder about an upcoming deadline: **{{deadline}}**.\n\n{{personal_message}}\n\nPlease complete the required action before the deadline.",
      instructions: "", closing: "", signature: SIGN_EN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "Visit the website", ctaUrl: "{{website_url}}",
    },
    bn: {
      subject: "সময়সীমার রিমাইন্ডার | Tech Verse Exam", greeting: HI_BN,
      message: "একটি সময়সীমা সম্পর্কে রিমাইন্ডার: **{{deadline}}**।\n\n{{personal_message}}\n\nসময়সীমার আগেই প্রয়োজনীয় কাজটি সম্পন্ন করুন।",
      instructions: "", closing: "", signature: SIGN_BN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: true, ctaLabel: "ওয়েবসাইটে যান", ctaUrl: "{{website_url}}",
    },
  },
  {
    id: "schedule_updated", name: "Exam Schedule Updated", type: "exam_upcoming", icon: "fa-calendar-days",
    desc: "এক্সামের সময়সূচি বদলালে — সর্বশেষ তারিখ ও সময়সহ।",
    en: {
      subject: "Exam schedule updated: {{exam_title}} | Tech Verse Exam", greeting: HI_EN,
      message: "The schedule of the examination **{{exam_title}}** has been updated. Please review the latest details below.\n\n{{personal_message}}",
      instructions: "", closing: "", signature: SIGN_EN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "Open the exam", ctaUrl: "{{exam_url}}",
    },
    bn: {
      subject: "পরীক্ষার সময়সূচি পরিবর্তিত: {{exam_title}} | Tech Verse Exam", greeting: HI_BN,
      message: "**{{exam_title}}** পরীক্ষার সময়সূচি হালনাগাদ করা হয়েছে। অনুগ্রহ করে নিচের সর্বশেষ তথ্য দেখুন।\n\n{{personal_message}}",
      instructions: "", closing: "", signature: SIGN_BN,
      showStudentInfo: true, infoFields: BASIC_INFO, showExamDetails: true, ctaEnabled: true, ctaLabel: "পরীক্ষাটি খুলুন", ctaUrl: "{{exam_url}}",
    },
  },
  {
    id: "custom", name: "Custom Email", type: "custom", icon: "fa-pen-to-square",
    desc: "ফাঁকা শুরু — বিষয় ও বার্তা নিজে লিখুন।",
    en: { subject: "", greeting: HI_EN, message: "", instructions: "", closing: "", signature: SIGN_EN, showStudentInfo: false, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: false, ctaLabel: "Visit the website", ctaUrl: "{{website_url}}" },
    bn: { subject: "", greeting: HI_BN, message: "", instructions: "", closing: "", signature: SIGN_BN, showStudentInfo: false, infoFields: BASIC_INFO, showExamDetails: false, ctaEnabled: false, ctaLabel: "ওয়েবসাইটে যান", ctaUrl: "{{website_url}}" },
  },
]);

export const templateById = (id) => BUILTIN_TEMPLATES.find((t) => t.id === id) || null;
/** The template that fits a campaign type best. */
export const templateForType = (type) => BUILTIN_TEMPLATES.find((t) => t.type === type) || BUILTIN_TEMPLATES[0];

const joinText = (a, b, glue) => [a, b].map((x) => String(x || "").trim()).filter(Boolean).join(glue);
/** The Bangla copy must not repeat the admin's personal message — it already sits in the English half. */
const withoutPersonal = (s) => String(s || "").replace(/\{\{\s*personal_message\s*\}\}\s*/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** English + Bangla in one e-mail: English text first, Bangla after it. */
export function mergeBilingual(en, bn) {
  return {
    ...en,
    subject: joinText(en.subject, bn.subject, " | "),
    greeting: joinText(en.greeting, bn.greeting, " / "),
    message: joinText(en.message, withoutPersonal(bn.message), "\n\n"),
    instructions: joinText(en.instructions, bn.instructions, "\n\n"),
    closing: joinText(en.closing, bn.closing, "\n\n"),
    signature: joinText(en.signature, bn.signature, "\n"),
    ctaLabel: joinText(en.ctaLabel, bn.ctaLabel, " / "),
  };
}

/** A template's content in the chosen language ("en" | "bn" | "both"), as a complete content object. */
export function contentFor(template, lang) {
  if (!template) return emptyContent();
  const src = lang === "bn" ? template.bn : lang === "both" ? mergeBilingual(template.en, template.bn) : template.en;
  return { ...emptyContent(), ...src, infoFields: [...(src.infoFields || [])] };
}
