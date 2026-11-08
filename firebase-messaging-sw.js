/* ==========================================================================
   firebase-messaging-sw.js — Tech Verse Exam push notifications (Firebase Cloud Messaging, Web SDK)

   A DEDICATED worker, registered by js/push/push-student.js with its own scope ("firebase-cloud-messaging-push-scope").
   No page lives in that scope, so this worker never controls a page: it cannot touch service-worker.js (the thin PWA
   worker), it cannot slow down or interrupt an exam, and it caches nothing but a tiny "already shown" list.

   What it does — and only this:
     1. A message arrives while no tab of the site is visible  → it draws the notification. The server sends DATA-ONLY
        messages, so this file decides what the notification looks like (title, text, icon, optional picture).
     2. A tap on the notification                              → focuses / opens the site at a page of THIS site.
        The destination is re-validated here: only "#/route[?query]" of the known routes, never another website.
     3. The same notification id arrives twice                 → one tag, so it replaces itself; the second copy is silent.
     4. A tab of the site IS visible                           → the Firebase SDK hands the message to that page instead
        (foreground: js/push/push-student.js shows an in-page banner), so nothing is drawn twice.
        Exception: when the only visible tab is the admin panel (it runs no push code) this file draws it — see 1b.

   The Firebase settings below are PUBLIC identifiers (not secrets). They arrive in the query string of this file's URL,
   which js/push/push-student.js builds from js/firebase-config.js — one source of truth, nothing to keep in sync.
   No credential of any kind is, or may ever be, in this file.
   ========================================================================== */
'use strict';

const SW_VERSION = '2026-11-06.1';
const FIREBASE_VERSION = '10.13.0';                       // the same release the pages use (js/firebase-config.js)
const SEEN_CACHE = 'tvpush-seen-v1';                      // NOT "tve-…": service-worker.js deletes every cache with that prefix
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_MAX = 60;

const ROOT = new URL('./', self.location.href);           // the site root — this file lives there
const ICON = new URL('assets/pwa/icon-192.png', ROOT).href;
const BADGE = new URL('assets/push/badge-72.png', ROOT).href;

// Keep in step with SITE_ROUTES in server/push/config.js and js/push/push-core.js (tests/unit/push.test.mjs checks all three).
const ROUTES = ['home', 'exam', 'exams', 'categories', 'schedule', 'notifications', 'leaderboard', 'performance', 'results', 'profile', 'about', 'faq', 'help', 'privacy', 'terms', 'credits'];
const ROUTE_RE = new RegExp('^#/(?:' + ROUTES.join('|') + ')(?:\\?[A-Za-z0-9_=&%.-]{1,200})?$');
const NID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TAG_RE = /^tvp-[A-Za-z0-9_-]{1,40}$/;
const CATEGORIES = ['announcement', 'exam', 'result'];

/* ---------- small, defensive helpers ---------- */
function clip(v, max, keepNewlines) {
  if (typeof v !== 'string') return '';
  const flat = keepNewlines ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ') : v.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return Array.from(flat.trim()).slice(0, max).join('');
}

/** "#/results" → "#/results";  anything that is not a known route of this site → "" */
function safeHash(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  return s.length <= 260 && ROUTE_RE.test(s) ? s : '';
}

/** https only, no credentials → href, else "" (pictures are fetched by the browser, never by this worker). */
function httpsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 600) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
  } catch (e) { return ''; }
}

/** The data part of an FCM message → what is safe to show, or null when it is not one of ours. */
function normalize(d) {
  if (!d || typeof d !== 'object') return null;
  const nid = typeof d.nid === 'string' && NID_RE.test(d.nid) ? d.nid : '';
  const title = clip(d.title, 120, false);
  if (!nid || !title) return null;                         // never draw a blank or foreign notification
  const ts = Number(d.ts);
  return {
    nid, title,
    body: clip(d.body, 400, true),
    url: safeHash(d.url) || '#/home',
    cat: CATEGORIES.indexOf(d.cat) >= 0 ? d.cat : 'announcement',
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    tag: typeof d.tag === 'string' && TAG_RE.test(d.tag) ? d.tag : 'tvp-' + nid.slice(0, 40),
    image: httpsUrl(d.image),
    icon: httpsUrl(d.icon),
  };
}

/* ---------- "already shown" list (Cache Storage) ---------- */
const seenRequest = (nid) => new Request(new URL('__tvp_seen__/' + encodeURIComponent(nid), ROOT).href);

async function wasSeen(nid) {
  try {
    const hit = await (await caches.open(SEEN_CACHE)).match(seenRequest(nid));
    const t = hit ? Number(hit.headers.get('x-tvp-t')) : NaN;
    return Number.isFinite(t) && Date.now() - t < SEEN_TTL_MS;
  } catch (e) { return false; }
}

async function markSeen(nid) {
  try {
    const cache = await caches.open(SEEN_CACHE);
    await cache.put(seenRequest(nid), new Response('1', { headers: { 'x-tvp-t': String(Date.now()) } }));
    const keys = await cache.keys();
    if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX / 2)) await cache.delete(k);   // oldest first
  } catch (e) { /* storage unavailable: the tag alone still prevents two visible copies */ }
}

/* ---------- 1. draw the notification ---------- */
async function showFromPayload(payload) {
  const n = normalize(payload && payload.data);
  if (!n) return;
  // Chrome requires every push to end in a visible notification, so a repeat is never skipped — it replaces the first one
  // (same tag) and stays silent. Only a notification that is new to this device is allowed to make a sound.
  const repeat = await wasSeen(n.nid);
  if (!repeat) await markSeen(n.nid);
  const options = {
    body: n.body, icon: n.icon || ICON, badge: BADGE, tag: n.tag, renotify: false, silent: repeat, lang: 'bn', timestamp: n.ts,
    data: { nid: n.nid, url: n.url, cat: n.cat },
  };
  if (n.image) options.image = n.image;
  await self.registration.showNotification(n.title, options);
}

/* ---------- 1b. only the admin panel is open ---------- */
// The SDK hands a message to the PAGE whenever a tab of the site is visible — and admin.html runs no push code, so when the
// admin panel is the only visible tab nothing would be shown at all ("Send test" from the panel would look broken, and an
// admin who is also a student would miss real notifications). This listener draws the notification in exactly that case.
// With a student page visible it does nothing (the page's banner stays the only copy); with no tab visible it does nothing
// (the SDK's background handler below draws it). Should both ever draw, the same tag makes the second one replace the first.
const isStudentPage = (c) => {
  try { const u = new URL(c.url); return u.origin === ROOT.origin && [ROOT.pathname, ROOT.pathname + 'index.html'].indexOf(u.pathname) >= 0; } catch (e) { return false; }
};
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = null;
    try { payload = event.data ? event.data.json() : null; } catch (e) { return; }
    if (!payload || typeof payload !== 'object') return;
    const visible = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => c.visibilityState === 'visible');
    if (visible.length === 0 || visible.some(isStudentPage)) return;
    await showFromPayload(payload);
  })());
});

/* ---------- 2. a tap on it ---------- */
// Registered BEFORE the Firebase SDK starts, so our handler always runs; the SDK ignores notifications it did not create.
self.addEventListener('notificationclick', (event) => {
  const d = event.notification && event.notification.data;
  if (!d || typeof d.nid !== 'string') return;             // not one of ours
  event.notification.close();
  event.waitUntil(openTarget(safeHash(d.url) || '#/home'));
});

async function openTarget(hash) {
  const target = new URL(hash, ROOT).href;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = all.filter(isStudentPage);                  // a tab of the STUDENT site (not admin.html, not another origin)
  const tab = mine.find((c) => c.visibilityState === 'visible') || mine[0];
  if (tab) {
    try { await tab.focus(); } catch (e) { /* focus can be refused; the message below still goes */ }
    tab.postMessage({ type: 'tvp-open', hash });           // the page decides (it never leaves a running exam)
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}

/* ---------- lifecycle ---------- */
self.addEventListener('install', () => { self.skipWaiting(); });                       // stateless → safe to take over at once
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/* ---------- 3. Firebase Cloud Messaging ---------- */
const q = new URL(self.location.href).searchParams;
const firebaseConfig = {
  apiKey: q.get('k') || '', projectId: q.get('p') || '', messagingSenderId: q.get('s') || '', appId: q.get('a') || '',
};
if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId) {
  importScripts(
    'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/firebase-messaging-compat.js'
  );
  firebase.initializeApp(firebaseConfig);
  // Called by the SDK only when NO tab of the site is visible (otherwise the page receives it: see point 4 at the top).
  firebase.messaging().onBackgroundMessage((payload) => showFromPayload(payload));
}

// The SDK may also import scripts or log; keep a version marker visible in DevTools for support.
self.__TVP_SW_VERSION__ = SW_VERSION;
