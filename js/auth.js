// ==========================================================================
// auth.js — Firebase Auth (email/password + Google), same users/{uid} doc
// shape TVcourse uses, so an exam-site account IS a course-site account.
// ==========================================================================
import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, consumePostLoginRedirect } from "./utils.js";
import { navigate } from "./router.js";

async function ensureUserDoc(user, extra = {}) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: user.displayName || extra.displayName || (user.email || "").split("@")[0],
      email: user.email,
      photoURL: user.photoURL || "",
      isAdmin: false,
      phone: "",
      enrolledCourses: [],
      createdAt: serverTimestamp(),
      ...extra,
    });
  }
}

function mapAuthError(code) {
  const map = {
    "auth/email-already-in-use": "এই ইমেইল দিয়ে আগে থেকেই একটা অ্যাকাউন্ট আছে",
    "auth/invalid-email": "সঠিক ইমেইল লিখুন",
    "auth/weak-password": "পাসওয়ার্ড খুবই দুর্বল",
    "auth/user-not-found": "এই ইমেইলে কোনো অ্যাকাউন্ট পাওয়া যায়নি",
    "auth/wrong-password": "পাসওয়ার্ড ভুল",
    "auth/invalid-credential": "ইমেইল বা পাসওয়ার্ড ভুল",
    "auth/too-many-requests": "অনেকবার চেষ্টা হয়েছে, একটু পর আবার চেষ্টা করুন",
  };
  return map[code] || "কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন";
}

function afterLogin() {
  navigate(consumePostLoginRedirect() || "#/home");
}

export async function loginWithEmail(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
    afterLogin();
  } catch (err) {
    toast(mapAuthError(err.code), "error");
  }
}

export async function signupWithEmail(name, email, password) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(cred.user, { displayName: name });
    await ensureUserDoc(cred.user, { displayName: name });
    afterLogin();
  } catch (err) {
    toast(mapAuthError(err.code), "error");
  }
}

export async function loginWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    await ensureUserDoc(cred.user);
    afterLogin();
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") toast(mapAuthError(err.code), "error");
  }
}

export async function logout() {
  await signOut(auth);
  navigate("#/login");
}
