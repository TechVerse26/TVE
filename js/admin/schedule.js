// ==========================================================================
// admin/schedule.js — Exam Schedule management.
//
// A "schedule" is not a separate record: it is the time/visibility part of the exam document itself
// (publishAt, closesAt, duration, status + a few small flags — see schedule-core.js). That keeps every
// existing exam, result and student view working exactly as before, and means a change here is one small
// update of exams/{id} (+ the students' index), never a rewrite of questions.
//
//   Create / edit  → start, end (closing time), duration, publish state, registration, visibility, reminders, featured
//   Publish        → status published | draft            Cancel / Restore → "Not Available" for students
//   Remove         → clears the dates and moves the exam back to Draft
//   Participants   → refreshes the "Participants" numbers shown on the student home page (aggregate counts, ≈1 read / exam)
// ==========================================================================
import { Timestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, openModal, closeModal } from "../utils.js";
import { fetchAllExamsAdmin } from "../exam-data.js";
import {
  esc, $, fmtDateTime, pageHead, chip, segmented, bindSegmented, createTable, confirmDanger, withBusy, debounce,
  errorState, skeleton, toLocalInput, fromLocalInput, ago,
} from "./core/ui.js";
import { can } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { onChange, takePending } from "./core/bus.js";
import { loadTaxonomy, subjectName, categoryPath } from "./core/taxonomy.js";
import { patchExamFields } from "./core/exam-ops.js";
import { participantCounts } from "./core/data.js";
import { validateSchedule, buildSchedulePatch, removeSchedulePatch, toFirestorePatch } from "./core/schedule-edit.js";
import { getHomeFeed, writeFeedFields } from "../home-data.js";
import { adminScheduleState, ADMIN_SCHEDULE_META, DIFFICULTY, toMs } from "../schedule-core.js";
import { hasSchedule } from "../home-core.js";
import { serverNow, syncServerTime } from "../server-time.js";

const META = { ...ADMIN_SCHEDULE_META, unscheduled: { label: "No schedule", tone: "" } };
const PARTICIPANT_REFRESH_MS = 30 * 60 * 1000;

let root = null, table = null, exams = [], feed = null, stale = false, loadFailed = false;
const filters = { q: "", status: "all", subject: "" };

/* A live exam with neither a start nor an end is simply "always open" — call it that, not "Live". */
function stateOf(e) {
  const s = adminScheduleState(e, serverNow());
  return s === "live" && !hasSchedule(e) ? "unscheduled" : s;
}
const isLiveType = (e) => e.examType !== "practice";

export async function mount(el) {
  root = el;
  syncServerTime();
  await loadTaxonomy().catch(() => {});
  const canWrite = can("exams.write");
  root.innerHTML = `
    ${pageHead({
      title: "Exam Schedule",
      desc: "কখন পরীক্ষা শুরু ও শেষ হবে, কারা দেখবে, রিমাইন্ডার চলবে কিনা — সব এক জায়গা থেকে।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="sc-refresh" title="Re-read the exams"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${canWrite ? `<button type="button" class="btn btn-outline btn-sm" id="sc-participants" title="Update the participant counts students see (≈1 read per exam)"><i class="fa-solid fa-users"></i> Participants</button>
        <button type="button" class="btn btn-primary btn-sm" id="sc-new"><i class="fa-solid fa-plus"></i> New schedule</button>` : ""}`,
    })}
    <div class="panel">
      <div class="toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="sc-q" placeholder="Search exam, subject…" autocomplete="off"></div>
        <select id="sc-subject" aria-label="Subject"></select>
      </div>
      <div class="toolbar" id="sc-seg"></div>
      <p class="note" id="sc-note" hidden></p>
      <div id="sc-table"></div>
    </div>`;

  table = createTable({
    mount: $("#sc-table", root),
    defaultSort: { key: "start", dir: "desc" },
    empty: { icon: "fa-calendar-days", title: "কোনো শিডিউল নেই", text: "“New schedule” চাপুন, অথবা ফিল্টার বদলান।" },
    columns: columns(),
    rowClass: (r) => (r._state === "cancelled" ? "row-muted" : ""),
  });

  bindSegmented($("#sc-seg", root), (v) => { filters.status = v; paint(); });
  $("#sc-q", root).addEventListener("input", debounce((e) => { filters.q = e.target.value; paint(); }, 150));
  $("#sc-subject", root).addEventListener("change", (e) => { filters.subject = e.target.value; paint(); });
  $("#sc-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#sc-new", root)?.addEventListener("click", () => openEditor(null));
  $("#sc-participants", root)?.addEventListener("click", (e) => withBusy(e.currentTarget, () => refreshParticipants()));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const b = e.target.closest("[data-act]");
    if (!b) return;
    ({ edit: openEditor, toggle: togglePublish, cancel: toggleCancel, feature: toggleFeatured, remove: removeSchedule })[b.dataset.act]?.(b.dataset.id);
  });
  onChange((kind) => { if (kind === "exams") stale = true; });
  await load();
  if (takePending("new-schedule") && canWrite) openEditor(null);
}

export async function activate() {
  if (!table) return;
  if (loadFailed) return load();
  if (stale) { stale = false; exams = (await fetchAllExamsAdmin()).filter(isLiveType); }
  paint();
  if (takePending("new-schedule") && can("exams.write")) openEditor(null);
}

async function load({ force = false } = {}) {
  table.setState(skeleton(5));
  try {
    const [all, f] = await Promise.all([fetchAllExamsAdmin({ force }), getHomeFeed({ force })]);
    exams = all.filter(isLiveType);
    feed = f;
    loadFailed = false;
    stale = false;
    fillSubjects();
    paint();
    maybeAutoRefreshParticipants();
  } catch (err) {
    loadFailed = true;
    table.setState(errorState({ title: "শিডিউল লোড করা যায়নি", text: err?.message || "" }));
  }
}

function fillSubjects() {
  const sel = $("#sc-subject", root);
  const used = [...new Set(exams.map((e) => e.subjectId).filter(Boolean))];
  sel.innerHTML = `<option value="">All subjects</option>${used.map((id) => `<option value="${esc(id)}">${esc(subjectName(id) || id)}</option>`).join("")}`;
  sel.value = used.includes(filters.subject) ? filters.subject : "";
  filters.subject = sel.value;
}

function rows() {
  const q = filters.q.trim().toLowerCase();
  return exams
    .map((e) => ({ ...e, _state: stateOf(e) }))
    .filter((e) => (filters.status === "all" || e._state === filters.status)
      && (!filters.subject || e.subjectId === filters.subject)
      && (!q || `${e.title} ${e.courseName || ""} ${subjectName(e.subjectId)} ${categoryPath(e.categoryId)}`.toLowerCase().includes(q)));
}

function paint() {
  const all = exams.map(stateOf);
  const count = (k) => all.filter((s) => s === k).length;
  $("#sc-seg", root).innerHTML = segmented([
    { id: "all", label: "All", count: exams.length },
    ...["scheduled", "live", "completed", "draft", "cancelled", "unscheduled"].map((k) => ({ id: k, label: META[k].label, count: count(k) })),
  ], filters.status);
  const note = $("#sc-note", root);
  const at = feed?.participantsAt;
  note.hidden = false;
  note.innerHTML = `Times are in <b>your</b> time zone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || "local")}); students see them in theirs. “Closes” is the last moment a student can <b>start</b> — the time limit then runs from their start.${at ? ` Participant counts updated <b>${esc(ago(at))}</b>.` : ""}`;
  table.setRows(rows(), { keepPage: true });
}

/* ---------- table ---------- */
function columns() {
  const canWrite = can("exams.write");
  return [
    { key: "title", label: "Exam", sortable: true, sortValue: (e) => e.title || "", render: (e) => {
      const sub = [subjectName(e.subjectId), categoryPath(e.categoryId)].filter(Boolean).join(" · ");
      return `<div class="cell-main"><div class="t">${e.featured ? '<i class="fa-solid fa-star" style="color:var(--accent-amber)" title="Featured"></i> ' : ""}${esc(e.title || "Untitled")}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
    } },
    { key: "state", label: "Status", sortable: true, sortValue: (e) => e._state, render: (e) => chip(META[e._state].label, META[e._state].tone) },
    { key: "start", label: "Starts", sortable: true, sortValue: (e) => toMs(e.publishAt) || null, render: (e) => (toMs(e.publishAt) ? `<span class="nowrap">${esc(fmtDateTime(e.publishAt))}</span>` : '<span class="muted">—</span>') },
    { key: "end", label: "Closes", sortable: true, sortValue: (e) => toMs(e.closesAt) || null, render: (e) => (toMs(e.closesAt) ? `<span class="nowrap">${esc(fmtDateTime(e.closesAt))}</span>` : '<span class="muted">No end</span>') },
    { key: "dur", label: "Time limit", cls: "c-num", sortable: true, sortValue: (e) => Number(e.duration) || 0, render: (e) => `${Number(e.duration) || 0} min` },
    { key: "flags", label: "Options", render: (e) => [
      e.registration === "closed" ? chip("Registration closed", "amber", "fa-user-lock") : "",
      e.visibility === "unlisted" ? chip("Unlisted", "", "fa-eye-slash") : "",
      e.reminderEnabled === false ? chip("No reminders", "", "fa-bell-slash") : "",
      DIFFICULTY[e.difficulty] ? chip(DIFFICULTY[e.difficulty].label, "", "fa-gauge") : "",
    ].join(" ") || '<span class="muted">—</span>' },
    { key: "people", label: "Participants", cls: "c-num", sortable: true, sortValue: (e) => Number(feed?.participants?.[e.id]) || 0, render: (e) => (feed?.participants?.[e.id] !== undefined ? String(feed.participants[e.id]) : '<span class="muted">—</span>') },
    { key: "act", label: "", cls: "c-act", render: (e) => (canWrite ? `<div class="row-actions">
      <button type="button" class="icon-btn" data-act="edit" data-id="${e.id}" title="Edit schedule"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="icon-btn" data-act="feature" data-id="${e.id}" title="${e.featured ? "Remove from Featured" : "Mark as Featured"}"><i class="fa-${e.featured ? "solid" : "regular"} fa-star"></i></button>
      <button type="button" class="icon-btn" data-act="toggle" data-id="${e.id}" title="${e.status === "draft" ? "Publish" : "Unpublish (move to draft)"}"><i class="fa-solid ${e.status === "draft" ? "fa-eye" : "fa-eye-slash"}"></i></button>
      <button type="button" class="icon-btn" data-act="cancel" data-id="${e.id}" title="${e.cancelled ? "Restore the schedule" : "Cancel the schedule (students see “Not Available”)"}"><i class="fa-solid ${e.cancelled ? "fa-rotate-left" : "fa-ban"}"></i></button>
      <button type="button" class="icon-btn danger" data-act="remove" data-id="${e.id}" title="Remove the schedule (back to draft)"><i class="fa-solid fa-calendar-minus"></i></button>
    </div>` : "") },
  ];
}

const find = (id) => exams.find((e) => e.id === id);

/* ---------- row actions ---------- */
async function togglePublish(id) {
  const e = find(id);
  if (!e) return;
  const next = e.status === "draft" ? "published" : "draft";
  if (next === "published" && !(Number(e.questionCount) > 0)) { toast(`"${e.title}" এ কোনো প্রশ্ন নেই — প্রকাশের আগে প্রশ্ন যোগ করুন`, "error"); return; }
  try {
    await patchExamFields([{ id, patch: { status: next } }]);
    logAction(next === "draft" ? "exam.unpublish" : "exam.publish", { type: "exam", id, label: e.title, detail: "from Exam Schedule" });
    toast(next === "draft" ? "আনপাবলিশ হয়েছে (Draft)" : "পাবলিশ হয়েছে", "success");
    await refreshLocal();
  } catch { toast("স্ট্যাটাস বদলানো যায়নি", "error"); }
}

async function toggleCancel(id) {
  const e = find(id);
  if (!e) return;
  const cancelling = e.cancelled !== true;
  if (cancelling && !(await confirmDanger({ title: "শিডিউল বাতিল করবেন?", message: `"${e.title}" শিক্ষার্থীদের কাছে “Not Available” দেখাবে এবং কেউ শুরু করতে পারবে না। পরে আবার Restore করা যাবে।`, confirmLabel: "Cancel schedule", tone: "amber" }))) return;
  try {
    await patchExamFields([{ id, patch: { cancelled: cancelling, scheduleUpdatedAt: Timestamp.now() } }]);
    logAction(cancelling ? "schedule.cancel" : "schedule.restore", { type: "exam", id, label: e.title });
    toast(cancelling ? "শিডিউল বাতিল করা হয়েছে" : "শিডিউল আবার চালু হয়েছে", "success");
    await refreshLocal();
  } catch { toast("বদলানো যায়নি", "error"); }
}

async function toggleFeatured(id) {
  const e = find(id);
  if (!e) return;
  try {
    await patchExamFields([{ id, patch: { featured: e.featured !== true } }]);
    logAction("exam.feature", { type: "exam", id, label: e.title, detail: e.featured ? "removed from Featured" : "marked Featured" });
    await refreshLocal();
  } catch { toast("বদলানো যায়নি", "error"); }
}

async function removeSchedule(id) {
  const e = find(id);
  if (!e) return;
  if (!(await confirmDanger({ title: "শিডিউল মুছবেন?", message: `"${e.title}" এর শুরু/শেষের সময় মুছে যাবে এবং এক্সামটি Draft হয়ে লুকিয়ে যাবে — যাতে ভুলে সবার জন্য খোলা না থাকে। প্রশ্ন ও রেজাল্ট অক্ষত থাকবে।`, confirmLabel: "Remove schedule", phrase: "REMOVE" }))) return;
  try {
    await patchExamFields([{ id, patch: removeSchedulePatch() }]);
    logAction("schedule.delete", { type: "exam", id, label: e.title });
    toast("শিডিউল মুছে ফেলা হয়েছে — এক্সামটি এখন Draft", "success");
    await refreshLocal();
  } catch { toast("মোছা যায়নি", "error"); }
}

async function refreshLocal() {
  exams = (await fetchAllExamsAdmin()).filter(isLiveType); // already primed by patchExamFields → no read
  paint();
}

/* ---------- participants (student home page numbers) ---------- */
async function refreshParticipants() {
  const ids = exams.filter((e) => ["live", "scheduled", "completed"].includes(stateOf(e)) || e.featured === true).map((e) => e.id).slice(0, 40);
  if (!ids.length) { toast("আপডেট করার মতো কোনো এক্সাম নেই", "info"); return; }
  try {
    const counts = await participantCounts(ids);
    await writeFeedFields({ participants: counts, participantsAt: Date.now() });
    feed = await getHomeFeed({ force: true });
    toast("Participant সংখ্যা আপডেট হয়েছে", "success");
    paint();
  } catch (err) {
    toast(err?.code === "permission-denied" ? "Firestore rules এখনো পাবলিশ করা হয়নি (homeFeed)" : "আপডেট করা যায়নি", "error");
  }
}
/** While an exam is live the numbers matter: refresh them at most every 30 minutes, only for people allowed to. */
function maybeAutoRefreshParticipants() {
  if (!can("exams.write") || !exams.some((e) => stateOf(e) === "live")) return;
  if (Date.now() - (feed?.participantsAt || 0) < PARTICIPANT_REFRESH_MS) return;
  refreshParticipants();
}

/* ==========================================================================
   Editor (create / edit one exam's schedule)
   ========================================================================== */
function openEditor(examId) {
  const fixed = examId ? find(examId) : null;
  if (examId && !fixed) return;
  const candidates = exams.slice().sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  const hour = 3600000;
  const defaultStart = Math.ceil((serverNow() + hour) / (5 * 60000)) * 5 * 60000;

  const overlay = openModal(`
    <div class="modal-head"><h3>${fixed ? "Edit schedule" : "New schedule"}</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <form id="sc-form" novalidate>
      <div class="field">
        <label for="sc-exam">Exam</label>
        <select id="sc-exam" ${fixed ? "disabled" : ""}>
          ${fixed ? `<option value="${esc(fixed.id)}">${esc(fixed.title)}</option>` : `<option value="">— Choose an exam —</option>${candidates.map((e) => `<option value="${esc(e.id)}">${esc(e.title)}${hasSchedule(e) ? " (already scheduled)" : ""}</option>`).join("")}`}
        </select>
        <span class="form-hint">Need a brand-new exam first? Create it under <b>Exams</b>, then schedule it here.</span>
      </div>
      <div class="schedule-box">
        <div class="schedule-box-title"><i class="fa-solid fa-calendar-days"></i> When</div>
        <div class="admin-grid">
          <div class="field"><label for="sc-start">Starts (date & time)</label><input type="datetime-local" id="sc-start"></div>
          <div class="field"><label for="sc-end">Closes (last time to start)</label><input type="datetime-local" id="sc-end">
            <span class="form-hint">Empty = stays open. <button type="button" class="link-btn" data-end="2">+2h</button> <button type="button" class="link-btn" data-end="24">+24h</button> <button type="button" class="link-btn" data-end="48">+48h</button> <button type="button" class="link-btn" data-end="0">No end</button></span></div>
        </div>
        <div class="admin-grid">
          <div class="field"><label for="sc-duration">Time limit (minutes)</label><input type="number" id="sc-duration" min="1" max="600" step="1"></div>
          <div class="field"><label for="sc-difficulty">Difficulty</label><select id="sc-difficulty"><option value="">— Not set —</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
        </div>
      </div>
      <div class="admin-grid">
        <div class="field"><label for="sc-status">Publish state</label><select id="sc-status"><option value="published">Published — visible to students</option><option value="draft">Draft — hidden</option></select></div>
        <div class="field"><label for="sc-reg">Registration</label><select id="sc-reg"><option value="open">Open — students can start</option><option value="closed">Closed — no new starts (running attempts finish)</option></select></div>
        <div class="field"><label for="sc-vis">Visibility</label><select id="sc-vis"><option value="public">Public — listed everywhere</option><option value="unlisted">Unlisted — direct link only</option></select></div>
      </div>
      <label class="switch-row"><input type="checkbox" id="sc-remind"> Students can set a reminder for this exam</label>
      <label class="switch-row"><input type="checkbox" id="sc-featured"> Featured exam (shown prominently on the home page)</label>
      <p class="note warn" id="sc-warn" hidden></p>
      <p class="note bad" id="sc-errors" hidden></p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button>
        <button type="submit" class="btn btn-primary btn-block" id="sc-save">Save schedule</button>
      </div>
    </form>`);

  const el = (id) => overlay.querySelector(`#${id}`);
  const fill = (e) => {
    const hasTimes = !!(toMs(e?.publishAt) || toMs(e?.closesAt));
    el("sc-start").value = toLocalInput(hasTimes ? e.publishAt : defaultStart);
    el("sc-end").value = hasTimes ? toLocalInput(e.closesAt) : toLocalInput(defaultStart + 24 * hour);
    el("sc-duration").value = Number(e?.duration) || 20;
    el("sc-difficulty").value = e?.difficulty || "";
    el("sc-status").value = e?.status === "draft" ? "draft" : "published";
    el("sc-reg").value = e?.registration === "closed" ? "closed" : "open";
    el("sc-vis").value = e?.visibility === "unlisted" ? "unlisted" : "public";
    el("sc-remind").checked = e?.reminderEnabled !== false;
    el("sc-featured").checked = e?.featured === true;
  };
  fill(fixed || null);
  el("sc-exam").addEventListener("change", (ev) => { const e = find(ev.target.value); if (e) fill(e); });
  overlay.querySelectorAll("[data-end]").forEach((b) => b.addEventListener("click", () => {
    const start = fromLocalInput(el("sc-start").value);
    const h = Number(b.dataset.end);
    el("sc-end").value = !h ? "" : toLocalInput((start ? start.getTime() : defaultStart) + h * hour);
  }));

  const read = () => {
    const s = fromLocalInput(el("sc-start").value), e = fromLocalInput(el("sc-end").value);
    return {
      start: s ? s.getTime() : null, end: e ? e.getTime() : null, duration: el("sc-duration").value,
      status: el("sc-status").value, registration: el("sc-reg").value, visibility: el("sc-vis").value,
      remind: el("sc-remind").checked, featured: el("sc-featured").checked, difficulty: el("sc-difficulty").value,
    };
  };
  const showErrors = (list) => { const b = el("sc-errors"); b.hidden = !list.length; b.innerHTML = list.map(esc).join("<br>"); };

  // Gentle heads-up when a published exam would open immediately or has already ended.
  const warn = () => {
    const f = read(), now = serverNow(), w = [];
    if (f.status === "published" && f.start === null) w.push("শুরুর সময় ফাঁকা — প্রকাশ করলে এক্সামটি সাথে সাথে সবার জন্য খুলে যাবে।");
    if (f.end !== null && f.end < now) w.push("শেষ সময় অতীতে — শিক্ষার্থীরা এটি শুরু করতে পারবে না।");
    const box = el("sc-warn"); box.hidden = !w.length; box.innerHTML = w.map(esc).join("<br>");
  };
  overlay.addEventListener("input", warn); overlay.addEventListener("change", warn); warn();

  el("sc-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const target = find(fixed ? fixed.id : el("sc-exam").value);
    if (!target) { showErrors(["একটি এক্সাম বেছে নিন।"]); return; }
    const f = read();
    const errors = validateSchedule(f, target);
    showErrors(errors);
    if (errors.length) return;
    const { patch, stamped, changes } = buildSchedulePatch(target, f, Date.now());
    await withBusy(el("sc-save"), async () => {
      try {
        await patchExamFields([{ id: target.id, patch: toFirestorePatch(patch, Timestamp) }]);
        const first = !hasSchedule(target);
        logAction(first ? "schedule.create" : "schedule.update", { type: "exam", id: target.id, label: target.title, detail: first ? `starts ${fmtDateTime(patch.publishAt)}` : changes.join(", ") || "options" });
        if (target.featured !== patch.featured) logAction("exam.feature", { type: "exam", id: target.id, label: target.title, detail: patch.featured ? "marked Featured" : "removed from Featured" });
        toast(stamped ? "শিডিউল সেভ হয়েছে — শিক্ষার্থীরা “সময়সূচি আপডেট” নোটিফিকেশন পাবে" : "শিডিউল সেভ হয়েছে", "success");
        closeModal();
        await refreshLocal();
      } catch (err) {
        showErrors([err?.code === "permission-denied" ? "অনুমতি নেই (Firestore rules)।" : "সেভ করা যায়নি — আবার চেষ্টা করুন।"]);
      }
    });
  });
}
