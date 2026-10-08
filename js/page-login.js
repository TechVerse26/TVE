import { loginWithEmail, loginWithGoogle } from "./auth.js";
import { redirectIfAlreadyAuthed } from "./page-guard-helper.js";
import { renderNav } from "./nav.js";

export async function initLoginPage(params, container) {
  await renderNav("");
  if (await redirectIfAlreadyAuthed()) return;

  container.innerHTML = `
    <div class="container page auth-page">
      <div class="auth-card card card--highlight">
        <div class="auth-logo"><img src="assets/logo.svg" alt="TVexam" width="204" height="46"></div>
        <h1><i class="fa-solid fa-graduation-cap" aria-hidden="true"></i>Welcome Back</h1>
        <p class="auth-sub">Log in to the Exam Platform. Use your Tech Verse Course account to continue.</p>
        <form id="login-form" class="auth-form">
          <div class="field"><label for="li-email">Email</label><input type="email" id="li-email" required autocomplete="email"></div>
          <div class="field"><label for="li-password">Password</label><input type="password" id="li-password" required autocomplete="current-password"></div>
          <button type="submit" class="btn btn-primary btn-block" id="li-submit">Login</button>
        </form>
        <p class="auth-or"><span>or</span></p>
        <button type="button" class="btn btn-outline btn-block" id="li-google"><i class="fa-brands fa-google" aria-hidden="true"></i>Continue With Google</button>
        <p class="auth-switch">Don't have an account? <a href="#/signup">Sign up</a></p>
      </div>
    </div>`;

  container.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#li-submit");
    btn.disabled = true; btn.textContent = "Login Processing...";
    await loginWithEmail(container.querySelector("#li-email").value.trim(), container.querySelector("#li-password").value);
    btn.disabled = false; btn.textContent = "Login";
  });
  container.querySelector("#li-google").addEventListener("click", () => loginWithGoogle());
}
