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
        <h1><i class="fa-solid fa-user-plus"></i>Continue Your Journey</h1>
        <p class="auth-sub">Use the same email address you used to enroll in the Tech Verse Course.</p>
        <form id="signup-form" class="auth-form">
          <div class="field"><label>Name</label><input type="text" id="su-name" required></div>
          <div class="field"><label>Email</label><input type="email" id="su-email" required autocomplete="email"></div>
          <div class="field"><label>Password</label><input type="password" id="su-password" required minlength="6" autocomplete="new-password"></div>
          <button type="submit" class="btn btn-primary btn-block" id="su-submit">Create an account</button>
        </form>
        <button type="button" class="btn btn-outline btn-block mt-8" id="su-google"><i class="fa-brands fa-google"></i>Continue With Google </button>
        <p class="auth-switch">Already have an account? <a href="#/login">Log in</a></p>
      </div>
    </div>`;

  container.querySelector("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = container.querySelector("#su-password").value;
    if (pass.length < 6) { toast("The password must be at least 6 characters long", "error"); return; }
    const btn = container.querySelector("#su-submit");
    btn.disabled = true; btn.textContent = "Account processing...";
    await signupWithEmail(container.querySelector("#su-name").value.trim(), container.querySelector("#su-email").value.trim(), pass);
    btn.disabled = false; btn.textContent = "Create an account";
  });
  container.querySelector("#su-google").addEventListener("click", () => loginWithGoogle());
}
