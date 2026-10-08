// ==========================================================================
// page-profile.js — student profile, built from the SAME design system as every other page
// (page header · card · badge · stat tile · field · btn). Nothing here has its own mini design language.
//
//   page header
//   identity card ........ avatar · name · Admin/Verified badges · email · roll · phone · organisation · Edit
//   stat grid ............ Enrolled Courses · Live exams attempted · Average score · Best score
//   Personal information . Name · Email(read-only) · Phone · Roll(read-only + Sync) · Organisation
//   Password ............. password users: 3 fields · Google users: a compact info card
//   Sign out ............. compact danger card
//
// Data + behaviour are unchanged: same users/{uid} doc, same updateUserProfile / changePassword / logout,
// same atomic roll claim (roll.js), same renderNav("profile") refresh after every change.
// Roll number: read-only, exactly like email. A student can only *claim* one via "Sync", which hands out
// the next serial number from the shared atomic counter — it is never a free-text field.
// ==========================================================================
import { requireAuth, getUserProfile, escapeHtml, toast } from "./utils.js";
import { fetchProfileStats } from "./exam-data.js";
import { updateUserProfile, changePassword, logout } from "./auth.js";
import { renderNav } from "./nav.js";
import { claimNextRoll } from "./roll.js";
import { pageHead } from "./home-ui.js";

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function setBtnLoading(btn, loadingLabel, idleHtml) {
  btn.disabled = true;
  btn.dataset.idleHtml = idleHtml;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${loadingLabel}`;
}
function resetBtn(btn) {
  btn.disabled = false;
  btn.innerHTML = btn.dataset.idleHtml;
}

/** A labelled field in the global `.field` style. `readonly` fields get the dashed + lock treatment. */
function fieldMarkup({ id, label, type = "text", value = "", placeholder = "", required = false, readonly = false, extra = "", hint = "", wide = false }) {
  const input = `<input type="${type}" id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""} ${readonly ? "disabled" : ""} ${extra}>`;
  return `
    <div class="field${readonly ? " field--readonly" : ""}${wide ? " pfl-wide" : ""}">
      <label for="${id}">${label}</label>
      ${readonly ? `<div class="field-lock">${input}<i class="fa-solid fa-lock" aria-hidden="true"></i></div>` : input}
      ${hint ? `<span class="form-hint">${hint}</span>` : ""}
    </div>`;
}

/** Roll number inside the form: value + (Sync button | copy button) side by side. */
function rollFieldMarkup(roll) {
  return `
    <div class="field field--readonly" id="pf-roll-field">
      <label for="pf-roll">Roll Number</label>
      <div class="input-group">
        <div class="field-lock"><input type="text" id="pf-roll" value="${escapeHtml(roll)}" placeholder="Not synced yet" disabled><i class="fa-solid fa-lock" aria-hidden="true"></i></div>
        <div class="pfl-roll-actions" id="pf-roll-actions">${rollActionsMarkup(roll)}</div>
      </div>
      <span class="form-hint" id="pf-roll-hint">${rollHint(roll)}</span>
    </div>`;
}
const rollHint = (roll) => (roll ? "Assigned once — it cannot be edited." : "Tap Sync to receive your roll number.");
const rollActionsMarkup = (roll) =>
  roll
    ? `<button type="button" class="btn btn-secondary btn-icon" id="pf-roll-copy" aria-label="Copy roll number" title="Copy"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>`
    : `<button type="button" class="btn btn-secondary" id="pf-roll-sync"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Sync</button>`;

/** Roll as shown in the identity card (read-only: value + status). */
const rollDetailMarkup = (roll, { animate = false } = {}) =>
  roll
    ? `<span data-field="roll"${animate ? ' class="pfl-roll-pop"' : ""}>${escapeHtml(roll)}</span> <span class="badge badge-pass" id="pf-roll-status"><i class="fa-solid fa-check" aria-hidden="true"></i> Synced</span>`
    : `<span data-field="roll" class="pfl-muted">Not synced</span>`;

export async function initProfilePage(params, container) {
  await renderNav("profile");
  const user = await requireAuth();
  if (!user) return;

  const profile = (await getUserProfile(user.uid)) || {};
  const isPasswordUser = user.providerData.some((p) => p.providerId === "password");
  const name = profile.displayName || user.displayName || "";
  const roll = profile.roll || "";
  const institution = profile.institution || "";
  const isVerified = !!user.emailVerified;
  const enrolledCount = (profile.enrolledCourses || []).length;

  const stat = (icon, key, value, label) => `
    <div class="stat-tile stat-tile--icon">
      <span class="stat-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
      <span class="stat-text"><b class="stat-value" data-stat="${key}">${value}</b><span class="stat-label">${label}</span></span>
    </div>`;

  container.innerHTML = `
    <div class="container page profile-page">
      ${pageHead("Profile", "আপনার অ্যাকাউন্ট, রোল নম্বর ও পাসওয়ার্ড এখান থেকে পরিচালনা করুন।")}

      <!-- ===== Identity ===== -->
      <section class="card card--highlight pfl-id" aria-label="Profile summary">
        <div class="pfl-id-top">
          <span class="user-avatar pfl-avatar" aria-hidden="true">${escapeHtml(initials(name || user.email))}</span>
          <div class="pfl-id-main">
            <h2 class="pfl-name" data-field="name">${escapeHtml(name || "No Name")}</h2>
            <div class="pfl-badges">
              ${profile.isAdmin ? '<span class="badge badge-teal"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Admin</span>' : ""}
              ${isVerified ? '<span class="badge badge-pass"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Verified</span>' : ""}
            </div>
            <p class="pfl-email"><i class="fa-regular fa-envelope" aria-hidden="true"></i><span class="pfl-ellipsis">${escapeHtml(user.email || "")}</span></p>
          </div>
          <button type="button" class="btn btn-secondary pfl-edit" id="pf-edit-jump"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit Profile</button>
        </div>
        <dl class="pfl-details">
          <div class="pfl-detail"><dt><i class="fa-solid fa-id-card" aria-hidden="true"></i> Roll number</dt><dd id="pf-roll-row">${rollDetailMarkup(roll)}</dd></div>
          <div class="pfl-detail"><dt><i class="fa-solid fa-phone" aria-hidden="true"></i> Phone</dt><dd><span data-field="phone"${profile.phone ? "" : ' class="pfl-muted"'}>${escapeHtml(profile.phone || "Not added")}</span></dd></div>
          <div class="pfl-detail"><dt><i class="fa-solid fa-graduation-cap" aria-hidden="true"></i> Organisation</dt><dd><span data-field="institution"${institution ? "" : ' class="pfl-muted"'}>${escapeHtml(institution || "Not added")}</span></dd></div>
        </dl>
      </section>

      <!-- ===== Stats ===== -->
      <div class="stat-grid stat-grid--4" id="profile-stats">
        ${stat("fa-book-open", "courses", enrolledCount, "Enrolled Courses")}
        ${stat("fa-satellite-dish", "live", 0, "Attempt Live Exam")}
        ${stat("fa-chart-line", "avg", "0%", "Average Score")}
        ${stat("fa-trophy", "best", "0%", "Best Score")}
      </div>

      <!-- ===== Account settings ===== -->
      <div class="pfl-grid" id="pf-edit-section">
        <section class="card" aria-labelledby="h-pf-info">
          <div class="card-head">
            <span class="card-icon"><i class="fa-solid fa-user-pen" aria-hidden="true"></i></span>
            <div><h2 class="card-title" id="h-pf-info">Personal information</h2><p class="card-sub">নাম, ফোন ও প্রতিষ্ঠান আপডেট করুন</p></div>
          </div>
          <form id="profile-form">
            <div class="pfl-fields">
              ${fieldMarkup({ id: "pf-name", label: "Name", value: name, required: true, extra: 'autocomplete="name"' })}
              ${fieldMarkup({ id: "pf-email", label: "Email", type: "email", value: user.email || "", readonly: true, hint: "Email cannot be changed." })}
              ${fieldMarkup({ id: "pf-phone", label: "Phone Number", type: "tel", value: profile.phone || "", placeholder: "01XXXXXXXXX", extra: 'autocomplete="tel"' })}
              ${rollFieldMarkup(roll)}
              ${fieldMarkup({ id: "pf-institution", label: "Organisation", value: institution, placeholder: "Tech Verse Exam Platform", wide: true })}
            </div>
            <div class="pfl-actions"><button type="submit" class="btn btn-primary" id="pf-save"><i class="fa-solid fa-check" aria-hidden="true"></i> Save changes</button></div>
          </form>
        </section>

        ${isPasswordUser ? `
        <section class="card" aria-labelledby="h-pf-pw">
          <div class="card-head">
            <span class="card-icon card-icon--amber"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>
            <div><h2 class="card-title" id="h-pf-pw">Password</h2><p class="card-sub">কমপক্ষে ৬ অক্ষরের নতুন পাসওয়ার্ড দিন</p></div>
          </div>
          <form id="password-form">
            ${fieldMarkup({ id: "pw-current", label: "Current Password", type: "password", required: true, extra: 'autocomplete="current-password"' })}
            ${fieldMarkup({ id: "pw-new", label: "New Password", type: "password", required: true, extra: 'minlength="6" autocomplete="new-password"' })}
            ${fieldMarkup({ id: "pw-confirm", label: "Confirm Password", type: "password", required: true, extra: 'minlength="6" autocomplete="new-password"' })}
            <div class="pfl-actions"><button type="submit" class="btn btn-primary" id="pw-save"><i class="fa-solid fa-key" aria-hidden="true"></i> Update password</button></div>
          </form>
        </section>` : `
        <section class="card pfl-google" aria-labelledby="h-pf-pw">
          <div class="card-head">
            <span class="card-icon"><i class="fa-brands fa-google" aria-hidden="true"></i></span>
            <div><h2 class="card-title" id="h-pf-pw">Signed in with Google</h2>
              <p class="card-sub">Your password is managed by Google. <a class="pfl-link" href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">Open Google account settings</a></p></div>
          </div>
        </section>`}
      </div>

      <!-- ===== Sign out (account action — quiet, compact) ===== -->
      <section class="card card--danger pfl-signout" aria-label="Sign out">
        <div>
          <h2 class="card-title">Sign out</h2>
          <p class="card-sub">Sign out of this device. You will need your email and password (or Google) to sign in again.</p>
        </div>
        <button type="button" class="btn btn-danger" id="pf-logout"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i> Sign Out</button>
      </section>
    </div>`;

  /* ---------- Stats (best-effort — never blocks the rest of the page) ---------- */
  // One small summary document (userStats/{uid}) instead of downloading every result
  // document just to count and average them. Falls back to the old scan automatically.
  fetchProfileStats(user.uid)
    .then(({ total, liveCount, avg, best }) => {
      const liveNum = container.querySelector('[data-stat="live"]');
      if (liveNum) liveNum.textContent = liveCount; // live exams only — practice attempts have their own place
      if (!total) return;
      container.querySelector('[data-stat="avg"]').textContent = `${avg}%`;
      container.querySelector('[data-stat="best"]').textContent = `${best}%`;
    })
    .catch(() => {});

  /* ---------- Roll: rebuild the synced / unsynced pieces (identity card + form field) and rebind ---------- */
  function renderRollRow(rollValue, { animate = false } = {}) {
    const detail = container.querySelector("#pf-roll-row");
    if (detail) detail.innerHTML = rollDetailMarkup(rollValue, { animate });
    const actions = container.querySelector("#pf-roll-actions");
    if (actions) actions.innerHTML = rollActionsMarkup(rollValue);
    const hint = container.querySelector("#pf-roll-hint");
    if (hint) hint.textContent = rollHint(rollValue);
    const rollInput = container.querySelector("#pf-roll");
    if (rollInput) rollInput.value = rollValue;
    bindRollCopy();
    bindRollSync();
  }

  function bindRollCopy() {
    const copyBtn = container.querySelector("#pf-roll-copy");
    if (!copyBtn) return;
    copyBtn.addEventListener("click", async () => {
      const val = container.querySelector('[data-field="roll"]')?.textContent?.trim();
      if (!val) return;
      try {
        await navigator.clipboard.writeText(val);
        toast("Roll Number has been copied", "success");
      } catch {
        toast("Roll number could not be copied", "error");
      }
    });
  }

  function bindRollSync() {
    const rollSyncBtn = container.querySelector("#pf-roll-sync");
    if (!rollSyncBtn) return;
    rollSyncBtn.addEventListener("click", async () => {
      rollSyncBtn.disabled = true;
      rollSyncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Syncing…';
      try {
        const newRoll = await claimNextRoll();
        const currentPhone = container.querySelector("#pf-phone")?.value?.trim() || profile.phone || "";
        const currentInstitution = container.querySelector("#pf-institution")?.value?.trim() || institution || "";
        const currentName = container.querySelector("#pf-name")?.value?.trim() || name;
        await updateUserProfile(user, { displayName: currentName, phone: currentPhone, roll: newRoll, institution: currentInstitution });
        renderRollRow(newRoll, { animate: true });
        await renderNav("profile");
        toast(`Roll synced ${newRoll}`, "success");
      } catch (err) {
        console.error("Roll sync error:", err);
        toast("Could not sync roll number. Please try again later!", "error");
        rollSyncBtn.disabled = false;
        rollSyncBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Sync';
      }
    });
  }
  bindRollCopy();
  bindRollSync();

  /* ---------- Edit name/phone/institution (roll is never sent — read-only) ---------- */
  container.querySelector("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#pf-save");
    const newName = container.querySelector("#pf-name").value.trim();
    const phone = container.querySelector("#pf-phone").value.trim();
    const newInstitution = container.querySelector("#pf-institution").value.trim();
    if (!newName) { toast("Name is required", "error"); return; }
    setBtnLoading(btn, "Saving…", btn.innerHTML);
    try {
      await updateUserProfile(user, { displayName: newName, phone, institution: newInstitution });
      toast("Profile has been updated", "success");
      renderNav("profile");
      // Reflect the change in the identity card immediately — no full re-render
      const phoneField = container.querySelector('[data-field="phone"]');
      const instField = container.querySelector('[data-field="institution"]');
      const nameField = container.querySelector('[data-field="name"]');
      const avatar = container.querySelector(".pfl-avatar");
      if (phoneField) { phoneField.textContent = phone || "Not added"; phoneField.classList.toggle("pfl-muted", !phone); }
      if (instField) { instField.textContent = newInstitution || "Not added"; instField.classList.toggle("pfl-muted", !newInstitution); }
      if (nameField) nameField.textContent = newName;
      if (avatar) avatar.textContent = initials(newName);
    } catch {
      toast("Profile could not be updated", "error");
    }
    resetBtn(btn);
  });

  /* ---------- Change password ---------- */
  const pwForm = container.querySelector("#password-form");
  if (pwForm) {
    pwForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = container.querySelector("#pw-save");
      const current = container.querySelector("#pw-current").value;
      const next = container.querySelector("#pw-new").value;
      const confirm = container.querySelector("#pw-confirm").value;
      if (next.length < 6) { toast("New password must be at least 6 characters", "error"); return; }
      if (next !== confirm) { toast("Confirm password", "error"); return; }
      setBtnLoading(btn, "Updating…", btn.innerHTML);
      const ok = await changePassword(user, current, next);
      if (ok) { toast("Your Password has been updated", "success"); pwForm.reset(); }
      resetBtn(btn);
    });
  }

  /* ---------- Edit button: jump to + focus the info form ---------- */
  container.querySelector("#pf-edit-jump").addEventListener("click", () => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    container.querySelector("#pf-edit-section").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    setTimeout(() => container.querySelector("#pf-name")?.focus({ preventScroll: true }), reduce ? 0 : 350);
  });

  /* ---------- Logout ---------- */
  container.querySelector("#pf-logout").addEventListener("click", () => logout());
}
