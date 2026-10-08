// ==========================================================================
// nav-bell.js — the notification bell in the top bar: unread badge + dropdown (bottom-sheet on phones).
// All data comes from notify.js, which derives the feed from what is already in memory — opening the
// bell costs no Firestore reads beyond what the pages loaded anyway.
// ==========================================================================
import { peekNotificationFeed, loadNotificationFeed, loadReadMap, markRead, markAllRead, unreadCount } from "./notify.js";
import { esc } from "./home-ui.js";
import { serverNow } from "./server-time.js";

let ctx = null;      // { uid, profile }
let bound = false;
let items = [];      // what the panel currently shows

const $ = (id) => document.getElementById(id);

function ago(ms) {
  const diff = Math.max(0, (serverNow() - ms) / 1000);
  const bn = (n) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);
  if (diff < 60) return "এইমাত্র";
  if (diff < 3600) return `${bn(Math.floor(diff / 60))} মিনিট আগে`;
  if (diff < 86400) return `${bn(Math.floor(diff / 3600))} ঘণ্টা আগে`;
  return `${bn(Math.floor(diff / 86400))} দিন আগে`;
}

export function paintBadge() {
  const badge = $("nav-bell-badge");
  const btn = $("nav-bell");
  if (!badge || !btn || !ctx) return;
  const feed = peekNotificationFeed(ctx.uid, ctx.profile);
  const n = feed ? unreadCount(feed, loadReadMap(ctx.uid)) : 0;
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.classList.toggle("hidden", n === 0);
  btn.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
}

export function itemHtml(it, read) {
  const href = it.href || "#/notifications";
  return `<a class="bell-item bell-item--${esc(it.tone)}${read ? " is-read" : ""}" href="${esc(href)}" data-nid="${esc(it.id)}">
    <span class="bell-ico" aria-hidden="true"><i class="fa-solid ${esc(it.icon || "fa-bell")}"></i></span>
    <span class="bell-body"><b>${esc(it.title)}</b>${it.text ? `<span>${esc(String(it.text).slice(0, 110))}</span>` : ""}<time>${esc(ago(it.at))}</time></span>
    ${read ? "" : '<i class="bell-unread" aria-label="unread"></i>'}
  </a>`;
}

function renderPanel() {
  const panel = $("bell-panel");
  if (!panel || !ctx) return;
  const read = loadReadMap(ctx.uid);
  const unread = unreadCount(items, read);
  panel.innerHTML = `
    <div class="bell-head">
      <b>Notifications</b>
      ${unread ? `<span class="badge badge-accent">${unread} new</span>` : ""}
      <button type="button" class="bell-markall" id="bell-markall"${unread ? "" : " disabled"}>Mark all read</button>
    </div>
    <div class="bell-list">
      ${items.length ? items.slice(0, 8).map((it) => itemHtml(it, !!read[it.id])).join("") : '<p class="bell-empty"><i class="fa-regular fa-bell-slash" aria-hidden="true"></i>এখনো কোনো নোটিফিকেশন নেই।</p>'}
    </div>
    <a class="bell-foot" href="#/notifications">View all notifications <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>`;
}

function closePanel() {
  const panel = $("bell-panel");
  const btn = $("nav-bell");
  if (panel) panel.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

async function openPanel() {
  const panel = $("bell-panel");
  const btn = $("nav-bell");
  if (!panel || !btn || !ctx) return;
  panel.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  panel.innerHTML = '<div class="bell-head"><b>Notifications</b></div><div class="bell-list"><div class="ui-skeleton ui-skeleton--row" aria-hidden="true"></div><div class="ui-skeleton ui-skeleton--row" aria-hidden="true"></div></div>';
  try {
    items = await loadNotificationFeed(ctx.uid, ctx.profile);
    if (!panel.classList.contains("hidden")) renderPanel();
    paintBadge();
  } catch {
    panel.innerHTML = '<div class="bell-head"><b>Notifications</b></div><p class="bell-empty"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>তথ্য লোড করা যায়নি। আবার চেষ্টা করুন।</p>';
  }
}

/** Call after every nav render (the nav DOM is rebuilt on each page). Global listeners are attached once. */
export function mountBell(context) {
  ctx = context;
  paintBadge();
  if (bound) return;
  bound = true;
  window.addEventListener("tvexam:notifications", () => { paintBadge(); if (!$("bell-panel")?.classList.contains("hidden")) { items = peekNotificationFeed(ctx.uid, ctx.profile) || items; renderPanel(); } });
  window.addEventListener("tvexam:data-ready", paintBadge);
  window.addEventListener("hashchange", closePanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#nav-bell")) {
      $("bell-panel")?.classList.contains("hidden") ? openPanel() : closePanel();
      return;
    }
    if (t.closest("#bell-markall")) { markAllRead(ctx.uid, items); renderPanel(); paintBadge(); return; }
    const link = t.closest(".bell-item");
    if (link) { markRead(ctx.uid, link.dataset.nid); closePanel(); return; }
    if (t.closest(".bell-foot")) { closePanel(); return; }
    if (!t.closest("#bell-panel")) closePanel();
  });
}
