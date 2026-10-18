// ==========================================================================
// copy-guard.js — keeps exam question text from being selected, copied,
// dragged or printed while an exam is on screen.
//
// What it stops: long-press selection (and the "Copy / Web search" bubble that
// comes with it), double / triple click, drag-select, Ctrl+A → Ctrl+C,
// right-click, text drag-and-drop, and printing / "Save as PDF" mid-exam.
// What NO web page can stop: a screenshot, a photo of the screen, and tools
// that read pixels (Google Lens, Circle to Search). See README → "প্রশ্ন কপি বন্ধ".
//
// Three independent layers, so beating one still leaves the other two:
//   1. CSS    (CSS below)            user-select / touch-callout off.
//   2. Events (bindCopyGuard below)  selectstart, contextmenu, dragstart, copy and
//                                    cut are cancelled inside a zone, and any selection that
//                                    reaches into a zone is dropped at once — this also
//                                    catches a browser or extension that overrides the CSS.
//   3. Drawn text (cgText below)     the words are painted by CSS generated content
//                                    (::before { content: attr(data-cg) }). Generated
//                                    content is not part of the page's text, so there is
//                                    nothing to select or copy even if 1 and 2 are switched off.
//
// Everything lives in this ONE file on purpose. The markup (cgText), the CSS that paints and protects it and the
// event handlers always ship together, so a browser that still has an older stylesheet cached can never show a
// blank question. And if the paint rule is somehow not active (blocked <style>, stripped CSS), cgText() notices
// and falls back to plain text — a student must never face an empty question; layers 1 and 2 still apply.
//
// Use:  bindCopyGuard(containerElement) once, then write guarded text with cgText(text) instead of
//       escapeHtml(text) inside that container. Anything outside a zone behaves exactly as before.
// ==========================================================================
import { escapeHtml } from "./utils.js";

const ZONE_CLASS = "cg-zone";
const ZONE = `.${ZONE_CLASS}`;

const CSS = `
.cg-zone, .cg-zone * {
  -webkit-user-select: none; -moz-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-user-drag: none;
}
.cg-text::before { content: attr(data-cg); }
/* exam.js puts body.exam-taking on while an exam runs: nothing of the question area is printed / saved as PDF then */
@media print { body.exam-taking .cg-zone { display: none !important; } }
`;

function ensureStyle() {
  if (typeof document === "undefined" || document.getElementById("cg-style")) return;
  const el = document.createElement("style");
  el.id = "cg-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}
ensureStyle();

let canDraw = null; // does this page really paint .cg-text::before? (asked once, the first time text is drawn)
function canDrawText() {
  if (canDraw !== null) return canDraw;
  try {
    const probe = document.createElement("span");
    probe.className = "cg-text";
    probe.setAttribute("data-cg", "x");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;";
    document.body.appendChild(probe);
    canDraw = getComputedStyle(probe, "::before").content.replace(/["']/g, "") === "x";
    probe.remove();
  } catch { canDraw = false; }
  if (!canDraw) console.warn("copy-guard: generated-content text is not painted on this page — showing plain text instead.");
  return canDraw;
}

/** Markup for text that must not be copyable. Use it instead of escapeHtml(text) inside a guarded container. */
export function cgText(text) {
  return canDrawText() ? `<span class="cg-text" data-cg="${escapeHtml(text)}"></span>` : escapeHtml(text);
}

const elementOf = (node) => (node && node.nodeType === 1 ? node : node?.parentElement || null);
const inZone = (node) => !!elementOf(node)?.closest?.(ZONE);

/** Does the current text selection reach into a guarded zone (e.g. Ctrl+A started outside it)? */
function selectionTouchesZone() {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const zones = document.querySelectorAll(ZONE);
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    for (const zone of zones) if (range.intersectsNode(zone)) return true;
  }
  return false;
}

let bound = false;

/**
 * Mark the given container element(s) as guarded zones and install the document-level listeners (once).
 * The listeners only ever act inside a zone, so calling this with more containers later is fine.
 */
export function bindCopyGuard(...containers) {
  ensureStyle();
  containers.forEach((el) => el?.classList.add(ZONE_CLASS));
  if (bound) return;
  bound = true;

  // Capture phase: runs before any other handler (or extension script) that could let the event through.
  const cancelInZone = (e) => { if (inZone(e.target)) e.preventDefault(); };
  ["selectstart", "contextmenu"].forEach((type) => document.addEventListener(type, cancelInZone, true));

  // Copy / cut / drag also count when the event starts OUTSIDE a zone but the selection being copied or dragged reaches into one.
  const cancelIfGuarded = (e) => {
    if (!inZone(e.target) && !selectionTouchesZone()) return;
    e.preventDefault();
    try { e.clipboardData?.setData("text/plain", ""); } catch { /* nothing to clear */ }
  };
  ["copy", "cut", "dragstart"].forEach((type) => document.addEventListener(type, cancelIfGuarded, true));

  // A selection that reaches into a zone (Ctrl+A, or a drag that starts outside it) is dropped at once.
  document.addEventListener("selectionchange", () => {
    if (selectionTouchesZone()) window.getSelection().removeAllRanges();
  });
}
