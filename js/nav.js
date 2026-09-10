// ==========================================================================
// nav.js — top navbar + mobile drawer (slide-in from right)
// ==========================================================================
import { waitForAuth, getUserProfile, escapeHtml } from "./utils.js";
import { logout } from "./auth.js";

let navBound = false;

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

export async function renderNav(activePage = "") {
  const root = document.getElementById("topnav-root");
  if (!root) return;

  const user = await waitForAuth();
  const profile = user ? await getUserProfile(user.uid) : null;
  const displayName = profile?.displayName || user?.displayName || "";
  const email = user?.email || "";

  root.innerHTML = `
    <nav class="topnav">
      <div class="container topnav-inner">
        <a href="#/home" class="brand">
          <img src="assets/logo.png" alt="TVexam" class="brand-logo">
        </a>

        <!-- Desktop links -->
        <div class="nav-links" id="nav-links">
          <a href="#/home" class="nav-link ${activePage === "exam" ? "active" : ""}">Exam</a>
          ${user ? `<a href="#/results" class="nav-link ${activePage === "results" ? "active" : ""}">My Activity</a>` : ""}
          ${profile?.isAdmin ? `<a href="admin.html" class="nav-link">Admin</a>` : ""}
          ${user
            ? `<a href="#/profile" class="nav-user-chip ${activePage === "profile" ? "active" : ""}">
                <span class="nav-avatar">${escapeHtml(initials(displayName || email))}</span>
                <span class="nav-user-name">${escapeHtml(displayName || "Profile")}</span>
                <span class="nav-user-chip-arrow"><i class="fa-solid fa-chevron-right"></i></span>
               </a>`
            : `<a href="#/login" class="btn btn-primary btn-sm">Login</a>`}
        </div>

        <!-- Hamburger (mobile only) -->
        <button class="nav-hamburger" id="nav-hamburger" aria-label="Menu" aria-expanded="false">
          <span class="nav-hamburger-bar"></span>
          <span class="nav-hamburger-bar"></span>
          <span class="nav-hamburger-bar"></span>
        </button>
      </div>
    </nav>

    <!-- Mobile drawer backdrop -->
    <div class="nav-drawer-backdrop" id="nav-drawer-backdrop"></div>

    <!-- Mobile drawer -->
    <aside class="nav-drawer" id="nav-drawer" aria-hidden="true">

      <!-- Drawer header: user card -->
      <div class="nav-drawer-head">
        ${user ? `
          <div class="nav-drawer-user">
            <span class="nav-drawer-avatar">${escapeHtml(initials(displayName || email))}</span>
            <div class="nav-drawer-user-info">
              <p class="nav-drawer-user-name">${escapeHtml(displayName || "Profile")}</p>
              <p class="nav-drawer-user-email">${escapeHtml(email)}</p>
            </div>
          </div>
        ` : `
          <div class="nav-drawer-brand">
            <img src="assets/logo.png" alt="TVexam" class="brand-logo">
          </div>
        `}
        <button class="nav-drawer-close" id="nav-drawer-close" aria-label="Close menu">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <!-- Drawer nav links -->
      <nav class="nav-drawer-nav">
        <a href="#/home" class="nav-drawer-item ${activePage === "exam" ? "active" : ""}">
          <span class="nav-drawer-item-icon"><i class="fa-solid fa-file-pen"></i></span>
          <span>Exam</span>
        </a>
        ${user ? `
        <a href="#/results" class="nav-drawer-item ${activePage === "results" ? "active" : ""}">
          <span class="nav-drawer-item-icon"><i class="fa-solid fa-chart-simple"></i></span>
          <span>My Result</span>
        </a>` : ""}
        ${profile?.isAdmin ? `
        <a href="admin.html" class="nav-drawer-item">
          <span class="nav-drawer-item-icon"><i class="fa-solid fa-shield-halved"></i></span>
          <span>Admin</span>
        </a>` : ""}
        ${user ? `
        <a href="#/profile" class="nav-drawer-profile-card ${activePage === "profile" ? "active" : ""}">
          <span class="nav-drawer-profile-card-avatar">${escapeHtml(initials(displayName || email))}</span>
          <span class="nav-drawer-profile-card-body">
            <span class="nav-drawer-profile-card-name">${escapeHtml(displayName || "Profile")}</span>
            <span class="nav-drawer-profile-card-sub">Profile Edit</span>
          </span>
          <span class="nav-drawer-profile-card-arrow"><i class="fa-solid fa-chevron-right"></i></span>
        </a>` : `
        <a href="#/login" class="nav-drawer-item nav-drawer-login">
          <span class="nav-drawer-item-icon"><i class="fa-solid fa-right-to-bracket"></i></span>
          <span>Login</span>
        </a>`}
      </nav>

      <!-- Drawer footer: sign out -->
      ${user ? `
      <div class="nav-drawer-footer">
        <button type="button" class="nav-drawer-signout" id="nav-drawer-signout">
          <i class="fa-solid fa-right-from-bracket"></i>
          <span>Sign Out</span>
        </button>
      </div>` : ""}
    </aside>`;

  // --- Hamburger toggle ---
  if (!navBound) {
    navBound = true;

    document.addEventListener("click", (e) => {
      const hamburger = document.getElementById("nav-hamburger");
      const drawer = document.getElementById("nav-drawer");
      const backdrop = document.getElementById("nav-drawer-backdrop");

      if (!hamburger) return;

      if (hamburger.contains(e.target)) {
        const isOpen = drawer?.classList.contains("open");
        if (isOpen) {
          closeDrawer(drawer, backdrop, hamburger);
        } else {
          openDrawer(drawer, backdrop, hamburger);
        }
        return;
      }

      const closeBtn = document.getElementById("nav-drawer-close");
      if (closeBtn?.contains(e.target)) {
        closeDrawer(drawer, backdrop, hamburger);
        return;
      }

      if (backdrop?.contains(e.target)) {
        closeDrawer(drawer, backdrop, hamburger);
        return;
      }
    });
  }

  // Sign out from drawer
  document.getElementById("nav-drawer-signout")?.addEventListener("click", () => {
    const drawer = document.getElementById("nav-drawer");
    const backdrop = document.getElementById("nav-drawer-backdrop");
    const hamburger = document.getElementById("nav-hamburger");
    closeDrawer(drawer, backdrop, hamburger);
    logout();
  });

  // Close drawer on nav item or profile card click (mobile)
  document.querySelectorAll(".nav-drawer-item, .nav-drawer-profile-card").forEach((item) => {
    item.addEventListener("click", () => {
      const drawer = document.getElementById("nav-drawer");
      const backdrop = document.getElementById("nav-drawer-backdrop");
      const hamburger = document.getElementById("nav-hamburger");
      closeDrawer(drawer, backdrop, hamburger);
    });
  });
}

function openDrawer(drawer, backdrop, hamburger) {
  drawer?.classList.add("open");
  backdrop?.classList.add("open");
  hamburger?.classList.add("open");
  hamburger?.setAttribute("aria-expanded", "true");
  drawer?.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDrawer(drawer, backdrop, hamburger) {
  drawer?.classList.remove("open");
  backdrop?.classList.remove("open");
  hamburger?.classList.remove("open");
  hamburger?.setAttribute("aria-expanded", "false");
  drawer?.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}
