import { signupWithEmail, loginWithGoogle } from "./auth.js";
import { redirectIfAlreadyAuthed } from "./page-guard-helper.js";
import { toast } from "./utils.js";
import { renderNav } from "./nav.js";

export async function initSignupPage(params, container) {
  await renderNav("");
  if (await redirectIfAlreadyAuthed()) return;

  container.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card card">
        <div class="auth-logo"><img src="assets/logo.png" alt="TVexam"></div>
        <h1><i class="fa-solid fa-user-plus"></i> সাইন-আপ করুন</h1>
        <p class="auth-sub">Tech Verse Course-এ যে ইমেইল দিয়ে এনরোল করেছেন সেটাই ব্যবহার করুন</p>
        <form id="signup-form" class="auth-form">
          <div class="field"><label>নাম</label><input type="text" id="su-name" required></div>
          <div class="field"><label>ইমেইল</label><input type="email" id="su-email" required autocomplete="email"></div>
          <div class="field"><label>পাসওয়ার্ড</label><input type="password" id="su-password" required minlength="6" autocomplete="new-password"></div>
          <button type="submit" class="btn btn-primary btn-block" id="su-submit">অ্যাকাউন্ট তৈরি করুন</button>
        </form>
        <button type="button" class="btn btn-outline btn-block mt-8" id="su-google"><i class="fa-brands fa-google"></i> Google দিয়ে সাইন-আপ</button>
        <p class="auth-switch">আগে থেকেই অ্যাকাউন্ট আছে? <a href="#/login">লগইন করুন</a></p>
      </div>
    </div>`;

  container.querySelector("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = container.querySelector("#su-password").value;
    if (pass.length < 6) { toast("পাসওয়ার্ড অন্তত ৬ অক্ষরের হতে হবে", "error"); return; }
    const btn = container.querySelector("#su-submit");
    btn.disabled = true; btn.textContent = "তৈরি হচ্ছে...";
    await signupWithEmail(container.querySelector("#su-name").value.trim(), container.querySelector("#su-email").value.trim(), pass);
    btn.disabled = false; btn.textContent = "অ্যাকাউন্ট তৈরি করুন";
  });
  container.querySelector("#su-google").addEventListener("click", () => loginWithGoogle());
}
