// ==========================================================================
// admin/students.js — student roster: enrollment, attempt count, and full
// roll-number management (enrollment edits themselves still happen on the
// main course site's admin panel — this is a viewing/searching/roll tool
// for the exam side, not a duplicate enrollment editor).
//
// Roll column: students can only ever *claim* a roll (serial, via the
// "সিঙ্ক করুন" button on their own profile) — they can never type one in.
// The admin panel is the one place a roll can be assigned on someone's
// behalf or corrected: "জেনারেট করুন" claims the next serial number for a
// student who hasn't synced yet, and the pencil icon lets an admin
// manually override a roll (e.g. to fix a duplicate/legacy value), with a
// uniqueness check before it's saved.
// ==========================================================================
import { db } from "../firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, toast, openModal, closeModal } from "../utils.js";
import { fetchAllUsersAdmin, fetchAllResultsAdmin } from "../exam-data.js";
import { claimNextRoll, isRollTaken } from "../roll.js";
import { courses } from "./admin.js";

let allUsers = [];
let attemptsByUid = {};

function courseTitle(courseId) {
  return courses.find((c) => c.id === courseId)?.title || courseId;
}

function sortUsers(list, sortMode) {
  const arr = [...list];
  if (sortMode === "name-asc") {
    arr.sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "bn"));
  } else {
    // Unsynced students (no roll) always sink to the bottom, regardless of direction.
    arr.sort((a, b) => {
      if (!a.roll && !b.roll) return 0;
      if (!a.roll) return 1;
      if (!b.roll) return -1;
      return sortMode === "roll-desc" ? b.roll.localeCompare(a.roll) : a.roll.localeCompare(b.roll);
    });
  }
  return arr;
}

function renderTable() {
  const tbody = document.querySelector("#students-table tbody");
  if (!tbody) return;
  const search = (document.getElementById("stu-search")?.value || "").trim().toLowerCase();
  const sortMode = document.getElementById("stu-sort")?.value || "roll-asc";
  const filtered = sortUsers(
    allUsers.filter((u) => {
      if (!search) return true;
      return `${u.displayName || ""} ${u.email || ""} ${u.roll || ""}`.toLowerCase().includes(search);
    }),
    sortMode,
  );

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="icon"><i class="fa-solid fa-users"></i></div><p>কোনো শিক্ষার্থী পাওয়া যায়নি</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((u) => {
    const courseChips = (u.enrolledCourses || []).length
      ? (u.enrolledCourses || []).map((cid) => `<span class="badge badge-teal">${escapeHtml(courseTitle(cid))}</span>`).join(" ")
      : `<span class="exs-muted exs-small">কোনো কোর্সে এনরোল নেই</span>`;
    const rollCell = u.roll
      ? `<span class="roll-chip">
           <span class="roll-chip-num">${escapeHtml(u.roll)}</span>
           <button type="button" class="roll-edit-btn" data-uid="${u.id}" title="রোল পরিবর্তন করুন"><i class="fa-solid fa-pen"></i></button>
         </span>`
      : `<button type="button" class="roll-gen-btn" data-uid="${u.id}"><i class="fa-solid fa-arrows-rotate"></i> জেনারেট করুন</button>`;
    return `
    <tr>
      <td data-label="Student"><div class="cell-title"><div><div class="t">${escapeHtml(u.displayName || "নাম নেই")}</div><div class="muted" style="font-size:0.8em">${escapeHtml(u.email || "")}</div></div></div></td>
      <td data-label="Roll">${rollCell}</td>
      <td data-label="Enrolled Courses"><div class="settings-badges">${courseChips}</div></td>
      <td data-label="Attempts">${attemptsByUid[u.id] || 0}</td>
      <td data-label="Role">${u.isAdmin ? `<span class="badge badge-amber">Admin</span>` : `<span class="badge">Student</span>`}</td>
    </tr>`;
  }).join("");

  bindRollCellActions();
}

/* ---------- Roll generate (admin claims the next serial number for a student) ---------- */
async function handleGenerate(btn) {
  const uid = btn.dataset.uid;
  const user = allUsers.find((u) => u.id === uid);
  if (!user) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> জেনারেট হচ্ছে...';
  try {
    const newRoll = await claimNextRoll();
    await updateDoc(doc(db, "users", uid), { roll: newRoll });
    user.roll = newRoll;
    toast(`${user.displayName || "শিক্ষার্থী"} এর রোল সেট হয়েছে: ${newRoll}`, "success");
    renderTable();
  } catch {
    toast("রোল জেনারেট করা যায়নি, আবার চেষ্টা করুন", "error");
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> জেনারেট করুন';
  }
}

/* ---------- Roll manual edit (admin override, with a uniqueness guard) ---------- */
function openRollEditModal(uid) {
  const user = allUsers.find((u) => u.id === uid);
  if (!user) return;
  const overlay = openModal(`
    <div class="modal-head"><h3>রোল পরিবর্তন করুন</h3></div>
    <p class="confirm-msg">${escapeHtml(user.displayName || user.email || "এই শিক্ষার্থীর")} জন্য নতুন রোল নম্বর দিন। এটি অন্য কোনো শিক্ষার্থীর সাথে মিলবে না, এমন একটি স্বতন্ত্র নম্বর হতে হবে।</p>
    <div class="field">
      <label>রোল নম্বর</label>
      <input type="text" id="roll-edit-input" value="${escapeHtml(user.roll || "")}" placeholder="যেমন 0001">
    </div>
    <div class="confirm-actions">
      <button type="button" class="btn btn-outline btn-block" data-modal-close>বাতিল</button>
      <button type="button" class="btn btn-primary btn-block" id="roll-edit-save">সংরক্ষণ করুন</button>
    </div>`);

  overlay.querySelector("#roll-edit-save").addEventListener("click", async () => {
    const saveBtn = overlay.querySelector("#roll-edit-save");
    const newRoll = overlay.querySelector("#roll-edit-input").value.trim();
    if (!newRoll) { toast("রোল নম্বর লিখুন", "error"); return; }
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> সংরক্ষণ হচ্ছে...';
    try {
      if (newRoll !== user.roll && (await isRollTaken(newRoll, uid))) {
        toast("এই রোল নম্বরটি অন্য শিক্ষার্থীর সাথে যুক্ত আছে", "error");
        saveBtn.disabled = false;
        saveBtn.innerHTML = "সংরক্ষণ করুন";
        return;
      }
      await updateDoc(doc(db, "users", uid), { roll: newRoll });
      user.roll = newRoll;
      toast("রোল আপডেট হয়েছে", "success");
      closeModal();
      renderTable();
    } catch {
      toast("রোল সংরক্ষণ করা যায়নি, আবার চেষ্টা করুন", "error");
      saveBtn.disabled = false;
      saveBtn.innerHTML = "সংরক্ষণ করুন";
    }
  });
}

function bindRollCellActions() {
  document.querySelectorAll(".roll-gen-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGenerate(btn));
  });
  document.querySelectorAll(".roll-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openRollEditModal(btn.dataset.uid));
  });
}

export async function loadStudentsTable() {
  const tbody = document.querySelector("#students-table tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="5"><div class="loading-screen"><span class="spinner"></span></div></td></tr>`;
  try {
    const [users, results] = await Promise.all([fetchAllUsersAdmin(), fetchAllResultsAdmin()]);
    allUsers = users;
    attemptsByUid = {};
    results.forEach((r) => { attemptsByUid[r.uid] = (attemptsByUid[r.uid] || 0) + 1; });
    renderTable();
  } catch {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>লোড করা যায়নি</p></div></td></tr>`;
  }
}

export function bindStudentsControls() {
  document.getElementById("stu-search")?.addEventListener("input", renderTable);
  document.getElementById("stu-sort")?.addEventListener("change", renderTable);
  document.getElementById("stu-refresh-btn")?.addEventListener("click", loadStudentsTable);
}
