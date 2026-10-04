// ==========================================================================
// admin/analytics.js — participation, growth, success and difficulty at a glance.
// Built from the SAME cached downloads the Results/Students pages use (results, users, exams) —
// opening Analytics after those costs no extra reads. Pure SVG/CSS charts (core/charts.js).
// Each saved attempt counts as one event, so history is real attempts, not just the latest per student.
// ==========================================================================
import { downloadCsv, toast } from "../utils.js";
import { fetchAllResultsAdmin, fetchAllUsersAdmin, fetchAllExamsAdmin, countAttempts } from "../exam-data.js";
import {
  esc, $, fmtN, fmtPct, pageHead, kpi, chip, segmented, bindSegmented, emptyState, errorState, skeleton, toDate, toMs, dayKey,
} from "./core/ui.js";
import { lineChart, columns, hbars, donut, COLORS } from "./core/charts.js";
import { passPercentOf } from "./core/exam-status.js";
import { can } from "./core/permissions.js";
import { onChange } from "./core/bus.js";

let root, range = "30", src = null, stale = false;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({ title: "Analytics", desc: "অংশগ্রহণ, ব্যবহারকারী বৃদ্ধি, সফলতার হার ও কঠিন প্রশ্ন — চার্টে।",
      actions: `${segmented([{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }, { id: "365", label: "12 months" }], range)}
        <button type="button" class="btn btn-outline btn-sm" id="an-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${can("results.export") ? `<button type="button" class="btn btn-outline btn-sm" id="an-export"><i class="fa-solid fa-download"></i> CSV</button>` : ""}` })}
    <div class="stack" id="an-body">${skeleton(5)}</div>`;
  bindSegmented($(".seg", root), (v) => { range = v; if (src) render(); });
  $("#an-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#an-export", root)?.addEventListener("click", exportCsv);
  root.addEventListener("click", (e) => { if (e.target.closest("[data-retry]")) load({ force: true }); });
  onChange((kind) => { if (["results", "users", "exams"].includes(kind)) stale = true; });
  await load();
}

export function activate() { if (stale) load(); }

async function load(opts) {
  if (!src) $("#an-body", root).innerHTML = skeleton(5);
  try {
    const [results, users, exams] = await Promise.all([fetchAllResultsAdmin(opts), fetchAllUsersAdmin(opts), fetchAllExamsAdmin(opts).catch(() => [])]);
    stale = false;
    const examsById = Object.fromEntries(exams.map((e) => [e.id, e]));
    const events = [];
    const missed = new Map(); // examId::text → { examId, title, text, n }
    const reviewed = new Map(); // examId → attempts whose review is still stored
    results.forEach((r) => {
      const list = Array.isArray(r.attempts) && r.attempts.length ? r.attempts : [r];
      list.forEach((a) => {
        const at = toDate(a.submittedAt || r.submittedAt);
        if (!at) return;
        events.push({ uid: r.uid, examId: r.examId, title: r.examTitle || examsById[r.examId]?.title || "—", at, ms: at.getTime(), percent: Number(a.percent) || 0, pass: (Number(a.percent) || 0) >= passPercentOf(examsById[r.examId]), type: r.examType });
        if (Array.isArray(a.review)) {
          reviewed.set(r.examId, (reviewed.get(r.examId) || 0) + 1);
          a.review.forEach((q) => {
            const key = `${r.examId}::${q.text}`;
            const cur = missed.get(key) || { examId: r.examId, title: r.examTitle || "—", text: q.text, n: 0, blank: 0 };
            cur.n++; if (q.selected === null || q.selected === undefined) cur.blank++;
            missed.set(key, cur);
          });
        }
      });
    });
    src = { events, users, examsById, missed, reviewed, resultDocs: results.length, attempts: results.reduce((s, r) => s + countAttempts(r), 0) };
    render();
  } catch (err) { $("#an-body", root).innerHTML = errorState({ title: "অ্যানালিটিক্স লোড করা যায়নি", text: err?.message || "" }); }
}

/* ---------- Buckets: day (7/30d) · week (90d) · month (12m) ---------- */
function buckets() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const keys = [], labels = {};
  let keyOf, unit;
  if (range === "365") {
    unit = "month";
    keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    for (let i = 11; i >= 0; i--) { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); const k = keyOf(d); keys.push(k); labels[k] = `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || i === 11 ? ` '${String(d.getFullYear()).slice(2)}` : ""}`; }
  } else if (range === "90") {
    unit = "week";
    const monday = (d) => { const x = new Date(d); const diff = (x.getDay() + 6) % 7; x.setDate(x.getDate() - diff); x.setHours(0, 0, 0, 0); return x; };
    keyOf = (d) => dayKey(monday(d));
    for (let i = 12; i >= 0; i--) { const d = monday(today); d.setDate(d.getDate() - i * 7); const k = dayKey(d); keys.push(k); labels[k] = `${d.getDate()}/${d.getMonth() + 1}`; }
  } else {
    unit = "day";
    const n = Number(range);
    keyOf = (d) => dayKey(d);
    for (let i = n - 1; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const k = dayKey(d); keys.push(k); labels[k] = `${d.getDate()}/${d.getMonth() + 1}`; }
  }
  const startKey = keys[0];
  return { keys, labels, keyOf, unit, startKey, inRange: (d) => keyOf(d) >= startKey && d.getTime() <= now.getTime() + 86400000 };
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function compute() {
  const b = buckets();
  const ev = src.events.filter((e) => b.inRange(e.at));
  const per = Object.fromEntries(b.keys.map((k) => [k, { attempts: 0, students: new Set(), pcts: [], pass: 0, newUsers: 0 }]));
  ev.forEach((e) => { const p = per[b.keyOf(e.at)]; if (!p) return; p.attempts++; p.students.add(e.uid); p.pcts.push(e.percent); if (e.pass) p.pass++; });

  let noDate = 0, before = 0;
  src.users.forEach((u) => {
    const d = toDate(u.createdAt);
    if (!d) { noDate++; return; }
    const k = b.keyOf(d);
    if (per[k]) per[k].newUsers++; else if (k < b.startKey) before++;
  });
  let running = before;
  b.keys.forEach((k) => { running += per[k].newUsers; per[k].totalUsers = running; });

  const byExam = new Map();
  ev.forEach((e) => {
    const cur = byExam.get(e.examId) || { title: e.title, n: 0, pcts: [], pass: 0 };
    cur.n++; cur.pcts.push(e.percent); if (e.pass) cur.pass++; byExam.set(e.examId, cur);
  });
  const exams = [...byExam.entries()].map(([id, x]) => ({ id, title: x.title, n: x.n, avg: avg(x.pcts), passRate: (x.pass / x.n) * 100 }));

  const bins = Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}`, value: 0, tone: "" }));
  ev.forEach((e) => { bins[Math.min(9, Math.floor(e.percent / 10))].value++; });
  const byWeekday = WEEKDAYS.map((l) => ({ label: l, value: 0 }));
  const byHour = ["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24"].map((l) => ({ label: l, value: 0 }));
  ev.forEach((e) => { byWeekday[e.at.getDay()].value++; byHour[Math.floor(e.at.getHours() / 3)].value++; });

  const missed = [...src.missed.values()].map((m) => ({ ...m, base: src.reviewed.get(m.examId) || 0 })).filter((m) => m.n >= 2).sort((a, b2) => b2.n - a.n).slice(0, 8);
  const students = src.users.filter((u) => !u.isAdmin).length;
  const active = new Set(ev.map((e) => e.uid));
  return { b, ev, per, exams, bins, byWeekday, byHour, missed, noDate, students, active, pass: ev.filter((e) => e.pass).length };
}

function render() {
  const d = compute();
  const body = $("#an-body", root);
  const n = d.ev.length;
  const unitName = { day: "day", week: "week", month: "month" }[d.b.unit];
  const attemptsSeries = d.b.keys.map((k) => ({ x: d.b.labels[k], y: d.per[k].attempts }));
  const studentSeries = d.b.keys.map((k) => ({ x: d.b.labels[k], y: d.per[k].students.size }));
  const growthSeries = d.b.keys.map((k) => ({ x: d.b.labels[k], y: d.per[k].totalUsers }));
  const newUsers = d.b.keys.reduce((s, k) => s + d.per[k].newUsers, 0);
  const top = d.exams.slice().sort((a, c) => c.n - a.n).slice(0, 6);
  const hard = d.exams.filter((x) => x.n >= 3).sort((a, c) => a.avg - c.avg).slice(0, 6);

  if (!src.events.length && !src.users.length) { body.innerHTML = emptyState({ icon: "fa-chart-line", title: "এখনো কোনো ডেটা নেই", text: "শিক্ষার্থীরা এক্সাম দেওয়া শুরু করলে এখানে চার্ট দেখা যাবে।" }); return; }

  body.innerHTML = `
    <div class="kpis">
      ${kpi({ label: "Attempts", value: fmtN(n), sub: `in this range`, tone: "accent" })}
      ${kpi({ label: "Active students", value: fmtN(d.active.size), sub: d.students ? `${fmtPct((d.active.size / d.students) * 100)} of ${fmtN(d.students)} students` : "", tone: "teal" })}
      ${kpi({ label: "Average score", value: n ? fmtPct(avg(d.ev.map((e) => e.percent))) : "—" })}
      ${kpi({ label: "Pass rate", value: n ? fmtPct((d.pass / n) * 100) : "—", tone: n && d.pass / n < 0.5 ? "coral" : "teal" })}
      ${kpi({ label: "New users", value: fmtN(newUsers), sub: d.noDate ? `${fmtN(d.noDate)} users have no signup date` : "signed up in range" })}
      ${kpi({ label: "All-time attempts", value: fmtN(src.attempts), sub: `${fmtN(src.resultDocs)} results` })}
    </div>

    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h2>Exam participation</h2><small>attempts and unique students per ${unitName}</small></div></div>
        <div class="panel-body">${n ? lineChart({ series: [{ name: "Attempts", color: COLORS.accent, data: attemptsSeries }, { name: "Students", color: COLORS.teal, data: studentSeries }], height: 220 }) : emptyState({ icon: "fa-chart-line", title: "এই সময়ে কোনো অ্যাটেম্পট নেই" })}</div></div>
      <div class="panel"><div class="panel-head"><div><h2>User growth</h2><small>total registered users</small></div></div>
        <div class="panel-body">${src.users.length ? lineChart({ series: [{ name: "Total users", color: COLORS.amber, data: growthSeries }], height: 220 }) : emptyState({ icon: "fa-users", title: "কোনো ব্যবহারকারী নেই" })}</div></div>
    </div>

    <div class="grid-3">
      <div class="panel"><div class="panel-head"><h2>Pass / fail</h2></div><div class="panel-body">${n ? donut({ items: [{ label: "Pass", value: d.pass, color: COLORS.teal }, { label: "Fail", value: n - d.pass, color: COLORS.coral }], centerValue: fmtPct((d.pass / n) * 100), centerLabel: "pass rate" }) : emptyState({ icon: "fa-circle-check", title: "তথ্য নেই" })}</div></div>
      <div class="panel span-2"><div class="panel-head"><div><h2>Score distribution</h2><small>attempts by score band (%)</small></div></div><div class="panel-body">${n ? columns({ bins: d.bins.map((x, i) => ({ ...x, tone: "" , label: `${i * 10}` })), height: 130 }) : emptyState({ icon: "fa-chart-simple", title: "তথ্য নেই" })}</div></div>
    </div>

    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Most attempted exams</h2></div><div class="panel-body">${top.length ? hbars({ items: top.map((x) => ({ label: x.title, value: x.n, sub: `avg ${fmtPct(x.avg)}` })), format: fmtN }) : emptyState({ icon: "fa-ranking-star", title: "তথ্য নেই" })}</div></div>
      <div class="panel"><div class="panel-head"><div><h2>Hardest exams</h2><small>lowest average score · at least 3 attempts</small></div></div><div class="panel-body">${hard.length ? hbars({ items: hard.map((x) => ({ label: x.title, value: x.avg, sub: `${x.n} attempts · pass ${fmtPct(x.passRate)}`, tone: x.avg < 50 ? "coral" : "amber" })), max: 100, format: (v) => fmtPct(v) }) : emptyState({ icon: "fa-gauge-high", title: "যথেষ্ট তথ্য নেই", text: "প্রতিটি এক্সামে অন্তত ৩টি অ্যাটেম্পট লাগবে।" })}</div></div>
    </div>

    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Activity by weekday</h2></div><div class="panel-body">${n ? columns({ bins: d.byWeekday, height: 110 }) : emptyState({ icon: "fa-calendar-week", title: "তথ্য নেই" })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Activity by time of day</h2></div><div class="panel-body">${n ? columns({ bins: d.byHour, height: 110 }) : emptyState({ icon: "fa-clock", title: "তথ্য নেই" })}</div></div>
    </div>

    <div class="panel"><div class="panel-head"><div><h2>Most difficult questions</h2><small>সবচেয়ে বেশি ভুল হওয়া প্রশ্ন — শুধু যেসব অ্যাটেম্পটের রিভিউ এখনো সংরক্ষিত (রিভিউ ৪৮ ঘণ্টা পর মুছে যায়), তাই এটি সাম্প্রতিক অবস্থার ছবি</small></div></div>
      <div class="panel-body flush">${d.missed.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Question</th><th>Exam</th><th class="c-num">Missed</th><th class="c-num">Of attempts</th><th class="c-num">Left blank</th></tr></thead><tbody>${d.missed.map((m) => `<tr>
        <td data-label="Question"><span class="clamp2">${esc(m.text)}</span></td><td data-label="Exam"><span class="clamp2">${esc(m.title)}</span></td>
        <td data-label="Missed" class="c-num"><b>${fmtN(m.n)}</b></td><td data-label="Of attempts" class="c-num">${m.base ? fmtPct((m.n / m.base) * 100) : "—"}</td><td data-label="Left blank" class="c-num">${fmtN(m.blank)}</td></tr>`).join("")}</tbody></table></div>`
        : emptyState({ icon: "fa-circle-question", title: "যথেষ্ট ডেটা নেই", text: "একই প্রশ্নে অন্তত ২ জন ভুল করলে এখানে দেখা যাবে।" })}</div></div>

    <div class="panel"><div class="panel-head"><div><h2>${unitName === "day" ? "Daily" : unitName === "week" ? "Weekly" : "Monthly"} statistics</h2></div></div>
      <div class="panel-body flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>${unitName === "day" ? "Day" : unitName === "week" ? "Week of" : "Month"}</th><th class="c-num">Attempts</th><th class="c-num">Students</th><th class="c-num">Avg score</th><th class="c-num">Pass rate</th><th class="c-num">New users</th></tr></thead><tbody>${d.b.keys.slice().reverse().slice(0, 14).map((k) => {
        const p = d.per[k];
        return `<tr><td data-label="Period">${esc(d.b.labels[k])}</td><td data-label="Attempts" class="c-num">${fmtN(p.attempts)}</td><td data-label="Students" class="c-num">${fmtN(p.students.size)}</td>
          <td data-label="Avg score" class="c-num">${p.attempts ? fmtPct(avg(p.pcts)) : "—"}</td><td data-label="Pass rate" class="c-num">${p.attempts ? fmtPct((p.pass / p.attempts) * 100) : "—"}</td><td data-label="New users" class="c-num">${fmtN(p.newUsers)}</td></tr>`;
      }).join("")}</tbody></table></div></div></div>`;
}

function exportCsv() {
  if (!src) return;
  const d = compute();
  const data = [[d.b.unit === "day" ? "Day" : d.b.unit === "week" ? "Week of" : "Month", "Attempts", "Students", "Avg score %", "Pass rate %", "New users"]];
  d.b.keys.forEach((k) => { const p = d.per[k]; data.push([d.b.labels[k], p.attempts, p.students.size, p.attempts ? Math.round(avg(p.pcts)) : "", p.attempts ? Math.round((p.pass / p.attempts) * 100) : "", p.newUsers]); });
  downloadCsv(`analytics-${range}d-${new Date().toISOString().slice(0, 10)}.csv`, data);
  toast("CSV ডাউনলোড হয়েছে", "success");
}
