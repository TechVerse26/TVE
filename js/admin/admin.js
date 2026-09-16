// ==========================================================================
// admin/admin.js — Admin panel entry point: gate, sidebar, courses cache
// ==========================================================================
import { db } from "../firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { requireAdmin, logout } from "../utils.js";
import { loadOverview } from "./overview.js";
import { loadExamsTable } from "./exams.js";
import { loadResultsTable, bindResultsControls } from "./results.js";
import { loadLeaderboard, bindLeaderboardControls } from "./leaderboard.js";
import { loadStudentsTable, bindStudentsControls } from "./students.js";

export let me = null;
export let courses = [];

export async function refreshCourses() {
  const snap = await getDocs(collection(db, "courses"));
  courses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return courses;
}

function bindSidebar() {
  const sidebar = document.getElementById("admin-sidebar");
  const backdrop = document.getElementById("admin-sidebar-backdrop");
  const drawerToggle = document.getElementById("admin-drawer-toggle");
  const drawerClose = document.getElementById("admin-drawer-close");

  const closeDrawer = () => { sidebar?.classList.remove("open"); backdrop?.classList.remove("open"); };
  drawerToggle?.addEventListener("click", () => { sidebar?.classList.toggle("open"); backdrop?.classList.toggle("open"); });
  backdrop?.addEventListener("click", closeDrawer);
  drawerClose?.addEventListener("click", closeDrawer);

  document.querySelectorAll(".admin-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".admin-nav-item").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".admin-section").forEach((s) => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`section-${btn.dataset.section}`).classList.add("active");
      closeDrawer();
    });
  });
}

function renderAdminHeader(profile, user) {
  const name = profile?.displayName || user.email || "Admin";
  const initial = name.trim().charAt(0).toUpperCase();
  document.getElementById("admin-user-avatar").textContent = initial;
  document.getElementById("admin-user-name").textContent = name;
  document.getElementById("admin-logout-btn").addEventListener("click", () => logout());
}

async function init() {
  me = await requireAdmin();
  if (!me) return;
  renderAdminHeader(me.profile, me.user);
  document.getElementById("admin-gate").classList.add("hidden");
  document.getElementById("admin-shell").classList.remove("hidden");

  bindSidebar();
  bindResultsControls();
  bindLeaderboardControls();
  bindStudentsControls();

  await refreshCourses();
  loadOverview();
  loadExamsTable();
  loadResultsTable();
  loadLeaderboard();
  loadStudentsTable();
}

init();
