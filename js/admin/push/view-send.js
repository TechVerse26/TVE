// ==========================================================================
// admin/push/view-send.js — "Send": write a notification, choose who gets it and when, check the preview, send a test, send.
//
//   • The form lives in S.form (state.js); this file only draws it and edits it. The rules (limits, destination, audience,
//     schedule) are in js/push/push-admin-core.js — the same rules the server enforces again.
//   • One request id per distinct content (requestSlot): a double click, or a retry after a lost answer, is the SAME request
//     and the server never sends twice. Tests and real sends use separate slots (on the server both become a job named after it).
//   • Nothing here claims delivery: the result card shows what FCM ACCEPTED and says so.
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, avatar, fmtN, confirmDanger, isDenied, debounce } from "../core/ui.js";
import { api } from "../../push/push-api.js";
import * as A from "../../push/push-admin-core.js";
import { S, on, emit, collect } from "./state.js";
import * as M from "./model.js";
import { openPicker } from "./images.js";
import { previewHtml, SITE_ICON } from "./preview.js";

let host = null;
let reach = { state: "idle", key: "" };         // idle | loading | ready | error
let seq = 0;                                     // answers to an outdated question are ignored
let touched = false;                             // the admin pressed Send/Test once: from now on every missing piece is shown
let last = null;                                 // the latest outcome: { kind, job } or { kind, error }
let previewMode = "phone";
let busyKind = "";                               // "send" | "test" while a request is in flight
let stopBus = () => {};

const $ = (sel) => host && host.querySelector(sel);

/* ==========================================================================
   Layout (drawn once — afterwards only small regions are repainted, so typing never loses focus)
   ========================================================================== */
const typeCard = (t) => `
  <label class="pn-type"><input type="radio" name="pn-cat" value="${esc(t.id)}"><i class="fa-solid ${esc(t.icon)}"></i>
    <span><b>${esc(t.label)} <small class="pn-bn">${esc(t.bn)}</small></b><small>${esc(t.help)}</small></span></label>`;
const audCard = (a) => `
  <label class="pn-type"><input type="radio" name="pn-aud" value="${esc(a.id)}"><i class="fa-solid ${esc(a.icon)}"></i>
    <span><b>${esc(a.label)}</b><small>${esc(a.help)}</small></span></label>`;

function layout() {
  return `
  <div class="pn-compose">
    <form class="pn-form" id="pn-form" novalidate autocomplete="off">
      <section class="panel pn-card" aria-labelledby="pn-h-msg">
        <div class="panel-head"><h2 id="pn-h-msg"><i class="fa-solid fa-pen-to-square"></i> Message</h2><small>What students will read</small></div>
        <div class="panel-body pn-fields">
          <fieldset class="pn-types"><legend>Kind of notification</legend><div class="pn-type-grid">${A.TYPES.map(typeCard).join("")}</div></fieldset>
          <div class="field">
            <label for="pn-title">Title <span class="req">*</span></label>
            <input type="text" id="pn-title" placeholder="e.g. Physics model test — tonight 8 PM" autocomplete="off" enterkeyhint="next">
            <div class="pn-meta"><span class="pn-err" id="pn-title-err" role="alert"></span><span class="pn-count" id="pn-title-n"></span></div>
          </div>
          <div class="field">
            <label for="pn-body">Message <span class="req">*</span></label>
            <textarea id="pn-body" rows="4" placeholder="One or two short, clear sentences."></textarea>
            <div class="pn-meta"><span class="pn-err" id="pn-body-err" role="alert"></span><span class="pn-count" id="pn-body-n"></span></div>
          </div>
          <div class="pn-pv-inline" id="pn-pv-inline" aria-label="Preview"></div>
        </div>
      </section>

      <section class="panel pn-card" aria-labelledby="pn-h-look">
        <div class="panel-head"><h2 id="pn-h-look"><i class="fa-solid fa-image"></i> Picture &amp; icon</h2><small>Optional</small></div>
        <div class="panel-body pn-fields" id="pn-look"></div>
      </section>

      <section class="panel pn-card" aria-labelledby="pn-h-dest">
        <div class="panel-head"><h2 id="pn-h-dest"><i class="fa-solid fa-arrow-pointer"></i> When it is tapped</h2><small>Always a page of this site</small></div>
        <div class="panel-body pn-fields" id="pn-dest"></div>
      </section>

      <section class="panel pn-card" aria-labelledby="pn-h-aud">
        <div class="panel-head"><h2 id="pn-h-aud"><i class="fa-solid fa-users"></i> Who receives it</h2><small>Only students who turned notifications on</small></div>
        <div class="panel-body pn-fields">
          <fieldset class="pn-types"><legend class="sr">Audience</legend><div class="pn-type-grid pn-aud-grid">${A.AUDIENCES.map(audCard).join("")}</div></fieldset>
          <div id="pn-aud-pick"></div>
          <div class="pn-reach" id="pn-reach" aria-live="polite"></div>
        </div>
      </section>

      <section class="panel pn-card" aria-labelledby="pn-h-when">
        <div class="panel-head"><h2 id="pn-h-when"><i class="fa-solid fa-clock"></i> When to send</h2></div>
        <div class="panel-body pn-fields" id="pn-when"></div>
      </section>
    </form>

    <aside class="pn-side" aria-label="Preview and sending">
      <section class="panel pn-card pn-pv-card">
        <div class="panel-head"><h2><i class="fa-solid fa-eye"></i> Preview</h2>
          <div class="pn-seg" role="radiogroup" aria-label="Preview style">
            <label class="seg-btn on" data-pvmode="phone"><input type="radio" name="pn-pvmode" value="phone" class="sr" checked>Phone</label>
            <label class="seg-btn" data-pvmode="desktop"><input type="radio" name="pn-pvmode" value="desktop" class="sr">Computer</label>
          </div>
        </div>
        <div class="panel-body"><div id="pn-pv-side"></div><p class="form-hint">A phone may show only the first lines until the notification is expanded.</p></div>
      </section>

      <section class="panel pn-card pn-ready" aria-labelledby="pn-h-ready">
        <div class="panel-head"><h2 id="pn-h-ready"><i class="fa-solid fa-paper-plane"></i> Ready to send?</h2></div>
        <div class="panel-body">
          <ul class="pn-checks" id="pn-checks"></ul>
          <div class="pn-actions">
            <button type="button" class="btn btn-outline btn-block" id="pn-test" data-act="test"><i class="fa-solid fa-flask"></i> <span>Send test to my devices</span></button>
            <button type="button" class="btn btn-primary btn-block" id="pn-send" data-act="send" aria-describedby="pn-why"><i class="fa-solid fa-paper-plane"></i> <span id="pn-send-l">Send now</span></button>
          </div>
          <p class="pn-why" id="pn-why" role="status"></p>
          <p class="pn-fine">A test goes only to devices of your own account that turned notifications on. “Accepted” in the results means Google’s push service took the message — it cannot confirm that a phone showed it.</p>
          <div id="pn-result" aria-live="polite"></div>
        </div>
      </section>
    </aside>
  </div>`;
}

/* ==========================================================================
   Small pure helpers
   ========================================================================== */
const hasValue = (key) => {
  const f = S.form;
  switch (key) {
    case "title": return f.title.trim() !== "";
    case "body": return f.body.trim() !== "";
    case "url": return f.destMode === "custom" ? f.destCustom.trim() !== "" : false;
    case "schedule": return f.scheduleLocal !== "";
    case "image": case "icon": return !!(f[key] && f[key].url);
    default: return false;
  }
};
/** An error is shown once the admin tried to send, or as soon as a field already holds a wrong value (never on an untouched form). */
const showErr = (v, key) => (v.errors[key] && (touched || hasValue(key)) ? v.errors[key] : "");
const validation = () => A.validateForm(S.form, { limits: S.limits, cronConfigured: S.setup ? S.setup.cronConfigured : true });
const testForm = () => ({ ...S.form, audienceType: "all", delivery: "now" });
const shortUrl = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/$/, "").slice(0, 48); } catch { return String(u).slice(0, 48); } };
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
const reachKey = () => JSON.stringify([A.audienceFromForm(S.form), S.form.category]);

function audienceLabel() {
  const f = S.form;
  if (reach.state === "ready" && reach.key === reachKey() && reach.label) return reach.label;
  switch (f.audienceType) {
    case "user": return `Student: ${f.userLabel || f.userId}`;
    case "exam": {
      const e = S.data.exams.list.find((x) => x.id === f.examId);
      const suffix = { all: "", not_submitted: " · not yet submitted", submitted: " · already submitted" }[f.examFilter] || "";
      return `Exam: ${e ? e.title : f.examId}${suffix}`;
    }
    case "section": { const s = S.data.academic.sections.find((x) => x.id === f.sectionId); return `Section: ${s ? s.name : f.sectionId}`; }
    case "level": { const l = S.data.academic.levels.find((x) => x.id === f.levelId); return `Level: ${l ? l.name : f.levelId}`; }
    default: return "All subscribed students";
  }
}

/* ==========================================================================
   Painting
   ========================================================================== */
function paintTypes() {
  host.querySelectorAll('input[name="pn-cat"]').forEach((r) => { r.checked = r.value === S.form.category; r.closest(".pn-type").classList.toggle("on", r.checked); });
  host.querySelectorAll('input[name="pn-aud"]').forEach((r) => { r.checked = r.value === S.form.audienceType; r.closest(".pn-type").classList.toggle("on", r.checked); });
}

function paintFields() {
  const t = $("#pn-title"), b = $("#pn-body");
  if (t.value !== S.form.title) t.value = S.form.title;
  if (b.value !== S.form.body) b.value = S.form.body;
}

function setCount(sel, n, max) {
  const el = $(sel);
  el.textContent = `${n} / ${max}`;
  el.classList.toggle("warn", n >= max * 0.9 && n <= max);
  el.classList.toggle("bad", n > max);
}

function paintCounters() {
  const f = S.form, v = validation();
  setCount("#pn-title-n", A.cpLen(f.title.trim()), S.limits.titleMax);
  setCount("#pn-body-n", A.cpLen(f.body.trim()), S.limits.bodyMax);
  $("#pn-title-err").textContent = showErr(v, "title");
  $("#pn-body-err").textContent = showErr(v, "body");
  $("#pn-title").setAttribute("aria-invalid", showErr(v, "title") ? "true" : "false");
  $("#pn-body").setAttribute("aria-invalid", showErr(v, "body") ? "true" : "false");
}

/* ---- picture & icon ---- */
function mediaRow(kind, v) {
  const f = S.form, picked = f[kind], isIcon = kind === "icon";
  const err = showErr(v, kind);
  const box = picked && picked.url
    ? `<img src="${esc(picked.thumb || picked.url)}" alt="" referrerpolicy="no-referrer">`
    : (isIcon ? `<img src="${SITE_ICON}" alt="">` : `<i class="fa-regular fa-image" aria-hidden="true"></i>`);
  const title = isIcon ? "Icon" : "Picture";
  const sub = picked && picked.url
    ? esc(picked.name || shortUrl(picked.url))
    : (isIcon ? "Default: the Tech Verse Exam logo" : "None — the notification shows text only");
  return `
    <div class="pn-media" data-kind="${kind}">
      <div class="pn-media-box ${kind}">${box}</div>
      <div class="pn-media-main"><b>${title}</b><small>${sub}</small>${err ? `<small class="pn-err" role="alert">${esc(err)}</small>` : ""}</div>
      <div class="pn-media-actions">
        <button type="button" class="btn btn-outline btn-sm" data-act="pick-${kind}"><i class="fa-solid fa-image"></i> ${picked && picked.url ? "Change" : "Choose"}</button>
        ${picked && picked.url ? `<button type="button" class="btn btn-outline btn-sm" data-act="clear-${kind}">${isIcon ? "Use default" : "Remove"}</button>` : ""}
      </div>
    </div>`;
}
function paintLook() {
  const v = validation();
  $("#pn-look").innerHTML = mediaRow("icon", v) + mediaRow("image", v);
}

/* ---- destination ---- */
const DEST_MODES = [["page", "A page"], ["exam", "An exam"], ["custom", "Custom address"]];

function destField() {
  const f = S.form;
  if (f.destMode === "exam") {
    const d = S.data.exams;
    if (d.status === "error") return errBox(d.error, "exams", "exams");
    if (d.status !== "ready") return `<div class="pn-loading"><span class="spinner sm"></span> Loading exams…</div>`;
    return `<label for="pn-dest-exam">Exam to open</label>
      <select id="pn-dest-exam"><option value="">Choose an exam…</option>${d.list.map((e) => `<option value="${esc(e.id)}"${f.destExamId === e.id ? " selected" : ""}>${esc(e.title)}${e.draft ? " (draft)" : ""}</option>`).join("")}</select>`;
  }
  if (f.destMode === "custom") {
    return `<label for="pn-dest-custom">Page address</label>
      <input type="text" id="pn-dest-custom" value="${esc(f.destCustom)}" placeholder="#/results" autocomplete="off" spellcheck="false" autocapitalize="off">
      <span class="form-hint">Only pages of this site, like <code>#/results</code> or <code>#/exams?open=…</code>.</span>`;
  }
  return `<label for="pn-dest-page">Page</label>
    <select id="pn-dest-page">${A.PAGES.map(([v, l]) => `<option value="${esc(v)}"${f.destPage === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}

function paintDest() {
  const f = S.form;
  $("#pn-dest").innerHTML = `
    <div class="pn-seg" role="radiogroup" aria-label="What the notification opens">${DEST_MODES.map(([id, label]) =>
      `<label class="seg-btn${f.destMode === id ? " on" : ""}"><input type="radio" name="pn-dest-mode" value="${id}" class="sr"${f.destMode === id ? " checked" : ""}>${esc(label)}</label>`).join("")}</div>
    <div class="field" id="pn-dest-field">${destField()}</div>
    <p class="form-hint pn-dest-note" id="pn-dest-note"></p>`;
  paintDestNote();
}
function paintDestField() {
  const el = $("#pn-dest-field");
  if (el) el.innerHTML = destField();
  paintDestNote();
}
function paintDestNote() {
  const el = $("#pn-dest-note");
  if (!el) return;
  const r = A.destinationFor(S.form), v = validation();
  const err = showErr(v, "url") || (!r.ok && S.form.destMode !== "custom" && touched ? r.error : "");
  el.classList.toggle("bad", !!err);
  el.innerHTML = err
    ? `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(err)}`
    : (r.ok ? `Opens <code>${esc(r.value)}</code> on this site. A notification can never open another website.` : "");
}

/* ---- audience ---- */
function errBox(err, what, which) {
  const why = isDenied(err) ? "Firestore rules do not let this account read it." : String((err && err.message) || err || "");
  return `<div class="note bad"><i class="fa-solid fa-triangle-exclamation"></i> Could not load the ${esc(what)}${why ? `: ${esc(why)}` : ""}. <button type="button" class="link-btn" data-act="retry-data" data-what="${esc(which)}">Try again</button></div>`;
}
const loading = (what) => `<div class="pn-loading"><span class="spinner sm"></span> Loading ${esc(what)}…</div>`;

function userPicker() {
  const d = S.data.students, f = S.form;
  if (f.userId) {
    return `<div class="field"><label>Student</label>
      <div class="pn-chosen">${avatar(f.userLabel || "?", 36)}<div class="pn-chosen-main"><b>${esc(f.userLabel || f.userId)}</b></div>
      <button type="button" class="btn btn-outline btn-sm" data-act="clear-student">Change</button></div></div>`;
  }
  if (d.status === "error") return errBox(d.error, "students", "students");
  if (d.status !== "ready") return loading("students");
  if (!d.list.length) return `<p class="muted">No students found.</p>`;
  return `<div class="field"><label for="pn-stu-q">Student</label>
    <input type="search" id="pn-stu-q" placeholder="Search by name, email or roll number…" autocomplete="off" spellcheck="false">
    <div class="pn-results" id="pn-stu-res" role="listbox" aria-label="Matching students"></div>
    <span class="form-hint">${fmtN(d.list.length)} students</span></div>`;
}

const optList = (list, sel, label = (x) => x.name) => list.map((x) => `<option value="${esc(x.id)}"${sel === x.id ? " selected" : ""}>${esc(label(x))}${x.inactive ? " (inactive)" : ""}</option>`).join("");

function examPicker() {
  const d = S.data.exams, f = S.form;
  if (d.status === "error") return errBox(d.error, "exams", "exams");
  if (d.status !== "ready") return loading("exams");
  return `<div class="admin-grid">
    <div class="field"><label for="pn-aud-exam">Exam</label><select id="pn-aud-exam"><option value="">Choose an exam…</option>${d.list.map((e) => `<option value="${esc(e.id)}"${f.examId === e.id ? " selected" : ""}>${esc(e.title)}${e.draft ? " (draft)" : ""}</option>`).join("")}</select></div>
    <div class="field"><label for="pn-aud-filter">Which students</label><select id="pn-aud-filter">${A.EXAM_FILTERS.map(([k, l]) => `<option value="${k}"${f.examFilter === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
  </div>`;
}

function sectionPicker() {
  const d = S.data.academic, f = S.form;
  if (d.status === "error") return errBox(d.error, "programs", "academic");
  if (d.status !== "ready") return loading("programs");
  return `<div class="field"><label for="pn-aud-section">Program</label><select id="pn-aud-section"><option value="">Choose a program…</option>${optList(d.sections, f.sectionId)}</select></div>`;
}

function levelPicker() {
  const d = S.data.academic, f = S.form;
  if (d.status === "error") return errBox(d.error, "levels", "academic");
  if (d.status !== "ready") return loading("levels");
  const groups = d.sections.map((s) => ({ s, levels: d.levels.filter((l) => l.sectionId === s.id) })).filter((g) => g.levels.length);
  const known = new Set(d.sections.map((s) => s.id));
  const orphan = d.levels.filter((l) => !known.has(l.sectionId));
  return `<div class="field"><label for="pn-aud-level">Level</label><select id="pn-aud-level"><option value="">Choose a level…</option>
    ${groups.map((g) => `<optgroup label="${esc(g.s.name)}">${optList(g.levels, f.levelId)}</optgroup>`).join("")}
    ${orphan.length ? `<optgroup label="Other">${optList(orphan, f.levelId)}</optgroup>` : ""}</select></div>`;
}

function paintAudPick() {
  const el = $("#pn-aud-pick");
  if (!el) return;
  const f = S.form;
  // a chosen item that no longer exists is dropped, so the admin is asked again instead of sending to a ghost
  if (S.data.exams.status === "ready") {
    if (f.examId && !S.data.exams.list.some((e) => e.id === f.examId)) f.examId = "";
    if (f.destExamId && !S.data.exams.list.some((e) => e.id === f.destExamId)) f.destExamId = "";
  }
  if (S.data.academic.status === "ready") {
    if (f.sectionId && !S.data.academic.sections.some((s) => s.id === f.sectionId)) f.sectionId = "";
    if (f.levelId && !S.data.academic.levels.some((l) => l.id === f.levelId)) f.levelId = "";
  }
  el.innerHTML = { user: userPicker, exam: examPicker, section: sectionPicker, level: levelPicker }[f.audienceType]?.() || "";
  if (f.audienceType === "user" && !f.userId) paintStudentResults();
}

function paintStudentResults() {
  const box = $("#pn-stu-res");
  if (!box) return;
  const q = (($("#pn-stu-q") || {}).value || "").trim().toLowerCase();
  const list = S.data.students.list;
  const hits = (q ? list.filter((s) => s.hay.includes(q)) : list).slice(0, 8);
  box.innerHTML = hits.length
    ? hits.map((s) => `<button type="button" class="pn-result-row" role="option" data-act="pick-student" data-uid="${esc(s.id)}" data-label="${esc(s.name || s.email || s.id)}">
        ${avatar(s.name || s.email || "?", 32)}<span class="pn-rr-main"><b>${esc(s.name || "(no name)")}</b><small>${esc([s.email, s.roll && `Roll ${s.roll}`].filter(Boolean).join(" · "))}</small></span>${s.admin ? `<span class="chip">Admin</span>` : ""}</button>`).join("")
    : `<p class="muted pn-none">No student matches “${esc(q)}”.</p>`;
}

function paintReach() {
  const el = $("#pn-reach");
  if (!el) return;
  if (A.audienceProblem(S.form)) { el.innerHTML = `<p class="pn-reach-idle"><i class="fa-solid fa-users-viewfinder"></i> Choose who should receive it to see how many devices it would reach.</p>`; return; }
  if (!(S.setup && S.setup.canSend)) { el.innerHTML = `<p class="pn-reach-idle"><i class="fa-solid fa-users-viewfinder"></i> ${S.healthStatus === "ready" || S.healthStatus === "error" ? "The number of devices appears once the push server is set up (see the Setup tab)." : "Checking the push server…"}</p>`; return; }
  if (reach.state === "loading") { el.innerHTML = `<p class="pn-reach-idle"><span class="spinner sm"></span> Counting devices…</p>`; return; }
  if (reach.state === "error") { el.innerHTML = `<div class="note bad"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(reach.text)} <button type="button" class="link-btn" data-act="reach-refresh">Try again</button></div>`; return; }
  if (reach.state === "ready" && reach.info) {
    const i = reach.info;
    el.innerHTML = `<div class="pn-reach-box ${i.tone}"><i class="fa-solid ${i.tone === "ok" ? "fa-mobile-screen-button" : "fa-circle-exclamation"}"></i>
      <div class="pn-reach-text"><b>${esc(i.headline)}</b><small>${esc(i.detail)}</small></div>
      <button type="button" class="link-btn" data-act="reach-refresh">Refresh</button></div>`;
    return;
  }
  el.innerHTML = "";
}

function paintAud() { paintTypes(); paintAudPick(); paintReach(); }

/* ---- when ---- */
function paintWhen() {
  const el = $("#pn-when");
  if (!el) return;
  const f = S.form, v = validation(), later = f.delivery === "later";
  const cron = S.setup ? S.setup.cronConfigured : null;
  const err = showErr(v, "schedule");
  const now = Date.now();
  const note = !later ? "" : cron === false
    ? `<div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> The free timer is not set up yet, so a scheduled notification goes out only while an admin has the Push Notification page open — and is still signed in — at that time. Set up the free timer in the <button type="button" class="link-btn" data-act="goto-setup">Setup tab</button> to send on time even when nobody is online.</div>`
    : `<div class="note ok"><i class="fa-solid fa-circle-check"></i> ${cron ? "The free timer you set up (cron-job.org or GitHub Actions) sends it — usually within a minute or two of the chosen time. An admin does not need to be online." : "Checking how scheduled sends are triggered…"}</div>`;
  el.innerHTML = `
    <div class="pn-whenrow" role="radiogroup" aria-label="When to send">
      <label class="pn-type${!later ? " on" : ""}"><input type="radio" name="pn-when" value="now"${!later ? " checked" : ""}><i class="fa-solid fa-bolt"></i><span><b>Send now</b><small>Goes out as soon as you confirm.</small></span></label>
      <label class="pn-type${later ? " on" : ""}"><input type="radio" name="pn-when" value="later"${later ? " checked" : ""}><i class="fa-solid fa-calendar-plus"></i><span><b>Schedule for later</b><small>Choose the date and time.</small></span></label>
    </div>
    ${later ? `<div class="field"><label for="pn-when-at">Send at</label>
      <input type="datetime-local" id="pn-when-at" value="${esc(f.scheduleLocal)}" min="${esc(A.toLocalInputValue(now + 60000))}" max="${esc(A.toLocalInputValue(now + S.limits.maxScheduleDays * 86400000))}" step="60" aria-invalid="${err ? "true" : "false"}">
      <div class="pn-meta"><span class="pn-err" role="alert">${esc(err)}</span><span class="pn-count">${esc(tzName() ? `Your time zone: ${tzName()}` : "")}</span></div></div>` : ""}
    ${note}`;
}

/* ---- preview ---- */
function currentPreview(mode) {
  const f = S.form;
  return previewHtml({ title: f.title, body: f.body, icon: f.icon && (f.icon.thumb || f.icon.url), image: f.image && f.image.url, category: f.category }, mode);
}
function paintPreview() {
  const a = $("#pn-pv-inline"), b = $("#pn-pv-side");
  if (a) a.innerHTML = `<div class="pn-pv-label">Preview</div>${currentPreview("phone")}`;
  if (b) b.innerHTML = currentPreview(previewMode);
}

/* ---- the readiness box ---- */
function readiness() {
  const f = S.form, v = validation(), setup = S.setup, later = f.delivery === "later";
  const vt = A.validateForm(testForm(), { limits: S.limits, cronConfigured: true });
  const loadingHealth = S.healthStatus === "idle" || S.healthStatus === "loading";
  const serverOk = !!(setup && (later ? setup.canSchedule : setup.canSend));
  const serverText = () => {
    const bad = setup && setup.items.find((i) => i.tone === "bad");
    return bad ? bad.text : "The push server is not ready — see the Setup tab.";
  };
  const zero = reach.state === "ready" && reach.key === reachKey() && reach.info && reach.info.devices === 0;
  const send = [];
  if (loadingHealth) send.push("Checking the push server…");
  else if (!serverOk) send.push(serverText());
  if (!v.ok) send.push("Fill in the parts listed above.");
  if (!later && zero) send.push("No student has notifications turned on for this audience, so nobody would receive it.");
  const test = [];
  if (loadingHealth) test.push("Checking the push server…");
  else if (!(setup && setup.canSend)) test.push(serverText());
  if (!vt.ok) test.push("Write the title and message first.");
  return { v, vt, later, loadingHealth, serverOk, serverText, send, test, zero };
}

const row = (tone, icon, html) => `<li class="${tone}"><i class="fa-solid ${icon}"></i><span>${html}</span></li>`;

function paintChecks(r) {
  const f = S.form, items = [];
  if (r.loadingHealth) items.push(row("mute", "fa-circle-notch fa-spin", "Checking the push server…"));
  else if (r.serverOk) items.push(row("ok", "fa-circle-check", "Push server is ready"));
  else items.push(row("bad", "fa-circle-xmark", `${esc(r.serverText())} <button type="button" class="link-btn" data-act="goto-setup">Open Setup</button>`));

  const part = (key, label) => (r.v.errors[key]
    ? row("todo", "fa-circle", `${esc(label)}: <span class="pn-todo">${esc(r.v.errors[key])}</span>`)
    : row("ok", "fa-circle-check", esc(label)));
  items.push(part("title", "Title"));
  items.push(part("body", "Message"));
  items.push(part("url", "Where it opens"));
  items.push(part("audience", "Audience"));
  if (f.delivery === "later") items.push(part("schedule", "Date and time"));
  for (const k of ["image", "icon"]) if (r.v.errors[k]) items.push(row("todo", "fa-circle", `${k === "image" ? "Picture" : "Icon"}: <span class="pn-todo">${esc(r.v.errors[k])}</span>`));
  if (r.v.errors.category) items.push(part("category", "Kind"));

  if (!A.audienceProblem(f) && r.serverOk) {
    if (reach.state === "loading") items.push(row("mute", "fa-circle-notch fa-spin", "Counting devices…"));
    else if (reach.state === "ready" && reach.key === reachKey() && reach.info) items.push(row(reach.info.tone === "ok" ? "ok" : "warn", reach.info.tone === "ok" ? "fa-mobile-screen-button" : "fa-circle-exclamation", esc(reach.info.headline)));
  }
  r.v.warnings.forEach((w) => items.push(row("warn", "fa-triangle-exclamation", esc(w))));
  $("#pn-checks").innerHTML = items.join("");
}

function paintActions(r) {
  const send = $("#pn-send"), test = $("#pn-test"), why = $("#pn-why");
  $("#pn-send-l").textContent = r.later ? "Schedule notification" : "Send now";
  const busy = S.sending;
  send.querySelector("i").className = `fa-solid ${busy && busyKind === "send" ? "fa-circle-notch fa-spin" : r.later ? "fa-calendar-check" : "fa-paper-plane"}`;
  test.querySelector("i").className = `fa-solid ${busy && busyKind === "test" ? "fa-circle-notch fa-spin" : "fa-flask"}`;
  send.disabled = busy; test.disabled = busy;
  send.setAttribute("aria-disabled", r.send.length ? "true" : "false");
  test.setAttribute("aria-disabled", r.test.length ? "true" : "false");
  send.classList.toggle("is-blocked", r.send.length > 0);
  test.classList.toggle("is-blocked", r.test.length > 0);
  send.classList.toggle("is-busy", busy);
  why.textContent = busy ? "Working…" : (r.send[0] || "");
}

function paintReady() {
  if (!host) return;
  const r = readiness();
  paintChecks(r);
  paintActions(r);
}

/* ---- the outcome ---- */
const CHIP_TONE = { teal: "teal", coral: "coral", amber: "amber", accent: "accent", "": "" };
function resultHtml() {
  if (!last) return "";
  const kind = last.kind === "test" ? "Test" : "";
  if (last.error) {
    return `<div class="pn-result bad"><div class="pn-result-head"><b><i class="fa-solid fa-triangle-exclamation"></i> ${last.kind === "test" ? "The test was not sent" : "Nothing was sent"}</b>
      <button type="button" class="icon-btn" data-act="dismiss-result" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button></div>
      <p>${esc(A.adminErrorText(last.error))}</p></div>`;
  }
  const j = last.job, meta = A.statusMeta(j.status), pct = A.progressPct(j);
  const rows = A.countRows(j.counts);
  const errs = A.errorRows(j.errors);
  const when = j.status === "scheduled" && j.scheduledAt ? `<p class="pn-result-when"><i class="fa-solid fa-clock"></i> Scheduled for ${esc(new Date(j.scheduledAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</p>` : "";
  return `<div class="pn-result ${meta.tone}">
    <div class="pn-result-head">
      <span class="pn-result-chips"><span class="chip ${CHIP_TONE[meta.tone] || ""}"><i class="fa-solid ${esc(meta.icon)}"></i> ${esc(meta.label)}</span>${kind ? `<span class="chip">${kind}</span>` : ""}</span>
      <button type="button" class="icon-btn" data-act="dismiss-result" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <p class="pn-result-title">${esc(j.title)}</p>
    ${when}
    ${j.status === "sending" ? `<div class="pn-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct === null ? 0 : pct}"><i style="width:${pct === null ? 8 : pct}%"></i></div>` : ""}
    ${j.status === "scheduled" ? "" : `<dl class="pn-counts">${rows.filter((x) => x.key !== "skipped" || x.value).map((x) => `<div class="${x.tone}" title="${esc(x.help)}"><dt>${esc(x.label)}</dt><dd>${fmtN(x.value)}</dd></div>`).join("")}</dl>`}
    ${errs.length ? `<ul class="pn-errlist">${errs.map((e) => `<li>${esc(e.label)} <b>${fmtN(e.n)}</b></li>`).join("")}</ul>` : ""}
    <p class="pn-note">${esc(A.deliveryNote(j))}</p>
    ${last.interrupted ? `<p class="pn-note bad"><i class="fa-solid fa-triangle-exclamation"></i> Sending was interrupted: ${esc(A.adminErrorText(last.interrupted))} Open History and press Continue.</p>` : ""}
    ${last.duplicate ? `<p class="pn-note"><i class="fa-solid fa-circle-info"></i> This notification had already been submitted, so nothing new was sent.</p>` : ""}
    <div class="pn-result-actions">
      <button type="button" class="btn btn-outline btn-sm" data-act="open-history" data-id="${esc(j.id)}"><i class="fa-solid fa-clock-rotate-left"></i> View in History</button>
      ${last.kind === "send" ? `<button type="button" class="btn btn-outline btn-sm" data-act="reuse-last"><i class="fa-solid fa-copy"></i> Reuse the text</button>` : ""}
    </div>
  </div>`;
}
function paintResult() {
  const el = $("#pn-result");
  if (el) el.innerHTML = resultHtml();
}

function paintAll() {
  paintTypes(); paintFields(); paintCounters(); paintLook(); paintDest(); paintAud(); paintWhen(); paintPreview(); paintReady(); paintResult();
}
/** After any edit of the text or the options. */
function changed({ counters = true, preview = true, ready = true } = {}) {
  if (counters) paintCounters();
  if (preview) paintPreview();
  if (ready) paintReady();
}

/* ==========================================================================
   Reach (how many devices) — asked from the server, debounced, answers to old questions dropped
   ========================================================================== */
const askReach = debounce(async () => {
  if (!host) return;
  if (A.audienceProblem(S.form) || !(S.setup && S.setup.canSend)) { seq++; reach = { state: "idle", key: "" }; paintReach(); paintReady(); return; }
  const key = reachKey(), mine = ++seq;
  reach = { state: "loading", key };
  paintReach(); paintReady();
  try {
    const r = await api("audience", { audience: A.audienceFromForm(S.form), category: S.form.category }, { timeoutMs: 20000 });
    if (mine !== seq) return;
    reach = { state: "ready", key, info: A.reachInfo(r.preview), label: (r.preview && r.preview.label) || "" };
  } catch (err) {
    if (mine !== seq) return;
    reach = { state: "error", key, text: A.adminErrorText(err) };
  }
  paintReach(); paintReady();
}, 350);
function refreshReach() {
  seq++;                                                   // whatever is in flight is about an older question
  if (A.audienceProblem(S.form)) { reach = { state: "idle", key: "" }; paintReach(); paintReady(); return; }
  askReach();
}

/** Load whatever the current choices need (students, exams, programs) — once, the first time it is wanted. */
function needData() {
  const f = S.form;
  if (f.audienceType === "user" && !f.userId) M.ensureStudents();
  if (f.audienceType === "exam" || f.destMode === "exam") M.ensureExams();
  if (f.audienceType === "section" || f.audienceType === "level") M.ensureAcademic();
}

/* ==========================================================================
   Actions
   ========================================================================== */
function resetForm() {
  S.form = A.emptyForm();
  touched = false;
  reach = { state: "idle", key: "" };
  seq++;
  paintAll();
  needData();
  refreshReach();                                          // the new (default) audience needs its device count again
}

function focusFirstProblem(r) {
  const f = S.form, e = r.v.errors;
  const target = e.title ? "#pn-title" : e.body ? "#pn-body"
    : e.url ? (f.destMode === "custom" ? "#pn-dest-custom" : f.destMode === "exam" ? "#pn-dest-exam" : "#pn-dest-page")
      : e.audience ? ({ user: "#pn-stu-q", exam: "#pn-aud-exam", section: "#pn-aud-section", level: "#pn-aud-level" }[f.audienceType] || "")
        : e.schedule ? "#pn-when-at" : "";
  const el = target && $(target);
  if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
  else if (r.send.length) $("#pn-why").scrollIntoView({ block: "nearest" });
}

/** An uncertain outcome (no answer at all): the request id is kept, so pressing the button again is the SAME request. */
const uncertain = (err) => !!err && (err.code === "network" || err.code === "timeout" || err.status >= 500 || err.code === "internal_error");

async function doSend() {
  if (S.sending) return;
  touched = true;
  const r = readiness();
  paintCounters(); paintLook(); paintDestNote(); paintWhen(); paintReady();
  if (r.send.length) {
    focusFirstProblem(r);
    return;
  }
  const f = S.form, later = f.delivery === "later";
  const probe = A.buildPayload(f, "");
  const info = reach.state === "ready" && reach.key === reachKey() ? reach.info : null;
  const ok = await confirmDanger({
    title: later ? "Schedule this notification?" : "Send this notification?",
    message: A.confirmMessage(probe, info, audienceLabel()),
    confirmLabel: later ? "Schedule" : "Send now",
    tone: "primary",
    phrase: !later && f.audienceType === "all" ? "SEND" : "",
  });
  if (!ok) return;

  S.reqSend = A.requestSlot(S.reqSend, probe);
  const payload = { ...probe, requestId: S.reqSend.id };
  S.sending = true; busyKind = "send"; paintReady();
  let driveId = "";
  try {
    const res = await api("send", payload, { timeoutMs: 50000 });
    S.reqSend = null;                                     // a definite answer: the next send is a new request
    M.upsertJob(res.job);
    last = { kind: "send", job: res.job, duplicate: !!res.duplicate };
    toast(res.duplicate ? "That notification had already been submitted" : later ? "Notification scheduled" : res.job.status === "sending" ? "Sending…" : "Notification sent", res.duplicate ? "info" : "success");
    if (!res.duplicate) resetForm();
    if (res.job.status === "sending") driveId = res.job.id;
  } catch (err) {
    if (!uncertain(err)) S.reqSend = null;
    last = { kind: "send", error: err };
    toast(A.adminErrorText(err), "error");
  } finally {
    S.sending = false;
    paintResult(); paintReady();
  }
  if (driveId) keepGoing(driveId);
}

async function keepGoing(id) {
  try { await M.driveJob(id); } catch (err) {
    if (last && last.job && last.job.id === id) { last = { kind: last.kind, job: last.job, duplicate: last.duplicate, interrupted: err }; paintResult(); }
    toast(`Sending was interrupted: ${A.adminErrorText(err)} Open History and press Continue.`, "error");
  }
  syncLast();
}

async function doTest() {
  if (S.sending) return;
  touched = true;
  const r = readiness();
  paintCounters(); paintDestNote(); paintReady();
  if (r.test.length) {
    const e = r.vt.errors;
    const el = $(e.title ? "#pn-title" : e.body ? "#pn-body" : "");
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
    return;
  }
  const probe = { ...A.buildPayload(testForm(), ""), audience: null, scheduleAt: null };
  S.reqTest = A.requestSlot(S.reqTest, probe);
  const payload = { ...probe, requestId: S.reqTest.id };
  S.sending = true; busyKind = "test"; paintReady();
  try {
    const res = await api("test", payload, { timeoutMs: 50000 });
    S.reqTest = null;
    M.upsertJob(res.job);
    last = { kind: "test", job: res.job, duplicate: !!res.duplicate };
    toast("Test sent to your devices", "success");
  } catch (err) {
    if (!uncertain(err)) S.reqTest = null;
    last = { kind: "test", error: err };
  } finally {
    S.sending = false;
    paintResult(); paintReady();
  }
}

function syncLast() {
  if (!last || !last.job) return;
  const j = S.jobs.find((x) => x.id === last.job.id);
  if (j && j !== last.job) { last = { ...last, job: j }; paintResult(); }
}

function reuse(job) {
  S.form = A.formFromJob(job);
  S.reqSend = null;
  touched = false;
  reach = { state: "idle", key: "" };
  seq++;
  paintAll();
  needData();
  refreshReach();
  emit("goto", { tab: "send" });
  try { host.scrollIntoView({ block: "start", behavior: "smooth" }); } catch { /* ignore */ }
  toast("Text copied — choose the audience and send", "info");
}

/* ==========================================================================
   Events
   ========================================================================== */
function onInput(e) {
  const t = e.target, f = S.form;
  if (t.id === "pn-title") { f.title = t.value; changed(); }
  else if (t.id === "pn-body") { f.body = t.value; changed(); }
  else if (t.id === "pn-dest-custom") { f.destCustom = t.value; paintDestNote(); paintReady(); }
  else if (t.id === "pn-when-at") { f.scheduleLocal = t.value; paintReady(); const v = validation(); const er = t.parentElement.querySelector(".pn-err"); if (er) er.textContent = showErr(v, "schedule"); }
  else if (t.id === "pn-stu-q") paintStudentResults();
}

function onChange(e) {
  const t = e.target, f = S.form;
  switch (true) {
    case t.name === "pn-cat": f.category = t.value; paintTypes(); changed(); refreshReach(); break;
    case t.name === "pn-dest-mode":
      f.destMode = t.value; paintDest(); if (t.value === "exam") M.ensureExams(); paintReady();
      keepFocus('input[name="pn-dest-mode"]:checked');
      break;
    case t.id === "pn-dest-page": f.destPage = t.value; paintDestNote(); paintReady(); break;
    case t.id === "pn-dest-exam": f.destExamId = t.value; paintDestNote(); paintReady(); break;
    case t.name === "pn-aud": f.audienceType = t.value; paintAud(); needData(); refreshReach(); paintReady(); break;
    case t.id === "pn-aud-exam": f.examId = t.value; refreshReach(); paintReady(); break;
    case t.id === "pn-aud-filter": f.examFilter = t.value; refreshReach(); paintReady(); break;
    case t.id === "pn-aud-section": f.sectionId = t.value; refreshReach(); paintReady(); break;
    case t.id === "pn-aud-level": f.levelId = t.value; refreshReach(); paintReady(); break;
    case t.name === "pn-when":
      f.delivery = t.value;
      if (f.delivery === "later" && !f.scheduleLocal) f.scheduleLocal = A.defaultSchedule();
      paintWhen(); paintReady();
      keepFocus('input[name="pn-when"]:checked');
      break;
    case t.name === "pn-pvmode":
      previewMode = t.value === "desktop" ? "desktop" : "phone";
      host.querySelectorAll("[data-pvmode]").forEach((l) => l.classList.toggle("on", l.dataset.pvmode === previewMode));
      paintPreview();
      break;
    default: break;
  }
}

/** The radios are redrawn with their panel; give the keyboard back to the one that is now selected. */
function keepFocus(sel) {
  const el = $(sel);
  if (el) { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
}

function pickMedia(kind) {
  const cur = S.form[kind];
  openPicker({
    kind,
    current: cur && cur.url,
    onPick: (img) => { S.form[kind] = img; paintLook(); changed({ counters: false }); },
  });
}

function onClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b || !host.contains(b)) return;
  const f = S.form;
  switch (b.dataset.act) {
    case "send": doSend(); break;
    case "test": doTest(); break;
    case "pick-icon": pickMedia("icon"); break;
    case "pick-image": pickMedia("image"); break;
    case "clear-icon": f.icon = null; paintLook(); changed({ counters: false }); break;
    case "clear-image": f.image = null; paintLook(); changed({ counters: false }); break;
    case "pick-student": f.userId = b.dataset.uid; f.userLabel = b.dataset.label || ""; paintAudPick(); refreshReach(); paintReady(); break;
    case "clear-student": f.userId = ""; f.userLabel = ""; paintAudPick(); needData(); refreshReach(); paintReady(); break;
    case "reach-refresh": refreshReach(); break;
    case "retry-data": {
      const what = b.dataset.what;
      if (what === "students") M.ensureStudents({ force: true });
      else if (what === "exams") M.ensureExams({ force: true });
      else M.ensureAcademic({ force: true });
      break;
    }
    case "goto-setup": emit("goto", { tab: "setup" }); break;
    case "open-history": emit("goto", { tab: "history", job: b.dataset.id }); break;
    case "dismiss-result": last = null; paintResult(); break;
    case "reuse-last": if (last && last.job) reuse(last.job); break;
    default: break;
  }
}

/** A picture whose link does not load: say so under the preview instead of showing a blank box. */
function onImageError(e) {
  const img = e.target;
  if (!img || img.tagName !== "IMG") return;
  const wrap = img.closest(".pn-pv-pic");
  if (wrap) wrap.classList.add("broken");
  else if (img.closest(".pn-media-box") || img.classList.contains("pn-pv-icon")) img.classList.add("broken");
}

/* ==========================================================================
   Lifecycle
   ========================================================================== */
export function mount(root) {
  host = root;
  host.innerHTML = layout();
  stopBus = collect(() => {
    on("health", () => { paintReady(); paintWhen(); paintReach(); refreshReach(); });
    on("data", () => { paintAudPick(); paintDestField(); paintReady(); });
    on("jobs", syncLast);
    on("reuse", reuse);
  });
  host.addEventListener("input", onInput);
  host.addEventListener("change", onChange);
  host.addEventListener("click", onClick);
  host.addEventListener("error", onImageError, true);
  host.addEventListener("submit", (e) => e.preventDefault());
  paintAll();
  needData();
}

/** Called every time the tab is shown. */
export function activate() {
  M.loadHealth();
  if (host) { paintWhen(); paintReady(); }
}

export function unmount() {
  stopBus();
  if (host) host.innerHTML = "";
  host = null;
}
