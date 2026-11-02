// ==========================================================================
// academic-ui.js — markup shared by the student pages and the admin preview.
// Pure string builders (+ one tiny DOM binder). No Firebase here.
//
// The cover picture is ALWAYS an <img src="https://…"> built from a validated URL (academic-core.safeImageUrl),
// never a CSS url('…') string and never untrusted HTML. A missing or broken picture falls back to a flat placeholder.
// ==========================================================================
import { safeImageUrl, displayName } from "./academic-core.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const KIND_ICON = Object.freeze({ section: "fa-graduation-cap", level: "fa-layer-group", subject: "fa-book-open" });
export const KIND_LABEL = Object.freeze({ section: "Academic section", level: "Level", subject: "Subject" });

/** "1 Level", "3 Levels" */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Free / Paid chip for a card. `locked` = paid and the student has no access yet. */
export function accessBadgeHtml(verdict) {
  if (!verdict) return "";
  if (verdict.mode === "paid") {
    const open = verdict.allowed && !verdict.locked;
    return `<span class="ac-badge ac-badge--paid${open ? " is-open" : ""}"><i class="fa-solid ${open ? "fa-lock-open" : "fa-lock"}" aria-hidden="true"></i>${open ? "Paid · Unlocked" : "Paid"}</span>`;
  }
  return `<span class="ac-badge ac-badge--free"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>Free</span>`;
}

/** The cover block: placeholder icon underneath, picture on top when the URL is valid, title on a solid scrim. */
export function coverHtml(node, { titleTag = "h3" } = {}) {
  const url = safeImageUrl(node?.coverImage);
  const icon = KIND_ICON[node?.kind] || KIND_ICON.section;
  return `
    <div class="ac-cover${url ? "" : " is-empty"}">
      <span class="ac-cover-ph" aria-hidden="true"><i class="fa-solid ${icon}"></i></span>
      ${url ? `<img class="ac-cover-img" src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}
      <${titleTag} class="ac-cover-title">${esc(displayName(node))}</${titleTag}>
    </div>`;
}

/**
 * One navigation card (section → level → subject).
 *   opts.href      where it leads
 *   opts.verdict   accessVerdict() of the node (Free / Paid badge + lock)
 *   opts.meta      [{ icon, text }] small facts under the description (level count, exam count …)
 *   opts.tag       "a" (default, student) or "div" (admin preview — not clickable)
 */
export function cardHtml(node, { href = "#", verdict = null, meta = [], tag = "a" } = {}) {
  const attrs = tag === "a" ? ` href="${esc(href)}"` : "";
  const locked = verdict && verdict.locked;
  return `
    <${tag} class="ac-card${locked ? " is-locked" : ""}" data-kind="${esc(node.kind)}" data-id="${esc(node.id)}"${attrs}>
      ${coverHtml(node)}
      <span class="ac-badges">${accessBadgeHtml(verdict)}</span>
      <div class="ac-body">
        ${node.description ? `<p class="ac-desc">${esc(node.description)}</p>` : ""}
        <div class="ac-meta">
          ${meta.filter(Boolean).map((m) => `<span><i class="fa-solid ${esc(m.icon)}" aria-hidden="true"></i>${esc(m.text)}</span>`).join("")}
          <span class="ac-go" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
        </div>
      </div>
    </${tag}>`;
}

/**
 * Smooth load + broken-image handling for every .ac-cover-img inside `root` (one pair of capture listeners:
 * image load/error events do not bubble). Safe to call again after the markup is replaced.
 */
export function bindCoverFallbacks(root) {
  if (!root) return;
  if (!root._acCovers) {
    root._acCovers = true;
    root.addEventListener("load", (e) => { if (e.target?.classList?.contains("ac-cover-img")) e.target.closest(".ac-cover")?.classList.add("is-loaded"); }, true);
    root.addEventListener("error", (e) => { if (e.target?.classList?.contains("ac-cover-img")) e.target.closest(".ac-cover")?.classList.add("is-broken"); }, true);
  }
  // an image that finished (or failed) before the listeners saw it
  root.querySelectorAll?.(".ac-cover-img").forEach((img) => {
    if (!img.complete) return;
    img.closest(".ac-cover")?.classList.add(img.naturalWidth ? "is-loaded" : "is-broken");
  });
}
