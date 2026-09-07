// ==========================================================================
// page-profile.js — student profile: account info, stats, edit name/phone,
// change password. Same users/{uid} doc auth.js and nav.js already read.
// ==========================================================================
import { requireAuth, getUserProfile, escapeHtml, toast, formatDate } from "./utils.js";
import { fetchMyResults } from "./exam-data.js";
import { updateUserProfile, changePassword, logout } from "./auth.js";
import { renderNav } from "./nav.js";

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

export async function initProfilePage(params, container) {
  await renderNav("profile");
  const user = await requireAuth();
  if (!user) return;

  const profile = (await getUserProfile(user.uid)) || {};
  const isPasswordUser = user.providerData.some((p) => p.providerId === "password");
  const name = profile.displayName || user.displayName || "";

  container.innerHTML = `
    <div class="container page-pad profile-page">
      <div class="page-head"><h1><i class="fa-solid fa-user"></i> প্রোফাইল</h1><p>আপনার অ্যাকাউন্টের তথ্য দেখুন ও পরিবর্তন করুন</p></div>

      <div class="profile-hero card">
        <span class="profile-avatar">${escapeHtml(initials(name || user.email))}</span>
        <div class="profile-hero-info">
          <h2>${escapeHtml(name || "নাম দেওয়া নেই")}${profile.isAdmin ? ' <span class="badge badge-teal">অ্যাডমিন</span>' : ""}</h2>
          <p class="profile-hero-email"><i class="fa-solid fa-envelope"></i> ${escapeHtml(user.email || "")}</p>
          <span class="exs-muted exs-small">সদস্য হয়েছেন ${profile.createdAt ? formatDate(profile.createdAt) : "—"}</span>
        </div>
      </div>

      <div class="profile-stats" id="profile-stats">
        <div class="stat-box"><span class="stat-num" data-stat="total">0</span><span class="stat-label">মোট এক্সাম</span></div>
        <div class="stat-box"><span class="stat-num" data-stat="avg">0%</span><span class="stat-label">গড় স্কোর</span></div>
        <div class="stat-box"><span class="stat-num" data-stat="best">0%</span><span class="stat-label">সেরা স্কোর</span></div>
      </div>

      <div class="profile-grid">
        <div class="card">
          <h3 class="profile-card-title"><i class="fa-solid fa-id-card"></i> ব্যক্তিগত তথ্য</h3>
          <form id="profile-form">
            <div class="field"><label>নাম</label><input type="text" id="pf-name" value="${escapeHtml(name)}" required></div>
            <div class="field"><label>ইমেইল</label><input type="email" value="${escapeHtml(user.email || "")}" disabled></div>
            <div class="field"><label>ফোন নম্বর</label><input type="tel" id="pf-phone" value="${escapeHtml(profile.phone || "")}" placeholder="যেমন 01XXXXXXXXX"></div>
            <button type="submit" class="btn btn-primary" id="pf-save"><i class="fa-solid fa-check"></i> পরিবর্তন সংরক্ষণ করুন</button>
          </form>
        </div>

        ${isPasswordUser ? `
        <div class="card">
          <h3 class="profile-card-title"><i class="fa-solid fa-lock"></i> পাসওয়ার্ড পরিবর্তন</h3>
          <form id="password-form">
            <div class="field"><label>বর্তমান পাসওয়ার্ড</label><input type="password" id="pw-current" required autocomplete="current-password"></div>
            <div class="field"><label>নতুন পাসওয়ার্ড</label><input type="password" id="pw-new" required minlength="6" autocomplete="new-password"></div>
            <div class="field"><label>নতুন পাসওয়ার্ড আবার লিখুন</label><input type="password" id="pw-confirm" required minlength="6" autocomplete="new-password"></div>
            <button type="submit" class="btn btn-primary" id="pw-save"><i class="fa-solid fa-key"></i> পাসওয়ার্ড পরিবর্তন করুন</button>
          </form>
        </div>` : `
        <div class="card">
          <h3 class="profile-card-title"><i class="fa-brands fa-google"></i> লগইন পদ্ধতি</h3>
          <p class="exs-muted">আপনি Google অ্যাকাউন্ট দিয়ে লগইন করেছেন — এখানে আলাদা কোনো পাসওয়ার্ড নেই।</p>
        </div>`}
      </div>

      <div class="profile-danger card">
        <div>
          <h3 class="profile-card-title"><i class="fa-solid fa-right-from-bracket"></i> লগআউট</h3>
          <p class="exs-muted">এই ডিভাইস থেকে আপনার অ্যাকাউন্ট থেকে বের হয়ে যান</p>
        </div>
        <button type="button" class="btn btn-outline" id="pf-logout">লগআউট করুন</button>
      </div>
    </div>`;

  /* ---------- Stats (best-effort — never blocks the rest of the page) ---------- */
  fetchMyResults(user.uid)
    .then((results) => {
      const nums = container.querySelectorAll("#profile-stats .stat-num");
      if (!results.length) return;
      const total = results.length;
      const avg = Math.round(results.reduce((s, r) => s + (Number(r.percent) || 0), 0) / total);
      const best = Math.max(...results.map((r) => Number(r.percent) || 0));
      nums[0].textContent = total;
      nums[1].textContent = `${avg}%`;
      nums[2].textContent = `${best}%`;
    })
    .catch(() => {});

  /* ---------- Edit name/phone ---------- */
  container.querySelector("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#pf-save");
    const newName = container.querySelector("#pf-name").value.trim();
    const phone = container.querySelector("#pf-phone").value.trim();
    if (!newName) { toast("নাম লিখুন", "error"); return; }
    setBtnLoading(btn, "সংরক্ষণ হচ্ছে...", btn.innerHTML);
    try {
      await updateUserProfile(user, { displayName: newName, phone });
      toast("প্রোফাইল আপডেট হয়েছে", "success");
      renderNav("profile");
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

  /* ---------- Logout ---------- */
  container.querySelector("#pf-logout").addEventListener("click", () => logout());
}
