// ==========================================================================
// push-boot.js — the one entry point of push notifications on the student site (called by one line in js/app.js).
//
//   Dormant until js/push/push-config.js holds the public VAPID key: nothing is downloaded, drawn or listening,
//   so the site behaves exactly as it did before this feature existed.
//   Once configured, everything loads AFTER the first paint, when the browser is idle — it never competes with the page
//   the student came for, and a failure anywhere in js/push/ is caught here and can never touch login, exams or results.
// ==========================================================================
import { pushConfigured } from "./push-config.js";

let started = false;

export function initPush() {
  if (started || !pushConfigured()) return;
  started = true;

  // A tap on a notification can reach an already-open tab before the files below have loaded — keep those messages for later.
  const early = [];
  const keep = (e) => { if (e && e.data && e.data.type === "tvp-open") early.push(e); };
  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : null;
  try { if (sw) sw.addEventListener("message", keep); } catch { /* no service workers here */ }

  const go = async () => {
    try {
      const [student, ui] = await Promise.all([import("./push-student.js"), import("./push-ui.js")]);
      try { if (sw) sw.removeEventListener("message", keep); } catch { /* ignore */ }
      try { await ui.mount(student); } catch (err) { console.warn("[push] screens unavailable:", err); }
      student.start({ early });
    } catch (err) {
      console.warn("[push] unavailable:", err);                      // the rest of the site is unaffected
    }
  };

  if ("requestIdleCallback" in window) window.requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}
