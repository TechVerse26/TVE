// ==========================================================================
// admin/push/view-setup.js — "Setup & Audit": is everything connected, how scheduled sends work on the free plan,
// the limits that protect the free quotas, and who did what.
//
// Nothing secret is shown or handled here. The environment variables are only NAMED, so an admin knows what to look for in
// Vercel; their values live in Vercel and nowhere else (see server/push/config.js and doc/PUSH-NOTIFICATIONS.md).
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, fmtN, fmtDateTime, chip, createTable, withBusy, skeleton } from "../core/ui.js";
import { actionMeta } from "../core/audit.js";
import { ROLES } from "../core/permissions.js";
import * as A from "../../push/push-admin-core.js";
import { S, on, emit, collect } from "./state.js";
import * as M from "./model.js";

let host = null, table = null, stopBus = () => {};
const audit = { status: "idle", rows: [], next: null, error: null, at: 0 };

const $ = (sel) => host && host.querySelector(sel);
const ICON = { ok: "fa-circle-check", warn: "fa-triangle-exclamation", bad: "fa-circle-xmark", mute: "fa-circle-minus" };
const siteBase = () => String((S.health && S.health.server && S.health.server.siteUrl) || location.origin).replace(/\/+$/, "");
const cronUrl = () => `${siteBase()}/api/push/cron`;
const OPENABLE = /^push\.(send|schedule|test|cancel|complete)$/;

/* ==========================================================================
   Layout
   ========================================================================== */
function layout() {
  return `
  <div class="pn-setup">
    <section class="panel pn-card" aria-labelledby="ps-h-status">
      <div class="panel-head">
        <div><h2 id="ps-h-status"><i class="fa-solid fa-plug-circle-check"></i> Is everything connected?</h2><small>Checked by asking the push server</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="recheck"><i class="fa-solid fa-arrow-rotate-right"></i> Check again</button></div>
      </div>
      <div class="panel-body" id="ps-status" aria-live="polite"></div>
    </section>

    <section class="panel pn-card" aria-labelledby="ps-h-timer">
      <div class="panel-head">
        <div><h2 id="ps-h-timer"><i class="fa-solid fa-clock"></i> Scheduled sends — the free timer</h2><small>No paid scheduler is used</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="tick" title="Ask the server to send everything that is due right now"><i class="fa-solid fa-play"></i> Run scheduler now</button></div>
      </div>
      <div class="panel-body pn-prose" id="ps-timer"></div>
    </section>

    <section class="panel pn-card" aria-labelledby="ps-h-limits">
      <div class="panel-head"><div><h2 id="ps-h-limits"><i class="fa-solid fa-gauge-simple-high"></i> Limits</h2><small>They keep the free quotas safe and stop mistakes</small></div></div>
      <div class="panel-body" id="ps-limits"></div>
    </section>

    <section class="panel pn-card" aria-labelledby="ps-h-free">
      <div class="panel-head"><div><h2 id="ps-h-free"><i class="fa-solid fa-piggy-bank"></i> Free plan — good to know</h2><small>What “no card, no cost” means in practice</small></div></div>
      <div class="panel-body pn-prose">
        <ul class="pn-notes">
          <li><b>No card, no Blaze plan.</b> Firebase stays on the free Spark plan. Sending uses Firebase Cloud Messaging (free) through a small server function on Vercel’s free plan. The Firebase service-account key exists only as a Vercel environment variable — it is never placed in a website file.</li>
          <li><b>“Accepted” is not “delivered”.</b> FCM tells the server that Google’s push service <i>accepted</i> the message for a device. It never reports whether a phone showed it, so this page never claims delivery.</li>
          <li><b>Which devices.</b> Android and computer browsers (Chrome, Edge, Firefox) work once the student allows notifications. On iPhone and iPad the student must first add the site to the Home Screen (iOS 16.4 or newer).</li>
          <li><b>Free daily quotas.</b> Firestore’s free plan allows about 50,000 reads and 20,000 writes a day. A notification reads the matching device records once; the device cap and the per-admin limits above stop a slip from using up the day’s allowance.</li>
          <li><b>Big sends.</b> A free Vercel function must answer within about ten seconds, so a large send is done in steps. This page keeps calling the server until it is finished; if you close it, the free timer finishes the job.</li>
          <li><b>Dead devices clean themselves up.</b> When FCM says a device token is no longer valid (the student cleared the browser data, say), that device is switched off automatically.</li>
        </ul>
      </div>
    </section>

    <section class="panel pn-card" aria-labelledby="ps-h-audit">
      <div class="panel-head">
        <div><h2 id="ps-h-audit"><i class="fa-solid fa-clipboard-list"></i> Audit log</h2><small>Who sent, scheduled, tested or cancelled — also visible in Activity Logs</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="audit-reload"><i class="fa-solid fa-arrow-rotate-right"></i> Reload</button></div>
      </div>
      <div class="panel-body flush"><div id="ps-audit"></div></div>
      <div class="pn-more" id="ps-audit-more" hidden><small></small><button type="button" class="btn btn-outline btn-sm" data-act="audit-more">Load older entries</button></div>
    </section>
  </div>`;
}

/* ==========================================================================
   1 · Checklist
   ========================================================================== */
function paintStatus() {
  const el = $("#ps-status");
  if (!el) return;
  if (!S.setup) { el.innerHTML = skeleton(4); return; }
  const h = S.health;
  const items = S.setup.items.map((i) => `
    <li class="${esc(i.tone)}"><i class="fa-solid ${ICON[i.tone] || ICON.mute}" aria-hidden="true"></i>
      <div><b>${esc(i.title)}</b><span>${esc(i.text)}</span></div></li>`).join("");
  const role = h && h.actor && h.actor.role;
  const meta = h ? `
    <dl class="pn-kv pn-kv-inline">
      <div><dt>Firebase project</dt><dd><code>${esc((h.server && h.server.projectId) || "—")}</code></dd></div>
      <div><dt>Website address</dt><dd><code>${esc(siteBase())}</code></dd></div>
      <div><dt>You are signed in as</dt><dd>${esc((ROLES[role] && ROLES[role].label) || role || "—")} <small class="muted">(checked by the server)</small></dd></div>
    </dl>` : "";
  const help = !S.setup.canSend ? `
    <div class="note warn"><i class="fa-solid fa-book-open"></i> The push server is not ready yet. Follow the setup guide <code>doc/PUSH-NOTIFICATIONS.md</code> (Vercel environment variables → service account → redeploy), then press <b>Check again</b>.</div>` : "";
  el.innerHTML = `<ul class="pn-checklist">${items}</ul>${meta}${help}`;
}

/* ==========================================================================
   2 · The free timer
   ========================================================================== */
function timerState() {
  const it = S.setup && S.setup.items.find((i) => i.id === "scheduler");
  if (!it) return `<div class="note"><i class="fa-solid fa-circle-minus"></i> The timer status appears once the push server answers (see the checklist above).</div>`;
  const cls = it.tone === "ok" ? "ok" : it.tone === "bad" ? "bad" : "warn";
  return `<div class="note ${cls}"><i class="fa-solid ${ICON[it.tone] || ICON.mute}"></i> <b>${esc(it.title)}:</b> ${esc(it.text)}</div>`;
}

const copyBtn = (value, label) => `<button type="button" class="btn btn-outline btn-sm" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}"><i class="fa-solid fa-copy"></i> Copy</button>`;

function paintTimer() {
  const el = $("#ps-timer");
  if (!el) return;
  const url = cronUrl();
  el.innerHTML = `
    <p>Firebase’s free plan has no scheduler, and Vercel’s free plan can run a timer only once a day. So a <b>free outside timer</b> wakes the push server every few minutes, and the server sends whatever is due. Without any timer, scheduled notifications go out only while an admin has this page open at (or after) the scheduled time — and the admin panel signs out after a period of inactivity, so do not rely on that.</p>
    ${timerState()}
    <h3 class="pn-h3">Option A — cron-job.org <small class="muted">(recommended · every minute)</small></h3>
    <ol class="pn-steps">
      <li>Make a free account at <b>cron-job.org</b> and press <b>Create cronjob</b>.</li>
      <li>URL: <span class="pn-copyline"><code>${esc(url)}</code>${copyBtn(url, "the timer address")}</span></li>
      <li>Schedule: every <b>1 minute</b> (every 5 minutes also works). Method: <b>GET</b>.</li>
      <li>Under <b>Advanced → Headers</b> add a header named <span class="pn-copyline"><code>Authorization</code>${copyBtn("Authorization", "the header name")}</span> with the value <code>Bearer </code> followed by your <code>CRON_SECRET</code> — the same secret text you saved in Vercel. (It is never shown here.)</li>
      <li>Save. The status above turns green after the first call.</li>
    </ol>
    <h3 class="pn-h3">Option B — GitHub Actions <small class="muted">(about every 5 minutes)</small></h3>
    <p>The project already contains <code>.github/workflows/push-scheduler.yml</code>. In your GitHub repository open <b>Settings → Secrets and variables → Actions</b> and add two secrets: <code>PUSH_CRON_URL</code> (the address above) and <code>PUSH_CRON_SECRET</code> (your <code>CRON_SECRET</code>). GitHub may delay runs by a few minutes and pauses them after 60 days without activity in the repository.</p>
    <p class="form-hint">Not sure it works? Press <b>Run scheduler now</b>: it makes the same call the timer makes and tells you how many notifications it handled.</p>`;
}

async function runTick(btn) {
  try {
    const r = await withBusy(btn, () => M.tick());
    const n = (r.jobs || []).length, w = r.waiting || 0;
    toast(n || w ? `Checked — ${n} notification${n === 1 ? "" : "s"} handled${w ? `, ${w} waiting for their time` : ""}.` : "Checked — nothing is due right now.", "success");
  } catch (err) { toast(A.adminErrorText(err), "error"); }
}

/* ==========================================================================
   3 · Limits
   ========================================================================== */
function paintLimits() {
  const el = $("#ps-limits");
  if (!el) return;
  const L = { ...S.limits, ...((S.health && S.health.limits) || {}) };
  const rows = [
    ["Title", `${fmtN(L.titleMax)} characters`, ""],
    ["Message", `${fmtN(L.bodyMax)} characters`, ""],
    ["Devices per notification", `up to ${fmtN(L.maxRecipients)}`, "A bigger audience is refused so a slip cannot use up the free quotas. The limit can be raised in Vercel (PUSH_MAX_RECIPIENTS)."],
    ["Sending limit per admin", L.adminPerHour && L.adminPerDay ? `${fmtN(L.adminPerHour)} per hour · ${fmtN(L.adminPerDay)} per day` : "—", "Also protects against a stuck button or a script. Test sends have their own, smaller limit."],
    ["Schedule ahead", `up to ${fmtN(L.maxScheduleDays)} days`, ""],
    ["Saved pictures", `${fmtN(L.maxImages)} pictures, each up to ${A.fmtKB(L.imageMaxBytes)}`, "Pictures are resized in the browser before upload."],
    ["Same text twice", "blocked for a short time", "An identical notification sent again within minutes is refused, so a double click never reaches students twice."],
  ];
  el.innerHTML = `<dl class="pn-limits">${rows.map(([k, v, h]) => `<div><dt>${esc(k)}</dt><dd><b>${esc(v)}</b>${h ? `<small>${esc(h)}</small>` : ""}</dd></div>`).join("")}</dl>`;
}

/* ==========================================================================
   5 · Audit log
   ========================================================================== */
const whoCell = (r) => `<div class="cell-main"><div class="t">${esc(r.name || r.email || "—")}</div><div class="s">${esc((ROLES[r.role] && ROLES[r.role].label) || r.role || "")}${r.name && r.email ? ` · ${esc(r.email)}` : ""}</div></div>`;
const actionCell = (r) => { const [label, icon, tone] = actionMeta(r.action); return chip(label, tone, icon); };
const whatCell = (r) => (r.jobId && OPENABLE.test(r.action || "")
  ? `<button type="button" class="link-btn pn-cname" data-open="${esc(r.jobId)}" title="Open in History"><b>${esc(r.label || r.jobId)}</b></button>`
  : esc(r.label || "—"));

const auditError = (err) => `<div class="state err"><div class="state-ico"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>The audit log could not be loaded</h3>
  <p>${esc(A.adminErrorText(err))}</p>
  <div class="pn-state-actions"><button type="button" class="btn btn-outline btn-sm" data-act="audit-reload"><i class="fa-solid fa-arrow-rotate-right"></i> Try again</button></div></div>`;

function paintAudit() {
  if (!host || !table) return;
  const more = $("#ps-audit-more");
  if (audit.status === "error" && !audit.rows.length) { table.setState(auditError(audit.error)); more.hidden = true; return; }
  if ((audit.status === "loading" || audit.status === "idle") && !audit.rows.length) { table.setState(skeleton(5)); more.hidden = true; return; }
  table.setRows(audit.rows, { keepPage: true });
  more.hidden = !audit.next;
  more.querySelector("button").disabled = audit.status === "loading";
  more.querySelector("small").textContent = `${fmtN(audit.rows.length)} loaded`;
}

let auditRun = null;
function loadAuditPage({ more = false } = {}) {
  if (auditRun) return auditRun;
  if (more && !audit.next) return Promise.resolve();
  audit.status = "loading";
  if (!more) audit.error = null;
  paintAudit();
  auditRun = (async () => {
    try {
      const r = await M.loadAudit({ before: more ? audit.next : null });
      if (more) {
        const seen = new Set(audit.rows.map((x) => x.id));
        audit.rows = [...audit.rows, ...r.items.filter((x) => !seen.has(x.id))];
      } else audit.rows = r.items;
      audit.next = r.next;
      audit.status = "ready";
      audit.at = Date.now();
    } catch (err) {
      audit.error = err;
      audit.status = "error";
    }
    paintAudit();
  })().finally(() => { auditRun = null; });
  return auditRun;
}

/* ==========================================================================
   Copy
   ========================================================================== */
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied", "success"); return; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  toast(ok ? "Copied" : "Could not copy — select the text and copy it yourself", ok ? "success" : "error");
}

/* ==========================================================================
   Lifecycle
   ========================================================================== */
function paintAll() { paintStatus(); paintTimer(); paintLimits(); paintAudit(); }

export function mount(root) {
  host = root;
  host.innerHTML = layout();
  table = createTable({
    mount: host.querySelector("#ps-audit"), pageSize: 10, defaultSort: { key: "at", dir: "desc" },
    empty: { icon: "fa-clipboard-list", title: "Nothing recorded yet", text: "Every send, schedule, test, cancellation and picture upload is recorded here with the admin’s name." },
    columns: [
      { key: "at", label: "When", sortable: true, sortValue: (r) => r.at || 0, render: (r) => esc(fmtDateTime(r.at)) },
      { key: "who", label: "Admin", render: whoCell },
      { key: "action", label: "Action", render: actionCell },
      { key: "what", label: "Notification", render: whatCell },
      { key: "detail", label: "Details", render: (r) => `<span class="muted pn-wrap">${esc(r.detail || "")}</span>` },
    ],
  });
  host.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) { copy(c.dataset.copy); return; }
    const o = e.target.closest("[data-open]");
    if (o) { emit("goto", { tab: "history", job: o.dataset.open }); return; }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    switch (a.dataset.act) {
      case "recheck": await withBusy(a, () => M.loadHealth({ force: true })); break;
      case "tick": await runTick(a); break;
      case "audit-reload": await withBusy(a, () => loadAuditPage()); break;
      case "audit-more": await withBusy(a, () => loadAuditPage({ more: true })); break;
      default: break;
    }
  });
  stopBus = collect(() => {
    on("health", () => { paintStatus(); paintTimer(); paintLimits(); });
  });
  paintAll();
}

/** Called every time the tab is shown. The server check is cached for a minute; the audit log is re-read when it is older than two. */
export async function activate() {
  if (!host) return;
  M.loadHealth();
  if (audit.status === "idle" || audit.status === "error" || Date.now() - audit.at > 120000) await loadAuditPage();
}

export function unmount() {
  stopBus();
  if (host) host.innerHTML = "";
  host = null; table = null;
}
