// ==========================================================================
// admin/email/editor.js — the message editor, shared by "Compose Email" and the template editor.
//
// A plain <textarea> with a small formatting toolbar (bold · italic · link · bullet list · numbered list) and
// click-to-insert {{variable}} chips. The toolbar only inserts the safe markup that email-render.js understands;
// there is deliberately no rich-text/contentEditable surface (those are unreliable and could smuggle HTML in).
// ==========================================================================
import { esc } from "../core/ui.js";
import { VARIABLES } from "../../email-core.js";
import { INFO_FIELDS } from "../../email-render.js";

const MARK = {
  bold: { before: "**", after: "**", sample: "bold text" },
  italic: { before: "_", after: "_", sample: "italic text" },
  link: { before: "[", after: "](https://)", sample: "link text" },
};

/** The formatting buttons above a textarea. `for` = the textarea id. */
export function toolbarHtml(forId) {
  const b = (act, icon, label) => `<button type="button" class="em-tb-btn" data-fmt="${act}" data-for="${forId}" title="${label}" aria-label="${label}"><i class="fa-solid ${icon}"></i></button>`;
  return `<div class="em-toolbar" role="toolbar" aria-label="Formatting">${b("bold", "fa-bold", "Bold (**text**)")}${b("italic", "fa-italic", "Italic (_text_)")}${b("link", "fa-link", "Link ([text](https://…))")}${b("ul", "fa-list-ul", "Bullet list")}${b("ol", "fa-list-ol", "Numbered list")}</div>`;
}

/** Click-to-insert chips for every supported variable. */
export function chipsHtml(forId) {
  return `<details class="em-vars"><summary><i class="fa-solid fa-code"></i> Insert a variable <small>(প্রতিটি ইমেইলে প্রাপকের নিজের তথ্য বসে)</small></summary>
    <div class="em-var-grid">${VARIABLES.map((v) => `<button type="button" class="em-var" data-var="${v.key}" data-for="${forId}" title="${esc(v.source)}"><code>{{${v.key}}}</code><span>${esc(v.label)}</span></button>`).join("")}</div>
    <p class="form-hint">ডেটা না থাকলে ফলব্যাক দিন: <code>{{exam_date|এখনো জানানো হয়নি}}</code> — নাহলে ডেটা-না-থাকা প্রাপকদের জন্য পাঠানো আটকে যায় (কিছু বানিয়ে লেখা হয় না)।</p></details>`;
}

/** Wire the toolbar + chips found inside `root` to their textareas / inputs (event delegation, safe to call once per root). */
export function bindEditor(root, onChange = () => {}) {
  root.addEventListener("click", (e) => {
    const f = e.target.closest("[data-fmt]");
    if (f && root.contains(f)) { e.preventDefault(); format(root.querySelector(`#${CSS.escape(f.dataset.for)}`), f.dataset.fmt); onChange(); return; }
    const v = e.target.closest("[data-var]");
    if (v && root.contains(v)) { e.preventDefault(); const el = root.querySelector(`#${CSS.escape(v.dataset.for)}`); insert(el, `{{${v.dataset.var}}}`); onChange(); }
  });
}

function insert(el, text) {
  if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, s, e, "end");
  el.focus();
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function format(el, kind) {
  if (!el) return;
  const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0;
  const sel = el.value.slice(s, e);
  if (MARK[kind]) {
    const m = MARK[kind];
    const inner = sel || m.sample;
    el.setRangeText(`${m.before}${inner}${m.after}`, s, e, "end");
    if (!sel) el.setSelectionRange(s + m.before.length, s + m.before.length + inner.length);
  } else {
    // list: prefix every selected line (or start a new line) with "- " / "1. "
    const from = el.value.lastIndexOf("\n", s - 1) + 1;
    const to = e + (el.value.indexOf("\n", e) === -1 ? el.value.length - e : el.value.indexOf("\n", e) - e);
    const block = el.value.slice(from, to) || "";
    const lines = (block || "item").split("\n").map((l, i) => (kind === "ul" ? `- ${l.replace(/^\s*([-•*]|\d+[.)])\s+/, "")}` : `${i + 1}. ${l.replace(/^\s*([-•*]|\d+[.)])\s+/, "")}`));
    el.setRangeText(lines.join("\n"), from, to, "end");
  }
  el.focus();
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The content fields. `p` = an id prefix so two editors never clash. `c` = the content object.
 * Reads back with readContent(root, p).
 */
export function contentFieldsHtml(c, p = "ed") {
  const infoBoxes = Object.entries(INFO_FIELDS).map(([k, f]) =>
    `<label class="em-check"><input type="checkbox" data-info="${k}" ${c.infoFields.includes(k) ? "checked" : ""}> ${esc(f.label[0])}</label>`).join("");
  return `
    <div class="field"><label for="${p}-subject">Email subject</label><input type="text" id="${p}-subject" maxlength="200" value="${esc(c.subject)}" placeholder="যেমন: Reminder: You Have Not Completed Your Exam"></div>
    <div class="field"><label for="${p}-greeting">Personalized greeting</label><input type="text" id="${p}-greeting" maxlength="200" value="${esc(c.greeting)}" placeholder="Dear {{student_name|Student}},"></div>
    <div class="field"><label for="${p}-message">Main message</label>${toolbarHtml(`${p}-message`)}
      <textarea id="${p}-message" rows="9" maxlength="6000" placeholder="মূল বার্তা লিখুন…&#10;ফাঁকা লাইন = নতুন প্যারাগ্রাফ। &quot;- &quot; দিয়ে শুরু করলে বুলেট লিস্ট।">${esc(c.message)}</textarea>
      ${chipsHtml(`${p}-message`)}</div>
    <div class="field"><label for="${p}-instructions">Important instructions <small>(ঐচ্ছিক — আলাদা হলুদ বক্সে দেখাবে)</small></label>
      <textarea id="${p}-instructions" rows="3" maxlength="3000">${esc(c.instructions)}</textarea></div>
    <div class="em-optgrid">
      <div class="em-opt">
        <label class="em-check"><input type="checkbox" id="${p}-showinfo" ${c.showStudentInfo ? "checked" : ""}> <b>Student information panel</b></label>
        <div class="em-checks" id="${p}-infofields">${infoBoxes}</div>
        <small>প্রতিটি ইমেইলে শুধু ওই শিক্ষার্থীর নিজের তথ্য; যে তথ্য নেই তার সারিটি বাদ যায়।</small>
      </div>
      <div class="em-opt">
        <label class="em-check"><input type="checkbox" id="${p}-showexam" ${c.showExamDetails ? "checked" : ""}> <b>Examination details panel</b></label>
        <small>এক্সামের নাম, তারিখ, সময়, সময়সীমা, শেষ সময় ও অবস্থা — শুধু যেগুলো সত্যিই এক্সামে সেট করা আছে।</small>
      </div>
    </div>
    <div class="em-cta">
      <label class="em-check"><input type="checkbox" id="${p}-cta" ${c.ctaEnabled ? "checked" : ""}> <b>Call-to-action button</b></label>
      <div class="em-cta-fields" id="${p}-ctafields" ${c.ctaEnabled ? "" : "hidden"}>
        <div class="field"><label for="${p}-ctalabel">Button text</label><input type="text" id="${p}-ctalabel" maxlength="80" value="${esc(c.ctaLabel)}"></div>
        <div class="field"><label for="${p}-ctaurl">Button link</label>
          <input type="text" id="${p}-ctaurl" maxlength="500" list="${p}-ctaopts" value="${esc(c.ctaUrl)}" autocomplete="off" spellcheck="false">
          <datalist id="${p}-ctaopts"><option value="{{website_url}}">ওয়েবসাইট</option><option value="{{exam_url}}">নির্বাচিত এক্সাম</option></datalist>
          <small class="form-hint">{{website_url}}, {{exam_url}} অথবা একটি https:// লিংক।</small></div>
      </div>
    </div>
    <div class="field"><label for="${p}-closing">Closing message <small>(ঐচ্ছিক)</small></label>
      <textarea id="${p}-closing" rows="3" maxlength="2000">${esc(c.closing)}</textarea></div>
    <div class="field"><label for="${p}-signature">Signature</label>
      <textarea id="${p}-signature" rows="2" maxlength="400">${esc(c.signature)}</textarea>
      <small class="form-hint">সাপোর্ট ইমেইল ও ওয়েবসাইট ফুটারে নিজে থেকেই বসে (js/footer-config.js থেকে)।</small></div>`;
}

/** Read the fields written by contentFieldsHtml back into a content object. */
export function readContent(root, p = "ed") {
  const val = (id) => root.querySelector(`#${p}-${id}`)?.value ?? "";
  const checked = (id) => !!root.querySelector(`#${p}-${id}`)?.checked;
  return {
    subject: val("subject"), greeting: val("greeting"), message: val("message"), instructions: val("instructions"), closing: val("closing"), signature: val("signature"),
    showStudentInfo: checked("showinfo"), infoFields: Array.from(root.querySelectorAll(`#${p}-infofields [data-info]:checked`)).map((i) => i.dataset.info),
    showExamDetails: checked("showexam"),
    ctaEnabled: checked("cta"), ctaLabel: val("ctalabel"), ctaUrl: val("ctaurl"),
  };
}

/** Show/hide the CTA fields when the checkbox flips. */
export function bindCta(root, p = "ed") {
  root.querySelector(`#${p}-cta`)?.addEventListener("change", (e) => { const box = root.querySelector(`#${p}-ctafields`); if (box) box.hidden = !e.target.checked; });
}
