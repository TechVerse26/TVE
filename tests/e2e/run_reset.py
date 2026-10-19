"""End-to-end checks for "Forgot password?" on the login page (js/page-login.js, js/auth.js, js/auth-reset-core.js).
   python3 tests/e2e/run_reset.py [--shots]      → exit code 0 = all checks passed
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
from playwright.sync_api import sync_playwright


def open_login(browser, viewport=None, errors=None):
    ctx = make_context(browser, viewport or VIEWPORTS["mobile"], user=None)
    install_clock(ctx)
    page = new_page(ctx, errors if errors is not None else [])
    go(page, "#/login")
    page.wait_for_selector("#login-form", timeout=8000)
    return ctx, page


def resets(page):
    return page.evaluate("(window.__MOCK__.resets || []).slice()")


def visible(page, sel):
    return page.locator(sel).is_visible()


def open_reset(page, typed=""):
    if typed:
        page.fill("#li-email", typed)
    page.locator("#li-forgot").click()
    page.wait_for_selector("#reset-form:not(.hidden)", timeout=3000)


def send(page, email):
    page.fill("#rs-email", email)
    page.locator("#rs-submit").click()


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ 1. The link and the panel
    print("\n[1] 'Forgot password?' opens the reset panel inside the login card")
    errors = []
    ctx, page = open_login(browser, errors=errors)
    check("the link sits under the password field", visible(page, "#li-forgot") and page.inner_text("#li-forgot").strip() == "Forgot password?")
    check("the login form is exactly as before (ids, labels, Login button, Google, sign-up link)",
          page.locator("#li-email").count() == 1 and page.locator("#li-password").count() == 1 and page.inner_text("#li-submit") == "Login"
          and visible(page, "#li-google") and visible(page, ".auth-switch"))
    shot(page, "reset-0-login")
    open_reset(page, typed="  Stu@Example.com ")
    check("the heading changes and the login form, 'or', Google and sign-up are tucked away",
          "Reset password" in page.inner_text(".auth-card h1") and not visible(page, "#login-form") and not visible(page, ".auth-or")
          and not visible(page, "#li-google") and not visible(page, ".auth-switch"))
    check("the typed login email is carried over", page.input_value("#rs-email") == "Stu@Example.com")
    check("keyboard focus is in the email field", page.evaluate("document.activeElement && document.activeElement.id") == "rs-email")
    shot(page, "reset-1-panel")
    page.locator("#rs-back").click()
    check("Back to login restores the login card and its heading", visible(page, "#login-form") and "Welcome Back" in page.inner_text(".auth-card h1") and not visible(page, "#reset-form"))
    check("…and puts the cursor in the password field (the email is already there)", page.evaluate("document.activeElement && document.activeElement.id") == "li-password")
    ctx.close()

    # ------------------------------------------------------------------ 2. Validation happens before any network call
    print("\n[2] Mistakes are caught on the page — Firebase is not called for them")
    ctx, page = open_login(browser)
    open_reset(page)
    page.locator("#rs-submit").click()
    check("empty: asks for the email, field flagged invalid", page.inner_text("#rs-msg") == "ইমেইল ঠিকানা লিখুন।" and page.get_attribute("#rs-email", "aria-invalid") == "true")
    send(page, "rahim@")
    check("'rahim@': says the address looks wrong", "সঠিক মনে হচ্ছে না" in page.inner_text("#rs-msg"))
    page.fill("#rs-email", "rahim@gmail.com")
    check("typing again clears the message", not visible(page, "#rs-msg") and page.get_attribute("#rs-email", "aria-invalid") is None)
    check("no mail was requested for any of that", resets(page) == [])
    ctx.close()

    # ------------------------------------------------------------------ 3. A mistyped domain gets one chance to be fixed
    print("\n[3] 'rahim@gmial.com' → \"did you mean rahim@gmail.com?\"")
    ctx, page = open_login(browser)
    open_reset(page)
    send(page, "rahim@gmial.com")
    check("first press: hint shown, nothing sent", visible(page, "#rs-msg") and "rahim@gmail.com" in page.inner_text("#rs-msg") and resets(page) == [], page.inner_text("#rs-msg"))
    shot(page, "reset-2-typo")
    page.locator(".auth-fix").click()
    check("tapping the suggestion fixes the field", page.input_value("#rs-email") == "rahim@gmail.com")
    page.locator("#rs-submit").click()
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("the corrected address is the one that is sent", [r["email"] for r in resets(page)] == ["rahim@gmail.com"], str(resets(page)))
    ctx.close()
    ctx, page = open_login(browser)
    open_reset(page)
    send(page, "rahim@gmial.com")
    page.locator("#rs-submit").click()          # insisting on the typed address is allowed (second press)
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("pressing again with the same address sends it as typed (their choice)", [r["email"] for r in resets(page)] == ["rahim@gmial.com"], str(resets(page)))
    ctx.close()

    # ------------------------------------------------------------------ 4. The happy path
    print("\n[4] Success: mail requested once, 'check your email', resend held back for a minute")
    errors = []
    ctx, page = open_login(browser, errors=errors)
    open_reset(page)
    send(page, "  STU@Example.com ")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    calls = resets(page)
    check("exactly one request, with the cleaned-up address", len(calls) == 1 and calls[0]["email"] == "stu@example.com", str(calls))
    check("the mail's 'continue' button leads back to this site's login", calls[0]["settings"] and calls[0]["settings"]["url"].endswith("/index.html#/login") and calls[0]["settings"]["handleCodeInApp"] is False, str(calls[0]))
    check("the mail is requested in Bengali (language set for the call) …", calls[0]["lang"] == "bn", str(calls[0]))
    check("… and the SDK's language is put back afterwards",
          page.evaluate("import('/js/firebase-config.js').then(m => m.auth.languageCode || null)") is None)
    done = page.inner_text("#reset-done")
    check("confirmation names the address and explains the next steps (inbox, Spam, link, log in)",
          "stu@example.com" in done and "Spam" in done and "নতুন পাসওয়ার্ড" in done and "Check your email" in page.inner_text(".auth-card h1"), done[:160])
    shot(page, "reset-3-done")
    check("resend is held back, with the time left on the button", page.is_disabled("#rd-resend") and "(" in page.inner_text("#rd-resend") and page.inner_text("#rd-resend").startswith("Resend link"), page.inner_text("#rd-resend"))
    first = page.inner_text("#rd-resend")
    page.wait_for_timeout(2200)
    check("the countdown on the button ticks", page.inner_text("#rd-resend") != first, f"{first} → {page.inner_text('#rd-resend')}")
    ctx.clock.fast_forward(61 * 1000)
    page.wait_for_timeout(1300)
    check("after a minute the button is live again", not page.is_disabled("#rd-resend") and page.inner_text("#rd-resend") == "Resend link", page.inner_text("#rd-resend"))
    page.locator("#rd-resend").click()
    page.wait_for_timeout(500)
    check("resend sends a second request for the same address", len(resets(page)) == 2 and resets(page)[1]["email"] == "stu@example.com", str(resets(page)))
    check("…and the wait starts again", page.is_disabled("#rd-resend"))
    check("success run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 5. A refresh must not skip the wait
    print("\n[5] Refreshing the page does not give a free second mail")
    ctx, page = open_login(browser)
    open_reset(page)
    send(page, "stu@example.com")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    page.reload()
    page.wait_for_selector("#login-form", timeout=8000)
    open_reset(page, typed="stu@example.com")
    page.locator("#rs-submit").click()
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("same address within the minute → straight to 'check your email', NO new request", resets(page) == [], str(resets(page)))
    check("…with the resend still held back", page.is_disabled("#rd-resend"))
    page.locator("#rd-back").click()
    open_reset(page)
    send(page, "someone.else@example.com")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("a different address is not held back by the first one", [r["email"] for r in resets(page)] == ["someone.else@example.com"], str(resets(page)))
    ctx.close()

    # ------------------------------------------------------------------ 6. No account probing
    print("\n[6] An unknown address looks exactly like a known one")
    ctx, page = open_login(browser)
    page.evaluate("window.__MOCK__.resetErrors = ['auth/user-not-found']")
    open_reset(page)
    send(page, "nobody@example.com")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("'user-not-found' → the same confirmation screen", "যদি" in page.inner_text("#reset-done") and "nobody@example.com" in page.inner_text("#reset-done") and not visible(page, "#rd-msg"))
    ctx.close()

    # ------------------------------------------------------------------ 7. Errors
    print("\n[7] Real failures are explained in Bengali")
    ctx, page = open_login(browser)
    open_reset(page)
    page.evaluate("window.__MOCK__.resetErrors = ['auth/network-request-failed']")
    send(page, "stu@example.com")
    page.wait_for_selector("#rs-msg:not([hidden])", timeout=5000)
    check("offline: 'ইন্টারনেট সংযোগ নেই…', field flagged, button live again (no lock-out)",
          "ইন্টারনেট" in page.inner_text("#rs-msg") and not page.is_disabled("#rs-submit") and page.inner_text("#rs-submit") == "Send reset link")
    page.locator("#rs-submit").click()
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("…and simply pressing again works once the connection is back", len(resets(page)) == 2)
    ctx.close()

    ctx, page = open_login(browser)
    open_reset(page)
    page.evaluate("window.__MOCK__.resetErrors = ['auth/too-many-requests']")
    send(page, "stu@example.com")
    page.wait_for_selector("#rs-msg:not([hidden])", timeout=5000)
    page.wait_for_timeout(300)
    check("'too many requests': explained, and the button is held back with a countdown",
          "অনেকবার" in page.inner_text("#rs-msg") and page.is_disabled("#rs-submit") and page.inner_text("#rs-submit").startswith("Try again in"), page.inner_text("#rs-submit"))
    shot(page, "reset-4-flood")
    check("the hold-back is ~5 minutes", page.inner_text("#rs-submit").replace("Try again in ", "").startswith(("4:5", "5:0")), page.inner_text("#rs-submit"))
    ctx.close()

    ctx, page = open_login(browser)
    open_reset(page)
    page.evaluate("window.__MOCK__.resetErrors = ['auth/some-new-code']")
    send(page, "stu@example.com")
    page.wait_for_selector("#rs-msg:not([hidden])", timeout=5000)
    check("an unknown error code gets the generic message", "পাঠানো যায়নি" in page.inner_text("#rs-msg"))
    ctx.close()

    # ------------------------------------------------------------------ 8. Domain not authorised for the continue link
    print("\n[8] Continue-URL refused by Firebase → sent again without it")
    errors = []
    ctx, page = open_login(browser, errors=errors)
    page.evaluate("window.__MOCK__.resetErrors = ['auth/unauthorized-continue-uri']")
    open_reset(page)
    send(page, "stu@example.com")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    calls = resets(page)
    check("two requests: with the continue link (refused), then plain (accepted)", len(calls) == 2 and calls[0]["settings"] and calls[1]["settings"] is None, str(calls))
    check("the student just sees success", visible(page, "#reset-done") and not visible(page, "#rd-msg"))
    check("fallback run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 9. Back to login keeps the email
    print("\n[9] Back to login")
    ctx, page = open_login(browser)
    open_reset(page)
    send(page, "stu@example.com")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    page.locator("#rd-back").click()
    check("login card is back, the address is filled in, the cursor waits in the password field",
          visible(page, "#login-form") and page.input_value("#li-email") == "stu@example.com" and page.evaluate("document.activeElement.id") == "li-password")
    check("heading restored, Google / sign-up visible again", "Welcome Back" in page.inner_text(".auth-card h1") and visible(page, "#li-google") and visible(page, ".auth-switch"))
    ctx.close()

    # ------------------------------------------------------------------ 10. Phones
    print("\n[10] Every state fits a 320px phone")
    ctx, page = open_login(browser, viewport={"width": 320, "height": 640})
    check("login card at 320px", no_overflow(page))
    open_reset(page)
    check("reset panel at 320px", no_overflow(page))
    send(page, "a.very.long.address.for.a.student.with.a.long.name@some-long-example-domain.com.bd")
    page.wait_for_selector("#reset-done:not(.hidden)", timeout=5000)
    check("'check your email' with a very long address at 320px", no_overflow(page))
    shot(page, "reset-5-320")
    ctx.close()

    browser.close()

sys.exit(finish())
