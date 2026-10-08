"""Shared end-to-end harness: static server, in-memory Firebase SDK, fake clock, check()/assert helpers."""
import json, os, subprocess, sys, time, datetime, email.utils, socketserver, threading, http.server
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
import fixtures

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
SHOTS = "--shots" in sys.argv
SHOT_DIR = "/home/claude/shots"
os.makedirs(SHOT_DIR, exist_ok=True)

NOW = int(datetime.datetime(2026, 10, 6, 4, 0, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)  # 10:00 in Dhaka
T0 = time.time()
advance = [0]      # ms the fake clock has been fast-forwarded (so the fake "server" keeps up)
device_skew = [0]  # ms the DEVICE clock is ahead of the server (for the wrong-clock scenario)


def server_ms():
    return NOW + (time.time() - T0) * 1000 + advance[0]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

passed, failed = [], []


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else f"   ← {detail}"))


def make_context(browser, viewport, skew_ms=0, seed=None, user="stu1", deny=None):
    global T0
    T0 = time.time()      # every scenario starts its own "server clock" at NOW
    advance[0] = 0
    ctx = browser.new_context(viewport=viewport, timezone_id="Asia/Dhaka", locale="en-US", device_scale_factor=1)
    device_skew[0] = skew_ms
    seed = seed if seed is not None else fixtures.build(NOW)
    mock_user = {"uid": user, "email": "stu@example.com", "displayName": "Abdullah Rahman", "providerData": [{"providerId": "password"}], "emailVerified": True} if user else None
    ctx.add_init_script(f"window.__MOCK__ = {{ seed: {json.dumps(seed)}, user: {json.dumps(mock_user)}, deny: {json.dumps(deny or [])} }};")

    def handler(route, request):
        url = request.url
        if url.startswith("https://www.gstatic.com/firebasejs/10.13.0/"):
            name = url.rsplit("/", 1)[1].split("?")[0]
            body = open(os.path.join(HERE, "mock", name), encoding="utf-8").read()
            return route.fulfill(status=200, content_type="text/javascript", body=body, headers={"access-control-allow-origin": "*"})
        if url.startswith(BASE):
            if request.method == "HEAD":
                return route.fulfill(status=200, headers={"date": email.utils.formatdate(server_ms() / 1000, usegmt=True)})
            return route.continue_()
        ct = "text/css" if ("css" in url or "fonts.googleapis" in url) else "text/plain"
        return route.fulfill(status=200, content_type=ct, body="", headers={"access-control-allow-origin": "*"})
    ctx.route("**/*", handler)
    return ctx


def new_page(ctx, errors):
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)
    return page


def go(page, hash_):
    page.goto(f"{BASE}/index.html{hash_}")
    page.wait_for_load_state("domcontentloaded")


def no_overflow(page):
    return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def reads(page):
    return page.evaluate("window.__MOCK__.reads.slice()")


def writes(page):
    return page.evaluate("window.__MOCK__.writes.slice()")


def shot(page, name, full=True):
    if SHOTS:
        page.screenshot(path=f"{SHOT_DIR}/{name}.png", full_page=full)



VIEWPORTS = {"mobile": {"width": 390, "height": 844}, "tablet": {"width": 820, "height": 1180}, "desktop": {"width": 1366, "height": 850}}


def install_clock(ctx, offset_ms=0):
    ctx.clock.install(time=datetime.datetime.fromtimestamp((NOW + offset_ms) / 1000, tz=datetime.timezone.utc))


def finish():
    httpd.shutdown()
    print(f"\n{len(passed)} passed, {len(failed)} failed")
    if failed:
        print("FAILED:\n  - " + "\n  - ".join(failed))
    return 1 if failed else 0
