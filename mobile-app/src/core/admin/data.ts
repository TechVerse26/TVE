// Admin data access. Every call goes straight to Firestore and is authorised by the website's firestore.rules — hiding a
// button in the UI is never the protection. Collections and field names are the ones the website's admin panel uses.
import {
  addDoc, collection, deleteDoc, doc, getAggregateFromServer, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where,
  count, sum, average, deleteField, Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import * as cache from "../cache";
import { normalizeTaxonomy, toMirrorNotice, toMs } from "../shared";
import { writeFeedFields } from "../repo/home";
import type { Profile } from "../types";

const TTL = 5 * 60_000;

// ---------------------------------------------------------------- who is acting (for the audit log)
export interface AdminActor { uid: string; name: string; email: string; role: string }
let actor: AdminActor | null = null;
export const setActor = (a: AdminActor | null) => { actor = a; };
export const actorName = () => actor?.name || actor?.email || "admin";

/** adminLogs: create-only audit trail (the rules forbid edits). Never blocks or fails the action it describes. */
export function logAction(action: string, { type = "", id = "", label = "", detail = "" }: { type?: string; id?: string; label?: string; detail?: string } = {}) {
  if (!actor) return Promise.resolve(false);
  return addDoc(collection(db, "adminLogs"), {
    at: serverTimestamp(), uid: actor.uid, name: actor.name || "", email: actor.email || "", role: actor.role || "super",
    action, targetType: type, targetId: String(id || ""), label: String(label || "").slice(0, 160), detail: String(detail || "").slice(0, 400),
  }).then(() => true).catch(() => false);
}
export async function fetchLogs(max = 100) {
  const snap = await getDocs(query(collection(db, "adminLogs"), orderBy("at", "desc"), limit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

// ---------------------------------------------------------------- dashboard numbers (server-side aggregation: a few reads, not one per document)
export async function fetchOverview() {
  const [users, results, taken] = await Promise.all([
    getAggregateFromServer(collection(db, "users"), { n: count() }),
    getAggregateFromServer(collection(db, "results"), { docs: count(), attempts: sum("attemptNumber"), avg: average("percent") }),
    getAggregateFromServer(query(collection(db, "userStats"), where("examsTaken", ">", 0)), { n: count() }).catch(() => null),
  ]);
  const r: any = results.data();
  return { users: Number(users.data().n) || 0, resultDocs: Number(r.docs) || 0, attempts: Number(r.attempts) || 0, avgPercent: Math.round(Number(r.avg) || 0), activeStudents: taken ? Number((taken.data() as any).n) || 0 : null };
}

// ---------------------------------------------------------------- students
export const fetchAllUsers = (opts: { force?: boolean } = {}): Promise<Profile[]> =>
  cache.remember("admin:users", TTL, async () => (await getDocs(collection(db, "users"))).docs.map((d) => ({ uid: d.id, ...d.data() }) as Profile), opts);
export const invalidateUsers = () => cache.del("admin:users");
const patchCachedUser = (uid: string, patch: Partial<Profile>) => { const list = cache.get<Profile[]>("admin:users"); if (list) cache.set("admin:users", list.map((u) => (u.uid === uid ? { ...u, ...patch } : u)), TTL); };

export async function setUserDisabled(uid: string, disabled: boolean, byUid: string) {
  await updateDoc(doc(db, "users", uid), disabled ? { disabled: true, disabledAt: serverTimestamp(), disabledBy: byUid } : { disabled: deleteField(), disabledAt: deleteField(), disabledBy: deleteField() });
  patchCachedUser(uid, { disabled });
}
export async function setUserRoll(uid: string, roll: string) { await updateDoc(doc(db, "users", uid), { roll }); patchCachedUser(uid, { roll }); }

// ---------------------------------------------------------------- admin roles (users/{uid}.isAdmin + adminRoles/{uid}.role)
export const fetchAdminRoles = async (): Promise<Record<string, { role: string; name?: string; email?: string }>> => {
  const snap = await getDocs(collection(db, "adminRoles"));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data() as any]));
};
export async function addAdmin(u: Profile, role: string, by: string) {
  await updateDoc(doc(db, "users", u.uid), { isAdmin: true });
  await setDoc(doc(db, "adminRoles", u.uid), { role, name: u.displayName || "", email: u.email || "", addedBy: by, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
  patchCachedUser(u.uid, { isAdmin: true });
}
export async function setAdminRole(u: Profile, role: string, by: string) {
  await setDoc(doc(db, "adminRoles", u.uid), { role, name: u.displayName || "", email: u.email || "", addedBy: by, updatedAt: serverTimestamp() }, { merge: true });
}
export async function removeAdmin(uid: string) {
  await updateDoc(doc(db, "users", uid), { isAdmin: false });
  await deleteDoc(doc(db, "adminRoles", uid)).catch(() => { /* a missing role doc is fine */ });
  patchCachedUser(uid, { isAdmin: false });
}

// ---------------------------------------------------------------- results of one exam
export async function fetchResultsOfExam(examId: string, max = 300) {
  const snap = await getDocs(query(collection(db, "results"), where("examId", "==", examId), limit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

// ---------------------------------------------------------------- notices (admin list → student copy inside homeFeed/main)
export interface NoticeDoc {
  id: string; title: string; body: string; category: string; priority: string; status: "draft" | "published";
  publishAt: any; expiresAt: any; audience: { type: string; ids: string[] }; examId: string; courseId: string; createdAt?: any;
}
export async function fetchNotices(): Promise<NoticeDoc[]> {
  const snap = await getDocs(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(200)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}
const MIRROR_MAX = 30;
export async function syncNoticeMirror(notices: NoticeDoc[]) {
  const keep = notices
    .filter((n) => n.status === "published" && !(toMs(n.expiresAt) && (toMs(n.expiresAt) as number) < Date.now() - 86_400_000))
    .sort((a, b) => ((toMs(b.publishAt) || toMs(b.createdAt) || 0) - (toMs(a.publishAt) || toMs(a.createdAt) || 0)))
    .slice(0, MIRROR_MAX).map((n) => toMirrorNotice(n.id, n));
  await writeFeedFields({ notices: keep });
}
export async function saveNotice(id: string | null, data: Omit<NoticeDoc, "id" | "createdAt">): Promise<string> {
  const payload = { ...data, publishAt: data.publishAt ? Timestamp.fromMillis(toMs(data.publishAt) as number) : null, expiresAt: data.expiresAt ? Timestamp.fromMillis(toMs(data.expiresAt) as number) : null };
  if (id) { await setDoc(doc(db, "notices", id), { ...payload, updatedAt: serverTimestamp() }, { merge: true }); return id; }
  const ref = await addDoc(collection(db, "notices"), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: actorName() });
  return ref.id;
}
export async function setNoticeStatus(id: string, status: "draft" | "published") { await setDoc(doc(db, "notices", id), { status, updatedAt: serverTimestamp() }, { merge: true }); }
export async function deleteNotice(id: string) { await deleteDoc(doc(db, "notices", id)); }

// ---------------------------------------------------------------- subjects / categories (examTaxonomy/main — read by any admin)
export async function fetchTaxonomy() {
  return cache.remember("admin:taxonomy", TTL, async () => {
    try {
      const snap = await getDoc(doc(db, "examTaxonomy", "main"));
      const d: any = snap.exists() ? snap.data() : {};
      return normalizeTaxonomy({ subjects: d.subjects || [], categories: d.categories || [] });
    } catch { return normalizeTaxonomy({}); }
  });
}
