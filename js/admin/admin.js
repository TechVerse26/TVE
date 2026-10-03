// ==========================================================================
// admin/admin.js — Admin panel entry point: gate, sidebar, courses cache
// ==========================================================================
import { db } from "../firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { requireAdmin, logout } from "../utils.js";
import { getExamCatalog, fetchAllExamsAdmin, syncExamIndex } from "../exam-data.js";
import * as cache from "../cache.js";
import { loadOverview } from "./overview.js";
import { loadExamsTable } from "./exams.js";
import { loadResultsTable, bindResultsControls } from "./results.js";
import { loadLeaderboard, bindLeaderboardControls } from "./leaderboard.js";
import { loadStudentsTable, bindStudentsControls } from "./students.js";

export let me = null;
export let courses = [];

// The course list rarely changes: read it once per 10 minutes, not on every panel open.
export async function refreshCourses(opts) {
  courses = await cache.remember("admin:courses", 10 * 60 * 1000, async () => {
    const snap = await getDocs(collection(db, "courses"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, { force: cache.wantsFresh(opts) });
  return courses;
}

/* Each tab loads the FIRST time it is opened — not all five at once on every page load —
   and they all share the same cached collections (see exam-data.js), so opening more tabs
   costs nothing extra. The ⟳ buttons inside each tab force a real re-read. */
const sectionLoaders = {
  overview: () => loadOverview(),
  exams: () => loadExamsTable(),
  results: () => loadResultsTable(),
  leaderboard: () => loadLeaderboard(),
  students: () => loadStudentsTable(),
};
const loadedSections = new Set();
function ensureSectionLoaded(section) {
  if (loadedSections.has(section) || !sectionLoaders[section]) return;
  loadedSections.add(section);
  Promise.resolve(sectionLoaders[section]()).catch(() => loadedSections.delete(section));
}

/* If the students' one-document exam index does not exist yet (first run after the upgrade),
   build it from the real exams. Normally this is a single cheap read that finds it already there. */
async function ensureExamIndex() {
  try {
    const catalog = await getExamCatalog();
    if (catalog.source === "index") return;
    await syncExamIndex(await fetchAllExamsAdmin(), courses);
  } catch { /* students keep working on the slower path; ⚡ Optimize fixes it */ }
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
      ensureSectionLoaded(btn.dataset.section);
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
  ensureSectionLoaded("overview"); // the landing tab; the others load when opened
  ensureExamIndex();
}

init();
