// ==========================================================================
// admin/settings-page.js — project settings (Super Admin only).
// One schema drives the whole form: tabs → sections of typed fields. Changes stay in a draft until
// "Save changes"; "Reset" only resets the draft of the open tab. Maintenance mode is also copied into
// examIndex/main.site so students learn about it from the document they already read.
// ==========================================================================
import { toast } from "../utils.js";
import * as cache from "../cache.js";
import { esc, $, $$, pageHead, chip, withBusy, errorState, isDenied, ago, confirmDanger } from "./core/ui.js";
import { DEFAULTS, getSettings, saveSettings, publishSiteConfig, settingsMeta, loadSettings } from "./core/settings.js";
import { writeFeedFields } from "../home-data.js";
import { logAction } from "./core/audit.js";
import { emitChange } from "./core/bus.js";
import { me } from "./admin.js";

const SCHEMA = [
  { id: "general", label: "General", icon: "fa-sliders", note: "প্যানেলের সাধারণ আচরণ।", fields: [
    { key: "orgName", label: "Site name", type: "text", max: 60, hint: "অ্যাডমিন হেডার ও ব্রাউজার ট্যাবে দেখায়।" },
    { key: "pageSize", label: "Rows per page", type: "select", options: [10, 25, 50, 100], num: true, hint: "সব টেবিলের ডিফল্ট সাইজ (টেবিলের নিচে আলাদা করেও বদলানো যায়)।" },
    { key: "compact", label: "Compact tables", type: "switch", hint: "টেবিলের সারির ফাঁকা জায়গা কমায় — বেশি ডেটা এক স্ক্রিনে।" },
  ] },
  { id: "exam", label: "Exams", icon: "fa-file-pen", note: "“Create exam from questions” ও নতুন এক্সামের ডিফল্ট মান।", fields: [
    { key: "examType", label: "Default type", type: "select", options: [{ v: "live", l: "Live" }, { v: "practice", l: "Practice" }] },
    { key: "duration", label: "Default time limit (minutes)", type: "number", min: 1, max: 600 },
    { key: "maxAttempts", label: "Default max attempts", type: "number", min: 0, max: 100, hint: "0 = সীমাহীন।" },
    { key: "negativeMarking", label: "Default negative marking", type: "number", min: 0, max: 5, step: 0.05, hint: "প্রতি ভুল উত্তরে কাটা নম্বর। Practice এক্সামে কখনো প্রযোজ্য নয়।" },
    { key: "shuffle", label: "Shuffle questions & options", type: "switch" },
    { key: "layout", label: "Default layout", type: "select", options: [{ v: "one", l: "One question at a time" }, { v: "all", l: "All questions on one page" }] },
  ] },
  { id: "result", label: "Results", icon: "fa-square-poll-vertical", note: "পাস/ফেল নির্ধারণ।", fields: [
    { key: "passPercent", label: "Default pass percentage", type: "number", min: 1, max: 100, hint: "যে এক্সামে আলাদা পাস মার্ক দেওয়া নেই, সেগুলোতে প্রযোজ্য। Results, Dashboard ও Analytics-এর পাস রেট এর ভিত্তিতে।" },
  ] },
  { id: "users", label: "Users", icon: "fa-users", note: "শিক্ষার্থী ব্যবস্থাপনা।", fields: [
    { key: "inactiveDays", label: "Inactive after (days)", type: "number", min: 1, max: 365, hint: "এত দিন কোনো এক্সাম না দিলে শিক্ষার্থী “inactive” ধরা হবে (Students ফিল্টার ও “Active” সংখ্যা)।" },
  ] },
  { id: "question", label: "Questions", icon: "fa-circle-question", note: "Question Bank-এর নিয়ম।", fields: [
    { key: "defaultDifficulty", label: "Default difficulty", type: "select", options: [{ v: "easy", l: "Easy" }, { v: "medium", l: "Medium" }, { v: "hard", l: "Hard" }] },
    { key: "minOptions", label: "Minimum options", type: "number", min: 2, max: 6 },
    { key: "maxOptions", label: "Maximum options", type: "number", min: 2, max: 8 },
    { key: "requireExplanation", label: "Require an explanation", type: "switch", hint: "প্রশ্ন সংরক্ষণের আগে ব্যাখ্যা লিখতেই হবে (ইমপোর্টে বাধ্যতামূলক নয়)।" },
  ] },
  { id: "notification", label: "Notifications", icon: "fa-bell", note: "নোটিফিকেশন কম্পোজারের ডিফল্ট।", fields: [
    { key: "defaultAudience", label: "Default audience", type: "select", options: [{ v: "all", l: "All students" }, { v: "enrolled", l: "Enrolled in selected courses" }] },
  ] },
  { id: "security", label: "Security", icon: "fa-shield-halved", note: "অ্যাডমিন সেশন ও বিপজ্জনক কাজের সুরক্ষা।", fields: [
    { key: "idleMinutes", label: "Auto sign-out after inactivity (minutes)", type: "number", min: 0, max: 480, hint: "0 = বন্ধ। পরবর্তী লগইন/রিলোড থেকে কার্যকর।" },
    { key: "typeToConfirm", label: "Type-to-confirm for bulk deletes", type: "switch", hint: "একাধিক জিনিস মোছার আগে “delete” লিখে নিশ্চিত করতে হবে।" },
  ] },
  { id: "site", label: "Site status", icon: "fa-screwdriver-wrench", note: "শিক্ষার্থীদের জন্য মেইনটেন্যান্স মোড।", fields: [
    { key: "maintenance", label: "Maintenance mode", type: "switch", hint: "চালু থাকলে শিক্ষার্থীরা নতুন এক্সাম শুরু করতে পারবে না এবং এক্সাম তালিকায় নোটিশ দেখবে। অ্যাডমিনরা স্বাভাবিকভাবে এক্সাম খুলতে পারবে। চলমান এক্সাম বন্ধ হবে না।" },
    { key: "message", label: "Message shown to students", type: "textarea", max: 300, hint: "ফাঁকা রাখলে ডিফল্ট বার্তা দেখাবে।" },
  ] },
];

let root, draft, saved, tab = "general";
const clone = (o) => JSON.parse(JSON.stringify(o));
const dirtyTabs = () => SCHEMA.filter((t) => JSON.stringify(draft[t.id]) !== JSON.stringify(saved[t.id])).map((t) => t.id);

export async function mount(el) {
  root = el;
  saved = clone(getSettings());
  draft = clone(saved);
  root.innerHTML = `
    ${pageHead({ title: "Settings", desc: "প্রজেক্টের গুরুত্বপূর্ণ কনফিগারেশন — আলাদা আলাদা ট্যাবে।",
      actions: `<span class="muted" id="st-meta" style="font-size:.8rem"></span>
        <button type="button" class="btn btn-outline btn-sm" id="set-discard" disabled>Discard</button>
        <button type="button" class="btn btn-primary btn-sm" id="set-save" disabled><i class="fa-solid fa-floppy-disk"></i> Save changes</button>` })}
    <div id="set-banner"></div>
    <div class="split">
      <nav class="vtabs" id="set-tabs" aria-label="Settings sections"></nav>
      <div class="panel" id="set-panel"></div>
    </div>`;
  $("#set-tabs", root).addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; paint(); } });
  $("#set-save", root).addEventListener("click", save);
  $("#set-discard", root).addEventListener("click", () => { draft = clone(saved); paint(); });
  root.addEventListener("input", onField);
  root.addEventListener("change", onField);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-reset]")) { draft[tab] = clone(DEFAULTS[tab]); paint(); }
  });
  paint();
}

export function activate() { /* nothing changes these values elsewhere */ }

function fieldHtml(t, fl) {
  const v = draft[t.id][fl.key], id = `f-${t.id}-${fl.key}`;
  const hint = fl.hint ? `<span class="form-hint">${esc(fl.hint)}</span>` : "";
  if (fl.type === "switch") return `<div class="field"><label class="switch"><input type="checkbox" id="${id}" data-k="${fl.key}" ${v ? "checked" : ""}><span>${esc(fl.label)}</span></label>${hint}</div>`;
  if (fl.type === "select") return `<div class="field"><label for="${id}">${esc(fl.label)}</label><select id="${id}" data-k="${fl.key}" ${fl.num ? 'data-num="1"' : ""}>${fl.options.map((o) => { const val = typeof o === "object" ? o.v : o, lab = typeof o === "object" ? o.l : o; return `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(lab)}</option>`; }).join("")}</select>${hint}</div>`;
  if (fl.type === "textarea") return `<div class="field"><label for="${id}">${esc(fl.label)}</label><textarea id="${id}" data-k="${fl.key}" rows="3" maxlength="${fl.max || 500}">${esc(v)}</textarea>${hint}</div>`;
  if (fl.type === "number") return `<div class="field"><label for="${id}">${esc(fl.label)}</label><input type="number" id="${id}" data-k="${fl.key}" data-num="1" value="${esc(v)}" ${fl.min !== undefined ? `min="${fl.min}"` : ""} ${fl.max !== undefined ? `max="${fl.max}"` : ""} ${fl.step ? `step="${fl.step}"` : ""}>${hint}</div>`;
  return `<div class="field"><label for="${id}">${esc(fl.label)}</label><input type="text" id="${id}" data-k="${fl.key}" value="${esc(v)}" maxlength="${fl.max || 120}" autocomplete="off">${hint}</div>`;
}

function paint() {
  const dirty = dirtyTabs();
  $("#set-tabs", root).innerHTML = SCHEMA.map((t) => `<button type="button" class="vtab${t.id === tab ? " on" : ""}" data-tab="${t.id}"><i class="fa-solid ${t.icon}" style="width:16px;text-align:center"></i>${esc(t.label)}${dirty.includes(t.id) ? ` <span class="chip amber" style="margin-inline-start:auto;padding:0 7px">•</span>` : ""}</button>`).join("");
  const t = SCHEMA.find((x) => x.id === tab);
  $("#set-panel", root).innerHTML = `
    <div class="panel-head"><div><h2>${esc(t.label)}</h2><small>${esc(t.note)}</small></div><button type="button" class="btn btn-outline btn-sm" data-reset><i class="fa-solid fa-rotate-left"></i> Reset to defaults</button></div>
    <div class="panel-body">${t.id === "site" && draft.site.maintenance ? `<div class="note warn" style="margin-bottom:14px"><b>মেইনটেন্যান্স মোড চালু হবে।</b> Save করার পর শিক্ষার্থীরা নতুন এক্সাম শুরু করতে পারবে না।</div>` : ""}
      <div class="stack" style="gap:2px">${t.fields.map((fl) => fieldHtml(t, fl)).join("")}</div></div>`;
  $("#set-save", root).disabled = !dirty.length;
  $("#set-discard", root).disabled = !dirty.length;
  const meta = settingsMeta();
  $("#st-meta", root).textContent = dirty.length ? `${dirty.length}টি ট্যাবে অসংরক্ষিত পরিবর্তন` : meta.source === "saved" ? `সংরক্ষিত${meta.updatedBy ? ` · ${meta.updatedBy}` : ""}` : meta.source === "blocked" ? "Rules প্রকাশিত নয়" : "ডিফল্ট মান";
  $("#set-banner", root).innerHTML = meta.source === "blocked" ? `<div class="note warn" style="margin-bottom:14px"><b>Settings rules প্রকাশিত নয়।</b> ডিফল্ট মান ব্যবহার হচ্ছে এবং সংরক্ষণ কাজ করবে না — firestore.rules Publish করুন।</div>` : "";
}

function onField(e) {
  const el = e.target.closest("[data-k]");
  if (!el || !draft) return;
  const t = SCHEMA.find((x) => x.id === tab), fl = t.fields.find((x) => x.key === el.dataset.k);
  let v = el.type === "checkbox" ? el.checked : el.value;
  if (el.dataset.num) { v = Number(v); if (Number.isNaN(v)) return; if (fl.min !== undefined) v = Math.max(fl.min, v); if (fl.max !== undefined) v = Math.min(fl.max, v); }
  draft[tab][el.dataset.k] = typeof v === "string" ? v.slice(0, fl.max || 500) : v;
  // keep the tab dots and the save button in step without rebuilding the field being typed in
  const dirty = dirtyTabs();
  $("#set-save", root).disabled = !dirty.length; $("#set-discard", root).disabled = !dirty.length;
  $("#st-meta", root).textContent = dirty.length ? `${dirty.length}টি ট্যাবে অসংরক্ষিত পরিবর্তন` : "";
  if (el.type === "checkbox" && tab === "site") paint();
  else $$("#set-tabs .vtab", root).forEach((b) => { const has = dirty.includes(b.dataset.tab); b.querySelector(".chip")?.remove(); if (has) b.insertAdjacentHTML("beforeend", ` <span class="chip amber" style="margin-inline-start:auto;padding:0 7px">•</span>`); });
}

function validate() {
  const q = draft.question;
  if (q.minOptions > q.maxOptions) return "Minimum options সর্বোচ্চ অপশনের চেয়ে বেশি হতে পারে না (Questions ট্যাব)";
  if (!draft.general.orgName.trim()) return "Site name ফাঁকা রাখা যাবে না (General ট্যাব)";
  return "";
}

async function save() {
  const problem = validate();
  if (problem) { toast(problem, "error"); return; }
  const changed = dirtyTabs();
  if (changed.includes("site") && draft.site.maintenance && !saved.site.maintenance
    && !(await confirmDanger({ title: "মেইনটেন্যান্স মোড চালু করবেন?", message: "শিক্ষার্থীরা নতুন এক্সাম শুরু করতে পারবে না এবং এক্সাম তালিকায় নোটিশ দেখবে। চলমান এক্সাম বন্ধ হবে না।", confirmLabel: "Turn on" }))) return;
  await withBusy($("#set-save", root), async () => {
    try {
      await saveSettings(draft, me?.profile?.displayName || me?.user?.email || "");
      let siteOk = true;
      if (changed.includes("site")) { try { await publishSiteConfig(draft.site); cache.del("exams:catalog"); } catch { siteOk = false; } }
      saved = clone(getSettings());
      draft = clone(saved);
      // Students' pass-mark default (result cards, "My Performance") comes from the home feed — keep it in step (best effort).
      if (changed.includes("result")) writeFeedFields({ passPercent: saved.result.passPercent }).catch(() => {});
      logAction("settings.update", { type: "settings", label: changed.map((id) => SCHEMA.find((t) => t.id === id).label).join(", "), detail: changed.includes("site") ? `maintenance ${saved.site.maintenance ? "ON" : "OFF"}` : "" });
      emitChange("settings");
      paint();
      toast(siteOk ? "সেটিংস সংরক্ষিত হয়েছে" : "সেটিংস সংরক্ষিত, কিন্তু মেইনটেন্যান্স মোড শিক্ষার্থীদের কাছে পৌঁছায়নি — আবার চেষ্টা করুন", siteOk ? "success" : "error");
    } catch (err) {
      toast(isDenied(err) ? "সংরক্ষণের অনুমতি নেই — শুধু Super Admin, এবং firestore.rules Publish করা থাকতে হবে" : "সংরক্ষণ করা যায়নি", "error");
    }
  });
}
