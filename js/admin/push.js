// ==========================================================================
// admin/push.js — Admin Panel → Communication → Push Notifications.
//
// Write a notification, choose who gets it and when, send a test to your own devices, follow what happened, and see who did what.
// Sending goes through the free push server (api/push/* on Vercel → FCM HTTP v1); this page never holds a secret and never decides
// who is allowed — the server checks the admin role on every request. `can("push.manage")` only decides what is SHOWN.
//
// This file is only the SHELL (tabs, lifecycle, and the small ticker that lets an open page send what has become due).
// The work lives in js/admin/push/:
//   state.js    shared state + event bus         model.js    server / Firestore calls         images.js   picture picker
//   view-send.js · view-history.js · view-setup.js   one file per tab                          preview.js  notification preview
// and in the pure, unit-tested rules js/push/push-admin-core.js (the server enforces the same rules again).
//
// Same lifecycle as every other admin page: mount(root) once, activate() on every later visit.
// Cost on the free quotas: opening the page = one `health` call + one `history` call (≤ 30 reads). While nothing is scheduled or
// sending, the ticker is completely idle; it only wakes when something is waiting for its time, and never while the tab is hidden.
// ==========================================================================
import { esc, pageHead, errorState, withBusy } from "./core/ui.js";
import { can } from "./core/permissions.js";
import { toast } from "../utils.js";
import * as A from "../push/push-admin-core.js";
import { S, TABS, on } from "./push/state.js";
import * as M from "./push/model.js";
import * as send from "./push/view-send.js";
import * as history from "./push/view-history.js";
import * as setup from "./push/view-setup.js";

const VIEWS = { send, history, setup };
const mounted = new Set();
let root = null, body = null, booted = false;

/* ---------- styles: loaded with this page only, so the other admin pages (and the student site) never pay for them ---------- */
function cssReady() {
  let link = document.getElementById("pn-css");
  if (!link) {
    link = document.createElement("link");
    link.id = "pn-css";
    link.rel = "stylesheet";
    link.href = new URL("../../css/admin-push.css", import.meta.url).href;
    link.ready = new Promise((resolve) => { link.onload = link.onerror = () => resolve(); setTimeout(resolve, 4000); });
    document.head.appendChild(link);
  }
  return link.ready || Promise.resolve();
}

/* ---------- tab strip ---------- */
function shellHtml() {
  return `
    <div id="pn-strip"></div>
    <div class="pn-tabs" role="tablist" aria-label="Push Notification sections">${TABS.map((t) => `
      <button type="button" role="tab" id="pn-tab-${t.id}" class="pn-tab" data-tab="${t.id}" aria-controls="pn-panel-${t.id}" aria-selected="false" tabindex="-1"><i class="fa-solid ${t.icon}" aria-hidden="true"></i><span>${esc(t.label)}</span></button>`).join("")}</div>
    <div class="pn-panels">${TABS.map((t) => `<div id="pn-panel-${t.id}" class="pn-panel" role="tabpanel" aria-labelledby="pn-tab-${t.id}" tabindex="0" hidden></div>`).join("")}</div>`;
}

function show(id, { focus = false } = {}) {
  if (!VIEWS[id] || !body) return;
  S.tab = id;
  for (const t of TABS) {
    const on_ = t.id === id;
    const btn = body.querySelector(`#pn-tab-${t.id}`);
    btn.setAttribute("aria-selected", String(on_));
    btn.tabIndex = on_ ? 0 : -1;
    body.querySelector(`#pn-panel-${t.id}`).hidden = !on_;
  }
  if (focus) body.querySelector(`#pn-tab-${id}`)?.focus();
  if (!mounted.has(id)) { mounted.add(id); VIEWS[id].mount(body.querySelector(`#pn-panel-${id}`)); }
  VIEWS[id].activate?.();
  paintStrip();
  body.querySelector(`#pn-tab-${id}`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
  armFromJobs();
}

/* ---------- a strip above the tabs while the push server cannot be used ---------- */
function paintStrip() {
  const el = body && body.querySelector("#pn-strip");
  if (!el) return;
  const s = S.setup;
  if (!s || s.canSend) { el.innerHTML = ""; return; }
  const bad = s.items.find((i) => i.tone === "bad");
  el.innerHTML = `<div class="note bad pn-strip" role="alert"><i class="fa-solid fa-triangle-exclamation"></i> <span><b>The push server is not ready.</b> ${esc(bad ? bad.text : "It did not answer.")} ${S.tab === "setup" ? "" : `<button type="button" class="link-btn" data-go="setup">Open Setup</button>`}</span></div>`;
}

/* ==========================================================================
   The ticker — lets an OPEN page send what has become due (the free outside timer does the same when the page is closed).

   • nothing scheduled or sending (as far as this page knows) → no timer at all
   • something is waiting for its time → one timeout, set for that moment
   • something is due → ask the server once (`process`); if somebody else already handled it, re-read the list to learn the truth
   • no progress → back off (5 s, 10 s, 20 s … at most 2 min) instead of hammering the server
   • never while the tab is hidden or another admin page is open; activate() / visibilitychange start it again
   ========================================================================== */
const T = { timer: 0, at: 0, busy: false, stuck: 0 };

const watching = () => S.canManage && !document.hidden && !!document.getElementById("section-push")?.classList.contains("active");
const dueList = (now) => S.jobs.filter((j) => (j.status === "sending" && !M.isDriving(j.id)) || (j.status === "scheduled" && (j.scheduledAt || 0) <= now + 1000));

function stopTicker() { clearTimeout(T.timer); T.timer = 0; }

function arm(delay) {
  if (!watching()) { stopTicker(); return; }
  const at = Date.now() + delay;
  if (T.timer && T.at <= at) return;           // a sooner wake-up is already planned
  clearTimeout(T.timer);
  T.at = at;
  T.timer = setTimeout(tickOnce, delay);
}

function armFromJobs() {
  const wait = A.nextCheckDelay(S.jobs, Date.now());
  if (wait !== null) arm(wait);
}

async function tickOnce() {
  T.timer = 0;
  if (!watching()) return;
  if (T.busy) { arm(5000); return; }
  const due = dueList(Date.now());
  if (!due.length) { armFromJobs(); return; }   // waiting for a time, or for a send this page is already driving
  T.busy = true;
  let next = null;                              // ms until the next look; null = decide from the list
  try {
    if (S.healthStatus === "error") {
      await M.loadHealth({ force: true });
      if (S.healthStatus === "error") { next = 60000; return; }
    }
    const before = due.map((j) => j.id).sort().join(",");
    const r = await M.tick();
    const handled = new Set((r.jobs || []).map((j) => j.id));
    if (dueList(Date.now()).some((j) => !handled.has(j.id))) await M.loadJobs();   // handled elsewhere (free timer, another admin) — learn the real state
    const after = dueList(Date.now()).map((j) => j.id).sort().join(",");
    T.stuck = after && after === before ? T.stuck + 1 : 0;
    if (!T.stuck && (r.jobs || []).some((j) => j.status === "sending")) next = 1500;   // a big send moved forward — keep it moving
  } catch {
    T.stuck += 1;
  } finally {
    T.busy = false;
    if (next === null && T.stuck > 0) next = Math.min(120000, 5000 * 2 ** (T.stuck - 1));
    if (next !== null) arm(next); else armFromJobs();
  }
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function buildShell() {
  body.innerHTML = shellHtml();
  const strip = body.querySelector(".pn-tabs");
  strip.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); });
  strip.addEventListener("keydown", (e) => {
    const ids = TABS.map((t) => t.id);
    const i = ids.indexOf(S.tab);
    const next = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[e.key];
    if (next) { e.preventDefault(); show(next, { focus: true }); }
  });
  body.querySelector("#pn-strip").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) show(b.dataset.go); });
}

function bootOnce() {
  if (booted) return;
  booted = true;
  // other tabs ask the shell to switch tabs ("Open Setup", "open in History", "Reuse the text" → Send)
  on("goto", ({ tab, job } = {}) => {
    if (job) S.openJob = job;
    if (VIEWS[tab]) show(tab);
  });
  on("health", paintStrip);
  on("jobs", armFromJobs);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopTicker(); return; }
    if (!watching()) return;
    if (S.jobsStatus !== "loading" && Date.now() - S.jobsAt > 30000 && S.jobsStatus !== "idle") M.loadJobs();
    armFromJobs();
  });
}

async function refreshAll(btn) {
  await withBusy(btn, async () => {
    const lists = [["students", M.ensureStudents], ["exams", M.ensureExams], ["academic", M.ensureAcademic]];
    for (const [key, fn] of lists) if (S.data[key].status !== "idle") fn({ force: true });   // only what the page already uses
    await Promise.all([M.loadHealth({ force: true }), M.loadJobs()]);
  });
  toast("Refreshed", "success");
}

/* ---------- the module contract ---------- */
export async function mount(el) {
  root = el;
  S.canManage = can("push.manage");
  root.innerHTML = `${pageHead({
    title: "Push Notification",
    desc: "Send a notification to students’ phones and computers — free, with Firebase Cloud Messaging. Only students who turned notifications on receive it.",
    actions: `<button type="button" class="btn btn-outline btn-sm" id="pn-refresh" title="Re-read the server status, the history and the student / exam lists"><i class="fa-solid fa-arrow-rotate-right"></i></button>`,
  })}<div class="stack" id="pn-shell"></div>`;
  body = root.querySelector("#pn-shell");
  if (!S.canManage) {
    body.innerHTML = errorState({ title: "No permission", text: "Push Notification needs the Super Admin or Manager role.", retry: false });
    root.querySelector("#pn-refresh").hidden = true;
    return;
  }
  root.querySelector("#pn-refresh").addEventListener("click", (e) => refreshAll(e.currentTarget));
  bootOnce();
  await cssReady();
  buildShell();
  show(S.tab);
  // not awaited: the tabs repaint themselves when these arrive
  M.loadHealth();
  M.loadJobs();
}

export function activate() {
  if (!body || !S.canManage) return;
  M.loadHealth();
  if (S.jobsStatus !== "loading" && Date.now() - S.jobsAt > 120000) M.loadJobs();
  VIEWS[S.tab]?.activate?.();
  armFromJobs();
}

