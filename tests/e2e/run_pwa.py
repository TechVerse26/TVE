"""End-to-end checks for the "Install app" experience (header icon → preview popup → real install prompt) and the PWA plumbing
   (manifest, icons, service worker, offline page) against the in-memory Firebase harness. The browser's own install prompt cannot be
   driven from automation, so a synthetic `beforeinstallprompt` event (same shape as the real one) stands in for it.
   python3 tests/e2e/run_pwa.py [--shots]      → exit code 0 = all checks passed
"""
import sys, os, re, json, zlib, struct
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
from playwright.sync_api import sync_playwright

SHOT_URL = "https://shots.example/phone.png"
WIDE_URL = "https://shots.example/wide.png"
BAD_URL = "https://shots.example/missing.png"
DESC = "Your exams, practice sessions, and results — all in one convenient app experience."


def png(w, h, rgb=(21, 88, 224)):
    """A solid-colour PNG of exactly w × h pixels (no imaging library needed)."""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


IMAGES = {SHOT_URL: (200, png(540, 1170)), WIDE_URL: (200, png(1200, 700)), BAD_URL: (404, b"nope")}
COUNT_LISTENERS = """(() => { window.__lst = {}; const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, ...r) { if (this === window && ['beforeinstallprompt','appinstalled','tve:bip','tve:installed'].includes(t)) window.__lst[t] = (window.__lst[t] || 0) + 1; return add.call(this, t, ...r); }; })();"""
FAKE_PROMPT = """window.__fireBip = () => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  window.__bip = { prompts: 0, resolve: null };
  e.prompt = () => { window.__bip.prompts++; return Promise.resolve(); };
  e.userChoice = new Promise((res) => { window.__bip.resolve = res; });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};"""
STANDALONE = """(() => { const orig = window.matchMedia.bind(window);
  window.matchMedia = (q) => { const l = orig(q); if (/display-mode:\\s*standalone/.test(q)) Object.defineProperty(l, 'matches', { value: true }); return l; }; })();"""
UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
UA_ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
UA_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0"


def config_js(url, alt="Custom screenshot of the app"):
    return f"export const PWA_PREVIEW_IMAGE_URL = {json.dumps(url)};\nexport const PWA_PREVIEW_IMAGE_ALT = {json.dumps(alt)};\n"


def open_page(ctx, errors, hash_="#/home", config=None, requests=None):
    page = new_page(ctx, errors)
    page.route(re.compile(r"https://shots\.example/.*"), lambda r: r.fulfill(status=IMAGES[r.request.url][0], content_type="image/png", body=IMAGES[r.request.url][1]))
    if requests is not None:
        page.on("request", lambda rq: requests.append(rq.url) if rq.url.startswith("https://shots.example/") else None)
    if config is not None:
        page.route(f"{BASE}/js/pwa-config.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=config))
    go(page, hash_)
    page.wait_for_selector(".topnav .nav-install", state="attached", timeout=8000)
    page.wait_for_function("window.__tvePwaInstallReady === true", timeout=8000)
    return page


def rect(page, sel):
    return page.evaluate("""(s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }""", sel)


def open_popup(page, via="click"):
    if via == "click":
        page.click(".topnav .nav-install")
    else:
        page.evaluate("document.querySelector('.nav-install').click()")
    page.wait_for_selector(".pwa-overlay.is-open", timeout=4000)
    page.wait_for_timeout(380)           # let the open transition finish before measuring


def close_popup(page):
    page.keyboard.press("Escape")
    page.wait_for_selector(".pwa-overlay:not(.is-open)", state="attached", timeout=3000)
    page.wait_for_timeout(300)


def is_open(page):
    return page.evaluate("!!document.querySelector('.pwa-overlay.is-open')")


STYLE_KEYS = ["borderTopWidth", "borderTopStyle", "borderTopLeftRadius", "borderTopColor", "backgroundColor", "color", "fontSize", "boxShadow"]
HEADER_JS = """(keys) => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, top: b.top, left: b.left }; };
  const st = (el) => { const c = getComputedStyle(el); return keys.map((k) => c[k]).join('|'); };
  const i = q('.nav-install'), s = q('.nav-schedule'), b = q('.nav-bell');
  const sVisible = s && getComputedStyle(s).display !== 'none';
  return { install: r(i), schedule: sVisible ? r(s) : null, bell: b ? r(b) : null, iStyle: st(i), sStyle: sVisible ? st(s) : null, bStyle: b ? st(b) : null,
    afterSchedule: s ? s.nextElementSibling === i : null, nextClass: i.nextElementSibling ? i.nextElementSibling.className : '',
    brand: r(q('.brand--lockup')), navH: q('.topnav').getBoundingClientRect().height, scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    label: i.getAttribute('aria-label'), title: i.getAttribute('title'), tag: i.tagName, type: i.getAttribute('type'), popup: i.getAttribute('aria-haspopup'),
    touch: getComputedStyle(i).touchAction, count: document.querySelectorAll('.nav-install').length };
}"""


def header(page):
    return page.evaluate(HEADER_JS, STYLE_KEYS)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    all_errors = []

    # ------------------------------------------------------------------ 1. Header icon — size, alignment, parity with Schedule / Notifications
    print("\n[1] Header icon — identical to the Schedule icon, header untouched")
    errors = []
    ctx = make_context(browser, {"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    page = open_page(ctx, errors)
    h = header(page)
    check("exactly one install icon in the bar", h["count"] == 1, str(h["count"]))
    check("it is a real <button type=button> with a dialog popup hint", h["tag"] == "BUTTON" and h["type"] == "button" and h["popup"] == "dialog")
    check("phone: 44×44 like the Schedule icon", (round(h["install"]["w"]), round(h["install"]["h"])) == (44, 44) == (round(h["schedule"]["w"]), round(h["schedule"]["h"])), f"{h['install']} vs {h['schedule']}")
    check("phone: same border / radius / colours / font as Schedule", h["iStyle"] == h["sStyle"], f"{h['iStyle']} vs {h['sStyle']}")
    check("phone: vertically aligned with Schedule", abs(h["install"]["top"] - h["schedule"]["top"]) < 0.6, f"{h['install']['top']} vs {h['schedule']['top']}")
    check("sits directly after Schedule, right before Notifications", h["afterSchedule"] is True and "nav-bell-wrap" in h["nextClass"], h["nextClass"])
    check("aria-label + tooltip + touch-action", "Install" in h["label"] and h["title"] == "Install app" and h["touch"] == "manipulation", str((h["label"], h["title"], h["touch"])))
    check("header height stays 56px, no horizontal overflow", round(h["navH"]) == 56 and h["scrollW"] <= h["vw"], str((h["navH"], h["scrollW"])))
    shot(page, "pwa-header-mobile", full=False)
    page.evaluate("document.querySelector('.nav-install').style.display='none'")
    h0 = header(page)
    check("logo lockup identical with or without the icon (390px)", abs(h0["brand"]["w"] - h["brand"]["w"]) < 0.5 and abs(h0["brand"]["h"] - h["brand"]["h"]) < 0.5, f"{h0['brand']} vs {h['brand']}")
    ctx.close()

    for w in (320, 340, 360, 375, 412):          # the narrow phones where room had to be found
        ctx = make_context(browser, {"width": w, "height": 800})
        page = open_page(ctx, errors)
        h = header(page)
        ok = h["brand"]["h"] <= 45 and h["scrollW"] <= h["vw"] and round(h["navH"]) == 56 and (round(h["install"]["w"]), round(h["install"]["h"])) == (44, 44)
        check(f"{w}px: logo not squeezed or wrapped, icon 44×44, no overflow, bar 56px", ok, str((h["brand"], h["scrollW"], h["navH"], h["install"])))
        if w >= 360:
            check(f"{w}px: logo exactly as designed (139.5px wide)", abs(h["brand"]["w"] - 139.5) < 0.6, str(h["brand"]["w"]))
        ctx.close()

    ctx = make_context(browser, VIEWPORTS["desktop"])
    page = open_page(ctx, errors)
    h = header(page)
    check("desktop: 40×40 like the other header icons", (round(h["install"]["w"]), round(h["install"]["h"])) == (40, 40) == (round(h["bell"]["w"]), round(h["bell"]["h"])), f"{h['install']} vs {h['bell']}")
    check("desktop: same border / radius / colours / font as Notifications", h["iStyle"] == h["bStyle"], f"{h['iStyle']} vs {h['bStyle']}")
    check("desktop: vertically aligned with Notifications", abs(h["install"]["top"] - h["bell"]["top"]) < 0.6)
    check("desktop: bar stays 64px, no overflow", round(h["navH"]) == 64 and h["scrollW"] <= h["vw"], str((h["navH"], h["scrollW"])))
    page.hover(".nav-bell"); page.wait_for_timeout(250)
    bell_hover = page.evaluate("(() => { const c = getComputedStyle(document.querySelector('.nav-bell')); return [c.borderTopColor, c.color, c.backgroundColor].join('|'); })()")
    page.hover(".nav-install"); page.wait_for_timeout(250)
    inst_hover = page.evaluate("(() => { const c = getComputedStyle(document.querySelector('.nav-install')); return [c.borderTopColor, c.color, c.backgroundColor].join('|'); })()")
    check("desktop: hover effect identical to the other header icons", bell_hover == inst_hover, f"{bell_hover} vs {inst_hover}")
    shot(page, "pwa-header-desktop", full=False)
    ctx.close()

    ctx = make_context(browser, {"width": 390, "height": 844}, user=None)
    page = open_page(ctx, errors, "#/login")
    h = header(page)
    check("signed-out visitors get the icon too (44×44, before Login)", h["count"] == 1 and round(h["install"]["w"]) == 44 and "nav-login" in h["nextClass"], str((h["count"], h["nextClass"])))
    check("signed-out: header unchanged in height, no overflow", round(h["navH"]) == 56 and h["scrollW"] <= h["vw"])
    ctx.close()
    all_errors += errors
    check("no JS errors while the header renders", not errors, str(errors[:3]))

    # ------------------------------------------------------------------ 2. Popup — open / close / focus / scroll lock / accessibility
    print("\n[2] Popup — behaviour and accessibility")
    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    ctx.add_init_script("window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true);")   # deterministic: no real prompt → manual-steps mode
    page = open_page(ctx, errors)
    check("nothing is built before the first click (lazy)", page.locator(".pwa-overlay").count() == 0)
    page.focus(".nav-install"); page.keyboard.press("Enter")
    page.wait_for_selector(".pwa-overlay.is-open", timeout=4000); page.wait_for_timeout(380)
    check("opens from the keyboard (Enter) — no page change", page.evaluate("location.hash") == "#/home" and is_open(page))
    d = page.evaluate("""() => { const dlg = document.querySelector('.pwa-dialog'); const t = document.getElementById(dlg.getAttribute('aria-labelledby')), s = document.getElementById(dlg.getAttribute('aria-describedby'));
      return { role: dlg.getAttribute('role'), modal: dlg.getAttribute('aria-modal'), title: t && t.textContent, desc: s && s.textContent, name: document.querySelector('.pwa-app-name').textContent,
        benefits: [...document.querySelectorAll('.pwa-benefits li')].map((li) => li.textContent.trim()), inDialog: dlg.contains(document.activeElement), closeLabel: document.querySelector('.pwa-close').getAttribute('aria-label'),
        overflow: document.body.style.overflow, lock: document.documentElement.classList.contains('pwa-lock'), navInert: document.getElementById('topnav-root').inert, pageInert: document.getElementById('page-exam').inert,
        steps: document.querySelectorAll('.pwa-steps li').length, guideTitle: document.querySelector('.pwa-guide-title').textContent, primary: document.querySelector('.pwa-primary').textContent.trim(),
        laterHidden: document.querySelector('.pwa-later').hidden, host: document.querySelector('.pwa-app-host').textContent, overlays: document.querySelectorAll('.pwa-overlay').length }; }""")
    check("dialog semantics: role=dialog, aria-modal, labelled + described", d["role"] == "dialog" and d["modal"] == "true" and d["title"] == "Install Tech Verse Exam" and d["desc"] == DESC, str((d["role"], d["title"], d["desc"])))
    check("app name TECH VERSE EXAM + host line", d["name"] == "TECH VERSE EXAM" and d["host"] == "127.0.0.1:8765", str((d["name"], d["host"])))
    check("benefit row: Fast Access · Secure · Lightweight", d["benefits"] == ["Fast Access", "Secure", "Lightweight"], str(d["benefits"]))
    check("focus moved into the dialog; close button is labelled", d["inDialog"] and d["closeLabel"] == "Close")
    check("page scroll locked, background inert while open", d["overflow"] == "hidden" and d["lock"] and d["navInert"] and d["pageInert"])
    check("no native prompt available → browser steps shown, button says Got it (no fake Install)", d["steps"] >= 2 and d["guideTitle"] and d["primary"] == "Got it" and d["laterHidden"], str((d["steps"], d["primary"])))
    check("one popup only", d["overlays"] == 1)
    check("popup sits on top of the header (hit-test at the header icon is the backdrop)", page.evaluate("document.elementFromPoint(970, 32).classList.contains('pwa-overlay')"))

    ring = []
    for _ in range(9):
        page.keyboard.press("Tab"); ring.append(page.evaluate("document.querySelector('.pwa-dialog').contains(document.activeElement)"))
    for _ in range(9):
        page.keyboard.press("Shift+Tab"); ring.append(page.evaluate("document.querySelector('.pwa-dialog').contains(document.activeElement)"))
    check("Tab / Shift+Tab never leave the dialog (focus trap)", all(ring), str(ring))

    page.keyboard.press("Escape"); page.wait_for_timeout(350)
    after = page.evaluate("({ open: !!document.querySelector('.pwa-overlay.is-open'), hidden: document.querySelector('.pwa-overlay').hidden, overflow: document.body.style.overflow, lock: document.documentElement.classList.contains('pwa-lock'), inert: document.getElementById('topnav-root').inert, focus: document.activeElement.classList.contains('nav-install') })")
    check("Escape closes it, scroll + inert restored, focus returns to the header icon", not after["open"] and after["hidden"] and after["overflow"] == "" and not after["lock"] and not after["inert"] and after["focus"], str(after))

    open_popup(page); page.click(".pwa-close"); page.wait_for_timeout(350)
    check("close (X) button closes", not is_open(page))
    open_popup(page); page.mouse.click(8, 8); page.wait_for_timeout(350)
    check("click outside (on the backdrop) closes", not is_open(page))
    open_popup(page)
    c = rect(page, ".pwa-dialog")
    page.mouse.move(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2); page.mouse.down(); page.mouse.move(8, 8, steps=4); page.mouse.up(); page.wait_for_timeout(300)
    check("dragging from inside the dialog to the backdrop does NOT close it", is_open(page))
    page.click(".pwa-primary"); page.wait_for_timeout(350)
    check("'Got it' closes", not is_open(page))
    open_popup(page); page.evaluate("location.hash = '#/exams'"); page.wait_for_timeout(500)
    check("navigating away closes it and leaves the page scrollable", not is_open(page) and page.evaluate("document.body.style.overflow") == "")
    page.evaluate("document.querySelector('.nav-install').click(); document.querySelector('.nav-install').click()"); page.wait_for_timeout(380)
    check("rapid double activation still builds one popup", page.locator(".pwa-overlay").count() == 1)
    close_popup(page)
    page.evaluate("document.body.classList.add('exam-taking')")
    hidden_in_exam = page.evaluate("getComputedStyle(document.querySelector('.nav-install')).display") == "none"
    page.evaluate("document.querySelector('.nav-install').click()"); page.wait_for_timeout(300)
    check("during a live exam the icon is hidden and the popup refuses to open", hidden_in_exam and not is_open(page))
    all_errors += errors
    check("no JS errors during popup interactions", not errors, str(errors[:3]))
    ctx.close()

    errors = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    page = open_page(ctx, errors)
    page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=8000); page.wait_for_timeout(500)
    page.mouse.move(600, 500); page.mouse.wheel(0, 300); page.wait_for_timeout(250)
    y0 = page.evaluate("window.scrollY")
    open_popup(page)
    page.mouse.move(40, 500); page.mouse.wheel(0, 400); page.wait_for_timeout(300)
    y1 = page.evaluate("window.scrollY")
    close_popup(page)
    y2 = page.evaluate("window.scrollY")
    page.mouse.move(600, 500); page.mouse.wheel(0, 200); page.wait_for_timeout(300)
    y3 = page.evaluate("window.scrollY")
    check("page cannot be scrolled with the wheel while the popup is open; position kept on close; scrolling works again after", y0 > 0 and y1 == y0 and y2 == y0 and y3 > y0, str((y0, y1, y2, y3)))
    ctx.close()

    ctx = make_context(browser, VIEWPORTS["desktop"], reduced_motion="reduce")
    page = open_page(ctx, errors)
    open_popup(page)
    dur = page.evaluate("getComputedStyle(document.querySelector('.pwa-dialog')).transitionDuration")
    page.keyboard.press("Escape"); page.wait_for_timeout(30)
    check("prefers-reduced-motion: no transition, closes instantly", dur in ("0s", "0.0s") and page.evaluate("document.querySelector('.pwa-overlay').hidden"), dur)
    ctx.close()

    # ------------------------------------------------------------------ 3. Popup layout on real screen sizes
    print("\n[3] Popup layout — desktop, phones, tiny phones, landscape")
    errors = []

    def layout(viewport, name, ready=True, **kw):
        ctx = make_context(browser, viewport, **kw)
        page = open_page(ctx, errors, config=config_js(SHOT_URL), requests=None)
        if ready:
            page.evaluate(FAKE_PROMPT + "; window.__fireBip();")
        open_popup(page, via="eval" if viewport["width"] < 700 else "click")
        page.wait_for_function("document.querySelector('.pwa-shot').classList.contains('is-loaded')", timeout=5000)
        page.wait_for_timeout(200)
        m = page.evaluate("""() => { const R = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
          const dlg = document.querySelector('.pwa-dialog');
          return { dlg: R('.pwa-dialog'), prev: R('.pwa-preview'), info: R('.pwa-info'), img: R('.pwa-shot-img'), btn: R('.pwa-primary'), vw: innerWidth, vh: innerHeight,
                   dlgScrollW: dlg.scrollWidth, dlgClientW: dlg.clientWidth, dlgScrollH: dlg.scrollHeight, dlgClientH: dlg.clientHeight, docScrollW: document.documentElement.scrollWidth,
                   ar: document.querySelector('.pwa-shot-img').naturalWidth / document.querySelector('.pwa-shot-img').naturalHeight, mode: document.querySelector('.pwa-overlay').dataset.mode }; }""")
        shot(page, f"pwa-popup-{name}", full=False)
        return ctx, page, m

    ctx, page, m = layout(VIEWPORTS["desktop"], "desktop")
    check("desktop: ready mode with the Install App button", m["mode"] == "ready" and page.inner_text(".pwa-primary").strip() == "Install App" and page.locator(".pwa-later").is_visible())
    check("desktop: two columns — screenshot left, info right", m["prev"]["r"] <= m["info"]["x"] + 1 and abs(m["prev"]["y"] - m["info"]["y"]) < 1, str((m["prev"], m["info"])))
    check("desktop: card is centred, ≤ 800px wide and fully on screen", 640 <= m["dlg"]["w"] <= 800 and abs((m["dlg"]["x"] + m["dlg"]["w"] / 2) - m["vw"] / 2) < 2 and m["dlg"]["y"] >= 0 and m["dlg"]["b"] <= m["vh"], str(m["dlg"]))
    check("desktop: screenshot keeps its proportions and stays inside its column", abs(m["img"]["w"] / m["img"]["h"] - m["ar"]) / m["ar"] < 0.01 and m["img"]["x"] >= m["prev"]["x"] and m["img"]["r"] <= m["prev"]["r"] and m["img"]["h"] <= 541, str((m["img"], m["ar"])))
    check("desktop: nothing clipped or scrolling sideways", m["dlgScrollW"] <= m["dlgClientW"] and m["docScrollW"] <= m["vw"])
    ctx.close()

    ctx, page, m = layout({"width": 390, "height": 844}, "phone-390", has_touch=True, is_mobile=True)
    check("phone 390: bottom sheet flush with the bottom edge, full width", abs(m["dlg"]["b"] - m["vh"]) < 1.5 and abs(m["dlg"]["w"] - m["vw"]) < 1.5, str(m["dlg"]))
    check("phone 390: screenshot beside the info + Install App", m["prev"]["r"] <= m["info"]["x"] + 1 and m["btn"]["y"] >= 0 and m["btn"]["b"] <= m["vh"], str((m["prev"], m["info"], m["btn"])))
    check("phone 390: screenshot clearly visible (≥ 110px wide) in its original proportions", m["img"]["w"] >= 110 and abs(m["img"]["w"] / m["img"]["h"] - m["ar"]) / m["ar"] < 0.01, str(m["img"]))
    check("phone 390: no horizontal scrolling or clipping", m["dlgScrollW"] <= m["dlgClientW"] and m["docScrollW"] <= m["vw"])
    ctx.close()

    ctx, page, m = layout({"width": 360, "height": 640}, "phone-360", has_touch=True, is_mobile=True)
    check("phone 360×640: stacks (screenshot above the info) and the popup fits the screen", m["info"]["y"] >= m["prev"]["b"] - 1 and m["dlg"]["y"] >= 0 and m["dlg"]["b"] <= m["vh"] + 1, str((m["prev"], m["info"], m["dlg"])))
    check("phone 360: screenshot still clearly visible (≥ 100px wide)", m["img"]["w"] >= 100, str(m["img"]))
    page.locator(".pwa-primary").scroll_into_view_if_needed(); page.wait_for_timeout(100)
    b = rect(page, ".pwa-primary")
    check("phone 360: the Install App button is reachable (scrolls inside the popup)", b["y"] >= 0 and b["b"] <= 641, str(b))
    check("phone 360: no horizontal scrolling", m["dlgScrollW"] <= m["dlgClientW"] and m["docScrollW"] <= m["vw"])
    ctx.close()

    ctx, page, m = layout({"width": 320, "height": 568}, "phone-320", has_touch=True, is_mobile=True)
    check("phone 320×568: fits, stacked, nothing clipped sideways", m["dlgScrollW"] <= m["dlgClientW"] and m["docScrollW"] <= m["vw"] and m["dlg"]["b"] <= m["vh"] + 1 and m["info"]["y"] >= m["prev"]["b"] - 1, str(m["dlg"]))
    ctx.close()

    ctx, page, m = layout({"width": 800, "height": 360}, "landscape", has_touch=True, is_mobile=True)
    check("landscape 800×360: popup stays inside the screen and scrolls inside if needed", m["dlg"]["y"] >= 0 and m["dlg"]["b"] <= m["vh"] + 1 and m["dlgScrollW"] <= m["dlgClientW"], str(m["dlg"]))
    ctx.close()
    all_errors += errors
    check("no JS errors across layouts", not errors, str(errors[:3]))

    # ------------------------------------------------------------------ 4. Screenshot link — js/pwa-config.js
    print("\n[4] Screenshot link — exact URL, proportions, graceful fallback")
    errors = []
    reqs = []
    ctx = make_context(browser, VIEWPORTS["desktop"])
    page = open_page(ctx, errors, config=config_js(SHOT_URL, "Custom alt text"), requests=reqs)
    check("the screenshot is not downloaded before the popup is opened (lazy)", SHOT_URL not in reqs, str(reqs))
    open_popup(page)
    page.wait_for_function("document.querySelector('.pwa-shot').classList.contains('is-loaded')", timeout=5000)
    s = page.evaluate("""() => { const i = document.querySelector('.pwa-shot-img'), c = getComputedStyle(i), b = i.getBoundingClientRect();
        return { src: i.getAttribute('src'), alt: i.alt, nw: i.naturalWidth, nh: i.naturalHeight, w: b.width, h: b.height, fit: c.objectFit, radius: c.borderTopLeftRadius,
                 opacity: c.opacity, border: c.borderTopWidth, shadow: c.boxShadow, fb: getComputedStyle(document.querySelector('.pwa-shot-fallback')).display, ref: i.referrerPolicy }; }""")
    check("shows exactly the configured URL, downloaded once, on first open", s["src"] == SHOT_URL and reqs.count(SHOT_URL) == 1, str((s["src"], reqs)))
    check("it is the real image (540×1170) with the alt text from the config", (s["nw"], s["nh"]) == (540, 1170) and s["alt"] == "Custom alt text")
    check("original aspect ratio kept · object-fit: contain · rounded · framed · soft shadow", abs(s["w"] / s["h"] - 540 / 1170) < 0.01 and s["fit"] == "contain" and float(s["radius"].replace("px", "")) >= 12 and s["border"] == "1px" and s["shadow"] != "none" and s["opacity"] == "1", str(s))
    check("the neutral placeholder tile disappears once the real image is in", s["fb"] == "none")
    ctx.close()

    for label, view, kw in (("desktop", VIEWPORTS["desktop"], {}), ("phone", {"width": 390, "height": 844}, {"has_touch": True, "is_mobile": True})):
        ctx = make_context(browser, view, **kw)
        page = open_page(ctx, errors, config=config_js(WIDE_URL))
        open_popup(page, via="click" if label == "desktop" else "eval")
        page.wait_for_function("document.querySelector('.pwa-shot').classList.contains('is-loaded')", timeout=5000)
        w = page.evaluate("""() => { const i = document.querySelector('.pwa-shot-img').getBoundingClientRect(), p = document.querySelector('.pwa-preview').getBoundingClientRect();
            return { ar: i.width / i.height, inside: i.left >= p.left - 0.5 && i.right <= p.right + 0.5 && i.top >= p.top - 0.5 && i.bottom <= p.bottom + 0.5, w: i.width }; }""")
        check(f"{label}: a wide 1200×700 screenshot keeps its proportions and stays inside its panel", abs(w["ar"] - 1200 / 700) < 0.02 and w["inside"], str(w))
        ctx.close()

    ctx = make_context(browser, VIEWPORTS["desktop"])
    page = open_page(ctx, errors)          # the shipped config: still the PASTE_… placeholder
    open_popup(page)
    f = page.evaluate("""() => ({ cls: document.querySelector('.pwa-shot').className, fb: getComputedStyle(document.querySelector('.pwa-shot-fallback')).display,
        img: getComputedStyle(document.querySelector('.pwa-shot-img')).display, text: document.querySelector('.pwa-shot-fallback').textContent.trim(), src: document.querySelector('.pwa-shot-img').getAttribute('src') })""")
    check("placeholder URL → calm Tech Verse tile (no image request, no made-up screenshot)", "is-fallback" in f["cls"] and f["fb"] != "none" and f["img"] == "none" and f["text"] == "Tech Verse Exam" and f["src"] is None, str(f))
    shot(page, "pwa-popup-fallback", full=False)
    ctx.close()

    ctx = make_context(browser, VIEWPORTS["desktop"])
    page = open_page(ctx, errors, config=config_js(BAD_URL))
    open_popup(page)
    page.wait_for_function("document.querySelector('.pwa-shot').classList.contains('is-fallback')", timeout=5000)
    check("a link that fails to load → the same graceful fallback", page.evaluate("getComputedStyle(document.querySelector('.pwa-shot-fallback')).display") != "none")
    ctx.close()

    # ------------------------------------------------------------------ 5. The real install flow (synthetic beforeinstallprompt)
    print("\n[5] Install flow — retained prompt · accepted / dismissed · appinstalled · no duplicates")
    ctx = make_context(browser, VIEWPORTS["desktop"])
    ctx.add_init_script(COUNT_LISTENERS)
    ctx.add_init_script(FAKE_PROMPT)
    ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { window.__early = window.__fireBip(); });")   # fires long BEFORE the app's modules finish loading
    page = open_page(ctx, errors)
    lst = page.evaluate("window.__lst")
    check("the early event was captured and the browser's own mini-prompt suppressed (preventDefault)", page.evaluate("window.__early") is True)
    check("exactly one listener per native event, no duplicates", lst.get("beforeinstallprompt") == 1 and lst.get("appinstalled") == 1 and lst.get("tve:bip") == 1 and lst.get("tve:installed") == 1, str(lst))
    page.evaluate("import('/js/pwa-install.js').then((m) => m.initPwaInstall())"); page.wait_for_timeout(200)
    check("initialising a second time adds nothing", page.evaluate("window.__lst") == lst)
    open_popup(page)
    ui = lambda: page.evaluate("""() => ({ mode: document.querySelector('.pwa-overlay').dataset.mode, primary: document.querySelector('.pwa-primary').textContent.trim(), disabled: document.querySelector('.pwa-primary').disabled,
        status: document.querySelector('.pwa-status').hidden ? '' : document.querySelector('.pwa-status').textContent.trim(), later: !document.querySelector('.pwa-later').hidden, guide: !document.querySelector('.pwa-guide').hidden,
        title: document.querySelector('.pwa-title').textContent, installed: document.documentElement.classList.contains('pwa-installed'), prompts: window.__bip.prompts,
        okIcon: getComputedStyle(document.querySelector('.nav-install-ok')).display, dlIcon: getComputedStyle(document.querySelector('.nav-install-ico')).display, aria: document.querySelector('.nav-install').getAttribute('aria-label') })""")
    u = ui()
    check("ready: 'Install App' + 'Maybe Later', no manual steps, nothing claimed yet", u["mode"] == "ready" and u["primary"] == "Install App" and not u["disabled"] and u["later"] and not u["guide"] and not u["installed"] and u["prompts"] == 0, str(u))
    shot(page, "pwa-popup-ready", full=False)
    page.click(".pwa-primary"); page.wait_for_timeout(120)
    page.evaluate("document.querySelector('.pwa-primary').click()"); page.wait_for_timeout(60)
    u = ui()
    check("one click → the native prompt is shown exactly once (repeat clicks ignored)", u["prompts"] == 1 and u["disabled"] and u["primary"] == "Waiting…" and "Confirm" in u["status"], str(u))
    page.evaluate("window.__bip.resolve({ outcome: 'dismissed', platform: 'web' })"); page.wait_for_timeout(150)
    u = ui()
    check("dismissed: honest message, NOT marked installed, manual steps offered", u["mode"] == "guide" and "cancelled" in u["status"] and not u["installed"] and u["guide"] and u["primary"] == "Got it", str(u))
    check("screen readers are told about it through a live region", "cancelled" in page.evaluate("document.querySelector('.pwa-dialog [role=status]').textContent"))
    page.evaluate("window.__fireBip()"); page.wait_for_timeout(100)
    u = ui()
    check("the browser offers the prompt again → back to 'Install App', old message cleared", u["mode"] == "ready" and u["status"] == "" and u["primary"] == "Install App" and u["prompts"] == 0, str(u))
    page.click(".pwa-primary"); page.wait_for_timeout(100)
    page.evaluate("window.__bip.resolve({ outcome: 'accepted', platform: 'web' })"); page.wait_for_timeout(150)
    u = ui()
    check("accepted: 'Installing…' — still NOT claimed as installed until the browser confirms", u["mode"] == "installing" and "Installing" in u["status"] and u["disabled"] and not u["installed"] and u["dlIcon"] != "none" and u["okIcon"] == "none", str(u))
    page.evaluate("window.dispatchEvent(new Event('appinstalled'))"); page.wait_for_timeout(150)
    u = ui()
    check("appinstalled: success state in the popup", u["mode"] == "installed" and u["installed"] and "installed" in u["title"] and u["primary"] == "Done" and "home screen" in u["status"] and not u["later"], str(u))
    check("appinstalled: header icon turns into a check, label updates", u["okIcon"] != "none" and u["dlIcon"] == "none" and u["aria"] == "Tech Verse Exam is installed", str(u))
    shot(page, "pwa-popup-installed", full=False)
    page.click(".pwa-primary"); page.wait_for_timeout(350)
    check("'Done' closes; re-opening shows the installed state again", not is_open(page) and (open_popup(page) or True) and ui()["mode"] == "installed")
    ctx.close()

    ctx = make_context(browser, VIEWPORTS["desktop"])
    ctx.add_init_script(FAKE_PROMPT)
    H.install_clock(ctx)
    page = open_page(ctx, errors)
    page.evaluate("window.__fireBip()")
    open_popup(page)
    page.click(".pwa-primary"); page.wait_for_timeout(100)
    page.evaluate("window.__bip.resolve({ outcome: 'accepted' })"); page.wait_for_timeout(100)
    page.clock.fast_forward(9000); page.wait_for_timeout(150)
    u = ui()
    check("accepted but no 'appinstalled' after a while: neutral message, still not marked installed, can be closed", "Installation started" in u["status"] and not u["installed"] and u["primary"] == "Done" and not u["disabled"], str(u))
    ctx.close()

    # ------------------------------------------------------------------ 6. Installed app · standalone · guidance per browser
    print("\n[6] Standalone mode, already-installed detection, browser-specific steps")
    phone = {"width": 390, "height": 844}
    ctx = make_context(browser, phone, has_touch=True, is_mobile=True)
    ctx.add_init_script(STANDALONE)
    page = open_page(ctx, errors)
    s = page.evaluate("({ cls: document.documentElement.classList.contains('pwa-standalone'), display: getComputedStyle(document.querySelector('.nav-install')).display, navH: document.querySelector('.topnav').getBoundingClientRect().height, sw: document.documentElement.scrollWidth })")
    check("running as the installed app (display-mode: standalone): icon hidden, bar unchanged", s["cls"] and s["display"] == "none" and round(s["navH"]) == 56 and s["sw"] <= 390, str(s))
    ctx.close()

    ctx = make_context(browser, phone, has_touch=True, is_mobile=True)
    ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: true });")
    page = open_page(ctx, errors)
    check("iOS Home-Screen app (navigator.standalone): icon hidden", page.evaluate("getComputedStyle(document.querySelector('.nav-install')).display") == "none")
    ctx.close()

    ctx = make_context(browser, phone, has_touch=True, is_mobile=True)
    ctx.add_init_script("navigator.getInstalledRelatedApps = async () => [{ platform: 'webapp', url: location.origin + '/manifest.webmanifest' }];")
    page = open_page(ctx, errors)
    page.wait_for_function("document.documentElement.classList.contains('pwa-installed')", timeout=4000)
    open_popup(page, via="eval")
    u = page.evaluate("({ title: document.querySelector('.pwa-title').textContent, primary: document.querySelector('.pwa-primary').textContent.trim(), steps: !document.querySelector('.pwa-guide').hidden, aria: document.querySelector('.nav-install').getAttribute('aria-label') })")
    check("app already installed (found via the browser) and opened in a tab → 'is installed' state, no install button", "installed" in u["title"] and u["primary"] == "Done" and not u["steps"] and "installed" in u["aria"], str(u))
    ctx.close()

    def guide_for(name, ua, mobile, text_all, text_none=None, **kw):
        ctx = make_context(browser, phone if mobile else VIEWPORTS["desktop"], user_agent=ua, has_touch=mobile, is_mobile=mobile)
        ctx.add_init_script("window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true);")
        page = open_page(ctx, errors)
        open_popup(page, via="eval")
        g = page.evaluate("({ text: document.querySelector('.pwa-guide').innerText, primary: document.querySelector('.pwa-primary').textContent.trim(), title: document.querySelector('.pwa-guide-title').textContent, shown: !document.querySelector('.pwa-guide').hidden, fakeSuccess: /installed/i.test(document.querySelector('.pwa-status').textContent) })")
        ok = g["shown"] and all(t in g["text"] for t in text_all) and (not text_none or all(t not in g["text"] for t in text_none)) and g["primary"] == "Got it" and not g["fakeSuccess"]
        check(f"{name}: steps shown, no Install button, no fake success", ok, str(g))
        shot(page, f"pwa-guide-{name.split()[0].lower()}", full=False)
        ctx.close()

    guide_for("iPhone Safari", UA_IPHONE, True, ["Share", "Add to Home Screen"])
    guide_for("Android Chrome", UA_ANDROID, True, ["Install app"])
    guide_for("Firefox desktop", UA_FIREFOX, False, ["Chrome", "Edge"])

    all_errors += errors
    check("no JS errors in the install flow scenarios", not errors, str(errors[:3]))

    # ------------------------------------------------------------------ 7. Manifest, icons, service worker, offline page
    print("\n[7] Manifest · icons · service worker · offline fallback")
    errors = []
    ctx = make_context(browser, phone)
    page = open_page(ctx, errors)
    mf = page.evaluate("""async () => {
        const link = document.querySelector('link[rel="manifest"]'); const res = await fetch(link.href); const m = JSON.parse(await res.text()); const icons = [];
        for (const ic of m.icons) { const u = new URL(ic.src, link.href).href; const r = await fetch(u); const bmp = await createImageBitmap(await r.blob()); icons.push([ic.src, r.status, bmp.width + 'x' + bmp.height, ic.sizes, ic.purpose]); }
        const apple = document.querySelector('link[rel="apple-touch-icon"]'); const ar = await fetch(apple.href);
        return { href: link.href, status: res.status, name: m.name, short: m.short_name, display: m.display, start: new URL(m.start_url, link.href).href, scope: new URL(m.scope, link.href).href, id: m.id,
                 theme: m.theme_color, icons, apple: ar.status, metaTheme: document.querySelector('meta[name="theme-color"]').content }; }""")
    check("manifest loads from the site root and names the app correctly", mf["href"] == BASE + "/manifest.webmanifest" and mf["status"] == 200 and mf["name"] == "Tech Verse Exam" and mf["short"] == "Tech Verse", str(mf))
    check("standalone display, start_url + scope = the site root, navy theme matches <meta theme-color>", mf["display"] == "standalone" and mf["start"] == BASE + "/" and mf["scope"] == BASE + "/" and mf["theme"].lower() == mf["metaTheme"].lower(), str((mf["start"], mf["scope"], mf["theme"], mf["metaTheme"])))
    check("every icon URL loads (200) at its declared size — 192/512 any + maskable", all(i[1] == 200 and i[2] == i[3] for i in mf["icons"]) and {(i[3], i[4]) for i in mf["icons"]} >= {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")}, str(mf["icons"]))
    check("Apple touch icon loads", mf["apple"] == 200)

    sw = page.evaluate("""async () => { const reg = await navigator.serviceWorker.ready; return { scope: reg.scope, script: reg.active && reg.active.scriptURL, state: reg.active && reg.active.state, ucache: reg.updateViaCache }; }""")
    check("service worker registered at the root scope and activated", sw["scope"] == BASE + "/" and sw["script"] == BASE + "/service-worker.js" and sw["state"] == "activated", str(sw))
    check("worker file is always re-checked (updateViaCache: none)", sw["ucache"] == "none")
    page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=5000)
    page.goto(f"{BASE}/index.html?second=1#/home"); page.wait_for_selector(".topnav .nav-install", state="attached", timeout=8000); page.wait_for_timeout(600)
    cached = page.evaluate("""async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); return out; }""")
    paths = [p for v in cached.values() for p in v]
    bad = [p for p in paths if p != "/offline.html" and not (p.startswith("/assets/") and re.search(r"\.(png|svg|ico|jpe?g|webp|gif)$", p))]
    check("the only things ever stored: offline.html + logo/icon images — no page, script, style or data", "/offline.html" in paths and not bad and all(k.startswith("tve-") for k in cached), str(cached))
    check("pages, scripts and styles still come fresh from the network (nothing of them is cached)", not any(p.endswith((".js", ".css", ".json")) or p in ("/", "/index.html") for p in paths))
    head = page.evaluate("fetch(location.pathname, { method: 'HEAD', cache: 'no-store' }).then((r) => r.headers.get('date'))")
    check("the server-clock HEAD request still passes straight through the worker", head is not None)
    cross = page.evaluate("fetch('https://example.invalid/x').then(() => 'ok', () => 'blocked-by-harness')")
    check("cross-origin traffic is untouched by the worker (reaches the normal network layer)", cross in ("ok", "blocked-by-harness"))

    ctx.set_offline(True)
    off = ctx.new_page()
    off.goto(f"{BASE}/index.html?offline=1#/home"); off.wait_for_load_state("domcontentloaded")
    t = off.title()
    check("offline: the friendly fallback page appears instead of a browser error", t.startswith("You're offline") and off.locator("#retry").count() == 1 and "internet connection" in off.inner_text("main"), t)
    check("offline page is complete (brand mark, no horizontal scroll at 390px)", off.locator("svg.mark").count() == 1 and off.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    shot(off, "pwa-offline", full=False)
    off.click("#retry"); off.wait_for_load_state("domcontentloaded"); off.wait_for_timeout(500)
    check("offline + 'Try again' → still the friendly page (no crash, no blank screen)", off.title().startswith("You're offline") and off.locator("#retry").count() == 1)
    ctx.set_offline(False)
    off.wait_for_selector(".topnav .nav-install", state="attached", timeout=15000)
    check("connection restored → the page reloads itself into the real app", off.locator(".topnav").count() == 1)
    ctx.close()
    all_errors += errors
    check("no JS errors while registering the worker", not errors, str(errors[:3]))

    # ------------------------------------------------------------------ 8. Everything that was there before still works
    print("\n[8] Existing header features untouched")
    errors = []
    ctx = make_context(browser, phone, has_touch=True, is_mobile=True)
    page = open_page(ctx, errors)
    page.click(".nav-schedule"); page.wait_for_function("location.hash.startsWith('#/schedule')", timeout=4000)
    check("Schedule icon still goes to the schedule page", True)
    page.click(".nav-bell"); page.wait_for_timeout(250)
    check("Notifications bell still opens", page.get_attribute(".nav-bell", "aria-expanded") == "true")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.click(".nav-menu-btn"); page.wait_for_selector(".nav-drawer.open", timeout=3000)
    check("menu (avatar) button still opens the drawer", page.locator(".nav-drawer.open").count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    open_popup(page, via="eval"); close_popup(page)
    page.click(".nav-schedule"); page.wait_for_timeout(200)
    check("after using the install popup, the rest of the bar keeps working", page.evaluate("location.hash").startswith("#/schedule") and page.evaluate("document.body.style.overflow") == "")
    check("no page or console errors", not errors, str(errors[:3]))
    all_errors += errors
    ctx.close()

    browser.close()

check("no JS errors anywhere in this run", not all_errors, str(all_errors[:3]))
sys.exit(finish())
