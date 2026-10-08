// ==========================================================================
// nav.js — the whole navigation system, rebuilt on every page (renderNav keeps working exactly as before):
//
//   desktop   logo  |  Home · Exams · Schedule · My Activity  |  🔔 · Admin · Profile
//   phone     top bar: logo | 🔔 · ☰        bottom bar: Home · Exams · Schedule · Activity · Profile
//   drawer    (☰) secondary only: Leaderboard · My Performance · Notifications · Admin Panel · Profile · Sign Out
//
// ONE list of primary pages feeds both the desktop links and the bottom bar, and ONE `lit` value decides which
// of them is active — so desktop, phone and drawer can never disagree about "where am I".
// ==========================================================================
import { waitForAuth, getUserProfile, escapeHtml } from "./utils.js";
import { logout } from "./auth.js";
import { mountBell } from "./nav-bell.js";

let navBound = false;

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

// Primary destinations (desktop centre links + phone bottom bar). `auth` = signed-in students only.
const PRIMARY = [
  { key: "home", href: "#/home", label: "Home", short: "Home", icon: "fa-house" },
  { key: "exams", href: "#/exams", label: "Exams", short: "Exams", icon: "fa-file-pen", auth: true },
  { key: "schedule", href: "#/schedule", label: "Schedule", short: "Schedule", icon: "fa-calendar-days", auth: true },
  { key: "results", href: "#/results", label: "My Activity", short: "Activity", icon: "fa-chart-simple", auth: true },
];
// Secondary destinations: they only live in the drawer (and as quick actions on the home page).
const SECONDARY = [
  { key: "leaderboard", href: "#/leaderboard", label: "Leaderboard", icon: "fa-trophy" },
  { key: "performance", href: "#/performance", label: "My Performance", icon: "fa-chart-line" },
  { key: "notifications", href: "#/notifications", label: "Notifications", icon: "fa-bell" },
];
// Pages that are not a tab themselves light up the tab they belong to.
const BELONGS_TO = { exam: "exams", performance: "results", leaderboard: "results" };

export async function renderNav(activePage = "") {
  const root = document.getElementById("topnav-root");
  if (!root) return;

  const user = await waitForAuth();
  const profile = user ? await getUserProfile(user.uid) : null;
  const displayName = profile?.displayName || user?.displayName || "";
  const email = user?.email || "";
  const label = displayName || "প্রোফাইল";
  const letter = escapeHtml(initials(displayName || email));
  const isAdmin = !!profile?.isAdmin;

  const lit = BELONGS_TO[activePage] || activePage;                       // which primary tab is lit
  const cur = (on) => (on ? ' aria-current="page"' : "");
  const primary = PRIMARY.filter((l) => !l.auth || user);

  // The drawer may have been open when a profile edit re-rendered the bar: never leave the page scroll-locked.
  if (document.getElementById("nav-drawer")?.classList.contains("open")) document.body.style.overflow = "";

  root.innerHTML = `
    <nav class="topnav" aria-label="Main">
      <div class="container topnav-inner">
        <a href="#/home" class="brand" aria-label="Tech Verse Exam — Home">
          <img src="assets/logo.svg" alt="TVexam" class="brand-logo" width="151" height="34">
        </a>

        <div class="nav-links" id="nav-links">
          ${primary.map((l) => `<a href="${l.href}" class="nav-link"${cur(lit === l.key)}>${l.label}</a>`).join("")}
        </div>

        <div class="nav-tools">
          ${user ? `
          <div class="nav-bell-wrap">
            <button type="button" class="nav-icon-btn nav-bell${activePage === "notifications" ? " is-active" : ""}" id="nav-bell" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false">
              <i class="fa-regular fa-bell" aria-hidden="true"></i>
              <span class="nav-bell-badge hidden" id="nav-bell-badge">0</span>
            </button>
            <div class="bell-panel hidden" id="bell-panel" role="dialog" aria-label="Notifications"></div>
          </div>
          ${isAdmin ? `<a href="admin.html" class="btn btn-outline btn-sm nav-admin" aria-label="Admin panel" title="Admin panel"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><span class="nav-admin-label">Admin</span></a>` : ""}
          <a href="#/profile" class="nav-user-chip" aria-label="Profile: ${escapeHtml(label)}"${cur(lit === "profile")}>
            <span class="user-avatar" aria-hidden="true">${letter}</span>
            <span class="nav-user-name">${escapeHtml(label)}</span>
          </a>` : `<a href="#/login" class="btn btn-primary btn-sm nav-login">Login</a>`}

          <button type="button" class="nav-icon-btn nav-menu-btn" id="nav-hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="nav-drawer">
            <i class="fa-solid fa-bars" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </nav>

    <div class="nav-drawer-backdrop" id="nav-drawer-backdrop"></div>

    <aside class="nav-drawer" id="nav-drawer" role="dialog" aria-modal="true" aria-label="Menu" aria-hidden="true">
      <div class="nav-drawer-head">
        ${user ? `
        <div class="nav-drawer-user">
          <span class="user-avatar" aria-hidden="true">${letter}</span>
          <div class="nav-drawer-user-info">
            <p class="nav-drawer-user-name">${escapeHtml(label)}</p>
            <p class="nav-drawer-user-email">${escapeHtml(email)}</p>
          </div>
        </div>` : `
        <a href="#/home" class="brand"><img src="assets/logo.svg" alt="TVexam" class="brand-logo" width="151" height="34"></a>`}
        <button type="button" class="btn btn-ghost btn-icon btn-sm" id="nav-drawer-close" aria-label="Close menu"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>

      <nav class="nav-drawer-nav" aria-label="More">
        ${user ? `
        <p class="nav-drawer-label">Explore</p>
        ${SECONDARY.map((l) => drawerItem(l.href, l.icon, l.label, activePage === l.key)).join("")}
        ${isAdmin ? `<p class="nav-drawer-label">Admin</p>${drawerItem("admin.html", "fa-shield-halved", "Admin Panel", false)}` : ""}
        <p class="nav-drawer-label">Account</p>
        ${drawerItem("#/profile", "fa-user", "Profile", activePage === "profile")}` : `
        ${drawerItem("#/home", "fa-house", "Home", lit === "home")}
        ${drawerItem("#/login", "fa-right-to-bracket", "Login", false)}
        ${drawerItem("#/signup", "fa-user-plus", "Sign up", false)}`}
      </nav>

      ${user ? `
      <div class="nav-drawer-footer">
        <button type="button" class="btn btn-danger btn-block" id="nav-drawer-signout"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign Out</button>
      </div>` : ""}
    </aside>

    ${user ? `
    <nav class="bottom-nav" id="bottom-nav" aria-label="Quick navigation">
      ${[...primary, { key: "profile", href: "#/profile", short: "Profile", icon: "fa-user" }].map((l) =>
        `<a href="${l.href}" class="bn-item"${cur(lit === l.key)}><span class="bn-icon"><i class="fa-solid ${l.icon}" aria-hidden="true"></i></span><span>${l.short}</span></a>`).join("")}
    </nav>` : ""}`;

  document.body.classList.toggle("has-bottom-nav", !!user);
  if (user) mountBell({ uid: user.uid, profile });

  if (!navBound) {
    navBound = true;
    bindGlobalNav();
  }
}

function drawerItem(href, icon, text, active) {
  return `<a href="${href}" class="nav-drawer-item"${active ? ' aria-current="page"' : ""}>
    <span class="nav-drawer-item-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
    <span>${text}</span>
    <i class="fa-solid fa-chevron-right nav-drawer-item-arrow" aria-hidden="true"></i>
  </a>`;
}

/* ---------- drawer behaviour: bound once for the whole app lifetime (event delegation) ---------- */
const $ = (id) => document.getElementById(id);
const drawerIsOpen = () => !!$("nav-drawer")?.classList.contains("open");

function openDrawer() {
  $("nav-drawer")?.classList.add("open");
  $("nav-drawer-backdrop")?.classList.add("open");
  $("nav-drawer")?.setAttribute("aria-hidden", "false");
  $("nav-hamburger")?.setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
  $("nav-drawer-close")?.focus();
}

function closeDrawer({ restoreFocus = true } = {}) {
  if (!drawerIsOpen()) return;
  $("nav-drawer")?.classList.remove("open");
  $("nav-drawer-backdrop")?.classList.remove("open");
  $("nav-drawer")?.setAttribute("aria-hidden", "true");
  $("nav-hamburger")?.setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
  if (restoreFocus) $("nav-hamburger")?.focus();
}

function bindGlobalNav() {
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#nav-hamburger")) { drawerIsOpen() ? closeDrawer() : openDrawer(); return; }
    if (t.closest("#nav-drawer-close") || t.closest("#nav-drawer-backdrop")) { closeDrawer(); return; }
    if (t.closest("#nav-drawer-signout")) { closeDrawer({ restoreFocus: false }); logout(); return; }
    if (t.closest("#nav-drawer a")) closeDrawer({ restoreFocus: false });
  });

  document.addEventListener("keydown", (e) => {
    if (!drawerIsOpen()) return;
    if (e.key === "Escape") { closeDrawer(); return; }
    if (e.key !== "Tab") return;                       // keep keyboard focus inside the open drawer
    const items = [...$("nav-drawer").querySelectorAll("a[href], button:not([disabled])")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  window.addEventListener("hashchange", () => closeDrawer({ restoreFocus: false }));
  // rotating a tablet / resizing to desktop must never leave an invisible, scroll-locking drawer behind
  window.matchMedia("(min-width: 901px)").addEventListener?.("change", (e) => { if (e.matches) closeDrawer({ restoreFocus: false }); });
}
