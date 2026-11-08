// ==========================================================================
// push-student.js — the student side of push notifications: this device's subscription, from permission to token.
//
//   • Loaded on the side (push-boot.js), only when js/push/push-config.js has been filled in.
//   • It never asks the browser for permission by itself: `enable()` is called from a button the student pressed, after
//     the page explained what they would get. The browser prompt is opened in exactly one place (enable()).
//   • Uses the site's EXISTING Firebase app (js/firebase-config.js) — no second initialization. The messaging library is
//     fetched only when it is needed (the student has push on, or is turning it on).
//   • One record per (student, browser) on the server; it is removed / invalidated when the student turns it off or signs out.
//
//   Local storage (per browser, failure-proof via local-store.js — nothing here is ever required for the site to work):
//     tvp.key            random id of this browser profile
//     tvp.on             { [uid]: { at, token } }   students who turned push on here (token "" while signed out)
//     tvp.prefs.<uid>    which kinds of notification they want on this device
//     tvp.prompt.<uid>   { n, at, never }           how often the explaining card was dismissed
//     tvp.visits.<uid>   how many browser sessions they have had
// ==========================================================================
import { app, auth } from "../firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { PUSH, pushConfigured } from "./push-config.js";
import * as C from "./push-core.js";
import { api, PushApiError } from "./push-api.js";
import { lsGet, lsSet } from "../local-store.js";

const FIREBASE_MESSAGING = "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";
const SW_FILE = "firebase-messaging-sw.js";
const SW_SCOPE = "./firebase-cloud-messaging-push-scope";
const DAY = 86400000;

const K = {
  key: "tvp.key", on: "tvp.on",
  prefs: (uid) => `tvp.prefs.${uid}`, prompt: (uid) => `tvp.prompt.${uid}`, visits: (uid) => `tvp.visits.${uid}`,
};
const ALL_ON = () => ({ announcement: true, exam: true, result: true });

/* ---------- status (what the UI shows) ---------- */
const st = { phase: "idle", support: { ok: false, reason: "" }, permission: "default", uid: "", prefs: ALL_ON(), devices: null, syncPending: false, error: "" };
const statusListeners = new Set();
const messageListeners = new Set();
const snapshot = () => ({ ...st, prefs: { ...st.prefs }, devices: st.devices ? st.devices.map((d) => ({ ...d })) : null });
const emit = () => statusListeners.forEach((fn) => { try { fn(snapshot()); } catch { /* a broken listener must not stop the others */ } });
function setPhase(phase) { st.phase = phase; emit(); }

export const getStatus = snapshot;
export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
export function onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); }

/* ---------- this browser ---------- */
function environment() {
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const dev = C.detectDevice({ ua: navigator.userAgent || "", standalone, touchPoints: navigator.maxTouchPoints || 0, navPlatform: navigator.platform || "" });
  const support = C.supportState({
    secure: window.isSecureContext, hasSW: "serviceWorker" in navigator, hasPush: "PushManager" in window,
    hasNotification: "Notification" in window, ios: dev.platform === "ios", standalone,
  });
  return { dev, support };
}
const permission = () => ("Notification" in window ? Notification.permission : "unsupported");

function deviceKey() {
  let k = lsGet(K.key, "");
  if (typeof k !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) { k = C.randomKey(); lsSet(K.key, k); }
  return k;
}
const readOn = () => { const v = lsGet(K.on, {}); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
const onRec = (uid) => readOn()[uid] || null;
const setOnRec = (uid, rec) => lsSet(K.on, { ...readOn(), [uid]: rec });
const clearOnRec = (uid) => { const all = readOn(); delete all[uid]; lsSet(K.on, all); };
const normPrefs = (p) => ({ ...ALL_ON(), ...Object.fromEntries(C.CATEGORIES.filter((c) => p && typeof p === "object" && p[c] === false).map((c) => [c, false])) });
function readPrefs(uid) { return normPrefs(lsGet(K.prefs(uid), null)); }
let confirmedPrefs = null;                                         // the choices the server last confirmed — where a switch falls back to when saving fails

export const getPromptRec = (uid) => (uid ? lsGet(K.prompt(uid), null) || {} : {});
export const getVisits = (uid) => (uid ? Number(lsGet(K.visits(uid), 0)) || 0 : 0);
export function dismissPrompt(uid, never = false) {
  if (!uid) return;
  const rec = getPromptRec(uid);
  lsSet(K.prompt(uid), never ? C.afterNever(rec, Date.now()) : C.afterLater(rec, Date.now()));
}
function bumpVisits(uid) {
  try { if (sessionStorage.getItem("tvp.v")) return; sessionStorage.setItem("tvp.v", "1"); } catch { return; } // no session storage → never counts (the card then simply never appears)
  lsSet(K.visits(uid), getVisits(uid) + 1);
}

const fail = (code) => { st.error = code; emit(); return { ok: false, code }; };
const errCode = (err) => (err instanceof PushApiError ? err.code : C.classifyFcmError(err));

/* ---------- Firebase Messaging (fetched only when needed) ---------- */
let sdk = null;
function loadSdk() {
  if (!sdk) {
    sdk = import(FIREBASE_MESSAGING).then(async (m) => {
      if (!(await m.isSupported())) throw Object.assign(new Error("unsupported-browser"), { code: "messaging/unsupported-browser" });
      return { m, messaging: m.getMessaging(app) };               // the page's existing Firebase app
    }).catch((e) => { sdk = null; throw e; });                     // offline now → try again next time
  }
  return sdk;
}

/** Our dedicated worker. The (public) Firebase settings travel in its URL, taken from firebase-config.js. */
function workerUrl() {
  const o = app.options || {};
  return `${SW_FILE}?${new URLSearchParams({ k: o.apiKey || "", p: o.projectId || "", s: o.messagingSenderId || "", a: o.appId || "" })}`;
}
async function registration() {
  try { return await navigator.serviceWorker.register(workerUrl(), { scope: SW_SCOPE, updateViaCache: "none" }); }
  catch (e) { throw Object.assign(e, { code: e.code || "messaging/failed-service-worker-registration" }); }
}
const existingRegistration = () => navigator.serviceWorker.getRegistration(SW_SCOPE).catch(() => null);

async function fetchToken() {
  const reg = await registration();
  const { m, messaging } = await loadSdk();
  const token = await m.getToken(messaging, { vapidKey: PUSH.vapidKey.trim(), serviceWorkerRegistration: reg });
  if (!token) throw Object.assign(new Error("no token"), { code: "messaging/token-subscribe-no-token" });
  attachForeground(m, messaging);
  return { token, reg };
}

/* A visible tab receives the message here (the worker steps aside). During an exam nothing is drawn on the page. */
let fgAttached = false;
function attachForeground(m, messaging) {
  if (fgAttached) return;
  fgAttached = true;
  m.onMessage(messaging, async (payload) => {
    const n = C.normalizeIncoming(payload && payload.data);
    if (!n || seenThisSession(n.nid)) return;
    if (document.body.classList.contains("exam-taking")) { await quietSystemNotification(n); return; }
    messageListeners.forEach((fn) => { try { fn(n); } catch { /* ignore */ } });
  });
}
function seenThisSession(nid) {
  try {
    const list = JSON.parse(sessionStorage.getItem("tvp.seen") || "[]");
    if (list.includes(nid)) return true;
    sessionStorage.setItem("tvp.seen", JSON.stringify([...list, nid].slice(-30)));
  } catch { /* storage blocked: at worst one repeat banner */ }
  return false;
}
/** Mid-exam: the notification waits silently in the system tray instead of appearing over the questions. */
async function quietSystemNotification(n) {
  try {
    const reg = await existingRegistration();
    if (!reg) return;
    await reg.showNotification(n.title, {
      body: n.body, tag: `tvp-${n.nid.slice(0, 40)}`, silent: true, renotify: false, lang: "bn", timestamp: n.ts,
      icon: new URL("assets/pwa/icon-192.png", document.baseURI).href, badge: new URL("assets/push/badge-72.png", document.baseURI).href,
      data: { nid: n.nid, url: n.url, cat: n.cat },
    });
  } catch { /* nothing to do */ }
}

/** Removes this browser's push subscription (FCM + the browser). Never opens a permission prompt, never touches another worker. */
async function dropSubscription() {
  const reg = await existingRegistration();
  if (!reg) return;
  if (permission() === "granted") {
    try {
      const { m, messaging } = await loadSdk();
      // getToken first: it binds OUR worker, so deleteToken can never register Firebase's default one over it
      await m.getToken(messaging, { vapidKey: PUSH.vapidKey.trim(), serviceWorkerRegistration: reg });
      await m.deleteToken(messaging);
      return;
    } catch { /* fall back to the plain browser unsubscribe below */ }
  }
  try { const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch { /* already gone */ }
}

/* ---------- the server record ---------- */
function subscribeBody(token, previous, prefs) {
  const { dev } = environment();
  const body = { token, deviceKey: deviceKey(), platform: dev.platform, browser: dev.browser, standalone: dev.standalone, label: dev.label };
  if (previous && previous !== token) body.previousToken = previous;
  if (prefs) body.prefs = prefs;                                   // omitted on a silent re-sync: the server keeps the student's choices
  return body;
}

export async function refreshDevices() {
  if (!auth.currentUser) return null;
  const res = await api("me", { deviceKey: deviceKey() });
  st.devices = res.devices || [];
  const here = st.devices.find((d) => d.current && d.status === "active");
  if (here && here.prefs) { st.prefs = normPrefs(here.prefs); confirmedPrefs = { ...st.prefs }; lsSet(K.prefs(auth.currentUser.uid), st.prefs); }
  emit();
  return st.devices;
}

/* ---------- turning it on / off (called from buttons) ---------- */
export async function enable() {
  const user = auth.currentUser;
  if (!pushConfigured()) return fail("not_configured");
  const { support } = environment();
  if (!support.ok) return fail("unsupported");
  if (!user) return fail("unauthenticated");
  if (st.phase === "busy") return { ok: false, code: "busy" };
  st.error = "";
  setPhase("busy");
  try {
    let perm = permission();
    if (perm === "default") perm = await Notification.requestPermission();   // the ONLY place the browser prompt is opened — from a click
    st.permission = perm;
    if (perm !== "granted") {
      setPhase(perm === "denied" ? "denied" : "off");
      return { ok: false, code: perm === "denied" ? "permission_denied" : "permission_dismissed" };
    }
    const { token } = await fetchToken();
    const prefs = readPrefs(user.uid);
    await api("subscribe", subscribeBody(token, (onRec(user.uid) || {}).token, prefs));
    st.prefs = prefs;
    confirmedPrefs = { ...prefs };
    setOnRec(user.uid, { at: Date.now(), token });
    st.syncPending = false;
    setPhase("on");
    refreshDevices().catch(() => { /* the list is optional */ });
    return { ok: true };
  } catch (err) {
    const code = errCode(err);
    setPhase(permission() === "denied" ? "denied" : "off");
    return fail(code);
  }
}

export async function disable() {
  const user = auth.currentUser;
  if (!user) return fail("unauthenticated");
  if (st.phase === "busy") return { ok: false, code: "busy" };
  st.error = "";
  setPhase("busy");
  await dropSubscription();                                        // delivery to this browser stops right now …
  clearOnRec(user.uid);
  st.devices = null;
  setPhase("off");
  try { await api("unsubscribe", { deviceKey: deviceKey() }); }    // … and the server record follows (if that fails, the dead token is dropped on its next send)
  catch { /* ignore */ }
  return { ok: true };
}

let prefChain = Promise.resolve();                                 // saves run one after another, so the server always ends on the newest choice
export function setPref(category, value) {
  const user = auth.currentUser;
  if (!user || !C.CATEGORIES.includes(category)) return Promise.resolve({ ok: false, code: "invalid" });
  st.prefs = { ...st.prefs, [category]: !!value };                 // the switch moves at once …
  lsSet(K.prefs(user.uid), st.prefs);
  st.error = "";
  emit();
  prefChain = prefChain.then(async () => {                         // … and is saved right behind it
    const sent = { ...st.prefs };
    try { await api("prefs", { deviceKey: deviceKey(), prefs: sent }); confirmedPrefs = sent; return { ok: true }; }
    catch (err) {
      if (confirmedPrefs) { st.prefs = { ...confirmedPrefs }; lsSet(K.prefs(user.uid), st.prefs); }   // not saved → the switch goes back to what the server really has
      return fail(errCode(err));
    }
  });
  return prefChain;
}

/* ---------- a student session ---------- */
async function resync() {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const { token, reg } = await fetchToken();
    const rec = onRec(user.uid) || {};
    const stale = !rec.at || Date.now() - rec.at > DAY;
    if (token !== rec.token || stale) {
      await api("subscribe", subscribeBody(token, rec.token, null));
      setOnRec(user.uid, { at: Date.now(), token });
      reg.update().catch(() => { /* a new worker version rolls out at most once a day */ });
    }
    st.syncPending = false;
    st.error = "";
    st.phase = "on";
  } catch (err) {
    const code = errCode(err);
    if (code === "account_disabled") { clearOnRec(user.uid); st.phase = "off"; }
    else if (code === "permission_denied") st.phase = "denied";
    else if (err instanceof PushApiError || code === "fcm_failed") st.syncPending = true;     // keep working with the token we hold; retry later
    st.error = code === "unauthenticated" ? "" : code;
  }
  emit();
}

async function beginSession(user) {
  st.uid = user.uid;
  st.error = "";
  const { support } = environment();
  st.support = support;
  st.permission = permission();
  st.prefs = readPrefs(user.uid);
  st.devices = null;
  if (!support.ok) { setPhase("unsupported"); return; }
  bumpVisits(user.uid);
  if (st.permission === "denied") { setPhase("denied"); return; }
  if (st.permission === "granted" && onRec(user.uid)) { setPhase("on"); await resync(); return; }   // turned on here before: re-check quietly
  setPhase("off");
}

async function endSession() {
  const had = readOn();
  st.uid = "";
  st.devices = null;
  const tokens = Object.entries(had).filter(([, r]) => r && r.token);
  if (tokens.length && "serviceWorker" in navigator) {
    await dropSubscription();                                     // the next person on this browser must not receive this student's notifications
    tokens.forEach(([uid, r]) => setOnRec(uid, { ...r, token: "" }));
  }
  setPhase(pushConfigured() ? "off" : "unconfigured");
}

/** The student may change the permission in the browser's site settings while this page is open → follow it (called on focus). */
export function recheck() {
  if (!st.uid || ["busy", "unsupported", "unconfigured", "idle"].includes(st.phase)) return;
  const perm = permission();
  if (perm === st.permission) return;
  st.permission = perm;
  if (perm === "denied") setPhase("denied");
  else if (perm === "granted" && onRec(st.uid)) { setPhase("on"); resync(); }
  else setPhase("off");
}

/* ---------- a tap on a notification while the site is open (sent by the worker) ---------- */
export function handleWorkerMessage(e) {
  if (!e || (e.origin && e.origin !== window.location.origin)) return;   // only same-origin workers can reach this channel at all; an empty origin is normal for worker messages
  const d = e.data;
  if (!d || d.type !== "tvp-open") return;
  const hash = C.safeRoute(d.hash);
  if (!hash) return;
  if (document.body.classList.contains("exam-taking")) return;    // never pull a student out of a running exam
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** Called once by push-boot.js. `early` = worker messages that arrived while this file was still loading. */
export function start({ early = [] } = {}) {
  if (!pushConfigured()) { setPhase("unconfigured"); return; }
  navigator.serviceWorker?.addEventListener("message", handleWorkerMessage);
  early.forEach(handleWorkerMessage);
  window.addEventListener("online", () => {
    if (st.syncPending && auth.currentUser && st.phase === "on") resync();
    else if (st.error && st.phase === "on") { st.error = ""; emit(); }   // a "could not save" line from while the connection was down is stale now
  });
  onAuthStateChanged(auth, (user) => { (user ? beginSession(user) : endSession()).catch((e) => console.warn("[push]", e)); });
}
