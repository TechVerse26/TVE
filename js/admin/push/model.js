// ==========================================================================
// admin/push/model.js — everything the Push Notifications page does with the server and with Firestore.
//
//   server (js/push/push-api.js → /api/push/*):  health · history · process · cancel · audit · images …
//   Firestore (read only, existing loaders):      students, exams, programs / levels for the audience pickers
//
// Nothing here decides whether something is ALLOWED — the server checks the admin role on every call.
// ==========================================================================
import { api } from "../../push/push-api.js";
import { pushConfigured } from "../../push/push-config.js";
import { describeHealth, DEFAULT_LIMITS } from "../../push/push-admin-core.js";
import { fetchAllUsersAdmin, fetchAllExamsAdmin } from "../../exam-data.js";
import { loadAcademic } from "../core/academic-data.js";
import { byOrder } from "../../academic-core.js";
import { S, emit } from "./state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = 30;

/* ---------- /health ---------- */
let healthRun = null;
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

export function refreshSetup() {
  S.setup = describeHealth({ health: S.health, error: S.healthError, vapid: pushConfigured(), now: S.health ? S.health.now : Date.now() });
}

/** Ask the server what it is (project, timer, devices, limits). Cached for a minute unless forced. */
export function loadHealth({ force = false } = {}) {
  if (healthRun) return healthRun;
  if (!force && S.healthStatus === "ready" && Date.now() - S.healthAt < 60000) return Promise.resolve();
  S.healthStatus = "loading";
  emit("health");
  healthRun = (async () => {
    try {
      const h = await api("health", {}, { timeoutMs: 15000 });
      S.health = h;
      S.healthError = null;
      S.healthStatus = "ready";
      const lim = {};
      for (const k of LIMIT_KEYS) if (h.limits && Number.isFinite(h.limits[k])) lim[k] = h.limits[k];
      S.limits = { ...DEFAULT_LIMITS, ...lim };
    } catch (err) {
      S.health = null;
      S.healthError = err;
      S.healthStatus = "error";
    }
    S.healthAt = Date.now();
    refreshSetup();
    emit("health");
  })().finally(() => { healthRun = null; });
  return healthRun;
}

/* ---------- history ---------- */
let jobsRun = null;

export function loadJobs({ more = false } = {}) {
  if (jobsRun) return jobsRun;
  if (more && !S.next) return Promise.resolve();
  S.jobsStatus = "loading";
  if (!more) S.jobsError = null;
  emit("jobs");
  jobsRun = (async () => {
    try {
      const r = await api("history", { limit: PAGE, ...(more ? { before: S.next } : {}) }, { timeoutMs: 20000 });
      const items = Array.isArray(r.items) ? r.items : [];
      if (more) {
        const seen = new Set(S.jobs.map((j) => j.id));
        S.jobs = [...S.jobs, ...items.filter((j) => !seen.has(j.id))];
      } else {
        S.jobs = items;
      }
      S.next = r.next || null;
      S.jobsStatus = "ready";
      S.jobsAt = Date.now();
    } catch (err) {
      S.jobsError = err;
      S.jobsStatus = "error";
    }
    emit("jobs");
  })().finally(() => { jobsRun = null; });
  return jobsRun;
}

/** A job the server just returned: replace it in the list, or add it at the top. */
export function upsertJob(job) {
  if (!job || !job.id) return;
  const i = S.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) S.jobs[i] = job;
  else { S.jobs.unshift(job); S.jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  emit("jobs");
}

/** Ask the server to work on whatever is due (scheduled sends whose time has come). One cheap read when nothing is. */
export async function tick() {
  const r = await api("process", {}, { timeoutMs: 40000 });
  (r.jobs || []).forEach(upsertJob);
  return r;
}

const driving = new Map();
/**
 * Keep a big send going until it is finished. One server call handles a few hundred devices within its time budget; this
 * simply calls again until the server says the job is final. Calls for the same job are shared, so two screens never
 * drive one job twice. `onUpdate(job)` after every step.
 */
export function driveJob(id, { onUpdate } = {}) {
  if (driving.has(id)) return driving.get(id);
  const run = (async () => {
    let last = null;
    for (let step = 0; step < 400; step++) {
      const r = await api("process", { id }, { timeoutMs: 40000 });
      if (r.job) { last = r.job; upsertJob(r.job); if (onUpdate) onUpdate(r.job); }
      if (r.done || !r.job || r.job.status !== "sending") return last;
      await sleep(r.busy ? 2500 : 150);     // busy = another request is sending it right now: wait, then look again
    }
    return last;
  })().finally(() => driving.delete(id));
  driving.set(id, run);
  return run;
}
export const isDriving = (id) => driving.has(id);

export async function cancelJob(id) {
  const r = await api("cancel", { id }, { timeoutMs: 20000 });
  upsertJob(r.job);
  return r.job;
}

/* ---------- audit trail ---------- */
export async function loadAudit({ before = null } = {}) {
  const r = await api("audit", { limit: PAGE, ...(before ? { before } : {}) }, { timeoutMs: 20000 });
  return { items: Array.isArray(r.items) ? r.items : [], next: r.next || null };
}

/* ---------- pictures ---------- */
export async function listImages() {
  const r = await api("images", {}, { timeoutMs: 20000 });
  return Array.isArray(r.images) ? r.images : [];
}
export async function uploadImage({ kind, name, data, thumb }) {
  const r = await api("upload", { kind, name, data, thumb }, { timeoutMs: 60000 });
  return r.image;
}
export async function deleteImage(id) {
  await api("image-delete", { id }, { timeoutMs: 20000 });
}

/* ---------- audience pickers: read once, kept, re-read on demand ---------- */
const slot = (key) => S.data[key];

async function fill(key, read, apply) {
  const d = slot(key);
  if (d.status === "loading") return;
  d.status = "loading"; d.error = null;
  emit("data");
  try { apply(d, await read()); d.status = "ready"; } catch (err) { d.error = err; d.status = "error"; }
  emit("data");
}

export const ensureStudents = ({ force = false } = {}) => (!force && slot("students").status === "ready" ? null : fill("students",
  () => fetchAllUsersAdmin({ force }),
  (d, users) => {
    d.list = users.filter((u) => u && u.id && !u.disabled).map((u) => ({
      id: u.id, name: u.displayName || "", email: u.email || "", roll: u.roll || "", admin: u.isAdmin === true,
      hay: `${u.displayName || ""} ${u.email || ""} ${u.roll || ""}`.toLowerCase(),
    })).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "bn", { numeric: true, sensitivity: "base" }));
  }));

export const ensureExams = ({ force = false } = {}) => (!force && slot("exams").status === "ready" ? null : fill("exams",
  () => fetchAllExamsAdmin({ force }),
  (d, exams) => {
    d.list = exams.filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title || "(untitled exam)", draft: e.status === "draft" }));
  }));

export const ensureAcademic = ({ force = false } = {}) => {
  const d = slot("academic");
  if (!force && d.status === "ready") return null;
  if (d.status === "loading") return null;
  d.status = "loading"; d.error = null;
  emit("data");
  return loadAcademic({ force }).then((a) => {
    d.sections = [...(a.sections || [])].sort(byOrder).map((s) => ({ id: s.id, name: s.name || "(untitled)", inactive: s.status !== "active" }));
    d.levels = [...(a.levels || [])].sort(byOrder).map((l) => ({ id: l.id, name: l.name || "(untitled)", sectionId: l.sectionId || "", inactive: l.status !== "active" }));
    d.status = "ready";
  }).catch((err) => { d.error = err; d.status = "error"; }).finally(() => emit("data"));
};

export function resetPickers() {
  S.data.students = { status: "idle", list: [], error: null };
  S.data.exams = { status: "idle", list: [], error: null };
  S.data.academic = { status: "idle", sections: [], levels: [], error: null };
}
