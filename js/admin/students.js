// ==========================================================================
// admin/students.js — Students / Users: search, filters, profile drawer (exam history, results,
// activity), account activate/deactivate, and the roll-number tools (unchanged rules: students can only
// CLAIM a roll; an admin can generate one or override it, with a uniqueness check).
//
// Account status = users/{uid}.disabled. A deactivated student can still sign in and browse, but can
// not start an exam (enforced in the exam entry guard). Admin accounts need a Super Admin to be changed.
// Enrollment itself is still edited on the course site's admin panel.
// ==========================================================================
import { db } from "../firebase-config.js";
import { doc, updateDoc, serverTimestamp, deleteField } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, openModal, closeModal, downloadCsv, formatScore } from "../utils.js";
import { fetchAllUsersAdmin, fetchAllResultsAdmin, fetchAllExamsAdmin, countAttempts } from "../exam-data.js";
import { claimNextRoll, isRollTaken } from "../roll.js";
import {
  esc, $, fmtN, fmtPct, fmtDur, fmtDate, fmtDateTime, ago, toMs, toDate, debounce, pageHead, kpi, chip, avatar, createTable, bulkBar,
  confirmDanger, openDrawer, closeDrawer, withBusy, errorState, skeleton,
} from "./core/ui.js";
import { can, currentRole } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { emitChange, onChange } from "./core/bus.js";
import { getSettings } from "./core/settings.js";
import { passPercentOf } from "./core/exam-status.js";
import { courses, me } from "./admin.js";

let root, table, rows = [], byUid = new Map(), resultsByUid = new Map(), examsById = {}, updateBulk = () => {}, stale = false;
const f = { q: "", role: "", status: "", activity: "", course: "", roll: "" };
const courseTitle = (id) => courses.find((c) => c.id === id)?.title || id;

export async function mount(el) {
  root = el;
  const manage = can("students.manage");
  root.innerHTML = `
    ${pageHead({ title: "Students", desc: "শিক্ষার্থীদের তালিকা, প্রোফাইল, এক্সাম হিস্টরি ও অ্যাকাউন্ট নিয়ন্ত্রণ।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="st-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button type="button" class="btn btn-outline btn-sm" id="st-export"><i class="fa-solid fa-download"></i> Export CSV</button>` })}
    <div class="stack">
      <div id="st-kpis"></div>
      <div class="panel">
        <div class="toolbar">
          <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="st-q" placeholder="Search name, email or roll…" autocomplete="off"></div>
          <select id="st-role" aria-label="Role"><option value="">All roles</option><option value="student">Students</option><option value="admin">Admins</option></select>
          <select id="st-status" aria-label="Status"><option value="">Any status</option><option value="active">Active</option><option value="off">Deactivated</option></select>
          <select id="st-activity" aria-label="Activity"><option value="">Any activity</option><option value="attempted">Has taken exams</option><option value="never">Never attempted</option><option value="inactive">Inactive</option></select>
          <select id="st-course" aria-label="Course"></select>
          <select id="st-roll" aria-label="Roll"><option value="">Roll: any</option><option value="has">Has roll</option><option value="none">No roll yet</option></select>
        </div>
        <div id="st-table"></div>
      </div>
    </div>
    <div id="st-bulk"></div>`;

  $("#st-course", root).innerHTML = `<option value="">All courses</option>${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("")}<option value="__none">Not enrolled</option>`;
  table = createTable({
    mount: $("#st-table", root), selectable: manage, onSelect: (ids) => updateBulk(ids.length),
    defaultSort: { key: "name", dir: "asc" },
    empty: { icon: "fa-users", title: "কোনো শিক্ষার্থী পাওয়া যায়নি", text: "ফিল্টার বদলে দেখুন।" },
    columns: [
      { key: "name", label: "Student", sortable: true, sortValue: (r) => r.name.toLowerCase(), render: (r) =>
        `<div class="row" style="flex-wrap:nowrap;gap:10px">${avatar(r.name, 34)}<div class="cell-main"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.u.email || "")}</div></div></div>` },
      { key: "roll", label: "Roll", sortable: true, sortValue: (r) => r.u.roll || "", render: (r) => rollCell(r.u) },
      { key: "courses", label: "Courses", render: (r) => (r.u.enrolledCourses || []).length
        ? (r.u.enrolledCourses.slice(0, 2).map((id) => chip(courseTitle(id), "teal")).join(" ") + (r.u.enrolledCourses.length > 2 ? ` <span class="muted">+${r.u.enrolledCourses.length - 2}</span>` : ""))
        : `<span class="muted" style="font-size:.78rem">কোনো কোর্সে নেই</span>` },
      { key: "attempts", label: "Attempts", cls: "c-num", sortable: true, sortValue: (r) => r.attempts, render: (r) => fmtN(r.attempts) },
      { key: "avg", label: "Avg score", cls: "c-num", sortable: true, sortValue: (r) => (r.exams ? r.avg : null), render: (r) => (r.exams ? fmtPct(r.avg) : `<span class="muted">—</span>`) },
      { key: "last", label: "Last active", sortable: true, sortValue: (r) => r.last, render: (r) => (r.last ? `<span class="muted">${ago(r.last)}</span>` : `<span class="muted">—</span>`) },
      { key: "role", label: "Role / Status", sortable: true, sortValue: (r) => `${r.u.isAdmin ? 0 : 1}${r.u.disabled ? 1 : 0}`, render: (r) =>
        `${r.u.isAdmin ? chip("Admin", "amber") : chip("Student")} ${r.u.disabled ? chip("Deactivated", "coral") : ""}` },
      { key: "act", label: "", cls: "c-act", render: (r) => `<div class="row-actions"><button type="button" class="icon-btn" data-act="view" data-id="${esc(r.id)}" title="View profile"><i class="fa-solid fa-id-card"></i></button>
        ${manage ? `<button type="button" class="icon-btn ${r.u.disabled ? "" : "danger"}" data-act="toggle" data-id="${esc(r.id)}" title="${r.u.disabled ? "Activate account" : "Deactivate account"}"><i class="fa-solid ${r.u.disabled ? "fa-user-check" : "fa-user-slash"}"></i></button>` : ""}</div>` },
    ],
  });
  updateBulk = bulkBar($("#st-bulk", root), [
    { id: "activate", label: "Activate", icon: "fa-user-check", tone: "teal" }, { id: "deactivate", label: "Deactivate", icon: "fa-user-slash", tone: "coral" },
    { id: "export", label: "Export", icon: "fa-download" },
  ], onBulk);

  $("#st-q", root).addEventListener("input", debounce((e) => { f.q = e.target.value; refresh(); }, 150));
  ["role", "status", "activity", "course", "roll"].forEach((k) => $(`#st-${k}`, root).addEventListener("change", (e) => { f[k] = e.target.value; refresh(); }));
  $("#st-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#st-export", root).addEventListener("click", () => exportCsv(filtered()));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const gen = e.target.closest(".roll-gen-btn"), edit = e.target.closest(".roll-edit-btn");
    if (gen) return generateRoll(gen);
    if (edit) return rollModal(edit.dataset.uid);
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "view") openProfile(b.dataset.id);
    if (b.dataset.act === "toggle") toggleAccount([b.dataset.id]);
  });
  onChange((kind) => { if (["results", "users", "exams"].includes(kind)) stale = true; });
  await load();
}

export function activate() { if (stale) load(); }

/* ---------- Data ---------- */
async function load(opts) {
  table.setState(skeleton(6));
  try {
    const [users, results, exams] = await Promise.all([fetchAllUsersAdmin(opts), fetchAllResultsAdmin(opts), fetchAllExamsAdmin(opts).catch(() => [])]);
    stale = false;
    examsById = Object.fromEntries(exams.map((e) => [e.id, e]));
    resultsByUid = new Map();
    results.forEach((r) => { if (!resultsByUid.has(r.uid)) resultsByUid.set(r.uid, []); resultsByUid.get(r.uid).push(r); });
    buildRows(users);
    refresh();
  } catch (err) { table.setState(errorState({ title: "শিক্ষার্থীদের তালিকা লোড করা যায়নি", text: err?.message || "" })); }
}

function buildRows(users) {
  rows = users.map((u) => {
    const rs = resultsByUid.get(u.id) || [];
    const attempts = rs.reduce((s, r) => s + countAttempts(r), 0);
    const avg = rs.length ? rs.reduce((s, r) => s + (Number(r.percent) || 0), 0) / rs.length : 0;
    const last = rs.reduce((m, r) => Math.max(m, toMs(r.submittedAt)), 0);
    return { id: u.id, u, name: u.displayName || "নাম নেই", attempts, exams: rs.length, avg, last, joined: toMs(u.createdAt) };
  });
  byUid = new Map(rows.map((r) => [r.id, r]));
}

function filtered() {
  const q = f.q.trim().toLowerCase();
  const inactiveMs = (Number(getSettings().users.inactiveDays) || 30) * 86400000;
  return rows.filter((r) => {
    const u = r.u;
    if (f.role === "admin" && !u.isAdmin) return false;
    if (f.role === "student" && u.isAdmin) return false;
    if (f.status === "off" && !u.disabled) return false;
    if (f.status === "active" && u.disabled) return false;
    if (f.activity === "attempted" && !r.attempts) return false;
    if (f.activity === "never" && r.attempts) return false;
    if (f.activity === "inactive" && !(r.attempts && Date.now() - r.last > inactiveMs)) return false;
    if (f.course === "__none" && (u.enrolledCourses || []).length) return false;
    if (f.course && f.course !== "__none" && !(u.enrolledCourses || []).includes(f.course)) return false;
    if (f.roll === "has" && !u.roll) return false;
    if (f.roll === "none" && u.roll) return false;
    return !q || `${u.displayName || ""} ${u.email || ""} ${u.roll || ""}`.toLowerCase().includes(q);
  });
}

function refresh() {
  const total = rows.length, admins = rows.filter((r) => r.u.isAdmin).length, off = rows.filter((r) => r.u.disabled).length;
  const days = Number(getSettings().users.inactiveDays) || 30;
  const active = rows.filter((r) => r.last && Date.now() - r.last <= days * 86400000).length;
  $("#st-kpis", root).innerHTML = `<div class="kpis">
    ${kpi({ label: "Total users", value: fmtN(total), sub: `${fmtN(total - admins)} students · ${fmtN(admins)} admins` })}
    ${kpi({ label: `Active (${days}d)`, value: fmtN(active), sub: "took an exam recently", tone: "teal" })}
    ${kpi({ label: "Never attempted", value: fmtN(rows.filter((r) => !r.attempts && !r.u.isAdmin).length), sub: "students" })}
    ${kpi({ label: "Without roll", value: fmtN(rows.filter((r) => !r.u.roll && !r.u.isAdmin).length), sub: "not synced yet" })}
    ${kpi({ label: "Deactivated", value: fmtN(off), tone: off ? "coral" : "" })}</div>`;
  table.setRows(filtered(), { keepPage: true });
}

/* ---------- Roll tools (same behaviour as before) ---------- */
function rollCell(u) {
  if (u.roll) return `<span class="roll-chip"><span class="roll-chip-num">${esc(u.roll)}</span>${can("students.manage") ? `<button type="button" class="roll-edit-btn" data-uid="${esc(u.id)}" title="রোল পরিবর্তন করুন"><i class="fa-solid fa-pen"></i></button>` : ""}</span>`;
  return can("students.manage") ? `<button type="button" class="roll-gen-btn" data-uid="${esc(u.id)}"><i class="fa-solid fa-arrows-rotate"></i> জেনারেট</button>` : `<span class="muted">—</span>`;
}
async function generateRoll(btn) {
  const row = byUid.get(btn.dataset.uid);
  if (!row) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try {
    const roll = await claimNextRoll();
    await updateDoc(doc(db, "users", row.id), { roll });
    row.u.roll = roll;
    logAction("user.roll", { type: "user", id: row.id, label: row.name, detail: `generated ${roll}` });
    toast(`${row.name} এর রোল সেট হয়েছে: ${roll}`, "success");
    refresh();
  } catch { toast("রোল জেনারেট করা যায়নি, আবার চেষ্টা করুন", "error"); refresh(); }
}
function rollModal(uid) {
  const row = byUid.get(uid);
  if (!row) return;
  const overlay = openModal(`
    <div class="modal-head"><h3>রোল পরিবর্তন করুন</h3></div>
    <p class="confirm-msg">${esc(row.name)} এর জন্য নতুন রোল নম্বর দিন। এটি অন্য কোনো শিক্ষার্থীর সাথে মিলবে না, এমন স্বতন্ত্র নম্বর হতে হবে।</p>
    <div class="field"><label>রোল নম্বর</label><input type="text" id="roll-in" value="${esc(row.u.roll || "")}" placeholder="যেমন 0001"></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>বাতিল</button><button type="button" class="btn btn-primary btn-block" id="roll-ok">সংরক্ষণ করুন</button></div>`);
  $("#roll-ok", overlay).addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const roll = $("#roll-in", overlay).value.trim();
    if (!roll) { toast("রোল নম্বর লিখুন", "error"); return; }
    try {
      if (roll !== row.u.roll && (await isRollTaken(roll, uid))) { toast("এই রোল নম্বরটি অন্য শিক্ষার্থীর সাথে যুক্ত আছে", "error"); return; }
      await updateDoc(doc(db, "users", uid), { roll });
      row.u.roll = roll;
      logAction("user.roll", { type: "user", id: uid, label: row.name, detail: `set ${roll}` });
      toast("রোল আপডেট হয়েছে", "success");
      closeModal(); refresh();
    } catch { toast("রোল সংরক্ষণ করা যায়নি, আবার চেষ্টা করুন", "error"); }
  }));
}

/* ---------- Activate / deactivate ---------- */
async function toggleAccount(ids, forceTo) {
  const list = ids.map((id) => byUid.get(id)).filter(Boolean);
  const target = forceTo ?? !list[0]?.u.disabled; // true = deactivate
  const eligible = [], skipped = [];
  list.forEach((r) => {
    if (r.id === me?.user?.uid) skipped.push("নিজের অ্যাকাউন্ট");
    else if (r.u.isAdmin && currentRole() !== "super") skipped.push(`${r.name} (অ্যাডমিন)`);
    else if (!!r.u.disabled !== target) eligible.push(r);
  });
  if (!eligible.length) { toast(skipped.length ? `পরিবর্তন করা যাবে না: ${skipped[0]}` : "কোনো পরিবর্তন নেই", "info"); return; }
  if (target && !(await confirmDanger({
    title: eligible.length > 1 ? `${eligible.length}টি অ্যাকাউন্ট নিষ্ক্রিয় করবেন?` : "অ্যাকাউন্ট নিষ্ক্রিয় করবেন?",
    message: `${eligible.length === 1 ? eligible[0].name : "নির্বাচিত শিক্ষার্থীরা"} আর কোনো এক্সাম শুরু করতে পারবে না। ফলাফল ও ডেটা অক্ষত থাকবে; যেকোনো সময় আবার চালু করা যাবে।`,
    confirmLabel: "Deactivate", tone: "coral",
  }))) return;
  let ok = 0;
  for (const r of eligible) {
    try {
      await updateDoc(doc(db, "users", r.id), target
        ? { disabled: true, disabledAt: serverTimestamp(), disabledBy: me.user.uid }
        : { disabled: false, disabledAt: deleteField(), disabledBy: deleteField() });
      r.u.disabled = target; ok++;
      logAction(target ? "user.deactivate" : "user.activate", { type: "user", id: r.id, label: r.name });
    } catch { /* continue with the rest */ }
  }
  toast(`${ok}/${eligible.length}টি অ্যাকাউন্ট ${target ? "নিষ্ক্রিয়" : "সক্রিয়"} হয়েছে${skipped.length ? ` (${skipped.length}টি বাদ)` : ""}`, ok === eligible.length ? "success" : "error");
  table.clearSelection();
  refresh(); emitChange("users");
  if (document.getElementById("adm-drawer")) closeDrawer();
}

function onBulk(action) {
  const ids = table.getSelected();
  if (action === "clear") return table.clearSelection();
  if (action === "export") return exportCsv(ids.map((id) => byUid.get(id)).filter(Boolean));
  if (action === "activate") return toggleAccount(ids, false);
  if (action === "deactivate") return toggleAccount(ids, true);
}

/* ---------- Profile drawer ---------- */
function openProfile(uid) {
  const r = byUid.get(uid);
  if (!r) return;
  const u = r.u, rs = (resultsByUid.get(uid) || []).slice().sort((a, b) => toMs(b.submittedAt) - toMs(a.submittedAt));
  const best = rs.reduce((m, x) => Math.max(m, Number(x.percent) || 0), 0);
  const history = rs.flatMap((x) => (Array.isArray(x.attempts) && x.attempts.length ? x.attempts : [x]).map((a) => ({ exam: x.examTitle || "—", percent: a.percent, at: a.submittedAt || x.submittedAt, time: a.timeTakenSeconds })))
    .sort((a, b) => toMs(b.at) - toMs(a.at)).slice(0, 8);
  const d = openDrawer({
    title: r.name, subtitle: u.email || "", width: 620,
    html: `
    <div class="row" style="gap:14px">${avatar(r.name, 52)}<div class="row" style="gap:6px">${u.isAdmin ? chip("Admin", "amber") : chip("Student")}${u.disabled ? chip("Deactivated", "coral") : chip("Active", "teal")}${u.roll ? chip(`Roll ${u.roll}`, "accent") : ""}</div></div>
    <div class="mini-stats">
      <div class="mini-stat"><b>${fmtN(r.exams)}</b><span>Exams taken</span></div>
      <div class="mini-stat"><b>${fmtN(r.attempts)}</b><span>Attempts</span></div>
      <div class="mini-stat"><b>${r.exams ? fmtPct(r.avg) : "—"}</b><span>Average</span></div>
      <div class="mini-stat"><b>${r.exams ? fmtPct(best) : "—"}</b><span>Best score</span></div></div>
    <div><h3>Profile</h3><dl class="kv">
      <dt>Joined</dt><dd>${r.joined ? fmtDateTime(r.joined) : "—"}</dd>
      <dt>Last active</dt><dd>${r.last ? `${fmtDateTime(r.last)} (${ago(r.last)})` : "Never"}</dd>
      <dt>Courses</dt><dd>${(u.enrolledCourses || []).length ? u.enrolledCourses.map((id) => chip(courseTitle(id), "teal")).join(" ") : "Not enrolled"}</dd>
      ${u.disabled && u.disabledAt ? `<dt>Deactivated</dt><dd>${fmtDateTime(u.disabledAt)}</dd>` : ""}</dl></div>
    <div><h3>Exam results</h3>${rs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Exam</th><th class="c-num">Latest</th><th class="c-num">Tries</th><th>Result</th></tr></thead><tbody>${rs.map((x) => {
      const pass = (Number(x.percent) || 0) >= passPercentOf(examsById[x.examId]);
      return `<tr><td data-label="Exam"><div class="cell-main"><div class="t clamp2">${esc(x.examTitle || "—")}</div><div class="s">${x.examType === "practice" ? "Practice" : "Live"} · ${fmtDate(x.submittedAt)}</div></div></td>
        <td data-label="Latest" class="c-num">${formatScore(x.score)} / ${x.total} <span class="muted">(${fmtPct(x.percent)})</span></td><td data-label="Tries" class="c-num">${countAttempts(x)}</td><td data-label="Result">${chip(pass ? "Pass" : "Fail", pass ? "teal" : "coral")}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<p class="muted">এখনো কোনো এক্সাম দেননি।</p>`}</div>
    <div><h3>Recent activity</h3>${history.length ? `<ul class="feed">${history.map((h) => `<li><span class="feed-ico"><i class="fa-solid fa-pen-to-square"></i></span><div><div class="feed-t">${esc(h.exam)} — <b>${fmtPct(h.percent)}</b></div><div class="feed-s">${fmtDateTime(h.at)}${h.time ? ` · ${fmtDur(h.time)}` : ""}</div></div></li>`).join("")}</ul>` : `<p class="muted">কোনো অ্যাক্টিভিটি নেই।</p>`}</div>
    ${can("students.manage") ? `<div class="row"><button type="button" class="btn ${u.disabled ? "btn-teal" : "btn-coral"} btn-sm" id="pf-toggle"><i class="fa-solid ${u.disabled ? "fa-user-check" : "fa-user-slash"}"></i> ${u.disabled ? "Activate account" : "Deactivate account"}</button></div>` : ""}`,
  });
  d.body.querySelector("#pf-toggle")?.addEventListener("click", () => toggleAccount([uid]));
}

function exportCsv(list) {
  if (!list.length) { toast("এক্সপোর্ট করার মতো কিছু নেই", "info"); return; }
  const data = [["Name", "Email", "Roll", "Role", "Status", "Courses", "Exams taken", "Attempts", "Average %", "Last active", "Joined"]];
  list.forEach((r) => data.push([
    r.u.displayName || "", r.u.email || "", r.u.roll || "", r.u.isAdmin ? "Admin" : "Student", r.u.disabled ? "Deactivated" : "Active",
    (r.u.enrolledCourses || []).map(courseTitle).join("; "), r.exams, r.attempts, r.exams ? Math.round(r.avg) : "",
    r.last ? fmtDateTime(r.last) : "", r.joined ? fmtDate(r.joined) : "",
  ]));
  downloadCsv(`students-${new Date().toISOString().slice(0, 10)}.csv`, data);
}
