// ==========================================================================
// server-time.js — a clock the student can trust.
//
// A phone with the wrong date/time would otherwise show a wrong countdown and flip an exam to
// "Live" too early or too late. The browser's HTTP `Date` header comes from the web server (Firebase
// Hosting / GitHub Pages), so one tiny same-origin HEAD request tells us how far the device clock is
// from real time. That costs nothing in Firestore reads/writes. serverNow() = device clock + that offset.
//
//   • synced on every page load (the previous offset is kept in sessionStorage so the very first paint
//     after a refresh is already right), and again whenever the tab becomes visible after 10+ minutes.
//   • if the request fails (offline, file://) the offset stays 0 → behaviour is exactly as before.
//
// This is the DISPLAY clock. The hard gate is the server too: examBundles / exam questions are only
// readable by students once Firestore's own `request.time` is inside the exam window (firestore.rules).
// ==========================================================================
const SS_KEY = "tvexam_clock_v1";
const RESYNC_AFTER_MS = 10 * 60 * 1000;

let offset = 0;          // serverTime − deviceTime, in ms
let synced = false;
let lastSyncPerf = -Infinity; // performance.now() of the last good sync (immune to device-clock edits)
let inflight = null;

try {
  const saved = JSON.parse(window.sessionStorage.getItem(SS_KEY) || "null");
  if (saved && Number.isFinite(saved.offset)) { offset = saved.offset; synced = true; }
} catch { /* storage blocked → start at 0 */ }

/** Current time according to the server, in epoch ms. Use this instead of Date.now() for anything schedule-related. */
export const serverNow = () => Date.now() + offset;
export const clockOffsetMs = () => offset;
export const isClockSynced = () => synced;
/** True when the device clock is off by more than `limitMs` (default 2 min) — worth telling the student. */
export const isDeviceClockOff = (limitMs = 2 * 60 * 1000) => synced && Math.abs(offset) > limitMs;

async function takeSample() {
  const url = new URL(window.location.pathname || "/", window.location.origin);
  url.searchParams.set("_t", String(Date.now())); // defeat any CDN / browser cache of the HEAD response
  const p0 = performance.now();
  const t0 = Date.now();
  const res = await fetch(url.toString(), { method: "HEAD", cache: "no-store", credentials: "omit" });
  const p1 = performance.now();
  const t1 = Date.now();
  const header = res.headers.get("date");
  const serverMs = header ? Date.parse(header) : NaN;
  if (!Number.isFinite(serverMs)) throw new Error("no-date-header");
  const rtt = p1 - p0;
  if (rtt > 8000) throw new Error("too-slow");
  const age = Number(res.headers.get("age")) || 0; // a CDN-cached copy keeps its original Date; Age says how old it is
  // The Date header has 1-second resolution (truncated) → +500 ms is the expected value; the reply was
  // produced about half a round trip before it reached us.
  const serverAtReceive = serverMs + age * 1000 + 500 + rtt / 2;
  return { offset: serverAtReceive - t1, rtt, t0 };
}

/**
 * Re-measure the offset. Safe to call often: concurrent calls share one request and, unless `force`,
 * a recent good sync is reused.
 */
export function syncServerTime({ force = false } = {}) {
  if (window.location.protocol === "file:") return Promise.resolve(offset);
  if (!force && performance.now() - lastSyncPerf < RESYNC_AFTER_MS) return Promise.resolve(offset);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let best = await takeSample();
      if (best.rtt > 1500) { // slow link: one more try, keep the sample with the shorter round trip
        try { const again = await takeSample(); if (again.rtt < best.rtt) best = again; } catch { /* keep first */ }
      }
      offset = best.offset;
      synced = true;
      lastSyncPerf = performance.now();
      try { window.sessionStorage.setItem(SS_KEY, JSON.stringify({ offset })); } catch { /* ignore */ }
    } catch { /* offline / blocked → keep whatever offset we had */ }
    finally { inflight = null; }
    return offset;
  })();
  return inflight;
}

/** Wait for a sync, but never hold the page up for more than `ms`. */
export function syncServerTimeSoon(ms = 900) {
  return Promise.race([syncServerTime(), new Promise((resolve) => setTimeout(() => resolve(offset), ms))]);
}

// Coming back to a tab that has been in the background for a while: the device may have slept → re-measure.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncServerTime();
  });
}
