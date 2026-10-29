// ==========================================================================
// admin/email/view-templates.js — "Email Templates": the built-in starting points (read-only, always available) and the
// admin's own templates (Firestore: emailTemplates). Create · edit · duplicate · delete · preview · use.
// ==========================================================================
import { closeModal, openModal, toast, confirmAction } from "../../utils.js";
import { esc, chip, createTable, fmtDateTime, confirmDanger, errorState, rulesHint, isDenied, withBusy } from "../core/ui.js";
import { logAction } from "../core/audit.js";
import { CAMPAIGN_TYPES, LANGUAGES, normLang } from "../../email-core.js";
import { renderEmail, sanitizeContent, sampleValues } from "../../email-render.js";
import { BUILTIN_TEMPLATES, contentFor } from "../../email-templates-data.js";
import * as store from "./store.js";
import { S, on, emit } from "./state.js";
import { useTemplate, refreshTemplates, site, logoUrlOf } from "./model.js";
import { contentFieldsHtml, readContent, bindEditor, bindCta } from "./editor.js";
import { goTab } from "./bits.js";
import { SITE } from "../../info-config.js";

let host = null, table = null;

/* ---------- preview with sample data ---------- */
function openTemplatePreview(content, lang, title) {
  const values = sampleValues({ lang, site: site(), testEmail: S.settings.testEmail });
  const out = renderEmail(sanitizeContent(content), values, { lang, policy: "fallback", site: site(), logoUrl: logoUrlOf(S.settings), brand: SITE.name });
  const overlay = openModal(`<div class="modal-head"><h3>${esc(title)} — preview</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="note"><i class="fa-solid fa-circle-info"></i> নমুনা তথ্য দিয়ে দেখানো হচ্ছে — আসল ইমেইলে প্রতিটি শিক্ষার্থীর নিজের তথ্য বসে।</div>
    <div class="em-pv-frame"><iframe title="Template preview" sandbox="" tabindex="-1" class="em-pv-iframe desktop"></iframe></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Close</button></div>`);
  overlay.querySelector(".modal-box").classList.add("em-dialog", "wide");
  overlay.querySelector("iframe").srcdoc = out.html;
}

/* ---------- editor (create / edit) ---------- */
function openEditor(tpl, { content = null, lang = null } = {}) {
  const t = tpl || { id: "", name: "", desc: "", type: S.draft.type, lang: lang || S.draft.lang, content: content || S.draft.content };
  const c = sanitizeContent(t.content);
  const overlay = openModal(`
    <div class="modal-head"><h3>${t.id ? "Edit template" : "New template"}</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="admin-grid">
      <div class="field"><label for="te-name">Template name</label><input type="text" id="te-name" maxlength="120" value="${esc(t.name)}" autocomplete="off"></div>
      <div class="field"><label for="te-type">Best for</label><select id="te-type">${Object.entries(CAMPAIGN_TYPES).map(([id, v]) => `<option value="${id}" ${t.type === id ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div>
      <div class="field"><label for="te-lang">Language</label><select id="te-lang">${Object.entries(LANGUAGES).map(([id, v]) => `<option value="${id}" ${normLang(t.lang) === id ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="te-desc">Description <small>(ঐচ্ছিক)</small></label><input type="text" id="te-desc" maxlength="300" value="${esc(t.desc || "")}"></div>
    <div id="te-fields" class="em-fields">${contentFieldsHtml(c, "te")}</div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>বাতিল</button><button type="button" class="btn btn-primary btn-block" id="te-save"><i class="fa-solid fa-floppy-disk"></i> Save template</button></div>`);
  overlay.querySelector(".modal-box").classList.add("em-dialog", "wide");
  bindEditor(overlay);
  bindCta(overlay, "te");
  overlay.querySelector("#te-name").focus();
  overlay.querySelector("#te-save").addEventListener("click", async (e) => {
    const name = overlay.querySelector("#te-name").value.trim();
    if (!name) { toast("টেমপ্লেটের একটি নাম দিন", "error"); overlay.querySelector("#te-name").focus(); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const id = await store.saveTemplate({
          name, desc: overlay.querySelector("#te-desc").value, type: overlay.querySelector("#te-type").value, lang: overlay.querySelector("#te-lang").value,
          content: readContent(overlay.querySelector("#te-fields"), "te"),
        }, { id: t.id, byName: S.me?.name || "" });
        logAction(t.id ? "email.template.update" : "email.template.create", { type: "email-template", id, label: name, detail: `${CAMPAIGN_TYPES[overlay.querySelector("#te-type").value]?.label || ""} · ${overlay.querySelector("#te-lang").value}` });
        closeModal();
        toast("টেমপ্লেট সেভ হয়েছে", "success");
        await refreshTemplates();
      } catch (err) {
        toast(isDenied(err) ? "সেভ করার অনুমতি নেই — firestore.rules Publish করুন" : `সেভ হয়নি: ${err?.message || err}`, "error");
      }
    });
  });
}
/** "Save as template" from Compose: the current content becomes a template. */
export function openSaveTemplate() { openEditor(null, { content: S.draft.content, lang: S.draft.lang }); }

async function duplicate(tpl, builtin) {
  const lang = builtin ? S.draft.lang : tpl.lang;
  const content = builtin ? contentFor(tpl, lang) : tpl.content;
  try {
    await store.saveTemplate({ name: `Copy of ${tpl.name}`, desc: tpl.desc || "", type: tpl.type, lang, content }, { byName: S.me?.name || "" });
    logAction("email.template.create", { type: "email-template", label: `Copy of ${tpl.name}`, detail: "duplicated" });
    toast("কপি তৈরি হয়েছে — “My templates”-এ দেখুন", "success");
    await refreshTemplates();
  } catch (err) { toast(isDenied(err) ? "সেভ করার অনুমতি নেই — firestore.rules Publish করুন" : `কপি হয়নি: ${err?.message || err}`, "error"); }
}

async function use(id) {
  if (S.draft.touched && !(await confirmAction("এই টেমপ্লেট ব্যবহার করলে Compose-এর এখনকার লেখা বদলে যাবে। এগিয়ে যাবেন?", { title: "লেখা বদলাবেন?", confirmLabel: "হ্যাঁ, বদলান" }))) return;
  if (useTemplate(id)) { emit("draft-replaced"); goTab("compose"); toast("টেমপ্লেট Compose-এ বসেছে", "success"); }
}

/* ---------- the tab ---------- */
const builtinCards = () => BUILTIN_TEMPLATES.map((t) => `
  <article class="em-tpl"><div class="em-tpl-h"><i class="fa-solid ${t.icon}" aria-hidden="true"></i><div><h3>${esc(t.name)}</h3>${chip(CAMPAIGN_TYPES[t.type]?.label || t.type, "")}</div></div>
    <p>${esc(t.desc)}</p>
    <div class="em-tpl-actions"><button type="button" class="btn btn-primary btn-sm" data-act="use" data-id="${t.id}">Use</button>
      <button type="button" class="btn btn-outline btn-sm" data-act="preview-b" data-id="${t.id}"><i class="fa-solid fa-eye"></i> Preview</button>
      <button type="button" class="btn btn-outline btn-sm" data-act="dup-b" data-id="${t.id}" title="নিজের টেমপ্লেট হিসেবে কপি করুন"><i class="fa-solid fa-clone"></i></button></div></article>`).join("");

function paintMine() {
  if (!table) return;
  if (S.templatesError) { table.setState(isDenied(S.templatesError) ? rulesHint("Email templates") : errorState({ title: "টেমপ্লেট লোড হয়নি", text: String(S.templatesError?.message || S.templatesError) })); return; }
  table.setRows(S.templates, { keepPage: true });
}

export const templates = {
  mount(el) {
    host = el;
    el.innerHTML = `
      <div class="panel"><div class="panel-head"><div><h2>Built-in templates</h2><small>সবসময় আছে — বদলানো যায় না, কিন্তু ব্যবহার করে বা কপি করে নিজের মতো এডিট করা যায়</small></div></div>
        <div class="panel-body"><div class="em-tpl-grid">${builtinCards()}</div></div></div>
      <div class="panel"><div class="panel-head"><div><h2>My templates</h2><small>আপনার ও অন্য অ্যাডমিনদের সেভ করা টেমপ্লেট</small></div>
        <div class="panel-actions"><button type="button" class="btn btn-primary btn-sm" data-act="new"><i class="fa-solid fa-plus"></i> New template</button></div></div>
        <div class="panel-body" id="tp-table"></div></div>`;
    table = createTable({
      mount: el.querySelector("#tp-table"), pageSize: 10,
      defaultSort: { key: "updated", dir: "desc" },
      empty: { icon: "fa-file-lines", title: "এখনো নিজের কোনো টেমপ্লেট নেই", text: "Compose থেকে “Save as template” করুন, অথবা ওপরের টেমপ্লেট কপি করে নিন।" },
      columns: [
        { key: "name", label: "Template", sortable: true, sortValue: (t) => (t.name || "").toLowerCase(), render: (t) => `<div class="cell-main"><div class="t">${esc(t.name)}</div>${t.desc ? `<div class="s">${esc(t.desc)}</div>` : ""}</div>` },
        { key: "type", label: "Best for", sortable: true, sortValue: (t) => t.type, render: (t) => esc(CAMPAIGN_TYPES[t.type]?.label || t.type) },
        { key: "lang", label: "Language", render: (t) => esc(LANGUAGES[normLang(t.lang)]) },
        { key: "updated", label: "Updated", sortable: true, sortValue: (t) => t.updatedAt?.toMillis?.() || 0, render: (t) => `<div class="cell-main"><div class="t">${fmtDateTime(t.updatedAt)}</div><div class="s">${esc(t.updatedBy || "")}</div></div>` },
        { key: "act", label: "", cls: "c-act", render: (t) => `<div class="row-actions"><button type="button" class="btn btn-primary btn-sm" data-act="use" data-id="${esc(t.id)}">Use</button>
          <button type="button" class="icon-btn" data-act="preview" data-id="${esc(t.id)}" title="Preview" aria-label="Preview ${esc(t.name)}"><i class="fa-solid fa-eye"></i></button>
          <button type="button" class="icon-btn" data-act="edit" data-id="${esc(t.id)}" title="Edit" aria-label="Edit ${esc(t.name)}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="icon-btn" data-act="dup" data-id="${esc(t.id)}" title="Duplicate" aria-label="Duplicate ${esc(t.name)}"><i class="fa-solid fa-clone"></i></button>
          <button type="button" class="icon-btn danger" data-act="del" data-id="${esc(t.id)}" title="Delete" aria-label="Delete ${esc(t.name)}"><i class="fa-solid fa-trash"></i></button></div>` },
      ],
    });
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const id = b.dataset.id;
      const built = BUILTIN_TEMPLATES.find((t) => t.id === id);
      const mine = S.templates.find((t) => t.id === id);
      switch (b.dataset.act) {
        case "new": openEditor(null, { content: contentFor(BUILTIN_TEMPLATES[0], S.draft.lang) }); break;
        case "use": await use(id); break;
        case "preview-b": openTemplatePreview(contentFor(built, S.draft.lang), S.draft.lang, built.name); break;
        case "dup-b": await duplicate(built, true); break;
        case "preview": if (mine) openTemplatePreview(mine.content, normLang(mine.lang), mine.name); break;
        case "edit": if (mine) openEditor(mine); break;
        case "dup": if (mine) await duplicate(mine, false); break;
        case "del":
          if (mine && await confirmDanger({ title: "টেমপ্লেট মুছবেন?", message: `“${mine.name}” মুছে যাবে। আগে পাঠানো ক্যাম্পেইনে কোনো প্রভাব পড়বে না।`, confirmLabel: "Delete" })) {
            try { await store.deleteTemplate(id); logAction("email.template.delete", { type: "email-template", id, label: mine.name }); toast("টেমপ্লেট মোছা হয়েছে", "success"); await refreshTemplates(); }
            catch (err) { toast(isDenied(err) ? "মোছার অনুমতি নেই" : `মোছা যায়নি: ${err?.message || err}`, "error"); }
          }
          break;
        default:
      }
    });
    on("templates", () => paintMine());
    paintMine();
  },
  refresh() { paintMine(); },
};
