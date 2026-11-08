"""End-to-end checks for Push Notifications — the STUDENT side, in a real browser.

   The real student code (js/push/*), the real push server code (server/push/*, through tests/support/push-dev-server.mjs with
   in-memory stand-ins for Firestore / Auth / FCM) and the REAL service worker (firebase-messaging-sw.js) run together.
   Only what a headless test browser cannot do is replaced:
     • the Firebase Messaging library       → tests/e2e/mock/firebase-messaging.js   (hands out a token, can "receive" a message)
     • the browser's permission dialog      → a small test double (init script below) whose answer the test decides
     • the browser's service-worker registry → a double for the pages' register() calls (the real worker is exercised in [N])
   Nothing here touches the network, a Firebase project or a Google account.
   python3 tests/e2e/run_push_student.py [--shots]
"""
import sys, os, re, json, subprocess, time, hashlib, urllib.request, urllib.error, urllib.parse
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

PDS_PORT = 8766
PDS = f"http://127.0.0.1:{PDS_PORT}"
DAY = 86400000
OUTAGE = {"on": False}
REQS = []          # (time, method, url, post_data) of every request any page made
ERR = []           # page errors / console errors of the current scenario


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


# ---------------------------------------------------------------- the configured site (a VAPID key filled in)
VAPID = "B" + "A1b2C3d4E5" * 8 + "xyz-_"                      # 86 characters of [A-Za-z0-9_-], like a real public key
CONFIG_ON = re.sub(r'vapidKey:\s*"[^"]*"', f'vapidKey: "{VAPID}"', open(os.path.join(ROOT, "js/push/push-config.js"), encoding="utf-8").read())
assert VAPID in CONFIG_ON, "could not find the vapidKey line in js/push/push-config.js"

IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

# the browser's permission answer + the worker registry (state survives reloads, like in a real browser)
PUSH_ENV = """(() => {
  const st = window.__PUSH = { asked: 0, regs: 0, regUrl: '', regOpts: null, shown: [], unsubscribed: 0 };
  const g = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  const s = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  try {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => g('__test.perm', 'default') });
    Notification.requestPermission = async () => {
      st.asked += 1;
      if (g('__test.perm', 'default') === 'default') s('__test.perm', g('__test.answer', 'granted'));
      return g('__test.perm', 'default');
    };
  } catch (e) {}
  const reg = {
    scope: location.origin + '/firebase-cloud-messaging-push-scope', active: {}, update: async () => {},
    showNotification: async (title, opts) => { st.shown.push({ title, opts: JSON.parse(JSON.stringify(opts || {})) }); },
    pushManager: { getSubscription: async () => ({ unsubscribe: async () => { st.unsubscribed += 1; return true; } }) },
  };
  const sw = navigator.serviceWorker;
  if (sw) {
    sw.register = async (url, opts) => { st.regs += 1; st.regUrl = String(url); st.regOpts = opts || {}; s('__test.reg', '1'); return reg; };
    sw.getRegistration = async () => (g('__test.reg', '') === '1' ? reg : undefined);
  }
})();"""


def student_ctx(browser, viewport=None, configured=True, user="stu1", **kw):
    ctx = make_context(browser, viewport or VIEWPORTS["mobile"], user=user, **kw)
    ctx.add_init_script("""(() => { const u = window.__MOCK__ && window.__MOCK__.user;
      if (u) u.getIdToken = async () => 'fake.' + u.uid + '.' + 'x'.repeat(24); })();""")
    ctx.add_init_script(PUSH_ENV)
    if configured:
        ctx.route("**/js/push/push-config.js*", lambda route, request: route.fulfill(
            status=200, content_type="text/javascript", body=CONFIG_ON, headers={"access-control-allow-origin": "*"}))
    ctx.route("**/api/push/**", forward)                      # registered last → runs first
    install_clock(ctx)
    ctx.on("request", lambda r: REQS.append((time.time(), r.method, r.url, r.post_data)))
    return ctx


def open_student(ctx, hash_="#/home"):
    page = new_page(ctx, ERR)
    page.set_default_timeout(9000)
    go(page, hash_)
    return page


def set_ls(page, items):
    """Write localStorage values (already JSON text) BEFORE the app starts: visit a blank page of the same site."""
    page.goto(f"{BASE}/__blank__")
    page.evaluate("(kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v))", items)


def ls_get(page, key):
    raw = page.evaluate("(k) => localStorage.getItem(k)", key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


def my_device(page, uid="stu1"):
    did = hashlib.sha256(f"{uid}:{ls_get(page, 'tvp.key')}".encode()).hexdigest()[:40]
    return next((d for d in state()["devices"] if d["id"] == did), None)


def active_devices(uid):
    return [d for d in state()["devices"] if d["uid"] == uid and d["status"] == "active"]


def api_calls(action, since):
    return [r for r in REQS[since:] if f"/api/push/{action}" in r[2]]


def wait_for(fn, timeout=9.0, step=0.15, page=None):
    """Poll fn() until it is truthy. Pass `page` when fn depends on browser events (requests, DevTools events): the sync
       Playwright API delivers those only while a page call is running, so the pause must be page.wait_for_timeout()."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        if page is not None:
            page.wait_for_timeout(int(step * 1000))
        else:
            time.sleep(step)
    return None


def toast_has(page, text, timeout=5000):
    try:
        page.wait_for_function("(t) => ((document.getElementById('toast-root') || {}).innerText || '').includes(t)", arg=text, timeout=timeout)
        return True
    except Exception:
        return False


def booted(page):
    """The push screens are mounted (they load after the first paint, when the browser is idle)."""
    page.wait_for_selector("#tvp-root", state="attached", timeout=12000)


def quiet(page, ms=3800):
    """Wait long enough for the card's own timers (2.5 s + route settle) — used to prove something does NOT appear."""
    booted(page)
    page.wait_for_timeout(ms)


def deliver(page, data):
    page.evaluate("(d) => window.__FCM.deliver({ data: d })", data)


def banners(page):
    return page.locator("#tvp-banners .tvp-banner")


def errs_ok():
    return not ERR


proc = start_server()
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # ------------------------------------------------------------------ A. as shipped: no key → dormant
        print("\n[A] As shipped (no browser key yet): completely dormant")
        ERR.clear()
        ctx = student_ctx(browser, configured=False)
        i0 = len(REQS)
        page = open_student(ctx, "#/home")
        page.wait_for_timeout(6000)
        urls = [r[2] for r in REQS[i0:]]
        check("none of the student push files is downloaded", not any(x in u for u in urls for x in ("push-student.js", "push-ui.js", "push-views.js", "push-core.js", "css/push.css", "firebase-messaging.js")), str([u for u in urls if "push" in u]))
        check("no push API call is made", not any("/api/push/" in u for u in urls))
        check("nothing is drawn on the page", page.evaluate("!document.getElementById('tvp-root') && !document.getElementById('tvp-css')"))
        page.evaluate("location.hash = '#/notifications'")
        page.wait_for_selector("#nf-tools .seg-tabs", timeout=9000)
        page.wait_for_timeout(600)
        check("the Notifications page is the old one — no push card", page.locator("#tvp-settings").count() == 0)
        check("the browser's permission prompt was never opened", page.evaluate("window.__PUSH.asked") == 0)
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        # ------------------------------------------------------------------ B. the explaining card
        print("\n[B] The explaining card — when it may appear, and when never")
        ERR.clear()
        ctx = student_ctx(browser)
        i0 = len(REQS)
        page = open_student(ctx, "#/home")
        booted(page)
        page.wait_for_timeout(3800)
        check("first visit: the card does not appear", page.locator("#tvp-prompt").count() == 0)
        check("…and nothing asked the browser for permission", page.evaluate("window.__PUSH.asked") == 0)
        urls = [r[2] for r in REQS[i0:]]
        check("the push screens were fetched on the side, never as part of the page itself", any("push-ui.js" in u for u in urls) and "push" not in open(os.path.join(ROOT, "index.html"), encoding="utf-8").read().lower().replace("pushstate", ""), "")
        check("the messaging library is not downloaded while push is off", not any("firebase-messaging.js" in u for u in urls))
        check("while off, the page does not call the push server", not any("/api/push/" in u for u in urls))
        check("the visit was counted", ls_get(page, "tvp.visits.stu1") == 1, str(ls_get(page, "tvp.visits.stu1")))
        page.close()

        page = open_student(ctx, "#/home")
        page.wait_for_selector("#tvp-prompt", timeout=14000)
        txt = page.inner_text("#tvp-prompt")
        check("second visit: the card first explains what the student gets", "পরীক্ষা" in txt and "ফলাফল" in txt and "বন্ধ করতে পারবেন" in txt, txt[:200])
        check("…with three choices: turn on · not now · don't show again", all(page.locator(f'#tvp-prompt [data-tvp="{k}"]').count() == 1 for k in ("enable", "later", "never")))
        check("…and the browser's own prompt is NOT open yet (it opens only from the 'turn on' click)", page.evaluate("window.__PUSH.asked") == 0)
        check("showing the card counts as having asked once", (ls_get(page, "tvp.prompt.stu1") or {}).get("n") == 1, str(ls_get(page, "tvp.prompt.stu1")))
        shot(page, "push-student-prompt", full=False)
        check("no horizontal overflow with the card on a phone", no_overflow(page))
        page.click('#tvp-prompt [data-tvp="later"]')
        check("'Not now' closes the card", page.locator("#tvp-prompt").count() == 0)
        check("…without asking the browser anything", page.evaluate("window.__PUSH.asked") == 0)
        page.close()

        page = open_student(ctx, "#/home")
        quiet(page)
        check("next visit: the card stays away (7-day quiet period)", page.locator("#tvp-prompt").count() == 0)
        page.close()

        page = new_page(ctx, ERR)
        set_ls(page, {"tvp.prompt.stu1": json.dumps({"n": 1, "at": NOW - 8 * DAY, "never": False})})
        go(page, "#/home")
        page.wait_for_selector("#tvp-prompt", timeout=14000)
        check("after the quiet period it may come back once more", True)
        page.click('#tvp-prompt [data-tvp="never"]')
        check("'Don't show again' closes it with a friendly note", page.locator("#tvp-prompt").count() == 0 and toast_has(page, "আর জিজ্ঞেস করা হবে না"))
        check("…and remembers it for good", (ls_get(page, "tvp.prompt.stu1") or {}).get("never") is True, str(ls_get(page, "tvp.prompt.stu1")))
        page.close()

        page = open_student(ctx, "#/home")
        quiet(page)
        check("…the card never returns by itself", page.locator("#tvp-prompt").count() == 0)
        page.close()

        # an exam on screen, or a dialog open, is never interrupted
        page = new_page(ctx, ERR)
        set_ls(page, {"tvp.prompt.stu1": "null", "tvp.visits.stu1": "9"})
        go(page, "#/home")
        booted(page)
        page.evaluate("document.body.classList.add('exam-taking')")
        page.wait_for_timeout(3800)
        check("during an exam the card never appears", page.locator("#tvp-prompt").count() == 0)
        check("no page errors", errs_ok(), str(ERR[:3]))
        page.close()

        # ------------------------------------------------------------------ C. turning it on, from the settings card
        print("\n[C] Turning notifications on (Notifications page)")
        ERR.clear()
        page = open_student(ctx, "#/notifications")
        page.wait_for_selector("#tvp-settings .tvp-benefits", timeout=14000)
        st_txt = page.inner_text("#tvp-settings")
        check("the page has a push card with the benefits and a clear Turn-on button", "পুশ নোটিফিকেশন" in st_txt and page.locator('#tvp-settings [data-tvp="enable"]').count() == 1, st_txt[:200])
        check("…it says nothing is ever forced", "জোর" in st_txt)
        check("…and the card alone did not open the browser prompt", page.evaluate("window.__PUSH.asked") == 0)
        check("the old 'browser alert' line of the page is still there (nothing else changed)", page.locator("#nf-tools .nf-note").count() >= 1 and page.locator("#nf-tools .seg-tabs").count() == 1)
        shot(page, "push-student-settings-off")
        check("no horizontal overflow", no_overflow(page))

        i0 = len(REQS)
        page.click('#tvp-settings [data-tvp="enable"]')
        page.wait_for_selector("#tvp-settings .tvp-prefs", timeout=12000)
        check("one click → the browser permission is requested exactly once", page.evaluate("window.__PUSH.asked") == 1)
        check("our own worker file was registered, with its own scope", page.evaluate("window.__PUSH.regUrl").startswith("firebase-messaging-sw.js") and page.evaluate("window.__PUSH.regOpts.scope") == "./firebase-cloud-messaging-push-scope", page.evaluate("window.__PUSH.regUrl"))
        calls = page.evaluate("window.__FCM.calls")
        check("a token was requested with the public key and our worker", len(calls) >= 1 and calls[0]["vapidKey"] == VAPID and calls[0]["hasReg"] is True, str(calls))
        subs = api_calls("subscribe", i0)
        body = json.loads(subs[0][3]) if subs else {}
        token = page.evaluate("localStorage.getItem('__test.fcmtoken')")
        check("the token went to the server once, with this browser's id and a readable name", len(subs) == 1 and body.get("token") == token and body.get("deviceKey") == ls_get(page, "tvp.key") and "Chrome" in body.get("label", ""), str(body)[:200])
        check("…and the page holds no secret: only the public key is in the config it loaded", "private_key" not in CONFIG_ON and "BEGIN PRIVATE" not in CONFIG_ON)
        d = my_device(page)
        check("the server holds a device record for this student + browser with all three kinds on", bool(d) and d["status"] == "active" and d["prefs"] == {"announcement": True, "exam": True, "result": True}, str(d))
        check("…next to the student's other device (two active devices in total)", len(active_devices("stu1")) == 2, str(active_devices("stu1")))
        txt = page.inner_text("#tvp-settings")
        check("the card now says it is on, with a switch per kind (all on)", "চালু" in txt and page.locator("#tvp-settings input[data-pref]").count() == 3 and page.locator("#tvp-settings input[data-pref]:checked").count() == 3, txt[:200])
        check("a confirmation toast appears", toast_has(page, "নোটিফিকেশন চালু হয়েছে"))
        page.wait_for_selector("#tvp-settings .tvp-device", timeout=8000)
        dev_txt = page.inner_text("#tvp-settings .tvp-devices")
        check("it lists this account's devices and marks the current one", page.locator("#tvp-settings .tvp-device").count() == 2 and "এই ডিভাইস" in dev_txt, dev_txt)
        check("the stored on-record has the token for this student", (ls_get(page, "tvp.on") or {}).get("stu1", {}).get("token") == token)
        shot(page, "push-student-settings-on")
        check("no horizontal overflow when on", no_overflow(page))
        check("no page errors", errs_ok(), str(ERR[:3]))

        # ------------------------------------------------------------------ D. which kinds
        print("\n[D] Choosing which kinds to receive")
        i0 = len(REQS)
        page.click('#tvp-settings label.tvp-switch:has(input[data-pref="result"])')
        check("switching 'ফলাফল' off is saved on the server for this device", bool(wait_for(lambda: my_device(page)["prefs"]["result"] is False)), str(my_device(page)))
        check("…the other two kinds stay on", my_device(page)["prefs"]["announcement"] is True and my_device(page)["prefs"]["exam"] is True)
        others = [x for x in active_devices("stu1") if x["id"] != my_device(page)["id"]]
        check("…and the student's other device is untouched", others and all(o["prefs"]["result"] is True for o in others), str(others))
        check("one small request was sent for it", len(api_calls("prefs", i0)) == 1)
        page.reload()
        page.wait_for_selector("#tvp-settings .tvp-prefs", timeout=12000)
        check("after a reload the choice is still shown", page.locator('#tvp-settings input[data-pref="result"]').is_checked() is False and page.locator('#tvp-settings input[data-pref="exam"]').is_checked())
        OUTAGE["on"] = True
        page.click('#tvp-settings label.tvp-switch:has(input[data-pref="exam"])')
        check("when the server cannot be reached, a clear message appears", toast_has(page, "ইন্টারনেট সংযোগ নেই"))
        page.wait_for_timeout(300)
        check("…and the switch goes back to what the server really has", page.locator('#tvp-settings input[data-pref="exam"]').is_checked())
        OUTAGE["on"] = False
        check("the server value did not change", my_device(page)["prefs"]["exam"] is True)
        check("the 'could not save' line is shown while the connection is down", page.locator("#tvp-settings .tvp-error").count() == 1)
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_function("!document.querySelector('#tvp-settings .tvp-error')", timeout=3000)
        check("…and it goes away by itself when the connection is back", True)

        # ------------------------------------------------------------------ E. a notification arrives while the site is open
        print("\n[E] A notification arrives while the site is open")
        n1 = {"nid": "nid_exam0001", "title": "পদার্থবিজ্ঞান মডেল টেস্ট — আজ রাত ৮টা", "body": "প্রস্তুত থাকুন। পরীক্ষা শুরুর ১৫ মিনিট আগে লগইন করুন।", "url": "#/results", "cat": "result", "ts": str(NOW)}
        check("the page is listening for messages (foreground)", page.evaluate("window.__FCM.handlers.length") >= 1)
        deliver(page, n1)
        page.wait_for_selector("#tvp-banners .tvp-banner", timeout=4000)
        b = page.inner_text("#tvp-banners .tvp-banner")
        check("an in-page banner shows the title and the text", "পদার্থবিজ্ঞান মডেল টেস্ট" in b and "প্রস্তুত থাকুন" in b, b)
        check("…in the colour/icon of its kind", banners(page).first.get_attribute("data-cat") == "result")
        page.wait_for_timeout(450)                              # let the banner finish sliding in
        shot(page, "push-student-banner", full=False)
        check("no horizontal overflow with a banner", no_overflow(page))
        deliver(page, n1)
        page.wait_for_timeout(300)
        check("the same notification again does not create a second banner", banners(page).count() == 1)
        page.click('#tvp-banners .tvp-banner [data-tvp="go"]')
        page.wait_for_function("location.hash === '#/results'", timeout=4000)
        check("'দেখুন' opens that page of this site and removes the banner", banners(page).count() == 0)

        deliver(page, {"nid": "nid_evil0001", "title": "Click me", "body": "x", "url": "https://evil.example/phish", "cat": "announcement"})
        page.wait_for_selector("#tvp-banners .tvp-banner", timeout=4000)
        page.click('#tvp-banners .tvp-banner [data-tvp="go"]')
        page.wait_for_function("location.hash === '#/home'", timeout=4000)
        check("a destination outside this site is never followed (falls back to Home)", page.evaluate("location.origin") == BASE and page.evaluate("location.hash") == "#/home", page.url)
        deliver(page, {"nid": "nid_evil0002", "title": "Script", "url": "javascript:alert(1)"})
        page.wait_for_selector("#tvp-banners .tvp-banner", timeout=4000)
        page.click('#tvp-banners .tvp-banner [data-tvp="go"]')
        page.wait_for_timeout(300)
        check("a javascript: destination is refused too", page.evaluate("location.hash") == "#/home" and page.evaluate("location.protocol") == "http:")
        deliver(page, {"nid": "nid_html00001", "title": "<img src=x onerror=window.__pwned=1>Hello", "body": "<b>bold</b>", "url": "#/home"})
        page.wait_for_selector("#tvp-banners .tvp-banner", timeout=4000)
        check("text from outside is shown as text, never as HTML", banners(page).locator("img").count() == 0 and banners(page).locator("b").count() == 1 and not page.evaluate("window.__pwned"))
        banners(page).first.locator('[data-tvp="close"]').click()
        check("the close button removes a banner", banners(page).count() == 0)
        deliver(page, {"title": "no id"})
        deliver(page, {"nid": "x", "title": "short id"})
        deliver(page, None)
        page.wait_for_timeout(300)
        check("malformed messages are ignored", banners(page).count() == 0)
        for i in range(5):
            deliver(page, {"nid": f"nid_many000{i}", "title": f"Message {i}", "url": "#/home"})
        page.wait_for_timeout(300)
        check("at most three banners are stacked", banners(page).count() == 3, str(banners(page).count()))
        page.evaluate("document.querySelectorAll('#tvp-banners .tvp-banner').forEach((e) => e.remove())")

        # a running exam is never interrupted
        page.evaluate("document.body.classList.add('exam-taking')")
        deliver(page, {"nid": "nid_exam0002", "title": "During the exam", "body": "wait quietly", "url": "#/results", "cat": "exam", "ts": str(NOW)})
        page.wait_for_timeout(500)
        check("during an exam nothing is drawn over the questions", banners(page).count() == 0)
        shown = page.evaluate("window.__PUSH.shown")
        check("…the message waits silently in the system tray instead", len(shown) == 1 and shown[0]["opts"].get("silent") is True and shown[0]["title"] == "During the exam" and shown[0]["opts"]["tag"].startswith("tvp-"), str(shown))
        page.evaluate("location.hash = '#/home'")
        page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'tvp-open', hash: '#/results' } }))")
        page.wait_for_timeout(300)
        check("a tap on a notification never pulls the student out of a running exam", page.evaluate("location.hash") == "#/home")
        page.evaluate("document.body.classList.remove('exam-taking')")
        page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'tvp-open', hash: 'https://evil.example/' } }))")
        page.wait_for_timeout(300)
        check("a tap message that points outside the site is ignored", page.evaluate("location.hash") == "#/home" and page.evaluate("location.origin") == BASE)
        page.evaluate("navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'tvp-open', hash: '#/results' } }))")
        page.wait_for_function("location.hash === '#/results'", timeout=3000)
        check("outside an exam a tap on a notification opens its page in the open tab", True)
        check("no page errors", errs_ok(), str(ERR[:3]))
        page.close()

        # ------------------------------------------------------------------ F. staying in sync
        print("\n[F] Staying in sync — token check on a later visit, refresh, rotation")
        ERR.clear()
        i0 = len(REQS)
        page = open_student(ctx, "#/notifications")
        page.wait_for_selector("#tvp-settings .tvp-prefs", timeout=14000)
        page.wait_for_timeout(1500)
        check("a normal visit re-checks the token quietly (no new subscription request)", len(api_calls("subscribe", i0)) == 0 and page.evaluate("window.__FCM.calls.length") >= 1, str(page.evaluate("window.__FCM.calls.length")))
        check("…the student's earlier choice is still on the server (not overwritten)", my_device(page)["prefs"]["result"] is False)
        page.close()

        page = new_page(ctx, ERR)
        page.goto(f"{BASE}/__blank__")
        on_rec = ls_get(page, "tvp.on")
        on_rec["stu1"]["at"] = NOW - 2 * DAY
        page.evaluate("(v) => localStorage.setItem('tvp.on', v)", json.dumps(on_rec))
        i0 = len(REQS)
        go(page, "#/notifications")
        wait_for(lambda: len(api_calls("subscribe", i0)) >= 1, timeout=14, page=page)
        subs = api_calls("subscribe", i0)
        body = json.loads(subs[0][3]) if subs else {}
        check("a day later the record is refreshed silently…", len(subs) == 1, str(len(subs)))
        check("…without sending the student's switches (the server keeps their choices)", "prefs" not in body and my_device(page)["prefs"]["result"] is False, str(body)[:200])
        old_token = page.evaluate("localStorage.getItem('__test.fcmtoken')")
        page.close()

        page = new_page(ctx, ERR)
        page.goto(f"{BASE}/__blank__")
        page.evaluate("localStorage.removeItem('__test.fcmtoken')")      # the browser rotated its token
        i0 = len(REQS)
        go(page, "#/notifications")
        wait_for(lambda: len(api_calls("subscribe", i0)) >= 1, timeout=14, page=page)
        subs = api_calls("subscribe", i0)
        body = json.loads(subs[0][3]) if subs else {}
        new_token = page.evaluate("localStorage.getItem('__test.fcmtoken')")
        check("a rotated token is sent together with the old one, so the server replaces it", len(subs) == 1 and body.get("token") == new_token and body.get("previousToken") == old_token and new_token != old_token, str(body)[:300])
        check("…and the student still has exactly two active devices (replaced, not added)", len(active_devices("stu1")) == 2, str(active_devices("stu1")))
        check("no page errors", errs_ok(), str(ERR[:3]))

        # ------------------------------------------------------------------ G. turning it off
        print("\n[G] Turning notifications off")
        page.wait_for_selector('#tvp-settings [data-tvp="disable"]', timeout=12000)
        i0 = len(REQS)
        page.click('#tvp-settings [data-tvp="disable"]')
        page.wait_for_selector('#tvp-settings [data-tvp="enable"]', timeout=10000)
        check("the card goes back to 'off' with the Turn-on button", "বন্ধ" in page.inner_text("#tvp-settings .tvp-head"))
        check("the token was deleted at Firebase (delivery to this browser stops at once)", page.evaluate("window.__FCM.deleted") == 1, str(page.evaluate("window.__FCM.deleted")))
        check("the server record of this device is gone", bool(wait_for(lambda: len(active_devices("stu1")) == 1)) and len(api_calls("unsubscribe", i0)) == 1, str(active_devices("stu1")))
        check("…while the student's other device stays", len(active_devices("stu1")) == 1)
        check("the local 'on' record is cleared", "stu1" not in (ls_get(page, "tvp.on") or {}))
        check("a confirmation toast appears", toast_has(page, "বন্ধ করা হয়েছে"))
        page.reload()
        quiet(page, 2500)
        check("after a reload it stays off (no automatic re-subscribing)", page.evaluate("(window.__FCM && window.__FCM.calls.length) || 0") == 0 and page.locator('#tvp-settings [data-tvp="enable"]').count() == 1)
        check("the browser prompt was not shown again", page.evaluate("window.__PUSH.asked") == 0)

        # ------------------------------------------------------------------ H. trouble while turning on
        print("\n[H] Trouble while turning on")
        OUTAGE["on"] = True
        page.click('#tvp-settings [data-tvp="enable"]')
        page.wait_for_selector("#tvp-settings .tvp-error", timeout=10000)
        err_txt = page.inner_text("#tvp-settings .tvp-error")
        check("with the server unreachable the card explains it in plain Bengali", "ইন্টারনেট" in err_txt, err_txt)
        check("…nothing is stored as 'on', and no record exists on the server", "stu1" not in (ls_get(page, "tvp.on") or {}) and len(active_devices("stu1")) == 1)
        check("…the browser permission was already granted, so it was not asked a second time here", page.evaluate("window.__PUSH.asked") <= 1)
        OUTAGE["on"] = False
        page.click('#tvp-settings [data-tvp="enable"]')
        page.wait_for_selector("#tvp-settings .tvp-prefs", timeout=12000)
        check("trying again after the connection is back works", len(active_devices("stu1")) == 2)
        page.evaluate("window.__FCM.fail = 'messaging/token-subscribe-failed'")
        page.click('#tvp-settings [data-tvp="disable"]')
        page.wait_for_selector('#tvp-settings [data-tvp="enable"]', timeout=10000)
        page.click('#tvp-settings [data-tvp="enable"]')
        page.wait_for_selector("#tvp-settings .tvp-error", timeout=10000)
        check("when Firebase cannot give a token the student sees a calm message and stays 'off'", "নোটিফিকেশন" in page.inner_text("#tvp-settings .tvp-error") and "stu1" not in (ls_get(page, "tvp.on") or {}), page.inner_text("#tvp-settings .tvp-error"))
        page.evaluate("window.__FCM.fail = null")
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        # ------------------------------------------------------------------ I. blocked / dismissed permission
        print("\n[I] Blocked or dismissed permission")
        ERR.clear()
        n_before, i_before = len(active_devices("stu1")), len(REQS)
        ctx = student_ctx(browser)
        page = new_page(ctx, ERR)
        set_ls(page, {"__test.perm": "denied", "tvp.visits.stu1": "9"})
        go(page, "#/home")
        quiet(page)
        check("a blocked site gets no card at all (no nagging about something the browser blocks)", page.locator("#tvp-prompt").count() == 0)
        page.evaluate("location.hash = '#/notifications'")
        page.wait_for_selector("#tvp-settings .tvp-note", timeout=12000)
        txt = page.inner_text("#tvp-settings")
        check("the Notifications page says it is blocked and how to allow it", "ব্লক" in txt and "অনুমতি দিন" in txt, txt[:300])
        check("…there is no Turn-on button while blocked", page.locator('#tvp-settings [data-tvp="enable"]').count() == 0)
        check("…and the browser prompt was never opened", page.evaluate("window.__PUSH.asked") == 0)
        shot(page, "push-student-settings-denied")
        check("no horizontal overflow", no_overflow(page))
        page.evaluate("localStorage.setItem('__test.perm', 'default'); localStorage.setItem('__test.answer', 'default')")
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.wait_for_selector('#tvp-settings [data-tvp="enable"]', timeout=6000)
        check("after the student unblocks the site, the card notices it on its own (still nothing forced)", page.evaluate("window.__PUSH.asked") == 0)
        page.click('#tvp-settings [data-tvp="enable"]')
        check("closing the browser's prompt without choosing is handled with a gentle message", toast_has(page, "অনুমতির বার্তাটি বন্ধ"))
        page.wait_for_selector('#tvp-settings [data-tvp="enable"]', timeout=4000)
        check("…the student can simply try again later", page.evaluate("window.__PUSH.asked") == 1 and "stu1" not in (ls_get(page, "tvp.on") or {}))
        page.evaluate("localStorage.setItem('__test.answer', 'denied')")
        page.click('#tvp-settings [data-tvp="enable"]')
        check("choosing 'Block' gets a clear message", toast_has(page, "অনুমতি দেয়নি"))
        page.wait_for_selector("#tvp-settings .tvp-head .badge", timeout=4000)
        check("…and the card then shows the blocked state", "ব্লক" in page.inner_text("#tvp-settings .tvp-head"))
        check("nothing was registered on the server (no subscribe call, no new device)", len(active_devices("stu1")) == n_before and not api_calls("subscribe", i_before), str(api_calls("subscribe", i_before)))
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        # ------------------------------------------------------------------ J. a device that cannot do web push
        print("\n[J] iPhone in the browser (not installed): honest guidance")
        ERR.clear()
        i_before = len(REQS)
        ctx = student_ctx(browser, user_agent=IPHONE_UA, is_mobile=True, has_touch=True)
        page = new_page(ctx, ERR)
        set_ls(page, {"tvp.visits.stu1": "9"})
        go(page, "#/home")
        quiet(page)
        check("no card is shown on a device that cannot receive push", page.locator("#tvp-prompt").count() == 0)
        page.evaluate("location.hash = '#/notifications'")
        page.wait_for_selector("#tvp-settings .tvp-note", timeout=12000)
        txt = page.inner_text("#tvp-settings")
        check("the page explains what to do (Add to Home Screen) instead of showing a button that cannot work", "Add to Home Screen" in txt and "সমর্থিত নয়" in txt and page.locator('#tvp-settings [data-tvp="enable"]').count() == 0, txt[:300])
        shot(page, "push-student-settings-ios")
        check("no horizontal overflow", no_overflow(page))
        check("nothing was asked of the browser and nothing sent to the server", page.evaluate("window.__PUSH.asked") == 0 and not any("/api/push/" in r[2] for r in REQS[i_before:]))
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        # ------------------------------------------------------------------ K. signed out / signing out
        print("\n[K] Signed-out visitors and signing out")
        ERR.clear()
        ctx = student_ctx(browser, user=None)
        i0 = len(REQS)
        page = open_student(ctx, "#/home")
        quiet(page, 3800)
        check("a signed-out visitor sees no card and no settings", page.locator("#tvp-prompt").count() == 0 and page.locator("#tvp-settings").count() == 0)
        check("…and nothing is sent to the push server", not any("/api/push/" in r[2] for r in REQS[i0:]))
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        ERR.clear()
        ctx = student_ctx(browser)
        page = open_student(ctx, "#/notifications")
        page.wait_for_selector('#tvp-settings [data-tvp="enable"]', timeout=14000)
        page.click('#tvp-settings [data-tvp="enable"]')
        page.wait_for_selector("#tvp-settings .tvp-prefs", timeout=12000)
        check("(setup) notifications are on for this student", len(active_devices("stu1")) == 2)
        page.evaluate("import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js').then((m) => m.signOut())")
        wait_for(lambda: (ls_get(page, "tvp.on") or {}).get("stu1", {}).get("token") == "", timeout=10)
        check("signing out removes this browser's token — the next person on this browser gets nothing of this student's", (ls_get(page, "tvp.on") or {}).get("stu1", {}).get("token") == "" and page.evaluate("window.__FCM.deleted") >= 1, str(ls_get(page, "tvp.on")))
        check("no page errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        # ------------------------------------------------------------------ L. the REAL service worker in a real browser
        print("\n[L] The real service worker (firebase-messaging-sw.js) in a real browser")
        # A headless test browser cannot display system notifications, so the one call that would draw it
        # (registration.showNotification) is recorded INSIDE the real worker; everything the worker itself decides — what to draw,
        # for whom, with which destination — is the real file running in a real service-worker runtime.
        ERR.clear()
        ctx = make_context(browser, VIEWPORTS["desktop"], user=None)
        page = new_page(ctx, ERR)
        page.goto(f"{BASE}/firebase-messaging-sw.js")           # a visible page of this site that is not a student page (like the admin panel)
        reg_state = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope', updateViaCache: 'none' });
          for (let i = 0; i < 100 && !(reg.active && reg.active.state === 'activated'); i++) await new Promise((r) => setTimeout(r, 100));
          return reg.active ? reg.active.state : 'none';
        }""")
        check("the real worker installs and activates in Chromium (no syntax or runtime error at start-up)", reg_state == "activated", str(reg_state))
        cdp = ctx.new_cdp_session(page)
        scopes = {}      # scope URL → DevTools registration id (the student pages register the site's own thin worker too — never mix them up)
        cdp.on("ServiceWorker.workerRegistrationUpdated", lambda e: scopes.update({r["scopeURL"]: r["registrationId"] for r in e["registrations"]}))
        cdp.on("ServiceWorker.workerErrorReported", lambda e: ERR.append(f"worker error: {e}"))
        cdp.send("ServiceWorker.enable")
        OUR_SCOPE = f"{BASE}/firebase-cloud-messaging-push-scope"
        wait_for(lambda: OUR_SCOPE in scopes, timeout=5, page=page)
        rids = [scopes[OUR_SCOPE]] if OUR_SCOPE in scopes else []
        worker = next((w for w in ctx.service_workers if w.url.endswith("firebase-messaging-sw.js")), None)
        check("the test can reach the worker", bool(rids) and worker is not None, str((scopes, [w.url for w in ctx.service_workers])))
        if rids and worker is not None:
            worker.evaluate("""() => { self.__shown = [];
              self.registration.showNotification = async (title, options) => { self.__shown.push({ title, options: JSON.parse(JSON.stringify(options || {})) }); }; }""")

            def push(data, raw=None):
                cdp.send("ServiceWorker.deliverPushMessage", {"origin": BASE, "registrationId": rids[0], "data": raw if raw is not None else json.dumps({"data": data})})

            def shown():
                return worker.evaluate("() => self.__shown")

            def settle(n, timeout=6):
                return wait_for(lambda: len(shown()) >= n, timeout=timeout, page=page)

            push({"nid": "nid_sw000001", "title": "পরীক্ষা শুরু হচ্ছে", "body": "আজ রাত ৮টায় মডেল টেস্ট।", "url": "#/exams", "cat": "exam", "ts": str(NOW)})
            settle(1)
            got = shown()
            o = got[0]["options"] if got else {}
            check("a push reaches the worker and it draws the notification (only a non-student page is open)", len(got) == 1 and got[0]["title"] == "পরীক্ষা শুরু হচ্ছে" and o.get("body", "").startswith("আজ রাত"), str(got))
            check("…with the site's icon and badge, Bengali language and the server's time", o.get("icon", "").endswith("assets/pwa/icon-192.png") and o.get("badge", "").endswith("assets/push/badge-72.png") and o.get("lang") == "bn" and o.get("timestamp") == NOW, str(o))
            check("…a tag for de-duplication and a destination inside the site", o.get("tag") == "tvp-nid_sw000001" and o.get("data", {}).get("url") == "#/exams" and o.get("data", {}).get("cat") == "exam", str(o))
            check("…and, being new to this device, it may make a sound", o.get("silent") is False, str(o))
            push({"nid": "nid_sw000001", "title": "পরীক্ষা শুরু হচ্ছে", "body": "আজ রাত ৮টায় মডেল টেস্ট।", "url": "#/exams", "cat": "exam", "ts": str(NOW)})
            settle(2)
            got = shown()
            check("the same notification id again uses the same tag (it replaces the first) and is silent — no double ring", len(got) == 2 and got[1]["options"]["tag"] == got[0]["options"]["tag"] and got[1]["options"]["silent"] is True, str(got))
            push({"nid": "nid_sw000002", "title": "Evil", "body": "x", "url": "https://evil.example/phish", "cat": "announcement", "image": "http://insecure.example/x.png", "icon": "javascript:alert(1)"})
            settle(3)
            o = shown()[2]["options"] if len(shown()) >= 3 else {}
            check("a destination outside the site becomes Home — the worker never carries another address", o.get("data", {}).get("url") == "#/home", str(o))
            check("…an insecure picture and a non-https icon are dropped", "image" not in o and o.get("icon", "").endswith("assets/pwa/icon-192.png"), str(o))
            push({"nid": "nid_sw000004", "title": "With picture", "body": "ok", "url": "#/results?exam=live1", "cat": "result", "image": "https://example.com/pic.png", "icon": "https://example.com/i.png"})
            settle(4)
            o = shown()[3]["options"] if len(shown()) >= 4 else {}
            check("an https picture and icon are used, and a route with a query is accepted", o.get("image") == "https://example.com/pic.png" and o.get("icon") == "https://example.com/i.png" and o.get("data", {}).get("url") == "#/results?exam=live1", str(o))
            before = len(shown())
            push({"title": "no id"})
            push({"nid": "nid_sw000003", "title": ""})
            push(None, raw="this is not json")
            page.wait_for_timeout(1500)
            check("messages that are not ours (no id, no title, not JSON) draw nothing and break nothing", len(shown()) == before, str(shown()[before:]))

            # a visible STUDENT page takes the message itself (in-page banner), so the worker must not draw it a second time
            student = new_page(ctx, ERR)
            go(student, "#/home")
            student.bring_to_front()
            student.wait_for_timeout(1200)
            clients = worker.evaluate("async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => [c.url, c.visibilityState])")
            student_visible = any(u.split("#")[0].endswith("/index.html") and v == "visible" for u, v in clients)
            if student_visible:
                push({"nid": "nid_sw000005", "title": "Student page is open", "body": "banner, not a system notification", "url": "#/home", "cat": "announcement"})
                page.wait_for_timeout(1500)
                check("with a student page visible the worker steps aside (the page shows its own banner — never two copies)", len(shown()) == before, str(shown()[before:]))
            else:
                print("  - (skipped: the test browser did not report the student page as visible)", clients)
            student.close()
            page.bring_to_front()
            page.wait_for_timeout(500)
            push({"nid": "nid_sw000006", "title": "Only the admin panel is open", "body": "drawn by the worker", "url": "#/home", "cat": "announcement"})
            settle(before + 1)
            check("when no student page is open the worker draws it again", len(shown()) == before + 1 and shown()[-1]["title"] == "Only the admin panel is open", str(shown()[before:]))
        page.evaluate("navigator.serviceWorker.getRegistration('/firebase-cloud-messaging-push-scope').then((r) => r && r.unregister())")
        check("no page or worker errors", errs_ok(), str(ERR[:3]))
        ctx.close()

        browser.close()
finally:
    proc.kill()

sys.exit(finish())
