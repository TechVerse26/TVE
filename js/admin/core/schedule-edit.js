// ==========================================================================
// admin/core/schedule-edit.js — validation + patch building for the Exam Schedule editor.
// Pure (no Firebase, no DOM): dates are epoch ms in and out, so it is unit-tested in Node. The page turns the
// ms into Firestore Timestamps right before writing.
// ==========================================================================
import { toMs } from "../../schedule-core.js";

export const DURATION_MIN = 1;
export const DURATION_MAX = 600;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * form = { start:ms|null, end:ms|null, duration:number, status, registration, visibility, remind:boolean, featured:boolean, difficulty }
 * Returns a list of human-readable problems (empty = fine).
 */
export function validateSchedule(f, exam = {}) {
  const errors = [];
  const dur = Number(f.duration);
  if (!Number.isFinite(dur) || dur < DURATION_MIN || dur > DURATION_MAX) errors.push(`Duration ${DURATION_MIN}–${DURATION_MAX} মিনিটের মধ্যে হতে হবে।`);
  if (f.end !== null && f.start === null) errors.push("শেষ সময় দিতে হলে আগে শুরুর সময় দিন।");
  if (f.end !== null && f.start !== null && f.end <= f.start) errors.push("শেষ সময় অবশ্যই শুরুর সময়ের পরে হতে হবে।");
  if (f.status === "published" && !(Number(exam.questionCount) > 0)) errors.push("এই এক্সামে কোনো প্রশ্ন নেই — প্রকাশের আগে প্রশ্ন যোগ করুন।");
  return errors;
}

/**
 * The fields to write on exams/{id}, plus whether students should be told "schedule updated".
 * `stamped` is true only when a schedule that students could already see actually changed.
 * Times in the returned patch are ms (or null).
 */
export function buildSchedulePatch(prev, f, nowMs) {
  const patch = {
    publishAt: f.start,
    closesAt: f.end,
    availableHours: f.start !== null && f.end !== null ? round4((f.end - f.start) / 3600000) : 0,
    duration: Math.round(Number(f.duration)),
    status: f.status === "draft" ? "draft" : "published",
    registration: f.registration === "closed" ? "closed" : "open",
    visibility: f.visibility === "unlisted" ? "unlisted" : "public",
    reminderEnabled: f.remind !== false,
    featured: f.featured === true,
    difficulty: ["easy", "medium", "hard"].includes(f.difficulty) ? f.difficulty : "",
  };
  const was = {
    start: toMs(prev.publishAt), end: toMs(prev.closesAt), duration: Number(prev.duration) || 0,
    registration: prev.registration === "closed" ? "closed" : "open",
  };
  const changes = [];
  if (was.start !== patch.publishAt) changes.push("start");
  if (was.end !== patch.closesAt) changes.push("end");
  if (was.duration !== patch.duration) changes.push("duration");
  if (was.registration !== patch.registration) changes.push("registration");
  const stamped = was.start !== null && prev.status !== "draft" && changes.length > 0;
  if (stamped) patch.scheduleUpdatedAt = nowMs;
  return { patch, stamped, changes };
}

/** The "remove schedule" patch: back to a draft with no dates, so nothing opens by accident. */
export const removeSchedulePatch = () => ({
  publishAt: null, closesAt: null, availableHours: 0, status: "draft", cancelled: false, registration: "open", scheduleUpdatedAt: null,
});

/** Convert the ms fields of a patch into Firestore Timestamps (the only place the page touches the SDK type). */
export function toFirestorePatch(patch, Timestamp) {
  const out = { ...patch };
  for (const k of ["publishAt", "closesAt", "scheduleUpdatedAt"]) {
    if (k in out) out[k] = out[k] === null || out[k] === undefined ? null : Timestamp.fromMillis(out[k]);
  }
  return out;
}
