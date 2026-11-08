"""End-to-end checks for Push Notifications — the ADMIN centre (Send · History · Setup & Audit) running in a real browser
   against the REAL push server code (server/push/*) with in-memory stand-ins for Firestore / Auth / FCM
   (tests/support/push-dev-server.mjs). Nothing here touches the network, a Firebase project or a Google account.
   python3 tests/e2e/run_push.py [--shots]
"""
import sys, os, json, subprocess, time, urllib.request, urllib.error, urllib.parse, datetime
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

PDS_PORT = 8766
PDS = f"http://127.0.0.1:{PDS_PORT}"


# ---------------------------------------------------------------- the fake push server (real routes)
def start_server(*flags):
    proc = subprocess.Popen(["node", os.path.join(ROOT, "tests/support/push-dev-server.mjs"), str(PDS_PORT), str(NOW), *flags],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"{PDS}/__state", timeout=1).read()
            return proc
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("push dev server did not start")


def srv(path, method="GET"):
    req = urllib.request.Request(f"{PDS}{path}", method=method, data=b"" if method == "POST" else None)
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())


def state():
    return srv("/__state")


def forward(route, request):
    """The page asks /api/push/<action> on the static site; hand it to the dev server and return its answer unchanged."""
    if OUTAGE["on"]:
        return route.abort("connectionrefused")
    u = urllib.parse.urlparse(request.url)
    hdrs = {k: v for k, v in request.headers.items() if k.lower() in ("authorization", "content-type")}
    req = urllib.request.Request(f"{PDS}{u.path}" + (f"?{u.query}" if u.query else ""), data=request.post_data_buffer, method=request.method, headers=hdrs)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as e:
        resp = e
    body = resp.read()
    route.fulfill(status=resp.status, body=body, headers={"content-type": resp.headers.get("content-type", "application/json"), "cache-control": "no-store"})


def push_context(browser, viewport, user="adm1"):
    """make_context + the bits the real push client needs from the mocked Firebase user: an ID token, and the push API route."""
    ctx = make_context(browser, viewport, seed=fixtures.build_admin(NOW), user=user)
    ctx.add_init_script("""(() => { const u = window.__MOCK__ && window.__MOCK__.user;
      if (u) u.getIdToken = async () => 'fake.' + u.uid + '.' + 'x'.repeat(24); })();""")
    ctx.route("**/api/push/**", forward)          # registered last → runs first
    install_clock(ctx)
    return ctx


def open_push(page, tab="send"):
    page.goto(f"{BASE}/admin.html#/push")
    page.wait_for_selector(f"#pn-panel-send .pn-compose", timeout=12000)
    if tab != "send":
        page.click(f"#pn-tab-{tab}")
    page.wait_for_timeout(300)


def fill_message(page, title, body):
    page.fill("#pn-title", title)
    page.fill("#pn-body", body)


def local_input(ms_offset=0):
    """A datetime-local value (Asia/Dhaka wall clock) ms_offset after the fixed test 'now'."""
    t = datetime.datetime.fromtimestamp((NOW + ms_offset) / 1000, tz=datetime.timezone(datetime.timedelta(hours=6)))
    return t.strftime("%Y-%m-%dT%H:%M")


def confirm(page, phrase=None):
    page.wait_for_selector("#cd-ok")
    if page.locator("#cd-phrase").count():
        page.fill("#cd-phrase", phrase or "SEND")
    page.click("#cd-ok")


OUTAGE = {"on": False}


def real_jobs():
    return [j for j in state()["jobs"] if not j.get("test")]


def job_by_title(title):
    for j in state()["jobs"]:
        if str(j.get("title", "")).startswith(title):
            return j
    return None


def wait_for(fn, timeout=9.0, step=0.15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def api_call(action, token, method="POST"):
    """A hand-made request straight to the server, like someone using the browser console or curl would send."""
    req = urllib.request.Request(f"{PDS}/api/push/{action}", method=method, data=b"{}" if method == "POST" else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        r = urllib.request.urlopen(req, timeout=10)
        return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def tok(uid):
    return f"fake.{uid}.{'x' * 24}"


def make_png(path, w=900, h=450):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), (30, 90, 200))
    d = ImageDraw.Draw(im)
    for i in range(0, w, 60):
        d.rectangle([i, 0, i + 30, h], fill=(240, 240, 255))
    d.ellipse([w // 2 - 90, h // 2 - 90, w // 2 + 90, h // 2 + 90], fill=(255, 190, 40))
    im.save(path)


def dup_ids(page):
    return page.evaluate("""() => { const seen = {}, dup = [];
      document.querySelectorAll('[id]').forEach((e) => { if (seen[e.id]) dup.push(e.id); seen[e.id] = 1; }); return dup; }""")


MIN = 60 * 1000

proc = start_server()
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        errors = []

        # ------------------------------------------------------------------ A. The page opens (phone width)
        print("\n[A] Opening Push Notifications on a phone")
        ctx = push_context(browser, VIEWPORTS["mobile"])
        page = new_page(ctx, errors)
        page.set_default_timeout(9000)
        page.goto(f"{BASE}/admin.html#/dashboard")
        page.wait_for_selector(".admin-nav-item")
        check("the menu has a Push Notifications item (Communication group)", page.locator('.admin-nav-item[data-section="push"]').count() == 1)
        page.goto(f"{BASE}/admin.html#/push")
        page.wait_for_selector("#pn-panel-send .pn-compose", timeout=12000)
        page.wait_for_timeout(400)
        check("three tabs: Send · History · Setup & Audit", page.locator(".pn-tab").count() == 3 and page.locator("#pn-tab-send").get_attribute("aria-selected") == "true")
        check("no horizontal overflow at 390 px", no_overflow(page))
        check("the stylesheet was loaded for this page only", page.evaluate("!!document.getElementById('pn-css')"))
        check("the Send tab shows the kinds, audience choices and the readiness box",
              page.locator(".pn-type").count() >= 8 and page.locator("#pn-checks li").count() >= 3)
        check("on a phone the preview sits inside the Message card (the side preview is hidden)",
              page.locator("#pn-pv-inline").is_visible() and not page.locator(".pn-pv-card").is_visible())
        shot(page, "push-send-empty")
        check("nothing was sent just by opening the page", state()["calls"] == 0)
        check("no id is used twice on the page (labels would point at the wrong field)", dup_ids(page) == [], str(dup_ids(page)))

        # ------------------------------------------------------------------ B. Writing a notification
        print("\n[B] Composer — counters, live preview, validation, destination")
        fill_message(page, "Physics model test — tonight 8 PM", "Bring a pen. The link opens at 7:55 PM.")
        check("character counters follow typing", page.inner_text("#pn-title-n").strip() == "33 / 65" and "/ 240" in page.inner_text("#pn-body-n"), page.inner_text("#pn-title-n"))
        check("the preview shows the typed text", "Physics model test" in page.inner_text("#pn-pv-inline") and "Bring a pen" in page.inner_text("#pn-pv-inline"))
        page.fill("#pn-title", "x" * 70)
        check("a too-long title is flagged at once", "too long" in page.inner_text("#pn-title-err").lower(), page.inner_text("#pn-title-err"))
        page.fill("#pn-title", "Physics model test — tonight 8 PM")
        check("the error disappears when fixed", page.inner_text("#pn-title-err").strip() == "")
        check("the default destination is a page of this site", "never open another website" in page.inner_text("#pn-dest-note").lower() or "opens" in page.inner_text("#pn-dest-note").lower(), page.inner_text("#pn-dest-note"))
        page.locator('label.seg-btn', has_text="Custom address").click()
        page.fill("#pn-dest-custom", "https://evil.example.com/login")
        page.wait_for_timeout(150)
        check("an outside website is refused as a destination", page.locator("#pn-dest-note.bad").count() == 1, page.inner_text("#pn-dest-note"))
        page.fill("#pn-dest-custom", "#/results")
        page.wait_for_timeout(150)
        check("a page of this site is accepted", page.locator("#pn-dest-note.bad").count() == 0 and "#/results" in page.inner_text("#pn-dest-note"), page.inner_text("#pn-dest-note"))
        page.locator('label.seg-btn', has_text="A page").click()
        shot(page, "push-send-filled")

        # ------------------------------------------------------------------ C. Who receives it — reach from the real server
        print("\n[C] Audience — how many devices, from the server")
        page.wait_for_selector("#pn-reach .pn-reach-box", timeout=9000)
        txt = page.inner_text("#pn-reach")
        check("all subscribed students: 3 devices (one student switched announcements off, and is told so)", "3 devices" in txt and "switched this kind off" in txt, txt)
        page.locator('label.pn-type', has=page.locator('input[value="user"]')).click()
        page.wait_for_selector("#pn-stu-q")
        page.fill("#pn-stu-q", "rahim")
        page.wait_for_selector("#pn-stu-res .pn-result-row")
        check("student search finds by name", page.locator("#pn-stu-res .pn-result-row").count() == 1)
        page.click("#pn-stu-res .pn-result-row")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        check("one student → one device", "1 device" in page.inner_text("#pn-reach"), page.inner_text("#pn-reach"))
        page.click('[data-act="clear-student"]')
        page.locator('label.pn-type', has=page.locator('input[value="all"]')).click()
        page.wait_for_selector("#pn-reach .pn-reach-box")

        # ------------------------------------------------------------------ D. Send now
        print("\n[D] Send now — confirmation, honest result, no double send")
        send_btn = page.locator("#pn-send")
        page.fill("#pn-title", "")
        page.evaluate("document.getElementById('pn-send').click()")   # aria-disabled (not `disabled`): a click is allowed so it can explain what is missing
        page.wait_for_timeout(200)
        check("sending with a missing title is blocked, shows why, and sends nothing", state()["calls"] == 0 and page.inner_text("#pn-title-err").strip() != "")
        fill_message(page, "Physics model test — tonight 8 PM", "Bring a pen. The link opens at 7:55 PM.")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        check("a confirmation names the audience and says it cannot be taken back", "cannot be taken back" in page.inner_text(".modal-box, #cd-ok >> xpath=ancestor::*[contains(@class,'modal')][1]") or page.locator("#cd-phrase").count() == 1)
        check("an all-students send asks for the word SEND", page.locator("#cd-phrase").count() == 1)
        page.fill("#cd-phrase", "SEND")
        page.click("#cd-ok")
        page.wait_for_selector("#pn-result .pn-result", timeout=12000)
        page.wait_for_timeout(500)
        st = state()
        check("FCM was asked once, for exactly the active, opted-in devices", st["calls"] == 1 and len(st["sent"]) == 1 and len(st["sent"][0]["tokens"]) == 3, str([len(s["tokens"]) for s in st["sent"]]))
        check("the notification text reached FCM as data", st["sent"][0]["data"].get("title", "").startswith("Physics model test"), str(st["sent"][0]["data"])[:200])
        res = page.inner_text("#pn-result")
        check("the result says 'accepted' and says it cannot confirm a phone showed it", "Accepted by FCM" in res and "cannot confirm" in res, res[:300])
        check("the word 'delivered' is not used as a result", "delivered" not in page.inner_text("#pn-result .pn-counts").lower())
        check("the form was cleared after a successful send", page.input_value("#pn-title") == "")
        shot(page, "push-send-result")

        print("\n[D1b] Sending again within seconds is refused politely")
        fill_message(page, "Result published — Set A", "Open the app to see your score.")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        page.fill("#cd-phrase", "SEND")
        page.click("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result .pn-result-head b')", timeout=9000)
        check("a second send straight after the first is refused with a clear message", "Too many notifications" in page.inner_text("#pn-result") and len(state()["jobs"]) == 1, page.inner_text("#pn-result")[:200])
        check("the text the admin typed is kept after a refused send", page.input_value("#pn-title").startswith("Result published"))

        print("\n[D2] A double click on the confirm button is ONE notification")
        srv("/__advance?ms=6000", "POST")
        before = len(state()["jobs"])
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        page.fill("#cd-phrase", "SEND")
        page.dblclick("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result .pn-result.teal, #pn-result .pn-result.amber')", timeout=12000)
        page.wait_for_timeout(600)
        jobs = state()["jobs"]
        check("two clicks created exactly one job", len(jobs) == before + 1, f"{before} → {len(jobs)}")
        check("FCM got that notification once", sum(1 for sent in state()["sent"] if sent["data"].get("title", "").startswith("Result published")) == 1)

        check("no page errors so far", not errors, str(errors[:3]))

        # ------------------------------------------------------------------ E. Test send
        print("\n[E] Send test to my own devices")
        srv("/__advance?ms=6000", "POST")
        fill_message(page, "Test: preview check", "Only I should get this.")
        page.click("#pn-test")
        page.wait_for_selector("#pn-result .pn-result-head b", timeout=9000)
        txt = page.inner_text("#pn-result")
        check("a test with no device of my own explains what to do", "no subscribed device" in txt, txt[:200])
        check("…and sent nothing", len([x for x in state()["sent"] if x["data"].get("title", "").startswith("Test:")]) == 0)
        mine = srv("/__device?uid=adm1", "POST")
        srv("/__advance?ms=6000", "POST")
        page.click("#pn-test")
        page.wait_for_selector("#pn-result .pn-result.teal, #pn-result .pn-result.amber", timeout=9000)
        sent_test = [x for x in state()["sent"] if x["data"].get("title", "").startswith("Test:")]
        check("the test reached only the admin's own device", len(sent_test) == 1 and sent_test[0]["tokens"] == [mine["token"]], str(sent_test)[:200])
        check("the test result is marked as a test", "Test" in page.inner_text("#pn-result"))
        check("the test did not clear what the admin was writing", page.input_value("#pn-title") == "Test: preview check")

        # ------------------------------------------------------------------ F. Picture + scheduling
        print("\n[F] Picture upload, preview and scheduling")
        png = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "e2e", "_push_pic.png")
        make_png(png)
        page.locator('[data-act="pick-image"]').click()
        page.wait_for_selector("#adm-drawer .pn-pick")
        check("the picture drawer opens and offers upload and a link", page.locator("#pnp-file").count() == 1 and page.locator("#pnp-url").count() == 1)
        page.set_input_files("#pnp-file", png)
        page.wait_for_selector("#adm-drawer", state="detached", timeout=12000)
        check("an uploaded picture is stored on the server (resized, small)", len(state()["images"]) == 1 and state()["images"][0]["size"] < 700 * 1024, str(state()["images"]))
        check("the composer shows the chosen picture", "_push_pic" in page.inner_text('[data-kind="image"]') and page.locator('[data-kind="image"] img').count() == 1)
        check("the preview shows the picture", page.locator("#pn-pv-inline .pn-pv-pic img").count() == 1)
        shot(page, "push-send-picture")

        page.locator('label.pn-type', has=page.locator('input[name="pn-when"][value="later"]')).click()
        page.wait_for_selector("#pn-when-at")
        page.fill("#pn-when-at", local_input(30 * MIN))
        page.wait_for_timeout(150)
        check("the send button now says Schedule", "Schedule" in page.inner_text("#pn-send-l"), page.inner_text("#pn-send-l"))
        page.fill("#pn-title", "Reminder: exam at 10 AM")
        page.fill("#pn-body", "Be ready 15 minutes early.")
        srv("/__advance?ms=6000", "POST")
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        check("scheduling needs no typed word (nothing goes out yet)", page.locator("#cd-phrase").count() == 0)
        page.click("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result').innerText.includes('Scheduled')", timeout=9000)
        j = job_by_title("Reminder: exam at 10 AM")
        check("the job is stored as scheduled for the chosen time and nothing was sent", j and j["status"] == "scheduled" and abs(j["scheduledAt"] - (state()["now"] + 30 * MIN)) < 3 * MIN, str(j and (j["status"], j.get("scheduledAt"))))
        check("the picture link was sent to the server", j and str(j.get("image", "")).startswith("https://"), str(j and j.get("image")))
        check("the result card says Scheduled", "Scheduled" in page.inner_text("#pn-result"), page.inner_text("#pn-result")[:120])
        check("a scheduled notification is not sent to FCM now", not [x for x in state()["sent"] if x["data"].get("title", "").startswith("Reminder")])
        check("no page errors", not errors, str(errors[:3]))

        # ------------------------------------------------------------------ G. History
        print("\n[G] History — list, filter, search, details, cancel")
        page.click("#pn-tab-history")
        page.wait_for_selector("#ph-table tbody tr")
        rows = page.locator("#ph-table tbody tr")
        check("the list shows the real notifications (tests are hidden by default)", rows.count() == 3, str(rows.count()))
        check("the scheduled one is labelled Scheduled", "Scheduled" in page.inner_text("#ph-table"))
        page.click('#ph-seg [data-seg="scheduled"]')
        check("filter: Scheduled → one row", page.locator("#ph-table tbody tr").count() == 1)
        page.click('#ph-seg [data-seg="all"]')
        page.check("#ph-tests")
        check("‘Show test sends’ adds the test row", page.locator("#ph-table tbody tr").count() == 4, str(page.locator("#ph-table tbody tr").count()))
        page.uncheck("#ph-tests")
        page.fill("#ph-q", "physics")
        page.wait_for_timeout(450)
        check("search finds by title", page.locator("#ph-table tbody tr").count() == 1 and "Physics" in page.inner_text("#ph-table"))
        page.fill("#ph-q", "")
        page.wait_for_timeout(450)
        page.locator('#ph-table button.pn-cname', has_text="Physics").click()
        page.wait_for_selector("#adm-drawer .pn-counts, #adm-drawer .pn-kv")
        dr = page.inner_text("#adm-drawer")
        check("the details drawer shows audience, who sent it and the honest note", "All students" in dr or "students" in dr.lower(), dr[:200])
        check("…and the person who created it", "Admin One" in dr, dr[:300])
        check("…and says accepted is not delivered", "cannot confirm" in dr or "not a confirmation" in dr.lower() or "NOT" in dr, dr[:400])
        shot(page, "push-history-drawer")
        page.keyboard.press("Escape")
        page.wait_for_selector("#adm-drawer", state="detached")

        sched = [j for j in real_jobs() if j["status"] == "scheduled"][0]
        page.click(f'[data-cancel="{sched["id"]}"]')
        page.wait_for_selector("#cd-ok")
        page.click("#cd-ok")
        wait_for(lambda: job_by_title("Reminder: exam at 10 AM")["status"] == "cancelled")
        check("Cancel works: the job is cancelled on the server", job_by_title("Reminder: exam at 10 AM")["status"] == "cancelled")
        page.wait_for_timeout(300)
        check("…and the list says Cancelled", "Cancelled" in page.inner_text("#ph-table"))
        check("a cancelled notification is never sent", not [x for x in state()["sent"] if x["data"].get("title", "").startswith("Reminder")])
        shot(page, "push-history")
        check("no horizontal overflow on History at 390 px", no_overflow(page))

        print("\n[G2] Reuse the text of an earlier notification")
        page.locator('#ph-table [data-view]').first.click()
        page.wait_for_selector('#adm-drawer [data-d="reuse"]')
        page.click('#adm-drawer [data-d="reuse"]')
        page.wait_for_selector("#pn-panel-send:not([hidden])")
        check("the Send tab is opened with the old text filled in", page.input_value("#pn-title") != "", page.input_value("#pn-title"))
        check("…but the audience and time must be chosen again", page.locator('input[name="pn-aud"][value="all"]').is_checked() and page.locator('input[name="pn-when"][value="now"]').is_checked())
        page.fill("#pn-title", "")
        page.fill("#pn-body", "")

        # ------------------------------------------------------------------ H. The open page sends what is due (no outside timer)
        print("\n[H] Scheduled → due while the page is open → sent by the page itself")
        srv("/__advance?ms=6000", "POST")
        fill_message(page, "Open-page ticker test", "Sent when its time comes.")
        page.locator('label.pn-type', has=page.locator('input[name="pn-when"][value="later"]')).click()
        page.wait_for_selector("#pn-when-at")
        page.fill("#pn-when-at", local_input(3 * MIN))
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        page.click("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result').innerText.includes('Scheduled')", timeout=9000)
        check("scheduled again", job_by_title("Open-page ticker test")["status"] == "scheduled")
        srv("/__advance?ms=240000", "POST")           # the server's clock: 4 minutes later
        page.clock.fast_forward(4 * MIN)              # the browser's clock too (the admin panel's own idle sign-out is 30 minutes)
        done = wait_for(lambda: job_by_title("Open-page ticker test")["status"] in ("completed", "completed_with_errors"), timeout=15)
        jj = job_by_title("Open-page ticker test")
        check("the open Push page sent it when it became due", done, f"{jj['status']} scheduledAt={jj.get('scheduledAt')} server_now={state()['now']} page_now={page.evaluate('Date.now()')}")
        check("FCM got it exactly once", len([x for x in state()["sent"] if x["data"].get("title", "").startswith("Open-page")]) == 1)
        page.wait_for_timeout(500)
        page.click("#pn-tab-history")
        page.wait_for_timeout(300)
        check("the list shows it as Sent without a manual reload", "Open-page ticker test" in page.inner_text("#ph-table"))
        check("no page errors", not errors, str(errors[:3]))

        # ------------------------------------------------------------------ I. FCM trouble is reported honestly
        print("\n[I] When FCM rejects devices")
        page.click("#pn-tab-send")
        srv("/__advance?ms=6000", "POST")
        srv("/__fail-token?uid=stuA&code=messaging/registration-token-not-registered", "POST")
        fill_message(page, "Dead device check", "One browser was uninstalled.")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        page.fill("#cd-phrase", "SEND")
        page.click("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result .pn-counts')", timeout=12000)
        page.wait_for_timeout(500)
        rt = page.inner_text("#pn-result")
        j = job_by_title("Dead device check")
        check("the job counts 3 accepted (incl. my own device) and 1 dead device", j and j["counts"]["accepted"] == 3 and j["counts"]["invalid"] == 1 and j["counts"]["targeted"] == 4, str(j and j["counts"]))
        check("the result card shows the dead device and explains it", "Dead devices removed" in rt and "removed" in rt.lower(), rt[:400])
        check("the dead device was removed on the server (it will not be tried again)", not [d for d in state()["devices"] if d["uid"] == "stuA" and d["status"] == "active"])
        srv("/__advance?ms=6000", "POST")
        srv("/__fcm-fail?code=messaging/server-unavailable", "POST")
        fill_message(page, "FCM down check", "FCM is unavailable.")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        page.click("#pn-send")
        page.wait_for_selector("#cd-ok")
        page.fill("#cd-phrase", "SEND")
        page.click("#cd-ok")
        page.wait_for_function("document.querySelector('#pn-result .pn-result.coral, #pn-result .pn-result.amber, #pn-result .pn-result.bad')", timeout=15000)
        page.wait_for_timeout(500)
        j = job_by_title("FCM down check")
        check("with FCM down nothing is claimed as accepted", j and j["counts"]["accepted"] == 0, str(j and (j["status"], j["counts"])))
        check("the result says failed / not accepted (never 'sent')", "Sent" not in page.inner_text("#pn-result .pn-result-chips"), page.inner_text("#pn-result")[:200])
        check("the reason is a sentence, not a raw code", "temporarily unavailable" in page.inner_text("#pn-result").lower() and "server_unavailable" not in page.inner_text("#pn-result"), page.inner_text("#pn-result")[:300])
        srv("/__fcm-fail", "POST")
        shot(page, "push-send-failed")
        check("no page errors", not errors, str(errors[:3]))

        # ------------------------------------------------------------------ J. Setup & Audit
        print("\n[J] Setup & Audit")
        page.click("#pn-tab-setup")
        page.wait_for_selector("#ps-status li")
        st_txt = page.inner_text("#ps-status")
        check("the checklist says the push server is reachable and the Firebase key works", "reach" in st_txt.lower() or "ready" in st_txt.lower() or "connected" in st_txt.lower(), st_txt[:300])
        check("it names the project and the site", "tvsaccount" in st_txt and "tvexam.vercel.app" in st_txt, st_txt[-300:])
        check("it says the browser key (VAPID) is not set yet — students cannot subscribe", "vapid" in st_txt.lower() or "web push key" in st_txt.lower() or "browser key" in st_txt.lower(), st_txt[:400])
        tm = page.inner_text("#ps-timer")
        check("the free-timer guide shows the exact address to call", "/api/push/cron" in tm and "tvexam.vercel.app" in tm, tm[:300])
        check("…and never shows the secret", "c" * 40 not in page.content())
        page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
        page.click('#ps-timer [data-copy]')
        page.wait_for_function("document.getElementById('toast-root') && document.getElementById('toast-root').innerText.includes('Copied')", timeout=3000)
        check("Copy gives feedback", True)
        page.click('[data-act="tick"]')
        page.wait_for_timeout(600)
        check("'Run scheduler now' works without error", not errors, str(errors[:3]))
        status, hb = api_call("cron", "c" * 48, "POST")
        check("the free timer endpoint accepts the right secret", status == 200 and hb.get("ok") is True, str((status, hb)))
        status, _ = api_call("cron", "wrong-secret-wrong-secret", "POST")
        check("…and refuses a wrong one", status in (401, 403), str(status))
        page.click('[data-act="recheck"]')
        page.wait_for_timeout(700)
        check("after a timer call the checklist shows the timer as working", "just now" in page.inner_text("#ps-status").lower() or "last" in page.inner_text("#ps-status").lower() or "working" in page.inner_text("#ps-status").lower(), page.inner_text("#ps-status")[-300:])
        page.wait_for_selector("#ps-audit tbody tr")
        au = page.inner_text("#ps-audit")
        for _ in range(6):                                  # the table shows 10 rows a page: read every page
            nxt = page.locator('#ps-audit .pager [aria-label="Next page"]')
            if nxt.count() == 0 or nxt.is_disabled():
                break
            nxt.click()
            page.wait_for_timeout(150)
            au += "\n" + page.inner_text("#ps-audit")
        first_pg = page.locator('#ps-audit .pager').get_by_role("button", name="1", exact=True)
        if first_pg.count():
            first_pg.click()                                 # back to the first page (its rows open the notification in History)
            page.wait_for_timeout(150)
        check("the audit log lists who did what", "Admin One" in au and "Push notification sent" in au, au[:300])
        check("…including the scheduling, the cancellation and the test", "scheduled" in au.lower() and "cancelled" in au.lower() and "Test push sent" in au, au[:600])
        check("…and the picture upload", "Push picture uploaded" in au, au[:300])
        check("the audit entries are mirrored into the existing Activity Logs", any(a.get("action", "").startswith("push.") for a in state()["adminLogs"]))
        shot(page, "push-setup")
        check("no horizontal overflow on Setup at 390 px", no_overflow(page))
        page.locator('#ps-audit [data-open]').first.click()
        page.wait_for_selector("#adm-drawer .pn-kv", timeout=6000)
        check("an audit row opens the notification in History", True)
        page.keyboard.press("Escape")
        check("no page errors", not errors, str(errors[:3]))
        check("no id is used twice on any tab", dup_ids(page) == [], str(dup_ids(page)))
        ctx.close()

        # ------------------------------------------------------------------ K. The server being unreachable
        print("\n[K] The push server is unreachable")
        OUTAGE["on"] = True
        ctx = push_context(browser, VIEWPORTS["mobile"])
        page = new_page(ctx, errors)
        page.set_default_timeout(9000)
        page.goto(f"{BASE}/admin.html#/push")
        page.wait_for_selector("#pn-panel-send .pn-compose", timeout=12000)
        page.wait_for_selector("#pn-strip .pn-strip", timeout=15000)
        check("a red strip says the push server is not ready", "not ready" in page.inner_text("#pn-strip").lower(), page.inner_text("#pn-strip"))
        fill_message(page, "Cannot send", "Server is down.")
        page.evaluate("document.getElementById('pn-send').click()")
        page.wait_for_timeout(300)
        check("Send is blocked and says why", state()["calls"] >= 0 and "push server" in page.inner_text("#pn-why").lower(), page.inner_text("#pn-why"))
        OUTAGE["on"] = False
        page.click("#pn-refresh")
        page.wait_for_function("!document.querySelector('#pn-strip .pn-strip')", timeout=12000)
        check("when the server is back, one refresh clears the warning", True)
        ctx.close()

        # ------------------------------------------------------------------ L. Who may use it — the SERVER decides
        print("\n[L] Permissions are enforced on the server, not only hidden in the page")
        status, body = api_call("health", tok("stu1"))
        check("a student calling the admin API is refused (403)", status == 403 and body["error"]["code"] == "not_admin", str((status, body)))
        status, body = api_call("send", tok("stu1"))
        check("…also for send", status == 403, str(status))
        status, body = api_call("health", "")
        check("no sign-in at all → 401", status == 401, str(status))
        status, body = api_call("health", tok("outsider"))
        check("a signed-in stranger with no student record → 403", status == 403, str(status))
        status, body = api_call("health", "fake.nobody." + "x" * 24)
        check("a forged token → 401", status == 401, str(status))
        srv("/__role?uid=adm1&role=editor", "POST")
        status, body = api_call("health", tok("adm1"))
        check("an Editor is refused by the server even though is an admin", status == 403, str((status, body)))
        srv("/__role?uid=adm1&role=manager", "POST")
        status, body = api_call("health", tok("adm1"))
        check("a Manager is allowed", status == 200 and body["actor"]["role"] == "manager", str((status, body)))
        srv("/__role?uid=adm1&role=", "POST")

        seed_editor = fixtures.build_admin(NOW)
        seed_editor["adminRoles/adm1"] = {"role": "editor"}
        ctx = make_context(browser, VIEWPORTS["mobile"], seed=seed_editor, user="adm1")
        ctx.add_init_script("""(() => { const u = window.__MOCK__ && window.__MOCK__.user; if (u) u.getIdToken = async () => 'fake.' + u.uid + '.' + 'x'.repeat(24); })();""")
        ctx.route("**/api/push/**", forward)
        install_clock(ctx)
        page = new_page(ctx, errors)
        page.goto(f"{BASE}/admin.html#/dashboard")
        page.wait_for_selector(".admin-nav-item")
        check("an Editor does not see the Push Notifications menu item", page.locator('.admin-nav-item[data-section="push"]').count() == 0)
        page.goto(f"{BASE}/admin.html#/push")
        page.wait_for_timeout(1200)
        check("…and opening the address directly does not load the page", page.locator("#pn-panel-send").count() == 0)
        ctx.close()

        seed_mgr = fixtures.build_admin(NOW)
        seed_mgr["adminRoles/adm1"] = {"role": "manager"}
        ctx = make_context(browser, VIEWPORTS["mobile"], seed=seed_mgr, user="adm1")
        ctx.add_init_script("""(() => { const u = window.__MOCK__ && window.__MOCK__.user; if (u) u.getIdToken = async () => 'fake.' + u.uid + '.' + 'x'.repeat(24); })();""")
        ctx.route("**/api/push/**", forward)
        install_clock(ctx)
        page = new_page(ctx, errors)
        srv("/__role?uid=adm1&role=manager", "POST")
        page.goto(f"{BASE}/admin.html#/push")
        page.wait_for_selector("#pn-panel-send .pn-compose", timeout=12000)
        check("a Manager can open Push Notifications", True)
        ctx.close()
        srv("/__role?uid=adm1&role=", "POST")

        # ------------------------------------------------------------------ M. Desktop
        print("\n[M] Desktop layout")
        ctx = push_context(browser, VIEWPORTS["desktop"])
        page = new_page(ctx, errors)
        page.set_default_timeout(9000)
        open_push(page)
        fill_message(page, "Desktop layout check", "The preview sits beside the form on a wide screen.")
        page.wait_for_selector("#pn-reach .pn-reach-box")
        check("on a wide screen the preview is in the side column", page.locator(".pn-pv-card").is_visible() and not page.locator("#pn-pv-inline").is_visible())
        box1 = page.locator(".pn-side").bounding_box()
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(300)
        box2 = page.locator(".pn-side").bounding_box()
        check("the side column stays in view while scrolling", box2 is not None and 0 <= box2["y"] < 200, str((box1, box2)))
        page.locator("label.seg-btn", has_text="Computer").click()
        check("the preview can be switched to a computer-style notification", page.locator(".pn-pv-card .pn-pv.desktop").count() == 1)
        check("no horizontal overflow at 1366 px", no_overflow(page))
        shot(page, "push-send-desktop")
        for tab in ("history", "setup"):
            page.click(f"#pn-tab-{tab}")
            page.wait_for_timeout(500)
        shot(page, "push-setup-desktop")
        check("no horizontal overflow on Setup at 1366 px", no_overflow(page))
        check("no page errors on desktop", not errors, str(errors[:3]))
        ctx.close()

        browser.close()
finally:
    proc.kill()

sys.exit(finish())
