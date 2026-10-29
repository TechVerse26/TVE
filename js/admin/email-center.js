// ==========================================================================
// admin/email-center.js — Admin Panel → Communication → Email Center.
//
// Personalised e-mail to students through EmailJS: announcements, reminders for students who have not submitted a chosen
// exam, hand-picked audiences, templates, a controlled bulk sender with retry, and a campaign history.
//
// This file is only the SHELL (tabs, loading, lifecycle). The work lives in js/admin/email/:
//   model.js    data + recipient logic          send.js     preview / test / bulk sending      store.js   Firestore
//   view-*.js   one file per tab                editor.js   message editor                     bits.js    shared UI pieces
// and in the pure, unit-tested modules js/email-core.js · js/email-render.js · js/email-templates-data.js · js/email-service.js.
//
// Same lifecycle as every other admin page:  mount(root) once, activate() on every later visit.
// Each tab keeps its own panel in the DOM, so switching tabs never reloads or redraws anything that has not changed.
// ==========================================================================
import { esc, pageHead, errorState, rulesHint, skeleton, withBusy } from "./core/ui.js";
import { toast } from "../utils.js";
import { onChange, takePending } from "./core/bus.js";
import { S, TABS, on, collect } from "./email/state.js";
import * as M from "./email/model.js";
import { overview } from "./email/view-overview.js";
import { compose } from "./email/view-compose.js";
import { reminders } from "./email/view-reminders.js";
import { recipients } from "./email/view-recipients.js";
import { templates } from "./email/view-templates.js";
import { history } from "./email/view-history.js";
import { settings } from "./email/view-settings.js";

const VIEWS = { overview, compose, reminders, recipients, templates, history, settings };
const STALE_AFTER = 5 * 60 * 1000;
let root = null, body = null, stale = false, booted = false;
const mounted = new Map(); // tab id → { el, stop }

/* ---------- tab strip ---------- */
function stripHtml() {
  return `<div class="em-tabs" role="tablist" aria-label="Email Center sections">${TABS.map((t) => `
    <button type="button" role="tab" id="em-tab-${t.id}" class="em-tab" data-tab="${t.id}" aria-controls="em-panel-${t.id}" aria-selected="false" tabindex="-1"><i class="fa-solid ${t.icon}" aria-hidden="true"></i><span>${esc(t.label)}</span></button>`).join("")}</div>`;
}

function show(id, { focus = false } = {}) {
  if (!VIEWS[id] || !body) return;
  S.tab = id;
  for (const t of TABS) {
    const btn = body.querySelector(`#em-tab-${t.id}`);
    const on_ = t.id === id;
    btn.setAttribute("aria-selected", String(on_));
    btn.tabIndex = on_ ? 0 : -1;
    const panel = body.querySelector(`#em-panel-${t.id}`);
    if (panel) panel.hidden = !on_;
  }
  if (focus) body.querySelector(`#em-tab-${id}`)?.focus();
  const panel = body.querySelector(`#em-panel-${id}`);
  if (!mounted.has(id)) {
    const stop = collect(() => VIEWS[id].mount(panel));
    mounted.set(id, { el: panel, stop });
  } else {
    VIEWS[id].refresh?.(panel);
  }
  body.querySelector(`#em-tab-${id}`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
}

function disposeAll() {
  for (const { stop } of mounted.values()) stop();
  mounted.clear();
}

/** Throw away every tab's DOM + subscriptions (after the base data was re-read); the visible tab is rebuilt at once. */
function resetPanels() {
  disposeAll();
  if (!body) return;
  for (const t of TABS) { const p = body.querySelector(`#em-panel-${t.id}`); if (p) p.innerHTML = ""; }
  show(S.tab);
}

function buildShell() {
  body.innerHTML = `${stripHtml()}<div class="em-panels">${TABS.map((t) => `<div id="em-panel-${t.id}" class="em-panel" role="tabpanel" aria-labelledby="em-tab-${t.id}" tabindex="0" hidden></div>`).join("")}</div>`;
  const strip = body.querySelector(".em-tabs");
  strip.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) show(b.dataset.tab); });
  strip.addEventListener("keydown", (e) => {
    const ids = TABS.map((t) => t.id);
    const i = ids.indexOf(S.tab);
    const next = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[e.key];
    if (next) { e.preventDefault(); show(next, { focus: true }); }
  });
}

/* ---------- loading ---------- */
function paintStatus() {
  if (!body) return;
  if (S.status === "loading") { body.innerHTML = skeleton(5); return; }
  if (S.status === "error") {
    body.innerHTML = S.denied ? rulesHint("Students & exams") : errorState({ title: "Email Center-এর ডেটা লোড করা যায়নি", text: String(S.error?.message || S.error || ""), action: `<button type="button" class="btn btn-primary btn-sm" data-retry>আবার চেষ্টা করুন</button>` });
    body.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    return;
  }
  buildShell();
  show(S.tab);
}

async function load(force = false) {
  disposeAll();
  body.innerHTML = skeleton(5);
  await M.loadBase({ force });
  stale = false;
  paintStatus();
  await takeActions();
}

/** Things other pages ask for: "Prepare email" on a notice, a specific tab. */
async function takeActions() {
  const noticeId = takePending("email-from-notice");
  if (noticeId && S.status === "ready") {
    try {
      const store = await import("./email/store.js");
      const notice = await store.loadNotice(noticeId);
      if (!notice) { toast("নোটিশটি পাওয়া যায়নি", "error"); return; }
      const { note } = await M.prepareFromNotice(notice);
      show("compose");
      toast(note || "নোটিশ থেকে ইমেইল-ড্রাফট তৈরি হয়েছে — প্রাপক দেখে নিন; কিছু পাঠানো হয়নি", note ? "info" : "success");
    } catch (err) { toast(`নোটিশ থেকে ড্রাফট করা যায়নি: ${err?.message || err}`, "error"); }
  }
  const tab = takePending("email-tab");
  if (tab && VIEWS[tab] && S.status === "ready") show(tab);
}

/* ---------- the module contract ---------- */
export async function mount(el) {
  root = el;
  M.initIdentity();
  root.innerHTML = `${pageHead({
    title: "Email Center",
    desc: "শিক্ষার্থীদের কাছে ব্যক্তিগতকৃত ইমেইল — EmailJS দিয়ে। প্রতিটি শিক্ষার্থী শুধু নিজের তথ্যসহ নিজের ইমেইল পায়।",
    actions: `<button type="button" class="btn btn-outline btn-sm" id="em-refresh" title="Re-read students, exams and history from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>`,
  })}<div class="stack" id="em-body"></div>`;
  body = root.querySelector("#em-body");
  root.querySelector("#em-refresh").addEventListener("click", async (e) => {
    if (S.sending) { toast("ইমেইল পাঠানো চলছে — শেষ হলে রিফ্রেশ করুন", "info"); return; }
    await withBusy(e.currentTarget, () => load(true));
    toast("ডেটা রিফ্রেশ হয়েছে", "success");
  });
  if (!booted) {
    booted = true;
    on("tab", (id) => show(id));
    onChange((kind) => { if (["users", "exams", "settings"].includes(kind)) stale = true; });
    // a campaign finishing changes the numbers shown on several tabs
    on("run-finished", () => { M.refreshCampaigns({ force: true }); });
  }
  if (!S.canManage) {
    body.innerHTML = errorState({ title: "অনুমতি নেই", text: "Email Center ব্যবহার করতে Super Admin বা Manager ভূমিকা লাগে।" });
    return;
  }
  await load(false);
}

export async function activate() {
  if (!body || !S.canManage) return;
  if (S.sending) return; // a campaign is running — leave everything as it is
  if (stale || (Date.now() - S.loadedAt > STALE_AFTER)) {
    await M.loadBase({ force: false });
    stale = false;
    if (S.status === "ready") resetPanels(); else paintStatus();
  } else if (S.status === "ready") {
    show(S.tab);
  }
  await takeActions();
}
