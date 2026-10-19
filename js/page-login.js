// ==========================================================================
// page-login.js — Log in (email/password or Google) + "Forgot password?".
//
// The reset panel lives INSIDE the login card (no new route): login → reset → "check your email" → back to login.
// Every rule that can be decided without a browser — what a valid address is, what a mistyped domain looks like,
// what each Firebase error means, how long a resend is held back — is in auth-reset-core.js (unit-tested).
// ==========================================================================
import { loginWithEmail, loginWithGoogle, sendPasswordReset } from "./auth.js";
import { redirectIfAlreadyAuthed } from "./page-guard-helper.js";
import { renderNav } from "./nav.js";
import { onPageLeave } from "./page-lifecycle.js";
import { lsGet, lsSet } from "./local-store.js";
import { validateResetEmail, resetOutcome, cooldownRecord, cooldownLeft, waitLabel } from "./auth-reset-core.js";

const COOLDOWN_KEY = "tvexam:reset-wait"; // per device: a refresh must not skip the wait between two mails
const HEAD = {
  login: { icon: "fa-graduation-cap", title: "Welcome Back", sub: "Log in to the Exam Platform. Use your Tech Verse Course account to continue." },
  reset: { icon: "fa-key", title: "Reset password", sub: "আপনার অ্যাকাউন্টের ইমেইল দিন — পাসওয়ার্ড বদলানোর লিংক পাঠিয়ে দেব।" },
  done: { icon: "fa-envelope-circle-check", title: "Check your email", sub: "পাসওয়ার্ড রিসেটের লিংক পাঠানো হয়েছে।" },
};

export async function initLoginPage(params, container) {
  await renderNav("");
  if (await redirectIfAlreadyAuthed()) return;

  container.innerHTML = `
    <div class="container page auth-page">
      <div class="auth-card card card--highlight">
        <div class="auth-logo"><img src="assets/logo-on-navy.svg" alt="TVexam" width="204" height="46"></div>
        <h1><i class="fa-solid fa-graduation-cap" aria-hidden="true"></i>Welcome Back</h1>
        <p class="auth-sub">Log in to the Exam Platform. Use your Tech Verse Course account to continue.</p>
        <form id="login-form" class="auth-form">
          <div class="field"><label for="li-email">Email</label><input type="email" id="li-email" required autocomplete="email"></div>
          <div class="field">
            <label for="li-password">Password</label>
            <input type="password" id="li-password" required autocomplete="current-password">
            <button type="button" class="auth-forgot" id="li-forgot">Forgot password?</button>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="li-submit">Login</button>
        </form>

        <form id="reset-form" class="auth-form auth-reset hidden" novalidate>
          <div class="field">
            <label for="rs-email">Email</label>
            <input type="email" id="rs-email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" aria-describedby="rs-msg">
            <p class="auth-msg" id="rs-msg" role="alert" hidden></p>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="rs-submit" data-idle="Send reset link">Send reset link</button>
          <button type="button" class="auth-back" id="rs-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Back to login</button>
        </form>

        <div id="reset-done" class="auth-done hidden" tabindex="-1">
          <p>যদি <b id="rd-email"></b> ঠিকানায় অ্যাকাউন্ট থাকে, সেখানে পাসওয়ার্ড বদলানোর একটি লিংক পাঠানো হয়েছে।</p>
          <ol class="auth-steps">
            <li>ইনবক্স দেখুন — মেইল না পেলে Spam বা Promotions ফোল্ডারও দেখুন।</li>
            <li>মেইলের লিংকে ট্যাপ করে নতুন পাসওয়ার্ড দিন।</li>
            <li>এখানে ফিরে এসে নতুন পাসওয়ার্ড দিয়ে লগইন করুন।</li>
          </ol>
          <p class="auth-note">ঠিকানা ভুল হয়ে থাকলে ফিরে গিয়ে আবার দিন। Google দিয়ে সাইন-আপ করে থাকলে পাসওয়ার্ড লাগে না — "Continue With Google" চাপুন।</p>
          <p class="auth-msg" id="rd-msg" role="alert" hidden></p>
          <button type="button" class="btn btn-outline btn-block" id="rd-resend" data-idle="Resend link">Resend link</button>
          <button type="button" class="auth-back" id="rd-back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Back to login</button>
        </div>

        <p class="auth-or"><span>or</span></p>
        <button type="button" class="btn btn-outline btn-block" id="li-google"><i class="fa-brands fa-google" aria-hidden="true"></i>Continue With Google</button>
        <p class="auth-switch">Don't have an account? <a href="#/signup">Sign up</a></p>
      </div>
    </div>`;

  /* ---------- Log in (unchanged behaviour) ---------- */
  container.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = container.querySelector("#li-submit");
    btn.disabled = true; btn.textContent = "Login Processing...";
    await loginWithEmail(container.querySelector("#li-email").value.trim(), container.querySelector("#li-password").value);
    btn.disabled = false; btn.textContent = "Login";
  });
  container.querySelector("#li-google").addEventListener("click", () => loginWithGoogle());

  /* ---------- Forgot password ---------- */
  const $ = (sel) => container.querySelector(sel);
  const loginForm = $("#login-form"), resetForm = $("#reset-form"), doneEl = $("#reset-done");
  const orEl = $(".auth-or"), googleBtn = $("#li-google"), switchEl = $(".auth-switch");
  const h1 = $(".auth-card h1"), sub = $(".auth-sub");
  const emailInput = $("#rs-email"), msgEl = $("#rs-msg"), submitBtn = $("#rs-submit");
  const doneMsg = $("#rd-msg"), resendBtn = $("#rd-resend");

  let mode = "login";
  let alive = true;      // false once the student has left this page
  let busy = false;      // a request is in flight
  let ticker = null;
  let currentEmail = ""; // the address the last mail was asked for
  let typoAckFor = "";   // the address the "did you mean …?" hint was already shown for

  function stopTick() { clearInterval(ticker); ticker = null; }
  onPageLeave(() => { alive = false; stopTick(); });

  const record = () => lsGet(COOLDOWN_KEY, null);
  const waitFor = (email) => cooldownLeft(record(), email, Date.now());

  function setLabel(btn, text) { if (btn.textContent !== text) btn.textContent = text; }

  /** Button states that depend on the clock: the resend wait, and the hold-back after "too many requests". */
  function paintButtons() {
    if (busy) return;
    const rec = record();
    if (mode === "done") {
      const left = waitFor(currentEmail);
      resendBtn.disabled = left > 0;
      setLabel(resendBtn, left > 0 ? `${resendBtn.dataset.idle} (${waitLabel(left)})` : resendBtn.dataset.idle);
    } else if (mode === "reset") {
      const left = rec?.kind === "flood" ? waitFor(emailInput.value) : 0;
      submitBtn.disabled = left > 0;
      setLabel(submitBtn, left > 0 ? `Try again in ${waitLabel(left)}` : submitBtn.dataset.idle);
    }
  }

  function show(next) {
    mode = next;
    const login = next === "login";
    [loginForm, orEl, googleBtn, switchEl].forEach((el) => el.classList.toggle("hidden", !login));
    resetForm.classList.toggle("hidden", next !== "reset");
    doneEl.classList.toggle("hidden", next !== "done");
    const head = HEAD[next];
    h1.innerHTML = `<i class="fa-solid ${head.icon}" aria-hidden="true"></i>${head.title}`; // fixed strings from HEAD — nothing typed by the student
    sub.textContent = head.sub;
    stopTick();
    if (next !== "login") { ticker = setInterval(paintButtons, 1000); paintButtons(); }
  }

  function clearMsg() {
    msgEl.hidden = true; msgEl.textContent = ""; msgEl.className = "auth-msg";
    emailInput.removeAttribute("aria-invalid");
  }
  function showError(text, el = msgEl) {
    el.textContent = text; el.className = "auth-msg"; el.hidden = false;
    if (el === msgEl) emailInput.setAttribute("aria-invalid", "true");
  }
  function showHint(suggestion) {
    msgEl.textContent = ""; msgEl.className = "auth-msg auth-msg--hint"; msgEl.hidden = false;
    const fix = document.createElement("button");
    fix.type = "button"; fix.className = "auth-fix"; fix.textContent = suggestion;
    fix.addEventListener("click", () => { emailInput.value = suggestion; typoAckFor = ""; clearMsg(); submitBtn.focus(); });
    msgEl.append("আপনি কি ", fix, " লিখতে চেয়েছেন? না হলে আবার \"Send reset link\" চাপুন।");
  }

  function setBusy(btn, on) {
    busy = on;
    btn.disabled = on;
    btn.textContent = on ? "Sending..." : btn.dataset.idle;
  }

  function showDone(email) {
    currentEmail = email;
    $("#rd-email").textContent = email;
    doneMsg.hidden = true;
    show("done");
    doneEl.focus({ preventScroll: true });
  }

  function backToLogin() {
    const typed = mode === "done" ? currentEmail : emailInput.value.trim();
    show("login");
    const loginEmail = $("#li-email");
    if (typed && !loginEmail.value) loginEmail.value = typed;
    (loginEmail.value ? $("#li-password") : loginEmail).focus({ preventScroll: true });
  }

  async function requestLink(email, btn) {
    const rec = record();
    const left = cooldownLeft(rec, email, Date.now());
    if (left > 0) {
      // "sent": the first mail is already on its way — say so instead of sending a second one.  "flood": the button is held back (paintButtons).
      if (rec.kind === "sent") showDone(email); else paintButtons();
      return;
    }
    setBusy(btn, true);
    const result = await sendPasswordReset(email);
    if (!alive) return;
    setBusy(btn, false);
    const outcome = resetOutcome(result.code);
    if (outcome.cooldownMs > 0) lsSet(COOLDOWN_KEY, cooldownRecord(email, Date.now(), outcome.cooldownMs, outcome.kind === "sent" ? "sent" : "flood"));
    if (outcome.kind === "sent") { showDone(email); return; }
    showError(outcome.message, mode === "done" ? doneMsg : msgEl);
    paintButtons();
  }

  $("#li-forgot").addEventListener("click", () => {
    const typed = $("#li-email").value.trim();
    emailInput.value = typed;
    typoAckFor = "";
    clearMsg();
    show("reset");
    emailInput.focus({ preventScroll: true });
  });

  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const v = validateResetEmail(emailInput.value);
    if (!v.ok) { showError(v.error); emailInput.focus(); return; }
    if (v.suggestion && typoAckFor !== v.email) { typoAckFor = v.email; showHint(v.suggestion); return; } // one chance to fix a mistyped domain
    clearMsg();
    await requestLink(v.email, submitBtn);
  });
  emailInput.addEventListener("input", () => { typoAckFor = ""; clearMsg(); paintButtons(); });

  resendBtn.addEventListener("click", async () => { if (!busy) await requestLink(currentEmail, resendBtn); });
  $("#rs-back").addEventListener("click", backToLogin);
  $("#rd-back").addEventListener("click", backToLogin);
}
