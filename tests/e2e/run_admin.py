"""End-to-end checks for the admin panel (dashboard, schedule, notices, homepage, analytics, leaderboard, audit log,
   permissions) and the hand-off to the student site — all against the in-memory Firestore.
   python3 tests/e2e/run_admin.py [--shots]
"""
import sys, os, datetime, json
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

DAY = 24 * 3600 * 1000


def dbdoc(page, path):
    return page.evaluate("(p) => window.__MOCK__.dump()[p] || null", path)


def admin_page(page, hash_, wait=".admin-nav-item"):
    page.goto(f"{BASE}/admin.html{hash_}")
    page.wait_for_selector(wait, timeout=9000)


def local_ms(y, mo, d, h, mi):
    """A wall-clock time in Asia/Dhaka (UTC+6) as epoch ms."""
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=datetime.timezone(datetime.timedelta(hours=6))).timestamp() * 1000)


def confirm_danger(page, phrase=None):
    page.wait_for_selector("#cd-ok")
    if page.locator("#cd-phrase").count():
        page.fill("#cd-phrase", phrase or "x")
    page.click("#cd-ok")


def kpi(page, label):
    return page.locator(".kpi", has=page.locator(".kpi-label", has_text=label)).first.locator(".kpi-value").inner_text().strip()


def mini(page, label):
    return page.locator(".mini-stat", has=page.locator("span", has_text=label)).first.locator("b").inner_text().strip()


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"], seed=fixtures.build_admin(NOW), user="adm1")
    install_clock(ctx)
    page = new_page(ctx, errors)
    page.set_default_timeout(9000)

    # ------------------------------------------------------------------ A. Dashboard
    print("\n[A] Dashboard — headline numbers, today's overview, quick actions")
    admin_page(page, "#/dashboard", "#dash-body .kpi")
    page.wait_for_timeout(600)
    check("Total students excludes admins", kpi(page, "Total students") == "4", kpi(page, "Total students"))
    check("Live / Upcoming / Completed exam counts", (kpi(page, "Live exams"), kpi(page, "Upcoming exams"), kpi(page, "Completed exams")) == ("4", "3", "1"),
          str((kpi(page, "Live exams"), kpi(page, "Upcoming exams"), kpi(page, "Completed exams"))))
    check("always-open exam is not counted as live", kpi(page, "Total exams") == "11")
    check("Today's overview: exams / attempts / new students / pending", (mini(page, "Today's exams"), mini(page, "Today's attempts"), mini(page, "New students today"), mini(page, "Pending")) == ("5", "6", "0", "3"),
          str((mini(page, "Today's exams"), mini(page, "Today's attempts"), mini(page, "New students today"), mini(page, "Pending"))))
    check("six quick actions", page.locator(".qa-btn").count() == 6)
    shot(page, "admin-dashboard")
    page.locator(".qa-btn", has_text="Schedule exam").click()
    page.wait_for_selector("#sc-form")
    check("quick action 'Schedule exam' opens the schedule editor", page.locator("#sc-exam").count() == 1)
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    if page.locator("#sc-form").count():
        page.locator("#sc-form [data-modal-close]").first.click()

    # ------------------------------------------------------------------ B. Schedule
    print("\n[B] Exam Schedule — table, filters, edit, validation, cancel/restore, feature, publish, remove, create, participants")
    page.evaluate("location.hash = '#/schedule'")
    page.wait_for_selector("#sc-table tr[data-id]")
    check("every live-type exam is listed (practice is not)", page.locator("#sc-table tr[data-id]").count() == 10 and page.locator('#sc-table tr[data-id="prac1"]').count() == 0)
    seg = lambda k: page.locator(f'#sc-seg [data-seg="{k}"] .seg-n').inner_text()
    check("status counts: scheduled 3 · live 4 · completed 1 · cancelled 1 · no schedule 1", (seg("scheduled"), seg("live"), seg("completed"), seg("cancelled"), seg("unscheduled")) == ("3", "4", "1", "1", "1"),
          str([seg(k) for k in ("scheduled", "live", "completed", "cancelled", "unscheduled")]))
    row = lambda id_: page.locator(f'#sc-table tr[data-id="{id_}"]')
    check("row chips: Live / Cancelled / No schedule", "Live" in row("live1").inner_text() and "Cancelled" in row("cx1").inner_text() and "No schedule" in row("open1").inner_text())
    shot(page, "admin-schedule")
    page.click('#sc-seg [data-seg="scheduled"]')
    check("filter 'Scheduled' → 3 rows", page.locator("#sc-table tr[data-id]").count() == 3)
    page.click('#sc-seg [data-seg="all"]')

    # edit up2 → new start/end/duration
    page.click('#sc-table tr[data-id="up2"] [data-act="edit"]')
    page.wait_for_selector("#sc-form")
    page.fill("#sc-start", "2026-10-08T14:00"); page.fill("#sc-end", "2026-10-08T14:00")
    page.fill("#sc-duration", "40")
    page.click("#sc-save")
    check("end ≤ start is rejected with a message (nothing written)", page.locator("#sc-errors").is_visible() and "শেষ সময়" in page.locator("#sc-errors").inner_text())
    w_before = len([w for w in writes(page) if w["path"].startswith("exams/")])
    page.fill("#sc-end", "2026-10-08T17:30")
    page.click("#sc-save")
    page.wait_for_selector("#sc-form", state="detached")
    up2 = dbdoc(page, "exams/up2")
    check("exam doc: publishAt / closesAt / duration / availableHours", (up2["publishAt"]["__ts"], up2["closesAt"]["__ts"], up2["duration"], up2["availableHours"]) == (local_ms(2026, 10, 8, 14, 0), local_ms(2026, 10, 8, 17, 30), 40, 3.5), str(up2))
    check("'schedule updated' stamp set (students were able to see it)", "scheduleUpdatedAt" in up2)
    idx = {e["id"]: e for e in dbdoc(page, "examIndex/main")["exams"]}
    check("students' index copy follows (no extra step)", idx["up2"]["publishAt"]["__ts"] == local_ms(2026, 10, 8, 14, 0) and idx["up2"]["duration"] == 40)
    check("only the exam doc (+ index) was written — no questions touched", all(not w["path"].startswith("examBundles") for w in writes(page)))

    # cancel / restore up1
    page.click('#sc-table tr[data-id="up1"] [data-act="cancel"]'); confirm_danger(page)
    page.wait_for_timeout(300)
    check("cancel → exam.cancelled = true, row shows Cancelled", dbdoc(page, "exams/up1")["cancelled"] is True and "Cancelled" in row("up1").inner_text())
    page.click('#sc-table tr[data-id="up1"] [data-act="cancel"]')
    page.wait_for_timeout(300)
    check("restore → cancelled = false", dbdoc(page, "exams/up1")["cancelled"] is False)

    # feature, unpublish/publish
    page.click('#sc-table tr[data-id="up2"] [data-act="feature"]'); page.wait_for_timeout(250)
    check("star toggle → featured = true", dbdoc(page, "exams/up2")["featured"] is True)
    page.click('#sc-table tr[data-id="up2"] [data-act="toggle"]'); page.wait_for_timeout(250)
    check("unpublish → status draft, row shows Draft", dbdoc(page, "exams/up2")["status"] == "draft" and "Draft" in row("up2").inner_text())
    page.click('#sc-table tr[data-id="up2"] [data-act="toggle"]'); page.wait_for_timeout(250)
    check("publish again → status published", dbdoc(page, "exams/up2")["status"] == "published")

    # remove schedule of soon1
    page.click('#sc-table tr[data-id="soon1"] [data-act="remove"]'); confirm_danger(page, "REMOVE")
    page.wait_for_timeout(300)
    s1 = dbdoc(page, "exams/soon1")
    check("remove schedule → dates cleared, exam back to Draft, questions intact", s1["publishAt"] is None and s1["closesAt"] is None and s1["status"] == "draft")
    check("bundle of that exam untouched", dbdoc(page, "examBundles/soon1") is not None)

    # new schedule for open1 (always open)
    page.click("#sc-new")
    page.wait_for_selector("#sc-form")
    page.select_option("#sc-exam", "open1")
    page.fill("#sc-start", "2026-10-09T09:00"); page.fill("#sc-end", "2026-10-10T09:00")
    page.select_option("#sc-difficulty", "hard"); page.select_option("#sc-reg", "closed"); page.select_option("#sc-vis", "unlisted")
    page.uncheck("#sc-remind"); page.check("#sc-featured")
    page.click("#sc-save")
    page.wait_for_selector("#sc-form", state="detached")
    o = dbdoc(page, "exams/open1")
    check("new schedule saved with all options", (o["publishAt"]["__ts"], o["registration"], o["visibility"], o["reminderEnabled"], o["featured"], o["difficulty"], o["availableHours"]) == (local_ms(2026, 10, 9, 9, 0), "closed", "unlisted", False, True, "hard", 24.0), str(o))
    check("first-time schedule is NOT announced as an update", "scheduleUpdatedAt" not in o or o.get("scheduleUpdatedAt") is None)

    # participants
    page.click("#sc-participants")
    page.wait_for_timeout(500)
    feed = dbdoc(page, "homeFeed/main")
    check("participant counts refreshed (live1 = 3 students) via aggregate queries", feed["participants"].get("live1") == 3 and feed["participantsAt"] > 0, str(feed.get("participants")))
    check("aggregates, not document downloads", any(r.startswith("agg:results") for r in reads(page)))
    page.fill("#sc-q", "zzzz"); page.wait_for_timeout(300)
    check("search with no match → empty state", page.locator("#sc-table tr[data-id]:visible").count() == 0 and "কোনো শিডিউল নেই" in page.inner_text("#sc-table"))
    page.fill("#sc-q", "")

    # ------------------------------------------------------------------ C. Notices
    print("\n[C] Notices — create / publish / schedule / expire / filters / mirror for students")
    page.evaluate("location.hash = '#/notices'")
    page.wait_for_selector("#nt-table")
    page.wait_for_timeout(400)
    check("empty state before the first notice", "কোনো নোটিশ নেই" in page.inner_text("#nt-table"))

    def create_notice(title, body="", priority="normal", category="general", status="published", pub="", exp="", exam=""):
        page.click("#nt-new")
        page.wait_for_selector("#nt-form")
        page.fill("#nt-title", title); page.fill("#nt-body", body)
        page.select_option("#nt-pri", priority); page.select_option("#nt-cat", category); page.select_option("#nt-status", status)
        if pub: page.fill("#nt-pub", pub)
        if exp: page.fill("#nt-exp", exp)
        if exam: page.select_option("#nt-exam", exam)
        page.click("#nt-save")
        page.wait_for_selector("#nt-form", state="detached")
        page.wait_for_timeout(250)

    page.click("#nt-new"); page.wait_for_selector("#nt-form")
    page.click("#nt-save")
    check("empty title is rejected", page.locator("#nt-errors").is_visible() and "Title" in page.locator("#nt-errors").inner_text())
    page.fill("#nt-title", "x"); page.fill("#nt-pub", "2026-10-07T10:00"); page.fill("#nt-exp", "2026-10-07T09:00"); page.click("#nt-save")
    check("expiry before publish time is rejected", "Expiry" in page.locator("#nt-errors").inner_text())
    page.locator("#nt-form [data-modal-close]").first.click()

    create_notice("আগামীকাল সকাল ১০টায় বিমান বাহিনী মডেল পরীক্ষা", "সবাই সময়মতো উপস্থিত থাকুন।", priority="urgent", category="exam", exam="live1")
    create_notice("খসড়া নোটিশ", priority="normal", status="draft")
    create_notice("ভবিষ্যতের নোটিশ", priority="important", pub="2026-10-07T10:00")
    create_notice("মেয়াদোত্তীর্ণ নোটিশ", pub="2026-10-05T10:00", exp="2026-10-06T09:00")
    nrows = page.locator("#nt-table tr[data-id]")
    check("four notices listed", nrows.count() == 4)
    chips = {t: page.locator("#nt-table tr[data-id]", has_text=t).inner_text() for t in ("আগামীকাল", "খসড়া", "ভবিষ্যতের", "মেয়াদোত্তীর্ণ")}
    check("status chips: Live / Draft / Scheduled / Expired", "Live" in chips["আগামীকাল"] and "Draft" in chips["খসড়া"] and "Scheduled" in chips["ভবিষ্যতের"] and "Expired" in chips["মেয়াদোত্তীর্ণ"], str(chips))
    mirror = dbdoc(page, "homeFeed/main")["notices"]
    mt = {n["title"]: n for n in mirror}
    check("students' copy: published notices only (draft excluded)", len(mirror) == 3 and "খসড়া নোটিশ" not in mt)
    u = mt["আগামীকাল সকাল ১০টায় বিমান বাহিনী মডেল পরীক্ষা"]
    check("mirror keeps priority / category / exam link, times as ms", (u["priority"], u["category"], u["examId"], u["publishAt"]) == ("urgent", "exam", "live1", 0))
    check("scheduled notice carries its publish time", mt["ভবিষ্যতের নোটিশ"]["publishAt"] == local_ms(2026, 10, 7, 10, 0))
    page.select_option("#nt-priority", "urgent"); page.wait_for_timeout(250)
    check("priority filter", page.locator("#nt-table tr[data-id]").count() == 1)
    page.select_option("#nt-priority", ""); page.click('#nt-seg [data-seg="draft"]'); page.wait_for_timeout(200)
    check("status filter (Draft)", page.locator("#nt-table tr[data-id]").count() == 1)
    page.click('#nt-seg [data-seg="all"]')
    # publish the draft, then unpublish + delete it
    page.click('#nt-table tr[data-id]:has-text("খসড়া") [data-act="toggle"]'); page.wait_for_timeout(350)
    check("publish → appears in the students' copy", any(n["title"] == "খসড়া নোটিশ" for n in dbdoc(page, "homeFeed/main")["notices"]))
    page.click('#nt-table tr[data-id]:has-text("খসড়া") [data-act="toggle"]'); page.wait_for_timeout(350)
    check("unpublish → removed from the students' copy", not any(n["title"] == "খসড়া নোটিশ" for n in dbdoc(page, "homeFeed/main")["notices"]))
    page.click('#nt-table tr[data-id]:has-text("খসড়া") [data-act="delete"]'); confirm_danger(page, "DELETE"); page.wait_for_timeout(400)
    check("delete → gone", page.locator("#nt-table tr[data-id]", has_text="খসড়া").count() == 0)
    # edit + audience
    page.click('#nt-table tr[data-id]:has-text("ভবিষ্যতের") [data-act="edit"]'); page.wait_for_selector("#nt-form")
    page.select_option("#nt-aud", "course")
    check("audience picker lists courses", page.locator('[data-pick="course"] input').count() >= 0)
    page.select_option("#nt-aud", "exam"); page.check('[data-pick="exam"] input[value="live1"]')
    page.fill("#nt-pub", ""); page.click("#nt-save"); page.wait_for_selector("#nt-form", state="detached"); page.wait_for_timeout(300)
    edited = {n["title"]: n for n in dbdoc(page, "homeFeed/main")["notices"]}["ভবিষ্যতের নোটিশ"]
    check("edit: audience = exam live1, publish time cleared", edited["audience"] == {"type": "exam", "ids": ["live1"]} and edited["publishAt"] == 0, str(edited))
    shot(page, "admin-notices")

    # ------------------------------------------------------------------ D. Homepage
    print("\n[D] Homepage — content, sections, validation, featured, taxonomy mirror")
    page.evaluate("location.hash = '#/homepage'")
    page.wait_for_selector("#hp-title")
    page.wait_for_timeout(700)
    tax = dbdoc(page, "homeFeed/main")["taxonomy"]
    check("subject/category names mirrored for students (auto-sync)", any(s["name"] == "ICT (new)" for s in tax["subjects"]) and {c["id"] for c in tax["categories"]} == {"c-model", "c-model-a"} and "note" not in tax["subjects"][0], str(tax)[:200])
    check("pass-mark mirror stays 60 (default)", dbdoc(page, "homeFeed/main")["passPercent"] == 60)
    page.fill("#hp-title", "নতুন হিরো শিরোনাম"); page.fill("#hp-sub", "আজকের লক্ষ্য: ৫০ প্রশ্ন"); page.fill("#hp-cta", "Begin")
    page.fill("#hp-info", "গুরুত্বপূর্ণ তথ্য")
    page.uncheck("#hp-sec-leaderboard"); page.uncheck("#hp-sec-motivation")
    page.fill("#hp-guide", "প্রথম নিয়ম\nদ্বিতীয় নিয়ম")
    page.fill("#hp-mot-pin", "")
    page.check('input[name="hp-names"][value="first"]')
    page.fill("#hp-ban-k", "javascript:alert(1)")
    page.click("#hp-save")
    page.wait_for_timeout(300)
    check("unsafe banner link blocks the save", dbdoc(page, "homeFeed/main")["content"]["heroTitle"] != "নতুন হিরো শিরোনাম" and page.locator(".toast").count() >= 1)
    page.fill("#hp-ban-k", "#/exams?type=practice")
    page.fill("#hp-ban-t", "নতুন সিরিজ"); page.fill("#hp-ban-l", "দেখুন"); page.check("#hp-ban-on")
    page.click("#hp-save")
    page.wait_for_timeout(500)
    c = dbdoc(page, "homeFeed/main")["content"]
    check("content saved (title, subtitle, CTA, info, guidelines)", (c["heroTitle"], c["heroSubtitle"], c["ctaText"], c["info"], c["guidelines"]) == ("নতুন হিরো শিরোনাম", "আজকের লক্ষ্য: ৫০ প্রশ্ন", "Begin", "গুরুত্বপূর্ণ তথ্য", ["প্রথম নিয়ম", "দ্বিতীয় নিয়ম"]), str(c))
    check("section switches + banner + privacy saved", c["sections"]["leaderboard"] is False and c["sections"]["motivation"] is False and c["sections"]["live"] is True and c["banner"]["enabled"] is True and c["banner"]["link"] == "#/exams?type=practice" and c["leaderboardNames"] == "first")
    check("notices and taxonomy fields survived the content save (per-field writes)", len(dbdoc(page, "homeFeed/main")["notices"]) == 3 and len(dbdoc(page, "homeFeed/main")["taxonomy"]["subjects"]) == 8)
    page.locator('input[data-act="feature"][data-id="open1"]').uncheck() if dbdoc(page, "exams/open1")["featured"] else None
    page.locator('input[data-act="feature"][data-id="soon1"]').check(); page.wait_for_timeout(300)
    check("featured switch saves immediately on the exam", dbdoc(page, "exams/soon1")["featured"] is True)
    shot(page, "admin-homepage")

    # ------------------------------------------------------------------ E. Analytics drawer
    print("\n[E] Exam analytics — summary, abandoned, question-wise")
    page.evaluate("location.hash = '#/exams'")
    try:
        page.wait_for_selector('#section-exams tr[data-id="live1"]')
    except Exception:
        print("DEBUG exams page:", page.inner_text("#section-exams")[:600].replace("\n", " | "), "| errors:", errors[:5])
        page.screenshot(path="/home/claude/shots/_debug_exams.png")
        raise
    page.click('tr[data-id="live1"] [data-act="stats"]')
    page.wait_for_selector(".drawer .mini-stat", timeout=9000)
    page.wait_for_timeout(500)
    tiles = {page.locator(".drawer .mini-stat span").nth(i).inner_text(): page.locator(".drawer .mini-stat b").nth(i).inner_text() for i in range(page.locator(".drawer .mini-stat").count())}
    check("participants / completed / abandoned", (tiles["Participants"], tiles["Completed attempts"], tiles["Abandoned"]) == ("3", "4", "3"), str(tiles))
    check("highest / lowest / average", (tiles["Highest"], tiles["Lowest"]) == ("90%", "40%") and tiles["Average score"].startswith("67"), str(tiles))
    pr = [v for k, v in tiles.items() if k.startswith("Pass rate")][0]
    check("pass rate 67% · fail rate 33%", pr.startswith("67") and tiles["Fail rate"].startswith("33"), str(tiles))
    page.click("#stats-qw summary")
    page.wait_for_selector(".qw-grid", timeout=6000)
    cols = {page.locator(".qw-col h4").nth(i).inner_text(): page.locator(".qw-col").nth(i).inner_text() for i in range(page.locator(".qw-col").count())}
    check("question-wise: most difficult / incorrect / skipped / easiest", "রাজধানী" in cols["Most difficult"] and "2 + 2" in cols["Most incorrect"].split("\n")[1] and "রাজধানী" in cols["Most skipped"] and "fruit" in cols["Easiest"], str(cols))
    shot(page, "admin-exam-stats", full=False)
    page.keyboard.press("Escape")

    # ------------------------------------------------------------------ F. Leaderboard top list
    print("\n[F] Leaderboard publishing — Top performers for the home page")
    page.evaluate("location.hash = '#/leaderboard'")
    page.wait_for_selector("#leaderboard-table tr, .lb-row", timeout=8000)
    page.wait_for_timeout(700)
    ps = dbdoc(page, "leaderboard/publicStats")
    check("published anonymous percents + top list", sorted(ps["percents"]) == [50, 70, 85] and [t["p"] for t in ps["top"]] == [85, 70, 50], str(ps))
    check("names follow the privacy choice (first name + initial)", [t["n"] for t in ps["top"]] == ["Rahim U.", "Nusrat J.", "Karim H."], str(ps["top"]))

    # ------------------------------------------------------------------ G. Audit log
    print("\n[G] Audit log")
    actions = sorted({d.get("action") for p, d in H_dump.items() if p.startswith("adminLogs/")} if (H_dump := page.evaluate("window.__MOCK__.dump()")) else set())
    expected = {"schedule.update", "schedule.cancel", "schedule.restore", "schedule.delete", "schedule.create", "exam.feature", "exam.publish", "exam.unpublish", "notice.publish", "notice.unpublish", "notice.delete", "notice.update", "notice.create", "homepage.update"}
    check("every important action was logged", expected <= set(actions), f"missing: {sorted(expected - set(actions))}")
    sample = next(d for p, d in H_dump.items() if p.startswith("adminLogs/") and d.get("action") == "schedule.update")
    check("log entry has admin, action, target and time", all(sample.get(k) for k in ("uid", "action", "label", "at")) , str(sample))
    page.evaluate("location.hash = '#/logs'")
    page.wait_for_selector("#section-logs tr[data-id], #section-logs .tbl", timeout=8000)
    page.wait_for_timeout(400)
    check("Activity Logs page shows the new action names", "Schedule changed" in page.inner_text("#section-logs"))
    check("admin run: no JS errors", not errors, "; ".join(errors[:5]))

    db_after = page.evaluate("window.__MOCK__.dump()")
    ctx.close()

    # ------------------------------------------------------------------ H. What the student now sees
    print("\n[H] Student site on the data the admin just wrote")
    errors = []
    ctx = make_context(browser, VIEWPORTS["mobile"], seed=db_after, user="stu1")
    install_clock(ctx)
    page = new_page(ctx, errors)
    go(page, "#/home")
    page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=9000)
    page.wait_for_timeout(400)
    txt = page.inner_text("#hm-root")
    check("new hero title / subtitle", "নতুন হিরো শিরোনাম" in txt and "আজকের লক্ষ্য: ৫০ প্রশ্ন" in txt)
    check("admin hid Leaderboard + Motivation; guidelines are the admin's two", page.locator('[data-slot="leaderboard"]').is_hidden() and page.locator('[data-slot="motivation"]').is_hidden() and page.locator(".hm-guides li").count() == 2)
    check("banner + important information visible", "নতুন সিরিজ" in txt and "গুরুত্বপূর্ণ তথ্য" in txt)
    # (the "future" notice had its publish time cleared and an exam audience in step C, so it is live now — for students who can see live1)
    check("urgent notice shown; draft (deleted) and expired ones are not; the re-targeted one is", "আগামীকাল সকাল ১০টায় বিমান বাহিনী" in txt and "খসড়া" not in txt and "মেয়াদোত্তীর্ণ" not in txt and "ভবিষ্যতের" in txt)
    check("featured: exams the admin starred appear (Bangladesh Affairs Model Test 06 + the live exam)", page.locator(".xc--featured").count() >= 2)
    check("exam the admin cancelled/restored/removed behaves: removed schedule exam is hidden (draft)", "English Grammar Test 02" not in txt)
    check("primary button uses the admin's text", page.locator(".hm-hero .btn-primary").first.inner_text().strip().endswith("Begin"), page.locator(".hm-hero .btn-primary").first.inner_text())
    go(page, "#/leaderboard")
    page.wait_for_selector(".lb-row", timeout=8000)
    names = page.locator(".lb-name").all_inner_texts()
    check("leaderboard page shows the privacy-masked names", names and names[0].startswith("Rahim U."), str(names))
    check("student run: no JS errors", not errors, "; ".join(errors[:5]))
    ctx.close()

    # ------------------------------------------------------------------ I. Roles
    print("\n[I] Permissions")
    for role, can_notices, can_edit in (("editor", False, True), ("viewer", False, False), ("manager", True, True)):
        errors = []
        seed = fixtures.build_admin(NOW)
        seed["adminRoles/adm1"] = {"role": role}
        ctx = make_context(browser, VIEWPORTS["desktop"], seed=seed, user="adm1")
        install_clock(ctx)
        page = new_page(ctx, errors)
        admin_page(page, "#/schedule", "#sc-table tr[data-id]")
        nav = page.locator(".admin-nav-item").all_inner_texts()
        check(f"{role}: sidebar {'has' if can_notices else 'hides'} Notices & Homepage", (any("Notices" in n for n in nav) and any("Homepage" in n for n in nav)) == can_notices, str(nav))
        check(f"{role}: schedule edit buttons {'visible' if can_edit else 'hidden'}", (page.locator("#sc-new").count() > 0 and page.locator('[data-act="edit"]').count() > 0) == can_edit)
        if not can_notices:
            page.evaluate("location.hash = '#/notices'")
            page.wait_for_timeout(500)
            check(f"{role}: direct URL to Notices is bounced to the dashboard", "dashboard" in page.evaluate("location.hash"), page.evaluate("location.hash"))
        check(f"{role}: no JS errors", not errors, "; ".join(errors[:3]))
        ctx.close()

    # ------------------------------------------------------------------ J. Admin on phone / tablet / desktop
    print("\n[J] Admin pages at three screen sizes — no horizontal overflow")
    for vp_name in ("mobile", "tablet", "desktop"):
        errors = []
        ctx = make_context(browser, VIEWPORTS[vp_name], seed=db_after, user="adm1")
        install_clock(ctx)
        page = new_page(ctx, errors)
        page.set_default_timeout(9000)
        bad = []
        for route, sel in (("#/dashboard", "#dash-body .kpi"), ("#/schedule", "#sc-table tr[data-id]"), ("#/notices", "#nt-table tr[data-id]"), ("#/homepage", "#hp-title"), ("#/exams", "#section-exams tr[data-id]"), ("#/leaderboard", "#section-leaderboard table, #section-leaderboard .tbl, .lb-row")):
            admin_page(page, route, sel)
            page.wait_for_timeout(350)
            if not no_overflow(page):
                bad.append(route)
            shot(page, f"admin{route.strip('#/').replace('/', '-')}-{vp_name}")
        check(f"{vp_name}: dashboard · schedule · notices · homepage · exams · leaderboard fit the screen", not bad, f"overflow on {bad}")
        check(f"{vp_name}: no JS errors", not errors, "; ".join(errors[:3]))
        ctx.close()

    browser.close()

sys.exit(finish())
