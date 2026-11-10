import { deleteField, doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import { afterExamsChanged, deleteExamCompletely, fetchAllExamsAdmin } from "../repo/exams";
import { logAction } from "./data";
import type { Exam } from "../types";

export type ExamPatch = Partial<Pick<Exam, "status" | "cancelled" | "registration" | "featured">>;
const toWrite = (patch: ExamPatch) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, k === "cancelled" && v === false ? deleteField() : v]));

/** Change one or two fields of an exam (publish, cancel, close registration …), then refresh the students' index and write the audit log. */
export async function patchExam(exam: Exam, patch: ExamPatch, action: string, detail = "") {
  if (Object.keys(patch).length) await updateDoc(doc(db, "exams", exam.id), toWrite(patch));
  const list = (await fetchAllExamsAdmin()).map((e) => (e.id === exam.id ? { ...e, ...patch, ...(patch.cancelled === false ? { cancelled: undefined } : {}) } : e));
  const indexed = await afterExamsChanged(list);
  void logAction(action, { type: "exam", id: exam.id, label: exam.title, detail });
  return { list, indexed };
}

export async function removeExam(exam: Exam) {
  await deleteExamCompletely(exam.id, exam);
  const list = (await fetchAllExamsAdmin()).filter((e) => e.id !== exam.id);
  const indexed = await afterExamsChanged(list);
  void logAction("exam.delete", { type: "exam", id: exam.id, label: exam.title });
  return { list, indexed };
}
