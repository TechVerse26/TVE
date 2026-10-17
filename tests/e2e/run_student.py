"""End-to-end checks for the student site against an in-memory Firestore (no network).
   python3 tests/e2e/run_student.py [--shots]      → exit code 0 = all checks passed
"""
import sys, os, re, datetime
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
from playwright.sync_api import sync_playwright


def user_doc(page, uid="stu1"):
    return page.evaluate("""async (uid) => {
      const { db } = await import('/js/firebase-config.js');
      const f = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
      const snap = await f.getDoc(f.doc(db, 'users', uid));
      return snap.data();
    }""", uid)


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ 1. Home: content, sections, reads
    print("\n[1] Home dashboard — content, sections, Firestore reads")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    ctx.clock.install(time=datetime.datetime.fromtimestamp(NOW / 1000, tz=datetime.timezone.utc))
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=8000)
    page.wait_for_timeout(300)
    txt = page.inner_text("#hm-root")
    check("greeting + student name", "Hello, Abdullah" in txt)
    check("admin hero title shown", "প্রস্তুত তো? আজকের পরীক্ষা শুরু করুন।" in txt)
    check("Live Now section lists the live exam", page.locator(".hm-live .lv-title").first.inner_text() == "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫")
    check("live participants (128) shown", "128" in page.locator(".hm-live").inner_text())
    check("urgent notice is prominent", page.locator(".nt--urgent").count() == 1)
    check("expired / scheduled / other-course notices are hidden", page.locator(".nt").count() == 3, f"{page.locator('.nt').count()} notices")
    check("Next exam block names the next scheduled exam", "English Grammar Test 02" in page.inner_text(".nx"))
    cd = page.locator(".nx-clock [data-cd]").all_inner_texts()
    check("countdown has days:hours:minutes:seconds (00:00:44:5x)", cd[:3] == ["00", "00", "44"] or cd[:3] == ["00", "00", "45"], str(cd))
    check("schedule rows grouped (live first)", page.locator(".sr").count() >= 3 and page.locator(".sr").first.get_attribute("data-status") == "live")
    check("cancelled exam shown as Not Available in schedule", page.locator('.sr[data-status="unavailable"]').count() == 1)
    check("featured exams section (2 featured)", page.locator(".xc--featured").count() == 2)
    check("categories: subject tiles + category chips", page.locator(".hm-tile").count() >= 5 and page.locator(".hm-chip").count() >= 2)
    check("quick actions (8)", page.locator(".hm-qa").count() == 8)
    check("performance summary + chart", page.locator(".pf-cell").count() == 7 and page.locator(".pf-col").count() >= 2)
    check("recent results (≤4) with Pass/Fail", 1 <= page.locator(".rs").count() <= 4 and page.locator(".rs-pf").count() >= 1)
    check("leaderboard preview with Your Rank", page.locator(".lb-row").count() == 5 and "Your Rank" in page.inner_text(".lb-me"))
    check("motivation + guidelines present", page.locator(".hm-quote").count() == 1 and page.locator(".hm-guides li").count() == 6)
    check("hidden/unlisted/locked exams not listed", "Course-only Exam" not in page.inner_text("#hm-root") and "Unlisted Direct-link" not in page.inner_text("#hm-root"))
    check("no horizontal overflow (mobile)", no_overflow(page))
    r = reads(page)
    uniq = sorted(set(r))
    check("cold home load reads only the 5 shared docs", uniq == sorted(["users/stu1", "examIndex/main", "homeFeed/main", "userStats/stu1", "leaderboard/publicStats"]), str(uniq))
    check("each doc read exactly once", len(r) == len(uniq), str(r))
    check("0 Firestore writes on load", len(writes(page)) == 0, str(writes(page)))
    shot(page, "home-mobile")

    # navigate around within the cache window → no extra reads
    before = len(reads(page))
    for h in ["#/exams", "#/schedule", "#/home", "#/performance", "#/leaderboard", "#/notifications", "#/home"]:
        go_hash = page.evaluate(f"location.hash = '{h}'")
        page.wait_for_timeout(350)
    after = reads(page)
    check("moving between 6 pages inside the cache window costs 0 extra reads", len(after) == before, f"{len(after) - before} extra: {after[before:]}")
    check("no JS errors on the home run", not errors, "; ".join(errors[:4]))

    # ------------------------------------------------------------------ 2. Reminders + live flip
    print("\n[2] Reminder, countdown reaching zero, bell")
    page.evaluate("location.hash = '#/home'")
    page.wait_for_selector(".nx")
    btn = page.locator('.nx [data-act="remind"]')
    check("Remind me button visible for the upcoming exam", btn.count() == 1 and "Remind me" in btn.inner_text())
    w0 = len(writes(page))
    btn.click()
    page.wait_for_timeout(200)
    check("click → 'Reminder set'", "Reminder set" in page.locator('.nx [data-act="remind"]').inner_text())
    check("reminder stored locally, 0 Firestore writes", len(writes(page)) == w0 and "soon1" in page.evaluate("localStorage.getItem('tvexam_rem_v1:stu1')"))
    page.reload(); page.wait_for_selector(".nx")
    check("reminder survives a refresh", "Reminder set" in page.locator('.nx [data-act="remind"]').inner_text())
    page.locator('.nx [data-act="remind"]').click()
    check("cancel works", "Remind me" in page.locator('.nx [data-act="remind"]').inner_text() and page.evaluate("Object.keys(JSON.parse(localStorage.getItem('tvexam_rem_v1:stu1')||'{}')).length") == 0)
    page.locator('.nx [data-act="remind"]').click()  # set again for the fast-forward below

    # fast-forward 31 minutes: reminder (T−15) must fire; then 15 more: exam goes live
    advance[0] += 31 * 60 * 1000
    page.clock.fast_forward(31 * 60 * 1000)
    page.wait_for_timeout(300)
    notif = page.evaluate("JSON.parse(localStorage.getItem('tvexam_localnotif_v1:stu1')||'[]')")
    check("reminder fired 15 min before start (bell item filed)", any("pre" in n["id"] for n in notif), str(notif))
    check("in-app toast shown", page.locator("#toast-root .toast, .toast").count() >= 1)
    check("bell shows an unread badge", not page.locator("#nav-bell-badge").evaluate("e => e.classList.contains('hidden')"))
    advance[0] += 16 * 60 * 1000
    page.clock.fast_forward(16 * 60 * 1000)
    page.wait_for_timeout(1500)
    page.clock.fast_forward(1500)
    page.wait_for_timeout(500)
    live_titles = page.locator(".hm-live .lv-title").all_inner_texts()
    check("upcoming exam flipped to Live without a refresh", "English Grammar Test 02" in live_titles, str(live_titles))
    check("start reminder filed too", any(":start:" in n["id"] for n in page.evaluate("JSON.parse(localStorage.getItem('tvexam_localnotif_v1:stu1')||'[]')")))
    page.locator("#nav-bell").click()
    page.wait_for_selector(".bell-item")
    check("bell panel lists notifications", page.locator(".bell-item").count() >= 3)
    shot(page, "bell-mobile", full=False)
    page.locator("#bell-markall").click()
    check("mark all read clears the badge", page.locator("#nav-bell-badge").evaluate("e => e.classList.contains('hidden')"))
    ctx.close()

    # ------------------------------------------------------------------ 3. Wrong device clock
    print("\n[3] Device clock 3 hours ahead of the server")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], skew_ms=3 * 60 * 60 * 1000)
    ctx.clock.install(time=datetime.datetime.fromtimestamp((NOW + 3 * 60 * 60 * 1000) / 1000, tz=datetime.timezone.utc))
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector("#hm-root:not([hidden]) .nx", timeout=8000)
    page.wait_for_timeout(1200)
    cd = page.locator(".nx-clock [data-cd]").all_inner_texts()
    check("countdown follows SERVER time (≈44 min, not wrong by 3 h)", cd[0] == "00" and cd[1] == "00" and cd[2] in ("44", "45"), str(cd))
    check("English test is still 'upcoming', live exam still live", page.locator(".hm-live .lv-title").count() == 1)
    check("device-clock notice shown", "ডিভাইসের সময় সঠিক নয়" in page.inner_text("#hm-root"))
    ctx.close()

    # ------------------------------------------------------------------ 4. Other pages + responsive
    print("\n[4] Exams / Schedule / Notifications / Leaderboard / Performance — 3 screen sizes")
    for vp_name, vp in VIEWPORTS.items():
        errors = []
        ctx = make_context(browser, vp)
        ctx.clock.install(time=datetime.datetime.fromtimestamp(NOW / 1000, tz=datetime.timezone.utc))
        page = new_page(ctx, errors)
        go(page, "#/home")
        page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=8000)
        if vp_name != "mobile":
            shot(page, f"home-{vp_name}")
        for route, sel in [("#/exams", ".xc-grid"), ("#/schedule", ".sr"), ("#/notifications", ".nf"), ("#/leaderboard", ".lb-row"), ("#/performance", ".pf-table")]:
            page.evaluate(f"location.hash = '{route}'")
            page.wait_for_selector(sel, timeout=6000)
            page.wait_for_timeout(200)
            check(f"{vp_name}: {route} renders, no horizontal overflow", no_overflow(page))
            shot(page, f"{route.strip('#/')}-{vp_name}")
        check(f"{vp_name}: no JS errors", not errors, "; ".join(errors[:4]))
        if vp_name == "mobile":
            check("mobile: bottom navigation visible", page.locator("#bottom-nav").is_visible())
        if vp_name == "desktop":
            check("desktop: bottom navigation hidden", not page.locator("#bottom-nav").is_visible())
        ctx.close()

    # ------------------------------------------------------------------ 5. Filters
    print("\n[5] All Exams filters and URL state")
    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    ctx.clock.install(time=datetime.datetime.fromtimestamp(NOW / 1000, tz=datetime.timezone.utc))
    page = new_page(ctx, errors)
    go(page, "#/exams?type=practice")
    page.wait_for_selector(".xc")
    check("?type=practice → only practice exams", page.locator(".xc").count() == 1 and "IQ Practice" in page.inner_text(".xc"))
    page.evaluate("location.hash = '#/exams'"); page.wait_for_selector(".xc")
    n_all = page.locator(".xc").count()
    check("default list excludes locked + unlisted exams", n_all == 9, f"{n_all} cards")
    page.fill("#fl-q", "english"); page.wait_for_timeout(400)
    check("search 'english' → 1 result", page.locator(".xc").count() == 1)
    check("URL carries the filter", "q=english" in page.evaluate("location.hash"))
    page.fill("#fl-q", ""); page.wait_for_timeout(400)
    page.select_option("#fl-status", "upcoming"); page.wait_for_timeout(200)
    check("status=upcoming → 3 exams", page.locator(".xc").count() == 3, str(page.locator(".xc .xc-title").all_inner_texts()))
    page.select_option("#fl-status", ""); page.select_option("#fl-subject", "s-bn"); page.wait_for_timeout(200)
    check("subject filter", page.locator(".xc").count() == 2, str(page.locator(".xc").count()))
    page.select_option("#fl-subject", ""); page.select_option("#fl-category", "c-model"); page.wait_for_timeout(200)
    check("category filter includes sub-category (Set A)", page.locator(".xc").count() == 3, str(page.locator(".xc").count()))
    page.select_option("#fl-category", ""); page.select_option("#fl-difficulty", "hard"); page.wait_for_timeout(200)
    check("difficulty filter", page.locator(".xc").count() == 1)
    page.locator("#fl-clear").click(); page.wait_for_timeout(200)
    check("clear filters restores the list", page.locator(".xc").count() == n_all)
    page.fill("#fl-q", "zzzz"); page.wait_for_timeout(400)
    check("no match → friendly empty state", "কোনো পরীক্ষা পাওয়া যায়নি" in page.inner_text("#ex-body"))
    # card CTAs
    page.fill("#fl-q", ""); page.wait_for_timeout(400)
    cta = lambda id_: page.locator(f'.xc[data-exam-id="{id_}"] .xc-cta').inner_text().strip()
    check("CTA: live → Start Exam", cta("live1") == "Start Exam", cta("live1"))
    check("CTA: upcoming → Coming Soon", cta("up1") == "Coming Soon", cta("up1"))
    check("CTA: practice with history → Continue Practice", cta("prac1") == "Continue Practice", cta("prac1"))
    check("CTA: closed with result → View Result", cta("done1") == "View Result", cta("done1"))
    check("CTA: attempts used up → View Result", cta("full1") == "View Result", cta("full1"))
    check("CTA: cancelled → Not Available", cta("cx1") == "Not Available", cta("cx1"))
    page.locator('.xc[data-exam-id="up1"] [data-act="details"]').click()
    page.wait_for_selector(".xd-grid")
    check("Details sheet shows pass mark / negative marking / time zone", all(t in page.inner_text(".xd-grid") for t in ["Pass mark", "Negative marking", "GMT+6"]))
    ctx.close()

    # ------------------------------------------------------------------ 6. Exam flow (existing) still works
    print("\n[6] The existing exam flow: guard → rules → questions → submit → result")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    ctx.clock.install(time=datetime.datetime.fromtimestamp(NOW / 1000, tz=datetime.timezone.utc))
    page = new_page(ctx, errors)
    go(page, "#/exam?id=soon1")
    page.wait_for_selector(".exs-fail, .exs-fail-card, [class*=fail]", timeout=8000)
    check("early access is blocked with the start time", "hasn't started" in page.inner_text("body"))
    go(page, "#/exam?id=cx1")
    page.wait_for_timeout(1200)
    check("cancelled exam cannot be entered", "not available" in page.inner_text("body").lower() or "বাতিল" in page.inner_text("body"), page.inner_text("body")[:200])
    go(page, "#/exam?id=live1")
    page.wait_for_selector("text=পাস নম্বর", timeout=9000)
    gate = page.inner_text("body")
    check("rules gate shows pass mark, negative marking and closing time", all(t in gate for t in ["পাস নম্বর", "নেগেটিভ মার্কিং আছে", "শুরু করার শেষ সময়"]))
    shot(page, "rules-gate-mobile")
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    check("exam started: questions loaded, bottom bar hidden while taking", page.locator("#bottom-nav").is_hidden())
    check("one 'started' counter write (examSessions), nothing else yet", [w for w in writes(page) if "examSessions" in w["path"]] == [{"op": "set", "path": "examSessions/stu1_live1"}], str(writes(page)))
    # answer all three questions (q1 right, q2 right, q3 wrong) and submit
    for i in range(3):
        page.locator(".exs-option").nth(1 if i == 1 or i == 2 else 0).click()   # q1 → A (right) · q2 → B (right) · q3 → B ("Apple", right)
        if i < 2:
            page.locator("#q-next").click(); page.wait_for_timeout(150)
    # make q3 wrong on purpose: pick option A ("Car") instead
    page.locator(".exs-option").nth(0).click() if page.locator(".exs-option.is-selected").count() == 0 else None
    page.locator("#q-submit").click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1200)   # the save runs in the background after the result is shown
    res = page.evaluate("window.__MOCK__.dump()")
    saved = res.get("results/stu1_live1")
    check("result screen shown, result document saved", saved is not None and saved["examId"] == "live1", str(saved)[:200])
    st = res["userStats/stu1"]["exams"]["live1"]
    check("summary entry written with latest + BEST percent", st["p"] == saved["percent"] and st["b"] == saved["percent"] and st["n"] == 1, str(st))
    check("bottom bar is back after submitting", page.locator("#bottom-nav").is_visible() and not page.evaluate("document.body.classList.contains('exam-taking')"))
    check("exam flow: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 7. Signed-out visitor
    print("\n[7] Signed-out visitor")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], user=None)
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector(".hm-hero--public", timeout=8000)
    check("public landing: hero + Login / Sign up, guidelines", page.locator(".hm-cta a").count() == 2 and page.locator(".hm-guides li").count() == 6)
    check("no Firestore reads for a signed-out visitor", reads(page) == [], str(reads(page)))
    check("no bell, no bottom bar when signed out", page.locator("#nav-bell").count() == 0 and page.locator("#bottom-nav").count() == 0)
    go(page, "#/exams")
    page.wait_for_timeout(800)
    check("#/exams while signed out → login", "login" in page.evaluate("location.hash"), page.evaluate("location.hash"))
    check("signed-out run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 8. Profile (redesigned page, unchanged behaviour)
    print("\n[8] Profile — reference profile view · Settings (info + roll + password) · Google variant · Log Out")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/profile")
    page.wait_for_selector(".pfl-id", timeout=8000)
    page.wait_for_timeout(500)
    check("profile: navy identity header, banner, details card, 4 stat tiles, quick-links menu, Log Out",
          page.locator("#generic-page-content .pfl-head h1.page-title").inner_text() == "Abdullah Rahman" and page.locator(".pfl-id").count() == 1
          and page.locator(".pfl-banner").count() == 1 and page.locator(".pfl-menu .pfl-menu-item").count() == 9
          and page.locator("#profile-stats .stat-tile").count() == 4 and page.locator("#pf-logout").count() == 1)
    menu = [t.strip().split("\n")[0] for t in page.locator(".pfl-menu .pfl-menu-item").all_inner_texts()]
    check("profile: the menu has Schedule, What's New and Settings (real destinations only)", "Schedule" in menu and "What's New" in menu and "Settings" in menu and menu[-1] == "Settings", str(menu))
    check("profile: the editing forms moved into Settings (none on this view)", page.locator("#profile-form").count() == 0 and page.locator("#password-form").count() == 0)
    check("profile: stats come from userStats (average is not the 0% placeholder)", page.locator('[data-stat="avg"]').inner_text() != "0%", page.locator('[data-stat="avg"]').inner_text())
    check("profile: banner follows the real data (the student has attempts)", "progress is amazing" in page.inner_text("[data-banner]"))
    check("profile: uses the global white card surface (no one-off colour / gradient)", page.evaluate("getComputedStyle(document.querySelector('.pfl-id')).backgroundColor") == "rgb(255, 255, 255)")
    check("profile: no horizontal overflow at 390px", no_overflow(page))
    page.set_viewport_size({"width": 320, "height": 700}); page.wait_for_timeout(150)
    check("profile: no horizontal overflow at 320px", no_overflow(page))
    page.set_viewport_size({"width": 1366, "height": 850}); page.wait_for_timeout(150)
    cols = page.evaluate("getComputedStyle(document.querySelector('.pfl-details')).gridTemplateColumns.split(' ').length")
    check("profile desktop: details in 3 columns, no overflow", cols == 3 and no_overflow(page), str(cols))
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(150)

    page.click(".pfl-gear")
    page.wait_for_selector("#profile-form", timeout=6000)
    page.wait_for_timeout(300)
    check("settings: reached from the gear — header “Settings”, one info form + one password form, no stats / menu",
          page.locator("#generic-page-content .page-head .page-title").inner_text().strip() == "Settings" and page.locator("#profile-form").count() == 1 and page.locator("#password-form").count() == 1
          and page.locator("#profile-stats").count() == 0 and page.locator(".pfl-menu").count() == 0)
    check("settings: has a back arrow", page.locator(".page-head .page-back").count() == 1)
    check("settings: email and roll are read-only", page.locator("#pf-email").is_disabled() and page.locator("#pf-roll").is_disabled())
    check("settings: no horizontal overflow at 390px", no_overflow(page))
    page.set_viewport_size({"width": 320, "height": 700}); page.wait_for_timeout(150)
    check("settings: no horizontal overflow at 320px", no_overflow(page))
    page.set_viewport_size({"width": 1366, "height": 850}); page.wait_for_timeout(150)
    cols = page.evaluate("getComputedStyle(document.querySelector('.pfl-grid')).gridTemplateColumns.split(' ').length")
    check("settings desktop: the two cards sit in 2 columns, no overflow", cols == 2 and no_overflow(page), str(cols))
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(150)

    check("roll: Sync button sits inside the Roll field", page.locator("#pf-roll-field #pf-roll-sync").count() == 1)
    page.click("#pf-roll-sync")
    page.wait_for_selector("#pf-roll-copy", timeout=6000)
    roll = page.input_value("#pf-roll")
    check("roll: Sync claims the next serial and shows it in the field", re.fullmatch(r"\d{4,}", roll) is not None, roll)
    check("roll: Sync button replaced by Copy; counter advanced and the roll is stored on users/stu1",
          page.locator("#pf-roll-sync").count() == 0 and any(w.get("path") == "counters/students" for w in writes(page)) and user_doc(page).get("roll") == roll, str(user_doc(page)))

    page.fill("#pf-name", "Abdullah R. Khan")
    page.fill("#pf-phone", "01712345678")
    page.fill("#pf-institution", "Tech Verse Academy")
    page.click("#pf-save")
    page.wait_for_timeout(900)
    check("save: top bar + drawer pick up the new name (no reload)",
          "Abdullah R. Khan" in (page.get_attribute(".nav-user-chip", "aria-label") or "") and "Abdullah R. Khan" in (page.text_content(".nav-drawer-user-name") or ""))
    stored = user_doc(page)
    check("save: stored on users/stu1 (name, phone, organisation) and the roll is left exactly as it was",
          stored.get("displayName") == "Abdullah R. Khan" and stored.get("phone") == "01712345678" and stored.get("institution") == "Tech Verse Academy" and stored.get("roll") == roll, str(stored))

    page.fill("#pw-current", "oldpass1"); page.fill("#pw-new", "newpass1"); page.fill("#pw-confirm", "different1")
    page.click("#pw-save"); page.wait_for_timeout(400)
    check("password: a mismatching confirmation is rejected", "Confirm password" in page.inner_text("#toast-root"), page.inner_text("#toast-root"))
    page.fill("#pw-confirm", "newpass1"); page.click("#pw-save"); page.wait_for_timeout(800)
    check("password: matching change succeeds and the form resets", "Your Password has been updated" in page.inner_text("#toast-root") and page.input_value("#pw-new") == "")

    page.evaluate("location.hash = '#/profile'")
    page.wait_for_selector(".pfl-menu", timeout=6000); page.wait_for_timeout(400)
    card = page.inner_text(".pfl-head") + " " + page.inner_text(".pfl-id")
    check("profile: shows the saved name / phone / organisation", "Abdullah R. Khan" in card and "01712345678" in card and "Tech Verse Academy" in card, card[:160])
    check("profile: the synced roll is shown in the details card with its status", roll in page.inner_text("#pf-roll-row") and page.locator("#pf-roll-status").count() == 1)
    page.click("#pf-logout")
    page.wait_for_selector("#login-form", timeout=6000)
    check("log out: returns to the login page", "login" in page.evaluate("location.hash"))
    check("profile run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    ctx.add_init_script("window.__MOCK__.user.providerData = [{providerId: 'google.com'}];")
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/profile?view=settings")
    page.wait_for_selector("#profile-form", timeout=8000)
    check("settings (Google account): no password form, a calm info card instead",
          page.locator("#password-form").count() == 0 and "Google" in page.inner_text(".pfl-google") and page.locator(".pfl-google.card--danger").count() == 0)
    check("settings (Google account): no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 9. Navigation structure (desktop · phone bar · drawer · bell)
    print("\n[9] Navigation — one active item everywhere, 5-item phone bar, secondary-only drawer, bell panel")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector("#bottom-nav", timeout=8000)
    labels = [t.strip() for t in page.locator("#bottom-nav .bn-item").all_inner_texts()]
    check("phone bar: exactly Home · Exams · Courses · Results · Profile", labels == ["Home", "Exams", "Courses", "Results", "Profile"], str(labels))
    check("phone top bar: brand + schedule + bell + avatar menu, no desktop links, no profile chip",
          page.locator(".brand--lockup").is_visible() and page.locator(".nav-schedule").is_visible() and page.locator("#nav-bell").is_visible() and page.locator("#nav-hamburger").is_visible() and not page.locator("#nav-links").is_visible() and not page.locator(".nav-user-chip").is_visible())
    expect = {"#/home": "Home", "#/exams": "Exams", "#/exam": "Courses", "#/categories": "Exams", "#/schedule": "Exams", "#/results": "Results", "#/performance": "Results", "#/leaderboard": "Results", "#/profile": "Profile"}
    for route, label in expect.items():
        page.evaluate(f"location.hash = '{route}'"); page.wait_for_timeout(900)
        act = [a.strip() for a in page.locator('#bottom-nav [aria-current="page"]').all_inner_texts()]
        check(f"phone bar: only “{label}” is active on {route}", act == [label], str(act))
    page.evaluate("location.hash = '#/notifications'"); page.wait_for_timeout(900)
    check("notifications page: the bell is the active item (and nothing else)", page.locator("#nav-bell.is-active").count() == 1 and page.locator('#bottom-nav [aria-current="page"]').count() == 0)

    page.click("#nav-hamburger"); page.wait_for_timeout(450)
    items = [t.strip() for t in page.locator("#nav-drawer .nav-drawer-item").all_inner_texts()]
    check("drawer: secondary links only — Schedule · Leaderboard · My Performance · Notifications · Profile", items == ["Schedule", "Leaderboard", "My Performance", "Notifications", "Profile"], str(items))
    check("drawer: shows name + email and a Sign Out button, fits the screen",
          "Abdullah" in page.inner_text(".nav-drawer-user-name") and "stu@example.com" in page.inner_text(".nav-drawer-user-email") and page.locator("#nav-drawer-signout").is_visible() and no_overflow(page))
    check("drawer: the current page (Notifications) is marked", page.locator('#nav-drawer [aria-current="page"]').all_inner_texts()[0].strip() == "Notifications")
    page.keyboard.press("Escape"); page.wait_for_timeout(450)
    check("drawer: closes with Escape and is removed from the tab order", page.locator("#nav-drawer.open").count() == 0 and not page.locator("#nav-drawer-signout").is_visible())

    page.evaluate("location.hash = '#/home'"); page.wait_for_timeout(900)
    page.click("#nav-bell"); page.wait_for_selector(".bell-item", timeout=5000); page.wait_for_timeout(300)
    geo = page.evaluate("(() => { const p = document.getElementById('bell-panel').getBoundingClientRect(), n = document.getElementById('bottom-nav').getBoundingClientRect(); return { bottom: p.bottom, navTop: n.top, left: p.left, right: p.right, vw: innerWidth }; })()")
    check("phone bell panel: above the bottom bar and inside the screen width", geo["bottom"] <= geo["navTop"] + 1 and geo["left"] >= 0 and geo["right"] <= geo["vw"], str(geo))
    check("navigation run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/schedule")
    page.wait_for_selector("#nav-links .nav-link", timeout=8000)
    links = [t.strip() for t in page.locator("#nav-links .nav-link").all_inner_texts()]
    check("desktop nav: Home · All Exams · Courses · Schedule · Results in the centre", links == ["Home", "All Exams", "Courses", "Schedule", "Results"], str(links))
    check("desktop nav: bell + profile on the right; no phone bar, no menu button",
          page.locator("#nav-bell").is_visible() and page.locator(".nav-user-chip").is_visible() and not page.locator("#bottom-nav").is_visible() and not page.locator("#nav-hamburger").is_visible())
    check("desktop nav: exactly one active link (Schedule)", [a.strip() for a in page.locator('#nav-links [aria-current="page"]').all_inner_texts()] == ["Schedule"])
    page.evaluate("location.hash = '#/profile'"); page.wait_for_timeout(900)
    check("desktop nav: on Profile the profile chip is active, no centre link is", page.locator(".nav-user-chip[aria-current='page']").count() == 1 and page.locator('#nav-links [aria-current="page"]').count() == 0)
    check("desktop nav run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    errors = []
    seed = fixtures.build(NOW); seed["users/stu1"]["isAdmin"] = True
    ctx = make_context(browser, VIEWPORTS["desktop"], seed=seed)
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector(".nav-admin", timeout=8000)
    check("admin: the Admin button sits beside the profile chip on desktop", page.locator(".nav-admin").is_visible() and "admin.html" in page.get_attribute(".nav-admin", "href"))
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
    page.click("#nav-hamburger"); page.wait_for_timeout(450)
    check("admin: the drawer lists Admin Panel on a phone", "Admin Panel" in page.inner_text("#nav-drawer"))
    ctx.close()

    # ------------------------------------------------------------------ 10. Categories + header shortcuts + hero search (reference screens)
    print("\n[10] Categories — All Categories, search, subject page; Schedule shortcut; hero search")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/categories")
    page.wait_for_selector(".cg-row", timeout=8000)
    page.wait_for_timeout(400)
    texts = page.locator(".cg-row").all_inner_texts()
    check("categories: one row per subject with visible exams, each showing its exam count", len(texts) >= 5 and all(re.search(r"\d+ Exams?", t) for t in texts), str(len(texts)))
    check("categories: back arrow + search box, nothing wider than the screen", page.locator(".page-head .page-back").count() == 1 and page.locator("#cg-q").count() == 1 and no_overflow(page))
    page.fill("#cg-q", "zzzz-no-such-category"); page.wait_for_timeout(250)
    check("categories: search hides every row and shows the empty note", page.locator(".cg-row:visible").count() == 0 and page.locator("#cg-empty").is_visible())
    page.fill("#cg-q", ""); page.wait_for_timeout(250)
    check("categories: clearing the search brings every row back", page.locator(".cg-row:visible").count() == len(texts))
    page.set_viewport_size({"width": 320, "height": 700}); page.wait_for_timeout(150)
    check("categories: no horizontal overflow at 320px", no_overflow(page))
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(150)
    page.locator(".cg-row").first.click()
    page.wait_for_selector(".cg-banner", timeout=6000)
    page.wait_for_timeout(300)
    start = page.locator(".cg-start").first
    check("subject page: banner + a “Start Exam” row that leads to the pre-filtered All Exams list",
          page.locator(".cg-banner").count() == 1 and page.locator(".cg-item").count() >= 1 and (start.get_attribute("href") or "").startswith("#/exams?"), str(start.get_attribute("href")))
    check("subject page: only the Exams tab is lit", [a.strip() for a in page.locator('#bottom-nav [aria-current="page"]').all_inner_texts()] == ["Exams"])
    start.click()
    page.wait_for_selector(".xc", timeout=8000)
    check("subject page → All Exams: opens already filtered (fewer cards than the full list)", 0 < page.locator(".xc").count() < 9, str(page.locator(".xc").count()))
    go(page, "#/exams")
    page.wait_for_selector(".xc", timeout=8000)
    check("All Exams: the header carries a Schedule shortcut (Schedule stays one tap away)", page.locator('.page-head a[href="#/schedule"]').count() == 1)
    check("All Exams: every exam card has its category icon tile", page.locator(".xc .xc-ico").count() == page.locator(".xc").count())
    page.click(".nav-schedule")
    page.wait_for_timeout(700)
    check("top bar: the calendar shortcut opens Schedule on a phone", "schedule" in page.evaluate("location.hash"))
    go(page, "#/home")
    page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=8000)
    page.fill("[data-hm-q]", "model test"); page.press("[data-hm-q]", "Enter"); page.wait_for_timeout(700)
    check("hero search: Enter opens All Exams with that search applied", "#/exams?q=model%20test" in page.evaluate("location.hash") and page.input_value("#fl-q") == "model test", page.evaluate("location.hash"))
    check("categories run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 11. What's New popup
    print("\n[11] What's New popup — once per release, never over login / exam, re-openable from Profile")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], whatsnew_seen=False)
    install_clock(ctx)
    page = new_page(ctx, errors)
    ver = whatsnew_version()
    go(page, "#/home")
    page.wait_for_selector(".wn-sheet", timeout=9000)
    page.wait_for_timeout(300)
    check("what's new: appears on the first visit of a release", page.locator(".wn-sheet").is_visible())
    check("what's new: a real modal dialog with a title, a lead line and 5+ updates",
          page.get_attribute(".wn-sheet", "role") == "dialog" and page.get_attribute(".wn-sheet", "aria-modal") == "true"
          and page.locator("#wn-title").inner_text().strip() != "" and page.locator(".wn-item").count() >= 5, str(page.locator(".wn-item").count()))
    check("what's new: the OK button has the focus and the page behind is inert",
          page.evaluate("document.activeElement.id") == "wn-ok" and page.evaluate("document.getElementById('page-generic').inert === true"))
    check("what's new: fits a phone (nothing wider than the screen, the button is on screen)",
          no_overflow(page) and page.evaluate("document.getElementById('wn-ok').getBoundingClientRect().bottom <= window.innerHeight"))
    for _ in range(14): page.keyboard.press("Tab")
    check("what's new: Tab stays inside the dialog (focus trap)", page.evaluate("!!document.activeElement.closest('.wn-sheet')"))
    page.keyboard.press("Escape"); page.wait_for_timeout(250)
    check("what's new: Escape closes it, remembers the release and un-locks the page",
          page.locator(".wn-overlay").count() == 0 and page.evaluate("localStorage.getItem('tvexam.whatsnew')") == ver
          and page.evaluate("document.getElementById('page-generic').inert === false") and page.evaluate("document.body.style.overflow") == "")
    go(page, "#/home"); page.wait_for_timeout(2600)
    check("what's new: not shown again for the same release", page.locator(".wn-overlay").count() == 0)

    page.evaluate("localStorage.removeItem('tvexam.whatsnew')")
    go(page, "#/exam?id=live1"); page.wait_for_timeout(2600)
    check("what's new: never over an exam", page.locator(".wn-overlay").count() == 0)
    page.evaluate("location.hash = '#/home'")
    page.wait_for_selector(".wn-sheet", timeout=9000)
    check("what's new: shows on the next safe page instead", page.locator(".wn-sheet").is_visible())
    page.click("#wn-ok"); page.wait_for_timeout(250)
    check("what's new: the OK button closes it and remembers the release", page.locator(".wn-overlay").count() == 0 and page.evaluate("localStorage.getItem('tvexam.whatsnew')") == ver)

    # a visitor who is not signed in: not over the login / signup forms, but on the landing page like everyone else
    ctx2 = make_context(browser, VIEWPORTS["mobile"], user=None, whatsnew_seen=False)
    install_clock(ctx2)
    page2 = new_page(ctx2, errors)
    go(page2, "#/login"); page2.wait_for_selector("#login-form", timeout=8000); page2.wait_for_timeout(2600)
    check("what's new: never over the login form", page2.locator(".wn-overlay").count() == 0)
    go(page2, "#/signup"); page2.wait_for_timeout(2600)
    check("what's new: never over the signup form", page2.locator(".wn-overlay").count() == 0)
    page2.evaluate("location.hash = '#/home'")
    page2.wait_for_selector(".wn-sheet", timeout=9000)
    check("what's new: visitors who are not signed in see it on the landing page", page2.locator(".wn-sheet").is_visible() and page2.locator(".hm-hero--public").count() == 1)
    ctx2.close()

    page.evaluate("localStorage.setItem('tvexam.whatsnew', 'an-older-release')")
    page.reload()                                   # the next visit after a new release
    page.wait_for_selector(".wn-sheet", timeout=9000)
    check("what's new: a newer release is announced again", page.locator(".wn-sheet").is_visible())
    page.click(".wn-close"); page.wait_for_timeout(250)

    page.evaluate("location.hash = '#/profile'")
    page.wait_for_selector("[data-open-whatsnew]", timeout=8000)
    page.click("[data-open-whatsnew]")
    page.wait_for_selector(".wn-sheet", timeout=4000)
    check("what's new: can be re-opened any time from Profile → What's New", page.locator(".wn-sheet").is_visible())
    page.click(".wn-overlay", position={"x": 5, "y": 5}); page.wait_for_timeout(250)
    check("what's new: a tap on the backdrop closes it", page.locator(".wn-overlay").count() == 0)
    page.set_viewport_size({"width": 320, "height": 640}); page.wait_for_timeout(150)
    page.click("[data-open-whatsnew]"); page.wait_for_selector(".wn-sheet", timeout=4000); page.wait_for_timeout(450)   # let the slide-up finish
    check("what's new: fits a 320px phone too", no_overflow(page) and page.evaluate("document.getElementById('wn-ok').getBoundingClientRect().bottom <= window.innerHeight"))
    check("what's new run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    browser.close()

sys.exit(finish())
