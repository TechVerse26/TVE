// Academic Section › Level › Subject — the student side of js/academic-data.js.
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";
import * as cache from "../cache";
import { Academic } from "../shared";
import type { Exam } from "../types";

const TTL = 5 * 60_000;
const SHORT = 30_000;
const COL = Academic.COL as Record<"section" | "level" | "subject" | "entitlement", string>;
const isDenied = (e: any) => e?.code === "permission-denied";
const activeQuery = (col: string, ...more: any[]) => query(collection(db, col), where("status", "==", "active"), ...more);
const toNodes = (kind: string, snap: any) => snap.docs.map((d: any) => Academic.normalizeNode(kind, d.id, d.data())).filter((n: any) => n.status === "active" && n.name);

export interface AcNode { kind: string; id: string; name: string; description: string; coverImage: string; status: string; order: number; accessMode: string; sectionId?: string; levelId?: string; linkedCourseId: string }
export interface SectionTree { section: AcNode; levels: AcNode[]; subjects: AcNode[] }

export const loadSections = (opts: { force?: boolean } = {}): Promise<AcNode[]> => cache.remember("acad:sections", TTL, async () => toNodes("section", await getDocs(activeQuery(COL.section))).sort(Academic.byOrder), opts);

export const loadSectionTree = (sectionId: string, opts: { force?: boolean } = {}): Promise<SectionTree | null> =>
  cache.remember(`acad:tree:${sectionId}`, (v: SectionTree | null) => (v ? TTL : SHORT), async () => {
    let section: AcNode | null = null;
    try { const snap = await getDoc(doc(db, COL.section, sectionId)); section = snap.exists() ? Academic.normalizeNode("section", snap.id, snap.data()) : null; } catch (err) { if (!isDenied(err)) throw err; }
    if (!section || section.status !== "active") return null;
    const [lv, sb] = await Promise.all([getDocs(activeQuery(COL.level, where("sectionId", "==", sectionId))), getDocs(activeQuery(COL.subject, where("sectionId", "==", sectionId)))]);
    const levels: AcNode[] = toNodes("level", lv).filter((l: AcNode) => l.sectionId === sectionId).sort(Academic.byOrder);
    const levelIds = new Set(levels.map((l) => l.id));
    const subjects: AcNode[] = toNodes("subject", sb).filter((s: AcNode) => s.sectionId === sectionId && levelIds.has(s.levelId as string)).sort(Academic.byOrder);
    return { section, levels, subjects };
  }, opts);

/** Ids of every node this student was granted access to (academicEntitlements — written only by admins). */
export async function loadMyEntitlements(uid: string, opts: { force?: boolean } = {}): Promise<Set<string>> {
  if (!uid) return new Set();
  const ids = await cache.remember(`acad:ent:${uid}`, TTL, async () => {
    try { return (await getDocs(query(collection(db, COL.entitlement), where("uid", "==", uid)))).docs.map((d) => String((d.data() as any).nodeId || "")).filter(Boolean); }
    catch (err) { if (isDenied(err)) return [] as string[]; throw err; }
  }, opts);
  return new Set(ids);
}

/** Entry gate for ONE exam (the rules decide again on the server when the questions are read). */
export async function checkAcademicExamAccess(exam: Exam, { uid = "", isAdmin = false } = {}): Promise<{ allowed: boolean; reason: string }> {
  if (!exam?.academicSubjectId) return { allowed: true, reason: "not-academic" };
  if (isAdmin) return { allowed: true, reason: "admin" };
  try {
    const tree = await loadSectionTree(exam.academicProgramId as string);
    if (!tree) return { allowed: false, reason: "hidden" };
    const level = tree.levels.find((l) => l.id === exam.academicLevelId);
    const subject = tree.subjects.find((s) => s.id === exam.academicSubjectId);
    if (!level || !subject || subject.levelId !== level.id) return { allowed: false, reason: "hidden" };
    const verdict = Academic.accessVerdict([subject, level, tree.section], await loadMyEntitlements(uid));
    return { allowed: verdict.allowed, reason: verdict.reason };
  } catch { return { allowed: true, reason: "unverified" }; }
}
export const invalidateAcademic = () => cache.delPrefix("acad:");
