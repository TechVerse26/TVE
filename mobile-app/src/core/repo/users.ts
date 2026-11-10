import { doc, getDoc, setDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { updateProfile, type User } from "firebase/auth";
import { db } from "../firebase";
import * as cache from "../cache";
import type { Profile } from "../types";

/** users/{uid} — the SAME profile document the website uses (name, phone, institution, roll, isAdmin, enrolledCourses …). */
export async function getUserProfile(uid: string, opts: { force?: boolean } = {}): Promise<Profile | null> {
  return cache.remember(`profile:${uid}`, 5 * 60_000, async () => {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? ({ uid, ...snap.data() } as Profile) : null;
  }, opts);
}
export const invalidateUserProfile = (uid: string) => cache.del(`profile:${uid}`);

/** Creates the profile document when it does not exist yet (same fields as the website's ensureUserDoc). Never touches an existing one. */
export async function ensureUserDoc(user: User, extra: Record<string, unknown> = {}) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    displayName: user.displayName || (extra.displayName as string) || (user.email || "").split("@")[0],
    email: user.email, photoURL: user.photoURL || "", isAdmin: false, phone: "", enrolledCourses: [], createdAt: serverTimestamp(), ...extra,
  });
  invalidateUserProfile(user.uid);
}

/** Name / phone / institution (roll is read-only for students and only written by claimNextRoll or an admin). */
export async function updateUserProfile(user: User, { displayName, phone, institution, roll }: { displayName: string; phone: string; institution: string; roll?: string }) {
  if (displayName && displayName !== user.displayName) await updateProfile(user, { displayName });
  const payload: Record<string, unknown> = { displayName, phone, institution };
  if (roll !== undefined) payload.roll = roll;
  await setDoc(doc(db, "users", user.uid), payload, { merge: true });
  invalidateUserProfile(user.uid);
}

/** Atomically claims the next serial roll number (counters/students) — the same transaction as js/roll.js. */
export async function claimNextRoll(): Promise<string> {
  const counterRef = doc(db, "counters", "students");
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? Number((snap.data() as any).next) || 1 : 1;
    tx.set(counterRef, { next: current + 1 }, { merge: true });
    return current;
  });
  return String(next).padStart(4, "0");
}
