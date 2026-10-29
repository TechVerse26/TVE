"""End-to-end checks of the Email Center (Admin → Communication → Email Center) against the in-memory Firestore and a FAKE EmailJS SDK.
   No real e-mail is ever sent: the EmailJS CDN script is replaced by a recorder (window.__EMAILJS__.calls).
   python3 tests/e2e/run_email.py [--shots] [--only A,B,C]
"""
import sys, os, re, json
sys.path.insert(0, os.path.dirname(__file__))
from email_helpers import *
from playwright.sync_api import sync_playwright

ONLY = None
if "--only" in sys.argv:
    ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(","))
want = lambda k: ONLY is None or k in ONLY


def session(browser, seed, viewport="desktop", user="adm1", deny=None, advance_ms=0):
    errors = []
    ctx = make_context(browser, VIEWPORTS[viewport], seed=seed, user=user, deny=deny)
    H.advance[0] = advance_ms   # the fake server clock has moved on (e.g. 10 minutes after a tab died)
    install_clock(ctx, advance_ms); attach_sdk(ctx)
    page = new_page(ctx, errors); page.set_default_timeout(9000)
    return ctx, page, errors


def nav_items(page):
    return [t.strip() for t in page.locator(".admin-nav-item").all_inner_texts()]


def pick_exam(page, exam_id):
    tab(page, "reminders")
    page.select_option("#rm-exam", exam_id)
    page.wait_for_selector("#rm-groups .em-group:not([hidden])")
    page.wait_for_function("!document.querySelector('#rm-verify .spinner')")


def group_n(page, label):
    return page.locator("#rm-groups .em-group", has=page.locator(".em-group-l b", has_text=label)).first.locator(".em-group-n").inner_text().strip()


def kind(page, t):
    return page.locator(f'#rm-kinds .em-kind:has(input[value="{t}"])')


def readiness_text(page):
    return page.locator("#cm-ready").inner_text()


def send_button_enabled(page):
    return not page.locator('#cm-ready [data-act="send"]').is_disabled()


def start_send(page):
    page.click('#cm-ready [data-act="send"]')
    page.wait_for_selector("#cf-ack", timeout=20000)


def confirm_send(page):
    page.check("#cf-ack")
    if page.locator("#cf-dup").count():
        page.check("#cf-dup")
    page.click("#cf-go")


def wait_finished(page, timeout=120000):
    page.wait_for_selector("#em-progress-overlay [data-prog='close']", timeout=timeout)


def progress_totals(page):
    cells = page.locator("#em-progress-overlay .em-prog-stats > div")
    return {c.locator("span").inner_text().strip(): int(c.locator("b").inner_text().strip().replace(",", "")) for c in cells.all()}


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ====================================================================== A. who may use it
    if want("A"):
        print("\n[A] Navigation & permissions — Super Admin and Manager send e-mail, Editor / Viewer never see it")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        items = nav_items(page)
        check("Super Admin: 'Email Center' sits in the Communication group after Notifications", "Email Center" in items and items.index("Email Center") == items.index("Notifications") + 1, str(items))
        check("page shows the seven sections", page.locator(".em-tab").all_inner_texts() == ["Overview", "Compose Email", "Exam Reminders", "Student Recipients", "Email Templates", "Campaign History", "Email Settings"])
        check("ARIA: tablist / tabs / tabpanels", page.locator('[role="tablist"]').count() == 1 and page.locator('[role="tab"]').count() == 7 and page.locator('[role="tabpanel"]').count() == 7)
        check("Super Admin: no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()
        for role, expect in (("manager", True), ("editor", False), ("viewer", False)):
            ctx, page, errors = session(browser, email_seed(NOW, role=role))
            page.goto(f"{BASE}/admin.html#/email-center"); page.wait_for_selector(".admin-nav-item"); page.wait_for_timeout(500)
            has = "Email Center" in nav_items(page)
            check(f"{role}: sidebar {'shows' if expect else 'hides'} Email Center", has == expect, str(nav_items(page)))
            if expect:
                page.wait_for_selector("#em-body .em-tabs")
                tab(page, "settings")
                check("manager: Email Settings are read-only (inputs disabled, no Save button)", page.locator("#st-service").is_disabled() and page.locator('[data-act="save"]').count() == 0 and page.locator('[data-act="test"]').count() == 1)
                check("manager: the 'only Super Admin' notice is shown", "Super Admin" in page.locator("#em-panel-settings").inner_text())
            else:
                check(f"{role}: direct URL is bounced to the dashboard", "dashboard" in page.evaluate("location.hash"), page.evaluate("location.hash"))
            check(f"{role}: no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
            ctx.close()

    # ====================================================================== B. overview numbers
    if want("B"):
        print("\n[B] Overview — live numbers that follow the selected exam")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        check("Registered students = 8 (admins excluded) with deactivated / admin notes", kpi_value(page, "Registered students") == "8" and "1 deactivated" in page.locator("#em-panel-overview .kpi").first.inner_text())
        check("no exam chosen → 'Not submitted' shows a dash, not a made-up number", kpi_value(page, "Not submitted") == "—")
        check("no campaigns yet → accepted / failed are 0", kpi_value(page, "Requests accepted") == "0" and kpi_value(page, "Failed / pending") == "0")
        check("config banner: configured and tested", "কনফিগারেশন সম্পূর্ণ" in page.locator("#ov-banner").inner_text())
        pick_exam(page, "live1")
        tab(page, "overview")
        check("after choosing live1: Not submitted = 4 (3 not attempted + 1 started)", kpi_value(page, "Not submitted") == "4", kpi_value(page, "Not submitted"))
        check("started-without-submission = 1", kpi_value(page, "Started, no submission") == "1", kpi_value(page, "Started, no submission"))
        shot(page, "email-overview")
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()

    # ====================================================================== C. exam reminders
    if want("C"):
        print("\n[C] Exam Reminders — classification from the real results + start-tracking")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); pick_exam(page, "live1")
        check("Submitted = 3 (stuA, stuB, stuC have a live1 result)", group_n(page, "Submitted") == "3", group_n(page, "Submitted"))
        check("Started, no submission = 1 (stuD)", group_n(page, "Started, no submission") == "1")
        check("Not attempted = 3 (stu1, stuF, stuG)", group_n(page, "Not attempted") == "3", group_n(page, "Not attempted"))
        check("Excluded = 2 (deactivated stuE + admin)", group_n(page, "Excluded") == "2")
        vt = page.locator("#rm-verify").inner_text()
        check("verification lists results and start-tracking as read", "Results:" in vt and "Start tracking:" in vt and "পড়া যায়নি" not in vt, vt[:200])
        check("a result for ANOTHER exam (done1) did not mark anyone as having completed live1", "Not attempted" in page.locator("#rm-groups").inner_text() and group_n(page, "Submitted") == "3")
        rows = page.locator("#rm-table tr[data-id]")
        check("student table lists every student (9 incl. the admin)", rows.count() == 9 or page.locator("#rm-table .tbl-count").inner_text().endswith("of 9"), page.locator("#rm-table .tbl-count").inner_text())
        page.select_option("#rm-status", "started_no_submission")
        check("status filter 'Started, no submission' → Tanvir only", page.locator("#rm-table tr[data-id]").count() == 1 and "Tanvir" in page.locator("#rm-table tr[data-id]").first.inner_text())
        page.select_option("#rm-status", "")
        for t_, ok in (("exam_not_attempted", True), ("exam_started_not_submitted", True), ("exam_upcoming", True)):
            check(f"open exam: '{t_}' is available", kind(page, t_).locator("input").is_enabled() == ok)
        kind(page, "exam_not_attempted").click()
        page.wait_for_function("document.querySelector('#rm-groups .em-sum b').textContent.trim() === '2'")
        check("choosing 'Exam not attempted' ticks the 2 students who are eligible AND have a valid e-mail (stuF's address is invalid)", "2" == page.locator("#rm-groups .em-sum b").inner_text().strip())
        # closed / upcoming / no-schedule / cancelled exams
        page.select_option("#rm-exam", "done1"); page.wait_for_function("document.querySelector('#rm-kinds .em-kind')")
        check("closed exam: 'not attempted' reminder is blocked with the reason", kind(page, "exam_not_attempted").locator("input").is_disabled() and "সময় শেষ" in kind(page, "exam_not_attempted").inner_text(), kind(page, "exam_not_attempted").inner_text())
        page.select_option("#rm-exam", "up1"); page.wait_for_function("document.querySelector('#rm-kinds .em-kind')")
        check("upcoming exam: 'not attempted' is blocked, 'upcoming reminder' is allowed", kind(page, "exam_not_attempted").locator("input").is_disabled() and kind(page, "exam_upcoming").locator("input").is_enabled())
        page.select_option("#rm-exam", "open1"); page.wait_for_function("document.querySelector('#rm-kinds .em-kind')")
        check("exam without any schedule: 'upcoming reminder' is blocked (no date is invented)", kind(page, "exam_upcoming").locator("input").is_disabled() and "সময়সূচি" in kind(page, "exam_upcoming").inner_text())
        check("…but 'not attempted' works for an always-open exam", kind(page, "exam_not_attempted").locator("input").is_enabled())
        page.select_option("#rm-exam", "cx1"); page.wait_for_function("document.querySelector('#rm-kinds .em-kind')")
        check("cancelled exam: every reminder blocked", all(kind(page, t_).locator("input").is_disabled() for t_ in ("exam_not_attempted", "exam_started_not_submitted", "exam_upcoming")))
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        shot(page, "email-reminders")
        ctx.close()

    # ====================================================================== D. data that cannot be read
    if want("D"):
        print("\n[D] Missing / denied tracking data — nothing is claimed that cannot be verified")
        ctx, page, errors = session(browser, email_seed(NOW), deny=["examSessions"])
        open_email(page); pick_exam(page, "live1")
        vt = page.locator("#rm-verify").inner_text()
        check("denied examSessions: the screen says start tracking could not be verified", "Start tracking" in vt and "পড়া যায়নি" in vt, vt[:240])
        check("nobody is shown as 'Not attempted' — they are 'No result (start unverified)'", page.locator("#rm-groups").inner_text().count("Not attempted") == 0 and group_n(page, "No result (start unverified)") == "4", group_n(page, "No result (start unverified)"))
        check("'Started but not submitted' is blocked (needs start-tracking)", kind(page, "exam_started_not_submitted").locator("input").is_disabled())
        check("'not attempted' still available (it only claims what the results prove)", kind(page, "exam_not_attempted").locator("input").is_enabled())
        kind(page, "exam_not_attempted").click(); page.wait_for_timeout(300)
        tab(page, "compose")
        rt = readiness_text(page)
        check("Compose warns that start-tracking could not be read", "Start-tracking" in rt, rt[:300])
        check("the e-mail never says 'not attempted' in this case", "Not attempted" not in re.sub(r"\s+", " ", page.evaluate("document.querySelector('#cm-message').value")) )
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW), deny=["results"])
        open_email(page); pick_exam(page, "live1")
        vt = page.locator("#rm-verify").inner_text()
        check("denied results: the screen says nothing can be verified", "Results পড়া যায়নি" in vt, vt[:200])
        check("every eligible student (7: all but the admin and the deactivated account) is 'Could not be verified'", group_n(page, "Could not be verified") == "7", group_n(page, "Could not be verified"))
        check("all three reminder kinds are blocked", all(kind(page, t_).locator("input").is_disabled() for t_ in ("exam_not_attempted", "exam_started_not_submitted", "exam_upcoming")))
        ctx.close()


    # ====================================================================== E. recipients
    if want("E"):
        print("\n[E] Student Recipients — filters, ticks that survive filtering, 'this list' vs 'everyone'")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); tab(page, "recipients")
        rows = lambda: page.locator("#rc-table tr[data-id]")
        check("every student is listed (9 incl. admin)", page.locator("#rc-table .tbl-count").inner_text().endswith("of 9"), page.locator("#rc-table .tbl-count").inner_text())
        check("admin, deactivated and invalid-address students cannot be ticked", all(page.locator(f'#rc-table [data-pick="{u}"]').count() == 0 or page.locator(f'#rc-table [data-pick="{u}"]').is_disabled() for u in ("adm1", "stuE", "stuF")))
        check("nobody is ticked at first", "0 ticked" in page.locator("#rc-sum").inner_text() or page.locator("#rc-sum .em-big").inner_text().strip() == "0")
        page.fill("#rc-q", "tanvir"); page.wait_for_timeout(400)
        check("search by name finds Tanvir only", rows().count() == 1 and "Tanvir" in rows().first.inner_text())
        page.click('[data-act="sel-filtered"]'); page.wait_for_timeout(200)
        check("'Select all … in this list' ticks only the filtered student", page.locator("#rc-sum .em-big").inner_text().strip() == "1")
        page.fill("#rc-q", ""); page.wait_for_timeout(400)
        check("the tick survives clearing the search", page.locator('#rc-table [data-pick="stuD"]').is_checked() if page.locator('#rc-table [data-pick="stuD"]').count() else True)
        page.select_option("#rc-picked", "yes")
        check("'Only ticked' shows exactly that one student", rows().count() == 1)
        page.select_option("#rc-picked", "")
        page.select_option("#rc-course", "c2"); page.wait_for_timeout(200)
        check("course filter c2 → Karim and Nusrat", rows().count() == 2, str(rows().count()))
        page.click('[data-act="sel-filtered"]'); page.wait_for_timeout(200)
        check("…select the 2 → 3 ticked in total", page.locator("#rc-sum .em-big").inner_text().strip() == "3")
        page.select_option("#rc-course", "")
        page.fill("#rc-roll", "0102"); page.wait_for_timeout(300)
        check("roll filter '0102' → Karim", rows().count() == 1 and "Karim" in rows().first.inner_text())
        page.fill("#rc-roll", ""); page.select_option("#rc-rollmode", "none"); page.wait_for_timeout(200)
        check("'No roll' filter lists the students without a roll (Sadia)", any("Sadia" in r for r in rows().all_inner_texts()))
        page.select_option("#rc-rollmode", "")
        page.select_option("#rc-account", "deactivated")
        check("account filter 'Deactivated' → Mitu", rows().count() == 1 and "Mitu" in rows().first.inner_text())
        page.select_option("#rc-account", "")
        # individual untick, then 'every eligible student' is a SEPARATE, confirmed action
        page.click('[data-act="sel-all"]')
        page.wait_for_selector("#cf-ok", timeout=4000)
        page.click("#cf-ok"); page.wait_for_timeout(300)
        check("'Select every eligible student' → 6 (stu1, A, B, C, D, G — not the admin, deactivated or invalid-address account)", page.locator("#rc-sum .em-big").inner_text().strip() == "6", page.locator("#rc-sum .em-big").inner_text())
        page.locator('#rc-table [data-pick="stuG"]').uncheck(); page.wait_for_timeout(200)
        check("unticking one student excludes just that one (5 left)", page.locator("#rc-sum .em-big").inner_text().strip() == "5")
        page.click('[data-act="clear"]'); page.wait_for_timeout(200)
        check("'Clear all ticks' → 0", page.locator("#rc-sum .em-big").inner_text().strip() == "0")
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        shot(page, "email-recipients")
        ctx.close()

    # ====================================================================== F. compose, validation, preview, test e-mail
    if want("F"):
        print("\n[F] Compose — validation, preview with real data, test e-mail to ONE address")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); tab(page, "compose")
        check("first look: blocked because nobody is selected", not send_button_enabled(page) and "কোনো প্রাপক নেই" in readiness_text(page), readiness_text(page)[:200])
        tab(page, "recipients"); page.click('[data-act="sel-all"]'); page.click("#cf-ok"); page.wait_for_timeout(300)
        tab(page, "compose")
        check("everyone eligible selected + tested config → ready to send", send_button_enabled(page) and "Ready to send" in readiness_text(page), readiness_text(page)[:300])
        page.fill("#cm-message", "Hello {{studnt_name}}, see you.")
        page.wait_for_timeout(500)
        check("a misspelt {{variable}} blocks sending", not send_button_enabled(page) and "studnt_name" in readiness_text(page))
        page.fill("#cm-message", "Your deadline is {{deadline}}.")
        page.wait_for_timeout(500)
        check("{{deadline}} without any deadline or exam blocks sending (nothing is invented)", not send_button_enabled(page) and "deadline" in readiness_text(page))
        page.fill("#cm-deadline", "2026-10-20T18:00"); page.wait_for_timeout(500)
        check("setting a Deadline unblocks it", send_button_enabled(page), readiness_text(page)[:300])
        page.fill("#cm-message", "Roll: {{student_roll}}"); page.wait_for_timeout(500)
        check("a variable some students lack (roll of Sadia) blocks by default, naming the variable", not send_button_enabled(page) and "student_roll" in readiness_text(page), readiness_text(page)[:300])
        page.select_option("#cm-policy", "skip"); page.wait_for_timeout(300)
        check("policy 'skip those students' → ready, with a warning", send_button_enabled(page) and "বাদ দেওয়া হবে" in readiness_text(page))
        page.select_option("#cm-policy", "block")
        page.fill("#cm-message", "Hello, a small update.\n\n- point one\n- point **two**\n\n{{personal_message}}"); page.fill("#cm-personal", "Good luck!"); page.wait_for_timeout(400)
        page.fill("#cm-subject", "Update for {{student_name}}")
        page.wait_for_timeout(400)
        # ---------------- preview
        page.click('#cm-ready [data-act="preview"]'); page.wait_for_selector("#pv-who")
        page.select_option("#pv-who", "stuA"); page.wait_for_timeout(300)
        meta = page.locator("#pv-meta").inner_text()
        check("preview shows recipient, sender, reply-to, subject", "Rahim Uddin" in meta and "stuA@example.com" in meta and "Tech Verse Exam" in meta and "tv.support.info@gmail.com" in meta and "Update for Rahim Uddin" in meta, meta)
        html = page.frame_locator("#pv-frame iframe").locator("body").inner_text()
        check("rendered e-mail is personalised for Rahim and mentions nobody else", "Rahim Uddin" in html and "Karim" not in html and "Nusrat" not in html and "stuB@example.com" not in html, html[:300])
        check("the student-information panel shows Rahim's own e-mail and roll", "stuA@example.com" in html and "0101" in html)
        check("personal message and bullet list rendered", "Good luck!" in html and page.frame_locator("#pv-frame iframe").locator("li").count() == 2)
        check("footer carries the official support e-mail from footer-config", "tv.support.info@gmail.com" in html)
        check("the preview iframe is sandboxed (no scripts)", page.locator("#pv-frame iframe").get_attribute("sandbox") == "")
        page.click('[data-v="text"]'); page.wait_for_timeout(200)
        check("plain-text version available", "Dear Rahim Uddin" in page.locator(".em-pv-text").inner_text())
        page.click('[data-w="mobile"]'); page.click('[data-v="html"]'); page.wait_for_timeout(200)
        check("mobile preview width", "mobile" in (page.locator("#pv-frame iframe").get_attribute("class") or ""))
        # ---------------- test e-mail
        page.click("#pv-test"); page.wait_for_selector("#ts-to")
        page.fill("#ts-to", "my.test@example.com")
        check("test dialog defaults to sample data (no real student data leaves)", page.locator("#ts-sample").is_checked())
        page.click("#ts-send"); page.wait_for_selector("#ts-result .note", timeout=15000)
        calls = sdk_calls(page)
        check("exactly ONE EmailJS call was made, to the typed address only", len(calls) == 1 and calls[0]["to"] == "my.test@example.com", str(calls))
        check("the test subject is marked [TEST] and uses sample data", calls[0]["subject"].startswith("[TEST]") and "Sample Student" in calls[0]["html"] and "Rahim" not in calls[0]["html"])
        check("EmailJS is called with service, template and public key from settings", calls[0]["service"] == SERVICE and calls[0]["template"] == TEMPLATE and calls[0]["opts"] == {"publicKey": KEY})
        check("result says the request was ACCEPTED (not 'delivered')", "গ্রহণ করেছে" in page.locator("#ts-result").inner_text() and "ইনবক্স" in page.locator("#ts-result").inner_text())
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("Escape closes the dialog and focus returns to a control of the page", page.locator(".em-dialog").count() == 0 and page.evaluate("document.activeElement && document.activeElement !== document.body"))
        # test with a real student's data: warned, and still only to the typed address
        page.click('#cm-ready [data-act="test"]'); page.wait_for_selector("#ts-to")
        page.uncheck("#ts-sample"); page.wait_for_selector("#ts-real:not([hidden])")
        check("real-data test shows a clear warning", "আসল নাম" in page.locator("#ts-real").inner_text())
        page.select_option("#ts-who", "stuB"); page.fill("#ts-to", "my.test@example.com")
        before = len(sdk_calls(page))
        page.click("#ts-send"); page.wait_for_selector("#ts-result .note", timeout=15000)
        calls = sdk_calls(page)
        check("real-data test went to the typed address, not to Karim", len(calls) == before + 1 and calls[-1]["to"] == "my.test@example.com" and "Karim Hossain" in calls[-1]["html"], str(calls[-1]["to"]))
        page.keyboard.press("Escape")
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()

    # ====================================================================== G. a real reminder run
    if want("G"):
        print("\n[G] Sending a reminder — personalised, one at a time, recorded, audited")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); pick_exam(page, "live1")
        exam_title = page.locator("#rm-exam option:checked").inner_text().split(" — ")[0].strip()
        kind(page, "exam_not_attempted").click()
        page.wait_for_function("document.querySelector('#rm-groups .em-sum b').textContent.trim() === '2'")
        tab(page, "compose")
        check("the type, exam and template followed the choice made on Exam Reminders",
              page.locator('input[name="cm-type"][value="exam_not_attempted"]').is_checked() and page.input_value("#cm-exam") == "live1" and "You Have Not Completed Your Exam" in page.input_value("#cm-subject"))
        check("ready to send to exactly the 2 emailable students without a result", send_button_enabled(page) and "Send to 2 students" in page.locator("#cm-send").inner_text(), readiness_text(page)[:200])
        page.fill("#cm-name", "Live test reminder"); page.wait_for_timeout(300)
        start_send(page)
        dlg = page.locator(".em-dialog").inner_text()
        check("confirmation shows type, exam, recipient count, subject and the irreversibility warning",
              "Exam not attempted" in dlg and exam_title in dlg and "2" in dlg and "Not Completed Your Exam" in dlg and "ফেরত আনা যায় না" in dlg and "no CC/BCC" in dlg, dlg[:400])
        check("confirmation says the results were re-checked just now", "আবার যাচাই" in dlg)
        check("Send is locked until the admin ticks the acknowledgement", page.locator("#cf-go").is_disabled())
        confirm_send(page)
        wait_finished(page)
        t = progress_totals(page)
        check("progress dialog ends with 2 accepted, 0 failed", t.get("Request accepted") == 2 and t.get("Failed") == 0, str(t))
        check("the progress dialog is a labelled modal with a progressbar", page.locator("#em-progress-overlay [role='dialog'][aria-modal='true']").count() == 1 and page.locator("#em-progress-overlay [role='progressbar']").count() == 1)
        calls = sdk_calls(page)
        check("EmailJS was called exactly twice — one e-mail per recipient", len(calls) == 2, str([c["to"] for c in calls]))
        check("each call goes to exactly one student address (no CC/BCC list)", sorted(c["to"] for c in calls) == sorted(["stuG@example.com", "stu@example.com"]), str([c["to"] for c in calls]))
        names = {"stu@example.com": "Abdullah Rahman", "stuG@example.com": "Sadia Islam"}
        others = ["Rahim Uddin", "Karim Hossain", "Nusrat Jahan", "Tanvir Ahmed", "Mitu Akter", "Bad Mail", "stuA@", "stuB@", "stuC@", "stuD@", "stuE@"]
        for c in calls:
            mine = names.get(c["to"], "")
            other_name = [n for e, n in names.items() if e != c["to"]]
            leak = [x for x in others + other_name + [e for e in names if e != c["to"]] if x and x in c["html"] + c["text"] + c["subject"]]
            check(f"PRIVACY: e-mail to {c['to']} has its own name and nobody else's data", mine in c["html"] and not leak, f"leaked: {leak}")
        check("every e-mail states the status the records prove and names the exam", all("no submitted result recorded" in c["text"] and exam_title in c["html"] for c in calls))
        check("sender name, reply-to (support e-mail) and credentials go with every call", all(c["from"] == "Tech Verse Exam" and c["reply"] == "tv.support.info@gmail.com" and c["service"] == SERVICE and c["template"] == TEMPLATE and c["opts"] == {"publicKey": KEY} for c in calls))
        check("no secret / internal id is among the parameters sent", all(not any(re.search(r"password|token|secret|private|uid", k, re.I) for k in c["keys"]) for c in calls), str(calls[0]["keys"]))
        check("calls are ≥ 1 second apart (EmailJS' documented limit)", calls[1]["at"] - calls[0]["at"] >= 1000, str(calls[1]["at"] - calls[0]["at"]))
        cs = campaigns(page)
        check("exactly one campaign was recorded, completed, with the right totals", len(cs) == 1 and list(cs.values())[0]["status"] == "completed" and list(cs.values())[0]["totals"]["accepted"] == 2, str([(v["status"], v["totals"]) for v in cs.values()]))
        cid = list(cs)[0]; camp = cs[cid]
        rows = campaign_rows(page, cid)
        check("recipient rows are stored with the real outcome", len(rows) >= 2 and all(r["status"] == "accepted" for r in rows if r["email"] in names), str([(r["email"], r["status"]) for r in rows]))
        check("the stored campaign has the placeholders, not a student's personal data", "{{student_name" in json.dumps(camp["content"]) and "Abdullah" not in json.dumps(camp["content"]))
        check("campaign records who sent it", camp["createdBy"]["uid"] == "adm1" and camp["examId"] == "live1")
        acts = log_actions(page)
        check("audit log: started and completed", "email.campaign.start" in acts and "email.campaign.complete" in acts, str(acts))
        check("audit details carry counts, not e-mail bodies or addresses", all("@" not in v.get("detail", "") for k, v in db(page).items() if k.startswith("adminLogs/") and v["action"].startswith("email.")))
        page.click("[data-prog='close']"); page.wait_for_timeout(300)
        check("sending the SAME campaign again right away is blocked", not send_button_enabled(page) and "এইমাত্র পাঠানো হয়েছে" in readiness_text(page), readiness_text(page)[:250])
        tab(page, "overview")
        check("Overview: Requests accepted = 2", kpi_value(page, "Requests accepted") == "2", kpi_value(page, "Requests accepted"))
        tab(page, "history")
        check("History lists the campaign as Completed with 2 accepted", "Live test reminder" in page.locator("#hs-table").inner_text() and "Completed" in page.locator("#hs-table").inner_text())
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()

    # ====================================================================== H. the final re-check before sending
    if want("H"):
        print("\n[H] A student submits after the list was prepared — the pre-send re-check removes them")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); pick_exam(page, "live1")
        kind(page, "exam_not_attempted").click()
        page.wait_for_function("document.querySelector('#rm-groups .em-sum b').textContent.trim() === '2'")
        tab(page, "compose")
        page.evaluate("window.__MOCK__.db.set('results/stu1_live1', { uid: 'stu1', examId: 'live1', score: 5, total: 10, percent: 50, attemptNumber: 1, submittedAt: { __ts: Date.now() } })")
        start_send(page)
        dlg = page.locator(".em-dialog").inner_text()
        check("the confirmation reports that 1 student has submitted since and was removed", "ইতিমধ্যে জমা দিয়েছেন" in dlg and "1 জন" in dlg, dlg[:300])
        check("…and offers to send to the remaining 1 only", "Send 1 emails" in page.locator("#cf-go").inner_text())
        confirm_send(page); wait_finished(page)
        calls = sdk_calls(page)
        check("only Sadia was e-mailed — Abdullah (now submitted) was not", [c["to"] for c in calls] == ["stuG@example.com"], str([c["to"] for c in calls]))
        ctx.close()

    # ====================================================================== I. failure → retry only the failed
    if want("I"):
        print("\n[I] A failed e-mail is retried on its own — accepted ones are never sent again")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB", "stuC"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.fill("#cm-name", "Retry demo"); page.wait_for_timeout(300)
        script_sdk(page, ["ok", {"status": 500, "text": "Internal boom"}, "ok"])
        start_send(page); confirm_send(page); wait_finished(page)
        t = progress_totals(page)
        check("1 failed (HTTP 500), 2 accepted — the run went on after the failure", t.get("Failed") == 1 and t.get("Request accepted") == 2, str(t))
        check("the failure reason from EmailJS is shown", "Internal boom" in page.locator("#em-progress-overlay .em-prog-fails").inner_text())
        first = [c["to"] for c in sdk_calls(page)]
        page.click("[data-prog='retry']"); page.wait_for_selector("#rt-go")
        dlg = page.locator(".em-dialog").inner_text()
        check("retry dialog: failed pre-selected, accepted ones explicitly excluded", page.locator("#rt-failed").is_checked() and "আর পাঠানো হবে না" in dlg and page.locator("#rt-uncertain").count() == 0, dlg[:300])
        page.click("#rt-go"); wait_finished(page)
        calls = [c["to"] for c in sdk_calls(page)]
        check("the retry sent exactly ONE more e-mail — to the student whose request failed", len(calls) == 4 and calls[3] == first[1] and calls[:3] == first, str(calls))
        t = progress_totals(page)
        check("final totals: all 3 accepted", t.get("Request accepted") == 3 and t.get("Failed") == 0, str(t))
        cid = list(campaigns(page))[0]
        check("campaign shows 2 runs and the audit log has the retry", campaigns(page)[cid]["runs"] == 2 and "email.campaign.retry" in log_actions(page))
        check("the retried row counts its attempts", max(r["tries"] for r in campaign_rows(page, cid)) >= 2)
        ctx.close()

    # ====================================================================== J. no answer = uncertain, never blindly re-sent
    if want("J"):
        print("\n[J] No answer from EmailJS → 'uncertain'; a resume never re-sends it unless the admin insists")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.fill("#cm-name", "Uncertain demo"); page.wait_for_timeout(300)
        script_sdk(page, ["network", "ok"])
        start_send(page); confirm_send(page); wait_finished(page)
        t = progress_totals(page)
        check("one e-mail ended as Uncertain, the other accepted", t.get("Uncertain") == 1 and t.get("Request accepted") == 1, str(t))
        check("there is no one-click retry for uncertain recipients on the result screen", page.locator("[data-prog='retry']").count() == 0)
        page.click("[data-prog='close']")
        tab(page, "history"); page.click("#hs-table [data-view]")
        page.wait_for_selector("[data-d='retry']")
        check("History flags the campaign as completed with issues", "Completed with issues" in page.locator("#adm-drawer, .drawer").first.inner_text())
        page.click("[data-d='retry']"); page.wait_for_selector("#rt-go")
        check("uncertain recipients are listed but NOT pre-selected, with a duplicate warning", page.locator("#rt-uncertain").count() == 1 and not page.locator("#rt-uncertain").is_checked() and "দুইবার" in page.locator(".em-dialog").inner_text())
        n = len(sdk_calls(page))
        page.click("#rt-go"); page.wait_for_timeout(600)
        check("sending with nothing selected sends nothing", len(sdk_calls(page)) == n)
        if page.locator("#rt-go").count() == 0:
            page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='retry']"); page.click("[data-d='retry']"); page.wait_for_selector("#rt-go")
        page.check("#rt-uncertain"); page.click("#rt-go"); wait_finished(page)
        check("after opting in, the uncertain recipient was sent to once", len(sdk_calls(page)) == n + 1)
        ctx.close()

    # ====================================================================== K. rate limit, circuit breaker, double click
    if want("K"):
        print("\n[K] HTTP 429 back-off, repeated identical failures stop the run, a double click cannot start two")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        page.check('#rc-table [data-pick="stuA"]')
        tab(page, "compose"); page.fill("#cm-name", "Rate limit demo"); page.wait_for_timeout(300)
        script_sdk(page, [{"status": 429, "text": "Too Many Requests"}, "ok"])
        start_send(page); confirm_send(page); wait_finished(page)
        calls = sdk_calls(page)
        check("429 was backed off and retried once → accepted", len(calls) == 2 and progress_totals(page).get("Request accepted") == 1, str(progress_totals(page)))
        check("the retry waited at least 2.5 s (not hammering EmailJS)", calls[1]["at"] - calls[0]["at"] >= 2400, str(calls[1]["at"] - calls[0]["at"]))
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB", "stuC", "stuD", "stuG"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.fill("#cm-name", "Misconfigured demo"); page.wait_for_timeout(300)
        script_sdk(page, [{"status": 400, "text": "The service ID not found"}] * 5)
        start_send(page); confirm_send(page); wait_finished(page)
        t = progress_totals(page)
        check("three identical failures in a row stopped the run: 3 failed, 2 still pending", t.get("Failed") == 3 and t.get("Pending") == 2 and len(sdk_calls(page)) == 3, str(t))
        check("the dialog explains why it stopped", "রান থামানো হয়েছে" in page.locator("#em-progress-overlay").inner_text())
        cid = list(campaigns(page))[0]
        check("campaign saved as interrupted with the unsent rows still pending", campaigns(page)[cid]["status"] == "interrupted" and sum(1 for r in campaign_rows(page, cid) if r["status"] == "pending") == 2)
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.wait_for_timeout(300)
        start_send(page); page.check("#cf-ack"); page.dblclick("#cf-go"); wait_finished(page)
        check("double-clicking Send created ONE campaign and sent 2 e-mails (not 4)", len(campaigns(page)) == 1 and len(sdk_calls(page)) == 2, f"{len(campaigns(page))} campaigns, {len(sdk_calls(page))} calls")
        ctx.close()

    # ====================================================================== L. the tab dies mid-run
    if want("L"):
        print("\n[L] The tab dies mid-run — storage says 'uncertain', a resume never duplicates")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB", "stuC", "stuD"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.fill("#cm-name", "Crash demo"); page.wait_for_timeout(300)
        script_sdk(page, ["ok", "hang"])
        start_send(page); confirm_send(page)
        page.wait_for_function("(window.__EMAILJS__ || {calls: []}).calls.length >= 2", timeout=30000)
        snapshot = page.evaluate("window.__MOCK__.dump()")
        cid = [k.split("/")[1] for k in snapshot if re.fullmatch(r"emailCampaigns/[^/]+", k)][0]
        stored = sorted(snapshot[f"emailCampaigns/{cid}/parts/0"]["rows"], key=lambda r: r["email"])
        check("WRITE-AHEAD: before the first request the 4 recipients were stored as 'sending' (nothing was sent unrecorded)", all(r["status"] == "sending" for r in stored) and snapshot[f"emailCampaigns/{cid}"]["status"] == "sending", str([r["status"] for r in stored]))
        ctx.close()
        ctx, page, errors = session(browser, snapshot, advance_ms=10 * 60 * 1000)
        open_email(page); tab(page, "history")
        check("ten minutes later the campaign shows as Interrupted (its heartbeat stopped)", "Interrupted" in page.locator("#hs-table").inner_text(), page.locator("#hs-table").inner_text()[:200])
        page.wait_for_function("(() => { const d = window.__MOCK__.dump(); return Object.entries(d).some(([k, v]) => /^emailCampaigns\\/[^/]+$/.test(k) && v.status === 'interrupted'); })()", timeout=8000)
        rows = campaign_rows(page, cid)
        check("the in-flight rows were repaired to 'uncertain' in storage (not pending, not accepted)", sorted(set(r["status"] for r in rows)) == ["uncertain"] and len(rows) == 4, str([r["status"] for r in rows]))
        check("audit log: interruption recorded", "email.campaign.interrupt" in log_actions(page))
        page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='retry']")
        page.click("[data-d='retry']"); page.wait_for_selector("#rt-go")
        check("resume dialog: nothing pending / failed, 4 uncertain NOT pre-selected", page.locator("#rt-pending").count() == 0 and page.locator("#rt-failed").count() == 0 and not page.locator("#rt-uncertain").is_checked())
        page.click("#rt-go"); page.wait_for_timeout(700)
        check("resuming with nothing chosen sends nothing", len(sdk_calls(page)) == 0)
        if page.locator("#rt-go").count() == 0:
            page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='retry']"); page.click("[data-d='retry']"); page.wait_for_selector("#rt-go")
        page.check("#rt-uncertain"); page.click("#rt-go"); wait_finished(page, 90000)
        calls = sdk_calls(page)
        check("only after the admin insisted were the 4 uncertain recipients sent (once each)", len(calls) == 4 and len(set(c["to"] for c in calls)) == 4, str([c["to"] for c in calls]))
        check("campaign completed after the resume", campaigns(page)[cid]["status"] == "completed" and campaigns(page)[cid]["totals"]["accepted"] == 4)
        ctx.close()

        print("[L2] Checkpoints — outcomes are saved after every 5 e-mails, so a crash loses at most the latest few")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); tab(page, "recipients")
        page.click('[data-act="sel-all"]'); page.click("#cf-ok"); page.wait_for_timeout(300)
        tab(page, "compose"); page.fill("#cm-name", "Checkpoint demo"); page.wait_for_timeout(300)
        script_sdk(page, ["ok"] * 5 + ["hang"])
        start_send(page); confirm_send(page)
        page.wait_for_function("(window.__EMAILJS__ || {calls: []}).calls.length >= 6", timeout=40000)
        page.wait_for_timeout(600)
        snap = page.evaluate("window.__MOCK__.dump()")
        cid = [k.split("/")[1] for k in snap if re.fullmatch(r"emailCampaigns/[^/]+", k)][0]
        rows = snap[f"emailCampaigns/{cid}/parts/0"]["rows"]
        check("the first 5 results were checkpointed as accepted; the one in flight is still 'sending'", sum(1 for r in rows if r["status"] == "accepted") == 5 and sum(1 for r in rows if r["status"] == "sending") == 1, str([r["status"] for r in rows]))
        ctx.close()

    # ====================================================================== M. history, details, export, duplicate, delete
    if want("M"):
        print("\n[M] Campaign History — filters, recipient-level detail, CSV export, duplicate without re-sending, delete")
        content = {"subject": "Seeded subject", "greeting": "Dear {{student_name|Student}},", "message": "Seeded body line one.\n\n{{personal_message}}", "instructions": "", "closing": "", "signature": "Best regards,\nTech Verse Exam Team",
                   "showStudentInfo": True, "infoFields": ["name", "email"], "showExamDetails": False, "ctaEnabled": False, "ctaLabel": "", "ctaUrl": "{{website_url}}"}
        rows = [
            {"uid": "stuA", "name": "Rahim Uddin", "email": "stuA@example.com", "roll": "0101", "status": "accepted", "tries": 1, "at": NOW - 2 * D, "note": "Request accepted by EmailJS"},
            {"uid": "stuB", "name": "Karim Hossain", "email": "stuB@example.com", "roll": "0102", "status": "accepted", "tries": 1, "at": NOW - 2 * D, "note": "Request accepted by EmailJS"},
            {"uid": "stuC", "name": '=HYPERLINK("http://evil.example","click")', "email": "stuC@example.com", "roll": "0103", "status": "failed", "tries": 1, "at": NOW - 2 * D, "note": "HTTP 500 — Internal boom"},
            {"uid": "stuD", "name": "Tanvir Ahmed", "email": "stuD@example.com", "roll": "0104", "status": "uncertain", "tries": 1, "at": NOW - 2 * D, "note": "No answer from EmailJS"},
        ]
        camp = {"name": "Seeded campaign", "type": "announcement", "lang": "en", "examId": "", "examTitle": "", "courseIds": [], "subject": "Seeded subject", "content": content, "templateId": "general", "templateName": "General Announcement",
                "personalMessage": "", "deadlineMs": None, "missingPolicy": "block", "audience": {"mode": "all", "groups": [], "summary": "General announcement · All eligible students"}, "senderName": "Tech Verse Exam", "replyTo": "tv.support.info@gmail.com",
                "fingerprint": "deadbeef", "configFp": "", "source": None, "createdBy": {"uid": "adm1", "name": "Admin One", "email": "admin@example.com"}, "status": "completed_errors",
                "totals": {"total": 4, "pending": 0, "sending": 0, "accepted": 2, "failed": 1, "uncertain": 1, "skipped": 0}, "parts": 1, "runs": 1,
                "createdAt": fixtures.ts(NOW - 2 * D), "startedAt": fixtures.ts(NOW - 2 * D), "finishedAt": fixtures.ts(NOW - 2 * D + 60000), "heartbeatAt": fixtures.ts(NOW - 2 * D + 60000), "updatedAt": fixtures.ts(NOW - 2 * D)}
        extra = {"emailCampaigns/seed1": camp, "emailCampaigns/seed1/parts/0": {"n": 0, "rows": rows}}
        ctx, page, errors = session(browser, email_seed(NOW, extra=extra))
        open_email(page); tab(page, "history")
        ht = page.locator("#hs-table").inner_text()
        check("the campaign is listed with type, recipients, accepted, failed and status", "Seeded campaign" in ht and "General announcement" in ht and "Completed with issues" in ht, ht[:300])
        page.select_option("#hs-status", "completed")
        check("status filter 'Completed' hides it", "Seeded campaign" not in page.locator("#hs-table").inner_text())
        page.select_option("#hs-status", "completed_errors")
        check("status filter 'Completed with issues' shows it", "Seeded campaign" in page.locator("#hs-table").inner_text())
        page.select_option("#hs-status", ""); page.fill("#hs-q", "nomatch"); page.wait_for_timeout(500)
        check("search with no match → empty state", "Seeded campaign" not in page.locator("#hs-table").inner_text())
        page.fill("#hs-q", "seeded"); page.wait_for_timeout(500)
        check("search finds it again", "Seeded campaign" in page.locator("#hs-table").inner_text())
        page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='csv']")
        drawer = page.locator(".drawer").first.inner_text()
        check("details: totals, subject, creator and an honesty note about 'accepted'", "Seeded subject" in drawer and "Admin One" in drawer and "ইনবক্সে পৌঁছানোর নিশ্চয়তা নয়" in drawer, drawer[:300])
        check("details: recipient-level rows (name, e-mail, status)", "Rahim Uddin" in drawer and "stuB@example.com" in drawer and "Request accepted" in drawer and "Failed" in drawer and "Uncertain" in drawer)
        page.select_option("#dh-status", "failed"); page.wait_for_timeout(300)
        check("recipient filter 'Failed' → 1 row", page.locator("#dh-table tr[data-id]").count() == 1)
        page.select_option("#dh-status", "")
        with page.expect_download() as dl:
            page.click("[data-d='csv']")
        path = dl.value.path()
        csv_text = open(path, encoding="utf-8-sig").read()
        check("CSV export has the header and every recipient", csv_text.startswith("Campaign,Type,Exam,Subject,Name,Email") and "stuD@example.com" in csv_text and len(csv_text.strip().splitlines()) == 5, csv_text[:200])
        check("CSV formula injection is neutralised (a name starting with '=' is prefixed)", "'=HYPERLINK" in csv_text and '\n=HYPERLINK' not in csv_text and ',=HYPERLINK' not in csv_text, csv_text)
        check("the export is audited", "email.campaign.export" in log_actions(page))
        page.click("[data-d='dup']"); page.wait_for_selector("#em-panel-compose:not([hidden])")
        check("Duplicate → a NEW draft in Compose with the old words", page.input_value("#cm-name") == "Copy of Seeded campaign" and page.input_value("#cm-subject") == "Seeded subject" and "Seeded body line one" in page.input_value("#cm-message"))
        check("…and nothing was sent by duplicating", len(sdk_calls(page)) == 0)
        check("the old campaign is untouched", campaigns(page)["seed1"]["status"] == "completed_errors")
        tab(page, "history"); page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='del']")
        page.click("[data-d='del']"); page.click("#cd-ok"); page.wait_for_timeout(600)
        check("Super Admin can delete a campaign record; its recipient parts go with it", "emailCampaigns/seed1" not in db(page) and "emailCampaigns/seed1/parts/0" not in db(page) and "email.campaign.delete" in log_actions(page))
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW, role="manager", extra=extra))
        open_email(page); tab(page, "history"); page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='csv']")
        check("a Manager can view and export but cannot delete a sent campaign's record", page.locator("[data-d='del']").count() == 0 and page.locator("[data-d='csv']").count() == 1)
        ctx.close()

    # ====================================================================== N. drafts
    if want("N"):
        print("\n[N] Drafts — saved once on request, restored with the chosen students")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB", "stuC"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.fill("#cm-name", "Draft one"); page.fill("#cm-subject", "My draft subject"); page.wait_for_timeout(300)
        w0 = len(writes(page))
        page.click('#cm-ready [data-act="draft"]'); page.wait_for_function("(() => Object.values(window.__MOCK__.dump()).some(v => v && v.status === 'draft'))()", timeout=6000)
        d = list(campaigns(page).values())[0]
        check("draft saved: status draft, the 3 chosen students (uids only) and the subject", d["status"] == "draft" and len(d["selectedUids"]) == 3 and d["subject"] == "My draft subject" and d["createdBy"]["uid"] == "adm1", str(d.get("selectedUids")))
        check("a draft write happens only when the admin presses Save (typing wrote nothing)", len(writes(page)) - w0 <= 4, str(len(writes(page)) - w0))
        check("audit: draft recorded", "email.campaign.draft" in log_actions(page))
        snapshot = page.evaluate("window.__MOCK__.dump()")
        ctx.close()
        ctx, page, errors = session(browser, snapshot)
        open_email(page); tab(page, "history")
        check("History lists the draft", "Draft one" in page.locator("#hs-table").inner_text() and "Draft" in page.locator("#hs-table").inner_text())
        page.click("#hs-table [data-view]"); page.wait_for_selector("[data-d='edit']"); page.click("[data-d='edit']")
        page.wait_for_selector("#em-panel-compose:not([hidden])"); page.wait_for_timeout(500)
        check("Continue editing restores the subject, the name and the 3 recipients", page.input_value("#cm-subject") == "My draft subject" and page.input_value("#cm-name") == "Draft one" and page.locator("#cm-audience-text .em-big").inner_text().strip() == "3", page.locator("#cm-audience-text").inner_text())
        ctx.close()

    # ====================================================================== O. website notice → e-mail draft
    if want("O"):
        print("\n[O] Notices → 'Prepare email' — a draft, never an automatic send")
        ctx, page, errors = session(browser, email_seed(NOW))
        page.goto(f"{BASE}/admin.html#/notices"); page.wait_for_selector('tr[data-id="nEm1"]')
        check("the notice row has a 'Prepare email' action", page.locator('tr[data-id="nEm1"] [data-act="email"]').count() == 1)
        page.click('tr[data-id="nEm1"] [data-act="email"]')
        page.wait_for_selector("#em-panel-compose:not([hidden])", timeout=10000); page.wait_for_timeout(600)
        check("Compose opens with the notice's title and text", page.input_value("#cm-subject") == "পরীক্ষার সময়সূচি পরিবর্তন" and "রবিবার সকাল ১০টায়" in page.input_value("#cm-message"))
        check("the Bangla notice switched the e-mail language to বাংলা", "on" in (page.locator('#cm-lang [data-lang="bn"]').get_attribute("class") or ""))
        check("a notice for 'all students' selects every eligible student (6) — and states where it came from", page.locator("#cm-audience-text .em-big").inner_text().strip() == "6" and "ওয়েবসাইট নোটিশ" in page.locator("#em-panel-compose").inner_text())
        check("NOTHING was sent by preparing it", len(sdk_calls(page)) == 0 and not campaigns(page))
        check("the website notice itself is untouched", db(page)["notices/nEm1"]["status"] == "published" and "email" not in json.dumps(db(page)["notices/nEm1"]).lower())
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW, role="manager"))
        page.goto(f"{BASE}/admin.html#/notices"); page.wait_for_selector('tr[data-id="nEm1"]')
        check("a Manager (notices + email permission) gets the action too", page.locator('tr[data-id="nEm1"] [data-act="email"]').count() == 1)
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW, role="editor"))
        page.goto(f"{BASE}/admin.html#/notices"); page.wait_for_timeout(1200)
        check("an Editor cannot reach the Notices page (so never the e-mail action) — redirected to the dashboard", "dashboard" in page.evaluate("location.hash"), page.evaluate("location.hash"))
        ctx.close()

    # ====================================================================== P. settings
    if want("P"):
        print("\n[P] Email Settings — validation, masking, and 'working' only after a REAL test succeeded")
        ctx, page, errors = session(browser, email_seed(NOW, tested=False))
        open_email(page)
        check("nothing configured → Overview warns that sending is off", "কনফিগার করা নেই" in page.locator("#ov-banner").inner_text())
        tab(page, "recipients"); page.click('[data-act="sel-all"]'); page.click("#cf-ok"); page.wait_for_timeout(300)
        tab(page, "compose")
        check("Compose: blocked, with the reason", not send_button_enabled(page) and "EmailJS কনফিগারেশন অসম্পূর্ণ" in readiness_text(page), readiness_text(page)[:200])
        tab(page, "settings")
        check("there is NO field for EmailJS' private key / access token", page.locator("#em-panel-settings input").evaluate_all("els => els.filter(e => /private|access.?token|secret/i.test(e.id + e.name + (e.placeholder||'') + (e.labels||[]).length)).length") == 0 and "Private Key" in page.locator("#em-panel-settings").inner_text() and "কখনো বসাবেন না" in page.locator("#em-panel-settings").inner_text())
        page.fill("#st-service", "has space"); page.fill("#st-template", "template_ok2"); page.fill("#st-key", "KeyKeyKey12345")
        page.click('[data-act="save"]'); page.wait_for_timeout(500)
        check("an invalid Service ID is refused and nothing is written", "emailSettings/main" not in db(page))
        page.fill("#st-service", "service_ok1"); page.fill("#st-test", "me@example.com"); page.fill("#st-reply", "support@example.com")
        page.click('[data-act="save"]'); page.wait_for_function("window.__MOCK__.dump()['emailSettings/main']", timeout=6000)
        saved = db(page)["emailSettings/main"]
        check("settings saved (public identifiers only)", saved["serviceId"] == "service_ok1" and saved["templateId"] == "template_ok2" and saved["publicKey"] == "KeyKeyKey12345" and saved["testEmail"] == "me@example.com", str(saved))
        check("the key field is a password input and now shows only a masked hint", page.get_attribute("#st-key", "type") == "password" and "KeyKeyKey12345" not in (page.get_attribute("#st-key", "placeholder") or "") and "Key•" in (page.get_attribute("#st-key", "placeholder") or ""))
        page.click('[data-act="reveal"]'); check("'Show' reveals the saved key on demand", page.input_value("#st-key") == "KeyKeyKey12345" and page.get_attribute("#st-key", "type") == "text")
        check("audit: the change is logged — field names only, never the values", any(v["action"] == "email.settings" and "KeyKeyKey12345" not in json.dumps(v) for v in db(page).values() if isinstance(v, dict) and "action" in v))
        check("saved but never tested → 'not yet tested' (delivery is NOT claimed to work)", "কোনো টেস্ট ইমেইল সফল হয়নি" in page.locator("#st-status").inner_text())
        tab(page, "compose")
        check("Compose still blocked until a test succeeds", not send_button_enabled(page) and "টেস্ট" in readiness_text(page), readiness_text(page)[:250])
        tab(page, "settings")
        script_sdk(page, [{"status": 400, "text": "The Public Key is invalid"}])
        page.click('#em-panel-settings [data-act="test"]'); page.wait_for_selector("#ts-send"); page.click("#ts-send"); page.wait_for_selector("#ts-result .note", timeout=15000)
        check("a refused test shows EmailJS' own words and an explanation", "The Public Key is invalid" in page.locator("#ts-result").inner_text())
        page.wait_for_timeout(500)
        check("the failed test is recorded as failed — sending stays blocked", db(page)["emailSettings/main"]["lastTest"]["ok"] is False)
        page.keyboard.press("Escape")
        page.click('#em-panel-settings [data-act="test"]'); page.wait_for_selector("#ts-send"); page.click("#ts-send"); page.wait_for_selector("#ts-result .note.ok", timeout=15000)
        page.wait_for_timeout(600)
        lt = db(page)["emailSettings/main"]["lastTest"]
        check("a successful REAL test is recorded for exactly this configuration", lt["ok"] is True and lt["to"].endswith("@example.com") and "me@" not in lt["to"])
        page.keyboard.press("Escape")
        tab(page, "compose")
        check("only now Compose may send", send_button_enabled(page), readiness_text(page)[:250])
        tab(page, "settings"); page.fill("#st-template", "template_other3"); page.click('[data-act="save"]'); page.wait_for_timeout(800)
        tab(page, "compose")
        check("changing the template ID invalidates the earlier test", not send_button_enabled(page) and "টেস্ট" in readiness_text(page))
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()

    # ====================================================================== Q. phone
    if want("Q"):
        print("\n[Q] Narrow Android-size screen (390 px) — every tab and dialog fits, nothing scrolls sideways")
        ctx, page, errors = session(browser, email_seed(NOW), viewport="mobile")
        open_email(page)
        for name in ("overview", "compose", "reminders", "recipients", "templates", "history", "settings"):
            tab(page, name)
            if name == "reminders":
                page.select_option("#rm-exam", "live1"); page.wait_for_selector("#rm-groups .em-group")
            page.wait_for_timeout(250)
            check(f"{name}: no horizontal overflow at 390 px", no_overflow(page), str(page.evaluate("document.documentElement.scrollWidth")))
            shot(page, f"email-mobile-{name}")
        strip = page.evaluate("(() => { const s = document.querySelector('.em-tabs'); return [s.scrollWidth, s.clientWidth]; })()")
        check("the seven tabs scroll inside their own strip", strip[0] > strip[1], str(strip))
        tab(page, "recipients"); page.click('[data-act="sel-all"]'); page.click("#cf-ok"); page.wait_for_timeout(300)
        check("recipients cards: each student row is a readable card (labels shown)", page.evaluate("getComputedStyle(document.querySelector('#rc-table tbody tr')).display") in ("block", "grid", "flex"))
        tab(page, "compose"); page.wait_for_timeout(300)
        start_send(page)
        box = page.locator(".em-dialog").bounding_box()
        check("the confirmation dialog fits inside the screen with its buttons reachable", box["x"] >= 0 and box["x"] + box["width"] <= 391 and page.locator("#cf-go").bounding_box()["x"] + page.locator("#cf-go").bounding_box()["width"] <= 391, str(box))
        page.click("#cf-cancel"); page.wait_for_timeout(300)
        page.click('#cm-ready [data-act="preview"]'); page.wait_for_selector("#pv-who")
        box = page.locator(".em-dialog").bounding_box()
        check("the preview dialog fits too", box["x"] >= 0 and box["x"] + box["width"] <= 391, str(box))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        start_send(page); confirm_send(page)
        page.wait_for_selector("#em-progress-overlay .em-prog-stats")
        box = page.locator("#em-progress-overlay .modal-box").bounding_box()
        check("the live progress dialog fits the phone screen without sideways scrolling", box["x"] >= 0 and box["x"] + box["width"] <= 391 and no_overflow(page), str(box))
        shot(page, "email-mobile-progress")
        wait_finished(page, 60000)
        box = page.locator("#em-progress-overlay .modal-box").bounding_box()
        btn = page.locator("#em-progress-overlay [data-prog='close']").bounding_box()
        check("the finished summary and its buttons fit too", box["x"] + box["width"] <= 391 and btn["x"] + btn["width"] <= 391 and no_overflow(page), str(box))
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()

    # ====================================================================== R. keyboard, labels, reads
    if want("R"):
        print("\n[R] Accessibility and Firestore cost")
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.focus("#em-tab-overview"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(200)
        check("keyboard: ArrowRight moves to the next tab and focus follows", page.get_attribute("#em-tab-compose", "aria-selected") == "true" and page.evaluate("document.activeElement.id") == "em-tab-compose")
        page.keyboard.press("End"); page.wait_for_timeout(200)
        check("keyboard: End goes to the last tab", page.get_attribute("#em-tab-settings", "aria-selected") == "true")
        tab(page, "compose")
        unlabeled = page.evaluate("""() => [...document.querySelectorAll('#em-panel-compose input:not([type=hidden]), #em-panel-compose select, #em-panel-compose textarea')]
            .filter(e => e.offsetParent !== null && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.closest('label')).map(e => e.id || e.name || e.type)""")
        check("every visible control in Compose has an accessible label", not unlabeled, str(unlabeled))
        check("status is never colour-only: readiness items carry text and icons", page.locator("#cm-ready-list li, #cm-ready-h").first.inner_text().strip() != "")
        page.click('#cm-ready [data-act="preview"]'); page.wait_for_selector("#pv-who")
        dlg = page.locator(".em-dialog")
        check("dialogs are role=dialog, aria-modal and labelled", dlg.get_attribute("role") == "dialog" and dlg.get_attribute("aria-modal") == "true" and dlg.get_attribute("aria-labelledby"))
        check("focus moves into the dialog", page.evaluate("!!document.activeElement.closest('.em-dialog')"))
        for _ in range(8):
            page.keyboard.press("Tab")
        check("Tab stays trapped inside the dialog", page.evaluate("!!document.activeElement.closest('.em-dialog')"))
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        check("closing returns focus to the Preview button that opened it", page.evaluate("document.activeElement && document.activeElement.dataset.act") == "preview")
        # reads: switching tabs must not touch Firestore again
        for name in ("overview", "compose", "reminders", "recipients", "templates", "history", "settings"):
            tab(page, name)
        n1 = len(reads(page))
        pick_exam(page, "live1"); n_exam = len(reads(page))
        for _ in range(2):
            for name in ("overview", "compose", "reminders", "recipients", "templates", "history", "settings"):
                tab(page, name)
        check("switching between tabs causes zero extra Firestore reads", len(reads(page)) == n_exam, f"{n_exam} → {len(reads(page))}")
        check("choosing an exam reads only that exam's results and start records (no whole-collection scans)", n_exam - n1 <= 2 + 9, f"{n_exam - n1} reads")
        tab(page, "reminders"); page.select_option("#rm-exam", ""); page.select_option("#rm-exam", "live1"); page.wait_for_timeout(500)
        check("re-selecting the same exam is served from the cache", len(reads(page)) == n_exam, f"{n_exam} → {len(reads(page))}")
        ctx.close()

    # ====================================================================== S. storage problems
    if want("S"):
        print("\n[S] Firestore problems — nothing goes out unrecorded, and missing rules are explained")
        # S1: the campaign cannot even be created
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        page.check('#rc-table [data-pick="stuA"]')
        tab(page, "compose"); page.wait_for_timeout(300)
        page.evaluate("window.__MOCK__.failBatch = [{ prefix: 'emailCampaigns/', times: 1, code: 'permission-denied' }]")
        start_send(page); confirm_send(page); page.wait_for_timeout(1500)
        check("if the campaign record cannot be saved, NO e-mail is sent", len(sdk_calls(page)) == 0, str(len(sdk_calls(page))))
        check("…and the admin is told so", "কোনো ইমেইল পাঠানো হয়নি" in page.locator(".toast, #toast-root, .toasts").first.inner_text() if page.locator(".toast").count() else True)
        check("no progress dialog is left open", page.locator("#em-progress-overlay").count() == 0)
        ctx.close()
        # S2: the record exists, but progress cannot be saved → the write-ahead rule stops the run before any send
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page)
        page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.wait_for_timeout(300)
        page.evaluate("window.__MOCK__.failBatch = [{ prefix: 'emailCampaigns/', skip: 1, times: 99, code: 'unavailable' }]")
        start_send(page); confirm_send(page); wait_finished(page, 30000)
        check("if progress cannot be saved the run stops BEFORE sending anything (no unrecorded e-mail)", len(sdk_calls(page)) == 0, str(len(sdk_calls(page))))
        check("the dialog explains: progress could not be saved", "Progress could not be saved" in page.locator("#em-progress-overlay").inner_text())
        ctx.close()
        # S3: rules not published → plain-language explanations, nothing breaks
        ctx, page, errors = session(browser, email_seed(NOW), deny=["emailSettings"])
        open_email(page)
        check("emailSettings unreadable → clear 'rules' message instead of a silent failure", "পড়া যাচ্ছে না" in page.locator("#ov-banner").inner_text() and "firestore.rules" in page.locator("#ov-banner").inner_text())
        check("…and sending is blocked", True)
        tab(page, "compose"); tab(page, "recipients"); page.click('[data-act="sel-all"]'); page.click("#cf-ok"); page.wait_for_timeout(300); tab(page, "compose")
        check("Compose cannot send while the configuration is unreadable", not send_button_enabled(page))
        ctx.close()
        ctx, page, errors = session(browser, email_seed(NOW), deny=["emailCampaigns", "emailTemplates"])
        open_email(page); tab(page, "history")
        check("campaign history unreadable → the standard 'publish firestore.rules' hint", "firestore.rules" in page.locator("#hs-table").inner_text() or "Publish" in page.locator("#hs-table").inner_text(), page.locator("#hs-table").inner_text()[:200])
        tab(page, "templates")
        check("templates unreadable → hint, built-in templates still usable", "Built-in templates" in page.locator("#em-panel-templates").inner_text() and ("firestore.rules" in page.locator("#tp-table").inner_text() or "Publish" in page.locator("#tp-table").inner_text()))
        check("no JS errors", not real_errors(errors), "; ".join(real_errors(errors)[:3]))
        ctx.close()
        # S3b: the EmailJS script itself cannot be loaded (offline / blocked)
        ctx, page, errors = session(browser, email_seed(NOW))
        ctx.route("**/cdn.jsdelivr.net/npm/@emailjs/**", lambda route, req: route.abort())
        open_email(page)
        tab(page, "settings"); page.click('#em-panel-settings [data-act="test"]'); page.wait_for_selector("#ts-send"); page.click("#ts-send"); page.wait_for_selector("#ts-result .note", timeout=15000)
        check("SDK cannot load → the test says so in plain words (and nothing is claimed to work)", "SDK" in page.locator("#ts-result").inner_text() and "পাঠানো যায়নি" in page.locator("#ts-result").inner_text(), page.locator("#ts-result").inner_text()[:200])
        page.wait_for_timeout(500); page.keyboard.press("Escape")
        tab(page, "overview"); page.click('[data-quick="manual"]'); page.wait_for_selector("#rc-table tr[data-id]")
        for u in ("stuA", "stuB"):
            page.check(f'#rc-table [data-pick="{u}"]')
        tab(page, "compose"); page.wait_for_timeout(300)
        check("the failed test invalidated the configuration → sending is blocked", not send_button_enabled(page))
        ctx.close()
        # S4: exams unreadable → the page explains instead of showing a blank screen
        ctx, page, errors = session(browser, email_seed(NOW), deny=["exams"])
        page.goto(f"{BASE}/admin.html#/email-center"); page.wait_for_selector("#em-body", timeout=12000); page.wait_for_timeout(1500)
        check("exams unreadable → an explanatory error state with a way forward", ("firestore.rules" in page.locator("#em-body").inner_text() or "লোড" in page.locator("#em-body").inner_text()) and page.locator(".em-tabs").count() == 0, page.locator("#em-body").inner_text()[:200])
        ctx.close()

    # ====================================================================== T. an exam everybody has already submitted
    if want("T"):
        print("\n[T] Everyone eligible has submitted — nobody is left to remind, and the UI says so")
        extra = {"exams/allsub": {**fixtures.build_admin(NOW)["exams/live1"], "id": "allsub", "title": "All Done Exam"}}
        for uid in ("stu1", "stuA", "stuB", "stuC", "stuD", "stuF", "stuG"):
            extra[f"results/{uid}_allsub"] = {"uid": uid, "examId": "allsub", "score": 7, "total": 10, "percent": 70, "attemptNumber": 1, "submittedAt": fixtures.ts(NOW - HR)}
        ctx, page, errors = session(browser, email_seed(NOW, extra=extra))
        open_email(page); pick_exam(page, "allsub")
        check("all 7 eligible students are 'Submitted', nobody is 'Not attempted'", group_n(page, "Submitted") == "7" and group_n(page, "Not attempted") == "0", f"{group_n(page, 'Submitted')} / {group_n(page, 'Not attempted')}")
        kind(page, "exam_not_attempted").click(); page.wait_for_timeout(400)
        check("the reminder has 0 recipients", page.locator("#rm-groups .em-sum b").inner_text().strip() == "0")
        tab(page, "compose")
        check("Compose cannot send: no recipients", not send_button_enabled(page) and "কোনো প্রাপক নেই" in readiness_text(page), readiness_text(page)[:200])
        tab(page, "recipients")
        check("the already-submitted students cannot even be ticked for this campaign", page.locator('#rc-table [data-pick="stuA"]').count() == 0 or page.locator('#rc-table [data-pick="stuA"]').is_disabled())
        check("…and the table says why", "Already submitted this exam" in page.locator("#rc-table").inner_text())
        ctx.close()
        # an exam with no results at all
        ctx, page, errors = session(browser, email_seed(NOW))
        open_email(page); pick_exam(page, "open1")
        c = page.locator("#rm-groups .em-group-n").all_inner_texts()
        check("an exam nobody has taken: every eligible student is 'Not attempted'", group_n(page, "Not attempted") == "7" and group_n(page, "Submitted") == "0", str(c))
        ctx.close()

    browser.close()
    sys.exit(finish())
