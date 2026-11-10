import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile, sendPasswordResetEmail, sendEmailVerification,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword, type User,
} from "firebase/auth";
import { auth } from "./firebase";
import { SITE_URL } from "./config";
import { Reset } from "./shared";
import * as cache from "./cache";
import { ensureUserDoc } from "./repo/users";
import { clearAllSessions } from "./session";
import { disablePushOnThisDevice } from "./push";

export class AuthFailure extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "AuthFailure"; this.code = code; }
}

export function authMessage(code: string): string {
  const map: Record<string, string> = {
    "auth/email-already-in-use": "There is already an account with this email. Sign in instead — if you first joined with Google, use “Forgot password” to set a password for the same account.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "That password is too weak — use at least 6 characters.",
    "auth/user-not-found": "No account was found for this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password. If you only ever signed in with Google, tap “Forgot password” to set a password.",
    "auth/user-disabled": "This account has been disabled. Please contact the administrator.",
    "auth/too-many-requests": "Too many attempts. Please wait a little while and try again.",
    "auth/network-request-failed": "No internet connection. Check your connection and try again.",
    "auth/requires-recent-login": "For security, please sign in again and then retry.",
  };
  return map[code] || "Something went wrong. Please try again.";
}
const wrap = (err: any) => new AuthFailure(err?.code || "unknown", authMessage(err?.code || ""));

export async function loginWithEmail(email: string, password: string): Promise<User> {
  try { return (await signInWithEmailAndPassword(auth, email.trim(), password)).user; } catch (err) { throw wrap(err); }
}

/** New email + password account. An email that already exists (including a Google-only account) is refused by Firebase — no duplicate is ever created. */
export async function signupWithEmail(name: string, email: string, password: string): Promise<User> {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (name) await updateProfile(cred.user, { displayName: name });
    await ensureUserDoc(cred.user, { displayName: name });
    sendEmailVerification(cred.user).catch(() => { /* best-effort — verification is optional, like on the website */ });
    return cred.user;
  } catch (err) { throw wrap(err); }
}

export async function resendVerification(user: User) {
  try { await sendEmailVerification(user); } catch (err) { throw wrap(err); }
}

/** Firebase's own reset mail (the same one the website sends). For a Google-only account it ADDS a password to the same account (same UID, same data). */
export async function sendPasswordReset(email: string): Promise<{ ok: boolean; code: string }> {
  const previous = auth.languageCode;
  auth.languageCode = "bn";
  try {
    const url = `${SITE_URL}/#/login`;
    try { await sendPasswordResetEmail(auth, email.trim(), { url, handleCodeInApp: false }); }
    catch (err: any) { if (!Reset.isContinueUrlProblem(err?.code)) throw err; await sendPasswordResetEmail(auth, email.trim()); }
    return { ok: true, code: "" };
  } catch (err: any) { return { ok: false, code: err?.code || "unknown" }; }
  finally { auth.languageCode = previous; }
}

export async function changePassword(user: User, currentPassword: string, newPassword: string) {
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email || "", currentPassword));
    await updatePassword(user, newPassword);
  } catch (err: any) {
    throw new AuthFailure(err?.code || "unknown", err?.code === "auth/wrong-password" || err?.code === "auth/invalid-credential" ? "Current password is incorrect." : authMessage(err?.code || ""));
  }
}

export async function logout() {
  await disablePushOnThisDevice().catch(() => { /* the server drops dead tokens on its own */ });
  cache.clearAll(); // nothing from this account may be served to the next one
  clearAllSessions();
  await signOut(auth);
}
