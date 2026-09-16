// ==========================================================================
// roll.js — shared serial roll-number engine.
// Roll numbers are plain sequential numbers (0001, 0002, 0003, ...) handed
// out from a single atomic Firestore counter (counters/students, field
// "next"). claimNextRoll() runs as a transaction, so two students hitting
// "sync" at the exact same moment can never walk away with the same roll —
// whoever's transaction commits first gets the number, the other retries
// and gets the next one. This replaces the old random-6-digit generator:
// no more collision-probing, and rolls now read as a clean, ordered list
// instead of scattered random digits.
//
// Used by:
//   - js/page-profile.js  → student clicks "সিঙ্ক করুন", claims the next roll
//   - js/admin/students.js → admin can generate a roll for a student who
//     hasn't synced yet, or manually override one (isRollTaken guards that)
// ==========================================================================
import { db } from "./firebase-config.js";
import {
  doc, runTransaction, collection, query, where, limit, getDocs,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ROLL_PAD = 4; // 0001, 0002, ... — grows past 4 digits naturally once the count passes 9999

export function formatRoll(n) {
  return String(n).padStart(ROLL_PAD, "0");
}

/** Atomically claims and returns the next serial roll number as a zero-padded string. */
export async function claimNextRoll() {
  const counterRef = doc(db, "counters", "students");
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? Number(snap.data().next) || 1 : 1;
    tx.set(counterRef, { next: current + 1 }, { merge: true });
    return current;
  });
  return formatRoll(next);
}

/** True if `roll` already belongs to some other user — used only when an admin manually sets a roll. */
export async function isRollTaken(roll, excludeUid = null) {
  const snap = await getDocs(query(collection(db, "users"), where("roll", "==", roll), limit(2)));
  return snap.docs.some((d) => d.id !== excludeUid);
}
