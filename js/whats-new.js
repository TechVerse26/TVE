// ==========================================================================
// whats-new.js — "What's new" popup: shown ONCE per release to everyone (signed in or not),
// and re-openable any time from Profile → What's New.
//
//   • What it says lives in whats-new-data.js (one release at a time). Change `version` there → everyone sees it once more.
//   • "Seen" is remembered on this device only (localStorage). No Firestore read or write; nothing about the user is stored.
//   • It never interrupts the exam flow (#/exam), the login / signup forms, or a screen where another dialog or the menu
//     is already open (those lock page scrolling) — it simply waits for the next safe page.
//   • A real modal dialog: focus moves in and is kept inside, Escape / backdrop / button close it, the page behind is inert
//     and focus returns to where it was. Reduced-motion users get no animation.
// ==========================================================================
import { WHATS_NEW } from "./whats-new-data.js";
import { escapeHtml } from "./utils.js";

const KEY = "tvexam.whatsnew";
const QUIET_ROUTES = new Set(["exam", "login", "signup"]);
let current = null;                 // { close } while the dialog is on screen
let dismissedThisVisit = false;     // fallback when localStorage is unavailable (private mode)

const routeName = () => window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || "home";
function readSeen() { try { return window.localStorage.getItem(KEY); } catch { return null; } }
function writeSeen() {
  try { window.localStorage.setItem(KEY, WHATS_NEW.version); }
  catch { dismissedThisVisit = true; }          // storage unavailable (private mode): remember for this visit only
}
const alreadySeen = () => dismissedThisVisit || readSeen() === WHATS_NEW.version;
const isSafePage = () =>
  !QUIET_ROUTES.has(routeName()) && !document.body.classList.contains("exam-taking") && document.body.style.overflow !== "hidden";

function dateText() {
  try { return new Date(`${WHATS_NEW.date}T12:00:00+06:00`).toLocaleDateString("bn-BD", { day: "numeric", month: "long", year: "numeric" }); }
  catch { return WHATS_NEW.date; }
}

function dialogHtml() {
  const items = WHATS_NEW.items.map((it) => `
      <li class="wn-item">
        <span class="wn-ico" data-tone="${escapeHtml(it.tone || "blue")}" aria-hidden="true"><i class="fa-solid ${escapeHtml(it.icon || "fa-star")}"></i></span>
        <div><b>${escapeHtml(it.title)}</b><p>${escapeHtml(it.text)}</p></div>
      </li>`).join("");
  return `
    <div class="wn-sheet" role="dialog" aria-modal="true" aria-labelledby="wn-title" aria-describedby="wn-lead">
      <header class="wn-head">
        <span class="wn-badge"><i class="fa-solid fa-gift" aria-hidden="true"></i> WHAT'S NEW</span>
        <h2 id="wn-title">${escapeHtml(WHATS_NEW.title)}</h2>
        <p id="wn-lead">${escapeHtml(WHATS_NEW.lead)}</p>
        <time class="wn-date" datetime="${escapeHtml(WHATS_NEW.date)}">${escapeHtml(dateText())}</time>
        <button type="button" class="wn-close" data-wn-close aria-label="বন্ধ করুন"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </header>
      <ul class="wn-list">${items}</ul>
      <footer class="wn-foot"><button type="button" class="btn btn-primary" id="wn-ok" data-wn-close>ঠিক আছে, শুরু করি</button></footer>
    </div>`;
}

export function openWhatsNew() {
  if (current || !WHATS_NEW.enabled || !WHATS_NEW.items?.length) return;
  const overlay = document.createElement("div");
  overlay.className = "wn-overlay";
  overlay.id = "wn-overlay";
  overlay.innerHTML = dialogHtml();

  const previousFocus = document.activeElement;
  const behind = [...document.body.children]                       // everything that is on the page right now becomes inert
    .filter((el) => !["SCRIPT", "STYLE", "LINK", "NOSCRIPT"].includes(el.tagName))
    .map((el) => [el, el.inert]);
  behind.forEach(([el]) => { el.inert = true; });
  document.body.appendChild(overlay);
  const sheet = overlay.querySelector(".wn-sheet");
  document.body.style.overflow = "hidden";

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;                                   // keep Tab inside the dialog
    const f = [...sheet.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])")];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    behind.forEach(([el, was]) => { el.inert = was; });
    document.body.style.overflow = "";
    current = null;
    writeSeen();
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus?.({ preventScroll: true });
  }
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-wn-close]")) close(); });
  document.addEventListener("keydown", onKey, true);
  current = { close };
  overlay.querySelector("#wn-ok").focus({ preventScroll: true });
}

/** Called once at start-up. */
export function initWhatsNew() {
  if (!WHATS_NEW.enabled) return;
  document.addEventListener("click", (e) => {                      // "What's New" entries (Profile menu)
    if (!e.target.closest("[data-open-whatsnew]")) return;
    e.preventDefault();
    openWhatsNew();
  });
  const tryAuto = () => { if (!current && !alreadySeen() && isSafePage()) openWhatsNew(); };
  window.setTimeout(tryAuto, 1500);                                // let the first screen paint before anything pops up
  window.addEventListener("hashchange", () => {
    if (current) current.close();                                  // Back / a link while it is open: close it and move on
    else window.setTimeout(tryAuto, 1500);
  });
}
