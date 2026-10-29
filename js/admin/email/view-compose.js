// ==========================================================================
// admin/email/view-compose.js — "Compose Email": campaign type → exam → audience → message → readiness → send.
//
// The form is built once; afterwards only the small live regions (exam banner, audience line, readiness list) are redrawn,
// so typing never loses focus. A change that REPLACES the whole draft (template, duplicate, notice…) re-mounts the tab.
// ==========================================================================
import { esc, fmtN, debounce } from "../core/ui.js";
import { confirmAction } from "../../utils.js";
import { CAMPAIGN_TYPES, LANGUAGES, typeAllowed, REASONS, fmtDateTimeShort } from "../../email-core.js";
import { toMs } from "../../schedule-core.js";
import { BUILTIN_TEMPLATES } from "../../email-templates-data.js";
import { S, on } from "./state.js";
import { setType, setExam, setLang, useTemplate, readiness, examOptions, STATE_LABEL, recompute } from "./model.js";
import { contentFieldsHtml, readContent, bindEditor, bindCta } from "./editor.js";
import { configBanner, bindTabLinks, examStateChip, keepFocus, setHtml } from "./bits.js";
import { openPreview, openTestSend, startCampaign, saveDraftNow, describeAudience } from "./send.js";
import { openSaveTemplate } from "./view-templates.js";
import { serverNow } from "../../server-time.js";

let host = null;

const typeCards = () => Object.entries(CAMPAIGN_TYPES).map(([id, t]) => `
  <label class="em-type${S.draft.type === id ? " on" : ""}"><input type="radio" name="cm-type" value="${id}" ${S.draft.type === id ? "checked" : ""}>
    <i class="fa-solid ${t.icon}" aria-hidden="true"></i><span><b>${esc(t.label)}</b><small>${esc(t.desc)}</small></span></label>`).join("");

function examSelectHtml() {
  const d = S.draft;
  const needs = CAMPAIGN_TYPES[d.type].needsExam;
  const opts = examOptions();
  return `<label for="cm-exam">${needs ? "Exam <b class=\"req\">*</b>" : "Exam <small>(ঐচ্ছিক — {{exam_title}}, {{exam_date}} ইত্যাদি ভেরিয়েবলের জন্য)</small>"}</label>
    <select id="cm-exam"><option value="">${needs ? "— একটি এক্সাম বাছুন —" : "— কোনো এক্সাম নয় —"}</option>
      ${opts.map((o) => `<option value="${esc(o.id)}" ${o.id === d.examId ? "selected" : ""}>${esc(o.title)} — ${esc(STATE_LABEL[o.state] || o.state)}</option>`).join("")}</select>`;
}

function examBanner() {
  const d = S.draft;
  const exam = S.derived.exam;
  const t = CAMPAIGN_TYPES[d.type];
  if (!exam) return t.needsExam ? `<div class="note"><i class="fa-solid fa-circle-info"></i> এই ধরনের ইমেইলের জন্য একটি এক্সাম বাছুন — প্রাপক তালিকা এক্সামের আসল ফলাফল থেকে তৈরি হবে।</div>` : "";
  const st = S.derived.examState;
  const tz = S.settings.timeZone;
  const bits = [];
  if (toMs(exam.publishAt) !== null) bits.push(`শুরু: ${fmtDateTimeShort(toMs(exam.publishAt), tz, "en")}`);
  if (toMs(exam.closesAt) !== null) bits.push(`শেষ (শুরুর সীমা): ${fmtDateTimeShort(toMs(exam.closesAt), tz, "en")}`);
  if (exam.duration) bits.push(`${exam.duration} মিনিট`);
  if (!bits.length) bits.push("কোনো সময়সূচি সেট নেই");
  const ok = typeAllowed(d.type, exam, serverNow());
  const ed = S.examData.get(exam.id);
  const data = S.derived.examLoading ? `<span class="spinner sm"></span> ফলাফল লোড হচ্ছে…`
    : S.derived.resultsOk === false ? `<span class="em-bad"><i class="fa-solid fa-triangle-exclamation"></i> ফলাফল পড়া যায়নি — যাচাই করা যায়নি</span>`
    : S.derived.sessionsOk === false && t.needsExam ? `<span class="em-warn"><i class="fa-solid fa-circle-question"></i> Start-tracking পড়া যায়নি (শুধু “জমা দেওয়া ফলাফল নেই” বলা যাবে)</span>`
    : ed?.status === "ready" ? `<span class="em-ok"><i class="fa-solid fa-circle-check"></i> ফলাফল ও start-তথ্য যাচাই করা হয়েছে</span>` : "";
  return `<div class="em-exambox ${ok.ok ? "" : "bad"}"><div class="em-exambox-h"><b>${esc(exam.title || exam.id)}</b> ${examStateChip(st?.key)} <small>${esc(bits.join(" · "))}</small></div>
    <div class="em-exambox-b">${data}</div>
    ${ok.ok ? "" : `<div class="note bad"><i class="fa-solid fa-ban"></i> ${esc(ok.reason)}</div>`}</div>`;
}

/** The live part of the audience line (text only — the buttons next to it never get replaced). */
function audienceText() {
  const D = S.derived;
  const skipReasons = {};
  D.skipped.forEach((s) => { skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1; });
  const sk = Object.entries(skipReasons).map(([k, n]) => `${n} × ${esc(REASONS[k] || k)}`).join(" · ");
  return `<b class="em-big">${fmtN(D.sendable.length)}</b> <span>recipients will each get their own email</span>
      <small>${esc(describeAudience())}${D.skipped.length ? ` · <span class="em-warn">${fmtN(D.skipped.length)} বাদ (${sk})</span>` : ""}</small>`;
}
const audienceShell = () => `<div class="em-audience"><div id="cm-audience-text" role="status" aria-live="polite">${audienceText()}</div>
    <div class="em-audience-actions"><button type="button" class="btn btn-outline btn-sm" data-go-tab="recipients"><i class="fa-solid fa-users"></i> Choose recipients</button>
      <button type="button" class="btn btn-outline btn-sm" data-go-tab="reminders" id="cm-to-reminders" ${CAMPAIGN_TYPES[S.draft.type].needsExam ? "" : "hidden"}><i class="fa-solid fa-bell"></i> Exam Reminders</button></div></div>`;

const readyShell = () => `<div class="em-ready" id="cm-ready" role="region" aria-label="Sending readiness">
    <h3 id="cm-ready-h"></h3><div id="cm-ready-list"></div><p class="em-ready-info" id="cm-ready-info"></p>
    <div class="em-ready-actions">
      <button type="button" class="btn btn-outline btn-block" data-act="preview"><i class="fa-solid fa-eye"></i> Preview</button>
      <button type="button" class="btn btn-outline btn-block" data-act="test"><i class="fa-solid fa-flask-vial"></i> Send test email</button>
      <div class="em-ready-row"><button type="button" class="btn btn-outline" data-act="draft"><i class="fa-solid fa-floppy-disk"></i> Save draft</button>
        <button type="button" class="btn btn-outline" data-act="template"><i class="fa-solid fa-file-circle-plus"></i> Save as template</button></div>
      <button type="button" class="btn btn-primary btn-block" data-act="send" id="cm-send" aria-describedby="cm-why"><i class="fa-solid fa-paper-plane"></i> <span id="cm-send-l"></span></button>
      <p class="form-hint" id="cm-why"></p></div></div>`;

/** Fill the readiness box. Only text and the Send button's state change — the buttons themselves stay put. */
function paintReady(el) {
  const r = readiness();
  const box = el.querySelector("#cm-ready");
  box.classList.toggle("ok", r.ok); box.classList.toggle("bad", !r.ok);
  setHtml(el.querySelector("#cm-ready-h"), r.ok ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Ready to send' : '<i class="fa-solid fa-hand" aria-hidden="true"></i> Not ready yet');
  const items = [
    ...r.blockers.map((b) => `<li class="bad"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i><span><b class="sr">Blocked: </b>${esc(b.message)}</span></li>`),
    ...r.warnings.map((w) => `<li class="warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span><b class="sr">Warning: </b>${esc(w.message)}</span></li>`),
  ];
  setHtml(el.querySelector("#cm-ready-list"), items.length ? `<ul class="em-checklist">${items.join("")}</ul>` : `<p class="muted">সব যাচাই পাস করেছে।</p>`);
  const a = r.analysis;
  const info = [];
  if (a.studentMissingCount) info.push(`${fmtN(a.studentMissingCount)} জনের তথ্য অনুপস্থিত: ${a.studentMissingKeys.map((k) => `{{${k}}}`).join(", ")}`);
  info.push(`ইমেইলের আকার ≈ ${(a.sizeBytes / 1024).toFixed(1)} KB / 50 KB`);
  setHtml(el.querySelector("#cm-ready-info"), info.map(esc).join(" · "));
  const send = el.querySelector("#cm-send");
  send.disabled = !(r.ok && !S.sending);
  const label = `Send to ${fmtN(r.sendableCount)} students`;
  if (el.querySelector("#cm-send-l").textContent !== label) el.querySelector("#cm-send-l").textContent = label;
  setHtml(el.querySelector("#cm-why"), r.ok ? "পাঠানোর আগে একটি চূড়ান্ত নিশ্চিতকরণ ও ফলাফল-যাচাই হবে।" : "লাল তালিকার সবকিছু ঠিক না হওয়া পর্যন্ত Send বন্ধ।");
}

function templateOptions() {
  const own = S.templates;
  return `<optgroup label="Built-in">${BUILTIN_TEMPLATES.map((t) => `<option value="${t.id}" ${S.draft.templateId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</optgroup>
    ${own.length ? `<optgroup label="My templates">${own.map((t) => `<option value="${esc(t.id)}" ${S.draft.templateId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</optgroup>` : ""}`;
}

function build() {
  const d = S.draft;
  return `
    <div id="cm-banner">${configBanner({ compact: true })}</div>
    ${d.source ? `<div class="note"><i class="fa-solid fa-bullhorn"></i> ওয়েবসাইট নোটিশ <b>“${esc(d.source.title)}”</b> থেকে তৈরি। এটি শুধু একটি ড্রাফট — নোটিশ প্রকাশ বা এডিট করলে নিজে থেকে কোনো ইমেইল যায় না।</div>` : ""}
    <div class="em-compose">
      <div class="em-form">
        <section class="panel"><div class="panel-head"><div><h2>1 · Campaign</h2></div></div><div class="panel-body">
          <fieldset class="em-types"><legend>Campaign type</legend><div class="em-type-grid" id="cm-types" role="radiogroup">${typeCards()}</div></fieldset>
          <div class="admin-grid">
            <div class="field"><label for="cm-name">Campaign name <small>(ফাঁকা রাখলে নিজে থেকে হবে)</small></label><input type="text" id="cm-name" maxlength="160" value="${esc(d.name)}"></div>
            <div class="field"><label>Email language</label><div class="seg" id="cm-lang" role="group" aria-label="Email language">${Object.entries(LANGUAGES).map(([k, v]) => `<button type="button" aria-pressed="${d.lang === k}" class="seg-btn${d.lang === k ? " on" : ""}" data-lang="${k}">${esc(v)}</button>`).join("")}</div>
              <small class="form-hint">শুধু ইমেইলের স্ট্যাটিক লেখা ও টেমপ্লেটের ভাষা বদলায়; আপনার নিজের লেখা যেমন আছে তেমনই থাকে।</small></div>
          </div>
          <div class="field" id="cm-examwrap">${examSelectHtml()}</div>
          <div id="cm-exambanner">${examBanner()}</div>
          <div id="cm-audience">${audienceShell()}</div>
          <div class="field"><label for="cm-policy">If a student lacks data a {{variable}} needs</label>
            <select id="cm-policy"><option value="block" ${d.missingPolicy === "block" ? "selected" : ""}>Block sending until fixed (recommended)</option><option value="skip" ${d.missingPolicy === "skip" ? "selected" : ""}>Skip those students</option><option value="fallback" ${d.missingPolicy === "fallback" ? "selected" : ""}>Send anyway — show “Not available”</option></select></div>
        </div></section>

        <section class="panel"><div class="panel-head"><div><h2>2 · Message</h2><small>প্রতিটি প্রাপক শুধু নিজের তথ্যসহ আলাদা ইমেইল পাবে</small></div></div><div class="panel-body">
          <div class="em-tpl-row"><div class="field"><label for="cm-tpl">Start from a template</label><select id="cm-tpl">${templateOptions()}</select></div>
            <button type="button" class="btn btn-outline" data-act="apply-tpl"><i class="fa-solid fa-file-import"></i> Use template</button></div>
          <div id="cm-fields" class="em-fields">${contentFieldsHtml(d.content, "cm")}</div>
          <div class="admin-grid">
            <div class="field"><label for="cm-personal">Personal message <small>({{personal_message}} — ঐচ্ছিক)</small></label><textarea id="cm-personal" rows="3" maxlength="1000">${esc(d.personalMessage)}</textarea></div>
            <div class="field"><label for="cm-deadline">Deadline <small>({{deadline}} — ঐচ্ছিক; ফাঁকা থাকলে এক্সামের শেষ-সময় ব্যবহার হয়)</small></label><input type="datetime-local" id="cm-deadline" value="${esc(d.deadline)}"><small class="form-hint">সময়টি ${esc(S.settings.timeZone)} ধরা হয়।</small></div>
          </div>
        </div></section>
      </div>
      <aside class="em-side">${readyShell()}</aside>
    </div>`;
}

/** Copy the form into the draft. `edited` = a real user edit (only then the draft counts as hand-written). */
function readForm(el, edited = false) {
  const d = S.draft;
  d.name = el.querySelector("#cm-name").value;
  d.content = readContent(el.querySelector("#cm-fields"), "cm");
  d.personalMessage = el.querySelector("#cm-personal").value;
  d.deadline = el.querySelector("#cm-deadline").value;
  d.missingPolicy = el.querySelector("#cm-policy").value;
  if (edited) d.touched = true;
}
const redrawLive = (el) => keepFocus(el, () => {
  setHtml(el.querySelector("#cm-exambanner"), examBanner());
  setHtml(el.querySelector("#cm-audience-text"), audienceText());
  const toRem = el.querySelector("#cm-to-reminders"); if (toRem) toRem.hidden = !CAMPAIGN_TYPES[S.draft.type].needsExam;
  paintReady(el);
  setHtml(el.querySelector("#cm-banner"), configBanner({ compact: true }));
});

export const compose = {
  mount(el) {
    host = el;
    const live = debounce(() => { recompute(); redrawLive(el); }, 250);
    bindTabLinks(el);
    bindEditor(el, () => { readForm(el, true); live(); });
    el.addEventListener("input", (e) => { if (e.target.closest("#cm-fields, #cm-personal, #cm-name")) { readForm(el, true); live(); } });
    el.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.matches('textarea, input[type="text"]')) return; // already handled by "input" while typing
      if (t.closest("#cm-fields") || t.id === "cm-deadline" || t.id === "cm-policy") { readForm(el, true); recompute(); redrawLive(el); return; }
      if (t.name === "cm-type") { readForm(el); await setType(t.value); this.render(); return; }
      if (t.id === "cm-exam") { readForm(el); await setExam(t.value); this.render(); }
    });
    el.addEventListener("click", async (e) => {
      const lang = e.target.closest("[data-lang]");
      if (lang) {
        readForm(el);
        const next = lang.dataset.lang;
        if (next === S.draft.lang) return;
        if (S.draft.touched) {
          const replace = await confirmAction("ইমেইলের লেখাও কি নতুন ভাষার টেমপ্লেট দিয়ে বদলাবেন? (“না” বললে আপনার লেখা থাকবে, শুধু ইমেইলের লেবেলের ভাষা বদলাবে।)", { title: "ভাষা বদলাচ্ছে", confirmLabel: "হ্যাঁ, লেখা বদলান", cancelLabel: "না, আমার লেখা রাখুন" });
          if (replace) S.draft.touched = false;
        }
        setLang(next); this.render(); return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      readForm(el);
      if (act === "apply-tpl") {
        if (S.draft.touched && !(await confirmAction("টেমপ্লেট ব্যবহার করলে এখনকার লেখা (বিষয়, বার্তা ইত্যাদি) বদলে যাবে। এগিয়ে যাবেন?", { title: "লেখা বদলাবেন?", confirmLabel: "হ্যাঁ, বদলান" }))) return;
        if (useTemplate(el.querySelector("#cm-tpl").value)) this.render();
      } else if (act === "preview") openPreview();
      else if (act === "test") openTestSend();
      else if (act === "draft") await saveDraftNow(e.target.closest("button"));
      else if (act === "template") openSaveTemplate();
      else if (act === "send") await startCampaign();
    });
    for (const evt of ["change", "selection", "settings", "campaigns", "examdata", "run-finished"]) on(evt, () => { if (S.tab === "compose" && host) redrawLive(host); });
    on("draft-replaced", () => { if (host) this.render(); });
    this.render();
  },
  /** Rebuild the whole form from the draft (type / language / template / draft replaced). Scroll position is kept. */
  render() {
    if (!host) return;
    const y = window.scrollY;
    host.innerHTML = build();
    bindCta(host, "cm");
    paintReady(host);
    window.scrollTo(0, y);
  },
  refresh(el) { redrawLive(el); },
};
