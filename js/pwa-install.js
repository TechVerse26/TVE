// ==========================================================================
// pwa-install.js — "Install app": header icon → preview popup → the browser's real install prompt.
//
//   header icon  (js/nav.js renders  <button data-pwa-install> )  ──click──►  popup (built once, on first use)
//   popup        screenshot (js/pwa-config.js) + app info + [Install App] / [Maybe Later]
//   Install App  →  retained beforeinstallprompt event .prompt()  →  userChoice (accepted / dismissed)
//                →  "appinstalled" confirms; nothing is ever shown as installed before the browser says so
//   no prompt    →  browser-specific steps (js/pwa-core.js), iOS: Share → Add to Home Screen
//
// State is mirrored onto <html> so the header icon needs no re-render:
//   html.pwa-standalone   running as the installed app → icon hidden
//   html.pwa-installed    install confirmed on this device → icon shows a check
// Everything is wired once (guarded), the popup is never opened mid-exam, and nothing here touches
// Firebase, auth, schedules or notifications.
// ==========================================================================
import { PWA_PREVIEW_IMAGE_URL, PWA_PREVIEW_IMAGE_ALT } from "./pwa-config.js";
import { resolvePreviewImageUrl, isStandaloneDisplay, detectPlatform, getInstallGuide } from "./pwa-core.js";

/* ---------- words (edit here) ---------- */
const COPY = {
  appName: "TECH VERSE EXAM",
  title: "Install Tech Verse Exam",
  description: "Your exams, practice sessions, and results — all in one convenient app experience.",
  install: "Install App",
  later: "Maybe Later",
  gotIt: "Got it",
  done: "Done",
  benefits: [["fa-bolt", "Fast Access"], ["fa-shield-halved", "Secure"], ["fa-feather", "Lightweight"]],
  installedTitle: "Tech Verse Exam is installed",
  installedDesc: "It's ready to use like any other app on your device.",
  installedStatus: "Open it from your home screen or app list.",
  waiting: "Confirm in the install prompt from your browser…",
  btnWaiting: "Waiting…",
  btnInstalling: "Installing…",
  installing: "Installing Tech Verse Exam…",
  slow: "Installation started. Tech Verse Exam will appear on your device shortly.",
  dismissed: "Installation was cancelled. You can try again whenever you like.",
  failed: "The install prompt couldn't be opened. Follow the steps below instead.",
  buttonInstall: "Install Tech Verse Exam app",
  buttonInstalled: "Tech Verse Exam is installed",
  buttonTitleInstall: "Install app",
};
const INSTALL_SLOW_AFTER_MS = 8000;
const CLOSE_MS = 200;

/* ---------- state ---------- */
const state = {
  deferred: null,        // the retained BeforeInstallPromptEvent (usable once)
  installed: false,      // confirmed by "appinstalled" or by the browser's installed-app lookup
  standalone: false,     // this window IS the installed app
  phase: "idle",         // idle | prompting | accepted | dismissed | error
  slow: false,           // accepted, but "appinstalled" has not arrived yet
  busy: false,
  message: "", tone: "info",
};
let ui = null;           // popup elements, built on first open
let isOpen = false;
let lastFocus = null;
let inertSnapshot = [];
let closeTimer = 0, installTimer = 0;
let downOnBackdrop = false;

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const platformInfo = () => detectPlatform({ ua: navigator.userAgent || "", platform: navigator.platform || "", maxTouchPoints: navigator.maxTouchPoints || 0 });

/* ==========================================================================
   Setup — runs once
   ========================================================================== */
export function initPwaInstall() {
  if (window.__tvePwaInstallReady) return;                 // never wire twice (even if this module were loaded twice)
  window.__tvePwaInstallReady = true;

  state.standalone = isStandaloneDisplay(window);
  wireNativeEvents();
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", () => { state.standalone = isStandaloneDisplay(window); syncDocument(); });

  document.addEventListener("click", (e) => {              // delegated: the header is re-rendered on every page / auth change
    const trigger = e.target.closest?.("[data-pwa-install]");
    if (!trigger) return;
    e.preventDefault();
    openInstallDialog(trigger);
  });
  document.addEventListener("tve:nav-rendered", syncButtons);
  window.addEventListener("hashchange", () => closeInstallDialog({ restoreFocus: false }));   // like the menu drawer: leaving the page closes it

  syncDocument();
  detectInstalledApp();
}

/** Native events: the early <head> script owns the listeners when present; otherwise we register them here (once). */
function wireNativeEvents() {
  const early = window.__tvePwaEarly;
  if (early) {
    if (early.event) retain(early.event);
    if (early.installed) markInstalled();
    window.addEventListener("tve:bip", () => { if (early.event) retain(early.event); });
    window.addEventListener("tve:installed", markInstalled);
  } else {
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); retain(e); });
    window.addEventListener("appinstalled", markInstalled);
  }
}

function retain(evt) {
  state.deferred = evt;
  state.installed = false;                                 // the browser offers installing → it is not installed
  if (state.phase === "dismissed" || state.phase === "error") { state.phase = "idle"; state.message = ""; }
  syncDocument();
  render();
}

function markInstalled() {
  clearTimeout(installTimer);
  state.deferred = null;
  state.installed = true;
  state.busy = false;
  state.phase = "idle";
  state.slow = false;
  state.message = COPY.installedStatus;
  state.tone = "success";
  syncDocument();
  render();
}

/** Visiting in a normal tab while the app is already installed: Chromium can tell (needs related_applications in the manifest). */
async function detectInstalledApp() {
  try {
    if (typeof navigator.getInstalledRelatedApps !== "function") return;
    const apps = await navigator.getInstalledRelatedApps();
    if (!state.deferred && apps.some((a) => a.platform === "webapp")) markInstalled();
  } catch { /* unsupported or blocked: fall back to the normal flow */ }
}

/* ==========================================================================
   Header + document state
   ========================================================================== */
function syncDocument() {
  const root = document.documentElement;
  root.classList.toggle("pwa-standalone", state.standalone);
  root.classList.toggle("pwa-installed", state.installed);
  syncButtons();
}

function syncButtons() {
  document.querySelectorAll("[data-pwa-install]").forEach((btn) => {
    btn.setAttribute("aria-label", state.installed ? COPY.buttonInstalled : COPY.buttonInstall);
    btn.setAttribute("title", state.installed ? COPY.buttonInstalled : COPY.buttonTitleInstall);
  });
}

/* ==========================================================================
   Installing
   ========================================================================== */
function currentMode() {
  if (state.installed) return "installed";
  if (state.phase === "prompting" || state.phase === "accepted") return "installing";
  return state.deferred ? "ready" : "guide";
}

function setStatus(message, tone = "info") { state.message = message; state.tone = tone; }

async function startInstall() {
  if (state.busy) return;                                  // no double prompts
  const evt = state.deferred;
  if (!evt) { render(); return; }                          // nothing to prompt with → the popup shows the manual steps
  state.busy = true;
  state.deferred = null;                                   // a retained prompt event can be used only once
  state.phase = "prompting";
  setStatus(COPY.waiting);
  render();
  try {
    const shown = evt.prompt();                            // called synchronously inside the click → counts as the user gesture
    const choice = await (evt.userChoice || shown);
    if (state.installed) return;                           // "appinstalled" already won the race
    if (choice?.outcome === "accepted") {
      state.phase = "accepted";
      state.slow = false;
      setStatus(COPY.installing);
      installTimer = setTimeout(() => {                    // accepted, yet no "appinstalled": say so honestly, never claim success
        if (state.installed) return;
        state.slow = true;
        setStatus(COPY.slow);
        render();
      }, INSTALL_SLOW_AFTER_MS);
    } else {
      state.phase = "dismissed";
      setStatus(COPY.dismissed, "warn");
    }
  } catch (err) {
    console.warn("[pwa] install prompt failed:", err);
    state.phase = "error";
    setStatus(COPY.failed, "warn");
  } finally {
    state.busy = false;
    render();
  }
}

/* ==========================================================================
   Popup — build once
   ========================================================================== */
const POPUP_HTML = `
<div class="pwa-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-title" aria-describedby="pwa-desc" tabindex="-1" lang="en">
  <button type="button" class="pwa-close" data-pwa-close aria-label="Close"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>
  <div class="pwa-grid">
    <div class="pwa-preview">
      <figure class="pwa-shot" data-el="shot">
        <img class="pwa-shot-img" data-el="img" alt="" decoding="async" fetchpriority="high">
        <div class="pwa-shot-fallback" data-el="fallback">
          <img src="assets/pwa/icon-192.png" alt="" width="56" height="56" decoding="async">
          <span>Tech Verse Exam</span>
        </div>
      </figure>
    </div>
    <div class="pwa-info">
      <div class="pwa-app">
        <img class="pwa-app-icon" src="assets/pwa/icon-192.png" alt="" width="56" height="56" decoding="async">
        <div class="pwa-app-text">
          <p class="pwa-app-name" data-el="appName"></p>
          <p class="pwa-app-host" data-el="host"></p>
        </div>
      </div>
      <h2 class="pwa-title" id="pwa-title" data-el="title"></h2>
      <p class="pwa-desc" id="pwa-desc" data-el="desc"></p>
      <ul class="pwa-benefits" data-el="benefits"></ul>
      <section class="pwa-guide" data-el="guide" hidden>
        <h3 class="pwa-guide-title" data-el="guideTitle"></h3>
        <ol class="pwa-steps" data-el="steps"></ol>
        <p class="pwa-guide-note" data-el="note" hidden></p>
      </section>
      <p class="pwa-status" data-el="status" aria-hidden="true" hidden></p>
      <p class="sr-only" data-el="live" role="status" aria-live="polite"></p>
      <div class="pwa-actions">
        <button type="button" class="btn btn-primary pwa-primary" data-el="primary"></button>
        <button type="button" class="btn btn-ghost pwa-later" data-el="later" data-pwa-close></button>
      </div>
    </div>
  </div>
</div>`;

function buildPopup() {
  if (ui) return;
  const overlay = document.createElement("div");
  overlay.className = "pwa-overlay";
  overlay.id = "pwa-install-overlay";
  overlay.hidden = true;
  overlay.innerHTML = POPUP_HTML;                          // static markup only — every dynamic value below goes in via textContent / properties
  document.body.appendChild(overlay);

  ui = { overlay, dialog: overlay.querySelector(".pwa-dialog") };
  overlay.querySelectorAll("[data-el]").forEach((el) => { ui[el.dataset.el] = el; });

  ui.appName.textContent = COPY.appName;
  ui.host.textContent = window.location.host || "";
  ui.later.textContent = COPY.later;
  ui.benefits.setAttribute("aria-label", "Benefits");
  COPY.benefits.forEach(([icon, label]) => {
    const li = document.createElement("li");
    const i = document.createElement("i");
    i.className = `fa-solid ${icon}`;
    i.setAttribute("aria-hidden", "true");
    li.append(i, label);
    ui.benefits.appendChild(li);
  });

  setupPreviewImage();

  overlay.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && downOnBackdrop) { closeInstallDialog(); return; }       // click outside (not a drag that ended outside)
    downOnBackdrop = false;
    if (e.target.closest("[data-pwa-close]")) { closeInstallDialog(); return; }
    if (e.target.closest("[data-el='primary']")) {
      if (ui.primary.dataset.action === "install") startInstall(); else closeInstallDialog();
    }
  });
}

/** The screenshot comes from pwa-config.js. Missing / broken link → neutral Tech Verse tile, never a made-up picture. */
function setupPreviewImage() {
  const src = resolvePreviewImageUrl(PWA_PREVIEW_IMAGE_URL, document.baseURI);
  const fallback = () => { ui.shot.classList.remove("is-loaded"); ui.shot.classList.add("is-fallback"); };
  if (!src) { fallback(); return; }
  ui.img.alt = PWA_PREVIEW_IMAGE_ALT || "App preview";
  ui.img.referrerPolicy = "no-referrer";
  ui.img.addEventListener("load", () => {
    if (!ui.img.naturalWidth) { fallback(); return; }
    ui.shot.style.setProperty("--shot-ar", `${ui.img.naturalWidth} / ${ui.img.naturalHeight}`);
    ui.shot.classList.add("is-loaded");
  });
  ui.img.addEventListener("error", fallback);
  ui.img.src = src;                                        // exactly the link that was configured
}

/* ==========================================================================
   Popup — content for the current state
   ========================================================================== */
function richText(parent, text) {                          // "**bold**" → <strong>, without innerHTML
  parent.textContent = "";
  text.split("**").forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const s = document.createElement("strong"); s.textContent = part; parent.appendChild(s); }
    else parent.appendChild(document.createTextNode(part));
  });
}

function setPrimary(action, iconClass, label, { spinner = false, disabled = false } = {}) {
  const btn = ui.primary;
  btn.dataset.action = action;
  btn.disabled = disabled;
  const lead = document.createElement(spinner ? "span" : "i");
  if (spinner) lead.className = "spinner"; else lead.className = `fa-solid ${iconClass}`;
  lead.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = label;
  btn.replaceChildren(lead, text);
}

function fillGuide() {
  const guide = getInstallGuide(platformInfo());
  ui.guideTitle.textContent = guide.title;
  ui.steps.replaceChildren(...guide.steps.map((s) => { const li = document.createElement("li"); richText(li, s); return li; }));
  ui.note.hidden = !guide.note;
  ui.note.textContent = guide.note || "";
}

function render() {
  if (!ui) return;
  const mode = currentMode();
  ui.overlay.dataset.mode = mode;

  ui.title.textContent = mode === "installed" ? COPY.installedTitle : COPY.title;
  ui.desc.textContent = mode === "installed" ? COPY.installedDesc : COPY.description;
  ui.benefits.hidden = mode === "installed";

  ui.guide.hidden = mode !== "guide";
  if (mode === "guide") fillGuide();

  if (ui.live.textContent !== state.message) ui.live.textContent = state.message;   // announced once, by a region that is always in the page
  ui.status.hidden = !state.message;
  ui.status.dataset.tone = state.tone;
  if (state.message) {
    const icon = document.createElement("i");
    icon.className = `fa-solid ${state.tone === "success" ? "fa-circle-check" : state.tone === "warn" ? "fa-triangle-exclamation" : "fa-circle-info"}`;
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = state.message;
    ui.status.replaceChildren(icon, text);
  }

  if (mode === "ready") setPrimary("install", "fa-download", COPY.install);
  else if (mode === "installing" && !state.slow) setPrimary("install", "", state.phase === "prompting" ? COPY.btnWaiting : COPY.btnInstalling, { spinner: true, disabled: true });
  else if (mode === "installing") setPrimary("close", "fa-check", COPY.done);
  else if (mode === "installed") setPrimary("close", "fa-check", COPY.done);
  else setPrimary("close", "fa-check", COPY.gotIt);
  ui.later.hidden = mode !== "ready";

  if (isOpen && !ui.dialog.contains(document.activeElement)) focusFirst();   // a disabled button may have dropped focus
}

/* ==========================================================================
   Popup — open / close, focus, scroll lock
   ========================================================================== */
const FOCUSABLE = "button:not([disabled]):not([hidden]), a[href], [tabindex]:not([tabindex='-1'])";
const focusables = () => [...ui.dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
function focusFirst() {
  const target = (!ui.primary.disabled && ui.primary) || focusables()[0] || ui.dialog;
  target.focus({ preventScroll: true });
}

export function openInstallDialog(trigger) {
  if (isOpen) return;
  if (document.body.classList.contains("exam-taking")) return;   // never during a live exam
  buildPopup();
  clearTimeout(closeTimer);
  if (state.phase === "dismissed" || state.phase === "error") { state.phase = "idle"; state.message = ""; }

  lastFocus = trigger || document.activeElement;
  isOpen = true;
  render();

  // everything behind the popup becomes inert (focus cannot leave it, screen readers skip the page)
  inertSnapshot = [...document.body.children]
    .filter((el) => el !== ui.overlay && !["SCRIPT", "STYLE", "LINK", "NOSCRIPT"].includes(el.tagName))
    .map((el) => [el, el.inert]);
  inertSnapshot.forEach(([el]) => { el.inert = true; });

  // lock page scroll without the page jumping sideways when the scrollbar disappears
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  document.documentElement.style.setProperty("--pwa-sbw", `${Math.max(0, scrollbar)}px`);
  document.documentElement.classList.add("pwa-lock");
  document.body.style.overflow = "hidden";

  ui.overlay.hidden = false;
  void ui.overlay.offsetWidth;                             // let the browser paint the closed state first → the transition runs
  ui.overlay.classList.add("is-open");
  document.addEventListener("keydown", onKeydown, true);
  focusFirst();
}

export function closeInstallDialog({ restoreFocus = true } = {}) {
  if (!ui || !isOpen) return;
  isOpen = false;
  document.removeEventListener("keydown", onKeydown, true);
  ui.overlay.classList.remove("is-open");

  inertSnapshot.forEach(([el, was]) => { el.inert = was; });
  inertSnapshot = [];
  document.body.style.overflow = "";
  document.documentElement.classList.remove("pwa-lock");

  clearTimeout(closeTimer);
  const finish = () => { if (!isOpen) ui.overlay.hidden = true; };
  if (reducedMotion()) finish(); else closeTimer = setTimeout(finish, CLOSE_MS);

  if (restoreFocus) {
    const back = lastFocus && document.contains(lastFocus) ? lastFocus : document.querySelector("[data-pwa-install]");
    back?.focus?.({ preventScroll: true });
  }
  lastFocus = null;
}

function onKeydown(e) {
  if (!isOpen) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeInstallDialog(); return; }
  if (e.key !== "Tab") return;
  const items = focusables();
  if (!items.length) { e.preventDefault(); ui.dialog.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  if (!ui.dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && (document.activeElement === first || document.activeElement === ui.dialog)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** For tests and diagnostics only. */
export const __pwaState = () => ({ ...state, open: isOpen, mode: currentMode() });
