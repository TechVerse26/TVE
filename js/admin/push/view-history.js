// ==========================================================================
// admin/push/view-history.js — "History": every notification (scheduled, sending, finished, cancelled) with honest numbers.
//
//   accepted = Google's push service took the message for that device. It is NOT proof a phone showed it — FCM does not report that.
//   The list is read from the push server (newest first, 30 at a time + "Load older"); filtering, search and paging happen here.
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, fmtN, fmtDateTime, chip, createTable, segmented, bindSegmented, debounce, confirmDanger, openDrawer, closeDrawer, withBusy, skeleton } from "../core/ui.js";
import * as A from "../../push/push-admin-core.js";
import { S, on, emit, collect } from "./state.js";
import * as M from "./model.js";
import { previewHtml } from "./preview.js";

let host = null, table = null, stopBus = () => {};
const f = { group: "all", q: "", tests: false };

/* ==========================================================================
   The list
   ========================================================================== */
const rows = () => A.filterJobs(S.jobs, { group: f.group, q: f.q, showTests: f.tests });

function resultCell(j) {
  if (j.status === "scheduled") return `<span class="muted">Not sent yet</span>`;
  if (j.status === "cancelled") return `<span class="muted">—</span>`;
  const c = j.counts || {};
  if (j.noRecipients) return `<span class="muted">No devices matched</span>`;
  const bad = c.failed || c.invalid;
  return `<div class="cell-main"><div class="t">${fmtN(c.accepted)} of ${fmtN(c.targeted)} accepted</div>${bad ? `<div class="s pn-bad">${fmtN(c.failed)} failed${c.invalid ? ` · ${fmtN(c.invalid)} removed` : ""}</div>` : ""}</div>`;
}

function whenCell(j) {
  const w = A.jobWhen(j);
  return `<div class="cell-main"><div class="t">${fmtDateTime(w.at)}</div><div class="s">${esc(w.label)}</div></div>`;
}

function actionCell(j) {
  const quick = j.status === "scheduled"
    ? `<button type="button" class="btn btn-outline btn-sm danger" data-cancel="${esc(j.id)}">Cancel</button>`
    : j.status === "sending" && !M.isDriving(j.id)
      ? `<button type="button" class="btn btn-outline btn-sm" data-continue="${esc(j.id)}">Continue</button>` : "";
  return `<div class="row-actions">${quick}<button type="button" class="btn btn-outline btn-sm" data-view="${esc(j.id)}">Details</button></div>`;
}

const histError = (err) => `<div class="state err"><div class="state-ico"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>History could not be loaded</h3>
  <p>${esc(A.adminErrorText(err))}</p>
  <div class="pn-state-actions"><button type="button" class="btn btn-outline btn-sm" data-retry><i class="fa-solid fa-arrow-rotate-right"></i> Try again</button>
  <button type="button" class="btn btn-outline btn-sm" data-act="goto-setup"><i class="fa-solid fa-screwdriver-wrench"></i> Open Setup</button></div></div>`;

function paintSeg() {
  const counts = A.groupCounts(S.jobs, f.tests);
  host.querySelector("#ph-seg").innerHTML = segmented(A.GROUPS.map(([id, label]) => ({ id, label, count: counts[id] })), f.group);
}

function paintBanner() {
  const el = host.querySelector("#ph-banner");
  const waiting = S.jobs.some((j) => j.status === "scheduled");
  const noTimer = S.setup && S.setup.cronConfigured === false;
  el.innerHTML = waiting && noTimer
    ? `<div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> Some notifications are scheduled, but the free timer is not set up. They are sent only while an admin has the Push Notification page open (and is still signed in) at the scheduled time. See the <button type="button" class="link-btn" data-act="goto-setup">Setup tab</button>.</div>`
    : "";
}

function paint() {
  if (!host || !table) return;
  paintSeg();
  paintBanner();
  const more = host.querySelector("#ph-more");
  if (S.jobsStatus === "error" && !S.jobs.length) { table.setState(histError(S.jobsError)); more.hidden = true; return; }
  if ((S.jobsStatus === "loading" || S.jobsStatus === "idle") && !S.jobs.length) { table.setState(skeleton(6)); more.hidden = true; return; }
  table.setRows(rows(), { keepPage: true });
  more.hidden = !S.next;
  const btn = more.querySelector("button");
  btn.disabled = S.jobsStatus === "loading";
  more.querySelector("small").textContent = `${fmtN(S.jobs.length)} loaded`;
}

/* ==========================================================================
   Details drawer
   ========================================================================== */
const kv = (k, v) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
const when = (ms) => (ms ? fmtDateTime(ms) : "—");

function detailsHtml(j) {
  const meta = A.statusMeta(j.status), pct = A.progressPct(j), kind = A.TYPES.find((t) => t.id === j.category);
  const counts = j.status === "scheduled" ? "" : `<dl class="pn-counts big">${A.countRows(j.counts).filter((x) => x.key !== "skipped" || x.value).map((x) => `<div class="${x.tone}"><dt>${esc(x.label)}</dt><dd>${fmtN(x.value)}</dd><small>${esc(x.help)}</small></div>`).join("")}</dl>`;
  const errs = A.errorRows(j.errors);
  const by = j.createdBy || {};
  const actions = [
    j.status === "scheduled" ? `<button type="button" class="btn btn-outline danger" data-d="cancel"><i class="fa-solid fa-ban"></i> Cancel this notification</button>` : "",
    j.status === "sending" && !M.isDriving(j.id) ? `<button type="button" class="btn btn-primary" data-d="continue"><i class="fa-solid fa-play"></i> Continue sending</button>` : "",
    `<button type="button" class="btn btn-outline" data-d="reuse"><i class="fa-solid fa-copy"></i> Reuse the text</button>`,
  ].filter(Boolean).join("");
  return `
    <div class="pn-dh">${chip(meta.label, meta.tone, meta.icon)}${j.test ? chip("Test", "") : ""}</div>
    ${j.status === "sending" ? `<div class="pn-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct === null ? 0 : pct}"><i style="width:${pct === null ? 8 : pct}%"></i></div>
      <p class="pn-note">${j.progress ? `${fmtN(j.progress.done)} of ${fmtN(j.progress.total)} devices handled so far.` : "Starting…"}${M.isDriving(j.id) ? "" : " Nothing is working on it right now — press Continue (or let the free timer pick it up)."}</p>` : ""}
    <p class="pn-note-lg">${esc(A.deliveryNote(j))}</p>
    ${counts}
    ${errs.length ? `<div><h3 class="pn-h3">Why some were not accepted</h3><ul class="pn-errlist">${errs.map((e) => `<li>${esc(e.label)} <b>${fmtN(e.n)}</b></li>`).join("")}</ul></div>` : ""}
    ${j.lastError && (j.status === "failed" || j.status === "completed_with_errors") ? `<div class="note bad"><i class="fa-solid fa-triangle-exclamation"></i> Last error from FCM: <code>${esc(String(j.lastError).slice(0, 300))}</code></div>` : ""}
    <dl class="pn-kv">
      ${kv("Audience", esc(j.audienceLabel || "—"))}
      ${kv("Kind", kind ? `${esc(kind.label)} <small class="muted">${esc(kind.bn)}</small>` : esc(j.category || "—"))}
      ${kv("Opens", j.url ? `<code>${esc(j.url)}</code>` : "—")}
      ${kv("Created", `${when(j.createdAt)} · ${esc(by.name || by.email || "—")}`)}
      ${j.scheduledAt ? kv("Scheduled for", when(j.scheduledAt)) : ""}
      ${j.startedAt ? kv("Started", when(j.startedAt)) : ""}
      ${j.finishedAt ? kv("Finished", when(j.finishedAt)) : ""}
      ${j.status === "cancelled" ? kv("Cancelled", `${when(j.cancelledAt)}${j.cancelledBy && (j.cancelledBy.name || j.cancelledBy.email) ? ` · ${esc(j.cancelledBy.name || j.cancelledBy.email)}` : ""}`) : ""}
      ${kv("Notification ID", `<code>${esc(j.id)}</code>`)}
    </dl>
    <div class="pn-dh-actions">${actions}</div>
    <div><h3 class="pn-h3">What students see</h3>${previewHtml({ title: j.title, body: j.body, icon: j.icon, image: j.image, category: j.category }, "phone")}</div>`;
}

async function openDetails(id) {
  let off = () => {};
  const d = openDrawer({ title: "Notification", subtitle: "", html: `<div class="state"><span class="spinner"></span></div>`, width: 640, onClose: () => off() });
  let job = S.jobs.find((j) => j.id === id);
  if (!job) { await M.loadJobs(); job = S.jobs.find((j) => j.id === id); }
  if (!job) {
    d.body.innerHTML = `<div class="state err"><div class="state-ico"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>Not found</h3><p>That notification is not in the loaded list. Use “Load older” in the History tab, or reload.</p></div>`;
    return;
  }
  const head = d.el.querySelector(".drawer-head");
  const draw = () => {
    job = S.jobs.find((j) => j.id === id) || job;
    head.querySelector("h2").textContent = job.title;
    const sub = head.querySelector("p") || head.querySelector("div").appendChild(document.createElement("p"));
    sub.textContent = `${A.statusMeta(job.status).label} · ${fmtDateTime(job.createdAt)}`;
    d.body.innerHTML = detailsHtml(job);
  };
  off = on("jobs", () => { if (document.getElementById("adm-drawer") === d.el) draw(); });
  draw();

  d.body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    const act = b.dataset.d;
    if (act === "reuse") { closeDrawer(); emit("reuse", job); return; }
    if (act === "cancel") {
      const ok = await confirmDanger({ title: "Cancel this notification?", message: `“${job.title}” will not be sent and nobody will receive it.`, confirmLabel: "Cancel notification" });
      if (!ok) return;
      try { await withBusy(b, () => M.cancelJob(id)); toast("Notification cancelled", "success"); } catch (err) { toast(A.adminErrorText(err), "error"); M.loadJobs(); }
      return;
    }
    if (act === "continue") {
      try { await withBusy(b, () => M.driveJob(id)); toast("Sending finished", "success"); } catch (err) { toast(A.adminErrorText(err), "error"); }
    }
  });
}

/* ==========================================================================
   Quick actions from the table
   ========================================================================== */
async function quickCancel(id, btn) {
  const j = S.jobs.find((x) => x.id === id);
  if (!j) return;
  const ok = await confirmDanger({ title: "Cancel this notification?", message: `“${j.title}” will not be sent and nobody will receive it.`, confirmLabel: "Cancel notification" });
  if (!ok) return;
  try { await withBusy(btn, () => M.cancelJob(id)); toast("Notification cancelled", "success"); } catch (err) { toast(A.adminErrorText(err), "error"); M.loadJobs(); }
}
async function quickContinue(id, btn) {
  try { await withBusy(btn, () => M.driveJob(id, { onUpdate: () => paint() })); toast("Sending finished", "success"); } catch (err) { toast(A.adminErrorText(err), "error"); }
  paint();
}

/* ==========================================================================
   Lifecycle
   ========================================================================== */
function openRequested() {
  if (!S.openJob) return;
  const id = S.openJob;
  S.openJob = "";
  openDetails(id);
}

export function mount(root) {
  host = root;
  host.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div><h2>Notifications</h2><small>Newest first. “Accepted” = Google’s push service took the message — not a confirmation that a phone showed it.</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="reload"><i class="fa-solid fa-arrow-rotate-right"></i> Reload</button></div>
      </div>
      <div id="ph-banner"></div>
      <div class="toolbar pn-toolbar">
        <div id="ph-seg"></div>
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="ph-q" placeholder="Search title, message, audience, admin…" aria-label="Search notifications" autocomplete="off"></div>
        <label class="pn-check"><input type="checkbox" id="ph-tests"> Show test sends</label>
      </div>
      <div class="panel-body flush"><div id="ph-table"></div></div>
      <div class="pn-more" id="ph-more" hidden><small></small><button type="button" class="btn btn-outline btn-sm" data-act="more">Load older notifications</button></div>
    </div>`;
  table = createTable({
    mount: host.querySelector("#ph-table"), pageSize: 10, defaultSort: { key: "created", dir: "desc" },
    empty: { icon: "fa-bell-slash", title: "No notifications here", text: "Notifications you send or schedule appear here. If a filter or a search is on, change it to see more." },
    columns: [
      { key: "title", label: "Notification", sortable: true, sortValue: (j) => (j.title || "").toLowerCase(),
        render: (j) => `<button type="button" class="link-btn pn-cname" data-view="${esc(j.id)}"><b>${esc(j.title)}</b></button>${j.test ? ` <span class="chip">Test</span>` : ""}<div class="s pn-excerpt">${esc(String(j.body || "").replace(/\s+/g, " ").slice(0, 80))}</div>` },
      { key: "aud", label: "Audience", render: (j) => esc(j.audienceLabel || "—") },
      { key: "status", label: "Status", sortable: true, sortValue: (j) => j.status, render: (j) => { const m = A.statusMeta(j.status); return chip(m.label, m.tone, m.icon); } },
      { key: "when", label: "Time", sortable: true, sortValue: (j) => A.jobWhen(j).at, render: whenCell },
      { key: "result", label: "Result", sortable: true, sortValue: (j) => (j.counts && j.counts.accepted) || 0, render: resultCell },
      { key: "created", label: "Created", sortable: true, sortValue: (j) => j.createdAt || 0, render: (j) => `<div class="cell-main"><div class="t">${fmtDateTime(j.createdAt)}</div><div class="s">${esc((j.createdBy && (j.createdBy.name || j.createdBy.email)) || "—")}</div></div>` },
      { key: "act", label: "", cls: "c-act", render: actionCell },
    ],
  });
  bindSegmented(host.querySelector("#ph-seg"), (id) => { f.group = id; paint(); });
  host.addEventListener("input", debounce((e) => { if (e.target.id === "ph-q") { f.q = e.target.value; paint(); } }, 200));
  host.addEventListener("change", (e) => { if (e.target.id === "ph-tests") { f.tests = e.target.checked; paint(); } });
  host.addEventListener("click", async (e) => {
    const v = e.target.closest("[data-view]");
    if (v) { openDetails(v.dataset.view); return; }
    const c = e.target.closest("[data-cancel]");
    if (c) { quickCancel(c.dataset.cancel, c); return; }
    const k = e.target.closest("[data-continue]");
    if (k) { quickContinue(k.dataset.continue, k); return; }
    if (e.target.closest("[data-retry]")) { M.loadJobs(); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.dataset.act === "reload") { await withBusy(a, () => M.loadJobs()); }
    else if (a.dataset.act === "more") { await withBusy(a, () => M.loadJobs({ more: true })); }
    else if (a.dataset.act === "goto-setup") emit("goto", { tab: "setup" });
  });
  stopBus = collect(() => {
    on("jobs", paint);
    on("health", paintBanner);
  });
  paint();
}

/** Called every time the tab is shown: refresh when the list is old, and open a notification someone asked for. */
export async function activate() {
  if (!host) return;
  if (S.jobsStatus === "idle" || Date.now() - S.jobsAt > 30000) await M.loadJobs();
  paint();
  openRequested();
}

export function unmount() {
  stopBus();
  if (host) host.innerHTML = "";
  host = null; table = null;
}
