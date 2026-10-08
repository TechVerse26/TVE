// ==========================================================================
// admin/logs.js — who did what, and when. Reads the append-only adminLogs collection
// (written by core/audit.js for every important admin action). Server-paginated:
// each "Load older" costs one page of reads, nothing is scanned in bulk.
// ==========================================================================
import { toast, downloadCsv, openModal, closeModal } from "../utils.js";
import {
  esc, $, ago, fmtN, fmtDateTime, toMs, debounce, pageHead, chip, createTable, confirmDanger, withBusy, errorState, skeleton, isDenied,
} from "./core/ui.js";
import { fetchLogs, actionMeta, purgeLogsOlderThan, logAction } from "./core/audit.js";
import { ROLES, can } from "./core/permissions.js";
import { emitChange, onChange } from "./core/bus.js";

const PAGE = 50;
let root, table, rows = [], cursor = null, done = false, loading = false;
const f = { q: "", group: "", who: "" };
const GROUPS = { exam: "Exams", schedule: "Schedule", notice: "Notices", homepage: "Homepage", question: "Questions", subject: "Subjects", category: "Categories", user: "Students", notification: "Notifications", settings: "Settings", admin: "Admins", logs: "Logs" };

export async function mount(el) {
  root = el;
  const canPurge = can("settings.manage");
  root.innerHTML = `
    ${pageHead({ title: "Activity Logs", desc: "অ্যাডমিনদের গুরুত্বপূর্ণ কাজের ইতিহাস — কে, কখন, কী বদলেছে।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="lg-refresh" title="Reload"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button type="button" class="btn btn-outline btn-sm" id="lg-export"><i class="fa-solid fa-download"></i> Export CSV</button>
        ${canPurge ? `<button type="button" class="btn btn-outline btn-sm" id="lg-purge"><i class="fa-solid fa-broom"></i> Clean up</button>` : ""}` })}
    <div class="panel">
      <div class="toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lg-q" placeholder="Search action, target or admin…" autocomplete="off"></div>
        <select id="lg-group" aria-label="Area"><option value="">All areas</option>${Object.entries(GROUPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <select id="lg-who" aria-label="Admin"><option value="">All admins</option></select>
      </div>
      <div id="lg-table"></div>
      <div class="tbl-foot" id="lg-more" style="justify-content:center"></div>
    </div>`;
  table = createTable({
    mount: $("#lg-table", root), pageSize: 25, defaultSort: { key: "at", dir: "desc" },
    empty: { icon: "fa-clock-rotate-left", title: "কোনো লগ নেই", text: "এক্সাম, প্রশ্ন, ব্যবহারকারী বা সেটিংস বদলালে এখানে রেকর্ড হবে।" },
    columns: [
      { key: "at", label: "When", sortable: true, sortValue: (l) => toMs(l.at), render: (l) => `<span title="${esc(fmtDateTime(l.at))}">${ago(l.at)}</span><div class="muted" style="font-size:.74rem">${esc(fmtDateTime(l.at))}</div>` },
      { key: "who", label: "Admin", sortable: true, sortValue: (l) => (l.name || l.email || "").toLowerCase(), render: (l) => `<div class="cell-main"><div class="t">${esc(l.name || l.email || "Admin")}</div><div class="s">${esc(ROLES[l.role]?.label || l.role || "")}</div></div>` },
      { key: "action", label: "Action", sortable: true, sortValue: (l) => actionMeta(l.action)[0], render: (l) => { const [label, icon, tone] = actionMeta(l.action); return `<span class="feed-ico ${tone}" style="display:inline-grid;vertical-align:middle;margin-inline-end:8px"><i class="fa-solid ${icon}"></i></span>${esc(label)}`; } },
      { key: "target", label: "Target", render: (l) => `<div class="cell-main"><div class="t clamp2">${esc(l.label || "—")}</div>${l.detail ? `<div class="s clamp2">${esc(l.detail)}</div>` : ""}</div>` },
    ],
  });
  $("#lg-q", root).addEventListener("input", debounce((e) => { f.q = e.target.value.trim().toLowerCase(); paint(); }, 150));
  $("#lg-group", root).addEventListener("change", (e) => { f.group = e.target.value; paint(); });
  $("#lg-who", root).addEventListener("change", (e) => { f.who = e.target.value; paint(); });
  $("#lg-refresh", root).addEventListener("click", () => reset());
  $("#lg-export", root).addEventListener("click", exportCsv);
  $("#lg-purge", root)?.addEventListener("click", purge);
  root.addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) reset(); if (e.target.closest("[data-more]")) more(); });
  onChange((kind) => { if (kind === "logs") stale = true; });
  await reset();
}

let stale = false;
export function activate() { if (stale) { stale = false; reset(); } }

async function reset() { rows = []; cursor = null; done = false; table.setState(skeleton(6)); $("#lg-more", root).innerHTML = ""; await more(true); }

async function more(first = false) {
  if (loading || done) return;
  loading = true;
  const foot = $("#lg-more", root);
  if (!first) foot.innerHTML = `<span class="spinner"></span>`;
  try {
    const page = await fetchLogs({ pageSize: PAGE, after: cursor });
    rows = rows.concat(page.rows);
    cursor = page.last; done = page.done;
    const who = $("#lg-who", root), keep = who.value;
    const people = [...new Map(rows.map((l) => [l.uid, l.name || l.email || l.uid])).entries()];
    who.innerHTML = `<option value="">All admins</option>${people.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join("")}`;
    who.value = people.some(([id]) => id === keep) ? keep : "";
    paint();
  } catch (err) {
    table.setState(isDenied(err) ? errorState({ title: "Activity Logs — Firestore rules প্রয়োজন", text: "firestore.rules ফাইলটি Firebase Console → Firestore → Rules-এ পেস্ট করে Publish করুন।" }) : errorState({ title: "লগ লোড করা যায়নি", text: err?.message || "" }));
    foot.innerHTML = "";
  } finally { loading = false; }
}

function filtered() {
  return rows.filter((l) =>
    (!f.group || String(l.action || "").startsWith(`${f.group}.`)) && (!f.who || l.uid === f.who) &&
    (!f.q || `${actionMeta(l.action)[0]} ${l.label || ""} ${l.detail || ""} ${l.name || ""} ${l.email || ""}`.toLowerCase().includes(f.q)));
}
function paint() {
  table.setRows(filtered(), { keepPage: true });
  $("#lg-more", root).innerHTML = done
    ? `<span class="muted">${fmtN(rows.length)} entries loaded — that's everything</span>`
    : `<span class="muted">${fmtN(rows.length)} loaded</span> <button type="button" class="btn btn-outline btn-sm" data-more>Load older</button>`;
}

function exportCsv() {
  const list = filtered();
  if (!list.length) { toast("এক্সপোর্ট করার মতো কিছু নেই", "info"); return; }
  downloadCsv(`activity-log-${new Date().toISOString().slice(0, 10)}.csv`, [["When", "Admin", "Email", "Role", "Action", "Target", "Detail"],
    ...list.map((l) => [fmtDateTime(l.at), l.name || "", l.email || "", l.role || "", actionMeta(l.action)[0], l.label || "", l.detail || ""])]);
}

function purge() {
  const overlay = openModal(`
    <div class="modal-head"><h3>পুরোনো লগ মুছুন</h3></div>
    <div class="field"><label>কত দিনের পুরোনো লগ মুছবেন?</label><input type="number" id="pg-days" min="30" value="90"><span class="form-hint">সর্বনিম্ন ৩০ দিন। সাম্প্রতিক লগ থেকে যাবে।</span></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>বাতিল</button><button type="button" class="btn btn-coral btn-block" id="pg-ok">এগিয়ে যান</button></div>`);
  overlay.querySelector("#pg-ok").addEventListener("click", async () => {
    const days = Number(overlay.querySelector("#pg-days").value);
    if (!Number.isFinite(days) || days < 30) { toast("কমপক্ষে ৩০ দিন দিতে হবে", "error"); return; }
    closeModal();
    if (!(await confirmDanger({ title: "পুরোনো লগ মুছবেন?", message: `${days} দিনের আগের সব অ্যাক্টিভিটি লগ স্থায়ীভাবে মুছে যাবে।`, confirmLabel: "Delete old logs", phrase: "delete" }))) return;
    try {
      const n = await purgeLogsOlderThan(days);
      await logAction("logs.purge", { type: "logs", label: `${n} entries older than ${days} days` });
      toast(`${n}টি পুরোনো লগ মুছে ফেলা হয়েছে`, "success");
      reset();
    } catch (err) { toast(isDenied(err) ? "অনুমতি নেই" : "মুছে ফেলা যায়নি", "error"); }
  });
}
