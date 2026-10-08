// ==========================================================================
// home-ui.js — small, shared view helpers for the student pages (home, exams, schedule,
// notifications, leaderboard, performance). Strings in, strings out: no Firestore, no routing.
// ==========================================================================
import { escapeHtml as esc } from "./utils.js";

export { esc };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------- dates & times (always the viewer's local time) ---------- */
export function fmtTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export const fmtDay = (ms) => { const d = new Date(ms); return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
export function fmtDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}
export const fmtDateTime = (ms, now) => `${fmtDate(ms, now)} · ${fmtTime(ms)}`;

/** "10:00 AM – 12:00 PM", or with dates when the window spans days. */
export function fmtRange(startMs, endMs, now) {
  if (startMs === null && endMs === null) return "";
  if (startMs === null) return `Until ${fmtDateTime(endMs, now)}`;
  if (endMs === null) return `${fmtDay(startMs)} · ${fmtTime(startMs)}`;
  const sameDay = new Date(startMs).toDateString() === new Date(endMs).toDateString();
  return sameDay ? `${fmtDay(startMs)} · ${fmtTime(startMs)} – ${fmtTime(endMs)}` : `${fmtDateTime(startMs, now)} → ${fmtDateTime(endMs, now)}`;
}

/** "GMT+6", "GMT+5:30", "GMT−4" — shown next to schedules so nobody misreads a time. */
export function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? "+" : "−";
  const a = Math.abs(off);
  const h = Math.floor(a / 60), m = a % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "আজ · Mon, 5 Oct" / "আগামীকাল · Tue, 6 Oct" / "Sat, 10 Oct" */
export function dayHeading(group) {
  const base = fmtDay(group.dayStart);
  if (group.diff === 0) return `আজ · ${base}`;
  if (group.diff === 1) return `আগামীকাল · ${base}`;
  if (group.diff === -1) return `গতকাল · ${base}`;
  return base;
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? Array.from(parts[0]).slice(0, 2) : [Array.from(parts[0])[0], Array.from(parts[parts.length - 1])[0]]).join("").toUpperCase();
}

/* ---------- small building blocks ---------- */
/** The ONE status badge: LIVE · SOON · UPCOMING · OPEN · DONE · CLOSED (+ UNAVAILABLE). Full wording stays in the tooltip. */
const BADGE_TEXT = { live: "LIVE", soon: "SOON", upcoming: "UPCOMING", open: "OPEN", completed: "DONE", closed: "CLOSED", unavailable: "UNAVAILABLE" };
export function statusBadge(status) {
  const dot = status.key === "live" ? '<span class="badge-dot" aria-hidden="true"></span>' : "";
  return `<span class="badge badge-${status.tone}" title="${esc(status.label)} · ${esc(status.bn)}">${dot}${esc(BADGE_TEXT[status.key] || String(status.label).toUpperCase())}</span>`;
}

/** Standard page header: title + one-line description (+ optional action html on the right). */
export function pageHead(title, desc = "", actionsHtml = "") {
  return `<header class="page-head">
    <div class="page-head-text"><h1 class="page-title">${esc(title)}</h1>${desc ? `<p class="page-desc">${esc(desc)}</p>` : ""}</div>
    ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ""}
  </header>`;
}

export function sectionHead(id, title, { sub = "", href = "", action = "", icon = "" } = {}) {
  return `<div class="section-head">
    <div class="section-head-text">
      <h2 class="section-title" id="${id}">${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i>` : ""}${esc(title)}</h2>
      ${sub ? `<p class="section-sub">${esc(sub)}</p>` : ""}
    </div>
    ${href ? `<a class="section-link" href="${esc(href)}">${esc(action)} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>` : ""}
  </div>`;
}

export const emptyBlock = (icon, text, extra = "") =>
  `<div class="ui-state"><i class="fa-regular ${icon}" aria-hidden="true"></i><p>${esc(text)}</p>${extra}</div>`;

export const errorBlock = (retryKey = "all", text = "তথ্য লোড করা যায়নি। আবার চেষ্টা করুন।") =>
  `<div class="ui-state ui-state--error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><p>${esc(text)}</p>
    <button type="button" class="btn btn-outline btn-sm" data-retry="${esc(retryKey)}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> আবার চেষ্টা করুন</button></div>`;

/** Skeleton placeholder shown while a section loads (no layout jump when the real content arrives). */
export const skeleton = (kind = "card", n = 1) =>
  Array.from({ length: n }, () => `<div class="ui-skeleton ui-skeleton--${kind}" aria-hidden="true"></div>`).join("");

/** `<a>` or disabled `<button>` for a CTA descriptor from exam-card.ctaFor(). */
export function ctaHtml(cta, { cls = "btn btn-sm", block = false } = {}) {
  const tone = cta.primary ? "btn-primary" : "btn-outline";
  const icon = cta.icon ? `<i class="fa-solid ${cta.icon}" aria-hidden="true"></i> ` : "";
  const klass = `${cls} ${tone}${block ? " btn-block" : ""}`;
  if (cta.disabled) return `<button type="button" class="${klass}" disabled>${icon}${esc(cta.label)}</button>`;
  return `<a class="${klass}" href="${esc(cta.href)}">${icon}${esc(cta.label)}</a>`;
}

/** Run `fn` when the user taps anything inside `root` that carries [data-retry]. */
export function onRetry(root, fn) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-retry]");
    if (b && root.contains(b)) fn(b.dataset.retry);
  });
}
