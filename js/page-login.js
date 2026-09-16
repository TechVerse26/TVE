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
        <h1><i class="fa-solid fa-graduation-cap"></i>Welcome Back</h1>
        <p class="auth-sub">Log in to the Exam Platform.Use your Tech Verse Course account to continue.</p>
        <form id="login-form" class="auth-form">
          <div class="field"><label>Email</label><input type="email" id="li-email" required autocomplete="email"></div>
          <div class="field"><label>Password</label><input type="password" id="li-password" required autocomplete="current-password"></div>
          <button type="submit" class="btn btn-primary btn-block" id="li-submit">Login</button>
        </form>
        <button type="button" class="btn btn-outline btn-block mt-8" id="li-google"><i class="fa-brands fa-google"></i>Continue With Google</button>
        <p class="auth-switch">Don't have an account? <a href="#/signup">Sign up</a></p>
      </div>
    </div>`;

  container.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#li-submit");
    btn.disabled = true; btn.textContent = "Login Processing...";
    await loginWithEmail(container.querySelector("#li-email").value.trim(), container.querySelector("#li-password").value);
    btn.disabled = false; btn.textContent = "Log in";
  });
  container.querySelector("#li-google").addEventListener("click", () => loginWithGoogle());
}
