import { CapacitorHttp } from "@capacitor/core";
import { SITE_URL } from "./config";
import { setClock, clockOffsetMs } from "./clock";

export { serverNow, clockOffsetMs, isClockSynced, isDeviceClockOff } from "./clock";

// Same idea as the website's js/server-time.js: measure (server clock − device clock) from the website's HTTP `Date`
// header, so a phone with the wrong time still counts exam schedules and deadlines correctly.
const RESYNC_AFTER_MS = 10 * 60 * 1000;
let lastSyncPerf = -Infinity;
let inflight: Promise<number> | null = null;


function header(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
  return k ? String(headers[k]) : "";
}

async function takeSample() {
  const p0 = performance.now();
  const res = await CapacitorHttp.request({ url: `${SITE_URL}/?_t=${Date.now()}`, method: "HEAD", headers: { "Cache-Control": "no-cache" }, connectTimeout: 6000, readTimeout: 6000 });
  const p1 = performance.now();
  const t1 = Date.now();
  const serverMs = Date.parse(header(res.headers as any, "date"));
  if (!Number.isFinite(serverMs)) throw new Error("no-date-header");
  const rtt = p1 - p0;
  if (rtt > 8000) throw new Error("too-slow");
  const age = Number(header(res.headers as any, "age")) || 0; // a CDN-cached copy keeps its original Date; Age says how old it is
  return { offset: serverMs + age * 1000 + 500 + rtt / 2 - t1, rtt };
}

export function syncServerTime({ force = false } = {}): Promise<number> {
  if (!force && performance.now() - lastSyncPerf < RESYNC_AFTER_MS) return Promise.resolve(clockOffsetMs());
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let best = await takeSample();
      if (best.rtt > 1500) { try { const again = await takeSample(); if (again.rtt < best.rtt) best = again; } catch { /* keep first */ } }
      setClock(best.offset); lastSyncPerf = performance.now();
    } catch { /* offline / blocked → keep whatever offset we had */ }
    finally { inflight = null; }
    return clockOffsetMs();
  })();
  return inflight;
}

/** Wait for a sync, but never hold a screen up for more than `ms`. */
export const syncServerTimeSoon = (ms = 900) => Promise.race([syncServerTime(), new Promise<number>((r) => setTimeout(() => r(clockOffsetMs()), ms))]);

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void syncServerTime(); });
}
