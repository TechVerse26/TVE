// ==========================================================================
// admin/email/send.js — previewing, test-sending and (above all) SENDING.
//
// How a campaign is sent — the rules this file exists to keep
//   1. NOTHING leaves before the campaign + every recipient row is saved in Firestore (so there is always a record).
//   2. One e-mail at a time, ≥ 1.1 s apart (EmailJS documents 1 request/second); HTTP 429 is backed off, never hammered.
//   3. WRITE-AHEAD checkpoints: before a chunk of 20 recipients is tried, those 20 are stored as "sending"; afterwards their
//      real outcome is stored. If the tab dies mid-chunk, those rows read back as "uncertain" — a resume NEVER re-sends them
//      unless the admin explicitly asks to. Rows that were accepted are never sent again, by any path.
//   4. "accepted" means EmailJS answered 200 — NOT that the inbox received it. The UI says so everywhere.
//   5. A student who has submitted the exam since the list was prepared is skipped at the moment of sending.
//   6. Only ONE run can exist at a time and the Send button is locked synchronously → double clicks cannot start two.
// ==========================================================================
import { closeModal, openModal, toast, downloadCsv } from "../../utils.js";
import { esc, chip, fmtN, withBusy } from "../core/ui.js";
import { logAction } from "../core/audit.js";
import { serverNow } from "../../server-time.js";
import {
  CAMPAIGN_TYPES, REASONS, ROW_STATUS, CAMPAIGN_STATUS, totalsOf, recoverRows, selectForRun, campaignStatusFor, isStale, outcomeNote, campaignCsv,
  isValidEmail, accountIssue, classifyStudents, typeAllowed, fmtEta,
} from "../../email-core.js";
import { sanitizeContent, paramsSize, sampleValues, EMAILJS_REQUEST_LIMIT_BYTES, buildEmailParams } from "../../email-render.js";
import { sendOne, runQueue, explainOutcome, estimateMs, MIN_INTERVAL_MS, configFingerprint } from "../../email-service.js";
import { contentFor, templateById } from "../../email-templates-data.js";
import * as store from "./store.js";
import { S, emit } from "./state.js";
import {
  readiness, finalPlan, ctxFromDraft, valuesFor, renderWith, paramsFor, site, replyToOf, ensureExamData, isExamType,
  refreshCampaigns, refreshSettings, recompute, settingsState,
} from "./model.js";

const CHUNK = 20;            // recipients stored as "sending" ahead of each batch (write-ahead)
const CHECKPOINT_EVERY = 5;  // and their real outcomes are saved after every 5 results
const HEARTBEAT_MS = 30_000;
const REFRESH_RESULTS_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let startLock = false;
async function whenIdle() { for (let i = 0; i < 60 && (startLock || S.sending); i++) await sleep(50); }

/* ==========================================================================
   Small dialog toolkit (focus goes in, is trapped, and returns to where it came from)
   ========================================================================== */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function trapFocus(root) {
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
function dialog(html, { wide = false, focus = "", onClose = null, opener: given = null } = {}) {
  const opener = given || document.activeElement;
  const overlay = openModal(html);
  const box = overlay.querySelector(".modal-box");
  box.classList.add("em-dialog");
  if (wide) box.classList.add("wide");
  box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
  const h = box.querySelector("h3"); if (h) { h.id ||= `em-dlg-${Date.now()}`; box.setAttribute("aria-labelledby", h.id); }
  trapFocus(box);
  const close = () => closeModal();
  const onKey = (e) => { if (e.key === "Escape" && document.body.contains(overlay)) { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  // however the dialog goes away (✕, backdrop, Escape, closeModal() elsewhere) — give the focus back and tell the caller once
  const watcher = new MutationObserver(() => {
    if (document.body.contains(overlay)) return;
    watcher.disconnect();
    document.removeEventListener("keydown", onKey, true);
    if (opener && document.contains(opener)) opener.focus?.();
    onClose?.();
  });
  watcher.observe(document.body, { childList: true });
  requestAnimationFrame(() => (focus ? box.querySelector(focus) : box.querySelector("[autofocus]") || box.querySelector(FOCUSABLE))?.focus());
  return { overlay, box, close, opener };
}
const nameOf = (s) => s?.name || s?.email || "—";
const maskEmail = (e) => String(e || "").replace(/^(.).*(@.*)$/, "$1•••$2");

export const describeAudience = (d = S.draft) => {
  const t = CAMPAIGN_TYPES[d.type];
  const exam = d.examId ? S.examsById.get(d.examId) : null;
  const bits = [];
  if (d.mode === "exam" && exam) bits.push(`${exam.title || exam.id}: ${d.groups.map((g) => g.replaceAll("_", " ")).join(" + ")}`);
  else if (d.mode === "course") bits.push(`Course: ${d.courseIds.map((c) => S.courseTitle.get(c) || c).join(", ") || "—"}`);
  else if (d.mode === "all") bits.push("All eligible students");
  else bits.push("Hand-picked students");
  return `${t?.label || d.type} · ${bits.join(" · ")}`;
};
export function autoName(d = S.draft) {
  const exam = d.examId ? S.examsById.get(d.examId) : null;
  const day = new Date(serverNow()).toISOString().slice(0, 10);
  return `${CAMPAIGN_TYPES[d.type]?.label || "Campaign"}${exam ? ` — ${exam.title || exam.id}` : ""} — ${day}`.slice(0, 160);
}

/* ==========================================================================
   Preview
   ========================================================================== */
export function openPreview() {
  const D = S.derived;
  const ctx = ctxFromDraft();
  const list = D.sendable.slice(0, 300);
  const sampleStudent = { uid: "sample", name: "", email: "", roll: "", studentId: "", courseIds: [] };
  const optHtml = (r) => `<option value="${esc(r.uid)}">${esc(nameOf(r.student))} — ${esc(r.student.email)}</option>`;
  const { box, close, opener } = dialog(`
    <div class="modal-head"><h3>Email preview</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="em-pv-bar">
      <div class="field"><label for="pv-who">Preview as</label>
        <select id="pv-who">${list.length ? list.map(optHtml).join("") : ""}<option value="__sample"${list.length ? "" : " selected"}>Sample student (fake data)</option></select>
        ${D.sendable.length > list.length ? `<small class="form-hint">প্রথম ${list.length} জন দেখানো হচ্ছে (মোট ${fmtN(D.sendable.length)})</small>` : ""}</div>
      <div class="field"><label>Screen</label><div class="seg" role="group" aria-label="Preview width"><button type="button" class="seg-btn on" data-w="desktop">Desktop</button><button type="button" class="seg-btn" data-w="mobile">Mobile</button></div></div>
    </div>
    <dl class="em-pv-meta" id="pv-meta"></dl>
    <div id="pv-issues"></div>
    <div class="seg" role="group" aria-label="Preview format"><button type="button" class="seg-btn on" data-v="html">Email</button><button type="button" class="seg-btn" data-v="text">Plain text</button></div>
    <div class="em-pv-frame" id="pv-frame"></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Close</button><button type="button" class="btn btn-primary btn-block" id="pv-test"><i class="fa-solid fa-flask-vial"></i> Send a test email</button></div>`, { wide: true, focus: "#pv-who" });
  let view = "html", width = "desktop";
  const frame = box.querySelector("#pv-frame");
  const draw = () => {
    const uid = box.querySelector("#pv-who").value;
    const pick = D.sendable.find((r) => r.uid === uid);
    const student = pick ? pick.student : sampleStudent;
    const values = pick ? valuesFor(ctx, student, pick.cls) : sampleValues({ lang: ctx.lang, site: site(), testEmail: S.settings.testEmail, exam: ctx.exam });
    const out = renderWith(ctx, values);
    const params = buildEmailParams({ recipient: { email: values.student_email || "", name: values.student_name || "" }, rendered: out, values, sender: { name: S.settings.senderName, replyTo: replyToOf(S.settings) } });
    const size = paramsSize(params);
    box.querySelector("#pv-meta").innerHTML = `
      <div><dt>To</dt><dd>${esc(values.student_name || "—")} &lt;${esc(values.student_email || "—")}&gt;</dd></div>
      <div><dt>From</dt><dd>${esc(S.settings.senderName)} <small>(পাঠানোর ঠিকানা = EmailJS-এ সংযুক্ত ইমেইল সার্ভিসের ঠিকানা)</small></dd></div>
      <div><dt>Reply-to</dt><dd>${esc(replyToOf(S.settings))}</dd></div>
      <div><dt>Subject</dt><dd><b>${esc(out.subject || "—")}</b></dd></div>
      <div><dt>Size</dt><dd>${(size / 1024).toFixed(1)} KB <small>of ${EMAILJS_REQUEST_LIMIT_BYTES / 1024} KB per EmailJS request</small></dd></div>`;
    const issues = [];
    if (!pick) issues.push(["info", "এটি নমুনা তথ্য — কোনো আসল শিক্ষার্থীর নয়।"]);
    if (out.unknown.length) issues.push(["bad", `অজানা ভেরিয়েবল: ${out.unknown.map((k) => `{{${k}}}`).join(", ")}`]);
    if (out.missing.length) issues.push(["warn", `এই প্রাপকের জন্য তথ্য নেই: ${out.missing.map((k) => `{{${k}}}`).join(", ")} ${ctx.policy === "fallback" ? "(“Not available” দেখাবে)" : ctx.policy === "skip" ? "(এঁকে বাদ দেওয়া হবে)" : "(পাঠানো আটকে যাবে)"}`]);
    if (out.fallbackUsed.length) issues.push(["info", `ফলব্যাক টেক্সট ব্যবহার হয়েছে: ${out.fallbackUsed.map((k) => `{{${k}}}`).join(", ")}`]);
    if (size > EMAILJS_REQUEST_LIMIT_BYTES) issues.push(["bad", "ইমেইলটি EmailJS-এর সীমার চেয়ে বড়।"]);
    box.querySelector("#pv-issues").innerHTML = issues.map(([tone, t]) => `<div class="note ${tone === "bad" ? "bad" : tone === "warn" ? "warn" : ""}"><i class="fa-solid ${tone === "info" ? "fa-circle-info" : "fa-triangle-exclamation"}"></i> ${esc(t)}</div>`).join("");
    frame.innerHTML = "";
    if (view === "html") {
      const f = document.createElement("iframe");
      f.title = "Rendered email"; f.setAttribute("sandbox", ""); f.tabIndex = -1; f.className = `em-pv-iframe ${width}`; // not in the tab order: keys pressed inside a frame never reach the dialog (Escape / focus trap)
      f.srcdoc = out.html;
      frame.appendChild(f);
    } else {
      const pre = document.createElement("pre"); pre.className = "em-pv-text"; pre.tabIndex = 0; pre.setAttribute("aria-label", "Plain-text version of the email"); pre.textContent = out.text; frame.appendChild(pre);
    }
  };
  box.querySelector("#pv-who").addEventListener("change", draw);
  box.addEventListener("click", (e) => {
    const w = e.target.closest("[data-w]"); if (w) { width = w.dataset.w; box.querySelectorAll("[data-w]").forEach((b) => b.classList.toggle("on", b === w)); draw(); return; }
    const v = e.target.closest("[data-v]"); if (v) { view = v.dataset.v; box.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("on", b === v)); draw(); return; }
    if (e.target.closest("#pv-test")) { const who = box.querySelector("#pv-who").value; close(); openTestSend(who, { opener }); }
  });
  draw();
}

/* ==========================================================================
   Test send — only ever to the one address typed here
   ========================================================================== */
async function pace() {
  const gap = Math.max(MIN_INTERVAL_MS, S.settings.intervalMs || 0);
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}
/** Record a successful/failed REAL request as the "last test" of the current configuration (when settings are saved). */
async function recordRealTest(to, outcome) {
  if (S.settingsMeta.source !== "saved") return;
  try {
    await store.recordTest({ ok: outcome.ok, at: Date.now(), fp: configFingerprint(S.settings), to: maskEmail(to), status: outcome.status, text: outcome.text });
    await refreshSettings();
  } catch { /* the test itself succeeded or failed on its own merits; only the memo could not be saved */ }
}

/** `who`: a recipient uid, "__sample" for fake data, or "" for the settings page (always fake data). */
/** The Settings page's test: a plain built-in message, so a blank Compose draft can never make a test fail or look odd. */
function testCtx() {
  return { ...ctxFromDraft(), content: contentFor(templateById("general"), S.draft.lang), policy: "fallback", exam: null, type: "announcement", personalMessage: "" };
}
export function openTestSend(who = "__sample", { opener = null } = {}) {
  const st = settingsState();
  const ctx = who === "" ? testCtx() : ctxFromDraft();
  const D = S.derived;
  const { box, close } = dialog(`
    <div class="modal-head"><h3>Send a test email</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <p class="confirm-msg">টেস্ট ইমেইল <b>শুধু নিচের একটি ঠিকানায়</b> যাবে — কোনো শিক্ষার্থীর কাছে নয়।</p>
    ${st.complete ? "" : `<div class="note bad"><i class="fa-solid fa-triangle-exclamation"></i> EmailJS কনফিগারেশন অসম্পূর্ণ — আগে Email Settings সেভ করুন।</div>`}
    <div class="field"><label for="ts-to">Test address</label><input type="email" id="ts-to" autocomplete="email" value="${esc(S.settings.testEmail || S.me?.email || "")}" placeholder="you@example.com"></div>
    <label class="em-check"><input type="checkbox" id="ts-sample" checked> Use sample data <small>(প্রস্তাবিত — কোনো আসল শিক্ষার্থীর তথ্য বাইরে যায় না)</small></label>
    <div class="field" id="ts-real" hidden><label for="ts-who">Use this student's real data</label>
      <select id="ts-who">${D.sendable.slice(0, 300).map((r) => `<option value="${esc(r.uid)}" ${r.uid === who ? "selected" : ""}>${esc(nameOf(r.student))} — ${esc(r.student.email)}</option>`).join("")}</select>
      <div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> এই ইমেইলে ওই শিক্ষার্থীর আসল নাম, ইমেইল ও রোল থাকবে এবং তা উপরের ঠিকানায় যাবে।</div></div>
    <div id="ts-result" role="status" aria-live="polite"></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Close</button><button type="button" class="btn btn-primary btn-block" id="ts-send" ${st.complete ? "" : "disabled"}><i class="fa-solid fa-paper-plane"></i> Send test</button></div>`, { focus: "#ts-to", opener });
  const sampleBox = box.querySelector("#ts-sample");
  const real = box.querySelector("#ts-real");
  sampleBox.addEventListener("change", () => { real.hidden = sampleBox.checked || !D.sendable.length; });
  if (!D.sendable.length || who === "") { sampleBox.disabled = true; if (who === "") box.querySelector(".em-check")?.setAttribute("hidden", ""); }
  const btn = box.querySelector("#ts-send");
  let busy = false;
  btn.addEventListener("click", async () => {
    if (busy) return;
    const to = box.querySelector("#ts-to").value.trim();
    const out = box.querySelector("#ts-result");
    if (!isValidEmail(to)) { out.innerHTML = `<div class="note bad">ঠিকানাটি ঠিক নয়।</div>`; return; }
    busy = true;
    await withBusy(btn, async () => {
      const useSample = sampleBox.checked;
      const pick = useSample ? null : D.sendable.find((r) => r.uid === box.querySelector("#ts-who").value);
      const values = pick ? valuesFor(ctx, pick.student, pick.cls) : sampleValues({ lang: ctx.lang, site: site(), testEmail: to, exam: ctx.exam });
      const rendered = renderWith(ctx, values);
      const params = buildEmailParams({ recipient: { email: to, name: "Test" }, rendered: { ...rendered, subject: `[TEST] ${rendered.subject}` }, values, sender: { name: S.settings.senderName, replyTo: replyToOf(S.settings) } });
      params.to_email = to; // the ONE address — never a student's
      if (paramsSize(params) > EMAILJS_REQUEST_LIMIT_BYTES) { out.innerHTML = `<div class="note bad">ইমেইলটি EmailJS-এর সীমার চেয়ে বড়।</div>`; return; }
      await pace();
      const res = await sendOne(S.settings, params);
      logAction("email.test", { type: "email", label: "Test email", detail: `${res.ok ? "accepted" : `failed (${res.status || "no answer"})`} · to ${maskEmail(to)} · ${useSample ? "sample data" : "real student data"}` });
      await recordRealTest(to, res);
      out.innerHTML = res.ok
        ? `<div class="note ok"><i class="fa-solid fa-circle-check"></i> <b>EmailJS অনুরোধ গ্রহণ করেছে</b> (HTTP ${res.status}). ইনবক্সে পৌঁছেছে কিনা নিশ্চিত হতে <b>${esc(to)}</b> দেখুন (স্প্যাম ফোল্ডারসহ)।</div>`
        : `<div class="note bad"><i class="fa-solid fa-circle-xmark"></i> <b>পাঠানো যায়নি${res.status ? ` (HTTP ${res.status})` : ""}.</b> ${esc(explainOutcome(res))}<br><small>EmailJS: ${esc(res.text || "—")}</small></div>`;
    });
    busy = false;
  });
}

/* ==========================================================================
   Draft
   ========================================================================== */
export function campaignMetaOf(d, ctx = ctxFromDraft(d)) {
  const exam = ctx.exam;
  const D = S.derived;
  return {
    name: d.name.trim() || autoName(d), type: d.type, lang: d.lang, examId: d.examId, examTitle: exam?.title || "", courseIds: d.courseIds,
    subject: ctx.content.subject, content: ctx.content, templateId: d.templateId, templateName: d.templateName,
    personalMessage: d.personalMessage, deadlineMs: ctx.deadlineMs, missingPolicy: d.missingPolicy,
    audience: { mode: d.mode, groups: d.groups, summary: describeAudience(d) },
    senderName: S.settings.senderName, replyTo: replyToOf(S.settings), configFp: configFingerprint(S.settings), source: d.source,
    createdBy: S.me, fingerprint: "",
  };
}
export async function saveDraftNow(btn) {
  const d = S.draft;
  const isNew = !d.id;
  return withBusy(btn, async () => {
    try {
      if (isNew) d.id = store.newCampaignId();
      const meta = campaignMetaOf(d);
      if (!d.name.trim()) d.name = meta.name;
      await store.saveDraft(d.id, meta, [...d.selected], { isNew });
      if (isNew) logAction("email.campaign.draft", { type: "email-campaign", id: d.id, label: meta.name, detail: `${CAMPAIGN_TYPES[d.type].label} · ${d.selected.size} selected` });
      toast("ড্রাফট সেভ হয়েছে (Campaign History-তে পাবেন)", "success");
      refreshCampaigns();
      emit("draft");
      return true;
    } catch (err) {
      if (isNew) d.id = null;
      toast(err?.code === "permission-denied" ? "ড্রাফট সেভ করার অনুমতি নেই — firestore.rules Publish করুন" : `ড্রাফট সেভ হয়নি: ${err?.message || err}`, "error");
      return false;
    }
  });
}

/* ==========================================================================
   Sending
   ========================================================================== */
const rowOf = (r, status = "pending", note = "") => ({ uid: r.uid, name: r.name ?? r.student?.name ?? "", email: r.email ?? r.student?.email ?? "", roll: r.roll ?? r.student?.roll ?? "", status, tries: 0, at: status === "skipped" ? Date.now() : null, note });

/** The classification of every student for the run's exam, from the exam data currently in memory. */
function classificationMap(exam) {
  const map = new Map();
  if (!exam) return map;
  const ed = S.examData.get(exam.id);
  if (!ed || ed.status !== "ready") return map;
  classifyStudents({ students: S.students, exam, resultsByUid: ed.resultsByUid, sessionsByUid: ed.sessionsByUid }).rows.forEach((r) => map.set(r.uid, r));
  return map;
}

async function sendRow(run, row) {
  const skip = (note) => ({ ok: false, kind: "skipped", skipped: true, note, status: 0, text: note });
  const student = S.byUid.get(row.uid);
  const ctx = run.ctx;
  if (!student) return skip("Student no longer exists");
  const issue = accountIssue(student);
  if (issue) return skip(REASONS[issue]);
  if (!isValidEmail(student.email)) return skip(REASONS.invalid_email);
  let cls = null;
  if (isExamType(ctx.type) && ctx.exam) {
    cls = run.cls.get(row.uid) || null;
    if (cls?.status === "submitted") return skip(REASONS.submitted_since);
    if (cls && !cls.eligible) return skip(REASONS[cls.reason] || "Not eligible for this exam");
  }
  const values = valuesFor(ctx, student, cls);
  const rendered = renderWith(ctx, values);
  if (rendered.unknown.length) return skip(`Unknown variable: ${rendered.unknown.join(", ")}`);
  if (rendered.missing.length && ctx.policy !== "fallback") return skip(`${REASONS.missing_data}: ${rendered.missing.join(", ")}`);
  const params = paramsFor(ctx, student, values, rendered);
  if (paramsSize(params) > EMAILJS_REQUEST_LIMIT_BYTES) return skip("Email too large for one EmailJS request");
  await pace();
  return sendOne(ctx.settings, params);
}

function applyOutcome(row, outcome, tries) {
  row.at = Date.now();
  if (outcome.skipped) { row.status = "skipped"; row.note = outcome.note || "Skipped"; return; }
  row.tries = (row.tries || 0) + (tries || 1);
  if (outcome.ok) { row.status = "accepted"; row.note = "Request accepted by EmailJS"; }
  else if (outcome.kind === "uncertain") { row.status = "uncertain"; row.note = outcomeNote(outcome); }
  else { row.status = "failed"; row.note = outcomeNote(outcome); }
}

async function persist(run, touched, { status = "sending", extra = {} } = {}) {
  const dirty = new Set(touched.map((r) => store.partOf(r.index)));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await store.saveProgress(run.id, { rows: run.rows, dirtyParts: [...dirty], totals: totalsOf(run.rows), status, extra });
      run.persistFailed = false;
      return true;
    } catch (err) { run.persistError = err; await sleep(900); }
  }
  run.persistFailed = true;
  return false;
}

/** Screen Wake Lock while sending: a phone that falls asleep freezes the page and the run silently stalls. Best effort — unsupported or refused is fine. */
function keepAwake() {
  let lock = null, stopped = false;
  const get = async () => { try { if (!stopped && document.visibilityState === "visible") lock = await navigator.wakeLock?.request?.("screen"); } catch { /* not allowed / unsupported */ } };
  const onVisible = () => { if (document.visibilityState === "visible") get(); }; // the browser drops the lock when the tab is hidden
  document.addEventListener("visibilitychange", onVisible);
  get();
  return { release() { stopped = true; document.removeEventListener("visibilitychange", onVisible); try { lock?.release?.(); } catch { /* already released */ } } };
}

/** The engine. `todo` = the rows to try this time (already chosen by selectForRun). */
async function engine(run, todo) {
  S.sending = run;
  run.startedAt = Date.now(); run.stop = false; run.tripped = null; run.finished = false; run.waitingMs = 0;
  const onLeave = (e) => { e.preventDefault(); e.returnValue = ""; };
  window.addEventListener("beforeunload", onLeave);
  const awake = keepAwake();
  drawProgress(run);
  let lastBeat = Date.now();
  let sinceCheckpoint = 0;
  run.persistChain = Promise.resolve();
  try {
    for (let c = 0; c < todo.length && !run.stop && !run.tripped; c += CHUNK) {
      const chunk = todo.slice(c, c + CHUNK);
      // keep the exam picture fresh on long runs (someone may submit while we are sending)
      if (isExamType(run.ctx.type) && run.ctx.exam && Date.now() - (S.examData.get(run.ctx.exam.id)?.loadedAt || 0) > REFRESH_RESULTS_MS) {
        await ensureExamData(run.ctx.exam.id, { force: true });
        run.cls = classificationMap(run.ctx.exam);
      }
      // (3) write-ahead: store the chunk as "sending" BEFORE anything is attempted
      chunk.forEach((r) => { r.prev = r.status; r.status = "sending"; });
      drawProgress(run);
      if (!(await persist(run, chunk))) {
        chunk.forEach((r) => { r.status = r.prev; });
        run.tripped = { reason: "persist", text: "Progress could not be saved to Firestore (offline or permission). Stopped before sending anything more, so no email can go out unrecorded." };
        break;
      }
      const res = await runQueue({
        items: chunk, send: (row) => sendRow(run, row), intervalMs: run.ctx.settings.intervalMs, shouldStop: () => run.stop,
        onUpdate: (ev) => {
          if (ev.type === "start") { run.current = ev.item; drawProgress(run); }
          else if (ev.type === "wait") { run.waitingMs = ev.ms; run.waitReason = ev.reason || ""; drawProgress(run); }
          else if (ev.type === "done") {
            run.waitingMs = 0; run.current = null;
            applyOutcome(ev.item, ev.outcome, ev.tries);
            if (!ev.outcome.ok && !ev.outcome.skipped) run.lastError = { row: ev.item, outcome: ev.outcome };
            drawProgress(run);
            // a checkpoint every few results: a crash then loses the outcome of at most the last few e-mails (they read back as "uncertain")
            if (++sinceCheckpoint >= CHECKPOINT_EVERY) { sinceCheckpoint = 0; lastBeat = Date.now(); run.persistChain = run.persistChain.then(() => persist(run, chunk)).catch(() => {}); }
            else if (Date.now() - lastBeat > HEARTBEAT_MS) { lastBeat = Date.now(); store.saveProgress(run.id, { rows: run.rows, dirtyParts: [], totals: totalsOf(run.rows) }).catch(() => {}); }
          }
        },
      });
      chunk.forEach((r) => { if (r.status === "sending") r.status = r.prev; }); // never reached → still what it was
      await run.persistChain;
      await persist(run, chunk); // best effort: if this fails the stored "sending" rows read back as "uncertain" (the safe side)
      if (res.tripped) run.tripped = res.tripped;
      if (res.stopped) break;
    }
  } catch (err) {
    console.error("[email-center] run crashed", err);
    run.tripped = run.tripped || { reason: "crash", text: String(err?.message || err) };
    todo.forEach((r) => { if (r.status === "sending") r.status = "uncertain"; });
  } finally {
    window.removeEventListener("beforeunload", onLeave);
    awake.release();
  }
  await finish(run);
}

async function finish(run) {
  const totals = totalsOf(run.rows);
  const configError = run.tripped && ["not_allowed", "sdk", "persist"].includes(run.tripped.reason);
  const status = campaignStatusFor(totals, { stopped: run.stop && !run.tripped, configError });
  run.status = status; run.finished = true; run.finishedAt = Date.now();
  await persist(run, run.rows.filter((r) => r.index !== undefined), { status, extra: { finishedAt: store.serverStamp(), lastRun: { at: Date.now(), by: S.me?.name || "", stopped: !!run.stop, trip: run.tripped ? { reason: run.tripped.reason || "", status: run.tripped.status || 0, text: String(run.tripped.text || "").slice(0, 200) } : null } } });
  const detail = `accepted ${totals.accepted} · failed ${totals.failed} · uncertain ${totals.uncertain} · skipped ${totals.skipped} · pending ${totals.pending}`;
  const action = status === "completed" || status === "completed_errors" ? "email.campaign.complete" : status === "failed" ? "email.campaign.fail" : "email.campaign.interrupt";
  logAction(action, { type: "email-campaign", id: run.id, label: run.name, detail: `${detail}${run.tripped ? ` · ${run.tripped.reason || "stopped"}` : ""}` });
  S.lastRun = run;
  S.sending = null;
  drawProgress(run);
  await refreshCampaigns();
  emit("run-finished", run);
}

/** (the confirmation dialog) → Promise<boolean> */
function confirmSend(plan, r, extra) {
  const d = S.draft;
  const exam = S.derived.exam;
  const reasons = {};
  plan.skipped.forEach((s) => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
  const dup = r.warnings.find((w) => w.code === "duplicate");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; resolve(v); };
    const { box, close } = dialog(`
      <div class="modal-head"><h3>Send this campaign?</h3></div>
      <dl class="em-confirm">
        <div><dt>Campaign</dt><dd>${esc(d.name.trim() || autoName(d))}</dd></div>
        <div><dt>Type</dt><dd>${esc(CAMPAIGN_TYPES[d.type].label)}${exam ? ` · <b>${esc(exam.title || exam.id)}</b>` : ""}</dd></div>
        <div><dt>Audience</dt><dd>${esc(describeAudience(d))}</dd></div>
        <div><dt>Subject</dt><dd><b>${esc(d.content.subject)}</b></dd></div>
        <div><dt>Recipients</dt><dd><b class="em-big">${fmtN(plan.send.length)}</b> students — each gets <u>their own</u> personalised email (no CC/BCC)</dd></div>
        ${plan.skipped.length ? `<div><dt>Not included</dt><dd>${fmtN(plan.skipped.length)} <small>(${Object.entries(reasons).map(([k, n]) => `${n} × ${esc(REASONS[k] || k)}`).join(" · ")})</small></dd></div>` : ""}
        <div><dt>Speed</dt><dd>১টি ইমেইল প্রতি ≈ ${(Math.max(MIN_INTERVAL_MS, S.settings.intervalMs) / 1000).toFixed(1)} সেকেন্ডে → প্রায় <b>${fmtEta(estimateMs(plan.send.length, S.settings.intervalMs))}</b></dd></div>
      </dl>
      ${extra.removed ? `<div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> এইমাত্র ফলাফল আবার যাচাই করা হয়েছে — <b>${extra.removed} জন</b> ইতিমধ্যে জমা দিয়েছেন, তাই তাঁদের বাদ দেওয়া হয়েছে।</div>` : (extra.verified ? `<div class="note ok"><i class="fa-solid fa-circle-check"></i> ফলাফল এইমাত্র আবার যাচাই করা হয়েছে (${esc(new Date(extra.verified).toLocaleTimeString())})।</div>` : "")}
      ${r.warnings.filter((w) => w.code !== "duplicate").map((w) => `<div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w.message)}</div>`).join("")}
      ${dup ? `<div class="note bad"><i class="fa-solid fa-copy"></i> <b>সম্ভাব্য ডুপ্লিকেট:</b> ${esc(dup.message)}</div>` : ""}
      <div class="note"><i class="fa-solid fa-circle-info"></i> শুরু হলে পাঠানো ইমেইল অ্যাডমিন প্যানেল থেকে <b>ফেরত আনা যায় না</b>। “Request accepted” মানে EmailJS অনুরোধ নিয়েছে — ইনবক্সে পৌঁছানোর নিশ্চয়তা নয়। কাজ চলাকালে ট্যাবটি খোলা রাখুন।</div>
      <label class="em-check"><input type="checkbox" id="cf-ack"> আমি প্রিভিউ দেখেছি এবং বুঝেছি যে পাঠানো ইমেইল ফেরত নেওয়া যায় না</label>
      ${dup ? `<label class="em-check"><input type="checkbox" id="cf-dup"> আমি জানি অনুরূপ ক্যাম্পেইন আগে গেছে — তবুও আবার পাঠাতে চাই</label>` : ""}
      <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" id="cf-cancel">বাতিল</button><button type="button" class="btn btn-primary btn-block" id="cf-go" disabled><i class="fa-solid fa-paper-plane"></i> Send ${fmtN(plan.send.length)} emails</button></div>`, { focus: "#cf-ack", onClose: () => settle(false) });
    const go = box.querySelector("#cf-go");
    const sync = () => { go.disabled = !(box.querySelector("#cf-ack").checked && (!dup || box.querySelector("#cf-dup").checked)); };
    box.addEventListener("change", sync);
    box.querySelector("#cf-cancel").addEventListener("click", () => { settle(false); close(); });
    go.addEventListener("click", () => { go.disabled = true; settle(true); close(); }); // locked at once: a second click cannot start a second run
  });
}

function busyModal(text) {
  const { close } = dialog(`<div class="modal-head"><h3>${esc(text)}</h3></div><div class="em-busy"><span class="spinner"></span></div>`);
  return close;
}

/** The Send button. Returns once the run has finished (or was never started). */
export async function startCampaign() {
  if (startLock || S.sending) { toast("একটি ক্যাম্পেইন ইতিমধ্যে চলছে", "info"); return; }
  startLock = true;
  try {
    const d = S.draft;
    let r = readiness();
    if (!r.ok) { toast(r.blockers[0].message, "error"); return; }
    let removed = 0, verified = 0;
    if (isExamType(d.type) && d.examId) {
      const before = new Set(S.derived.sendable.map((x) => x.uid));
      const closeBusy = busyModal("ফলাফল আবার যাচাই করা হচ্ছে…");
      try { await ensureExamData(d.examId, { force: true }); recompute(); verified = Date.now(); } finally { closeBusy(); }
      removed = [...before].filter((u) => !S.derived.sendable.some((x) => x.uid === u)).length;
      r = readiness();
      if (!r.ok) { toast(r.blockers[0].message, "error"); emit("change"); return; }
    }
    const plan = finalPlan();
    if (!plan.send.length) { toast("কোনো প্রাপক নেই", "error"); return; }
    if (!(await confirmSend(plan, r, { removed, verified }))) return;
    await runNew(plan, r);
  } finally { startLock = false; }
}

async function runNew(plan, r) {
  const d = S.draft;
  const ctx = ctxFromDraft();
  const id = store.newCampaignId();
  const draftId = d.id;
  const name = d.name.trim() || autoName(d);
  const rows = [...plan.send.map((x) => rowOf(x)), ...plan.skipped.map((s) => rowOf(s, "skipped", REASONS[s.reason] || s.reason))];
  rows.forEach((x, i) => { x.index = i; });
  const meta = { ...campaignMetaOf({ ...d, name }, ctx), fingerprint: r.fingerprint };
  try {
    await store.createCampaign(id, meta, rows); // (1) the record exists BEFORE the first email is attempted
  } catch (err) {
    toast(err?.code === "permission-denied" ? "ক্যাম্পেইন সেভ করা যায়নি (অনুমতি নেই — firestore.rules Publish করেছেন?) — কোনো ইমেইল পাঠানো হয়নি" : `ক্যাম্পেইন সেভ করা যায়নি — কোনো ইমেইল পাঠানো হয়নি (${err?.message || err})`, "error");
    return;
  }
  if (draftId) store.deleteCampaign(draftId).catch(() => {});
  d.id = null;
  logAction("email.campaign.start", { type: "email-campaign", id, label: name, detail: `${CAMPAIGN_TYPES[d.type].label} · ${plan.send.length} recipients${plan.skipped.length ? ` · ${plan.skipped.length} skipped` : ""}${ctx.exam ? ` · exam ${ctx.exam.title || ctx.exam.id}` : ""}` });
  const run = { id, name, ctx, rows, cls: classificationMap(ctx.exam), isRetry: false, status: "sending" };
  const todo = selectForRun(rows, { includeFailed: false, includeUncertain: false });
  await engine(run, todo);
  if (totalsOf(run.rows).accepted > 0) d.sentFps = [...(d.sentFps || []), r.fingerprint];
  emit("change");
}

/* ==========================================================================
   Retry / resume (from Campaign History)
   ========================================================================== */
/** The frozen settings of a stored campaign, but with TODAY's EmailJS configuration and student data. */
export function ctxFromCampaign(c) {
  return {
    id: c.id, type: c.type, lang: c.lang || "en", content: sanitizeContent(c.content), policy: c.missingPolicy || "block",
    exam: c.examId ? S.examsById.get(c.examId) || null : null, personalMessage: c.personalMessage || "", deadlineMs: Number(c.deadlineMs) || null,
    courseIds: c.courseIds || [], settings: S.settings,
  };
}

/** Interrupted campaigns: rows still "sending" were in flight when the page died → "uncertain". Persisted once. */
export async function repairStale(c) {
  if (!isStale(c, serverNow()) || S.sending?.id === c.id) return c;
  try {
    const rows = await store.loadCampaignRows(c.id);
    const fixed = recoverRows(rows);
    fixed.forEach((x, i) => { x.index = i; });
    const touched = fixed.filter((x, i) => x.status !== rows[i].status);
    const totals = totalsOf(fixed);
    await store.saveProgress(c.id, { rows: fixed, dirtyParts: [...new Set(touched.map((x) => store.partOf(x.index)))], totals, status: "interrupted", extra: { finishedAt: store.serverStamp() } });
    logAction("email.campaign.interrupt", { type: "email-campaign", id: c.id, label: c.name || "", detail: `no heartbeat — marked interrupted · uncertain ${totals.uncertain} · pending ${totals.pending}` });
    return { ...c, status: "interrupted", totals };
  } catch { return c; }
}

/** Opens the "what should be sent again?" dialog, then runs. `rows` = the campaign's stored rows. */
export async function retryFlow(c, rows) {
  if (startLock || S.sending) { toast("একটি ক্যাম্পেইন ইতিমধ্যে চলছে", "info"); return; }
  const st = settingsState();
  if (!st.complete || !st.tested) { toast("EmailJS কনফিগারেশন সম্পূর্ণ ও টেস্ট করা না থাকলে পাঠানো যাবে না — Email Settings দেখুন", "error"); return; }
  const fixed = recoverRows(rows);
  const t = totalsOf(fixed);
  const exam = c.examId ? S.examsById.get(c.examId) || null : null;
  if (CAMPAIGN_TYPES[c.type]?.needsExam) {
    const ok = typeAllowed(c.type, exam, serverNow());
    if (!ok.ok) { toast(`আবার পাঠানো যাবে না: ${ok.reason}`, "error"); return; }
  }
  const retryHtml = `
    <div class="modal-head"><h3>Send again — which recipients?</h3></div>
    <p class="confirm-msg">যাদের ইমেইল <b>ইতিমধ্যে গ্রহণ হয়েছে (${fmtN(t.accepted)} জন) তাঁদের আর পাঠানো হবে না</b>।</p>
    ${t.pending ? `<label class="em-check"><input type="checkbox" id="rt-pending" checked> Pending — এখনো চেষ্টাই করা হয়নি <b>(${fmtN(t.pending)})</b></label>` : ""}
    ${t.failed ? `<label class="em-check"><input type="checkbox" id="rt-failed" checked> Failed — EmailJS প্রত্যাখ্যান করেছে <b>(${fmtN(t.failed)})</b></label>` : ""}
    ${t.uncertain ? `<label class="em-check"><input type="checkbox" id="rt-uncertain"> Uncertain — কোনো উত্তর আসেনি, ইমেইল গিয়ে থাকতে পারে <b>(${fmtN(t.uncertain)})</b></label>
      <div class="note warn"><i class="fa-solid fa-triangle-exclamation"></i> Uncertain-দের আবার পাঠালে কেউ দুইবার ইমেইল পেতে পারেন। আগে EmailJS Dashboard → Email History দেখে নিন।</div>` : ""}
    ${isExamType(c.type) ? `<div class="note"><i class="fa-solid fa-circle-info"></i> পাঠানোর মুহূর্তে ফলাফল আবার যাচাই হবে — যিনি ইতিমধ্যে জমা দিয়েছেন তাঁকে বাদ দেওয়া হবে।</div>` : ""}
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" id="rt-cancel">বাতিল</button><button type="button" class="btn btn-primary btn-block" id="rt-go"><i class="fa-solid fa-rotate"></i> Send</button></div>`;
  const choice = await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; resolve(v); };
    const dlg = dialog(retryHtml, { onClose: () => settle(null) });
    dlg.box.querySelector("#rt-cancel").addEventListener("click", () => { settle(null); dlg.close(); });
    dlg.box.querySelector("#rt-go").addEventListener("click", () => {
      settle({ includePending: !!dlg.box.querySelector("#rt-pending")?.checked, includeFailed: !!dlg.box.querySelector("#rt-failed")?.checked, includeUncertain: !!dlg.box.querySelector("#rt-uncertain")?.checked });
      dlg.close();
    });
  });
  if (!choice) return;
  fixed.forEach((x, i) => { x.index = i; });
  const todo = selectForRun(fixed, choice);
  if (!todo.length) { toast("পাঠানোর মতো কেউ বাছা হয়নি", "info"); return; }
  startLock = true;
  try {
    if (exam && isExamType(c.type)) await ensureExamData(exam.id, { force: true });
    const ctx = ctxFromCampaign(c);
    const run = { id: c.id, name: c.name || "", ctx, rows: fixed, cls: classificationMap(ctx.exam), isRetry: true, status: "sending" };
    await store.saveProgress(c.id, { rows: fixed, dirtyParts: [...new Set(fixed.filter((x, i) => x.status !== rows[i]?.status).map((x) => store.partOf(x.index)))], totals: totalsOf(fixed), status: "sending", extra: { runs: (Number(c.runs) || 1) + 1, startedAt: store.serverStamp(), finishedAt: store.fieldDelete() } });
    logAction("email.campaign.retry", { type: "email-campaign", id: c.id, label: c.name || "", detail: `${todo.length} recipients (${choice.includePending ? "pending " : ""}${choice.includeFailed ? "failed " : ""}${choice.includeUncertain ? "uncertain" : ""})`.trim() });
    await engine(run, todo);
  } catch (err) {
    toast(`আবার পাঠানো শুরু করা যায়নি: ${err?.message || err}`, "error");
  } finally { startLock = false; }
}

export function exportCampaign(c, rows) {
  const safe = (c.name || "campaign").replace(/[^\w\u0980-\u09FF-]+/g, "_").slice(0, 40);
  downloadCsv(`email-campaign-${safe}-${new Date().toISOString().slice(0, 10)}.csv`, campaignCsv(c, rows));
  logAction("email.campaign.export", { type: "email-campaign", id: c.id, label: c.name || "", detail: `${rows.length} rows exported` });
}

/* ==========================================================================
   The progress dialog (cannot be dismissed while a run is in progress)
   ========================================================================== */
let progEl = null, progRaf = 0, announced = 0;
function ensureProgress() {
  if (progEl && document.body.contains(progEl)) return progEl;
  progEl = document.createElement("div");
  progEl.className = "modal-overlay"; progEl.id = "em-progress-overlay";
  progEl.innerHTML = `<div class="modal-box card em-dialog wide" role="dialog" aria-modal="true" aria-labelledby="em-prog-title" tabindex="-1"></div>`;
  document.body.appendChild(progEl);
  document.body.style.overflow = "hidden";
  trapFocus(progEl.querySelector(".modal-box"));
  progEl.addEventListener("click", (e) => {
    const stop = e.target.closest("[data-prog='stop']");
    if (stop && S.sending) { S.sending.stop = true; stop.disabled = true; stop.textContent = "Stopping after this email…"; }
    if (e.target.closest("[data-prog='close']")) closeProgress();
    if (e.target.closest("[data-prog='retry']") && S.lastRun) {
      const r = S.lastRun;
      closeProgress();
      // the run that just ended is still unwinding for a few milliseconds (history refresh, lock release) — wait until it is idle
      whenIdle().then(() => store.listCampaigns({ force: true })).then(async (list) => { const c = list.find((x) => x.id === r.id); if (c) retryFlow(c, await store.loadCampaignRows(r.id)); });
    }
    if (e.target.closest("[data-prog='csv']") && S.lastRun) { const r = S.lastRun; exportCampaign({ id: r.id, name: r.name, type: r.ctx.type, subject: r.ctx.content.subject, examTitle: r.ctx.exam?.title || "" }, r.rows); }
  });
  return progEl;
}
function closeProgress() {
  progEl?.remove(); progEl = null; document.body.style.overflow = "";
  cancelAnimationFrame(progRaf);
}
function drawProgress(run) {
  if (!run) return;
  cancelAnimationFrame(progRaf);
  progRaf = requestAnimationFrame(() => paint(run));
}
function paint(run) {
  const el = ensureProgress().querySelector(".modal-box");
  const t = totalsOf(run.rows);
  const target = run.rows.filter((r) => r.status !== "skipped").length || 1;
  const finishedRows = t.accepted + t.failed + t.uncertain;
  const pct = Math.min(100, Math.round((finishedRows / target) * 100));
  const running = !run.finished;
  const remaining = t.pending + t.sending;
  const eta = running && remaining ? fmtEta(estimateMs(remaining, run.ctx.settings.intervalMs)) : "";
  const st = running ? "Sending…" : (CAMPAIGN_STATUS[run.status]?.label || run.status);
  const failures = run.rows.filter((r) => r.status === "failed" || r.status === "uncertain").slice(0, 8);
  const tone = running ? "" : run.status === "completed" ? "ok" : run.status === "failed" ? "bad" : "warn";
  el.innerHTML = `
    <div class="modal-head"><h3 id="em-prog-title">${running ? "Sending campaign" : "Campaign finished"}: ${esc(run.name)}</h3></div>
    <div class="em-prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Sending progress"><i style="width:${pct}%"></i></div>
    <div class="em-prog-stats">
      <div><b>${fmtN(finishedRows)}</b><span>of ${fmtN(target)} processed</span></div>
      <div class="ok"><b>${fmtN(t.accepted)}</b><span>Request accepted</span></div>
      <div class="bad"><b>${fmtN(t.failed)}</b><span>Failed</span></div>
      <div class="warn"><b>${fmtN(t.uncertain)}</b><span>Uncertain</span></div>
      <div><b>${fmtN(t.skipped)}</b><span>Skipped</span></div>
      <div><b>${fmtN(remaining)}</b><span>Pending</span></div>
    </div>
    <p class="em-prog-now" role="status" aria-live="polite">${running
      ? (run.waitingMs && run.waitReason === "rate_limited" ? `EmailJS ধীর হতে বলেছে — ${(run.waitingMs / 1000).toFixed(1)} সেকেন্ড অপেক্ষা…` : run.current ? `<span class="spinner sm"></span> পাঠানো হচ্ছে: ${esc(nameOf(run.current))} &lt;${esc(run.current.email)}&gt;` : "প্রস্তুত হচ্ছে…") + (eta ? ` · বাকি ≈ ${eta}` : "")
      : `${esc(st)} — ${fmtN(finishedRows)}/${fmtN(target)} processed`}</p>
    ${running ? `<div class="note"><i class="fa-solid fa-lock"></i> কাজ শেষ না হওয়া পর্যন্ত এই ট্যাব <b>খোলা ও সামনে</b> রাখুন, স্ক্রিন চালু রাখুন (অন্য ট্যাবে গেলে বা স্ক্রিন বন্ধ হলে ব্রাউজার কাজ ধীর বা স্থগিত করে দিতে পারে)। বন্ধ হয়ে গেলেও রেকর্ড সেভ আছে — Campaign History থেকে চালিয়ে নিতে পারবেন (অনিশ্চিতদের আবার পাঠানো হবে না)।</div>` : ""}
    ${run.tripped ? `<div class="note bad"><i class="fa-solid fa-hand"></i> <b>রান থামানো হয়েছে:</b> ${esc(run.tripped.reason === "persist" || run.tripped.reason === "crash" ? run.tripped.text : `${explainOutcome(run.tripped) || ""} (EmailJS: ${run.tripped.status || "—"} ${run.tripped.text || ""})`)}</div>` : ""}
    ${!running ? `<div class="note ${tone}"><i class="fa-solid fa-circle-info"></i> “Request accepted” মানে EmailJS অনুরোধটি নিয়েছে — ইনবক্সে পৌঁছানোর নিশ্চয়তা নয়। পাঠানো ইমেইল ফেরত আনা যায় না।${run.status === "stopped" ? " আপনি Stop করেছেন — বাকিরা Pending আছে।" : ""}</div>` : ""}
    ${failures.length ? `<div class="em-prog-fails"><b>Problems (${fmtN(t.failed + t.uncertain)}):</b><ul>${failures.map((r) => `<li>${chip(ROW_STATUS[r.status].label, ROW_STATUS[r.status].tone)} ${esc(nameOf(r))} <small>${esc(r.note || "")}</small></li>`).join("")}</ul></div>` : ""}
    <div class="confirm-actions">
      ${running ? `<button type="button" class="btn btn-outline btn-block" data-prog="stop"><i class="fa-solid fa-hand"></i> Stop after current email</button>`
        : `${t.failed || t.pending ? `<button type="button" class="btn btn-outline btn-block" data-prog="retry"><i class="fa-solid fa-rotate"></i> Retry failed / pending (${fmtN(t.failed + t.pending)})</button>` : ""}
           <button type="button" class="btn btn-outline btn-block" data-prog="csv"><i class="fa-solid fa-download"></i> Export CSV</button>
           <button type="button" class="btn btn-primary btn-block" data-prog="close">Close</button>`}
    </div>`;
  if (!running && !el.dataset.focused) { el.dataset.focused = "1"; el.querySelector("[data-prog='close']")?.focus(); }
  if (running && !el.dataset.focused) { el.dataset.focused = "1"; el.focus(); }
}
