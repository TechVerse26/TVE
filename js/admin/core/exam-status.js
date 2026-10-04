// ==========================================================================
// admin/core/exam-status.js — one definition of "what state is this exam in?" for every page.
//
//   exams/{id}.status   "draft" | "published"   (missing = published, so every old exam keeps working)
//   draft               hidden from students completely (index + start guard both enforce it)
//   published + schedule → open / scheduled / closed  (unchanged logic from utils.getExamAvailability)
//
// Marking: +1 per correct answer, so an exam's total marks = questions per attempt.
// exams/{id}.passPercent (new, optional) sets the pass line; otherwise Settings → Results applies.
// ==========================================================================
import { getExamAvailability, getExamQuestionCount } from "../../utils.js";
import { getSettings } from "./settings.js";

export const isDraft = (e) => e?.status === "draft";

export function examState(e) {
  if (isDraft(e)) return "draft";
  const { state } = getExamAvailability(e);
  return state === "upcoming" ? "scheduled" : state === "closed" ? "closed" : "open";
}

export const STATE_META = {
  open: { label: "Open", tone: "teal" },
  scheduled: { label: "Scheduled", tone: "amber" },
  closed: { label: "Closed", tone: "coral" },
  draft: { label: "Draft", tone: "" },
};

export function passPercentOf(e) {
  const own = Number(e?.passPercent);
  return own > 0 ? Math.min(100, own) : Number(getSettings().result.passPercent) || 60;
}

export const totalMarksOf = (e) => getExamQuestionCount(e || {});
export const passMarksOf = (e) => Math.ceil((totalMarksOf(e) * passPercentOf(e)) / 100 - 1e-9);
