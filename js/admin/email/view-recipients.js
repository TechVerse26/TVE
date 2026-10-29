// ==========================================================================
// admin/email/view-recipients.js — "Student Recipients": WHO gets the e-mail.
//
// The model is deliberately plain: what is ticked here is exactly who is sent to. The quick-select buttons (everyone eligible,
// by course, by exam status) only TICK boxes for you; you can then untick anybody. The ticks survive filtering and searching,
// and "Select all in this filtered list" is a different button from "Select everyone eligible in the database".
// Students who can never receive this campaign (admin, deactivated, not in the exam's course, no valid address) cannot be ticked.
// ==========================================================================
import { esc, chip, fmtN, createTable, debounce } from "../core/ui.js";
import { confirmAction, toast } from "../../utils.js";
import { CAMPAIGN_TYPES, EXAM_GROUPS, examEligibility, isValidEmail, NOT_SUBMITTED } from "../../email-core.js";
import { S, on } from "./state.js";
import { applyPreset, toggleUid, selectMany, setCourses, setExam, setGroups, examOptions, STATE_LABEL, isExamType } from "./model.js";
import { groupChip, bindTabLinks, reasonText, keepFocus, setHtml } from "./bits.js";
import { describeAudience } from "./send.js";

let host = null, table = null;

/** One row of the table = a student + why they can (not) be e-mailed for THIS campaign + their exam status. */
function decorate(s) {
  const D = S.derived;
  const enforce = isExamType(S.draft.type);
  let reason = examEligibility(s, enforce ? D.exam : null).reason;
  if (!reason && !isValidEmail(s.email)) reason = "invalid_email";
  const c = D.clsByUid.get(s.uid) || null;
  if (!reason && enforce && c?.status === "submitted") reason = "already_submitted";
  return { id: s.uid, s, ok: !reason, reason, c };
}

function matches(r, f) {
  const s = r.s;
  if (f.q) { const q = f.q.toLowerCase(); if (!`${s.name} ${s.email} ${s.roll}`.toLowerCase().includes(q)) return false; }
  if (f.course && !s.courseIds.includes(f.course)) return false;
  if (f.account === "eligible" && !r.ok) return false;
  if (f.account === "deactivated" && !s.disabled) return false;
  if (f.account === "admin" && !s.isAdmin) return false;
  if (f.account === "blocked" && r.ok) return false;
  if (f.status && (r.c?.status || "none") !== f.status) return false;
  if (f.roll === "has" && !s.roll) return false;
  if (f.roll === "none" && s.roll) return false;
  if (f.roll && !["has", "none"].includes(f.roll) && !s.roll.toLowerCase().includes(f.roll.toLowerCase())) return false;
  if (f.picked === "yes" && !S.draft.selected.has(s.uid)) return false;
  if (f.picked === "no" && S.draft.selected.has(s.uid)) return false;
  return true;
}
const filtered = () => S.students.map(decorate).filter((r) => matches(r, S.filters));

function paintTable() { table?.setRows(filtered(), { keepPage: true }); }

/** The live text at the top (what will happen). The buttons below it are static and only change label / disabled state. */
function summaryHtml() {
  const D = S.derived;
  const reasons = {};
  D.skipped.forEach((s) => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
  return `<div class="em-sumbar" role="status" aria-live="polite">
      <div class="em-sumbar-main"><b class="em-big">${fmtN(D.sendable.length)}</b> will receive the email
        <small>${fmtN(S.draft.selected.size)} ticked${D.skipped.length ? ` · <span class="em-warn">${fmtN(D.skipped.length)} cannot be sent (${Object.entries(reasons).map(([k, n]) => `${n} × ${esc(reasonText(k))}`).join(" · ")})</span>` : ""}</small></div>
      <div class="em-sumbar-sub"><small>${esc(describeAudience())}</small></div></div>`;
}
const selbarShell = () => `<div class="em-selbar">
    <div class="em-selgroup"><span class="em-selgroup-l">This filtered list <b id="rc-fl-info"></b></span>
      <button type="button" class="btn btn-outline btn-sm" data-act="sel-filtered"><i class="fa-solid fa-square-check"></i> <span id="rc-sel-l"></span></button>
      <button type="button" class="btn btn-outline btn-sm" data-act="unsel-filtered"><i class="fa-regular fa-square"></i> Untick these</button></div>
    <div class="em-selgroup"><span class="em-selgroup-l">Whole database (ignores the filters)</span>
      <button type="button" class="btn btn-outline btn-sm" data-act="sel-all"><i class="fa-solid fa-users"></i> Select every eligible student</button>
      <button type="button" class="btn btn-outline btn-sm" data-act="clear"><i class="fa-solid fa-eraser"></i> Clear all ticks</button></div></div>`;
function paintSelbar(el) {
  const rows = filtered();
  const tickable = rows.filter((r) => r.ok);
  const nSel = rows.filter((r) => S.draft.selected.has(r.id)).length;
  setHtml(el.querySelector("#rc-fl-info"), `(${fmtN(rows.length)} students · ${fmtN(tickable.length)} can be selected · ${fmtN(nSel)} ticked)`);
  const label = `Select all ${fmtN(tickable.length)} in this list`;
  const l = el.querySelector("#rc-sel-l"); if (l.textContent !== label) l.textContent = label;
  el.querySelector('[data-act="sel-filtered"]').disabled = !tickable.length;
  el.querySelector('[data-act="unsel-filtered"]').disabled = !nSel;
  el.querySelector('[data-act="clear"]').disabled = !S.draft.selected.size;
}

function skippedHtml() {
  const D = S.derived;
  if (!D.skipped.length) return "";
  return `<details class="em-skipped"><summary>${fmtN(D.skipped.length)} ticked students will NOT receive it — see why</summary>
    <ul>${D.skipped.slice(0, 200).map((s) => `<li><b>${esc(s.student?.name || s.student?.email || s.uid)}</b> <small>${esc(s.student?.email || "")}</small> — ${esc(reasonText(s.reason))}</li>`).join("")}</ul>${D.skipped.length > 200 ? `<small>(প্রথম ২০০ জন)</small>` : ""}</details>`;
}

function presetsHtml() {
  const t = CAMPAIGN_TYPES[S.draft.type];
  const opts = examOptions();
  return `<details class="em-presets" ${S.draft.selected.size ? "" : "open"}><summary><i class="fa-solid fa-wand-magic-sparkles"></i> Quick select <small>(শুধু টিক বসায় — পরে যাকে খুশি বাদ দিতে পারেন)</small></summary>
    <div class="em-preset-grid">
      <div class="em-preset"><h3>By course</h3><div class="em-checks">${S.courses.length ? S.courses.map((c) => `<label class="em-check"><input type="checkbox" data-course="${esc(c.id)}" ${S.draft.courseIds.includes(c.id) ? "checked" : ""}> ${esc(c.title)}</label>`).join("") : '<small class="muted">কোনো কোর্স নেই</small>'}</div>
        <small>টিক দিলে ওই কোর্সের যোগ্য শিক্ষার্থীরা সিলেক্ট হয়।</small></div>
      <div class="em-preset"><h3>By exam</h3>
        <div class="field"><label for="rc-exam" class="sr">Exam</label><select id="rc-exam"><option value="">— এক্সাম বাছুন —</option>${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === S.draft.examId ? "selected" : ""}>${esc(o.title)} — ${esc(STATE_LABEL[o.state] || o.state)}</option>`).join("")}</select></div>
        ${S.draft.examId ? `<div class="em-checks">${NOT_SUBMITTED.filter((g) => g !== "unverified").map((g) => `<label class="em-check"><input type="checkbox" data-group="${g}" ${S.draft.groups.includes(g) ? "checked" : ""}> ${esc(EXAM_GROUPS[g].label)}</label>`).join("")}</div>
          <button type="button" class="btn btn-outline btn-sm" data-act="sel-exam"><i class="fa-solid fa-user-clock"></i> Select these students</button>` : "<small>এক্সাম বাছলে ওই এক্সামে জমা না দেওয়া শিক্ষার্থীদের সিলেক্ট করা যাবে।</small>"}</div>
    </div>
    ${t.needsExam ? `<small class="form-hint">ক্যাম্পেইন টাইপ “${esc(t.label)}” — এই টাইপে শুধু ওই এক্সামের যোগ্য শিক্ষার্থীরাই ইমেইল পান; যাঁরা ইতিমধ্যে জমা দিয়েছেন তাঁদের কখনোই পাঠানো হয় না।</small>` : ""}</details>`;
}

function paint(el) {
  keepFocus(el, () => paintNow(el));
}
function paintNow(el) {
  setHtml(el.querySelector("#rc-presets"), presetsHtml());
  setHtml(el.querySelector("#rc-sum"), summaryHtml());
  setHtml(el.querySelector("#rc-skipped"), skippedHtml());
  paintSelbar(el);
  // filter widgets that depend on data
  const f = S.filters;
  el.querySelector("#rc-course").innerHTML = `<option value="">All courses</option>${S.courses.map((c) => `<option value="${esc(c.id)}" ${f.course === c.id ? "selected" : ""}>${esc(c.title)}</option>`).join("")}`;
  const stSel = el.querySelector("#rc-status");
  stSel.hidden = !S.derived.exam;
  stSel.innerHTML = `<option value="">Any exam status</option>${["not_attempted", "started_no_submission", "no_result_unverified", "submitted", "excluded", "unverified"].filter((g) => [...S.derived.clsByUid.values()].some((r) => r.status === g)).map((g) => `<option value="${g}" ${f.status === g ? "selected" : ""}>${esc(EXAM_GROUPS[g].label)}</option>`).join("")}`;
  paintTable();
}
const paintSummaryOnly = (el) => { setHtml(el.querySelector("#rc-sum"), summaryHtml()); setHtml(el.querySelector("#rc-skipped"), skippedHtml()); paintSelbar(el); };

export const recipients = {
  mount(el) {
    host = el;
    const f = S.filters;
    el.innerHTML = `
      <div class="panel"><div class="panel-body">
        <div id="rc-presets"></div><div id="rc-sum"></div>${selbarShell()}<div id="rc-skipped"></div>
      </div></div>
      <div class="panel"><div class="panel-head"><div><h2>Students</h2><small>টিক = ইমেইল পাবে। ফিল্টার বদলালেও টিক থাকে।</small></div></div>
        <div class="panel-body">
          <div class="toolbar em-filters">
            <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="rc-q" placeholder="Name or email…" aria-label="Search by name or email" autocomplete="off" value="${esc(f.q)}"></div>
            <select id="rc-course" aria-label="Filter by course"></select>
            <select id="rc-account" aria-label="Filter by account / eligibility">
              <option value="">All accounts</option><option value="eligible" ${f.account === "eligible" ? "selected" : ""}>Can receive this campaign</option><option value="blocked" ${f.account === "blocked" ? "selected" : ""}>Cannot receive (see reason)</option>
              <option value="deactivated" ${f.account === "deactivated" ? "selected" : ""}>Deactivated</option><option value="admin" ${f.account === "admin" ? "selected" : ""}>Admin accounts</option></select>
            <select id="rc-status" aria-label="Filter by exam status"></select>
            <select id="rc-picked" aria-label="Filter by selection"><option value="">Ticked + unticked</option><option value="yes" ${f.picked === "yes" ? "selected" : ""}>Only ticked</option><option value="no" ${f.picked === "no" ? "selected" : ""}>Only unticked</option></select>
            <select id="rc-rollmode" aria-label="Filter by roll"><option value="">Any roll</option><option value="has" ${f.roll === "has" ? "selected" : ""}>Has a roll</option><option value="none" ${f.roll === "none" ? "selected" : ""}>No roll</option></select>
            <div class="search em-roll"><i class="fa-solid fa-id-badge"></i><input type="search" id="rc-roll" placeholder="Roll contains…" aria-label="Roll contains" autocomplete="off" value="${esc(["has", "none"].includes(f.roll) ? "" : f.roll)}"></div>
          </div>
          <div id="rc-table"></div>
        </div></div>`;
    table = createTable({
      mount: el.querySelector("#rc-table"), pageSize: 10, defaultSort: { key: "name", dir: "asc" },
      empty: { icon: "fa-users", title: "কোনো শিক্ষার্থী মেলেনি", text: "সার্চ বা ফিল্টার বদলে দেখুন।" },
      rowClass: (r) => (S.draft.selected.has(r.id) ? "sel" : ""),
      columns: [
        { key: "pick", label: "", cls: "c-sel", render: (r) => `<input type="checkbox" data-pick="${esc(r.id)}" ${S.draft.selected.has(r.id) ? "checked" : ""} ${r.ok ? "" : "disabled"} aria-label="${r.ok ? "Select" : "Cannot select"} ${esc(r.s.name || r.s.email)}">` },
        { key: "name", label: "Student", sortable: true, sortValue: (r) => (r.s.name || r.s.email).toLowerCase(), render: (r) => `<div class="cell-main"><div class="t">${esc(r.s.name || "নাম নেই")}</div><div class="s">${esc(r.s.email || "—")}</div></div>` },
        { key: "roll", label: "Roll", sortable: true, sortValue: (r) => r.s.roll, render: (r) => esc(r.s.roll || "—") },
        { key: "courses", label: "Courses", render: (r) => esc(r.s.courseIds.map((c) => S.courseTitle.get(c) || c).join(", ") || "—") },
        { key: "acct", label: "Account", sortable: true, sortValue: (r) => (r.s.isAdmin ? 2 : r.s.disabled ? 1 : 0), render: (r) => (r.s.isAdmin ? chip("Admin", "accent") : r.s.disabled ? chip("Deactivated", "coral") : chip("Active", "teal")) },
        { key: "exam", label: "Exam status", sortable: true, sortValue: (r) => r.c?.status || "", render: (r) => (r.c ? groupChip(r.c.status) : '<span class="muted">—</span>') },
        { key: "can", label: "This campaign", render: (r) => (r.ok ? chip("Can receive", "teal", "fa-circle-check") : chip(reasonText(r.reason), "coral", "fa-ban")) },
      ],
    });
    bindTabLinks(el);
    const typing = debounce(() => { S.filters.q = el.querySelector("#rc-q").value; paintSummaryOnly(el); paintTable(); }, 200);
    el.addEventListener("input", (e) => {
      if (e.target.id === "rc-q") typing();
      if (e.target.id === "rc-roll") { S.filters.roll = e.target.value.trim(); el.querySelector("#rc-rollmode").value = ""; paintSummaryOnly(el); paintTable(); }
    });
    el.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.pick) { toggleUid(t.dataset.pick, t.checked); t.closest("tr")?.classList.toggle("sel", t.checked); paintSummaryOnly(el); return; }
      if (t.dataset.course) {
        const ids = new Set(S.draft.courseIds);
        if (t.checked) ids.add(t.dataset.course); else ids.delete(t.dataset.course);
        await setCourses([...ids]);
        if (!S.draft.courseIds.length && S.draft.mode === "course") await applyPreset("clear");
        paint(el); return;
      }
      if (t.dataset.group) { const set = new Set(S.draft.groups); if (t.checked) set.add(t.dataset.group); else set.delete(t.dataset.group); S.draft.groups = [...set]; if (S.draft.mode === "exam") await setGroups([...set]); paint(el); return; }
      if (t.id === "rc-exam") { await setExam(t.value); paint(el); return; }
      const map = { "rc-course": "course", "rc-account": "account", "rc-status": "status", "rc-picked": "picked" };
      if (map[t.id]) { S.filters[map[t.id]] = t.value; paintSummaryOnly(el); paintTable(); return; }
      if (t.id === "rc-rollmode") { S.filters.roll = t.value; el.querySelector("#rc-roll").value = ""; paintSummaryOnly(el); paintTable(); }
    });
    el.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "sel-filtered") { const ids = filtered().filter((r) => r.ok).map((r) => r.id); selectMany(ids, true); toast(`${fmtN(ids.length)} জন সিলেক্ট হয়েছে (শুধু এই ফিল্টার-করা তালিকা)`, "success"); }
      else if (act === "unsel-filtered") { const ids = filtered().map((r) => r.id); selectMany(ids, false); }
      else if (act === "clear") { await applyPreset("clear"); }
      else if (act === "sel-all") {
        const n = S.students.map(decorate).filter((r) => r.ok).length;
        if (!(await confirmAction(`ডেটাবেসের যোগ্য সব ${fmtN(n)} জন শিক্ষার্থী সিলেক্ট হবে — ফিল্টার/সার্চ নির্বিশেষে। এগিয়ে যাবেন?`, { title: "সবাইকে সিলেক্ট করবেন?", confirmLabel: `হ্যাঁ, ${fmtN(n)} জন` }))) return;
        S.draft.mode = "all"; S.draft.selected = new Set(S.students.map(decorate).filter((r) => r.ok).map((r) => r.id));
        selectMany([], true);
      } else if (act === "sel-exam") await applyPreset("exam");
      paint(el);
    });
    on("selection", (p) => { if (S.tab !== "recipients") return; if (p?.source !== "row") table.render(); paintSummaryOnly(el); });
    on("change", () => { if (S.tab === "recipients") paint(el); });
    on("examdata", () => { if (S.tab === "recipients") paint(el); });
    paint(el);
  },
  refresh(el) { paint(el); },
};
