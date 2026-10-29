// ==========================================================================
// admin/email/state.js — the one shared state object of the Email Center page, plus a tiny event bus.
// Every tab reads S and calls the actions in model.js; nothing else is shared, so tabs stay independent.
// ==========================================================================
import { normalizeSettings } from "../../email-service.js";
import { contentFor, templateById } from "../../email-templates-data.js";

export const TABS = [
  { id: "overview", label: "Overview", icon: "fa-gauge" },
  { id: "compose", label: "Compose Email", icon: "fa-pen-to-square" },
  { id: "reminders", label: "Exam Reminders", icon: "fa-bell" },
  { id: "recipients", label: "Student Recipients", icon: "fa-users" },
  { id: "templates", label: "Email Templates", icon: "fa-file-lines" },
  { id: "history", label: "Campaign History", icon: "fa-clock-rotate-left" },
  { id: "settings", label: "Email Settings", icon: "fa-gear" },
];

export const newDraft = () => ({
  id: null,                    // Firestore id once saved as a draft
  name: "", type: "announcement", lang: "en",
  mode: "manual",              // how the recipients were chosen: all | course | exam | manual (the selection below is what counts; nobody is ticked at first)
  examId: "", courseIds: [], groups: ["not_attempted", "no_result_unverified"],
  selected: new Set(),         // uids that will receive the e-mail — what is ticked is exactly what is sent
  content: contentFor(templateById("general"), "en"), templateId: "general", templateName: "General Announcement",
  personalMessage: "", deadline: "",   // deadline: a datetime-local string, "" = none
  missingPolicy: "block",      // block | skip | fallback — what to do when a student lacks data a variable needs
  source: null,                // { type: "notice", id, title } when prepared from a website notice
  sentFps: [],                 // fingerprints of campaigns sent from this draft in this session (blocks an accidental second send)
  touched: false,              // the admin edited the content by hand (so a type change asks before replacing it)
});

export const S = {
  me: null, canManage: false, canSettings: false,
  tab: "overview",
  // base data
  status: "loading",           // loading | ready | error
  error: null, denied: false,
  loadedAt: 0,
  students: [], byUid: new Map(),
  exams: [], examsById: new Map(),
  courses: [], courseTitle: new Map(),
  settings: normalizeSettings({}), settingsMeta: { source: "defaults" },
  templates: [], templatesError: null,
  campaigns: [], campaignsError: null,
  // per exam: { status: "loading"|"ready"|"error", resultsByUid: Map|null, sessionsByUid: Map|null, loadedAt }
  examData: new Map(),
  // the campaign being prepared
  draft: newDraft(),
  // derived by recompute()
  derived: { exam: null, examState: null, cls: null, clsByUid: new Map(), counts: null, sendable: [], skipped: [], selectedCount: 0, resultsOk: null, sessionsOk: null },
  // recipients-tab filters (kept so switching tabs does not reset them)
  filters: { q: "", course: "", status: "", account: "", roll: "", picked: "" },
  openCampaign: "",            // a campaign id the History tab should open as soon as it is shown
  sending: null,               // the active run, or null
  lastRun: null,
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
export const emit = (evt, payload) => subs.get(evt)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error(`[email-center] "${evt}" handler failed`, e); } });
/** Run `fn` and remember every on() it registers; the returned function removes them all (used when a tab is re-created). */
export function collect(fn) {
  const mine = [];
  const prev = scope;
  scope = mine;
  try { fn(); } finally { scope = prev; }
  return () => mine.forEach((off) => off());
}

export const courseTitleOf = (id) => S.courseTitle.get(id) || "";
