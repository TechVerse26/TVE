"""End-to-end checks for the STUDENT side of Academic Management, against the in-memory Firestore:
   the Academic block on #/exam · Section → Level → Subject → exams drill-down · subject isolation · Free / Paid / locked ·
   hidden (inactive / archived) nodes · deep links, refresh, back / forward · broken images · 320–390px phones ·
   the existing exam engine running an academic exam · the existing course list left exactly as it was.
   python3 tests/e2e/run_academic.py [--shots]
"""
import sys, os, datetime
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from academic_fixtures import add_academic
from playwright.sync_api import sync_playwright

D = 24 * 3600 * 1000
ALL_ACADEMIC = ["academicSections", "academicLevels", "academicSubjects", "academicEntitlements"]


def academic_reads(page):
    return [r for r in reads(page) if r.startswith("academic")]


def titles(page, scope=".ac-grid"):
    return [t.strip() for t in page.locator(f"{scope} .ac-card .ac-cover-title").all_inner_texts()]


def open_student(browser, seed, viewport="mobile", user="stu1", deny=None, errors=None):
    ctx = make_context(browser, VIEWPORTS[viewport], seed=seed, user=user, deny=deny)
    install_clock(ctx)
    page = new_page(ctx, errors if errors is not None else [])
    page.set_default_timeout(9000)
    return ctx, page


def crumbs(page):
    return [t.strip() for t in page.locator("#exam-breadcrumb li").all_inner_texts()]


def hash_of(page):
    return page.evaluate("location.hash")


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ A. The Academic block next to the course cards
    print("\n[A] #/exam — Academic programs sit next to the course cards; the course cards are untouched")
    errors = []
    ctx0, p0 = open_student(browser, fixtures.build(NOW), errors=errors)
    go(p0, "#/exam"); p0.wait_for_selector(".exs-course-card")
    legacy_plain = p0.inner_text("#exam-grid")
    plain_cards = p0.locator(".exs-course-card").count()
    check("without academic data there is no academic block at all (page looks exactly as before)", p0.locator("#exam-academic-block").count() == 0)
    ctx0.close()

    seed = add_academic(fixtures.build(NOW), NOW)
    ctx, page = open_student(browser, seed, errors=errors)
    go(page, "#/exam"); page.wait_for_selector("#exam-academic-block .ac-card")
    check("existing course cards: same cards, same text, same counts as without academic data",
          page.locator(".exs-course-card").count() == plain_cards and page.inner_text("#exam-grid") == legacy_plain, page.inner_text("#exam-grid")[:200])
    check("academic exams are NOT mixed into the legacy 'General Exam' group", "SSC Mathematics" not in page.inner_text("#exam-grid"))
    block = page.locator("#exam-academic-block")
    check("block heading", "Academic Programs" in block.inner_text())
    check("only ACTIVE sections are shown (the inactive 'Admission' is not)", titles(page) == ["Academic"], str(titles(page)))
    card = page.locator('.ac-card[data-id="P1"]')
    txt = card.inner_text()
    check("card: description, level count (active levels only), exam count (hidden node's exam not counted)",
          "School & college programs" in txt and "2 Levels" in txt and "5 Exams" in txt, txt)
    check("card: Free badge + navigation indicator", card.locator(".ac-badge--free").count() == 1 and card.locator(".ac-go").count() == 1)
    check("cover is a real <img> with the saved URL (lazy, no inline style / url() injection)",
          card.locator("img.ac-cover-img").get_attribute("src") == "https://img.example.com/academic.webp"
          and card.locator("img.ac-cover-img").get_attribute("loading") == "lazy" and page.locator(".ac-cover[style]").count() == 0)
    page.wait_for_selector('.ac-card[data-id="P1"] .ac-cover.is-broken')
    check("a picture that does not load falls back to the placeholder (img hidden, icon shown)",
          card.locator("img.ac-cover-img").is_hidden() and card.locator(".ac-cover-ph").is_visible())
    levels_docs = [r for r in academic_reads(page) if r.startswith("academicLevels/") or r.startswith("academicSubjects/")]
    check("#/exam reads no level/subject documents (level count comes from one cheap count query)", levels_docs == [], str(levels_docs))
    shot(page, "academic-home-mobile")
    check("no JS errors on #/exam", not errors, "; ".join(errors[:4]))

    print("\n[A2] A picture that DOES load fades in (is-loaded) and covers the card")
    png = __import__("base64").b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    ctx_i, page_i = open_student(browser, seed, errors=errors)
    page_i.route("https://img.example.com/**", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
    go(page_i, "#/exam"); page_i.wait_for_selector('.ac-card[data-id="P1"] .ac-cover.is-loaded')
    page_i.wait_for_function("getComputedStyle(document.querySelector('.ac-card[data-id=\"P1\"] img.ac-cover-img')).opacity === '1'", timeout=3000)   # the 0.25s fade-in has finished
    box = page_i.locator('.ac-card[data-id="P1"] .ac-cover').bounding_box(); img_box = page_i.locator('.ac-card[data-id="P1"] img.ac-cover-img').bounding_box()
    check("loaded picture: visible, fills the cover (object-fit: cover), 16:9 frame",
          page_i.locator('.ac-card[data-id="P1"] img.ac-cover-img').evaluate("el => getComputedStyle(el).opacity === '1' && getComputedStyle(el).objectFit === 'cover'")
          and abs(img_box["width"] - box["width"]) < 1.5 and abs(img_box["height"] - box["height"]) < 1.5 and abs(box["width"] / box["height"] - 16 / 9) < 0.05, str((box, img_box)))
    ctx_i.close()

    # ------------------------------------------------------------------ B. Drill-down: section → level → subject → exams
    print("\n[B] Academic → levels → subjects → subject dashboard → that subject's exams")
    page.click('.ac-card[data-id="P1"]')
    page.wait_for_selector('.ac-card[data-kind="level"]')
    check("section page URL", hash_of(page) == "#/exam?academicProgram=P1", hash_of(page))
    check("breadcrumb: Courses › Academic", crumbs(page) == ["Courses", "Academic"], str(crumbs(page)))
    check("levels in display order; the inactive 'Masters' is not offered", titles(page) == ["SSC", "HSC"], str(titles(page)))
    ssc, hsc = page.locator('.ac-card[data-id="L-ssc"]'), page.locator('.ac-card[data-id="L-hsc"]')
    check("SSC card: own description, 2 subjects (archived one not counted), its 4 exams; Free badge",
          "Secondary School Certificate" in ssc.inner_text() and "2 Subjects" in ssc.inner_text() and "4 Exams" in ssc.inner_text() and ssc.locator(".ac-badge--free").count() == 1, ssc.inner_text())
    check("HSC card: Paid badge with a lock; 1 subject, 1 exam", hsc.locator(".ac-badge--paid").count() == 1 and hsc.locator(".fa-lock").count() == 1 and "1 Subject" in hsc.inner_text() and "1 Exam" in hsc.inner_text(), hsc.inner_text())
    check("section page header shows the section's own name + description", page.inner_text("#exam-section-title").strip() == "Academic" and "School & college" in page.inner_text("#exam-section-sub"))
    n_reads = len(academic_reads(page))
    shot(page, "academic-levels-mobile")

    ssc.click()
    page.wait_for_selector('.ac-card[data-kind="subject"]')
    check("level page URL", hash_of(page) == "#/exam?academicProgram=P1&academicLevel=L-ssc", hash_of(page))
    check("breadcrumb: Courses › Academic › SSC", crumbs(page) == ["Courses", "Academic", "SSC"], str(crumbs(page)))
    check("ONLY SSC's subjects (Bengali name shows; archived subject and HSC's Mathematics do not)", titles(page) == ["Mathematics", "পদার্থবিজ্ঞান"], str(titles(page)))
    check("subject card: exam count", "3 Exams" in page.locator('.ac-card[data-id="S-ssc-math"]').inner_text() and "1 Exam" in page.locator('.ac-card[data-id="S-ssc-phy"]').inner_text())

    page.click('.ac-card[data-id="S-ssc-math"]')
    page.wait_for_selector(".ac-hub .exs-hub-btn")
    check("subject dashboard URL", hash_of(page) == "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math", hash_of(page))
    check("breadcrumb: Courses › Academic › SSC › Mathematics", crumbs(page) == ["Courses", "Academic", "SSC", "Mathematics"], str(crumbs(page)))
    counts = {b.get_attribute("href").split("type=")[1]: b.locator(".exs-hub-count").inner_text().strip() for b in page.locator(".ac-hub .exs-hub-btn").all()}
    check("Upcoming / Live / Practice with this subject's exam counts", counts == {"upcoming": "1", "live": "1", "practice": "1"}, str(counts))
    check("drilling down level → subject → dashboard cost ZERO extra academic reads (one cached section tree)", len(academic_reads(page)) == n_reads, f"{n_reads} → {len(academic_reads(page))}")
    shot(page, "academic-subject-hub-mobile")

    page.click('.ac-hub a[href$="type=live"]')
    page.wait_for_selector("#exam-grid article.xc")
    body = page.inner_text("#exam-grid")
    check("Live list: this subject's live exam only", "SSC Mathematics Model Test 01" in body and "Physics" not in body and "HSC Mathematics" not in body and "Practice Set" not in body, body[:200])
    check("header: subject · bucket", "Mathematics" in page.inner_text("#exam-section-title") and "Live" in page.inner_text("#exam-section-title"))
    check("breadcrumb ends with the bucket", crumbs(page)[-2:] == ["Mathematics", "Live"], str(crumbs(page)))
    page.go_back(); page.wait_for_selector(".ac-hub .exs-hub-btn")
    page.click('.ac-hub a[href$="type=practice"]'); page.wait_for_selector("#exam-grid article.xc")
    body = page.inner_text("#exam-grid")
    check("Practice list: only the practice set", "SSC Mathematics Practice Set" in body and "Model Test 01" not in body, body[:200])
    page.go_back(); page.wait_for_selector(".ac-hub .exs-hub-btn")
    page.click('.ac-hub a[href$="type=upcoming"]'); page.wait_for_selector("#exam-grid article.xc")
    check("Upcoming list: only the upcoming exam", "SSC Mathematics Model Test 02" in page.inner_text("#exam-grid") and "Model Test 01" not in page.inner_text("#exam-grid"))

    # ---- subject isolation: same name in another level, other subjects
    print("\n[B2] Subject isolation — SSC Physics vs SSC Mathematics vs HSC Mathematics")
    go(page, "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-phy&type=live"); page.wait_for_selector("#exam-grid article.xc")
    body = page.inner_text("#exam-grid")
    check("SSC Physics shows only its own exam", "SSC Physics Chapter Test" in body and "Mathematics" not in body, body[:200])
    go(page, "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math&type=live"); page.wait_for_selector("#exam-grid article.xc")
    check("SSC Mathematics does not show Physics or HSC Mathematics exams", "Physics" not in page.inner_text("#exam-grid") and "HSC Mathematics" not in page.inner_text("#exam-grid"))

    # ------------------------------------------------------------------ C. Free / Paid / locked
    print("\n[C] Free / Paid / Inherit — a Paid level locks its subjects until access is granted")
    go(page, "#/exam?academicProgram=P1&academicLevel=L-hsc"); page.wait_for_selector('.ac-card[data-kind="subject"]')
    check("Paid level: notice explains it, the subject card shows the lock (inherited from the level)",
          page.locator(".ac-notice").count() == 1 and page.locator('.ac-card[data-id="S-hsc-math"] .ac-badge--paid').count() == 1, page.inner_text("#exam-grid")[:200])
    page.click('.ac-card[data-id="S-hsc-math"]')
    page.wait_for_selector(".ac-state--locked")
    check("subject dashboard of a Paid subject → 'Premium access required' (no exam list, no counts)",
          "Premium access required" in page.inner_text("#exam-grid") and page.locator(".ac-hub").count() == 0 and "HSC Mathematics Test" not in page.inner_text("#exam-grid"))
    check("locked screen offers support + back to the level", page.locator('.ac-state a[href="#/help?section=contact"]').count() == 1 and page.locator('.ac-state a[href*="academicLevel=L-hsc"]').count() == 1)
    shot(page, "academic-locked-mobile")
    go(page, "#/exam?academicProgram=P1&academicLevel=L-hsc&academicSubject=S-hsc-math&type=live"); page.wait_for_selector(".ac-state--locked")
    check("the bucket URL of a locked subject is locked too (no way around it by editing the URL)", "HSC Mathematics Test" not in page.inner_text("#exam-grid"))
    go(page, "#/exam?id=ac-hsc-live")
    page.wait_for_selector(".exs-fail, .exs-fail-card, [class*=fail]", timeout=9000)
    check("direct link to a Paid exam without access → 'Premium access required' (not the exam)", "Premium access required" in page.inner_text("body"), page.inner_text("body")[:200])
    check("no question was read for the locked exam", not any("examBundles/ac-hsc-live" in r for r in reads(page)), str([r for r in reads(page) if "examBundles" in r]))
    ctx.close()

    print("\n[C2] …and with an access grant (academicEntitlements) the same pages open")
    seed = add_academic(fixtures.build(NOW), NOW, entitled=["L-hsc"])
    ctx, page = open_student(browser, seed, errors=errors)
    go(page, "#/exam?academicProgram=P1"); page.wait_for_selector('.ac-card[data-id="L-hsc"]')
    check("granted level shows 'Paid · Unlocked'", "Unlocked" in page.locator('.ac-card[data-id="L-hsc"]').inner_text())
    go(page, "#/exam?academicProgram=P1&academicLevel=L-hsc&academicSubject=S-hsc-math"); page.wait_for_selector(".ac-hub .exs-hub-btn")
    counts = {b.get_attribute("href").split("type=")[1]: b.locator(".exs-hub-count").inner_text().strip() for b in page.locator(".ac-hub .exs-hub-btn").all()}
    check("granted student gets the subject dashboard (1 live exam)", counts == {"upcoming": "0", "live": "1", "practice": "0"}, str(counts))
    go(page, "#/exam?id=ac-hsc-live")
    page.wait_for_selector("text=পাস নম্বর", timeout=9000)
    check("granted student reaches the exam rules gate", "Premium access required" not in page.inner_text("body"))
    ctx.close()

    # ------------------------------------------------------------------ D. Hidden nodes, bad URLs
    print("\n[D] Inactive / archived / missing nodes and broken URLs")
    ctx, page = open_student(browser, add_academic(fixtures.build(NOW), NOW), errors=errors)
    for label, url in (("inactive section", "#/exam?academicProgram=P2"), ("unknown section", "#/exam?academicProgram=nope"),
                       ("inactive level", "#/exam?academicProgram=P1&academicLevel=L-ms"), ("unknown level", "#/exam?academicProgram=P1&academicLevel=ghost"),
                       ("archived subject", "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-arch"),
                       ("subject under the wrong level", "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-hsc-math"),
                       ("script in the id", "#/exam?academicProgram=%3Cscript%3Ealert(1)%3C%2Fscript%3E"), ("subject without level", "#/exam?academicProgram=P1&academicSubject=S-ssc-math"),
                       ("unknown bucket", "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math&type=hack")):
        go(page, url); page.wait_for_selector(".ac-state")
        check(f"{label} → friendly 'not available' state with a way back", "isn't available" in page.inner_text("#exam-grid") and page.locator("#exam-grid .ac-state a.btn").count() == 1, page.inner_text("#exam-grid")[:160])
    go(page, "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-arch"); page.wait_for_selector(".ac-state")
    check("the 'back' link of a missing subject goes to its level", page.locator('.ac-state a.btn').get_attribute("href") == "#/exam?academicProgram=P1&academicLevel=L-ssc")
    go(page, "#/exam?id=ac-ms-live"); page.wait_for_selector(".exs-fail, .exs-fail-card, [class*=fail]", timeout=9000)
    check("direct link to an exam under an INACTIVE level → 'Exam not available'", "Exam not available" in page.inner_text("body"), page.inner_text("body")[:200])
    go(page, "#/exams"); page.wait_for_timeout(1500)
    check("All Exams page also leaves out the exam of the inactive level", "Masters Finance Test" not in page.inner_text("body") and "SSC Mathematics Model Test 01" in page.inner_text("body"))
    ctx.close()

    # ------------------------------------------------------------------ E. Deep links, refresh, back / forward
    print("\n[E] Deep links, refresh, back / forward, legacy routes")
    ctx, page = open_student(browser, add_academic(fixtures.build(NOW), NOW), errors=errors)
    go(page, "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math&type=practice")
    page.wait_for_selector("#exam-grid article.xc")
    check("deep link straight to a subject's practice list", "SSC Mathematics Practice Set" in page.inner_text("#exam-grid") and crumbs(page)[-1] == "Practice", str(crumbs(page)))
    page.reload(); page.wait_for_selector("#exam-grid article.xc")
    check("browser refresh keeps the same page", "SSC Mathematics Practice Set" in page.inner_text("#exam-grid"))
    go(page, "#/exam"); page.wait_for_selector("#exam-academic-block .ac-card")
    page.click('.ac-card[data-id="P1"]'); page.wait_for_selector('.ac-card[data-kind="level"]')
    page.click('.ac-card[data-id="L-ssc"]'); page.wait_for_selector('.ac-card[data-kind="subject"]')
    page.go_back(); page.wait_for_selector('.ac-card[data-kind="level"]')
    check("back: subjects → levels", titles(page) == ["SSC", "HSC"] and crumbs(page) == ["Courses", "Academic"], str(crumbs(page)))
    page.go_back(); page.wait_for_selector("#exam-academic-block .ac-card")
    check("back: levels → course list with the academic block", page.locator(".exs-course-card").count() == plain_cards and page.locator("#exam-breadcrumb").count() == 0)
    page.go_forward(); page.wait_for_selector('.ac-card[data-kind="level"]')
    check("forward: course list → levels", titles(page) == ["SSC", "HSC"])
    page.go_back(); page.wait_for_selector("#exam-academic-block .ac-card")
    page.locator(".exs-course-card").first.click(); page.wait_for_selector(".exs-hub-btn")
    check("a legacy course card still opens its hub, and the academic block/breadcrumb are gone there", page.locator("#exam-academic-block").count() == 0 and page.locator("#exam-breadcrumb").count() == 0 and "#/exam?course=" in hash_of(page), hash_of(page))
    for route, marker in (("#/exams", "xc"), ("#/results", ""), ("#/schedule", "")):
        e0 = len(errors)
        go(page, route); page.wait_for_timeout(1300)
        check(f"legacy route {route} still loads", page.locator("#app, main").count() >= 1 and len(errors) == e0, "; ".join(errors[e0:e0 + 2]))
    check("no JS errors across the whole run", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ F. The existing exam engine runs an academic exam
    print("\n[F] An academic exam goes through the SAME exam engine: gate → questions → submit → result")
    ctx, page = open_student(browser, add_academic(fixtures.build(NOW), NOW), errors=errors)
    go(page, "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math&type=practice")
    page.wait_for_selector("#exam-grid article.xc")
    check("the subject's practice list shows the exam card (data-exam-id) for the normal exam route", page.locator('article.xc[data-exam-id="ac-math-prac"]').count() == 1)
    go(page, "#/exam?id=ac-math-prac")
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    subject_hash = "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math"
    check("rules gate: 'Go back' returns to the subject dashboard (not the legacy General course)", page.locator(".exs-rules-actions a.btn").get_attribute("href") == subject_hash, page.locator(".exs-rules-actions a.btn").get_attribute("href"))
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    for i in range(3):
        page.locator(".exs-option").nth(1).click()
        if i < 2:
            page.locator("#q-next").click(); page.wait_for_timeout(150)
    page.locator("#q-submit").click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1200)
    saved = page.evaluate("window.__MOCK__.dump()").get("results/stu1_ac-math-prac")
    check("result saved for the academic exam (3/3)", saved is not None and saved["examId"] == "ac-math-prac" and saved["percent"] == 100, str(saved)[:200])
    check("result screen: 'Course exams' becomes 'Subject exams' and returns to the subject dashboard",
          page.locator("#exs-course-link").get_attribute("href") == subject_hash and "সাবজেক্টের এক্সাম" in page.locator("#exs-course-link").inner_text(), page.locator("#exs-course-link").get_attribute("href"))
    page.locator("#exs-course-link").click()
    page.wait_for_selector(".ac-hub .exs-hub-btn", timeout=9000)
    check("…and clicking it really lands on that subject's dashboard", hash_of(page) == subject_hash and crumbs(page)[-1] == "Mathematics", hash_of(page))
    check("exam flow: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ G. Phones
    print("\n[G] Phones (390px and 320px): no sideways scroll, long Bengali names wrap")
    seed = add_academic(fixtures.build(NOW), NOW)
    seed["academicSubjects/S-ssc-phy"]["name"] = "উচ্চতর পদার্থবিজ্ঞান ও প্রয়োগিক গণিত সমন্বিত বিষয় — পূর্ণাঙ্গ প্রস্তুতি"
    for vp in ("mobile", "tablet", "desktop"):
        ctx, page = open_student(browser, seed, viewport=vp, errors=errors)
        for label, url, sel in (("home", "#/exam", "#exam-academic-block .ac-card"), ("levels", "#/exam?academicProgram=P1", '.ac-card[data-kind="level"]'),
                                ("subjects", "#/exam?academicProgram=P1&academicLevel=L-ssc", '.ac-card[data-kind="subject"]'),
                                ("dashboard", "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math", ".ac-hub"),
                                ("locked", "#/exam?academicProgram=P1&academicLevel=L-hsc&academicSubject=S-hsc-math", ".ac-state--locked")):
            go(page, url); page.wait_for_selector(sel); page.wait_for_timeout(250)
            check(f"{vp}: {label} has no horizontal overflow", no_overflow(page))
        if vp == "mobile":
            page.set_viewport_size({"width": 320, "height": 640})
            for label, url, sel in (("home", "#/exam", "#exam-academic-block .ac-card"), ("subjects", "#/exam?academicProgram=P1&academicLevel=L-ssc", '.ac-card[data-kind="subject"]'),
                                    ("dashboard", "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math", ".ac-hub")):
                go(page, url); page.wait_for_selector(sel); page.wait_for_timeout(250)
                check(f"320px: {label} has no horizontal overflow", no_overflow(page))
            shot(page, "academic-subjects-320")
        ctx.close()

    # ------------------------------------------------------------------ H. Academic collections unreadable (rules not published yet)
    print("\n[H] If the academic collections can't be read (rules not published), nothing else is affected")
    errors = []
    ctx, page = open_student(browser, add_academic(fixtures.build(NOW), NOW), deny=ALL_ACADEMIC, errors=errors)
    go(page, "#/exam"); page.wait_for_selector(".exs-course-card"); page.wait_for_timeout(900)
    check("course cards render, no academic block, no error banner", page.locator(".exs-course-card").count() == plain_cards and page.locator("#exam-academic-block").count() == 0)
    go(page, "#/exam?academicProgram=P1"); page.wait_for_selector(".ac-state")
    check("an academic URL shows a clear message instead of crashing", "Academic programs aren't available" in page.inner_text("#exam-grid") or "isn't available" in page.inner_text("#exam-grid"), page.inner_text("#exam-grid")[:160])
    go(page, "#/exam?id=live1"); page.wait_for_selector("text=পাস নম্বর", timeout=9000)
    check("a normal (non-academic) exam still opens its rules gate", "পাস নম্বর" in page.inner_text("body"))
    check("no uncaught JS errors", not [e for e in errors if e.startswith("pageerror")], "; ".join(errors[:3]))
    ctx.close()

    code = finish()
    browser.close()
    sys.exit(code)
