// ==========================================================================
// page-lifecycle.js — "we are leaving this page" hooks. A page registers whatever it started
// (timers, listeners on window/document) with onPageLeave(); app.js runs them all on the next navigation.
// ==========================================================================
let cleanups = [];

/** Register a function to run once, when the user navigates away from the current page. */
export function onPageLeave(fn) { cleanups.push(fn); }

export function runPageCleanups() {
  const list = cleanups;
  cleanups = [];
  list.forEach((fn) => { try { fn(); } catch (err) { console.error("page cleanup failed:", err); } });
}
