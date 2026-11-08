// ==========================================================================
// push-ui.js — what a student sees of push notifications. Loaded by push-boot.js only after the one-time setup.
//
//   1. The explaining card  ("চালু করুন / এখন নয়")  a small card at the bottom — only when push-core's promptDecision says so,
//      at most once per visit, then 7 days of silence, then 30, then never. Showing it counts as having asked.
//   2. The settings card on #/notifications     turn on / off, which kinds, this account's devices; calm "blocked" / "not supported" states.
//   3. The in-page banner                       a notification that arrives while the site is open and visible.
//
//   It owns no data: push-student.js holds the state and the rules, push-views.js builds the HTML. This file puts it on the
//   page and forwards clicks. The browser's permission dialog is opened only by S.enable(), which is called straight from a click.
//   css/push.css is added on first use, so index.html does not change.
// ==========================================================================
import { toast } from "../utils.js";
import { pushConfigured } from "./push-config.js";
import * as C from "./push-core.js";
import { promptHtml, settingsHtml, bannerHtml, enableLabel } from "./push-views.js";

const BANNER_MS = 9000;
const BANNER_MAX = 3;

let S = null;            // push-student.js (module namespace)
let promptEl = null;
let promptUid = "";
let evalTimer = 0;
let navTimer = 0;
let lastPhase = "";
let devicesAskedFor = "";
let settingsCache = "";

const routeName = () => window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
const examTaking = () => document.body.classList.contains("exam-taking");
const overlayOpen = () =>
  !!document.querySelector("#wn-overlay, #active-modal-overlay, .modal-overlay, .pwa-overlay.is-open, .result-modal-overlay.is-open")
  || document.body.style.overflow === "hidden";                                         // the menu drawer and other dialogs lock scrolling

/* ---------- styles ---------- */
function loadCss() {
  if (document.getElementById("tvp-css")) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.id = "tvp-css";
    link.rel = "stylesheet";
    link.href = new URL("css/push.css", document.baseURI).href;
    link.onload = link.onerror = () => resolve();                                       // a missing style file must never block the feature
    document.head.appendChild(link);
  });
}

function ensureRoot() {
  let root = document.getElementById("tvp-root");
  if (root) return root;
  root = document.createElement("div");
  root.id = "tvp-root";
  root.innerHTML = '<div class="tvp-banners" id="tvp-banners" role="status" aria-live="polite"></div><div id="tvp-prompt-slot"></div>';
  document.body.appendChild(root);
  return root;
}

/** Replace the HTML of `el`, keeping keyboard focus on the same control (a switch the student just toggled, say). */
function setHtmlKeepFocus(el, html) {
  const a = document.activeElement;
  let sel = "";
  if (a && el.contains(a)) {
    if (a.getAttribute("data-pref")) sel = `[data-pref="${a.getAttribute("data-pref")}"]`;
    else if (a.getAttribute("data-tvp")) sel = `[data-tvp="${a.getAttribute("data-tvp")}"]`;
  }
  el.innerHTML = html;
  if (sel) { const n = el.querySelector(sel); if (n && !n.disabled) n.focus({ preventScroll: true }); }
}

/* ==========================================================================
   1. The explaining card
   ========================================================================== */
function showPrompt(s) {
  if (promptEl) return;
  const el = document.createElement("section");
  el.id = "tvp-prompt";
  el.className = "tvp-prompt";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-labelledby", "tvp-p-title");
  el.setAttribute("aria-describedby", "tvp-p-text");
  el.innerHTML = promptHtml();
  document.getElementById("tvp-prompt-slot").appendChild(el);
  promptEl = el;
  promptUid = s.uid;
  S.dismissPrompt(s.uid, false);          // shown = asked once, so ignoring the card equals "not now" — it can never nag
  patchPrompt(s);
}

function hidePrompt() {
  if (!promptEl) return;
  promptEl.remove();
  promptEl = null;
  promptUid = "";
}

function patchPrompt(s) {
  if (!promptEl) return;
  const busy = s.phase === "busy";
  const go = promptEl.querySelector('[data-tvp="enable"]');
  go.disabled = busy;
  go.innerHTML = enableLabel(busy);
  promptEl.querySelectorAll('[data-tvp="later"],[data-tvp="never"]').forEach((b) => { b.disabled = busy; });
  const err = promptEl.querySelector("[data-tvp-error]");
  err.textContent = s.error ? C.errorText(s.error) : "";
  err.hidden = !s.error;
}

function evaluatePrompt() {
  clearTimeout(evalTimer);
  if (!S) return;
  const s = S.getStatus();
  if (s.phase === "busy") return;                                   // a click is being processed — leave the card as it is
  const keeping = !!promptEl && promptUid === s.uid;                // already on screen: only a real reason to leave closes it
  const verdict = C.promptDecision({
    configured: pushConfigured(), support: s.support, signedIn: !!s.uid, permission: s.permission,
    enabledHere: s.phase === "on", examTaking: examTaking(), overlayOpen: overlayOpen(),
    resumeBar: !!document.querySelector("#resume-banner-root .rsb"),
    route: routeName(), rec: keeping ? {} : S.getPromptRec(s.uid), visits: keeping ? 99 : S.getVisits(s.uid), now: Date.now(),
  });
  if (verdict.show && s.phase === "off") showPrompt(s);
  else hidePrompt();
  if (verdict.reason === "busy" && !examTaking()) evalTimer = setTimeout(evaluatePrompt, 15000);   // a dialog or the exam bar is up: look again shortly
}

const schedule = (ms) => { clearTimeout(evalTimer); evalTimer = setTimeout(evaluatePrompt, ms); };

/* ==========================================================================
   2. The settings card
   ========================================================================== */
function syncSettingsSlot() {
  const mount = document.getElementById("generic-page-content");
  if (!mount) return;
  const tools = routeName() === "notifications" ? mount.querySelector("#nf-tools") : null;
  const existing = document.getElementById("tvp-settings");
  if (!tools) { if (existing) existing.remove(); return; }
  if (existing && existing.nextElementSibling === tools) return;    // still in the right place
  if (existing) existing.remove();
  const card = document.createElement("section");
  card.id = "tvp-settings";
  card.className = "card tvp-card";
  card.setAttribute("aria-labelledby", "tvp-s-title");
  tools.parentNode.insertBefore(card, tools);
  settingsCache = "";
  renderSettings();
}

function renderSettings(s) {
  const card = document.getElementById("tvp-settings");
  s = s || (S && S.getStatus());
  if (!card || !s) return;
  const show = !!s.uid && s.phase !== "idle" && s.phase !== "unconfigured";
  card.hidden = !show;
  if (!show) return;
  if (s.phase === "on") {
    if (!s.devices && devicesAskedFor !== s.uid) { devicesAskedFor = s.uid; S.refreshDevices().catch(() => { /* the list is optional */ }); }
  } else devicesAskedFor = "";
  const html = settingsHtml(s);
  if (html === settingsCache) return;
  settingsCache = html;
  setHtmlKeepFocus(card, html);
}

/* ==========================================================================
   3. The in-page banner
   ========================================================================== */
function removeBanner(el) { clearTimeout(el._tvpTimer); el.remove(); }
function clearBanners() { document.querySelectorAll("#tvp-banners .tvp-banner").forEach(removeBanner); }

function showBanner(n) {
  const host = document.getElementById("tvp-banners");
  if (!host || examTaking()) return;
  const el = document.createElement("div");
  el.className = "tvp-banner";
  el.dataset.cat = n.cat;
  el.dataset.url = n.url;
  el.dataset.nid = n.nid;
  el.innerHTML = bannerHtml(n);
  host.appendChild(el);
  while (host.children.length > BANNER_MAX) removeBanner(host.firstElementChild);
  const stop = () => clearTimeout(el._tvpTimer);
  const start = () => { stop(); el._tvpTimer = setTimeout(() => removeBanner(el), BANNER_MS); };
  el.addEventListener("mouseenter", stop);
  el.addEventListener("mouseleave", start);
  el.addEventListener("focusin", stop);
  el.addEventListener("focusout", start);
  start();
}

/* ==========================================================================
   Events
   ========================================================================== */
async function onEnable() {
  const res = await S.enable();                                     // opens the browser's permission dialog first thing — we are still inside the click
  if (res.ok) { toast("নোটিফিকেশন চালু হয়েছে।", "success"); hidePrompt(); return; }
  if (res.code === "busy") return;
  if (res.code === "permission_denied" || res.code === "permission_dismissed") { hidePrompt(); toast(C.errorText(res.code), "error"); }
  // any other failure stays visible in whichever card was used (its status carries the error)
}

async function onClick(e) {
  const t = e.target.closest && e.target.closest("[data-tvp]");
  if (!t || !t.closest("#tvp-root, #tvp-settings")) return;
  switch (t.dataset.tvp) {
    case "enable": await onEnable(); break;
    case "later": hidePrompt(); break;
    case "never": {
      S.dismissPrompt(S.getStatus().uid, true);
      hidePrompt();
      toast("ঠিক আছে, আর জিজ্ঞেস করা হবে না। নোটিফিকেশন পেজ থেকে যেকোনো সময় চালু করতে পারবেন।");
      break;
    }
    case "disable": {
      const res = await S.disable();
      if (res.ok) toast("এই ডিভাইসে নোটিফিকেশন বন্ধ করা হয়েছে।");
      break;
    }
    case "go": {
      const banner = t.closest(".tvp-banner");
      const hash = C.safeRoute(banner && banner.dataset.url);
      if (banner) removeBanner(banner);
      if (hash && !examTaking() && window.location.hash !== hash) window.location.hash = hash;
      break;
    }
    case "close": { const banner = t.closest(".tvp-banner"); if (banner) removeBanner(banner); break; }
    default: break;
  }
}

async function onChange(e) {
  const t = e.target;
  if (!t || !t.matches || !t.matches("#tvp-settings input[data-pref]")) return;
  const res = await S.setPref(t.dataset.pref, t.checked);
  if (!res.ok && res.code !== "invalid") toast(C.errorText(res.code), "error");
}

function onKey(e) {
  if (e.key === "Escape" && promptEl && promptEl.contains(document.activeElement)) hidePrompt();
}

function onHash() {
  if (promptEl && !C.PROMPT_ROUTES.has(routeName())) hidePrompt();
  clearTimeout(navTimer);
  navTimer = setTimeout(evaluatePrompt, 700);                       // after the new page has drawn itself
  syncSettingsSlot();
}

function onStatusChange(s) {
  renderSettings(s);
  patchPrompt(s);
  if (s.phase !== lastPhase) { lastPhase = s.phase; schedule(s.phase === "off" ? 2500 : 0); }
}

/* ---------- entry ---------- */
export async function mount(student) {
  if (S) return;
  S = student;
  await loadCss();
  ensureRoot();
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", onHash);
  window.addEventListener("focus", () => S.recheck());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) S.recheck(); });
  new MutationObserver(() => { if (examTaking()) { clearBanners(); hidePrompt(); } }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const mountEl = document.getElementById("generic-page-content");
  if (mountEl) new MutationObserver(syncSettingsSlot).observe(mountEl, { childList: true });   // the page redraws itself on every visit
  S.onStatus(onStatusChange);
  S.onMessage(showBanner);
  syncSettingsSlot();
  onStatusChange(S.getStatus());
}
