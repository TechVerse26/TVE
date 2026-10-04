// ==========================================================================
// admin/admin.js — Admin panel entry point.
//   gate → role → settings → permission-aware sidebar → hash router that loads each page module
//   the FIRST time it is opened (so the panel starts fast and costs no reads for pages you never visit).
// Page modules live next to this file and export mount(root) [+ optional activate()].
// ==========================================================================
import { db } from "../firebase-config.js";
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { requireAdmin, logout, toast } from "../utils.js";
import { getExamCatalog, fetchAllExamsAdmin, syncExamIndex } from "../exam-data.js";
import * as cache from "../cache.js";
import { setRole, normalizeRole, can, ROLES } from "./core/permissions.js";
import { setActor } from "./core/audit.js";
import { loadSettings, getSettings, settingsMeta } from "./core/settings.js";
import { esc, errorState, skeleton } from "./core/ui.js";

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

/* id, label, icon, perm needed to see it (null = every admin), page module. */
const NAV = [
  { group: "Overview", items: [
    { id: "dashboard", label: "Dashboard", icon: "fa-gauge-high", perm: null, mod: "./dashboard.js" },
  ] },
  { group: "Exam system", items: [
    { id: "exams", label: "Exams", icon: "fa-file-pen", perm: "exams.view", mod: "./exams.js" },
    { id: "questions", label: "Question Bank", icon: "fa-circle-question", perm: "questions.view", mod: "./questions.js" },
    { id: "taxonomy", label: "Subjects & Categories", icon: "fa-folder-tree", perm: "taxonomy.view", mod: "./taxonomy-page.js" },
  ] },
  { group: "People", items: [
    { id: "students", label: "Students", icon: "fa-users", perm: "students.view", mod: "./students.js" },
    { id: "results", label: "Results", icon: "fa-square-poll-vertical", perm: "results.view", mod: "./results.js" },
    { id: "leaderboard", label: "Leaderboard", icon: "fa-ranking-star", perm: "results.view", mod: "./leaderboard.js", adapter: "leaderboard" },
  ] },
  { group: "Insights", items: [
    { id: "analytics", label: "Analytics", icon: "fa-chart-line", perm: "analytics.view", mod: "./analytics.js" },
    { id: "logs", label: "Activity Logs", icon: "fa-clock-rotate-left", perm: "logs.view", mod: "./logs.js" },
  ] },
  { group: "Communication", items: [
    { id: "notifications", label: "Notifications", icon: "fa-bell", perm: "notifications.manage", mod: "./notifications.js" },
  ] },
  { group: "System", items: [
    { id: "settings", label: "Settings", icon: "fa-gear", perm: "settings.manage", mod: "./settings-page.js" },
    { id: "admins", label: "Admin Management", icon: "fa-user-shield", perm: "admins.manage", mod: "./admins.js" },
  ] },
];
const allowed = () => NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(i.perm)) })).filter((g) => g.items.length);
const flat = () => allowed().flatMap((g) => g.items);

const mounted = new Map(); // id → module
const mounting = new Map(); // id → promise
let activeId = null;

export function go(id) { window.location.hash = `#/${id}`; }

function ensureSection(id) {
  let el = document.getElementById(`section-${id}`);
  if (!el) {
    el = document.createElement("section");
    el.className = "admin-section";
    el.id = `section-${id}`;
    document.getElementById("admin-main").appendChild(el);
  }
  return el;
}

async function mountPage(item) {
  if (mounted.has(item.id)) return mounted.get(item.id);
  if (mounting.has(item.id)) return mounting.get(item.id);
  const root = ensureSection(item.id);
  const p = (async () => {
    if (!item.adapter) root.innerHTML = skeleton(5);
    try {
      const mod = await import(item.mod);
      if (item.adapter === "leaderboard") { mod.bindLeaderboardControls(); mod.loadLeaderboard(); } else await mod.mount(root);
      mounted.set(item.id, mod);
      return mod;
    } catch (err) {
      console.error(`Could not open "${item.id}":`, err);
      root.innerHTML = errorState({ title: "এই পেজটি খোলা যায়নি", text: String(err?.message || err) });
      root.querySelector("[data-retry]")?.addEventListener("click", () => { mounting.delete(item.id); route(); });
      return null;
    } finally { mounting.delete(item.id); }
  })();
  mounting.set(item.id, p);
  return p;
}

async function route() {
  const items = flat();
  const wanted = (window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0]) || "dashboard";
  let item = items.find((i) => i.id === wanted);
  if (!item) {
    if (wanted !== "dashboard") toast("এই পেজ দেখার অনুমতি আপনার নেই", "error");
    item = items.find((i) => i.id === "dashboard") || items[0];
    if (window.location.hash !== `#/${item.id}`) { history.replaceState(null, "", `#/${item.id}`); }
  }
  const wasActive = activeId;
  activeId = item.id;
  document.querySelectorAll(".admin-nav-item").forEach((b) => {
    const on = b.dataset.section === item.id;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  document.querySelectorAll(".admin-section").forEach((s) => s.classList.toggle("active", s.id === `section-${item.id}`));
  ensureSection(item.id).classList.add("active");
  document.title = `${item.label} · ${getSettings().general.orgName}`;
  closeSidebar();
  window.scrollTo(0, 0);
  const revisit = mounted.has(item.id);
  const mod = await mountPage(item);
  if (mod && revisit && wasActive !== item.id) mod.activate?.();
}

/* ---------- Sidebar ---------- */
function buildNav() {
  document.getElementById("admin-nav").innerHTML = allowed().map((g) =>
    `<div class="nav-label">${esc(g.group)}</div>${g.items.map((i) =>
      `<button type="button" class="admin-nav-item" data-section="${i.id}"><span><i class="fa-solid ${i.icon}"></i></span>${esc(i.label)}</button>`).join("")}`).join("");
}
function closeSidebar() {
  document.getElementById("admin-sidebar")?.classList.remove("open");
  document.getElementById("admin-sidebar-backdrop")?.classList.remove("open");
}
function bindSidebar() {
  const sidebar = document.getElementById("admin-sidebar");
  const backdrop = document.getElementById("admin-sidebar-backdrop");
  document.getElementById("admin-drawer-toggle")?.addEventListener("click", () => { sidebar.classList.toggle("open"); backdrop.classList.toggle("open"); });
  backdrop?.addEventListener("click", closeSidebar);
  document.getElementById("admin-drawer-close")?.addEventListener("click", closeSidebar);
  document.getElementById("admin-nav").addEventListener("click", (e) => {
    const b = e.target.closest(".admin-nav-item");
    if (!b) return;
    if (window.location.hash === `#/${b.dataset.section}`) route(); else go(b.dataset.section);
  });
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });
}

/* ---------- Session safety: sign out after a period of inactivity ---------- */
function startIdleGuard() {
  const mins = Number(getSettings().security.idleMinutes) || 0;
  if (mins <= 0) return;
  let last = Date.now(), warned = false;
  const touch = () => { last = Date.now(); warned = false; };
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) => window.addEventListener(ev, touch, { passive: true }));
  setInterval(() => {
    const idle = Date.now() - last;
    if (idle >= mins * 60000) { toast("নিষ্ক্রিয়তার কারণে সাইন আউট করা হচ্ছে", "info"); logout(); }
    else if (!warned && mins > 2 && idle >= (mins - 1) * 60000) { warned = true; toast("১ মিনিট পর নিরাপত্তার জন্য সাইন আউট হবে — চালিয়ে যেতে কিছু একটা করুন", "info"); }
  }, 15000);
}

/* If the students' one-document exam index does not exist yet (first run after the upgrade), build it. */
async function ensureExamIndex() {
  try {
    const catalog = await getExamCatalog();
    if (catalog.source === "index") return;
    await syncExamIndex(await fetchAllExamsAdmin(), courses);
  } catch { /* students keep working on the slower path; ⚡ Optimize fixes it */ }
}

async function loadMyRole(uid) {
  try {
    const snap = await getDoc(doc(db, "adminRoles", uid));
    return snap.exists() ? normalizeRole(snap.data().role) : "super"; // no role document = the original, full-access admin
  } catch { return "super"; }
}

function renderHeader(profile, user, role) {
  const name = profile?.displayName || user.email || "Admin";
  document.getElementById("admin-user-avatar").textContent = name.trim().charAt(0).toUpperCase();
  document.getElementById("admin-user-name").textContent = name;
  const chipEl = document.getElementById("admin-role-chip");
  chipEl.textContent = ROLES[role].label;
  chipEl.className = `chip ${ROLES[role].tone}`;
  document.getElementById("admin-logout-btn").addEventListener("click", () => logout());
}

async function init() {
  // Keep the page hash out of the auth gate: a logged-out visit to admin.html#/exams must not become the post-login redirect.
  const startHash = window.location.hash;
  if (startHash) history.replaceState(null, "", window.location.pathname + window.location.search);
  me = await requireAdmin();
  if (!me) return;
  if (startHash) history.replaceState(null, "", window.location.pathname + window.location.search + startHash);
  const role = await loadMyRole(me.user.uid);
  setRole(role);
  me.role = role;
  setActor({ uid: me.user.uid, name: me.profile?.displayName || "", email: me.user.email || "", role });

  document.getElementById("admin-gate").classList.add("hidden");
  document.getElementById("admin-shell").classList.remove("hidden");
  renderHeader(me.profile, me.user, role);

  await Promise.all([loadSettings(), refreshCourses().catch(() => [])]);
  if (settingsMeta().source === "blocked") toast("Settings rules প্রকাশিত নয় — ডিফল্ট সেটিংস ব্যবহার হচ্ছে (README দেখুন)", "info");

  buildNav();
  bindSidebar();
  startIdleGuard();
  route();
  ensureExamIndex();
}

init();
