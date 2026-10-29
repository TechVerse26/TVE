// ==========================================================================
// admin/email/view-history.js — "Campaign History": every campaign (and draft), with recipient-level results.
//
// What the numbers mean (shown to the admin too):
//   Request accepted  EmailJS answered 200 — NOT a guarantee of inbox delivery.      Failed     EmailJS answered with an error.
//   Uncertain         no answer at all — it may or may not have been sent (never re-sent unless the admin insists).
//   Interrupted       the tab closed / network died mid-run; what was in flight became "uncertain".
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, fmtN, createTable, fmtDateTime, errorState, rulesHint, isDenied, openDrawer, closeDrawer, debounce, confirmDanger, withBusy } from "../core/ui.js";
import { logAction } from "../core/audit.js";
import { downloadCsv } from "../../utils.js";
import { CAMPAIGN_TYPES, CAMPAIGN_STATUS, ROW_STATUS, totalsOf, recoverRows, isStale, csvSafe } from "../../email-core.js";
import { serverNow } from "../../server-time.js";
import { S, on } from "./state.js";
import * as store from "./store.js";
import { refreshCampaigns, openDraft, duplicateCampaign } from "./model.js";
import { rowChip, campaignChip, goTab } from "./bits.js";
import { retryFlow, exportCampaign, repairStale } from "./send.js";

let host = null, table = null;
const f = { q: "", status: "", type: "" };
const repaired = new Set();

const effective = (c) => (isStale(c, serverNow()) ? { ...c, status: "interrupted", derived: true } : c);

function rows() {
  const q = f.q.trim().toLowerCase();
  return S.campaigns.map(effective).filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (f.type && c.type !== f.type) return false;
    return !q || `${c.name} ${c.subject} ${c.examTitle} ${c.createdBy?.name} ${CAMPAIGN_TYPES[c.type]?.label}`.toLowerCase().includes(q);
  });
}
function paint() {
  if (!table) return;
  if (S.campaignsError) { table.setState(isDenied(S.campaignsError) ? rulesHint("Email campaigns") : errorState({ title: "হিস্ট্রি লোড হয়নি", text: String(S.campaignsError?.message || S.campaignsError) })); return; }
  table.setRows(rows(), { keepPage: true });
  // campaigns whose heartbeat died are repaired once (rows "sending" → "uncertain"), so their numbers become true
  for (const c of S.campaigns) {
    if (isStale(c, serverNow()) && !repaired.has(c.id) && S.canManage) {
      repaired.add(c.id);
      repairStale(c).then((fixed) => { if (fixed !== c) refreshCampaigns({ force: true }); });
    }
  }
}

/* ---------- details drawer ---------- */
const kvRow = (k, v) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

async function openDetails(id) {
  let c = S.campaigns.find((x) => x.id === id);
  const d = openDrawer({ title: c?.name || "Campaign", subtitle: "Loading…", html: `<div class="state"><span class="spinner"></span></div>`, width: 760 });
  try {
    if (!c) c = await store.loadCampaign(id);
    if (!c) { d.body.innerHTML = errorState({ title: "ক্যাম্পেইনটি পাওয়া যায়নি", text: "মোছা হয়ে থাকতে পারে।" }); return; }
    c = effective(c);
    const isDraft = c.status === "draft";
    const loaded = isDraft ? [] : await store.loadCampaignRows(id);
    const recs = isDraft ? [] : (c.derived ? recoverRows(loaded) : loaded);
    const t = isDraft ? { total: (c.selectedUids || []).length } : totalsOf(recs);
    const exam = c.examId ? S.examsById.get(c.examId) : null;
    const canRetry = !isDraft && S.canManage && (t.pending || t.failed || t.uncertain);
    d.body.closest(".drawer").querySelector(".drawer-head h2").textContent = c.name || "Campaign";
    const sub = d.body.closest(".drawer").querySelector(".drawer-head p"); if (sub) sub.textContent = `${CAMPAIGN_TYPES[c.type]?.label || c.type} · ${fmtDateTime(c.createdAt)}`;
    d.body.innerHTML = `
      <div class="em-dh">${campaignChip(c.status)} ${c.derived ? `<small>(heartbeat বন্ধ — ট্যাব বন্ধ বা নেটওয়ার্ক সমস্যা হয়েছিল)</small>` : ""}</div>
      ${isDraft ? "" : `<div class="em-mini">
        <div class="ok"><b>${fmtN(t.accepted)}</b><span>Request accepted</span></div><div class="bad"><b>${fmtN(t.failed)}</b><span>Failed</span></div>
        <div class="warn"><b>${fmtN(t.uncertain)}</b><span>Uncertain</span></div><div><b>${fmtN(t.pending + t.sending)}</b><span>Pending</span></div><div><b>${fmtN(t.skipped)}</b><span>Skipped</span></div></div>
        <div class="note"><i class="fa-solid fa-circle-info"></i> “Request accepted” = EmailJS অনুরোধ নিয়েছে; ইনবক্সে পৌঁছানোর নিশ্চয়তা নয়। পাঠানো ইমেইল ফেরত আনা যায় না।</div>`}
      <dl class="em-kv">
        ${kvRow("Type", esc(CAMPAIGN_TYPES[c.type]?.label || c.type))}
        ${c.examId ? kvRow("Exam", esc(c.examTitle || exam?.title || c.examId)) : ""}
        ${kvRow("Subject", `<b>${esc(c.subject || "—")}</b>`)}
        ${kvRow("Audience", esc(c.audience?.summary || "—"))}
        ${kvRow("Created", `${fmtDateTime(c.createdAt)} · ${esc(c.createdBy?.name || "—")}`)}
        ${c.startedAt ? kvRow("Started", fmtDateTime(c.startedAt)) : ""}${c.finishedAt ? kvRow("Finished", fmtDateTime(c.finishedAt)) : ""}
        ${c.runs > 1 ? kvRow("Runs", `${fmtN(c.runs)} (retries included)`) : ""}
        ${c.source?.type === "notice" ? kvRow("From notice", esc(c.source.title)) : ""}
        ${c.lastRun?.trip ? kvRow("Stopped because", esc(`${c.lastRun.trip.reason || ""} ${c.lastRun.trip.status || ""} ${c.lastRun.trip.text || ""}`)) : ""}
        ${isDraft ? kvRow("Selected students", fmtN((c.selectedUids || []).length)) : ""}
      </dl>
      <div class="em-dh-actions">
        ${isDraft ? `<button type="button" class="btn btn-primary" data-d="edit"><i class="fa-solid fa-pen-to-square"></i> Continue editing</button>` : ""}
        ${canRetry ? `<button type="button" class="btn btn-primary" data-d="retry"><i class="fa-solid fa-rotate"></i> Resume / retry…</button>` : ""}
        ${!isDraft ? `<button type="button" class="btn btn-outline" data-d="csv"><i class="fa-solid fa-download"></i> Export CSV</button>` : ""}
        <button type="button" class="btn btn-outline" data-d="dup" title="লেখা ও সেটিংস কপি হবে; পুরোনো প্রাপক/পাঠানো আবার হবে না"><i class="fa-solid fa-clone"></i> Duplicate as new draft</button>
        ${isDraft || S.canSettings ? `<button type="button" class="btn btn-outline danger" data-d="del"><i class="fa-solid fa-trash"></i> Delete</button>` : ""}
      </div>
      ${isDraft ? "" : `<h3 class="em-h3">Recipients</h3>
        <div class="toolbar"><div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="dh-q" placeholder="Name or email…" aria-label="Search recipients" autocomplete="off"></div>
          <select id="dh-status" aria-label="Filter by status"><option value="">All statuses</option>${Object.entries(ROW_STATUS).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join("")}</select></div>
        <div id="dh-table"></div>`}
      <h3 class="em-h3">Message (placeholders, no personal data)</h3>
      <pre class="em-pre">${esc(String(c.content?.message || "").slice(0, 1500))}</pre>`;

    if (!isDraft) {
      const dt = createTable({
        mount: d.body.querySelector("#dh-table"), pageSize: 10, defaultSort: { key: "status", dir: "asc" },
        rowId: (r) => r.uid, empty: { icon: "fa-users", title: "কোনো প্রাপক নেই", text: "ফিল্টার বদলে দেখুন।" },
        columns: [
          { key: "name", label: "Student", sortable: true, sortValue: (r) => (r.name || r.email).toLowerCase(), render: (r) => `<div class="cell-main"><div class="t">${esc(r.name || "—")}</div><div class="s">${esc(r.email)}</div></div>` },
          { key: "roll", label: "Roll", render: (r) => esc(r.roll || "—") },
          { key: "status", label: "Status", sortable: true, sortValue: (r) => ["failed", "uncertain", "pending", "sending", "skipped", "accepted"].indexOf(r.status), render: (r) => rowChip(r.status) },
          { key: "tries", label: "Tries", render: (r) => fmtN(r.tries || 0) },
          { key: "note", label: "Detail", render: (r) => `<span class="em-note">${esc(r.note || "")}</span>` },
          { key: "at", label: "When", sortable: true, sortValue: (r) => r.at || 0, render: (r) => (r.at ? fmtDateTime(r.at) : "—") },
        ],
      });
      const drawRows = () => {
        const q = d.body.querySelector("#dh-q").value.trim().toLowerCase();
        const st = d.body.querySelector("#dh-status").value;
        dt.setRows(recs.filter((r) => (!st || r.status === st) && (!q || `${r.name} ${r.email} ${r.roll}`.toLowerCase().includes(q))).map((r) => ({ ...r, id: r.uid })));
      };
      d.body.querySelector("#dh-q").addEventListener("input", debounce(drawRows, 200));
      d.body.querySelector("#dh-status").addEventListener("change", drawRows);
      drawRows();
    }

    d.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-d]");
      if (!b) return;
      const act = b.dataset.d;
      if (act === "edit") { closeDrawer(); await openDraft(c); goTab("compose"); }
      else if (act === "dup") { closeDrawer(); await duplicateCampaign(c); goTab("compose"); toast("লেখা কপি হয়েছে — প্রাপক আজকের ডেটা থেকে আবার বানানো হয়েছে; কিছু পাঠানো হয়নি", "success"); }
      else if (act === "csv") exportCampaign(c, recs);
      else if (act === "retry") { closeDrawer(); await retryFlow(c, recs); }
      else if (act === "del") {
        if (!(await confirmDanger({ title: isDraft ? "ড্রাফট মুছবেন?" : "ক্যাম্পেইন রেকর্ড মুছবেন?", message: isDraft ? "ড্রাফটটি মুছে যাবে।" : `“${c.name}”-এর হিস্ট্রি ও প্রাপক-ফলাফল মুছে যাবে। এতে আগে পাঠানো ইমেইল ফেরত আসে না।`, confirmLabel: "Delete" }))) return;
        try { await store.deleteCampaign(c.id); logAction("email.campaign.delete", { type: "email-campaign", id: c.id, label: c.name || "", detail: isDraft ? "draft" : `${c.status}` }); closeDrawer(); toast("মোছা হয়েছে", "success"); await refreshCampaigns(); }
        catch (err) { toast(isDenied(err) ? "মোছার অনুমতি নেই" : `মোছা যায়নি: ${err?.message || err}`, "error"); }
      }
    });
  } catch (err) {
    d.body.innerHTML = isDenied(err) ? rulesHint("Email campaigns") : errorState({ title: "লোড হয়নি", text: String(err?.message || err) });
  }
}

function exportList() {
  const head = ["Campaign", "Type", "Exam", "Subject", "Created", "By", "Status", "Total", "Accepted", "Failed", "Uncertain", "Pending", "Skipped"];
  const body = rows().map((c) => { const t = c.totals || {}; return [c.name, CAMPAIGN_TYPES[c.type]?.label || c.type, c.examTitle, c.subject, c.createdAt?.toMillis ? new Date(c.createdAt.toMillis()).toISOString() : "", c.createdBy?.name, CAMPAIGN_STATUS[c.status]?.label || c.status, t.total || 0, t.accepted || 0, t.failed || 0, t.uncertain || 0, (t.pending || 0) + (t.sending || 0), t.skipped || 0].map(csvSafe); });
  downloadCsv(`email-campaigns-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...body]);
  logAction("email.campaign.export", { label: "Campaign list", detail: `${body.length} campaigns` });
}

export const history = {
  mount(el) {
    host = el;
    el.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>Campaigns</h2><small>সর্বশেষ ৮০টি — নতুন থেকে পুরোনো</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="export"><i class="fa-solid fa-download"></i> Export list</button>
          <button type="button" class="btn btn-outline btn-sm" data-act="reload"><i class="fa-solid fa-arrow-rotate-right"></i> Reload</button></div></div>
      <div class="panel-body"><div class="toolbar"><div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="hs-q" placeholder="Search name, subject, exam, admin…" aria-label="Search campaigns" autocomplete="off"></div>
        <select id="hs-status" aria-label="Filter by status"><option value="">All statuses</option>${Object.entries(CAMPAIGN_STATUS).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join("")}</select>
        <select id="hs-type" aria-label="Filter by type"><option value="">All types</option>${Object.entries(CAMPAIGN_TYPES).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join("")}</select></div>
        <div id="hs-table"></div></div></div>`;
    table = createTable({
      mount: el.querySelector("#hs-table"), pageSize: 10, defaultSort: { key: "created", dir: "desc" },
      empty: { icon: "fa-envelope-open", title: "কোনো ক্যাম্পেইন মেলেনি", text: "প্রথম ক্যাম্পেইন পাঠালে বা ড্রাফট সেভ করলে এখানে দেখা যাবে।" },
      columns: [
        { key: "name", label: "Campaign", sortable: true, sortValue: (c) => (c.name || "").toLowerCase(), render: (c) => `<button type="button" class="link-btn em-cname" data-view="${esc(c.id)}"><b>${esc(c.name || "Campaign")}</b></button><div class="s">${esc(c.subject || "")}</div>` },
        { key: "type", label: "Type", sortable: true, sortValue: (c) => c.type, render: (c) => esc(CAMPAIGN_TYPES[c.type]?.label || c.type) },
        { key: "exam", label: "Exam", render: (c) => esc(c.examTitle || "—") },
        { key: "created", label: "Created", sortable: true, sortValue: (c) => c.createdAt?.toMillis?.() || 0, render: (c) => `<div class="cell-main"><div class="t">${fmtDateTime(c.createdAt)}</div><div class="s">${esc(c.createdBy?.name || "—")}</div></div>` },
        { key: "total", label: "Recipients", sortable: true, sortValue: (c) => c.status === "draft" ? (c.selectedUids || []).length : c.totals?.total || 0, render: (c) => fmtN(c.status === "draft" ? (c.selectedUids || []).length : c.totals?.total || 0) },
        { key: "acc", label: "Accepted", sortable: true, sortValue: (c) => c.totals?.accepted || 0, render: (c) => (c.status === "draft" ? "—" : fmtN(c.totals?.accepted || 0)) },
        { key: "fail", label: "Failed", sortable: true, sortValue: (c) => c.totals?.failed || 0, render: (c) => (c.status === "draft" ? "—" : fmtN(c.totals?.failed || 0)) },
        { key: "pend", label: "Pending / uncertain", sortable: true, sortValue: (c) => (c.totals?.pending || 0) + (c.totals?.uncertain || 0), render: (c) => (c.status === "draft" ? "—" : `${fmtN((c.totals?.pending || 0) + (c.totals?.sending || 0))} / ${fmtN(c.totals?.uncertain || 0)}`) },
        { key: "status", label: "Status", sortable: true, sortValue: (c) => c.status, render: (c) => campaignChip(c.status) },
        { key: "act", label: "", cls: "c-act", render: (c) => `<button type="button" class="btn btn-outline btn-sm" data-view="${esc(c.id)}">Details</button>` },
      ],
    });
    el.addEventListener("input", debounce((e) => { if (e.target.id === "hs-q") { f.q = e.target.value; paint(); } }, 200));
    el.addEventListener("change", (e) => { if (e.target.id === "hs-status") { f.status = e.target.value; paint(); } if (e.target.id === "hs-type") { f.type = e.target.value; paint(); } });
    el.addEventListener("click", async (e) => {
      const v = e.target.closest("[data-view]");
      if (v) { openDetails(v.dataset.view); return; }
      const a = e.target.closest("[data-act]")?.dataset.act;
      if (a === "export") exportList();
      else if (a === "reload") { await withBusy(e.target.closest("button"), () => refreshCampaigns({ force: true })); toast("হিস্ট্রি রিফ্রেশ হয়েছে", "success"); }
    });
    on("campaigns", () => paint());
    on("run-finished", () => paint());
    paint();
    if (S.openCampaign) { const id = S.openCampaign; S.openCampaign = ""; openDetails(id); }
  },
  refresh() {
    paint();
    if (S.openCampaign) { const id = S.openCampaign; S.openCampaign = ""; openDetails(id); }
  },
};
