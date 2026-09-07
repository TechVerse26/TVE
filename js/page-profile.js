// ==========================================================================
// page-profile.js — student profile: compact banner (avatar, badges, roll,
// school, small atom watermark), a slim stat-chip strip, edit name/phone/
// school, change password. Same users/{uid} doc auth.js and nav.js
// already read. Every visual piece on this page (banner, stat chips, form
// cards, logout card) is hand-styled in profile.css — no generic/site-wide
// .card/.field/.btn classes are used here, so the whole section reads as
// one consistent, purpose-built, high-density design.
//
// Roll number: read-only, exactly like email. A student can only ever
// *claim* one via the "সিঙ্ক করুন" button, which hands out the next serial
// number (0001, 0002, ...) from the shared atomic counter in roll.js — it
// is never a free-text field the student can edit or overwrite.
// ==========================================================================
import { requireAuth, getUserProfile, escapeHtml, toast, formatDate } from "./utils.js";
import { fetchMyResults } from "./exam-data.js";
import { updateUserProfile, changePassword, logout } from "./auth.js";
import { renderNav } from "./nav.js";
import { claimNextRoll } from "./roll.js";

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function setBtnLoading(btn, loadingLabel, idleHtml) {
  btn.disabled = true;
  btn.dataset.idleHtml = idleHtml;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${loadingLabel}`;
}
function resetBtn(btn) {
  btn.disabled = false;
  btn.innerHTML = btn.dataset.idleHtml;
}

// ---------- Pure-CSS atom (nucleus + 3 orbiting electrons) ----------
function atomMarkup(size = "sm") {
  return `
    <div class="tve-atom tve-atom-${size}">
      <span class="tve-nucleus"></span>
      <div class="tve-orbit-tilt tve-tilt-1"><div class="tve-orbit"><span class="tve-electron tve-e1"></span></div></div>
      <div class="tve-orbit-tilt tve-tilt-2"><div class="tve-orbit"><span class="tve-electron tve-e2"></span></div></div>
      <div class="tve-orbit-tilt tve-tilt-3"><div class="tve-orbit"><span class="tve-electron tve-e3"></span></div></div>
    </div>`;
}

// ---------- Pure-CSS labeled input field ----------
function fieldMarkup({ id, label, icon, type = "text", value = "", placeholder = "", required = false, disabled = false, extra = "" }) {
  return `
    <div class="tve-field">
      <label for="${id}">${label}</label>
      <div class="tve-input-wrap${disabled ? " tve-input-disabled" : ""}">
        <i class="fa-solid ${icon}"></i>
        <input type="${type}" id="${id}" class="tve-input" value="${escapeHtml(value)}"
          placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""} ${disabled ? "disabled" : ""} ${extra}>
      </div>
    </div>`;
}

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

  container.innerHTML = `
    <div class="container page-pad profile-page">

      <!-- ===== Banner: avatar, name, badges, roll, phone, institution ===== -->
      <div class="tve-banner">
        ${atomMarkup("sm")}
        <div class="tve-banner-top">
          <span class="tve-avatar">${escapeHtml(initials(name || user.email))}</span>
          <div class="tve-banner-info">
            <h2 class="tve-banner-name">${escapeHtml(name || "নাম দেওয়া নেই")}${profile.isAdmin ? ' <span class="tve-pill tve-pill-teal">অ্যাডমিন</span>' : ""}</h2>
            <div class="tve-banner-meta">
              <span class="tve-banner-row"><i class="fa-solid fa-envelope"></i> <span class="tve-ellipsis">${escapeHtml(user.email || "")}</span>${isVerified ? '<i class="fa-solid fa-circle-check tve-verified-tick" title="Verified"></i>' : ""}</span>
              <span class="tve-banner-row tve-roll-row" id="pf-roll-row">
                <i class="fa-solid fa-id-card"></i>
                <span data-field="roll">${escapeHtml(roll || "রোল সিঙ্ক করা নেই")}</span>
                ${roll
                  ? '<span class="tve-sync-badge tve-sync-ok" id="pf-roll-status"><i class="fa-solid fa-check"></i> সিঙ্ক করা হয়েছে</span><button type="button" class="tve-copy-btn" id="pf-roll-copy" title="কপি করুন"><i class="fa-regular fa-copy"></i></button>'
                  : '<button type="button" class="tve-sync-btn" id="pf-roll-sync"><i class="fa-solid fa-arrows-rotate"></i> সিঙ্ক করুন</button>'}
              </span>
              <span class="tve-banner-row"><i class="fa-solid fa-phone"></i> <span data-field="phone">${escapeHtml(profile.phone || "ফোন নম্বর যোগ করা হয়নি")}</span></span>
            </div>
          </div>
        </div>
        <div class="tve-banner-bottom">
          <p class="tve-banner-school"><i class="fa-solid fa-graduation-cap"></i> <span data-field="institution">${escapeHtml(institution || "প্রতিষ্ঠানের নাম যোগ করা হয়নি")}</span></p>
          <button type="button" class="tve-edit-btn" id="pf-edit-jump"><i class="fa-solid fa-pen"></i> Edit</button>
        </div>
      </div>

      <!-- ===== Stats: compact chip strip ===== -->
      <div class="tve-stats-row" id="profile-stats">
        <div class="tve-stat-chip tve-stat-green">
          <span class="tve-stat-icon"><i class="fa-solid fa-book-open"></i></span>
          <span class="tve-stat-text"><span class="tve-stat-num" data-stat="courses">${enrolledCount}</span><span class="tve-stat-label">Enrolled Courses</span></span>
        </div>
        <div class="tve-stat-chip tve-stat-blue">
          <span class="tve-stat-icon"><i class="fa-solid fa-satellite-dish"></i></span>
          <span class="tve-stat-text"><span class="tve-stat-num" data-stat="live">0</span><span class="tve-stat-label">Live Exam অংশগ্রহণ</span></span>
        </div>
        <div class="tve-stat-chip tve-stat-amber">
          <span class="tve-stat-icon"><i class="fa-solid fa-chart-line"></i></span>
          <span class="tve-stat-text"><span class="tve-stat-num" data-stat="avg">0%</span><span class="tve-stat-label">গড় স্কোর</span></span>
        </div>
        <div class="tve-stat-chip tve-stat-purple">
          <span class="tve-stat-icon"><i class="fa-solid fa-trophy"></i></span>
          <span class="tve-stat-text"><span class="tve-stat-num" data-stat="best">0%</span><span class="tve-stat-label">সেরা স্কোর</span></span>
        </div>
      </div>

      <!-- ===== Editable info + password — same hand-built pure-CSS card language ===== -->
      <div class="tve-panels" id="pf-edit-section">
        <div class="tve-card">
          <div class="tve-card-head">
            <span class="tve-card-icon tve-card-icon-blue"><i class="fa-solid fa-id-card"></i></span>
            <h3>ব্যক্তিগত তথ্য</h3>
          </div>
          <form id="profile-form">
            ${fieldMarkup({ id: "pf-name", label: "নাম", icon: "fa-user", value: name, required: true })}
            ${fieldMarkup({ id: "pf-email", label: "ইমেইল", icon: "fa-envelope", type: "email", value: user.email || "", disabled: true })}
            ${fieldMarkup({ id: "pf-phone", label: "ফোন নম্বর", icon: "fa-phone", type: "tel", value: profile.phone || "", placeholder: "যেমন 01XXXXXXXXX" })}
            ${fieldMarkup({ id: "pf-roll", label: "রোল নম্বর (স্বয়ংক্রিয়, পরিবর্তনযোগ্য নয়)", icon: "fa-id-badge", value: roll, placeholder: "উপরে থেকে সিঙ্ক করুন", disabled: true })}
            ${fieldMarkup({ id: "pf-institution", label: "প্রতিষ্ঠানের নাম", icon: "fa-graduation-cap", value: institution, placeholder: "যেমন Scholars Model School and College" })}
            <button type="submit" class="tve-form-btn" id="pf-save"><i class="fa-solid fa-check"></i> পরিবর্তন সংরক্ষণ করুন</button>
          </form>
        </div>

        ${isPasswordUser ? `
        <div class="tve-card">
          <div class="tve-card-head">
            <span class="tve-card-icon tve-card-icon-amber"><i class="fa-solid fa-lock"></i></span>
            <h3>পাসওয়ার্ড পরিবর্তন</h3>
          </div>
          <form id="password-form">
            ${fieldMarkup({ id: "pw-current", label: "বর্তমান পাসওয়ার্ড", icon: "fa-lock", type: "password", required: true, extra: 'autocomplete="current-password"' })}
            ${fieldMarkup({ id: "pw-new", label: "নতুন পাসওয়ার্ড", icon: "fa-key", type: "password", required: true, extra: 'minlength="6" autocomplete="new-password"' })}
            ${fieldMarkup({ id: "pw-confirm", label: "নতুন পাসওয়ার্ড আবার লিখুন", icon: "fa-key", type: "password", required: true, extra: 'minlength="6" autocomplete="new-password"' })}
            <button type="submit" class="tve-form-btn" id="pw-save"><i class="fa-solid fa-key"></i> পাসওয়ার্ড পরিবর্তন করুন</button>
          </form>
        </div>` : `
        <div class="tve-card">
          <div class="tve-card-head">
            <span class="tve-card-icon tve-card-icon-blue"><i class="fa-brands fa-google"></i></span>
            <h3>লগইন পদ্ধতি</h3>
          </div>
          <p class="tve-muted">আপনি Google অ্যাকাউন্ট দিয়ে লগইন করেছেন — এখানে আলাদা কোনো পাসওয়ার্ড নেই।</p>
        </div>`}
      </div>

      <div class="tve-card tve-danger-card">
        <div class="tve-card-head">
          <span class="tve-card-icon tve-card-icon-coral"><i class="fa-solid fa-right-from-bracket"></i></span>
          <div>
            <h3>লগআউট</h3>
            <p class="tve-muted">এই ডিভাইস থেকে আপনার অ্যাকাউন্ট থেকে বের হয়ে যান</p>
          </div>
        </div>
        <button type="button" class="tve-form-btn tve-form-btn-outline" id="pf-logout">লগআউট করুন</button>
      </div>
    </div>`;

  /* ---------- Stats (best-effort — never blocks the rest of the page) ---------- */
  fetchMyResults(user.uid)
    .then((results) => {
      const liveNum = container.querySelector('[data-stat="live"]');
      if (liveNum) liveNum.textContent = results.length;
      if (!results.length) return;
      const total = results.length;
      const avg = Math.round(results.reduce((s, r) => s + (Number(r.percent) || 0), 0) / total);
      const best = Math.max(...results.map((r) => Number(r.percent) || 0));
      container.querySelector('[data-stat="avg"]').textContent = `${avg}%`;
      container.querySelector('[data-stat="best"]').textContent = `${best}%`;
    })
    .catch(() => {});

  /* ---------- Roll row: rebuild synced/unsynced markup + rebind its buttons ---------- */
  function renderRollRow(rollValue, { animate = false } = {}) {
    const rollRow = container.querySelector("#pf-roll-row");
    if (!rollRow) return;
    rollRow.innerHTML = rollValue
      ? `<i class="fa-solid fa-id-card"></i>
         <span data-field="roll"${animate ? ' class="tve-roll-pop"' : ""}>${escapeHtml(rollValue)}</span>
         <span class="tve-sync-badge tve-sync-ok" id="pf-roll-status"><i class="fa-solid fa-check"></i> সিঙ্ক করা হয়েছে</span>
         <button type="button" class="tve-copy-btn" id="pf-roll-copy" title="কপি করুন"><i class="fa-regular fa-copy"></i></button>`
      : `<i class="fa-solid fa-id-card"></i>
         <span data-field="roll">রোল সিঙ্ক করা নেই</span>
         <button type="button" class="tve-sync-btn" id="pf-roll-sync"><i class="fa-solid fa-arrows-rotate"></i> সিঙ্ক করুন</button>`;
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
        toast("রোল নম্বর কপি হয়েছে", "success");
      } catch {
        toast("কপি করা যায়নি", "error");
      }
    });
  }

  function bindRollSync() {
    const rollSyncBtn = container.querySelector("#pf-roll-sync");
    if (!rollSyncBtn) return;
    rollSyncBtn.addEventListener("click", async () => {
      rollSyncBtn.disabled = true;
      rollSyncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> সিঙ্ক হচ্ছে...';
      try {
        const newRoll = await claimNextRoll();
        await updateUserProfile(user, { displayName: name, phone: profile.phone || "", roll: newRoll, institution });
        renderRollRow(newRoll, { animate: true });
        const rollInput = container.querySelector("#pf-roll");
        if (rollInput) rollInput.value = newRoll;
        renderNav("profile");
        toast(`রোল সিঙ্ক করা হয়েছে: ${newRoll}`, "success");
      } catch {
        toast("রোল সিঙ্ক করা যায়নি, আবার চেষ্টা করুন", "error");
        rollSyncBtn.disabled = false;
        rollSyncBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> সিঙ্ক করুন';
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
    if (!newName) { toast("নাম লিখুন", "error"); return; }
    setBtnLoading(btn, "সংরক্ষণ হচ্ছে...", btn.innerHTML);
    try {
      await updateUserProfile(user, { displayName: newName, phone, institution: newInstitution });
      toast("প্রোফাইল আপডেট হয়েছে", "success");
      renderNav("profile");
      // Reflect changes in the banner immediately without a full re-render
      const phoneField = container.querySelector('[data-field="phone"]');
      const instField = container.querySelector('[data-field="institution"]');
      if (phoneField) phoneField.textContent = phone || "ফোন নম্বর যোগ করা হয়নি";
      if (instField) instField.textContent = newInstitution || "প্রতিষ্ঠানের নাম যোগ করা হয়নি";
      const nameEl = container.querySelector(".tve-banner-name");
      if (nameEl) nameEl.childNodes[0].textContent = newName;
    } catch {
      toast("প্রোফাইল আপডেট করা যায়নি, আবার চেষ্টা করুন", "error");
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
      if (next.length < 6) { toast("নতুন পাসওয়ার্ড অন্তত ৬ অক্ষরের হতে হবে", "error"); return; }
      if (next !== confirm) { toast("নতুন পাসওয়ার্ড দুইবার একই দিন", "error"); return; }
      setBtnLoading(btn, "পরিবর্তন হচ্ছে...", btn.innerHTML);
      const ok = await changePassword(user, current, next);
      if (ok) { toast("পাসওয়ার্ড পরিবর্তন হয়েছে", "success"); pwForm.reset(); }
      resetBtn(btn);
    });
  }

  /* ---------- Edit button: jump to + focus the info form ---------- */
  container.querySelector("#pf-edit-jump").addEventListener("click", () => {
    const section = container.querySelector("#pf-edit-section");
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => container.querySelector("#pf-name")?.focus(), 350);
  });

  /* ---------- Logout ---------- */
  container.querySelector("#pf-logout").addEventListener("click", () => logout());
}
