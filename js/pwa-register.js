// ==========================================================================
// pwa-register.js — registers /service-worker.js and keeps it fresh.
//
//   • Registered after the page has loaded, so it never competes with the first paint.
//   • updateViaCache:"none" → the browser always asks the server whether service-worker.js changed.
//   • Long-lived sessions (an installed app can stay open for days) re-check when the tab comes back after 30+ min.
//   • A new worker takes over by itself (skipWaiting + clients.claim inside service-worker.js). The page is NEVER
//     reloaded automatically: the worker caches no scripts or pages, so there is nothing stale to refresh,
//     and an exam in progress is never interrupted.
// ==========================================================================
const RECHECK_AFTER_MS = 30 * 60 * 1000;
let started = false;

export function registerServiceWorker() {
  if (started) return;
  started = true;
  if (!("serviceWorker" in navigator) || !window.isSecureContext || window.location.protocol === "file:") return;

  const start = () => {
    navigator.serviceWorker
      .register("service-worker.js", { scope: "./", updateViaCache: "none" })
      .then(watchForUpdates)
      .catch((err) => console.warn("[pwa] service worker registration failed:", err));
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

function watchForUpdates(registration) {
  let lastCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < RECHECK_AFTER_MS) return;
    lastCheck = Date.now();
    registration.update().catch(() => { /* offline: try again next time */ });
  });
}
