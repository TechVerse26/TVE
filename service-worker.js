/* ==========================================================================
   service-worker.js — Tech Verse Exam  (scope: the whole site, registered by js/pwa-register.js)

   Deliberately THIN, so it can never get in the way of a live exam:

   ✔ makes the app installable
   ✔ page navigations always go to the network; only when the device is offline the visitor sees offline.html
   ✔ the logo / icon images under /assets/ are cached (stale-while-revalidate) so they appear instantly

   ✘ it never caches HTML, JavaScript, CSS, JSON or any API response — a new deployment is live on the next load
   ✘ it never touches anything that is not a same-origin GET: Firebase Auth / Firestore, Google, CDN scripts,
     EmailJS, the server-time HEAD request, form posts … go straight to the network, untouched
   ✘ nothing user-specific (tokens, profile, exam questions, answers, submissions, results) is ever stored here

   UPDATING: the browser re-checks this file on every load. Change SW_VERSION whenever you change
   offline.html or the lists below — the new worker installs, takes over by itself, and old caches are deleted.
   ========================================================================== */
const SW_VERSION = "2026-10-29.1";
const PRECACHE = `tve-precache-${SW_VERSION}`;
const IMAGES = "tve-images-v1";
const MAX_IMAGES = 60;

const OFFLINE_URL = new URL("offline.html", self.location.href).href;
const IMAGE_PREFIX = new URL("assets/", self.location.href).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));   // bypass the HTTP cache: always the freshest offline page
    await self.skipWaiting();                                          // thin worker → safe to take over immediately
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();   // no start-up delay on navigations
    for (const key of await caches.keys()) {
      if (key.startsWith("tve-") && key !== PRECACHE && key !== IMAGES) await caches.delete(key);   // old versions
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;                                // HEAD (server clock), POST … → the browser handles them
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;                     // Firebase, Google, CDNs … → the browser handles them

  if (request.mode === "navigate") { event.respondWith(navigate(event)); return; }
  if (request.destination === "image" && url.pathname.startsWith(IMAGE_PREFIX)) { event.respondWith(cachedImage(event)); return; }
  // everything else (scripts, styles, data) → no respondWith: normal network + HTTP cache, exactly as without a worker
});

/* page loads: network first, always; offline.html only when the network is unreachable */
async function navigate(event) {
  try {
    const preloaded = await event.preloadResponse;
    return preloaded || (await fetch(event.request));
  } catch {
    const offline = await (await caches.open(PRECACHE)).match(OFFLINE_URL);
    return offline || new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

/* images under /assets/: serve the stored copy at once, refresh it in the background */
async function cachedImage(event) {
  const cache = await caches.open(IMAGES);
  const stored = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === "basic") {
      await cache.put(event.request, response.clone());
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - MAX_IMAGES; i++) await cache.delete(keys[i]);   // keep the store small
    }
    return response;
  }).catch(() => null);
  if (stored) { event.waitUntil(refresh); return stored; }
  return (await refresh) || Response.error();
}
