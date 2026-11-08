// Test double for firebase-messaging.js (the Web Push part of the Firebase SDK).
// Nothing here talks to Google. The state lives in window.__FCM so a test can look at what the page did and can play "FCM":
//
//   __FCM.calls          every getToken() call           { vapidKey, hasReg }
//   __FCM.deleted        how many times deleteToken() ran
//   __FCM.fail           set to a code ("messaging/token-subscribe-failed", …) to make the next getToken() calls throw
//   __FCM.unsupported    set to true to make isSupported() answer false
//   __FCM.deliver(p)     hand a message ({ data: {...} }) to the page's onMessage() handlers, like FCM does for a visible tab
//
// The token is kept in localStorage (like the real SDK keeps it in IndexedDB), so it stays the same across page loads
// until deleteToken() is called.
const W = window;
const F = (W.__FCM = W.__FCM || { calls: [], handlers: [], deleted: 0, fail: null, unsupported: false });
F.deliver = (payload) => F.handlers.forEach((h) => h(payload));

const KEY = "__test.fcmtoken";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* ignore */ } };

export const isSupported = async () => !F.unsupported;
export const getMessaging = (app) => ({ app });

export async function getToken(messaging, opts) {
  F.calls.push({ vapidKey: opts && opts.vapidKey, hasReg: !!(opts && opts.serviceWorkerRegistration) });
  if (F.fail) { const e = new Error(`Messaging: ${F.fail}`); e.code = F.fail; throw e; }
  let t = read();
  if (!t) {
    const rand = Array.from({ length: 140 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"[Math.floor(Math.random() * 64)]).join("");
    t = `fcm${Math.floor(Math.random() * 1e6)}:APA91b${rand}`;
    write(t);
  }
  return t;
}

export function onMessage(messaging, cb) {
  F.handlers.push(cb);
  return () => { const i = F.handlers.indexOf(cb); if (i >= 0) F.handlers.splice(i, 1); };
}

export async function deleteToken() {
  F.deleted += 1;
  write("");
  return true;
}
