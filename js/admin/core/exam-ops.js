// ==========================================================================
// admin/core/exam-ops.js — exam writes needed outside the Exams page (the Question Bank page
// assigns questions to exams and builds exams from a selection). Same atomic saveExamDoc path
// as the exam editor, and the same bookkeeping afterwards: shared cache, students' index, audit, bus.
// ==========================================================================
import { Timestamp, writeBatch, doc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "../../firebase-config.js";
import { fetchAllExamsAdmin, fetchQuestionsAdmin, saveExamDoc, primeAdminExams, writeExamIndex, QUESTION_FORMAT } from "../../exam-data.js";
import { courses } from "../admin.js";
import { qHash } from "./qbank.js";
import { logAction } from "./audit.js";
import { emitChange } from "./bus.js";
import { getSettings } from "./settings.js";

const plain = (q) => ({ text: q.text, options: q.options.slice(), correctIndex: q.correctIndex, explanation: q.explanation || "" });
const bundleMeta = (saved) => (saved.format === QUESTION_FORMAT ? { qFormat: QUESTION_FORMAT, qChunks: saved.chunks } : {});

/** Copy bank questions into an existing exam (skips ones it already has). → { added, total, exam } */
export async function appendQuestionsToExam(examId, questions) {
  const exams = await fetchAllExamsAdmin();
  const ex = exams.find((e) => e.id === examId);
  if (!ex) throw new Error("এক্সামটি পাওয়া যায়নি");
  const list = (await fetchQuestionsAdmin(ex.id, ex)).map(plain);
  const have = new Set(list.map(qHash));
  let added = 0;
  questions.forEach((q) => { const h = qHash(q); if (have.has(h)) return; have.add(h); list.push(plain(q)); added++; });
  if (!added) return { added: 0, total: list.length, exam: ex };

  const saved = await saveExamDoc({ examId: ex.id, data: { questionCount: list.length }, questions: list, prevChunks: ex.qChunks || 1 });
  const { qFormat, qChunks, ...prev } = ex;
  const next = { ...prev, questionCount: list.length, ...bundleMeta(saved) };
  exams[exams.findIndex((e) => e.id === ex.id)] = next;
  primeAdminExams(exams);
  writeExamIndex(exams, courses).catch(() => {});
  logAction("question.assign", { type: "exam", id: ex.id, label: ex.title, detail: `+${added} questions from the bank` });
  emitChange("exams");
  return { added, total: list.length, exam: next };
}

/** Make a new DRAFT exam from bank questions, using the defaults from Settings → Exams. */
export async function createExamFromQuestions({ title, examType = "live", duration, subjectId = "", categoryId = "", questions }) {
  const d = getSettings().exam;
  const data = {
    examType, title, description: "", courseName: "", courseId: "", lessonIds: [], lessonNames: [],
    duration: Number(duration) || d.duration, questionCount: questions.length, questionsPerAttempt: 0,
    maxAttempts: d.maxAttempts, negativeMarking: d.negativeMarking, layout: d.layout, shuffle: d.shuffle,
    status: "draft", subjectId, categoryId, passPercent: 0, instructions: "",
    publishAt: examType === "practice" ? null : Timestamp.fromDate(new Date()), availableHours: 0, closesAt: null,
  };
  const saved = await saveExamDoc({ data, questions: questions.map(plain) });
  const exams = await fetchAllExamsAdmin();
  const exam = { id: saved.id, ...data, createdAt: Timestamp.now(), ...bundleMeta(saved) };
  exams.unshift(exam);
  primeAdminExams(exams);
  writeExamIndex(exams, courses).catch(() => {});
  logAction("exam.create", { type: "exam", id: saved.id, label: title, detail: `${questions.length} questions from the bank · draft` });
  emitChange("exams");
  return exam;
}

/**
 * Change a few fields on one or more exams WITHOUT touching their questions (schedule, featured, registration …).
 * patches: [{ id, patch }] — values must be concrete (use Timestamp.now(), never serverTimestamp(): the same values are
 * mirrored into the students' index document, where a sentinel inside an array is not allowed).
 * Same bookkeeping as every other exam write: shared cache, students' index, bus. Callers write their own audit entry.
 */
export async function patchExamFields(patches) {
  const exams = await fetchAllExamsAdmin();
  for (let i = 0; i < patches.length; i += 400) {
    const batch = writeBatch(db);
    patches.slice(i, i + 400).forEach(({ id, patch }) => batch.update(doc(db, "exams", id), patch));
    await batch.commit();
  }
  patches.forEach(({ id, patch }) => {
    const i = exams.findIndex((e) => e.id === id);
    if (i >= 0) exams[i] = { ...exams[i], ...patch };
  });
  primeAdminExams(exams);
  writeExamIndex(exams, courses).catch(() => { /* self-heals through syncExamIndex on the next fresh load */ });
  emitChange("exams");
  return exams;
}
