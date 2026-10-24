// ==========================================================================
// info-ui.js — what the six information pages have in common (About · FAQ · Help · Privacy · Terms · Credits):
//   • markup builders  page frame → hero → sections · cards · steps · accordion · call-to-action band · legal document
//   • behaviours       jump links (contents lists, topic tiles) · ?section= deep links · "you are here" in the contents list
//                      · copy-to-clipboard · broken-photo fallback
//
// Strings in, strings out for the builders (all text goes through info-core.js, which escapes it). No Firebase here —
// the page modules ask nav.js / utils.js for the signed-in state and pass it in.
//
// Behaviours attach to the page's OWN root element (the persistent #generic-page-content is never listened on, so a
// second visit can never stack handlers) and anything global (scroll / resize) is removed again through onPageLeave().
// ==========================================================================
import {
  esc, inline, plainInline, renderBlocks, prepareSections, collectOwnerKeys, pendingOwnerKeys, formatLongDate,
  makeTokenResolver, mailtoHref, sectionParam,
} from "./info-core.js";
import { SITE, OWNER_DETAILS } from "./info-config.js";
import { onPageLeave } from "./page-lifecycle.js";

/** The context every content string is rendered with: {email} {site} {name} {owner:key} resolve through it. */
export const INFO_CTX = Object.freeze({ token: makeTokenResolver({ site: SITE, owner: OWNER_DETAILS }) });

/* ==========================================================================
   Markup builders
   ========================================================================== */
/** The page root. lang="en": these pages are English even though the rest of the app is not (the <html> language is left alone). */
export const pageShell = (page, inner) => `<div class="container page inf" lang="en" data-page="${esc(page)}">${inner}</div>`;

export function heroHtml({ kicker = "", title, lead = "", back = true, meta = "", extra = "", actions = "" }) {
  return `<header class="inf-hero">
    ${back ? '<button type="button" class="inf-back" data-back><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>' : ""}
    ${kicker ? `<p class="inf-kicker">${esc(kicker)}</p>` : ""}
    <h1 class="inf-title">${esc(title)}</h1>
    ${lead ? `<p class="inf-lead">${inline(lead, INFO_CTX)}</p>` : ""}
    ${meta ? `<p class="inf-meta">${meta}</p>` : ""}
    ${extra}
    ${actions ? `<div class="inf-hero-actions">${actions}</div>` : ""}
  </header>`;
}

/** A page section: id (jump target) · heading · optional one-line intro · body html. */
export function sectionHtml({ id, title, sub = "", icon = "", body = "", cls = "" }) {
  return `<section class="section inf-section${cls ? ` ${cls}` : ""}" id="${esc(id)}" aria-labelledby="h-${esc(id)}">
    <div class="section-head"><div class="section-head-text">
      <h2 class="section-title inf-anchor" id="h-${esc(id)}">${icon ? `<i class="fa-solid ${esc(icon)}" aria-hidden="true"></i>` : ""}${esc(title)}</h2>
      ${sub ? `<p class="section-sub">${inline(sub, INFO_CTX)}</p>` : ""}
    </div></div>
    ${body}
  </section>`;
}

/** One card: icon + title + text (+ an optional link target that makes the whole card a link). */
export function cardHtml({ icon, tone = "", title, text = "", href = "", extra = "", attrs = "" }) {
  const iconHtml = `<span class="card-icon${tone ? ` card-icon--${esc(tone)}` : ""}" aria-hidden="true"><i class="fa-solid ${esc(icon)}"></i></span>`;
  if (href) {
    return `<a class="card inf-card inf-card--link" href="${esc(href)}"${attrs ? ` ${attrs}` : ""}>${iconHtml}<span class="inf-card-text"><b class="inf-card-title">${esc(title)}</b>${text ? `<span class="inf-card-desc">${esc(plainInline(text))}</span>` : ""}</span><i class="fa-solid fa-chevron-right inf-card-go" aria-hidden="true"></i></a>`;
  }
  return `<div class="card inf-card">${iconHtml}<div class="inf-card-text"><h3 class="inf-card-title">${esc(title)}</h3>${text ? `<p class="inf-card-desc">${inline(text, INFO_CTX)}</p>` : ""}${extra}</div></div>`;
}

/** A responsive grid of cards as a real list (cols = the number of columns on a wide screen: 2, 3 or 4). */
export const gridHtml = (cards, cols = 3) => `<ul class="inf-grid inf-grid--${cols}" role="list">${cards.map((c) => `<li>${c}</li>`).join("")}</ul>`;

/** Numbered steps: [{ title, text }]. layout "row" = four across on a wide screen · "list" = stacked. */
export function stepsHtml(steps, { layout = "row" } = {}) {
  return `<ol class="inf-steps inf-steps--${layout}" role="list">${steps.map((s) => `<li class="card inf-step"><div><h3 class="inf-step-title">${esc(s.title)}</h3><p class="inf-step-text">${inline(s.text, INFO_CTX)}</p></div></li>`).join("")}</ol>`;
}

/** A question/answer row: a native <details>, so it opens with Enter / Space / a tap and needs no script to be accessible.
 *  `meta` (optional, plain text) is a small muted line under the question — the FAQ uses it to name the category in search results. */
export function qaHtml({ id, q, a, open = false, cls = "", meta = "" }) {
  return `<details class="inf-qa${cls ? ` ${cls}` : ""}" id="${esc(id)}"${open ? " open" : ""}>
    <summary class="inf-q"><span class="inf-q-text">${inline(q, INFO_CTX)}${meta ? `<small class="inf-q-meta">${esc(meta)}</small>` : ""}</span><i class="fa-solid fa-chevron-down inf-caret" aria-hidden="true"></i></summary>
    <div class="inf-a inf-prose">${renderBlocks(a, INFO_CTX)}</div>
  </details>`;
}
export const accordionHtml = (items) => `<div class="inf-acc">${items.map(qaHtml).join("")}</div>`;

/** The closing band: a heading, one sentence and the buttons. */
export function ctaHtml({ title, text = "", actions = "" }) {
  return `<section class="inf-cta" aria-labelledby="h-cta">
    <div class="inf-cta-text"><h2 class="inf-cta-title" id="h-cta">${esc(title)}</h2>${text ? `<p>${inline(text, INFO_CTX)}</p>` : ""}</div>
    <div class="inf-cta-actions">${actions}</div>
  </section>`;
}

/** A button / link in the shared button style. */
export function btnHtml({ href, label, icon = "", kind = "primary", size = "", attrs = "" }) {
  return `<a class="btn btn-${esc(kind)}${size ? ` btn-${esc(size)}` : ""}" href="${esc(href)}"${attrs ? ` ${attrs}` : ""}>${icon ? `<i class="fa-solid ${esc(icon)}" aria-hidden="true"></i>` : ""}${esc(label)}</a>`;
}

/** The empty state of a filtered list (same look as every other empty state in the app). */
export const emptyHtml = ({ icon = "fa-face-meh", text, actions = "" }) =>
  `<div class="ui-state inf-empty"><i class="fa-regular ${esc(icon)}" aria-hidden="true"></i><p>${esc(text)}</p>${actions ? `<div class="inf-empty-actions">${actions}</div>` : ""}</div>`;

/* ---------- contact ---------- */
export const SUPPORT_SUBJECT = "Tech Verse Exam — support request";
export const SUPPORT_BODY = [
  "Hello,", "",
  "Name:", "Registered email:", "Roll number (if you have one):", "Exam name (if it is about an exam):",
  "Date and time it happened:", "Device and browser (e.g. Android phone, Chrome):", "",
  "What happened:", "",
  "What I expected:", "",
  "(Please do not write your password in this email.)",
].join("\n");

/** mailto: link to the support address with the subject and the "what to include" template filled in. */
export const supportMailto = (subject = SUPPORT_SUBJECT, body = SUPPORT_BODY) => mailtoHref({ to: SITE.email, subject, body });

/* ---------- legal documents ---------- */
/**
 * A legal document page: hero (with the "last updated" date) → [pending-details notice] → contents list + numbered sections.
 * `sections` = [{ title, blocks, id? }]. `route` = the page's route name (the contents links point at #/<route>?section=…).
 */
export function legalPageHtml({ route, kicker, title, lead, updatedIso, intro = [], sections, footer = [] }) {
  const secs = prepareSections(sections);
  const pending = pendingOwnerKeys(collectOwnerKeys([intro, secs.map((s) => s.blocks), footer]), OWNER_DETAILS);
  const dateText = formatLongDate(updatedIso);
  const meta = dateText ? `<i class="fa-regular fa-calendar" aria-hidden="true"></i> Last updated: <time datetime="${esc(updatedIso)}">${esc(dateText)}</time>` : "";
  const toc = `<nav class="inf-toc" aria-label="Contents">
      <details class="inf-toc-box" open>
        <summary class="inf-toc-sum"><span>Contents</span><i class="fa-solid fa-chevron-down inf-caret" aria-hidden="true"></i></summary>
        <ol class="inf-toc-list" role="list">${secs.map((s) => `<li><a href="#/${esc(route)}?section=${esc(s.id)}" data-jump="${esc(s.id)}" data-toc-link><span class="inf-toc-num">${s.num}</span><span>${esc(s.title)}</span></a></li>`).join("")}</ol>
      </details>
    </nav>`;
  const notice = pending.length
    ? `<aside class="inf-note inf-note--tbc" role="note" data-pending="${pending.length}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i><div><b>Some details are still to be confirmed.</b> Items marked “To be confirmed” depend on information that only the site operator can supply. They will appear here once the operator has confirmed them.</div></aside>`
    : "";
  const body = secs.map((s) => `<section class="inf-legal-sec" id="${esc(s.id)}" aria-labelledby="h-${esc(s.id)}" data-sec>
      <h2 class="inf-legal-h2 inf-anchor" id="h-${esc(s.id)}"><span class="inf-num">${s.num}</span>${esc(s.title)}</h2>
      <div class="inf-prose">${renderBlocks(s.blocks, INFO_CTX)}</div>
    </section>`).join("");
  return pageShell(route, `${heroHtml({ kicker, title, lead, meta })}
    <div class="inf-doc">
      ${toc}
      <div class="inf-doc-main">
        ${notice}
        ${intro.length ? `<div class="inf-prose inf-intro">${renderBlocks(intro, INFO_CTX)}</div>` : ""}
        ${body}
        ${footer.length ? `<div class="inf-prose inf-doc-foot">${renderBlocks(footer, INFO_CTX)}</div>` : ""}
      </div>
    </div>`);
}

/* ==========================================================================
   Behaviours
   ========================================================================== */
/** Scroll a section into view (below the fixed top bar — see scroll-margin-top in info-pages.css). `focus`: also move keyboard focus to its heading. */
const byId = (root, id) => (id ? root.querySelector(`#${CSS.escape(id)}`) : null);   // looked up inside the page itself: an id elsewhere in the document can never be picked by mistake

/**
 * Puts `el` at the top of the page, just below the fixed top bar (its scroll-margin-top), with no animation.
 * Worked out by hand on purpose: right after a page change the router's own "back to the top" may still be gliding (the page's CSS
 * makes scrolling smooth), and scrollIntoView() measured against that moving target lands a few dozen pixels off.
 */
function scrollInstantlyTo(el) {
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const y = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY - margin));
  window.scrollTo({ top: window.scrollY, left: 0, behavior: "instant" });                       // 1 · stop the glide where it is …
  requestAnimationFrame(() => { if (el.isConnected) window.scrollTo({ top: y, left: 0, behavior: "instant" }); });   // 2 · … and only then move (a glide that is still being cancelled would swallow part of the jump)
}

export function jumpTo(root, id, { focus = false, instant = false } = {}) {
  const el = byId(root, id);
  if (!el) return false;
  if (el.tagName === "DETAILS") el.open = true;
  if (instant) scrollInstantlyTo(el);
  else el.scrollIntoView({ block: "start", behavior: "auto" });   // "auto" follows the page's CSS (smooth, unless the visitor asked for less motion)
  if (focus) {
    const target = el.tagName === "DETAILS" ? el.querySelector("summary") : (el.querySelector(".inf-anchor") || el);
    if (!target.hasAttribute("tabindex") && target.tagName !== "SUMMARY") target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  return true;
}

/** "#/privacy?section=your-rights" on the privacy page itself → "your-rights"; a link to another page (or another kind of link) → "". */
const samePageSection = (root, href) => {
  const m = /^#\/([a-z]+)\?section=([a-z0-9-]+)$/.exec(String(href || ""));
  return m && m[1] === root.dataset.page ? m[2] : "";
};

/**
 * A link with data-jump="id" scrolls to that section instead of navigating (the href stays a real, shareable ?section= link).
 * So does any plain link to a ?section= of the page you are already on — the page is not drawn again for it.
 * A target that does not exist is never swallowed: the link then behaves like any other link.
 */
export function bindJumpLinks(root, { before } = {}) {
  root.addEventListener("click", (e) => {
    const a = e.target.closest?.("[data-jump], a[href^='#/']");
    if (!a || !root.contains(a) || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const id = a.dataset.jump || samePageSection(root, a.getAttribute("href"));
    if (!id || !byId(root, id)) return;
    e.preventDefault();
    before?.(a);                                     // e.g. fold a phone's contents list FIRST: the page above the target must have its final height before the scroll is worked out
    jumpTo(root, id, { focus: true });
  });
}

/** …#/privacy?section=data-security: after the router has finished (it scrolls to the top once the page is drawn), go to the section. */
export function scheduleDeepLink(root, id) {
  if (!id) return;
  const t = setTimeout(() => { if (root.isConnected) jumpTo(root, id, { instant: true }); }, 60);
  onPageLeave(() => clearTimeout(t));
}

/** Marks the contents link of the section currently under the top bar (aria-current="location"). */
export function bindScrollSpy(root) {
  const links = [...root.querySelectorAll("[data-toc-link]")];
  const secs = links.map((l) => byId(root, l.dataset.jump)).filter(Boolean);
  if (!links.length || secs.length !== links.length) return;
  let queued = false;
  const offset = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-h")) || 56) + 32;
  const update = () => {
    queued = false;
    let current = secs[0];
    for (const s of secs) { if (s.getBoundingClientRect().top - offset() <= 0) current = s; else break; }
    links.forEach((l) => { if (l.dataset.jump === current.id) l.setAttribute("aria-current", "location"); else l.removeAttribute("aria-current"); });
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onPageLeave(() => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); });
  update();
}

/** The contents list is a closed accordion on phones and a plain, always-open side list from 960px up (same trick as the footer). */
export function bindContentsToggle(root) {
  const box = root.querySelector(".inf-toc-box");
  if (!box) return () => {};
  const mq = window.matchMedia("(min-width: 960px)");
  const sync = () => { box.open = mq.matches; };
  sync();
  mq.addEventListener?.("change", sync);
  onPageLeave(() => mq.removeEventListener?.("change", sync));
  return () => { if (!mq.matches) box.open = false; };       // after a jump on a phone: fold the list away again
}

/** Everything a legal document needs once it is drawn: contents links, the "you are here" marker, the phone accordion, the ?section= deep link. */
export function bindLegalPage(root, params) {
  const fold = bindContentsToggle(root);                  // a jump on a phone folds the contents list away again (before it scrolls)
  bindJumpLinks(root, { before: fold });
  bindScrollSpy(root);
  scheduleDeepLink(root, sectionParam(params?.get?.("section")));
}

/** Copies text to the clipboard (with the old execCommand as a fallback). Resolves true / false. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch { return false; }
}

/** <button data-copy="text"> + a <span data-copy-status role="status"> next to it. */
export function bindCopyButtons(root) {
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-copy]");
    if (!btn || !root.contains(btn)) return;
    const status = root.querySelector(btn.dataset.copyStatus || "[data-copy-status]");
    const ok = await copyText(btn.dataset.copy);
    if (!root.isConnected) return;
    if (status) {
      status.textContent = ok ? "Address copied." : "Could not copy — please select the address and copy it by hand.";
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { status.textContent = ""; }, 4000);
    }
  });
}

/** A photo that fails to load quietly becomes the initials again (error events do not bubble — hence the capture). */
export function bindImageFallbacks(root) {
  root.addEventListener("error", (e) => {
    const img = e.target;
    if (img?.tagName !== "IMG" || !img.dataset.fb) return;
    img.replaceWith(document.createTextNode(img.dataset.fb));
  }, true);
}
