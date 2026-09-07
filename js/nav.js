// ==========================================================================
// nav.js — top navbar: logo, Home / My Results links, auth-aware right side
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

  root.innerHTML = `
    <nav class="topnav">
      <div class="container topnav-inner">
        <a href="#/home" class="brand"><i class="fa-solid fa-graduation-cap"></i> Tech Verse Exam</a>
        <button class="nav-hamburger" id="nav-hamburger" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
        <div class="nav-links" id="nav-links">
          <a href="#/home" class="nav-link ${activePage === "exam" ? "active" : ""}">এক্সাম</a>
          ${user ? `<a href="#/results" class="nav-link ${activePage === "results" ? "active" : ""}">আমার ফলাফল</a>` : ""}
          ${profile?.isAdmin ? `<a href="admin.html" class="nav-link">অ্যাডমিন প্যানেল</a>` : ""}
          ${user
            ? `<button type="button" class="nav-user-chip" id="nav-logout-btn"><span class="nav-avatar">${escapeHtml(initials(profile?.displayName || user.email))}</span> লগআউট</button>`
            : `<a href="#/login" class="btn btn-primary btn-sm">লগইন</a>`}
        </div>
      </div>
    </nav>`;

  root.querySelector("#nav-logout-btn")?.addEventListener("click", () => logout());

  if (!navBound) {
    navBound = true;
    document.addEventListener("click", (e) => {
      const hamburger = document.getElementById("nav-hamburger");
      const links = document.getElementById("nav-links");
      if (!hamburger || !links) return;
      if (hamburger.contains(e.target)) { links.classList.toggle("open"); return; }
      if (!links.contains(e.target)) links.classList.remove("open");
    });
  }
}
