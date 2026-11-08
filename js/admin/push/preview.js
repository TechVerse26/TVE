// ==========================================================================
// admin/push/preview.js — what a notification will look like. Pure HTML; used by the composer (live) and by the history (read-only).
// Everything that comes from the admin is escaped. Pictures are plain <img> tags: a link that does not load is reported by
// the page that shows this markup (see the "error" listener in view-send.js) — nothing is fetched by this file.
// ==========================================================================
import { esc } from "../core/ui.js";

export const SITE_ICON = "assets/pwa/icon-192.png";
export const BADGE = "assets/push/badge-72.png";

/**
 * n: { title, body, icon, image, category } — icon / image are url strings (or empty).
 * mode: "phone" | "desktop"
 */
export function previewHtml(n, mode = "phone") {
  const title = String(n.title || "").trim(), body = String(n.body || "").trim();
  const icon = n.icon || SITE_ICON;
  const pic = n.image || "";
  return `<div class="pn-pv ${mode === "desktop" ? "desktop" : "phone"}" data-cat="${esc(n.category || "announcement")}">
    <div class="pn-pv-top"><span class="pn-pv-badge"><img src="${BADGE}" alt=""></span><span class="pn-pv-site">Tech Verse Exam · ${esc(location.host)}</span><span class="pn-pv-time">now</span></div>
    <div class="pn-pv-row">
      <div class="pn-pv-text"><b class="${title ? "" : "ph"}">${esc(title || "Your title appears here")}</b><span class="${body ? "" : "ph"}">${esc(body || "The message appears here.")}</span></div>
      <img class="pn-pv-icon" src="${esc(icon)}" alt="" referrerpolicy="no-referrer">
    </div>
    ${pic ? `<div class="pn-pv-pic"><img src="${esc(pic)}" alt="" referrerpolicy="no-referrer"><span class="pn-pv-broken">This picture could not be loaded — check the link.</span></div>` : ""}
  </div>`;
}
