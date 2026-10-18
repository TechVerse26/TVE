"""End-to-end checks for the Leaderboard: every row shows name + roll + photo, every live exam has its own leaders,
   and the admin's privacy choice still decides what is published — all against the in-memory Firestore.
   python3 tests/e2e/run_leaderboard.py [--shots]
"""
import sys, os, base64, re
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
GOOD_PHOTO = "https://lh3.googleusercontent.com/a/rahim=s96-c"      # served as a real image below
BROKEN_PHOTO = "https://broken.example/nusrat.png"                  # answers 200 with no image data → must fall back to initials
D = fixtures.D
HR = fixtures.H


def dbdoc(page, path):
    return page.evaluate("(p) => window.__MOCK__.dump()[p] || null", path)


def attempt(percent, secs, hours_ago):
    return {"percent": percent, "score": percent // 10, "total": 10, "timeTakenSeconds": secs, "submittedAt": fixtures.ts(NOW - hours_ago * HR)}


def result(uid, exam_id, title, attempts, at, typ="live"):
    last = attempts[-1]
    return {"uid": uid, "examId": exam_id, "examTitle": title, "examType": typ, "percent": last["percent"], "score": last["score"], "total": 10,
            "attemptNumber": len(attempts), "attempts": attempts, "timeTakenSeconds": last["timeTakenSeconds"], "submittedAt": fixtures.ts(at)}


def admin_seed(mode=None, exam_title=None):
    seed = fixtures.build_admin(NOW)
    seed["users/stuA"].update(roll="0001", photoURL=GOOD_PHOTO)                  # Rahim Uddin
    seed["users/stuB"].update(roll="0002")                                       # Karim Hossain — no photo
    seed["users/stuC"].update(roll="0003", photoURL=BROKEN_PHOTO)                # Nusrat Jahan — photo that will not load
    seed["users/stu1"].update(roll="0007")                                       # the student who looks at the page: Abdullah Rahman
    title = exam_title or "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫"
    seed["results/stuA_live1"] = result("stuA", "live1", title, [attempt(55, 300, 5), attempt(90, 320, 2)], NOW - 2 * HR)   # best = 2nd attempt
    seed["results/stuB_live1"] = result("stuB", "live1", title, [attempt(40, 280, 3)], NOW - 3 * HR)
    seed["results/stuC_live1"] = result("stuC", "live1", title, [attempt(70, 300, 4)], NOW - 4 * HR)
    seed["results/stu1_live1"] = result("stu1", "live1", title, [attempt(100, 200, 1)], NOW - 1 * HR)                        # the viewer is this exam's leader
    seed["results/stuA_done1"] = result("stuA", "done1", "Previous Week Model Test", [attempt(80, 300, 80)], NOW - 3 * D)    # older exam
    seed["results/stuB_done1"] = result("stuB", "done1", "Previous Week Model Test", [attempt(60, 300, 80)], NOW - 3 * D)
    seed["results/stuA_prac1"] = result("stuA", "prac1", "IQ Practice Set", [attempt(100, 100, 6)], NOW - 6 * HR, typ="practice")  # practice never counts
    if mode:
        seed["homeFeed/main"]["content"]["leaderboardNames"] = mode
    return seed


def photo_routes(ctx):
    ctx.route("https://lh3.googleusercontent.com/**", lambda route, req: route.fulfill(status=200, content_type="image/png", body=PNG))


def admin_publishes(browser, mode=None, exam_title=None):
    """Open the admin Leaderboard tab (that is what publishes the student-facing lists) and return the resulting database."""
    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"], seed=admin_seed(mode, exam_title), user="adm1")
    install_clock(ctx)
    photo_routes(ctx)
    page = new_page(ctx, errors)
    page.set_default_timeout(9000)
    page.goto(f"{BASE}/admin.html#/leaderboard")
    page.wait_for_selector("#leaderboard-table tr.lb-row", timeout=9000)
    page.wait_for_timeout(900)
    db = page.evaluate("window.__MOCK__.dump()")
    ctx.close()
    return db, errors


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ A. Admin publishes (full names)
    print("\n[A] Admin opens Leaderboard → publicStats now carries name · roll · photo and exam-wise leaders")
    db_full, errs = admin_publishes(browser)
    ps = db_full["leaderboard/publicStats"]
    top = ps["top"]
    check("overall list is still ranked by average of best results", [t["p"] for t in top] == [100, 85, 70, 50], str(top))
    check("each overall row has name + roll", [(t["n"], t["r"]) for t in top] == [("Abdullah Rahman", "0007"), ("Rahim Uddin", "0001"), ("Nusrat Jahan", "0003"), ("Karim Hossain", "0002")], str(top))
    check("photo published only for students who have one", [t.get("ph") for t in top] == [None, GOOD_PHOTO, BROKEN_PHOTO, None], str([t.get("ph") for t in top]))
    ex = ps.get("exams") or []
    check("one leaders list per live exam, newest first, practice excluded", [x["id"] for x in ex] == ["live1", "done1"], str([x["id"] for x in ex]))
    live1 = ex[0] if ex else {"top": []}
    check("live1 leaders ranked by best attempt (100, 90, 70, 40)", [t["p"] for t in live1["top"]] == [100, 90, 70, 40], str(live1["top"]))
    check("live1: Rahim's best attempt (90) counts, not his latest", live1["top"][1]["n"] == "Rahim Uddin" and live1["top"][1]["s"] == 9 and live1["top"][1]["o"] == 10 if len(live1["top"]) > 1 else False)
    check("live1: head-count and rolls", live1.get("c") == 4 and [t.get("r") for t in live1["top"]] == ["0007", "0001", "0003", "0002"], str(live1))
    check("done1 leaders (80, 60)", [t["p"] for t in ex[1]["top"]] == [80, 60] if len(ex) > 1 else False)
    check("only publicStats was written for the student lists (no extra document)", not any(k.startswith("leaderboard/") and k != "leaderboard/publicStats" for k in db_full))
    check("admin run: no JS errors", not errs, "; ".join(errs[:4]))

    # ------------------------------------------------------------------ B. Student sees it
    print("\n[B] Student → #/leaderboard (phone)")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], seed=db_full, user="stu1")
    install_clock(ctx)
    photo_routes(ctx)
    page = new_page(ctx, errors)
    go(page, "#/leaderboard")
    page.wait_for_selector(".lb-row", timeout=9000)
    page.wait_for_selector("#lb-exam-view .lb-row", timeout=9000)
    page.wait_for_timeout(700)
    overall = page.locator(".lb-list").first
    rows = overall.locator(".lb-row")
    check("overall list: 4 rows with real names (no 'Student N')", rows.count() == 4 and "Student" not in overall.inner_text(), overall.inner_text())
    names = [rows.nth(i).locator(".lb-name").evaluate("el => el.firstChild.textContent.trim()") for i in range(rows.count())]
    check("name shown first on every row", names == ["Abdullah Rahman", "Rahim Uddin", "Nusrat Jahan", "Karim Hossain"], str(names))
    smalls = [rows.nth(i).locator(".lb-name small").inner_text().strip() for i in range(rows.count())]
    check("roll sits under each name (with the exam count, as before)", smalls == ["Roll 0007 · 1 live exam", "Roll 0001 · 2 live exams", "Roll 0003 · 1 live exam", "Roll 0002 · 2 live exams"], str(smalls))
    check("Rahim's photo is drawn", rows.nth(1).locator(".lb-avatar img").count() == 1 and rows.nth(1).locator(".lb-avatar img").get_attribute("src") == GOOD_PHOTO)
    check("a student without a photo keeps the initials tile", rows.nth(3).locator(".lb-avatar img").count() == 0 and rows.nth(3).locator(".lb-avatar").inner_text().strip() == "KH")
    check("a photo that fails to load falls back to initials", rows.nth(2).locator(".lb-avatar img").count() == 0 and rows.nth(2).locator(".lb-avatar").inner_text().strip() == "NJ", rows.nth(2).locator(".lb-avatar").inner_html())
    check("'You' is matched by roll (exact)", rows.nth(0).locator(".lb-you").count() == 1 and page.locator(".lb-list").first.locator(".lb-you").count() == 1)
    check("the photo fills the avatar tile (same size as the initials tile)", page.evaluate("""() => { const t = document.querySelector('.lb-list .lb-avatar'); const i = document.querySelector('.lb-avatar img'); if (!i) return false; const a = t.getBoundingClientRect(), b = i.getBoundingClientRect(); return Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5 && a.width === 36; }"""))
    shot(page, "leaderboard-mobile")

    print("\n[C] Exam-wise Leaders")
    check("section heading", "Exam-wise Leaders" in page.inner_text("#lb-body"))
    chips = page.locator(".fl-chip[data-lb-exam]")
    check("one chip per live exam (practice not included)", chips.count() == 2, str(chips.all_inner_texts()))
    check("newest exam is selected first", chips.nth(0).get_attribute("aria-pressed") == "true" and chips.nth(1).get_attribute("aria-pressed") == "false")
    ev = page.locator("#lb-exam-view")
    erows = ev.locator(".lb-row")
    check("live1 list: 4 rows, leader first with 100%", erows.count() == 4 and erows.nth(0).locator(".lb-pct").inner_text().strip() == "100%", ev.inner_text())
    check("leader row: name, roll + score under it, 'You' by roll", erows.nth(0).locator(".lb-name small").inner_text().strip() == "Roll 0007 · 10/10" and erows.nth(0).locator(".lb-you").count() == 1)
    check("rank badges: gold / silver / bronze on top 3", [erows.nth(i).get_attribute("class") for i in range(3)] == ["lb-row lb-row--1 is-me", "lb-row lb-row--2", "lb-row lb-row--3"], str([erows.nth(i).get_attribute("class") for i in range(3)]))
    check("Rahim: photo + Roll 0001 · 9/10 (his best attempt)", erows.nth(1).locator(".lb-avatar img").count() == 1 and erows.nth(1).locator(".lb-name small").inner_text().strip() == "Roll 0001 · 9/10")
    check("note names the exam and the head-count", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫" in ev.inner_text() and "4 students took part" in ev.inner_text(), ev.inner_text())
    chips.nth(1).click()
    page.wait_for_timeout(250)
    check("tapping another chip swaps the list (2 rows: 80%, 60%)", ev.locator(".lb-row").count() == 2 and ev.locator(".lb-pct").all_inner_texts() == ["80%", "60%"], ev.inner_text())
    check("chip state follows the tap", chips.nth(1).get_attribute("aria-pressed") == "true" and chips.nth(0).get_attribute("aria-pressed") == "false" and "is-on" in chips.nth(1).get_attribute("class"))
    check("no 'You' in an exam the student has not taken", ev.locator(".lb-you").count() == 0)
    shot(page, "leaderboard-exam-wise-mobile")
    r = sorted(set(reads(page)))
    check("page reads only the 5 shared documents (no extra read for the new lists)", r == sorted(["users/stu1", "examIndex/main", "homeFeed/main", "userStats/stu1", "leaderboard/publicStats"]), str(r))
    check("0 Firestore writes", len(writes(page)) == 0, str(writes(page)))
    check("no horizontal overflow (390px)", no_overflow(page))
    check("student run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    print("\n[D] Smallest phone (320px) and desktop")
    for name, vp in (("320px", {"width": 320, "height": 640}), ("desktop", VIEWPORTS["desktop"])):
        errors = []
        ctx = make_context(browser, vp, seed=db_full, user="stu1")
        install_clock(ctx)
        photo_routes(ctx)
        page = new_page(ctx, errors)
        go(page, "#/leaderboard")
        page.wait_for_selector("#lb-exam-view .lb-row", timeout=9000)
        page.wait_for_timeout(400)
        check(f"{name}: fits the screen", no_overflow(page))
        check(f"{name}: names, roll and photo visible; chips scroll inside themselves", page.locator(".lb-list").first.locator(".lb-name small").first.is_visible() and page.locator(".fl-chips").evaluate("el => getComputedStyle(el).overflowX") == "auto")
        check(f"{name}: no JS errors", not errors, "; ".join(errors[:3]))
        shot(page, f"leaderboard-{name}")
        ctx.close()

    # ------------------------------------------------------------------ E. Privacy
    print("\n[E] Admin privacy choice still rules")
    db_first, errs = admin_publishes(browser, "first")
    p1 = db_first["leaderboard/publicStats"]
    check("first-name mode: names shortened, no roll, no photo anywhere", [t["n"] for t in p1["top"]] == ["Abdullah R.", "Rahim U.", "Nusrat J.", "Karim H."]
          and not any(("r" in t or "ph" in t) for t in p1["top"]) and not any(("r" in t or "ph" in t) for x in p1["exams"] for t in x["top"]), str(p1)[:300])
    check("first-name mode: exam-wise names shortened too", [t["n"] for t in p1["exams"][0]["top"]] == ["Abdullah R.", "Rahim U.", "Nusrat J.", "Karim H."], str(p1["exams"][0]["top"]))
    db_hidden, errs2 = admin_publishes(browser, "hidden")
    p2 = db_hidden["leaderboard/publicStats"]
    check("hidden mode: nothing identifying published (no names, no exam lists)", p2["top"] == [] and p2["exams"] == [] and len(p2["percents"]) == 4, str(p2)[:300])
    check("privacy runs: no JS errors", not errs and not errs2, "; ".join((errs + errs2)[:3]))

    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], seed=db_first, user="stu1")
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/leaderboard")
    page.wait_for_selector("#lb-exam-view .lb-row", timeout=9000)
    t = page.inner_text("#lb-body")
    check("student view in first-name mode: short names, no 'Roll', no photos", "Rahim U." in t and "Roll" not in t and page.locator(".lb-avatar img").count() == 0, t[:200])
    ctx.close()

    # ------------------------------------------------------------------ F. Older document (nothing re-published yet)
    print("\n[F] Before the admin re-publishes: the page looks exactly as it did")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], seed=fixtures.build(NOW), user="stu1")
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/leaderboard")
    page.wait_for_selector(".lb-row", timeout=9000)
    page.wait_for_timeout(300)
    check("old document: 5 rows, initials tiles, '5 live exams' line, no exam-wise section", page.locator(".lb-row").count() == 5 and page.locator(".lb-avatar img").count() == 0
          and page.locator(".lb-name small").first.inner_text().strip() == "5 live exams" and "Exam-wise" not in page.inner_text("#lb-body"), page.inner_text("#lb-body")[:200])
    check("old document: no JS errors", not errors, "; ".join(errors[:3]))
    ctx.close()


    # ------------------------------------------------------------------ G. Every word of the page is English
    print("\n[G] The page's own text is English in every state (exam titles and names stay exactly as admins / students typed them)")
    BN = re.compile(r"[\u0980-\u09FF]")

    def open_page(seed, wait="#lb-body .lb-row, #lb-body .ui-state, #lb-body .lbp-me"):
        errs = []
        c = make_context(browser, VIEWPORTS["mobile"], seed=seed, user="stu1")
        install_clock(c)
        pg = new_page(c, errs)
        go(pg, "#/leaderboard")
        pg.wait_for_selector(wait, timeout=9000)
        pg.wait_for_timeout(500)
        return c, pg, errs

    def content(pg):
        return pg.inner_text("#generic-page-content")

    def bengali(text):
        return "".join(BN.findall(text))[:40]

    # G1 · normal page with data (English exam title)
    db_en, errs_a = admin_publishes(browser, exam_title="Air Force Model Test 05")
    c, pg, e1 = open_page(db_en, wait="#lb-exam-view .lb-row")
    t = content(pg)
    check("G1 data page: no Bengali characters anywhere in the page content", not BN.search(t), bengali(t))
    check("G1 description + exam-wise note + refresh note are English", all(s in t for s in (
        "Ranked by the average of each student's best result in every live exam.",
        "Air Force Model Test 05 \u2014 4 students took part. Each student's best attempt counts: higher score first, then faster time.",
        "The list is updated regularly by the admin, so recent exam results may take a little while to appear.")), t[-460:])
    check("G1 the labels that were already English are untouched", all(s in t for s in ("Your rank", "Your average", "Live exams", "Top Performers", "Exam-wise Leaders", "You", "Last updated")))
    check("G1 no JS errors", not errs_a and not e1, "; ".join((errs_a + e1)[:3]))
    c.close()

    # G2 · the student has no live exam yet, the list exists → "no rank yet" card
    seed = fixtures.build(NOW)
    seed["userStats/stu1"]["exams"] = {}
    c, pg, e2 = open_page(seed)
    t = content(pg)
    check("G2 'no rank yet' card is English", "You don't have a rank yet" in t and "Take at least one live exam to get ranked." in t and not BN.search(t), t[:300])
    check("G2 no JS errors", not e2, "; ".join(e2[:3]))
    c.close()

    # G3 · the admin has not published the top list
    seed = fixtures.build(NOW)
    seed["leaderboard/publicStats"]["top"] = []
    c, pg, e3 = open_page(seed)
    t = content(pg)
    check("G3 empty top list message is English", "The top performers list hasn't been published yet." in t and not BN.search(t), t[:300])
    check("G3 no JS errors", not e3, "; ".join(e3[:3]))
    c.close()

    # G4 · nothing at all yet
    seed = fixtures.build(NOW)
    seed.pop("leaderboard/publicStats")
    seed["userStats/stu1"]["exams"] = {}
    c, pg, e4 = open_page(seed)
    t = content(pg)
    check("G4 'not ready yet' state + button are English", "The leaderboard isn't ready yet. Take a live exam and your position will appear here." in t and pg.locator("#lb-body .ui-state a").inner_text().strip() == "View live exams" and not BN.search(t), t[:300])
    check("G4 button still goes to the live exams", pg.locator("#lb-body .ui-state a").get_attribute("href") == "#/exams?type=live")
    check("G4 no JS errors", not e4, "; ".join(e4[:3]))
    c.close()

    # G5 · the page cannot load (corrupt top list) → error block, English text and button, and it retries
    seed = fixtures.build(NOW)
    seed["leaderboard/publicStats"]["top"] = [None]
    c, pg, e5 = open_page(seed, wait="#lb-body .ui-state--error")
    t = content(pg)
    check("G5 error block text + 'Try again' button are English", "Couldn't load the leaderboard. Please try again." in t and pg.locator("#lb-body [data-retry]").inner_text().strip() == "Try again" and not BN.search(t), t[:300])
    pg.click("#lb-body [data-retry]")
    pg.wait_for_selector("#lb-body .ui-state--error", timeout=6000)
    check("G5 retry works and stays English", "Try again" in content(pg) and not BN.search(content(pg)))
    # the shared helper keeps its original Bengali wording for every other page (only this page passes its own English text)
    dflt = pg.evaluate("import('/js/home-ui.js').then((m) => [m.errorBlock('x'), m.errorBlock('x', 'Oops', 'Retry now')])")
    check("shared errorBlock default unchanged for other pages; custom text/label supported", "আবার চেষ্টা করুন" in dflt[0] and "তথ্য লোড করা যায়নি" in dflt[0] and "Oops" in dflt[1] and "Retry now" in dflt[1] and "আবার চেষ্টা করুন" not in dflt[1])
    check("G5 no JS errors", not e5, "; ".join(e5[:3]))
    c.close()

    browser.close()

sys.exit(finish())
