"""End-to-end checks for "my exam survived a refresh" (js/exam-session*.js) against the in-memory Firestore.
   python3 tests/e2e/run_resume.py [--shots]      → exit code 0 = all checks passed
"""
import sys, os, json, datetime
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
from playwright.sync_api import sync_playwright

KEY = "tvexam:s1:stu1:live1"
LOCK = "tvexam:s1lock:stu1:live1"


def stored(page, key=KEY):
    raw = page.evaluate("(k) => localStorage.getItem(k)", key)
    return json.loads(raw) if raw else None


def start_exam(page, exam="live1"):
    go(page, f"#/exam?id={exam}")
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)


def pick(page, i):
    page.locator(".exs-option").nth(i).click()
    page.wait_for_timeout(120)


def jump(ctx, page, ms):
    """The wall clock (and the fake server's clock) moves `ms` forward — as if the student had been away that long."""
    H.advance[0] += ms
    ctx.clock.fast_forward(ms)


def away(ctx, page, ms, back="#/exam?id=live1"):
    """The student closes the app (the page — and its timers — are gone), `ms` pass, then the app is opened again."""
    page.goto("about:blank")
    jump(ctx, page, ms)
    go(page, back)


def reload_page(page):
    page.reload()
    page.wait_for_load_state("domcontentloaded")


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ 1. Save → refresh → resume
    print("\n[1] An attempt is saved while it runs, and a refresh offers to carry on")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    s0 = stored(page)
    check("a saved attempt exists from the very first moment (deadline = start + 30 min, attempt id, whole pool)",
          s0 and s0["phase"] == "active" and s0["deadline"] - s0["startedAt"] == 30 * 60 * 1000 and s0["attemptId"] and len(s0["questions"]) == 3, str(s0)[:200])
    pick(page, 0)                                   # q1 → A (right)
    page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 0)                                   # q2 → A (wrong)
    s1 = stored(page)
    check("every answer is written straight away", s1["answers"] == {"q1": 0, "q2": 0} and s1["locked"] == ["q1", "q2"] and s1["index"] == 1, str(s1)[:240])
    check("the saved copy never touches Firestore: exactly one write so far (the 'started' counter)", [w["path"] for w in writes(page)] == ["examSessions/stu1_live1"], str(writes(page)))
    reads_before = len(reads(page))
    attempt_id = s1["attemptId"]

    jump(ctx, page, 90 * 1000)                      # a minute and a half pass …
    reload_page(page)                               # … and the page is refreshed (the 'leave site?' prompt is not shown by headless Chromium)
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    gate = page.inner_text(".rs-card")
    check("the resume screen replaces the rules page: title, exam name, answered 2 of 3", "আপনার পরীক্ষা চলছে" in gate and "বাংলাদেশ বিমান বাহিনী" in gate and "২/৩" in gate, gate[:200])
    left = page.inner_text("[data-rs-clock]")
    mins, secs = [int(x) for x in left.split(":")]
    check("the clock kept running while the page was away (≈ 28:30 left, not a fresh 30:00)", 27 * 60 + 50 <= mins * 60 + secs <= 28 * 60 + 35, left)
    shot(page, "resume-gate-mobile")
    check("resume screen fits a phone", no_overflow(page))

    page.locator('[data-rs="primary"]').click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    check("back on question 2 with the answer still locked", "প্রশ্ন 2 / 3" in page.inner_text("#question-area") and page.locator(".exs-option.is-selected").count() == 1 and page.locator(".exs-options.is-locked").count() == 1, page.inner_text("#question-area")[:120])
    page.locator("#q-prev").click(); page.wait_for_timeout(120)
    check("question 1 kept its answer too (A, locked)", page.locator(".exs-option").nth(0).get_attribute("class").count("is-selected") == 1 and page.locator(".exs-options.is-locked").count() == 1)
    timer = page.inner_text("#exam-timer")
    check("the exam timer continues from the saved deadline", timer.strip().startswith("28:") or timer.strip().startswith("29:"), timer)
    check("resuming costs nothing extra: the questions are NOT read again, no new 'started' write",
          not any(r.startswith(("examBundles", "exams/")) for r in reads(page)) and not any(w["path"].startswith("examSessions") for w in writes(page)),
          f"reads={reads(page)} writes={writes(page)}")
    s2 = stored(page)
    check("the same attempt id and the same deadline carry on (no extra time)", s2["attemptId"] == attempt_id and s2["deadline"] == s1["deadline"], str(s2)[:120])
    check("a toast says the answers are back", "ফিরিয়ে আনা হয়েছে" in page.inner_text("#toast-root"))

    page.locator("#q-next").click(); page.wait_for_timeout(120)
    page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1)                                   # q3 → B ("Apple", right)
    page.locator("#q-submit").click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1200)
    res = page.evaluate("window.__MOCK__.dump()")
    saved = res.get("results/stu1_live1")
    check("result stored once, with the attempt id that was minted at the start",
          saved and len(saved["attempts"]) == 1 and saved["attempts"][0]["id"] == attempt_id and saved["correctCount"] == 2 and saved["wrongCount"] == 1, str(saved)[:260])
    check("once stored, nothing is left on the device", stored(page) is None and page.evaluate("(k) => localStorage.getItem(k)", LOCK) is None)
    check("resume run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 2. Banner on every page
    print("\n[2] A waiting attempt shows as a bar on every page, and the bar leads back")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    pick(page, 0)
    reload_page(page)
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    go(page, "#/home")
    page.wait_for_selector(".rsb", timeout=9000)
    bar = page.inner_text(".rsb")
    check("home shows 'চলমান পরীক্ষা' with the exam name and the time left", "চলমান পরীক্ষা" in bar and "বাংলাদেশ বিমান বাহিনী" in bar and ":" in page.inner_text("[data-rsb-clock]"), bar)
    shot(page, "resume-banner-mobile", full=False)
    check("the bar fits a phone", no_overflow(page))
    c1 = page.inner_text("[data-rsb-clock]")
    page.wait_for_timeout(2200)
    check("its clock ticks", page.inner_text("[data-rsb-clock]") != c1, f"{c1} → {page.inner_text('[data-rsb-clock]')}")
    page.locator(".rsb-go").click()
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    check("on the exam's own page the bar steps aside (the resume screen takes over)", page.locator(".rsb").count() == 0)
    go(page, "#/schedule")
    page.wait_for_selector(".rsb", timeout=9000)
    check("…and is back on another page", page.locator(".rsb").count() == 1)
    ctx.close()
    ctx = make_context(browser, VIEWPORTS["mobile"], user=None)
    install_clock(ctx)
    page = new_page(ctx, [])
    go(page, "#/login")
    page.wait_for_selector("#login-form", timeout=8000)
    check("signed-out visitor: no bar (login page)", page.locator(".rsb").count() == 0)
    ctx.close()

    # ------------------------------------------------------------------ 3. Time ran out while away
    print("\n[3] Time ran out while the student was away → the saved answers are submitted")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    pick(page, 0)                                   # q1 right
    page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1)                                   # q2 right
    attempt_id = stored(page)["attemptId"]
    away(ctx, page, 40 * 60 * 1000)                 # app closed; 40 minutes later the 30-minute exam is long over
    page.wait_for_selector(".rs-card[data-rs-state=expired]", timeout=9000)
    gate = page.inner_text(".rs-card")
    check("expired: says so, offers to submit the 2 saved answers", "সময় শেষ হয়ে গেছে" in gate and "২/৩" in gate and "উত্তর জমা দিন" in gate, gate[:200])
    go(page, "#/home")
    page.wait_for_selector(".rsb--warn", timeout=9000)
    check("the bar turns amber: 'পরীক্ষার সময় শেষ হয়েছে'", "সময় শেষ হয়েছে" in page.inner_text(".rsb") and "উত্তর জমা দিন" in page.inner_text(".rsb-go"))
    page.locator(".rsb-go").click()
    page.wait_for_selector('.rs-card[data-rs-state=expired]', timeout=9000)
    page.locator('[data-rs="primary"]').click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1200)
    res = page.evaluate("window.__MOCK__.dump()")
    saved = res.get("results/stu1_live1")
    check("the saved answers were submitted: 2 right, 1 not answered, full time used, same attempt id",
          saved and saved["correctCount"] == 2 and saved["unansweredCount"] == 1 and saved["timeTakenSeconds"] == 1800 and saved["attempts"][0]["id"] == attempt_id, str(saved)[:260])
    check("nothing left on the device", stored(page) is None)
    check("expired run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 4. An abandoned attempt with no answers is dropped, not submitted blank
    print("\n[4] No answers + time over → silently dropped (a blank result would burn an attempt)")
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, [])
    start_exam(page)
    away(ctx, page, 40 * 60 * 1000)
    page.wait_for_selector("#exs-start-confirm", timeout=9000)   # straight to the normal rules page
    check("normal rules page, no resume screen, saved copy deleted", page.locator(".rs-card").count() == 0 and stored(page) is None)
    ctx.close()

    # ------------------------------------------------------------------ 5. Result not stored (offline at the very end) → stored later, same attempt
    print("\n[5] Submitted but not stored (connection gone) → survives closing the app, stored next time")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    pick(page, 0); page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1); page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1)
    attempt_id = stored(page)["attemptId"]
    page.evaluate("window.__MOCK__.fail.push({ prefix: 'results', times: 99, code: 'unavailable' }); window.__MOCK__.fail.push({ prefix: 'examSessions', times: 99, code: 'unavailable' });")
    page.locator("#q-submit").click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(5500)                     # 3 tries with back-off all fail
    s = stored(page)
    check("the save failed, but the attempt is kept on the device, flagged 'submitted'", s and s["phase"] == "submitted" and s["answers"] == {"q1": 0, "q2": 1, "q3": 1}, str(s)[:160])
    check("nothing reached Firestore", page.evaluate("window.__MOCK__.dump()").get("results/stu1_live1") is None)
    reload_page(page)                               # the app was closed and opened again
    go(page, "#/home")
    page.wait_for_selector(".rsb--warn", timeout=9000)
    check("home: 'ফলাফল সেভ হয়নি'", "ফলাফল সেভ হয়নি" in page.inner_text(".rsb"), page.inner_text(".rsb"))
    page.locator(".rsb-go").click()
    page.wait_for_selector('.rs-card[data-rs-state=unsaved]', timeout=9000)
    check("the screen explains it and offers to store it", "ফলাফল সেভ হয়নি" in page.inner_text(".rs-card") and "ফলাফল সেভ করুন" in page.inner_text('[data-rs="primary"]'))
    page.locator('[data-rs="primary"]').click()
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1500)
    res = page.evaluate("window.__MOCK__.dump()")
    saved = res.get("results/stu1_live1")
    check("stored now: 3 right, attempt id unchanged (so a result that DID reach the server earlier can never be doubled)",
          saved and saved["correctCount"] == 3 and len(saved["attempts"]) == 1 and saved["attempts"][0]["id"] == attempt_id, str(saved)[:240])
    check("device is clean again", stored(page) is None)
    check("unsaved run: no JS errors", not [e for e in errors if "unavailable" not in e and "Could not save" not in e], "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 6. Start over / discard
    print("\n[6] 'নতুন করে শুরু' discards the saved attempt after a confirmation")
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, [])
    start_exam(page)
    pick(page, 0)
    reload_page(page)
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    page.locator('[data-rs="discard"]').click()
    page.wait_for_selector("#cf-ok", timeout=5000)
    page.locator("#cf-cancel").click()
    page.wait_for_timeout(300)
    check("'ফিরে যাই' keeps everything", page.locator(".rs-card[data-rs-state=resume]").count() == 1 and stored(page) is not None)
    page.locator('[data-rs="discard"]').click()
    page.wait_for_selector("#cf-ok", timeout=5000)
    page.locator("#cf-ok").click()
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    check("confirmed: saved copy gone, the normal rules page follows", stored(page) is None and page.locator(".rs-card").count() == 0)
    ctx.close()

    # ------------------------------------------------------------------ 7. Two tabs
    print("\n[7] The same attempt in two tabs: the second waits, nothing is overwritten")
    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    install_clock(ctx)
    tab1 = new_page(ctx, errors)
    start_exam(tab1)
    pick(tab1, 0)
    tab2 = new_page(ctx, errors)
    go(tab2, "#/exam?id=live1")
    tab2.wait_for_selector(".rs-card[data-rs-state=busy]", timeout=9000)
    check("tab 2 says the exam is running in another tab", "আরেকটি ট্যাবে চলছে" in tab2.inner_text(".rs-card"))
    check("tab 2 did not touch the saved attempt", stored(tab2)["answers"] == {"q1": 0})
    tab1.close()                                     # pagehide releases the lock at once
    tab2.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    check("when tab 1 is gone, tab 2 offers to carry on by itself", True)
    tab2.locator('[data-rs="primary"]').click()
    tab2.wait_for_selector("body.exam-taking", timeout=8000)
    check("…with the answer saved by tab 1", tab2.locator(".exs-option.is-selected").count() == 1)
    check("two-tab run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 8. Corrupt / foreign data is ignored
    print("\n[8] Damaged or foreign saved data never breaks the exam page")
    for label, raw in [("garbage text", "{not json"), ("valid JSON, wrong shape", json.dumps({"v": 1, "uid": "stu1"})), ("old version", json.dumps({"v": 99}))]:
        errors = []
        ctx = make_context(browser, VIEWPORTS["mobile"])
        install_clock(ctx)
        page = new_page(ctx, errors)
        go(page, "#/home")
        page.wait_for_selector("#hm-root:not([hidden])", timeout=8000)
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, raw])
        go(page, "#/exam?id=live1")
        page.wait_for_selector("#exs-start-confirm", timeout=9000)
        check(f"{label}: normal rules page, damaged copy removed, no JS errors", stored(page) is None and not errors, "; ".join(errors[:3]))
        ctx.close()

    # ------------------------------------------------------------------ 9. Another student's data stays out of reach
    print("\n[9] Saved attempts belong to ONE student")
    ctx = make_context(browser, VIEWPORTS["mobile"], user="stu2")
    install_clock(ctx)
    page = new_page(ctx, [])
    go(page, "#/home")
    page.wait_for_selector("#hm-root:not([hidden])", timeout=8000)
    # an attempt saved by stu1 on this same device
    page.evaluate("""async () => {
      const C = await import('/js/exam-session-core.js');
      const s = C.createSession({ uid: 'stu1', examId: 'live1', attemptId: 'x1', now: Date.now(), durationSec: 1800, exam: { id: 'live1', title: 'T' },
        questions: [{ id: 'q1', text: 'a', options: ['x', 'y'], correctIndex: 0, explanation: '' }] });
      localStorage.setItem(C.sessionKey('stu1', 'live1'), JSON.stringify(s));
    }""")
    go(page, "#/home")
    page.wait_for_timeout(800)
    check("another student on the same device sees no bar and no resume screen", page.locator(".rsb").count() == 0)
    go(page, "#/exam?id=live1")
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    check("…and starts normally", page.locator(".rs-card").count() == 0)
    ctx.close()

    # ------------------------------------------------------------------ 10. Layout 'all' + 320px
    print("\n[10] Everything fits a 320px phone")
    ctx = make_context(browser, {"width": 320, "height": 640})
    install_clock(ctx)
    page = new_page(ctx, [])
    start_exam(page)
    pick(page, 0)
    reload_page(page)
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    check("resume screen: no horizontal overflow at 320px", no_overflow(page))
    shot(page, "resume-gate-320")
    go(page, "#/home")
    page.wait_for_selector(".rsb", timeout=9000)
    check("banner: no horizontal overflow at 320px", no_overflow(page))
    shot(page, "resume-banner-320", full=False)
    ctx.close()

    # ------------------------------------------------------------------ 11. A slow save of an OLD attempt must not wipe the retake
    print("\n[11] Retake after a failed save: the old attempt is replaced on purpose, and its late 'saved' never touches the new one")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    pick(page, 0); page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1); page.locator("#q-next").click(); page.wait_for_timeout(120)
    pick(page, 1)
    first_id = stored(page)["attemptId"]
    page.evaluate("window.__MOCK__.fail.push({ prefix: 'results', times: 99, code: 'unavailable' });")
    page.locator("#q-submit").click()
    page.wait_for_selector(".exs-save-retry", timeout=12000)
    check("attempt 1 is flagged 'submitted' on the device while its save keeps failing", stored(page)["phase"] == "submitted" and stored(page)["attemptId"] == first_id)
    page.locator("#exs-retake").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    page.locator("#cf-ok").click()                   # "তবুও যাব" — the student knowingly starts over
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    check("after that warning a retake goes straight to the rules page (no second question about the old result)", page.locator(".rs-card").count() == 0)
    check("the unsaved attempt 1 was replaced on purpose", stored(page) is None)
    page.evaluate("window.__MOCK__.fail = []")
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    pick(page, 2)
    second = stored(page)
    check("attempt 2 has its own saved copy and its own attempt id", second and second["attemptId"] != first_id and second["answers"] == {"q1": 2}, str(second)[:140])
    # attempt 1's slow save finally succeeds (e.g. a reply that arrived late) — it must not remove attempt 2's copy
    page.evaluate("""async () => {
      const S = await import('/js/exam-session.js');
      S.finishSession('stu1', 'live1', %s);
    }""" % json.dumps(first_id))
    after = stored(page)
    check("a late 'saved' for attempt 1 leaves attempt 2's copy alone, and it keeps being saved", after and after["attemptId"] == second["attemptId"], str(after)[:100])
    page.locator("#q-next").click(); page.wait_for_timeout(150)
    pick(page, 3)
    check("…attempt 2 is still auto-saved afterwards", stored(page)["answers"] == {"q1": 2, "q2": 3}, str(stored(page).get("answers")))
    check("retake run: no JS errors", not [e for e in errors if "unavailable" not in e and "Could not save" not in e], "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 12. "All questions on one page" layout
    print("\n[12] Layout 'সব প্রশ্ন একসাথে' resumes too")
    errors = []
    import fixtures
    seed = fixtures.build(H.NOW)
    seed["exams/live1"]["layout"] = "all"
    ctx = make_context(browser, VIEWPORTS["mobile"], seed=seed)
    install_clock(ctx)
    page = new_page(ctx, errors)
    start_exam(page)
    page.locator(".exs-option").nth(0).click(); page.wait_for_timeout(120)     # q1 → A
    page.locator(".exs-option").nth(9).click(); page.wait_for_timeout(120)     # q3 → B
    reload_page(page)
    page.wait_for_selector(".rs-card[data-rs-state=resume]", timeout=9000)
    check("resume screen says 2 of 3 answered", "২/৩" in page.inner_text(".rs-card"))
    page.locator('[data-rs="primary"]').click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    check("all three questions are on the page again, the two answers locked", page.locator(".exs-question-card").count() == 3 and page.locator(".exs-option.is-selected").count() == 2, f"{page.locator('.exs-question-card').count()} cards")
    page.locator("#q-submit").click()
    page.wait_for_selector("#cf-ok", timeout=4000)
    page.locator("#cf-ok").click()                   # one question left unanswered → the usual confirmation
    page.wait_for_selector("#exs-retake", timeout=9000)
    page.wait_for_timeout(1200)
    saved = page.evaluate("window.__MOCK__.dump()").get("results/stu1_live1")
    check("result: 2 right, 1 unanswered", saved and saved["correctCount"] == 2 and saved["unansweredCount"] == 1, str(saved)[:200])
    check("'all' layout run: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ------------------------------------------------------------------ 13. Changing the phone's clock does not change the time left
    print("\n[13] The phone's clock is changed while the app is closed → the time left still follows the SERVER")
    ctx = make_context(browser, VIEWPORTS["mobile"])
    install_clock(ctx)
    page = new_page(ctx, [])
    start_exam(page)
    pick(page, 0)
    page.goto("about:blank")
    ctx.clock.set_system_time(datetime.datetime.fromtimestamp((H.NOW + 3 * 3600 * 1000) / 1000, tz=datetime.timezone.utc))  # device clock +3 h; the server's did not move
    go(page, "#/exam?id=live1")
    page.wait_for_selector(".rs-card", timeout=9000)
    state_attr = page.get_attribute(".rs-card", "data-rs-state")
    left = page.inner_text("[data-rs-clock]") if state_attr == "resume" else state_attr
    check("clock +3 h on the device: still 'resume', ≈ 30 minutes left (not expired, not 3 h)", state_attr == "resume" and left.startswith(("29:", "30:")), f"{state_attr} {left}")
    ctx.close()

    browser.close()

sys.exit(finish())
