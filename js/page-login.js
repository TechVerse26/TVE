import { loginWithEmail, loginWithGoogle } from "./auth.js";
import { redirectIfAlreadyAuthed } from "./page-guard-helper.js";
import { renderNav } from "./nav.js";

export async function initLoginPage(params, container) {
  await renderNav("");
  if (await redirectIfAlreadyAuthed()) return;

  container.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card card">
        <div class="auth-logo"><img src="assets/logo.png" alt="TVexam"></div>
        <h1><i class="fa-solid fa-graduation-cap"></i> লগইন করুন</h1>
        <p class="auth-sub">Tech Verse Course অ্যাকাউন্ট দিয়েই এক্সাম সাইটে প্রবেশ করুন</p>
        <form id="login-form" class="auth-form">
          <div class="field"><label>ইমেইল</label><input type="email" id="li-email" required autocomplete="email"></div>
          <div class="field"><label>পাসওয়ার্ড</label><input type="password" id="li-password" required autocomplete="current-password"></div>
          <button type="submit" class="btn btn-primary btn-block" id="li-submit">লগইন করুন</button>
        </form>
        <button type="button" class="btn btn-outline btn-block mt-8" id="li-google"><i class="fa-brands fa-google"></i> Google দিয়ে লগইন</button>
        <p class="auth-switch">অ্যাকাউন্ট নেই? <a href="#/signup">সাইন-আপ করুন</a></p>
      </div>
    </div>`;

  container.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#li-submit");
    btn.disabled = true; btn.textContent = "লগইন হচ্ছে...";
    await loginWithEmail(container.querySelector("#li-email").value.trim(), container.querySelector("#li-password").value);
    btn.disabled = false; btn.textContent = "লগইন করুন";
  });
  container.querySelector("#li-google").addEventListener("click", () => loginWithGoogle());
}
