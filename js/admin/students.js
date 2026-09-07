// ==========================================================================
// admin/students.js — read-only student roster: enrollment + attempt count
// (enrollment edits happen on the main course site's admin panel — this is
// a viewing/searching tool for the exam side, not a duplicate editor)
// ==========================================================================
import { escapeHtml } from "../utils.js";
import { fetchAllUsersAdmin, fetchAllResultsAdmin } from "../exam-data.js";
import { courses } from "./admin.js";

let allUsers = [];
let attemptsByUid = {};

function courseTitle(courseId) {
  return courses.find((c) => c.id === courseId)?.title || courseId;
}

function renderTable() {
  const tbody = document.querySelector("#students-table tbody");
  if (!tbody) return;
  const search = (document.getElementById("stu-search")?.value || "").trim().toLowerCase();
  const filtered = allUsers.filter((u) => {
    if (!search) return true;
    return `${u.displayName || ""} ${u.email || ""}`.toLowerCase().includes(search);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="icon"><i class="fa-solid fa-users"></i></div><p>কোনো শিক্ষার্থী পাওয়া যায়নি</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((u) => {
    const courseChips = (u.enrolledCourses || []).length
      ? (u.enrolledCourses || []).map((cid) => `<span class="badge badge-teal">${escapeHtml(courseTitle(cid))}</span>`).join(" ")
      : `<span class="exs-muted exs-small">কোনো কোর্সে এনরোল নেই</span>`;
    return `
    <tr>
      <td data-label="Student"><div class="cell-title"><div><div class="t">${escapeHtml(u.displayName || "নাম নেই")}</div><div class="muted" style="font-size:0.8em">${escapeHtml(u.email || "")}</div></div></div></td>
      <td data-label="Enrolled Courses"><div class="settings-badges">${courseChips}</div></td>
      <td data-label="Attempts">${attemptsByUid[u.id] || 0}</td>
      <td data-label="Role">${u.isAdmin ? `<span class="badge badge-amber">Admin</span>` : `<span class="badge">Student</span>`}</td>
    </tr>`;
  }).join("");
}

export async function loadStudentsTable() {
  const tbody = document.querySelector("#students-table tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="4"><div class="loading-screen"><span class="spinner"></span></div></td></tr>`;
  try {
    const [users, results] = await Promise.all([fetchAllUsersAdmin(), fetchAllResultsAdmin()]);
    allUsers = users;
    attemptsByUid = {};
    results.forEach((r) => { attemptsByUid[r.uid] = (attemptsByUid[r.uid] || 0) + 1; });
    renderTable();
  } catch {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>লোড করা যায়নি</p></div></td></tr>`;
  }
}

export function bindStudentsControls() {
  document.getElementById("stu-search")?.addEventListener("input", renderTable);
  document.getElementById("stu-refresh-btn")?.addEventListener("click", loadStudentsTable);
}
