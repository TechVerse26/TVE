// Test double for firebase-auth.js. The signed-in user lives in window.__MOCK__.user (set by the test runner).
const M = window.__MOCK__;
M.authCbs = M.authCbs || [];
const auth = { get currentUser() { return M.user; } };
export const getAuth = () => auth;
export function onAuthStateChanged(a, cb) {
  M.authCbs.push(cb);
  Promise.resolve().then(() => cb(M.user));
  return () => { const i = M.authCbs.indexOf(cb); if (i >= 0) M.authCbs.splice(i, 1); };
}
export async function signOut() { M.user = null; M.authCbs.slice().forEach((cb) => cb(null)); }
export const signInWithEmailAndPassword = async () => ({ user: M.user });
export const createUserWithEmailAndPassword = async () => ({ user: M.user });
export const signInWithPopup = async () => ({ user: M.user });
export const updateProfile = async () => {};
export const reauthenticateWithCredential = async () => {};
export const updatePassword = async () => {};
export class GoogleAuthProvider {}
export const EmailAuthProvider = { credential: () => ({}) };
