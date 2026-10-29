// ==========================================================================
// admin/email/view-reminders.js — "Exam Reminders": pick an exam, see EXACTLY who has submitted, who started without submitting and
// who has no result — and what could not be verified — then prepare the matching reminder.
//
// Evidence used (nothing else): results/{uid}_{examId} = a submission · examSessions/{uid}_{examId} = a start.
// If either source cannot be read, the screen says so and the affected claim is never made.
// ==========================================================================
import { esc, chip, fmtN, createTable, emptyState, withBusy } from "../core/ui.js";
import { toast, confirmAction } from "../../utils.js";
import { CAMPAIGN_TYPES, EXAM_GROUPS, typeAllowed, NOT_SUBMITTED, fmtDateTimeShort, fmtMinutes } from "../../email-core.js";
import { toMs } from "../../schedule-core.js";
import { serverNow } from "../../server-time.js";
import { templateForType } from "../../email-templates-data.js";
import { S, on, emit } from "./state.js";
import { setExam, setType, setGroups, ensureExamData, examOptions, STATE_LABEL, useTemplate, applyPreset } from "./model.js";
import { groupChip, examStateChip, goTab, bindTabLinks, reasonText, keepFocus } from "./bits.js";

let host = null, table = null;
const f = { q: "", status: "" };

const KINDS = [
  { type: "exam_not_attempted", title: "Exam not attempted", text: "“এই এক্সামের কোনো জমা দেওয়া ফলাফল রেকর্ড নেই” — যাঁরা এখনো দেননি।", icon: "fa-user-clock" },
  { type: "exam_started_not_submitted", title: "Started, not submitted", text: "যাঁদের start-রেকর্ড আছে কিন্তু জমা দেওয়া ফলাফল নেই (start-tracking লাগে)।", icon: "fa-hourglass-half" },
  { type: "exam_upcoming", title: "Upcoming / current exam reminder", text: "সময়সূচিসহ রিমাইন্ডার — এক্সামে সত্যিকারের সময়সূচি থাকতে হবে।", icon: "fa-calendar-check" },
];

function examInfoLine(exam) {
  const tz = S.settings.timeZone;
  const bits = [];
  if (toMs(exam.publishAt) !== null) bits.push(`শুরু ${fmtDateTimeShort(toMs(exam.publishAt), tz, "en")}`);
  if (toMs(exam.closesAt) !== null) bits.push(`শুরুর শেষ সীমা ${fmtDateTimeShort(toMs(exam.closesAt), tz, "en")}`);
  const dur = fmtMinutes(exam.duration, "en"); if (dur) bits.push(dur);
  if (exam.courseId) bits.push(`কোর্স: ${S.courseTitle.get(exam.courseId) || exam.courseName || exam.courseId}`); // (escaped once, by the caller)
  else bits.push("সব শিক্ষার্থীর জন্য (কোর্স-নির্দিষ্ট নয়)");
  if (!bits.some((b) => b.startsWith("শুরু"))) bits.push("কোনো সময়সূচি সেট নেই");
  return bits.join(" · ");
}

function verifyHtml() {
  const D = S.derived;
  const exam = D.exam;
  if (!exam) return "";
  const ed = S.examData.get(exam.id);
  if (!ed || ed.status !== "ready") return `<div class="em-verify"><span class="spinner sm"></span> ফলাফল ও start-তথ্য লোড হচ্ছে…</div>`;
  const li = (tone, icon, text) => `<li class="${tone}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${text}</span></li>`;
  const res = ed.resultsByUid
    ? li("ok", "fa-circle-check", `<b>Results:</b> এই এক্সামের ${fmtN(ed.resultsByUid.size)}টি জমা-রেকর্ড পড়া হয়েছে। (অন্য এক্সামের ফলাফল এখানে গণনা হয় না।)`)
    : li("bad", "fa-circle-xmark", `<b>Results পড়া যায়নি</b> — Firestore permission বা নেটওয়ার্ক। কে জমা দিয়েছেন তা যাচাই করা যায়নি, তাই কাউকে “দেননি” বলা হবে না।`);
  const ses = ed.sessionsByUid
    ? li("ok", "fa-circle-check", `<b>Start tracking:</b> ${fmtN(ed.sessionsByUid.size)} জনের start-রেকর্ড আছে।`)
    : li("warn", "fa-circle-question", `<b>Start tracking (examSessions) পড়া যায়নি</b> — rules Publish করা নেই বা অনুমতি নেই। কে শুরু করেছিলেন তা যাচাই করা যায়নি; ফলাফল-নেই এমন সবাই “No result (start unverified)” হিসেবে দেখানো হবে — “কখনো শুরু করেননি” বলা হবে না।`);
  return `<div class="em-verify"><ul class="em-checklist">${res}${ses}</ul>
    <p class="form-hint">লোড হয়েছে ${esc(new Date(ed.loadedAt).toLocaleTimeString())}। Start-রেকর্ড শুধু examSessions rules চালু হওয়ার পরের শুরুগুলোর জন্য থাকে — তাই “start-রেকর্ড নেই” মানে “কখনো খোলেননি” — এমন প্রমাণ নয়; ইমেইলে সেটা দাবি করাও হয় না।
    <button type="button" class="link-btn" data-act="recheck"><i class="fa-solid fa-arrow-rotate-right"></i> এখনই আবার যাচাই করুন</button></p></div>`;
}

function groupsHtml() {
  const D = S.derived;
  if (!D.exam || !D.counts) return "";
  const c = D.counts;
  const shown = [];
  if (D.resultsOk === false) shown.push(["unverified", c.unverified]);
  else {
    shown.push(D.sessionsOk ? ["not_attempted", c.not_attempted] : ["no_result_unverified", c.no_result_unverified]);
    if (D.sessionsOk) shown.push(["started_no_submission", c.started_no_submission]);
    shown.push(["submitted", c.submitted]);
  }
  shown.push(["excluded", c.excluded]);
  const picked = new Set(S.draft.groups);
  return `<div class="em-groups">${shown.map(([g, n]) => {
    const m = EXAM_GROUPS[g];
    const selectable = NOT_SUBMITTED.includes(g) && g !== "unverified";
    return `<div class="em-group ${m.tone}${picked.has(g) && selectable ? " on" : ""}">
      <div class="em-group-n">${fmtN(n)}</div><div class="em-group-l"><b>${esc(m.label)}</b><small>${esc(m.desc)}</small></div>
      ${selectable ? `<label class="em-check"><input type="checkbox" data-group="${g}" ${picked.has(g) ? "checked" : ""}> Include in this campaign</label>` : ""}</div>`;
  }).join("")}</div>
  <p class="em-sum"><b>${fmtN(D.sendable.length)}</b> students will receive the email${D.skipped.length ? ` · <span class="em-warn">${fmtN(D.skipped.length)} skipped</span>` : ""}. <button type="button" class="link-btn" data-go-tab="recipients">Review / change recipients →</button></p>`;
}

function kindsHtml() {
  const D = S.derived;
  if (!D.exam || !D.counts) return "";
  const now = serverNow();
  const c = D.counts;
  const count = { exam_not_attempted: D.resultsOk === false ? "?" : D.sessionsOk ? c.not_attempted + c.no_result_unverified : c.no_result_unverified,
    exam_started_not_submitted: D.sessionsOk && D.resultsOk !== false ? c.started_no_submission : "—", exam_upcoming: D.resultsOk === false ? "?" : c.notSubmitted };
  return `<div class="em-kinds" role="radiogroup" aria-label="Which reminder to prepare">${KINDS.map((k) => {
    const ok = typeAllowed(k.type, D.exam, now);
    const needSess = k.type === "exam_started_not_submitted" && D.sessionsOk === false;
    const blocked = !ok.ok || needSess || D.resultsOk === false;
    const why = !ok.ok ? ok.reason : needSess ? "Start-tracking পড়া যায়নি — এই তালিকা যাচাই করা যায় না।" : D.resultsOk === false ? "ফলাফল পড়া যায়নি।" : "";
    const on_ = S.draft.type === k.type && !blocked;
    return `<label class="em-kind${on_ ? " on" : ""}${blocked ? " off" : ""}"><input type="radio" name="rm-kind" value="${k.type}" ${on_ ? "checked" : ""} ${blocked ? "disabled" : ""}>
      <i class="fa-solid ${k.icon}" aria-hidden="true"></i><span><b>${esc(k.title)}</b><small>${esc(k.text)}</small>${why ? `<small class="em-bad">${esc(why)}</small>` : `<small class="em-n">${typeof count[k.type] === "number" ? `${fmtN(count[k.type])} ${count[k.type] === 1 ? "student" : "students"}` : ""}</small>`}</span></label>`;
  }).join("")}</div>
  <div class="em-step-actions"><button type="button" class="btn btn-primary" data-act="continue" ${CAMPAIGN_TYPES[S.draft.type].needsExam && typeAllowed(S.draft.type, D.exam, now).ok ? "" : "disabled"}><i class="fa-solid fa-pen-to-square"></i> Continue to Compose</button></div>`;
}

function tableRows() {
  const D = S.derived;
  const q = f.q.trim().toLowerCase();
  return S.students.filter((s) => {
    const row = D.clsByUid.get(s.uid);
    if (!row) return false;
    if (f.status && row.status !== f.status) return false;
    return !q || `${s.name} ${s.email} ${s.roll}`.toLowerCase().includes(q);
  }).map((s) => ({ id: s.uid, s, c: D.clsByUid.get(s.uid) }));
}

function paintTable() {
  if (!table) return;
  const D = S.derived;
  if (!D.exam) { table.setState(emptyState({ icon: "fa-file-pen", title: "একটি এক্সাম বাছুন", text: "এক্সাম বাছলে প্রতিটি শিক্ষার্থীর অবস্থা এখানে দেখা যাবে।" })); return; }
  if (D.examLoading || !D.cls) { table.setState(`<div class="state"><span class="spinner"></span></div>`); return; }
  table.setRows(tableRows(), { keepPage: true });
}

function paint(el) { keepFocus(el, () => paintNow(el)); }
function paintNow(el) {
  const D = S.derived;
  const hasExam = !!D.exam;
  el.querySelector("#rm-info").innerHTML = hasExam ? `${examStateChip(D.examState?.key)} <small>${esc(examInfoLine(D.exam))}</small>${D.examState && !D.examState.remind && D.examState.reason ? `<div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(D.examState.reason)}</div>` : ""}` : `<small class="muted">নিচের তালিকা থেকে একটি এক্সাম বাছুন।</small>`;
  el.querySelector("#rm-verify").innerHTML = verifyHtml();
  el.querySelector("#rm-groups-wrap").hidden = !hasExam || !D.counts;
  el.querySelector("#rm-groups").innerHTML = groupsHtml();
  el.querySelector("#rm-kinds-wrap").hidden = !hasExam || !D.counts;
  el.querySelector("#rm-kinds").innerHTML = kindsHtml();
  const sel = el.querySelector("#rm-status");
  const have = ["", ...new Set([...D.clsByUid.values()].map((r) => r.status))];
  sel.innerHTML = have.map((g) => `<option value="${g}" ${f.status === g ? "selected" : ""}>${g ? esc(EXAM_GROUPS[g]?.label || g) : "All statuses"}</option>`).join("");
  paintTable();
}

export const reminders = {
  mount(el) {
    host = el;
    const opts = examOptions();
    el.innerHTML = `
      <div class="panel"><div class="panel-head"><div><h2>1 · Choose the exam</h2><small>এক্সামের তালিকা Firestore-এর আসল এক্সাম থেকে</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-act="recheck" title="ফলাফল ও start-তথ্য আবার পড়ুন"><i class="fa-solid fa-arrow-rotate-right"></i> Re-check</button></div></div>
        <div class="panel-body">
          ${opts.length ? `<div class="field"><label for="rm-exam">Exam</label><select id="rm-exam"><option value="">— একটি এক্সাম বাছুন —</option>
            ${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === S.draft.examId ? "selected" : ""}>${esc(o.title)} — ${esc(STATE_LABEL[o.state] || o.state)}</option>`).join("")}</select></div>`
            : emptyState({ icon: "fa-file-pen", title: "কোনো এক্সাম নেই", text: "আগে Exams পেজে এক্সাম তৈরি করুন।" })}
          <div id="rm-info" class="em-examinfo"></div><div id="rm-verify"></div></div></div>
      <div class="panel" id="rm-groups-wrap" hidden><div class="panel-head"><div><h2>2 · Where does every student stand?</h2><small>ফলাফল ও start-রেকর্ড থেকে — অনুমান নয়</small></div></div><div class="panel-body" id="rm-groups"></div></div>
      <div class="panel" id="rm-kinds-wrap" hidden><div class="panel-head"><div><h2>3 · What do you want to send?</h2></div></div><div class="panel-body" id="rm-kinds"></div></div>
      <div class="panel"><div class="panel-head"><div><h2>Students for this exam</h2></div></div>
        <div class="panel-body"><div class="toolbar"><div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="rm-q" placeholder="Name, email or roll…" aria-label="Search students" autocomplete="off"></div>
          <select id="rm-status" aria-label="Filter by status"></select></div><div id="rm-table"></div></div></div>`;
    table = createTable({
      mount: el.querySelector("#rm-table"), pageSize: 10, defaultSort: { key: "status", dir: "asc" },
      empty: { icon: "fa-users", title: "কোনো শিক্ষার্থী নেই", text: "ফিল্টার বদলে দেখুন।" },
      columns: [
        { key: "name", label: "Student", sortable: true, sortValue: (r) => (r.s.name || r.s.email).toLowerCase(), render: (r) => `<div class="cell-main"><div class="t">${esc(r.s.name || "নাম নেই")}</div><div class="s">${esc(r.s.email || "—")}</div></div>` },
        { key: "roll", label: "Roll", sortable: true, sortValue: (r) => r.s.roll, render: (r) => esc(r.s.roll || "—") },
        { key: "status", label: "Status", sortable: true, sortValue: (r) => r.c.status, render: (r) => `${groupChip(r.c.status)}${r.c.status === "excluded" ? `<div class="s">${esc(reasonText(r.c.reason))}</div>` : ""}` },
        { key: "att", label: "Submitted", sortable: true, sortValue: (r) => r.c.attempts, render: (r) => (r.c.status === "unverified" ? "?" : fmtN(r.c.attempts)) },
        { key: "starts", label: "Starts", sortable: true, sortValue: (r) => r.c.starts, render: (r) => (S.derived.sessionsOk ? fmtN(r.c.starts) : '<span class="muted" title="Start-tracking পড়া যায়নি">?</span>') },
        { key: "mail", label: "Email", render: (r) => (r.c.emailable ? chip("valid", "teal") : chip("invalid / missing", "coral")) },
      ],
    });
    bindTabLinks(el);
    el.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.id === "rm-exam") { await withBusy(null, () => setExam(t.value)); paint(el); return; }
      if (t.id === "rm-status") { f.status = t.value; paintTable(); return; }
      if (t.name === "rm-kind") {
        const type = t.value;
        await setType(type);
        const tpl = templateForType(type);
        if (!S.draft.touched || await confirmAction(`এই রিমাইন্ডারের জন্য “${tpl.name}” টেমপ্লেট বসাবেন? Compose-এর এখনকার লেখা বদলে যাবে।`, { title: "টেমপ্লেট বসাবেন?", confirmLabel: "হ্যাঁ, বসান" })) { useTemplate(tpl.id); emit("draft-replaced"); }
        paint(el); return;
      }
      if (t.dataset.group) {
        const set = new Set(S.draft.groups);
        if (t.checked) set.add(t.dataset.group); else set.delete(t.dataset.group);
        await setGroups([...set]); paint(el);
      }
    });
    el.addEventListener("input", (e) => { if (e.target.id === "rm-q") { f.q = e.target.value; paintTable(); } });
    el.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-act]")?.dataset.act;
      if (a === "recheck" && S.draft.examId) { const b = e.target.closest("button"); await withBusy(b, () => ensureExamData(S.draft.examId, { force: true })); await applyPreset(S.draft.mode === "exam" ? "exam" : "manual"); paint(el); toast("আবার যাচাই করা হয়েছে", "success"); }
      else if (a === "recheck") toast("আগে একটি এক্সাম বাছুন", "info");
      else if (a === "continue") goTab("compose");
    });
    on("examdata", () => { if (S.tab === "reminders") paint(el); });
    on("change", () => { if (S.tab === "reminders") paint(el); });
    on("selection", () => { if (S.tab === "reminders") paint(el); });
    paint(el);
  },
  refresh(el) { paint(el); },
};
