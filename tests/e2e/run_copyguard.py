"""End-to-end checks for the exam copy guard (js/copy-guard.js), against the in-memory Firestore (no network).
   python3 tests/e2e/run_copyguard.py [--shots]      → exit code 0 = all checks passed

   While an exam is on screen its question text and answer options must not be selectable, copyable or draggable —
   by touch, double / triple click, drag, Ctrl+A → Ctrl+C, right-click or "Save as PDF" — while the exam itself
   keeps working and nothing outside the question area changes.

   Limits of this test (be honest about them):
   · Headless Chromium has no touch long-press text selection (that is an Android feature), so a real long-press cannot be
     reproduced here. What IS checked: a touch on ordinary text starts a selection (selectstart fires) and the same touch on
     a question does not, user-select / touch-callout are "none" (what Android Chrome and iOS Safari obey), and the
     selectstart / contextmenu / dragstart events a long-press would raise are cancelled. Try a real phone once (README).
   · No web page can block a screenshot, a photo of the screen, or tools that read pixels (Google Lens, Circle to Search).
"""
import sys, os, copy, subprocess, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

# fixtures.py → examBundles/live1 (shuffle is off, so the order is fixed)
Q = ["বাংলাদেশের রাজধানী কোনটি?", "2 + 2 = ?", "Which is a fruit?"]
SECRET = [Q[0], Q[1], Q[2], "ঢাকা", "চট্টগ্রাম", "খুলনা", "রাজশাহী", "Apple", "Chair", "Table"]   # none of these may ever be copyable
leaked = lambda s: [t for t in SECRET if t in (s or "")]

PHONE = {"width": 390, "height": 844}
TINY = {"width": 320, "height": 640}
DESKTOP = {"width": 1366, "height": 850}

# The container has no Bengali web fonts: map the site's families onto the system FreeSans so Bengali text lays out like text.
FONT_CSS = """
@font-face { font-family: 'Hind Siliguri'; font-weight: 100 600; src: local('FreeSans'); }
@font-face { font-family: 'Hind Siliguri'; font-weight: 601 900; src: local('FreeSansBold'), local('FreeSans Bold'); }
@font-face { font-family: 'Noto Sans Bengali'; font-weight: 100 600; src: local('FreeSans'); }
@font-face { font-family: 'Noto Sans Bengali'; font-weight: 601 900; src: local('FreeSansBold'), local('FreeSans Bold'); }
"""

GEN = """(sel) => [...document.querySelectorAll(sel)].map((el) => { const c = getComputedStyle(el, '::before').content; try { return JSON.parse(c); } catch (e) { return c; } })"""
SELECTION = "() => window.getSelection().toString()"
CLEAR = "() => { window.getSelection().removeAllRanges(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }"
PROBE = """() => {
  window.__copy = { fired: 0, prevented: null, data: null };
  window.__cm = [];
  window.__ss = [];
  if (window.__probed) return;
  window.__probed = true;
  document.addEventListener('copy', (e) => { window.__copy.fired++; window.__copy.prevented = e.defaultPrevented; window.__copy.data = e.clipboardData ? e.clipboardData.getData('text/plain') : null; });
  window.addEventListener('contextmenu', (e) => window.__cm.push({ prevented: e.defaultPrevented, inZone: !!(e.target.closest && e.target.closest('.cg-zone')) }));
  document.addEventListener('selectstart', () => window.__ss.push(1));
}"""
# What a long-press (or a drag) raises, dispatched by hand: true = the page let it through, false = the page cancelled it.
RAISE = """(sel) => { const el = document.querySelector(sel);
  return { selectstart: el.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })),
           contextmenu: el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
           dragstart: el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })) }; }"""


def fresh(browser, viewport, seed=None, **ctx_kw):
    errors = []
    ctx = make_context(browser, viewport, seed=seed, **ctx_kw)
    install_clock(ctx)
    ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = %s; document.head.appendChild(s); });" % repr(FONT_CSS))
    page = new_page(ctx, errors)
    return ctx, page, errors


def start_exam(page):
    go(page, "#/exam?id=live1")
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    page.wait_for_selector(".exs-option", timeout=5000)
    page.evaluate(PROBE)


def seed_with(layout=None, text=None, option=None):
    seed = copy.deepcopy(fixtures.build(NOW))
    if layout:
        seed["exams/live1"]["layout"] = layout
    if text is not None:
        seed["examBundles/live1"]["questions"][0]["text"] = text
    if option is not None:
        seed["examBundles/live1"]["questions"][0]["options"][0] = option
    return seed


def spot(page, selector, dy=12):
    """A point on the first line of an element — where a finger or a mouse would land on its text."""
    b = page.locator(selector).first.bounding_box()
    return b["x"] + min(40, b["width"] / 2), b["y"] + min(dy, b["height"] / 2)


def long_touch(page, x, y, hold_ms=1100):
    """A finger held on the screen (a real touch gesture with a long hold — what a long-press starts with)."""
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.synthesizeTapGesture", {"x": x, "y": y, "duration": hold_ms, "tapCount": 1, "gestureSourceType": "touch"})
    page.wait_for_timeout(250)
    cdp.detach()


def drag(page, a, b):
    page.mouse.move(*a)
    page.mouse.down()
    page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, steps=6)
    page.mouse.move(*b, steps=6)
    page.mouse.up()
    page.wait_for_timeout(80)


def pdf_text(page):
    path = tempfile.mktemp(suffix=".pdf")
    page.pdf(path=path)
    out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    os.remove(path)
    return " ".join(out.split())


def common_checks(page, tag, mouse=True):
    """Everything that must hold for the one-question-at-a-time layout, on any device."""
    area = "#question-area"
    opts = fixtures.build(NOW)["examBundles/live1"]["questions"][0]["options"]

    # ---- the text is there to read, but is not text the browser can select ----
    check(f"{tag}: the question is drawn on screen (generated content = the question)", page.evaluate(GEN, f"{area} h2 .cg-text") == [Q[0]], str(page.evaluate(GEN, f"{area} h2 .cg-text")))
    check(f"{tag}: the four options are drawn on screen the same way", page.evaluate(GEN, f"{area} .exs-option-text .cg-text") == opts, str(page.evaluate(GEN, f"{area} .exs-option-text .cg-text")))
    check(f"{tag}: the question has real size on screen (not collapsed or hidden)", page.locator(f"{area} h2").bounding_box()["height"] >= 24 and all(page.locator(f"{area} .exs-option").nth(i).bounding_box()["height"] >= 44 for i in range(4)))
    check(f"{tag}: the page holds no copyable text for the question or its options", page.evaluate(f"document.querySelector('{area} h2').textContent.trim() === '' && [...document.querySelectorAll('{area} .exs-option-text')].every((e) => e.textContent.trim() === '')"))
    check(f"{tag}: nothing from the question area shows up in the page's text at all", leaked(page.inner_text(area)) == [], page.inner_text(area))
    shot(page, f"copyguard-{tag}")

    sel_cases = [area, f"{area} .exs-question-card", f"{area} h2", f"{area} .exs-option", f"{area} .exs-option-text"]
    got = [page.evaluate("(s) => getComputedStyle(document.querySelector(s)).userSelect", s) for s in sel_cases]
    check(f"{tag}: user-select is none on the area, the card, the question and the options", got == ["none"] * 5, str(got))
    # Chromium has no -webkit-touch-callout (and iOS Safari needs the -webkit- prefix on user-select), so these two can only be checked in the CSS text itself.
    css = page.evaluate("(document.getElementById('cg-style') || {}).textContent || ''")
    check(f"{tag}: the guard's CSS is injected once and also sets -webkit-user-select / -webkit-touch-callout (iOS Safari)",
          page.evaluate("document.querySelectorAll('#cg-style').length") == 1 and "-webkit-user-select: none" in css and "-webkit-touch-callout: none" in css, css[:200])

    # ---- screen readers still get the question (generated content is part of the accessibility tree) ----
    cdp = page.context.new_cdp_session(page)
    cdp.send("Accessibility.enable")
    ax = cdp.send("Accessibility.getFullAXTree")["nodes"]
    cdp.detach()
    ax_val = lambda n, k: (n.get(k) or {}).get("value", "")
    check(f"{tag}: accessibility: the question is a heading whose accessible name is the question text", sum(1 for n in ax if ax_val(n, "role") == "heading" and ax_val(n, "name") == Q[0]) == 1)
    check(f"{tag}: accessibility: the options are in the accessibility tree too", all(any(ax_val(n, "name") == o for n in ax) for o in opts), str([o for o in opts if not any(ax_val(n, "name") == o for n in ax)]))

    # ---- the events a long-press / drag raises are cancelled inside the zone, left alone outside it ----
    for sel in (f"{area} h2", f"{area} .exs-option", f"{area} .exs-option-text"):
        r = page.evaluate(RAISE, sel)
        check(f"{tag}: selectstart / contextmenu / dragstart on {sel.replace(area + ' ', '')} are all cancelled", r == {"selectstart": False, "contextmenu": False, "dragstart": False}, str(r))
    r = page.evaluate(RAISE, "#exam-take-title")
    check(f"{tag}: outside the question area the same events are NOT interfered with (title)", r == {"selectstart": True, "contextmenu": True, "dragstart": True}, str(r))

    # ---- select-all → copy ----
    page.evaluate(PROBE)
    page.evaluate(CLEAR)
    page.keyboard.press("Control+A")
    page.wait_for_timeout(80)
    after_a = page.evaluate(SELECTION)
    page.keyboard.press("Control+C")
    cp = page.evaluate("window.__copy")
    check(f"{tag}: Ctrl+A on the exam screen leaves no selection reaching the question (it is dropped at once)", after_a.strip() == "", repr(after_a[:120]))
    check(f"{tag}: Ctrl+A then Ctrl+C — the copy attempt happened, and nothing of the question is on the clipboard", cp["fired"] >= 1 and leaked(cp["data"]) == [] and not (cp["data"] or "").strip(), str(cp))

    # The copy / cut / drag handlers on their own (a selection that reaches into the zone is set and the event is raised in the same tick,
    # before the selection clean-up above can run): all cancelled — and a drag that starts outside the zone counts too.
    r = page.evaluate("""() => {
      const area = document.getElementById('question-area'), out = {};
      for (const type of ['copy', 'cut']) {
        window.getSelection().selectAllChildren(area);
        out[type] = document.body.dispatchEvent(new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
      }
      window.getSelection().selectAllChildren(area);
      out.dragFromOutside = document.getElementById('exam-take-title').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      window.getSelection().removeAllRanges();
      out.copyWithNoSelection = document.body.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
      return out; }""")
    check(f"{tag}: copy / cut / drag are cancelled while a selection reaches the question — and left alone when nothing is selected",
          r == {"copy": False, "cut": False, "dragFromOutside": False, "copyWithNoSelection": True}, str(r))
    page.evaluate(CLEAR)

    if mouse:
        # ---- a drag that starts outside the guarded area and runs through it ----
        page.evaluate(PROBE)
        top = page.locator("#exam-take-title").bounding_box()
        q = page.locator(f"{area} .exs-question-card").bounding_box()
        drag(page, (top["x"] + 4, top["y"] + top["height"] / 2), (q["x"] + q["width"] - 6, q["y"] + q["height"] - 6))
        page.wait_for_timeout(80)
        s = page.evaluate(SELECTION)
        check(f"{tag}: dragging from the title down through the question selects none of it", leaked(s) == [] and s.strip() == "", repr(s[:120]))
        page.keyboard.press("Control+C")
        cp = page.evaluate("window.__copy")
        check(f"{tag}: …and copying after that drag puts nothing of the question on the clipboard", leaked(cp["data"]) == [], str(cp))
        page.evaluate(CLEAR)

        # ---- right-click ----
        page.evaluate(PROBE)
        page.locator(f"{area} h2").click(button="right")
        page.locator(f"{area} .exs-option").nth(1).click(button="right")
        cm = page.evaluate("window.__cm")
        check(f"{tag}: right-click on the question and on an option opens no menu (cancelled)", len(cm) == 2 and all(c["prevented"] and c["inZone"] for c in cm), str(cm))
        page.evaluate("window.__cm.length = 0")
        page.locator("#exam-take-title").click(button="right")
        cm = page.evaluate("window.__cm")
        check(f"{tag}: right-click on the exam title (outside) still opens the normal menu", len(cm) == 1 and cm[0]["prevented"] is False, str(cm))

    # ---- an extension that forces text selection back on (the common "allow copy" trick) ----
    page.add_style_tag(content="*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default !important; }")
    page.evaluate(CLEAR)
    page.evaluate("() => window.getSelection().selectAllChildren(document.getElementById('question-area'))")
    forced = page.evaluate(SELECTION)
    check(f"{tag}: with user-select forced back ON (extension trick) there is still no question text to select", leaked(forced) == [], forced[:120])
    if mouse:
        page.evaluate(PROBE)
        page.evaluate(CLEAR)
        page.locator(f"{area} h2").click(click_count=3)
        s = page.evaluate(SELECTION)
        check(f"{tag}: …triple-click on the question still selects none of it", leaked(s) == [], s[:120])
        page.keyboard.press("Control+C")
        cp = page.evaluate("window.__copy")
        check(f"{tag}: …and Ctrl+C then puts nothing of it on the clipboard", (cp["prevented"] is True or not s.strip()) and leaked(cp["data"]) == [], f"{cp} sel={s!r}")
    page.evaluate(CLEAR)


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ============================================================ 1. phone (touch): one question at a time
    print("\n[1] Phone · one question at a time")
    ctx, page, errors = fresh(browser, PHONE, has_touch=True, is_mobile=True, seed=seed_with())
    start_exam(page)

    # Control: a touch on ordinary text starts a selection (selectstart fires); the same touch on a question or an option does not.
    page.evaluate("window.__ss.length = 0")
    page.touchscreen.tap(*spot(page, "#exam-take-title", dy=10))
    page.wait_for_timeout(150)
    started_on_title = len(page.evaluate("window.__ss"))
    page.evaluate(CLEAR)
    page.evaluate("window.__ss.length = 0")
    page.touchscreen.tap(*spot(page, "#question-area h2"))
    page.wait_for_timeout(150)
    check("phone: control — a touch on ordinary text (the exam title) starts a text selection (selectstart)", started_on_title >= 1, str(started_on_title))
    check("phone: …but a touch on the question does not start one", len(page.evaluate("window.__ss")) == 0, str(page.evaluate("window.__ss")))
    page.evaluate(CLEAR)

    # A finger held down on the question / an option: nothing selected, no menu.
    page.evaluate("window.__cm.length = 0; window.__ss.length = 0")
    long_touch(page, *spot(page, "#question-area h2"))
    s_q = page.evaluate(SELECTION)
    long_touch(page, *spot(page, "#question-area .exs-option-text", dy=10))
    s_o = page.evaluate(SELECTION)
    cm = page.evaluate("window.__cm")
    check("phone: a finger held on the question / an option selects nothing", s_q.strip() == "" and s_o.strip() == "", f"{s_q!r} {s_o!r}")
    check("phone: …raises no selection start and no un-cancelled menu event", len(page.evaluate("window.__ss")) == 0 and all(c["prevented"] for c in cm), f"{page.evaluate('window.__ss')} {cm}")
    page.evaluate(CLEAR)

    common_checks(page, "phone", mouse=False)
    check("phone: no horizontal overflow on the exam screen", no_overflow(page))
    check("phone: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # the exam still works with the guard on: tap an option → answered + locked; Next goes on
    ctx, page, errors = fresh(browser, PHONE, has_touch=True, is_mobile=True, seed=seed_with())
    start_exam(page)
    page.locator(".exs-option").nth(0).tap()
    check("phone: tapping an option still answers and locks it", page.locator(".exs-option.is-selected").count() == 1 and page.locator(".exs-options.is-locked").count() == 1)
    page.locator("#q-next").tap()
    page.wait_for_timeout(150)
    check("phone: Next shows question 2, drawn the same way", page.evaluate(GEN, "#question-area h2 .cg-text") == [Q[1]], str(page.evaluate(GEN, "#question-area h2 .cg-text")))
    page.locator("#q-prev").tap()
    page.wait_for_timeout(150)
    check("phone: Previous goes back and the locked answer is still marked", page.evaluate(GEN, "#question-area h2 .cg-text") == [Q[0]] and page.locator(".exs-option.is-selected").count() == 1)
    check("phone: no JS errors while answering", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================ 2. desktop (mouse + keyboard)
    print("\n[2] Desktop · one question at a time")
    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with())
    start_exam(page)
    # Control: a triple-click on unguarded text selects it — and copying it is NOT blocked.
    page.locator("#exam-take-title").click(click_count=3)
    ctrl = page.evaluate(SELECTION)
    page.keyboard.press("Control+C")
    check("desktop: control — triple-click on unguarded text (the exam title) DOES select it", "বাংলাদেশ বিমান বাহিনী" in ctrl, repr(ctrl))
    check("desktop: …and copying it is not blocked (the guard only acts on the question area)", page.evaluate("window.__copy.fired") >= 1 and page.evaluate("window.__copy.prevented") is False, str(page.evaluate("window.__copy")))
    page.evaluate(CLEAR)
    # double / triple click and drag on the question
    page.mouse.dblclick(*spot(page, "#question-area h2"))   # on the first word of the question, where the text starts
    s1 = page.evaluate(SELECTION)
    page.evaluate(CLEAR)
    page.locator("#question-area h2").click(click_count=3)
    s2 = page.evaluate(SELECTION)
    page.evaluate(CLEAR)
    b = page.locator("#question-area .exs-question-card").bounding_box()
    drag(page, (b["x"] + 6, b["y"] + 6), (b["x"] + b["width"] - 6, b["y"] + b["height"] - 6))
    s3 = page.evaluate(SELECTION)
    page.evaluate(CLEAR)
    check("desktop: double-click on the question selects nothing", s1.strip() == "", repr(s1))
    check("desktop: triple-click on the question selects nothing", s2.strip() == "", repr(s2))
    check("desktop: dragging across the whole question card selects nothing", s3.strip() == "", repr(s3))
    common_checks(page, "desktop", mouse=True)
    check("desktop: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # Save as PDF / printing while the exam runs: the question area is not printed.
    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with())
    start_exam(page)
    page.locator(".exs-option").nth(0).click()
    page.locator("#q-next").click(); page.wait_for_timeout(100)
    page.locator(".exs-option").nth(1).click()
    page.locator("#q-next").click(); page.wait_for_timeout(100)   # question 3 — plain ASCII ("Which is a fruit?"), so the PDF text is easy to read
    check("print: question 3 is on screen", page.evaluate(GEN, "#question-area h2 .cg-text") == [Q[2]])
    page.emulate_media(media="print")
    check("print: the question area is display:none while the exam runs", page.evaluate("getComputedStyle(document.getElementById('question-area')).display") == "none")
    txt = pdf_text(page)
    check("print: control — the PDF has text (the Submit button and the timer are in it)", "Submit" in txt and "30:00" in txt, txt[:200])
    check("print: the PDF contains none of the question or option text", leaked(txt) == [], txt[:300])
    page.emulate_media(media="screen")
    check("print: back on screen the question is visible again", page.evaluate("getComputedStyle(document.getElementById('question-area')).display") != "none")
    check("print: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================ 3. every question on one page
    print("\n[3] Desktop · all questions on one page")
    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with(layout="all"))
    start_exam(page)
    check("all-on-one-page: 3 question cards are shown", page.locator(".exs-question-card").count() == 3)
    check("all-on-one-page: every question is drawn on screen", page.evaluate(GEN, "#question-area h2 .cg-text") == Q, str(page.evaluate(GEN, "#question-area h2 .cg-text")))
    check("all-on-one-page: none of the questions or options is text in the page", leaked(page.inner_text("#question-area")) == [] and page.evaluate("[...document.querySelectorAll('#question-area h2, #question-area .exs-option-text')].every((e) => e.textContent.trim() === '')"))
    page.evaluate(CLEAR)
    page.keyboard.press("Control+A")
    page.wait_for_timeout(80)
    sel = page.evaluate(SELECTION)
    page.keyboard.press("Control+C")
    cp = page.evaluate("window.__copy")
    check("all-on-one-page: Ctrl+A → Ctrl+C copies nothing from any question", sel.strip() == "" and leaked(cp["data"]) == [], f"{sel[:80]!r} {cp}")
    page.evaluate(CLEAR)
    picked = []
    for i in range(3):
        page.locator(".exs-question-card").nth(i).locator("h2").click(click_count=3)
        picked.append(page.evaluate(SELECTION).strip())
        page.evaluate(CLEAR)
    check("all-on-one-page: triple-click on each of the 3 questions selects nothing", picked == ["", "", ""], str(picked))
    page.locator(".exs-question-card").nth(1).locator(".exs-option").nth(1).click()
    check("all-on-one-page: answering still works (question 2, option B locked)", page.locator(".exs-question-card").nth(1).locator(".exs-option.is-selected").count() == 1)
    check("all-on-one-page: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================ 4. the text is shown exactly as written
    print("\n[4] Awkward question text: markup, quotes, very long lines")
    nasty = "<b>bold</b> & \"quoted\" 'single' \\ back <img src=x onerror=\"window.__xss=1\"> 2 < 3 > 1"
    ctx, page, errors = fresh(browser, PHONE, has_touch=True, is_mobile=True, seed=seed_with(text=nasty, option="<i>x</i> & \"y\""))
    start_exam(page)
    page.wait_for_timeout(200)
    check("awkward text: shown literally (nothing is parsed as HTML)", page.evaluate(GEN, "#question-area h2 .cg-text") == [nasty], str(page.evaluate(GEN, "#question-area h2 .cg-text")))
    check("awkward text: no element was created from the text and no script ran", page.evaluate("document.querySelectorAll('#question-area h2 *').length") == 1 and page.evaluate("window.__xss") is None)
    check("awkward text: the option text is literal too", page.evaluate(GEN, "#question-area .exs-option-text .cg-text")[0] == "<i>x</i> & \"y\"", str(page.evaluate(GEN, "#question-area .exs-option-text .cg-text")))
    ctx.close()

    long_bn = "বাংলাদেশের সংবিধান অনুযায়ী রাষ্ট্রের সকল ক্ষমতার মালিক জনগণ এবং জনগণের পক্ষে সেই ক্ষমতার প্রয়োগ কেবল সংবিধানের অধীন ও কর্তৃত্বে কীভাবে নিশ্চিত করা হয়েছে তা ব্যাখ্যা করুন। " * 3
    ctx, page, errors = fresh(browser, TINY, has_touch=True, is_mobile=True, seed=seed_with(text=long_bn, option="অতিদীর্ঘএকটিশব্দযারমধ্যেকোনোফাঁকনেইএবংসেটিছোটপর্দায়সহজেইউপচেপড়তেপারেযদিঠিকমতোভাঙানাহয়" * 2))
    start_exam(page)
    page.wait_for_timeout(200)
    check("long text @320px: a very long question and an unbroken option wrap — no horizontal overflow", no_overflow(page))
    check("long text @320px: the whole long question is drawn", page.evaluate(GEN, "#question-area h2 .cg-text") == [long_bn], "")
    shot(page, "copyguard-320-long")
    check("long text @320px: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================ 5. the rest of the site is untouched
    print("\n[5] Outside the exam question area nothing changes")
    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with())
    start_exam(page)
    for i, p in enumerate([0, 1, 0]):
        page.locator(".exs-option").nth(p).click()
        if i < 2:
            page.locator("#q-next").click()
            page.wait_for_timeout(100)
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=4000)
    page.wait_for_timeout(300)
    check("result screen: not inside a guarded zone, text is selectable as before", page.evaluate("!document.getElementById('rx-root').closest('.cg-zone') && getComputedStyle(document.getElementById('rx-root')).userSelect !== 'none'"))
    check("result screen: the 'wrong answers' review is still selectable (it is not part of the exam screen)", page.locator(".exs-review-q").count() >= 1 and page.evaluate("[...document.querySelectorAll('.exs-review-q')].every((e) => getComputedStyle(e).userSelect !== 'none')"))
    check("result screen: context menu is not blocked", page.evaluate("document.getElementById('rx-root').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))") is True)
    check("result screen: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with())
    go(page, "#/exam")
    page.wait_for_timeout(800)
    check("exam list page: text is selectable as before", page.evaluate("getComputedStyle(document.body).userSelect !== 'none' && getComputedStyle(document.getElementById('exam-section-title')).userSelect !== 'none'"))
    check("only #question-area carries the guard", page.evaluate("document.querySelectorAll('.cg-zone').length") == 1 and page.evaluate("document.querySelector('.cg-zone').id") == "question-area")
    ctx.close()

    # ============================================================ 6. never a blank question
    print("\n[6] If the paint rule is not active the question is shown as plain text (never blank)")
    src = open(os.path.join(ROOT, "js", "copy-guard.js"), encoding="utf-8").read()
    rule = ".cg-text::before { content: attr(data-cg); }"
    check("fallback setup: the paint rule is in copy-guard.js exactly once", src.count(rule) == 1)
    broken = src.replace(rule, "")   # what a blocked <style> / stripped CSS / odd browser would look like
    ctx, page, errors = fresh(browser, DESKTOP, seed=seed_with())
    page.route("**/js/copy-guard.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=broken, headers={"access-control-allow-origin": "*"}))
    start_exam(page)
    check("fallback: the question is on screen as plain text", page.inner_text("#question-area h2").strip() == Q[0], page.inner_text("#question-area h2"))
    check("fallback: the four options are plain text too", page.evaluate("[...document.querySelectorAll('#question-area .exs-option-text')].map((e) => e.textContent.trim())") == fixtures.build(NOW)["examBundles/live1"]["questions"][0]["options"])
    check("fallback: no empty .cg-text span is left behind", page.locator("#question-area .cg-text").count() == 0)
    page.locator("#question-area h2").click(click_count=3)
    s = page.evaluate(SELECTION)
    page.evaluate(CLEAR)
    page.mouse.dblclick(*spot(page, "#question-area h2"))
    s2 = page.evaluate(SELECTION)
    check("fallback: even then the question cannot be selected (CSS + events still apply)", s.strip() == "" and s2.strip() == "", f"{s!r} {s2!r}")
    page.evaluate(CLEAR)
    page.evaluate(PROBE)
    page.keyboard.press("Control+A")
    page.wait_for_timeout(80)
    sel = page.evaluate(SELECTION)
    page.keyboard.press("Control+C")
    cp = page.evaluate("window.__copy")
    check("fallback: Ctrl+A leaves no selection reaching the question, and Ctrl+C copies none of it", sel.strip() == "" and leaked(cp["data"]) == [], f"{sel[:80]!r} {cp}")
    page.locator(".exs-option").nth(1).click()
    check("fallback: answering still works", page.locator(".exs-option.is-selected").count() == 1)
    check("fallback: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    browser.close()

sys.exit(finish())
