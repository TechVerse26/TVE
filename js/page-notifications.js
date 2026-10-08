// ==========================================================================
// page-notifications.js — the full notification centre (#/notifications).
// Same derived feed as the bell (notify.js): notices, new / starting-soon / live exams, schedule updates,
// results and reminders. Read marks are kept on the device (no Firestore writes).
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadNotificationFeed, loadReadMap, markRead, markAllRead, unreadCount } from "./notify.js";
import { reminderCount, browserPermission, maybeAskBrowserPermission } from "./reminders.js";
import { onPageLeave } from "./page-lifecycle.js";
import { serverNow } from "./server-time.js";
import { toBnDigits } from "./schedule-core.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, fmtDate, fmtTime, pageHead } from "./home-ui.js";

let renderToken = 0;
const GROUPS = [
  ["all", "All", () => true],
  ["notice", "Notices", (i) => i.kind === "notice"],
  ["exam", "Exams", (i) => i.kind.startsWith("exam") || i.kind === "schedule"],
  ["result", "Results", (i) => i.kind === "result"],
  ["reminder", "Reminders", (i) => i.kind === "reminder"],
];

function ago(ms) {
  const diff = Math.max(0, (serverNow() - ms) / 1000);
  if (diff < 60) return "এইমাত্র";
  if (diff < 3600) return `${toBnDigits(Math.floor(diff / 60))} মিনিট আগে`;
  if (diff < 86400) return `${toBnDigits(Math.floor(diff / 3600))} ঘণ্টা আগে`;
  return `${toBnDigits(Math.floor(diff / 86400))} দিন আগে`;
}

function rowHtml(it, read) {
  const href = it.href || "";
  const tag = href ? "a" : "div";
  return `<${tag} class="nf nf--${esc(it.tone)}${read ? " is-read" : ""}" ${href ? `href="${esc(href)}"` : ""} data-nid="${esc(it.id)}">
    <span class="nf-ico" aria-hidden="true"><i class="fa-solid ${esc(it.icon || "fa-bell")}"></i></span>
    <span class="nf-body">
      <b class="nf-title">${esc(it.title)}${it.priorityLabel && it.tone !== "normal" ? ` <span class="badge badge-${it.tone === "urgent" ? "coral" : "amber"}">${esc(it.priorityLabel)}</span>` : ""}</b>
      ${it.text ? `<span class="nf-text">${esc(it.text)}</span>` : ""}
      <time class="nf-time" title="${esc(`${fmtDate(it.at)} · ${fmtTime(it.at)}`)}">${esc(ago(it.at))}</time>
    </span>
    ${read ? "" : '<i class="bell-unread" aria-label="unread"></i>'}
  </${tag}>`;
}

export async function initNotificationsPage(params, mount) {
  const my = ++renderToken;
  await renderNav("notifications");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  let items = [];
  let profile = null;
  let group = "all";

  mount.innerHTML = `<div class="container page">
    ${pageHead("Notifications", "নতুন পরীক্ষা, সময়সূচি পরিবর্তন, ঘোষণা ও ফলাফল — এক জায়গায়।", '<button type="button" class="btn btn-outline btn-sm" id="nf-markall"><i class="fa-solid fa-check-double" aria-hidden="true"></i> Mark all read</button>')}
    <div id="nf-tools"></div>
    <div id="nf-body">${skeleton("row", 4)}</div>
  </div>`;
  const body = mount.querySelector("#nf-body");
  const tools = mount.querySelector("#nf-tools");
  const markAllBtn = mount.querySelector("#nf-markall");

  function toolsHtml() {
    const read = loadReadMap(user.uid);
    const perm = browserPermission();
    const alertsNote = perm === "unsupported" || perm === "granted" ? ""
      : perm === "denied" ? '<p class="nf-note"><i class="fa-solid fa-bell-slash" aria-hidden="true"></i> ব্রাউজার নোটিফিকেশন বন্ধ আছে — ব্রাউজারের সাইট সেটিংস থেকে চালু করতে পারেন।</p>'
      : `<p class="nf-note"><i class="fa-regular fa-bell" aria-hidden="true"></i> পরীক্ষা শুরুর আগে ব্রাউজার অ্যালার্ট পেতে চান? <button type="button" class="nt-btn" id="nf-allow">চালু করুন</button></p>`;
    return `<div class="seg-tabs" role="tablist" aria-label="Filter">
      ${GROUPS.map(([k, t, fn]) => { const n = items.filter(fn).filter((i) => !read[i.id]).length; return `<button type="button" role="tab" class="seg-tab${group === k ? " is-on" : ""}" aria-selected="${group === k}" data-g="${k}">${t}${n ? `<em>${n}</em>` : ""}</button>`; }).join("")}
    </div>${alertsNote}${reminderCount(user.uid) ? `<p class="nf-note"><i class="fa-solid fa-bell" aria-hidden="true"></i> আপনার ${toBnDigits(reminderCount(user.uid))}টি রিমাইন্ডার সেট করা আছে।</p>` : ""}`;
  }

  function paint() {
    const read = loadReadMap(user.uid);
    markAllBtn.disabled = unreadCount(items, read) === 0;
    tools.innerHTML = toolsHtml();
    const fn = GROUPS.find(([k]) => k === group)[2];
    const list = items.filter(fn);
    body.innerHTML = list.length
      ? `<div class="nf-list">${list.map((it) => rowHtml(it, !!read[it.id])).join("")}</div>`
      : emptyBlock("fa-bell-slash", "এখনো কোনো নোটিফিকেশন নেই।");
  }

  async function load(force) {
    try {
      const { getUserProfile } = await import("./utils.js");
      profile = await getUserProfile(user.uid);
      items = await loadNotificationFeed(user.uid, profile, { force });
      if (my !== renderToken) return;
      window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
      paint();
    } catch {
      body.innerHTML = errorBlock("notifications");
    }
  }
  await load(false);
  if (my !== renderToken) return;

  onRetry(mount, () => { body.innerHTML = skeleton("row", 4); load(true); });
  mount.addEventListener("click", async (e) => {
    const g = e.target.closest("[data-g]");
    if (g) { group = g.dataset.g; paint(); return; }
    if (e.target.closest("#nf-markall")) { markAllRead(user.uid, items); paint(); return; }
    if (e.target.closest("#nf-allow")) { await maybeAskBrowserPermission(); paint(); return; }
    const row = e.target.closest(".nf");
    if (row) { markRead(user.uid, row.dataset.nid); row.classList.add("is-read"); }
  });
  const onChange = () => { if (my === renderToken) paint(); };
  window.addEventListener("tvexam:notifications", onChange);
  onPageLeave(() => window.removeEventListener("tvexam:notifications", onChange));
}
