// ==========================================================================
// admin/push/state.js — the one shared state object of the Push Notifications page, plus a tiny event bus.
// The tabs read S and call the actions in model.js; nothing else is shared, so the tabs stay independent.
// ==========================================================================
import { DEFAULT_LIMITS, emptyForm } from "../../push/push-admin-core.js";

export const TABS = [
  { id: "send", label: "Send", icon: "fa-paper-plane" },
  { id: "history", label: "History", icon: "fa-clock-rotate-left" },
  { id: "setup", label: "Setup & Audit", icon: "fa-screwdriver-wrench" },
];

const loadable = () => ({ status: "idle", list: [], error: null });

export const S = {
  canManage: false,
  tab: "send",

  // what the server says about itself (/api/push/health)
  health: null, healthError: null, healthStatus: "idle", healthAt: 0,
  setup: null,                         // describeHealth(…) — the checklist, and whether sending is possible at all
  limits: { ...DEFAULT_LIMITS },

  // history: newest first
  jobs: [], next: null, jobsStatus: "idle", jobsError: null, jobsAt: 0,
  openJob: "",                         // a job id the History tab should open as soon as it is shown

  // the notification being written
  form: emptyForm(),
  reqSend: null, reqTest: null,        // { fp, id } — see requestSlot() in push-admin-core.js
  sending: false,                      // a send / test request is in flight (blocks a second click)

  // lists the pickers need — each loaded the first time it is wanted, then kept
  data: { students: loadable(), exams: loadable(), academic: { status: "idle", sections: [], levels: [], error: null } },
};

/* ---- tiny event bus ---- */
const subs = new Map();
let scope = null;
export const on = (evt, fn) => {
  (subs.get(evt) || subs.set(evt, new Set()).get(evt)).add(fn);
  const off = () => subs.get(evt)?.delete(fn);
  scope?.push(off);
  return off;
};
export const emit = (evt, payload) => subs.get(evt)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error(`[push-admin] "${evt}" handler failed`, e); } });
/** Run `fn` and remember every on() it registers; the returned function removes them all (used when a tab is re-created). */
export function collect(fn) {
  const mine = [];
  const prev = scope;
  scope = mine;
  try { fn(); } finally { scope = prev; }
  return () => mine.forEach((off) => off());
}
