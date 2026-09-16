// ==========================================================================
// utils.js — shared helpers (toast, modal, auth guards, formatting)
// ==========================================================================
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ---------- Toast ---------- */
export function toast(message, type = "info") {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ---------- User profile (users/{uid}) ---------- */
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* ---------- Auth state / guards ---------- */
export function waitForAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

const POST_LOGIN_REDIRECT_KEY = "tvexam_post_login_redirect";
export function setPostLoginRedirect(hash) {
  if (!hash || /^#\/?(login|signup)?$/.test(hash)) return;
  try { sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, hash); } catch {}
}
export function consumePostLoginRedirect() {
  try {
    const target = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    return target || null;
  } catch { return null; }
}

export async function requireAuth() {
  const user = await waitForAuth();
  if (!user) {
    setPostLoginRedirect(window.location.hash);
    window.location.hash = "#/login";
    return null;
  }
  return user;
}

export async function requireAdmin() {
  const user = await requireAuth();
  if (!user) return null;
  const profile = await getUserProfile(user.uid);
  if (!profile || !profile.isAdmin) {
    toast("এই পেজ দেখার অনুমতি আপনার নেই", "error");
    window.location.href = "index.html#/home";
    return null;
  }
  return { user, profile };
}

export async function logout() {
  await signOut(auth);
  window.location.href = "index.html#/login";
}

/* ---------- Course pricing (free vs paid) ---------- */
function normalizePrice(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export function getCoursePricing(course = {}) {
  const price = normalizePrice(course.price ?? course.discountPrice ?? 0);
  return { isPaid: price > 0 || course.isPaid === true, price };
}

/* ---------- Modal ---------- */
export function openModal(innerHtml) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "active-modal-overlay";
  overlay.innerHTML = `<div class="modal-box card">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelectorAll("[data-modal-close]").forEach((el) => el.addEventListener("click", () => closeModal()));
  return overlay;
}
export function closeModal() {
  const existing = document.getElementById("active-modal-overlay");
  if (existing) { existing.remove(); document.body.style.overflow = ""; }
}

export function confirmAction(message, { title = "নিশ্চিত করুন", confirmLabel = "হ্যাঁ, নিশ্চিত", cancelLabel = "বাতিল" } = {}) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <div class="modal-head"><h3>${escapeHtml(title)}</h3></div>
      <p class="confirm-msg">${escapeHtml(message)}</p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline btn-block" id="cf-cancel">${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn btn-coral btn-block" id="cf-ok">${escapeHtml(confirmLabel)}</button>
      </div>`);
    let settled = false;
    function finish(v) { if (settled) return; settled = true; closeModal(); resolve(v); }
    overlay.querySelector("#cf-cancel").addEventListener("click", () => finish(false));
    overlay.querySelector("#cf-ok").addEventListener("click", () => finish(true));
  });
}

/* ---------- Text / formatting ---------- */
export function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m <= 0) return `${sec} sec`;
  return `${m} min ${sec} sec`;
}
export function formatScore(n) {
  const num = Number(n) || 0;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}
export function formatDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
}
export function formatDateTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h = d.getHours();
  const period = h < 12 ? "AM" : "PM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()} — ${h12}:${m} ${period}`;
}
export function timeAgo(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "এইমাত্র";
  if (diff < 3600) return `${Math.floor(diff / 60)} মিনিট আগে`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ঘণ্টা আগে`;
  return `${Math.floor(diff / 86400)} দিন আগে`;
}

/* ---------- Exam schedule / availability ----------
   Practice exams (exam.examType === "practice") ignore any schedule
   entirely and are always "open" — practice is meant to be available
   any time, so a publishAt/closesAt left over from before the type was
   switched (or copy-pasted from a live exam) is never honored. ---------- */
export function getExamAvailability(exam) {
  if (exam.examType === "practice") return { state: "open", publishAt: null, closesAt: null };
  const now = new Date();
  const publishAt = exam.publishAt?.toDate ? exam.publishAt.toDate() : exam.publishAt ? new Date(exam.publishAt) : null;
  const closesAt = exam.closesAt?.toDate ? exam.closesAt.toDate() : exam.closesAt ? new Date(exam.closesAt) : null;
  let state = "open";
  if (publishAt && now < publishAt) state = "upcoming";
  else if (closesAt && now > closesAt) state = "closed";
  return { state, publishAt, closesAt };
}
/* ---------- Which of the 3 student-facing buckets an exam belongs to ----------
   "practice" — exam.examType === "practice", always open.
   "upcoming" — a live exam scheduled in the future (not published yet).
   "live"     — every other live exam (currently open, or already closed —
                closed ones still belong here, just shown locked). ---------- */
export function getExamBucket(exam) {
  if (exam.examType === "practice") return "practice";
  const { state } = getExamAvailability(exam);
  return state === "upcoming" ? "upcoming" : "live";
}
export function getExamQuestionCount(exam = {}) {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  const pool = Number(exam.questionCount) || 0;
  return perAttempt > 0 && perAttempt < pool ? perAttempt : pool;
}
export function isExamRandomPool(exam = {}) {
  const perAttempt = Number(exam.questionsPerAttempt) || 0;
  return perAttempt > 0 && perAttempt < (Number(exam.questionCount) || 0);
}

/* ---------- CSV export (admin) ---------- */
export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((cell) => {
    const s = String(cell ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
