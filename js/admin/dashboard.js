// ==========================================================================
// admin/dashboard.js — landing page: the whole platform at a glance.
// Cheap by design: counts come from aggregation queries, the exam list is the one shared admin
// download, "recent" data is a capped 30-day query (or reuses a download another tab made).
// Every card renders on its own — one failing query never blanks the page.
// ==========================================================================
import {
  esc, $, fmtN, fmtPct, pageHead, kpi, chip, dotStatus, avatar, ago, fmtDateTime, toMs, toDate, dayKey,
  emptyState, errorState, skeleton, segmented, bindSegmented, isDenied,
} from "./core/ui.js";
import { lineChart, hbars, donut, COLORS } from "./core/charts.js";
import { dashboardCounts, recentResults, clearDashboardCache, usersByIds, todayNewStudents } from "./core/data.js";
import { fetchAllExamsAdmin, getExamCatalog } from "../exam-data.js";
import { bankCount } from "./core/qbank.js";
import { fetchLogs, actionMeta } from "./core/audit.js";
import { getSettings, settingsMeta } from "./core/settings.js";
import { can } from "./core/permissions.js";
import { examState, passPercentOf, isDraft } from "./core/exam-status.js";
import { onChange, setPending } from "./core/bus.js";
import { go } from "./admin.js";
import { adminScheduleState, startOfDay, endOfDay } from "../schedule-core.js";
import { hasSchedule } from "../home-core.js";
import { serverNow, syncServerTime } from "../server-time.js";

let root, stale = false, range = 14, data = null;

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({
      title: "Dashboard",
      desc: "পুরো পরীক্ষা প্ল্যাটফর্মের অবস্থা এক নজরে।",
      actions: `${can("exams.write") ? `<button type="button" class="btn btn-primary btn-sm" id="dash-new-exam"><i class="fa-solid fa-plus"></i> New exam</button>` : ""}
                <button type="button" class="btn btn-outline btn-sm" id="dash-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i> Refresh</button>`,
    })}
    <div class="stack" id="dash-body">${skeleton(4)}</div>`;
  syncServerTime();
  root.querySelector("#dash-refresh").addEventListener("click", () => load({ force: true }));
  root.querySelector("#dash-new-exam")?.addEventListener("click", () => { setPending("new-exam"); go("exams"); });
  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-go]");
    if (a) { if (a.dataset.pending) setPending(a.dataset.pending); go(a.dataset.go); }
  });
  onChange((kind) => { if (["exams", "results", "users", "questions", "settings"].includes(kind)) stale = true; });
  await load();
}

export function activate() { if (stale) load(); }

/* ---------- Data ---------- */
async function load(opts) {
  stale = false;
  const body = $("#dash-body", root);
  if (!data) body.innerHTML = skeleton(4);
  if (opts?.force) clearDashboardCache();
  const wantLogs = can("logs.view");
  const [counts, exams, recent, bank, catalog, logs, todayNew] = await Promise.allSettled([
    dashboardCounts(opts),
    fetchAllExamsAdmin(opts),
    recentResults({ days: 30, cap: 400 }, opts),
    bankCount(),
    getExamCatalog(opts),
    wantLogs ? fetchLogs({ pageSize: 8 }) : Promise.resolve(null),
    todayNewStudents(opts),
  ]);
  const ok = (r) => (r.status === "fulfilled" ? r.value : null);
  data = { counts: ok(counts), exams: ok(exams), recent: ok(recent), bank: ok(bank), catalog: ok(catalog), logs: ok(logs), todayNew: ok(todayNew), logsDenied: logs.status === "rejected" && isDenied(logs.reason), errs: { counts: counts.reason, exams: exams.reason, recent: recent.reason } };

  const rows = data.recent?.rows || [];
  data.users = rows.length ? await usersByIds(rows.slice(0, 10).map((r) => r.uid)).catch(() => ({})) : {};
  render();
}

/* ---------- Derived numbers ---------- */
function derive() {
  const exams = data.exams || [];
  const byId = Object.fromEntries(exams.map((e) => [e.id, e]));
  const states = { open: 0, scheduled: 0, closed: 0, draft: 0 };
  exams.forEach((e) => { states[examState(e)]++; });
  const rows = data.recent?.rows || [];
  const active = new Set(rows.map((r) => r.uid));
  const passed = rows.filter((r) => (Number(r.percent) || 0) >= passPercentOf(byId[r.examId])).length;
  // Schedule view (live-type exams only): what is on air, what is coming, what is over, and what falls on today.
  const now = serverNow(), dayStart = startOfDay(now);
  const sched = { live: 0, upcoming: 0, completed: 0, today: 0 };
  exams.forEach((e) => {
    if (e.examType === "practice") return;
    if (!hasSchedule(e)) return; // always-open exams are neither "live" nor "upcoming" — they have no schedule
    const st = adminScheduleState(e, now);
    if (st === "live") sched.live++;
    else if (st === "scheduled") sched.upcoming++;
    else if (st === "completed") sched.completed++;
    if (st === "draft" || st === "cancelled") return;
    const open = toMs(e.publishAt), close = toMs(e.closesAt);
    if (st === "live" || (open >= dayStart && open < endOfDay(dayStart)) || (st === "completed" && close >= dayStart)) sched.today++;
  });
  return {
    exams, byId, states, rows, sched, attemptsToday: attemptSeries(rows, 1)[0]?.y ?? 0,
    questions: exams.reduce((s, e) => s + (Number(e.questionCount) || 0), 0),
    activeUsers: active.size,
    passRate: rows.length ? (passed / rows.length) * 100 : null,
  };
}

function attemptSeries(rows, days) {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
  const map = new Map();
  for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(start.getDate() + i); map.set(dayKey(d), 0); }
  rows.forEach((r) => {
    const stamps = Array.isArray(r.attempts) && r.attempts.length ? r.attempts.map((a) => a?.submittedAt) : [r.submittedAt];
    stamps.forEach((s) => { const d = toDate(s); if (!d) return; const k = dayKey(d); if (map.has(k)) map.set(k, map.get(k) + 1); });
  });
  return [...map.entries()].map(([k, y]) => { const [, m, d] = k.split("-"); return { x: `${Number(d)}/${Number(m)}`, y }; });
}

/* ---------- Rendering ---------- */
function render() {
  const d = derive();
  const c = data.counts;
  const body = $("#dash-body", root);
  const dash = (v) => (v === null || v === undefined ? "—" : v);
  const capNote = data.recent?.capped ? "≥ " : "";

  // The eight headline numbers of an exam platform …
  const overviewStrip = `<div class="kpis kpis-4">
    ${kpi({ label: "Total students", value: dash(c ? fmtN(Math.max(0, c.users - c.admins)) : null), sub: c && c.disabledUsers ? `${fmtN(c.disabledUsers)} deactivated` : "registered accounts" })}
    ${kpi({ label: "Total exams", value: dash(data.exams ? fmtN(d.exams.length) : null), sub: `${d.states.draft} draft · ${d.exams.length - d.states.draft} published` })}
    ${kpi({ label: "Live exams", value: dash(data.exams ? fmtN(d.sched.live) : null), sub: "open right now", tone: d.sched.live ? "coral" : "" })}
    ${kpi({ label: "Upcoming exams", value: dash(data.exams ? fmtN(d.sched.upcoming) : null), sub: "scheduled, not started", tone: "amber" })}
    ${kpi({ label: "Completed exams", value: dash(data.exams ? fmtN(d.sched.completed) : null), sub: "window closed", tone: "accent" })}
    ${kpi({ label: "Total attempts", value: dash(c ? fmtN(c.attempts) : null), sub: "all time", tone: "accent" })}
    ${kpi({ label: "Average score", value: c ? fmtPct(c.avgPercent) : "—", sub: "all results" })}
    ${kpi({ label: "Pass rate", value: d.passRate === null ? "—" : fmtPct(d.passRate), sub: "last 30 days", tone: d.passRate !== null && d.passRate < 50 ? "coral" : "teal" })}
  </div>`;

  // … what is happening today …
  const todayPanel = `<div class="panel"><div class="panel-head"><h2>Today's overview</h2><small>${esc(new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }))}</small></div>
    <div class="panel-body"><div class="mini-stats mini-stats-2">
      <div class="mini-stat"><b>${data.exams ? fmtN(d.sched.today) : "—"}</b><span>Today's exams</span></div>
      <div class="mini-stat"><b>${data.recent ? `${capNote}${fmtN(d.attemptsToday)}` : "—"}</b><span>Today's attempts</span></div>
      <div class="mini-stat"><b>${dash(data.todayNew === null || data.todayNew === undefined ? null : fmtN(data.todayNew))}</b><span>New students today</span></div>
      <div class="mini-stat"><b>${data.exams ? fmtN(d.sched.upcoming) : "—"}</b><span>Pending / upcoming</span></div>
    </div></div></div>`;

  // … and the things an admin does most.
  const qa = (icon, label, go, perm, pending = "") => (can(perm) ? `<button type="button" class="qa-btn" data-go="${go}"${pending ? ` data-pending="${pending}"` : ""}><i class="fa-solid ${icon}"></i><span>${label}</span></button>` : "");
  const quickPanel = `<div class="panel"><div class="panel-head"><h2>Quick actions</h2></div>
    <div class="panel-body"><div class="qa-grid">
      ${qa("fa-plus", "Create exam", "exams", "exams.write", "new-exam")}
      ${qa("fa-calendar-plus", "Schedule exam", "schedule", "exams.write", "new-schedule")}
      ${qa("fa-circle-question", "Add questions", "questions", "questions.view")}
      ${qa("fa-bullhorn", "Send notice", "notices", "notices.manage", "new-notice")}
      ${qa("fa-square-poll-vertical", "View results", "results", "results.view")}
      ${qa("fa-users", "Manage students", "students", "students.view")}
    </div></div></div>`;

  // … then the wider content picture that was always here.
  const contentStrip = `<div class="kpis">
    ${kpi({ label: "Published", value: dash(data.exams ? fmtN(d.exams.length - d.states.draft) : null), sub: "visible to students", tone: "teal" })}
    ${kpi({ label: "Open (incl. practice)", value: dash(data.exams ? fmtN(d.states.open) : null), sub: `${d.states.scheduled} scheduled · ${d.states.closed} closed` })}
    ${kpi({ label: "Draft", value: dash(data.exams ? fmtN(d.states.draft) : null), sub: "hidden from students", tone: d.states.draft ? "amber" : "" })}
    ${kpi({ label: "Questions in exams", value: dash(data.exams ? fmtN(d.questions) : null), sub: "across all exams" })}
    ${kpi({ label: "Question bank", value: dash(data.bank === null ? null : fmtN(data.bank)), sub: "reusable library" })}
    ${kpi({ label: "Active users", value: data.recent ? `${capNote}${fmtN(d.activeUsers)}` : "—", sub: "took an exam in 30 days", tone: "teal" })}
  </div>`;

  const noteErr = (data.errs.counts && !c) ? `<div class="note warn"><b>কিছু সংখ্যা লোড হয়নি।</b> ${esc(data.errs.counts?.message || "")} Refresh করে দেখুন।</div>` : "";

  body.innerHTML = `${noteErr}${overviewStrip}
    <div class="grid-2">${todayPanel}${quickPanel}</div>
    ${contentStrip}
    <div class="grid-3">
      <div class="panel span-2">
        <div class="panel-head"><div><h2>Exam attempts</h2><small>${data.recent?.capped ? "সর্বশেষ ৪০০টি ফলাফল ডকুমেন্টের ভিত্তিতে" : "গত ৩০ দিনের ফলাফল ডকুমেন্টের ভিত্তিতে"}</small></div>
          ${segmented([{ id: "7", label: "7d" }, { id: "14", label: "14d" }, { id: "30", label: "30d" }], String(range))}</div>
        <div class="panel-body" id="dash-chart"></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Exam status</h2><small>${d.exams.length} total</small></div><div class="panel-body" id="dash-donut"></div></div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Recent results</h2>${can("results.view") ? `<button type="button" class="link-btn" data-go="results">View all</button>` : ""}</div><div class="panel-body flush" id="dash-results"></div></div>
      <div class="panel"><div class="panel-head"><h2>Recent activity</h2>${can("logs.view") ? `<button type="button" class="link-btn" data-go="logs">View all</button>` : ""}</div><div class="panel-body" id="dash-activity"></div></div>
    </div>
    <div class="grid-3">
      <div class="panel"><div class="panel-head"><h2>Most attempted exams</h2><small>30 days</small></div><div class="panel-body" id="dash-top"></div></div>
      <div class="panel"><div class="panel-head"><h2>Opening & closing soon</h2><small>next 7 days</small></div><div class="panel-body" id="dash-soon"></div></div>
      <div class="panel"><div class="panel-head"><h2>System status</h2></div><div class="panel-body" id="dash-system"></div></div>
    </div>`;

  paintChart(d);
  bindSegmented($(".panel-head .seg", body), (v) => { range = Number(v); paintChart(derive()); });
  $("#dash-donut", body).innerHTML = d.exams.length
    ? donut({ items: [
      { label: "Open", value: d.states.open, color: COLORS.teal }, { label: "Scheduled", value: d.states.scheduled, color: COLORS.amber },
      { label: "Closed", value: d.states.closed, color: COLORS.coral }, { label: "Draft", value: d.states.draft, color: COLORS.muted },
    ], centerValue: String(d.exams.length), centerLabel: "exams" })
    : emptyState({ icon: "fa-file-pen", title: "এখনো কোনো এক্সাম নেই", text: "প্রথম এক্সাম তৈরি করুন।" });
  paintResults(d); paintActivity(); paintTop(d); paintSoon(d); paintSystem(d);
}

function paintChart(d) {
  const el = $("#dash-chart", root);
  if (!el) return;
  if (!data.recent) { el.innerHTML = errorState({ title: "চার্ট লোড করা যায়নি", text: data.errs.recent?.message || "" , retry: false }); return; }
  const series = attemptSeries(d.rows, range);
  const total = series.reduce((s, p) => s + p.y, 0);
  el.innerHTML = total
    ? lineChart({ series: [{ name: "Attempts", color: COLORS.accent, data: series }], height: 210 })
    : emptyState({ icon: "fa-chart-line", title: "এই সময়ে কোনো অ্যাটেম্পট নেই", text: "শিক্ষার্থীরা এক্সাম দিলে এখানে ট্রেন্ড দেখা যাবে।" });
}

function paintResults(d) {
  const el = $("#dash-results", root);
  if (!data.recent) { el.innerHTML = errorState({ title: "লোড করা যায়নি", retry: false }); return; }
  const rows = d.rows.slice(0, 8);
  if (!rows.length) { el.innerHTML = emptyState({ icon: "fa-square-poll-vertical", title: "কোনো ফলাফল নেই", text: "গত ৩০ দিনে কেউ এক্সাম দেয়নি।" }); return; }
  el.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Student</th><th>Exam</th><th class="c-num">Score</th><th>Result</th><th>When</th></tr></thead><tbody>${rows.map((r) => {
    const u = data.users[r.uid];
    const name = u?.displayName || u?.email || (u?.missing ? "Deleted user" : "Student");
    const pass = (Number(r.percent) || 0) >= passPercentOf(d.byId[r.examId]);
    return `<tr><td data-label="Student"><div class="row" style="flex-wrap:nowrap;gap:10px">${avatar(name, 28)}<span class="clamp2">${esc(name)}</span></div></td>
      <td data-label="Exam"><span class="clamp2">${esc(r.examTitle || "—")}</span></td>
      <td data-label="Score" class="c-num">${fmtPct(r.percent)}</td>
      <td data-label="Result">${chip(pass ? "Pass" : "Fail", pass ? "teal" : "coral")}</td>
      <td data-label="When" class="muted">${ago(r.submittedAt)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function paintActivity() {
  const el = $("#dash-activity", root);
  if (!can("logs.view")) { el.innerHTML = `<p class="muted">এই অংশ দেখতে Activity Logs অনুমতি লাগবে।</p>`; return; }
  if (data.logsDenied) { el.innerHTML = errorState({ title: "Activity log rules প্রয়োজন", text: "firestore.rules Publish করার পর লগ দেখা যাবে।", retry: false }); return; }
  const rows = data.logs?.rows || [];
  if (!rows.length) { el.innerHTML = emptyState({ icon: "fa-clock-rotate-left", title: "এখনো কোনো অ্যাক্টিভিটি নেই", text: "এক্সাম, প্রশ্ন বা সেটিংস বদলালে এখানে জমা হবে।" }); return; }
  el.innerHTML = `<ul class="feed">${rows.map((l) => {
    const [label, icon, tone] = actionMeta(l.action);
    return `<li><span class="feed-ico ${tone}"><i class="fa-solid ${icon}"></i></span><div><div class="feed-t">${esc(label)}${l.label ? ` — <b>${esc(l.label)}</b>` : ""}</div><div class="feed-s">${esc(l.name || l.email || "Admin")} · ${ago(l.at)}</div></div></li>`;
  }).join("")}</ul>`;
}

function paintTop(d) {
  const el = $("#dash-top", root);
  if (!data.recent) { el.innerHTML = errorState({ title: "লোড করা যায়নি", retry: false }); return; }
  const tally = new Map();
  d.rows.forEach((r) => {
    const n = Array.isArray(r.attempts) && r.attempts.length ? r.attempts.length : 1;
    const cur = tally.get(r.examId) || { title: r.examTitle || d.byId[r.examId]?.title || "—", n: 0 };
    cur.n += n; tally.set(r.examId, cur);
  });
  const top = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  el.innerHTML = top.length ? hbars({ items: top.map((t) => ({ label: t.title, value: t.n })), format: fmtN }) : emptyState({ icon: "fa-ranking-star", title: "তথ্য নেই" });
}

function paintSoon(d) {
  const el = $("#dash-soon", root);
  const now = Date.now(), horizon = now + 7 * 86400000;
  const items = [];
  d.exams.forEach((e) => {
    if (isDraft(e) || e.examType === "practice") return;
    const open = toMs(e.publishAt), close = toMs(e.closesAt);
    if (open > now && open <= horizon) items.push({ at: open, kind: "Opens", tone: "amber", e });
    if (close > now && close <= horizon && open <= now) items.push({ at: close, kind: "Closes", tone: "coral", e });
  });
  items.sort((a, b) => a.at - b.at);
  el.innerHTML = items.length
    ? `<ul class="feed">${items.slice(0, 6).map((i) => `<li><span class="feed-ico ${i.tone}"><i class="fa-solid ${i.kind === "Opens" ? "fa-door-open" : "fa-stopwatch"}"></i></span><div><div class="feed-t">${esc(i.e.title)}</div><div class="feed-s">${i.kind} ${fmtDateTime(i.at)}</div></div></li>`).join("")}</ul>`
    : emptyState({ icon: "fa-calendar-check", title: "আগামী ৭ দিনে কিছু নেই" });
}

function paintSystem(d) {
  const el = $("#dash-system", root);
  const cat = data.catalog, set = getSettings(), meta = settingsMeta();
  const checks = [
    cat ? (cat.source === "index" ? ["teal", "Student exam index", "ঠিক আছে — শিক্ষার্থীরা ১টি রিডে লিস্ট পায়"] : ["amber", "Student exam index", "নেই — Exams → ⚡ Optimize চালান"]) : ["", "Student exam index", "যাচাই করা যায়নি"],
    cat ? (cat.statsReady ? ["teal", "Student summaries", "প্রস্তুত"] : ["amber", "Student summaries", "এখনো তৈরি হয়নি — ⚡ Optimize চালান"]) : ["", "Student summaries", "যাচাই করা যায়নি"],
    set.site.maintenance ? ["coral", "Maintenance mode", "চালু — শিক্ষার্থীরা এক্সাম দিতে পারছে না"] : ["teal", "Maintenance mode", "বন্ধ"],
    meta.source === "blocked" ? ["amber", "Admin settings", "Rules প্রকাশিত নয় — ডিফল্ট ব্যবহার হচ্ছে"] : ["teal", "Admin settings", meta.source === "saved" ? "সংরক্ষিত" : "ডিফল্ট"],
    data.counts?.disabledUsers ? ["amber", "Deactivated accounts", `${fmtN(data.counts.disabledUsers)}টি`] : ["teal", "Deactivated accounts", "নেই"],
  ];
  if (data.exams && d.states.draft) checks.push(["amber", "Draft exams", `${d.states.draft}টি এখনো প্রকাশ হয়নি`]);
  el.innerHTML = `<div class="checks">${checks.map(([tone, t, s]) => `<div class="check">${dotStatus("", tone)}<div>${esc(t)}<small>${esc(s)}</small></div></div>`).join("")}</div>`;
}
