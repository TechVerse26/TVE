"""End-to-end checks for the six information pages — About · FAQ · Help Center · Privacy Policy · Terms & Conditions · Credits —
   and for the footer links that lead to them (js/page-about.js … js/page-credits.js, js/info-ui.js, js/footer.js, css/info-pages.css).

   python3 tests/e2e/run_info.py [--shots]      → exit code 0 = all checks passed

   What it proves, in a real Chromium at phone (390px), tablet (820px) and desktop (1366px) size, with the in-memory Firebase mock:
     [1]  every route loads: right <title>, one <h1>, English only (lang="en" on the page, <html lang="bn"> untouched), shared nav + footer, no errors
     [2]  the footer: every link goes to its page, the mobile accordion is unchanged, social links stay switched off, contact info is kept
     [3]  About: complete, not duplicated, working links
     [4]  FAQ: search, highlighting, category filters, empty state, deep links, accordions by mouse and keyboard
     [5]  Help Center: topic jumps, suggestions, popular links, working mailto:, copy button, no fake ticket form / chat
     [6]  Privacy + Terms: numbered sections, contents list, scroll position, "to be confirmed" notes, phone accordion, readable line length
     [7]  Credits: placeholder cards, initials / broken-photo fallbacks, unsafe photos and links refused, hostile text escaped
     [8]  no horizontal overflow on any page at 320 / 390 / 820 / 1366px
     [9]  keyboard: tab stops have a visible focus ring and a name; Enter / Space / Escape do what they should
     [10] markup: no duplicate ids, every aria reference resolves, every link / button / image is named, headings do not skip, no 404 resources
     [11] lifecycle: pages clean up their scroll / resize listeners and never stack when visited again
"""
import sys, os, re, json
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
from playwright.sync_api import sync_playwright

# route · <title> · <h1> · least amount of text a finished page has (a page that lost its content would fall far below it)
PAGES = [
    ("about",   "About Us — Tech Verse Exam",           "About Tech Verse Exam",             3500),
    ("faq",     "FAQ — Tech Verse Exam",                "Frequently Asked Questions",        15000),
    ("help",    "Help Center — Tech Verse Exam",        "How can we help?",                  9000),
    ("privacy", "Privacy Policy — Tech Verse Exam",     "Privacy Policy",                    14000),
    ("terms",   "Terms & Conditions — Tech Verse Exam", "Terms & Conditions",                11000),
    ("credits", "Credits — Tech Verse Exam",            "The people behind Tech Verse Exam", 1200),
]
SRC = lambda *p: open(os.path.join(ROOT, *p), encoding="utf-8").read()
SUPPORT_EMAIL = re.search(r'SUPPORT_EMAIL = "([^"]+)"', SRC("js", "footer-config.js")).group(1)
WEBSITE = re.search(r'website: "([^"]+)"', SRC("js", "footer-config.js")).group(1)
LEGAL_DATE = {k: re.search(rf'{k}: "(\d{{4}}-\d{{2}}-\d{{2}})"', SRC("js", "info-config.js")).group(1) for k in ("privacy", "terms")}


def watch(page):
    """Failed same-origin requests (a missing stylesheet or module) and console warnings — the harness' own listener ignores both."""
    seen = {"bad": [], "warn": []}
    FILES = ("stylesheet", "script", "image", "font", "media")
    page.on("response", lambda r: seen["bad"].append(f"{r.status} {r.url}") if r.url.startswith(BASE) and r.status >= 400 else None)
    page.on("requestfailed", lambda r: seen["bad"].append(f"FAILED {r.url}") if r.url.startswith(BASE) and r.resource_type in FILES else None)   # (the app's own server-clock HEAD request is a fetch, not a file)
    page.on("console", lambda m: seen["warn"].append(m.text) if m.type == "warning" else None)
    return seen


def open_page(browser, hash_, vp="desktop", user=None, viewport=None, grant=False, wait=".inf"):
    errors = []
    ctx = make_context(browser, viewport or VIEWPORTS[vp], user=user)
    if grant:
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    page = new_page(ctx, errors)
    seen = watch(page)
    go(page, hash_)
    page.wait_for_selector(wait, timeout=8000)
    page.wait_for_timeout(300)
    return ctx, page, errors, seen


def goto_route(page, hash_):
    """Same-document navigation, exactly like a link click."""
    page.evaluate("(h) => { location.hash = h; }", hash_)
    page.wait_for_timeout(350)


def top_of(page, sel):
    return round(page.evaluate("(s) => document.querySelector(s).getBoundingClientRect().top", sel))


def nav_h(page):
    return round(page.evaluate("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 56"))


def tab_stops(page, how_many):
    """Press Tab how_many times from the first focusable element of the page; describe every stop that is inside the page."""
    page.evaluate("() => { const r = document.querySelector('.inf'); const f = r.querySelector('a[href], button:not([disabled]), input, summary'); f && f.focus(); window.scrollTo({top: 0, behavior: 'instant'}); }")
    stops = []
    for _ in range(how_many):
        page.keyboard.press("Tab")
        info = page.evaluate("""() => {
          const e = document.activeElement; if (!e || e === document.body) return null;
          const inside = !!e.closest('.inf');
          const cs = getComputedStyle(e), r = e.getBoundingClientRect();
          const wrap = e.closest('.inf-search-box');
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none') || (wrap && getComputedStyle(wrap).outlineStyle !== 'none');
          const name = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
          return { inside, tag: e.tagName.toLowerCase(), ring: !!ring, named: !!name, visible: r.width > 0 && r.height > 0, label: name.slice(0, 40) };
        }""")
        if info and info["inside"]:
            stops.append(info)
    return stops


# JS run inside a page: everything that makes markup "malformed" for a user of a screen reader or a keyboard
LINT = """() => {
  const root = document.querySelector('.inf'), out = [];
  const seen = {}; document.querySelectorAll('[id]').forEach((e) => { (seen[e.id] = seen[e.id] || []).push(e); });
  Object.entries(seen).filter(([, v]) => v.length > 1).forEach(([id]) => out.push('duplicate id: ' + id));
  root.querySelectorAll('[aria-labelledby],[aria-controls],[aria-describedby]').forEach((e) => {
    for (const attr of ['aria-labelledby', 'aria-controls', 'aria-describedby']) {
      (e.getAttribute(attr) || '').split(/\\s+/).filter(Boolean).forEach((id) => { if (!document.getElementById(id)) out.push(attr + ' points at a missing id: ' + id); });
    }
  });
  root.querySelectorAll('label[for]').forEach((l) => { if (!document.getElementById(l.getAttribute('for'))) out.push('label for a missing id'); });
  const named = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim() || e.querySelector('img[alt]:not([alt=""])');
  root.querySelectorAll('a').forEach((a) => {
    if (!named(a)) out.push('unnamed link: ' + (a.getAttribute('href') || '').slice(0, 40));
    const h = a.getAttribute('href') || '';
    if (h === '#' || /^javascript:/i.test(h)) out.push('dead link: ' + h);
    if (a.target === '_blank' && !/noopener/.test(a.rel)) out.push('target=_blank without rel=noopener: ' + h.slice(0, 40));
  });
  root.querySelectorAll('button').forEach((b) => { if (!named(b)) out.push('unnamed button'); });
  root.querySelectorAll('input:not([type=hidden])').forEach((i) => { if (!(i.getAttribute('aria-label') || (i.id && root.querySelector('label[for="' + i.id + '"]')))) out.push('unlabelled input #' + i.id); });
  root.querySelectorAll('img').forEach((i) => { if (!i.hasAttribute('alt')) out.push('img without alt'); });
  const h1 = root.querySelectorAll('h1'); if (h1.length !== 1) out.push('expected exactly one h1, found ' + h1.length);
  let last = 1; root.querySelectorAll('h1,h2,h3,h4').forEach((h) => { const n = +h.tagName[1]; if (n > last + 1) out.push('heading jumps from h' + last + ' to h' + n + ': ' + h.textContent.trim().slice(0, 40)); last = n; });
  root.querySelectorAll('table').forEach((t) => { if (!t.querySelector('caption') && !t.getAttribute('aria-label')) out.push('table without a caption'); if (!t.querySelector('th')) out.push('table without header cells'); });
  root.querySelectorAll('details').forEach((d) => { if (!d.querySelector(':scope > summary')) out.push('details without summary'); });
  const bad = [...root.querySelectorAll('*')].filter((e) => /\\{(owner|email|site|name)[:}]|\\[[^\\]]+\\]\\([^)]*\\)|\\*\\*/.test(e.childNodes.length === 1 && e.firstChild.nodeType === 3 ? e.textContent : ''));
  bad.forEach((e) => out.push('mark-up left in the text: ' + e.textContent.trim().slice(0, 50)));
  return out;
}"""

OVERFLOW = """() => {
  const w = document.documentElement.clientWidth, off = [];
  const insideScroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === 'auto' || o === 'scroll') && p.getBoundingClientRect().right <= w + 1 && p.getBoundingClientRect().left >= -1) return true; } return false; };
  document.querySelectorAll('.inf *').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width && (r.right > w + 1 || r.left < -1) && !e.closest('.sr-only') && getComputedStyle(e).position !== 'fixed' && !insideScroller(e)) off.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' ' + Math.round(r.left) + '→' + Math.round(r.right));
  });
  return { scroll: document.documentElement.scrollWidth, client: w, off: off.slice(0, 5) };
}"""


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ------------------------------------------------------------------ 1. Routes
    print("\n[1] All six routes load, in English, inside the app shell")
    for route, title, h1, min_chars in PAGES:
        ctx, page, errors, seen = open_page(browser, f"#/{route}")
        f = page.evaluate("""() => {
          const root = document.querySelector('.inf'), h1 = root.querySelectorAll('h1');
          return { page: root.dataset.page, lang: root.getAttribute('lang'), htmlLang: document.documentElement.lang, title: document.title,
                   h1: h1.length === 1 ? h1[0].textContent.trim() : 'x' + h1.length, chars: root.textContent.length, bengali: /[\\u0980-\\u09FF]/.test(root.textContent),
                   nav: document.querySelector('#topnav-root').innerHTML.length > 200, footer: !!document.querySelector('#site-footer .ftr-main'),
                   roots: document.querySelectorAll('.inf').length, scrollY: Math.round(scrollY), hasHome: !!document.querySelector('#page-home:not(.hidden)') };
        }""")
        check(f"#/{route}: its own page is drawn (data-page, one .inf, nothing else on top)", f["page"] == route and f["roots"] == 1, str(f))
        check(f"#/{route}: <title> is “{title}”", f["title"] == title, f["title"])
        check(f"#/{route}: one <h1> “{h1}”", f["h1"] == h1, f["h1"])
        check(f"#/{route}: English — lang=\"en\" on the page, <html lang=\"bn\"> unchanged, no Bengali text", f["lang"] == "en" and f["htmlLang"] == "bn" and not f["bengali"], str(f))
        check(f"#/{route}: complete content (≥ {min_chars} characters; has {f['chars']})", f["chars"] >= min_chars)
        check(f"#/{route}: the shared top bar and footer are there, page starts at the top", f["nav"] and f["footer"] and f["scrollY"] == 0, str(f))
        check(f"#/{route}: no JavaScript errors, no missing files", not errors and not seen["bad"], f"{errors} {seen['bad']}")
        shot(page, f"info-{route}-desktop")
        ctx.close()
    # signed in: the same pages (public), the nav shows the student
    ctx, page, errors, seen = open_page(browser, "#/about", user="stu1")
    check("signed in: About still renders (public page) with the student's top bar and no errors", page.locator(".inf[data-page=about] h1").is_visible() and not errors and not seen["bad"], f"{errors}")
    check("signed in: the About call-to-action goes to the student's own pages", page.locator('.inf-cta a[href="#/exams"]').count() == 1 and page.locator('.inf-cta a[href="#/results"]').count() == 1 and page.locator('.inf-cta a[href="#/signup"]').count() == 0)
    ctx.close()
    ctx, page, errors, seen = open_page(browser, "#/home", user="stu1", wait="#site-footer .ftr-main")
    check("the other pages are untouched: Home has no information-page root and keeps <html lang=\"bn\">", page.locator(".inf").count() == 0 and page.evaluate("document.documentElement.lang") == "bn")
    ctx.close()

    # ------------------------------------------------------------------ 2. Footer
    print("\n[2] Footer links, accordion, contact details")
    LINKS = [("About Us", "#/about", "about"), ("Help Center", "#/help", "help"), ("Frequently Asked Questions", "#/faq", "faq"),
             ("Contact Support", "#/help?section=contact", "help"), ("Terms & Conditions", "#/terms", "terms"), ("Privacy Policy", "#/privacy", "privacy"), ("Credits", "#/credits", "credits")]
    for vp in ("desktop", "tablet", "mobile"):
        errors = []
        ctx = make_context(browser, VIEWPORTS[vp], user=None)
        page = new_page(ctx, errors)
        go(page, "#/home")
        page.wait_for_selector("#site-footer .ftr-main", timeout=8000)
        groups = page.evaluate("[...document.querySelectorAll('#site-footer details.ftr-acc')].map((d) => d.open)")
        check(f"[{vp}] footer groups are {'closed accordions' if vp == 'mobile' else 'open columns'} by default (behaviour unchanged)", groups == ([False] * 3 if vp == "mobile" else [True] * 3), str(groups))
        resources = page.evaluate("[...document.querySelectorAll('#site-footer .ftr-group')].find((g) => /Student Resources/.test(g.textContent)).querySelectorAll('a.ftr-link').length")
        check(f"[{vp}] 'Student Resources' lists the seven links (About Us and Credits added)", resources == 7, str(resources))
        pending = page.evaluate("[...document.querySelectorAll('#site-footer [aria-disabled=true]')].map((e) => e.getAttribute('aria-label') || e.textContent.trim())")
        check(f"[{vp}] the four social icons are still switched off — no invented addresses", len(pending) == 4 and all("coming soon" in p for p in pending), str(pending))
        check(f"[{vp}] support email and website are kept in the contact area",
              page.locator(f'#site-footer .ftr-contact a[href="mailto:{SUPPORT_EMAIL}"]').count() == 1 and page.locator(f'#site-footer .ftr-contact a[href="{WEBSITE}"]').count() == 1)
        for label, href, key in LINKS:
            goto_route(page, "#/home")
            page.wait_for_selector("#site-footer .ftr-main", timeout=8000)
            page.evaluate("document.querySelectorAll('#site-footer details.ftr-acc').forEach((d) => d.open = true)")
            link = page.locator(f'#site-footer .ftr-links a[href="{href}"]')
            ok_text = link.count() == 1 and label in link.inner_text()
            link.scroll_into_view_if_needed()
            link.click()
            page.wait_for_selector(f'.inf[data-page="{key}"]', timeout=8000)
            page.wait_for_timeout(250)
            landed = page.evaluate("location.hash") == href
            extra = True
            if "section=" in href:
                sec = href.split("section=")[1]
                extra = abs(top_of(page, f"#h-{sec}") - (nav_h(page) + 16)) <= 12
            check(f"[{vp}] footer “{label}” → {href}" + (" and lands on that section" if "section=" in href else ""), ok_text and landed and extra, f"text={ok_text} hash={page.evaluate('location.hash')}")
        for label, href in (("Privacy Policy", "#/privacy"), ("Terms & Conditions", "#/terms")):
            goto_route(page, "#/home")
            page.wait_for_selector("#site-footer .ftr-legal", timeout=8000)
            page.locator(f'#site-footer .ftr-legal a[href="{href}"]').click()
            page.wait_for_selector(f'.inf[data-page="{href[2:]}"]', timeout=8000)
            check(f"[{vp}] bottom legal bar “{label}” → {href}", page.evaluate("location.hash") == href)
        if vp == "mobile":
            goto_route(page, "#/home")
            page.wait_for_selector("#site-footer .ftr-main", timeout=8000)
            page.evaluate("document.querySelectorAll('#site-footer details.ftr-acc').forEach((d) => d.open = false)")
            summ = page.locator("#site-footer .ftr-group", has_text="Student Resources").locator("summary")
            summ.scroll_into_view_if_needed()
            was_closed = not page.locator('#site-footer .ftr-links a[href="#/about"]').is_visible()
            summ.click(); page.wait_for_timeout(150)
            check("[mobile] 'Student Resources' is closed until tapped, then shows About Us and Credits",
                  was_closed and page.locator('#site-footer .ftr-links a[href="#/about"]').is_visible() and page.locator('#site-footer .ftr-links a[href="#/credits"]').is_visible())
        # a footer link to the page you are already on
        goto_route(page, "#/help?section=contact"); page.wait_for_selector('.inf[data-page="help"]'); page.wait_for_timeout(300)
        page.evaluate("window.scrollTo({top: 0, behavior: 'instant'}); document.querySelector('.inf').dataset.marker = 'same'; document.querySelectorAll('#site-footer details.ftr-acc').forEach((d) => d.open = true)")
        page.locator('#site-footer .ftr-links a[href="#/help?section=contact"]').click()
        page.wait_for_timeout(900)
        check(f"[{vp}] 'Contact Support' on the Help page itself goes to the contact section without redrawing the page",
              abs(top_of(page, "#h-contact") - (nav_h(page) + 16)) <= 12 and page.evaluate("document.querySelector('.inf').dataset.marker") == "same", str(top_of(page, "#h-contact")))
        goto_route(page, "#/credits"); page.wait_for_selector('.inf[data-page="credits"]'); page.wait_for_timeout(300)
        page.evaluate("window.scrollTo({top: 600, behavior: 'instant'}); document.querySelectorAll('#site-footer details.ftr-acc').forEach((d) => d.open = true)")
        page.locator('#site-footer .ftr-links a[href="#/credits"]').click()
        page.wait_for_timeout(900)
        check(f"[{vp}] 'Credits' on the Credits page itself scrolls back to the top", page.evaluate("Math.round(scrollY)") == 0)
        check(f"[{vp}] no errors while using the footer", not errors, str(errors))
        if vp != "tablet":
            page.evaluate("document.querySelectorAll('#site-footer details.ftr-acc').forEach((d) => d.open = true)")
            shot(page, f"info-footer-{vp}")
        ctx.close()

    # ------------------------------------------------------------------ 3. About
    print("\n[3] About Us")
    ctx, page, errors, seen = open_page(browser, "#/about")
    ids = page.evaluate("[...document.querySelectorAll('.inf section[id]')].map((s) => s.id)")
    want = ["story", "mission", "vision", "offer", "features", "how", "commitment", "accessibility", "values"]
    check("About has all its sections, each exactly once", all(ids.count(w) == 1 for w in want), str(ids))
    check("About is not duplicated: one page root, one <h1>, one 'About Us' link in the footer, one `about` route",
          page.locator(".inf").count() == 1 and page.locator(".inf h1").count() == 1 and page.locator('#site-footer a[href="#/about"]').count() == 1 and SRC("js", "app.js").count("about: genericRoute") == 1)
    goto_route(page, "#/home"); goto_route(page, "#/about"); goto_route(page, "#/faq"); goto_route(page, "#/about")
    page.wait_for_selector('.inf[data-page="about"]'); page.wait_for_timeout(300)
    check("visiting About again does not stack a second copy", page.locator(".inf").count() == 1 and page.locator(".inf h1").count() == 1 and page.locator("section#story").count() == 1)
    check("signed out: the call-to-action offers 'Create an account' (→ #/signup)", page.locator('.inf-cta a[href="#/signup"]').count() == 1)
    check("About states no numbers, awards, partners or certifications it cannot back up", not re.search(r"\b\d[\d,]*\+?\s+(students|learners|users|exams)\b|award|partner|certified|accredited|trusted by", page.inner_text(".inf"), re.I))
    goto_route(page, "#/about?section=values"); page.wait_for_timeout(700)
    check("About ?section=values lands on that section, just under the top bar", abs(top_of(page, "#h-values") - (nav_h(page) + 16)) <= 12, str(top_of(page, "#h-values")))
    goto_route(page, "#/home"); page.wait_for_timeout(200)
    goto_route(page, "#/about"); page.wait_for_selector('.inf[data-page="about"]')
    page.locator(".inf-back").click(); page.wait_for_timeout(400)
    check("the 'Back' button on a page returns to the page before", page.evaluate("location.hash") in ("#/home", "#/faq"), page.evaluate("location.hash"))
    check("no errors on About", not errors and not seen["bad"], str(errors))
    ctx.close()

    # ------------------------------------------------------------------ 4. FAQ
    print("\n[4] FAQ — search, filters, accordions")
    ctx, page, errors, seen = open_page(browser, "#/faq")
    total = page.locator(".inf-qa").count()
    check("all questions are listed, grouped under the nine categories", total >= 50 and page.locator(".inf-faq-group").count() == 9, f"{total} questions / {page.locator('.inf-faq-group').count()} groups")
    check("the live status says how many questions are shown", f"Showing {total} questions" in page.inner_text("#faq-status"), page.inner_text("#faq-status"))
    check("by default every answer is folded away", page.locator(".inf-qa[open]").count() == 0)
    page.fill("#faq-q", "how do I reset my password")
    page.wait_for_timeout(700)
    first = page.locator(".inf-qa .inf-q-text").first.inner_text()
    check("searching 'how do I reset my password' puts the password-reset question first", "password" in first.lower() and "reset" in first.lower(), first)
    check("the matches are highlighted and few matches open themselves", page.locator(".inf-faq-groups mark").count() > 0 and page.locator(".inf-qa[open]").count() >= 1)
    check("the status line announces the number of matches", re.search(r"\d+ questions? match", page.inner_text("#faq-status")) is not None, page.inner_text("#faq-status"))
    check("the search result names the category of each question", page.locator(".inf-q-meta").count() > 0)
    shot(page, "info-faq-search")
    page.fill("#faq-q", "zzzzqq")
    page.wait_for_timeout(700)
    check("a search with no match shows the empty state with ways forward",
          page.locator(".inf-empty").is_visible() and "No questions found" in page.inner_text(".inf-empty") and page.locator('.inf-empty a[href="#/help"]').count() == 1 and page.locator('.inf-empty a[href^="mailto:"]').count() == 1)
    page.locator('.inf-empty [data-act="clear"]').click()
    page.wait_for_timeout(300)
    check("'Clear search' empties the box, gives it focus and lists everything again", page.input_value("#faq-q") == "" and page.evaluate("document.activeElement.id") == "faq-q" and page.locator(".inf-qa").count() == total)
    page.fill("#faq-q", "leaderboard"); page.wait_for_timeout(600)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("Escape clears the search", page.input_value("#faq-q") == "" and page.locator(".inf-qa").count() == total)
    page.click('[data-cat="results"]'); page.wait_for_timeout(300)
    n_results = page.locator(".inf-qa").count()
    check("a category chip filters the list and is marked pressed", 0 < n_results < total and page.get_attribute('[data-cat="results"]', "aria-pressed") == "true" and page.get_attribute('[data-cat="all"]', "aria-pressed") == "false" and "Results & Performance" in page.inner_text("#faq-status"), f"{n_results} / {page.inner_text('#faq-status')}")
    page.fill("#faq-q", "password"); page.wait_for_timeout(600)
    check("a category with no match for the search is greyed out", page.locator("[data-cat][disabled]").count() >= 1)
    page.fill("#faq-q", ""); page.click('[data-cat="all"]'); page.wait_for_timeout(300)
    # accordions: mouse
    q = page.locator(".inf-qa").nth(2)
    q.locator("summary").click(); page.wait_for_timeout(150)
    check("clicking a question opens its answer, clicking again folds it", q.evaluate("(d) => d.open") is True and (q.locator("summary").click() or True) and q.evaluate("(d) => d.open") is False)
    # accordions: keyboard
    page.evaluate("document.querySelectorAll('.inf-qa summary')[4].focus()")
    page.keyboard.press("Enter"); page.wait_for_timeout(100)
    opened = page.evaluate("document.querySelectorAll('.inf-qa')[4].open")
    page.keyboard.press("Space"); page.wait_for_timeout(100)
    closed = not page.evaluate("document.querySelectorAll('.inf-qa')[4].open")
    check("keyboard: Enter opens a question, Space folds it again", opened and closed)
    # deep links
    goto_route(page, "#/faq?open=lb-rank-rule"); page.wait_for_timeout(800)
    check("?open=lb-rank-rule opens that answer and brings it just under the top bar", page.evaluate("document.getElementById('faq-lb-rank-rule').open") is True and abs(top_of(page, "#faq-lb-rank-rule") - (nav_h(page) + 16)) <= 14, str(top_of(page, "#faq-lb-rank-rule")))
    goto_route(page, "#/faq?q=reset%20password"); page.wait_for_timeout(700)
    check("?q=reset%20password fills the search box and filters", page.input_value("#faq-q") == "reset password" and page.locator(".inf-qa").count() < total)
    goto_route(page, "#/faq?cat=leaderboard"); page.wait_for_timeout(500)
    check("?cat=leaderboard selects that category", page.get_attribute('[data-cat="leaderboard"]', "aria-pressed") == "true")
    goto_route(page, "#/faq?cat=nonsense&open=%3Cscript%3E&q=" + "x" * 400); page.wait_for_timeout(500)
    check("nonsense parameters are ignored safely (unknown category, markup in ?open=, 400-character ?q=)", page.get_attribute('[data-cat="all"]', "aria-pressed") == "true" and len(page.input_value("#faq-q")) <= 120 and not errors, str(errors))
    goto_route(page, "#/faq"); page.wait_for_timeout(400)
    mail = page.get_attribute('.inf-cta-actions a[href^="mailto:"]', "href")
    check("the 'Email support' button is a real mailto: to the support address with a subject", mail.startswith(f"mailto:{SUPPORT_EMAIL}?subject=") and "body=" in mail, mail[:120])
    check("the 'Open the Help Center' button goes to #/help", page.locator('.inf-cta-actions a[href="#/help"]').count() == 1)
    check("no errors on FAQ", not errors and not seen["bad"], str(errors))
    ctx.close()
    # phone
    ctx, page, errors, seen = open_page(browser, "#/faq", vp="mobile")
    page.fill("#faq-q", "timer"); page.wait_for_timeout(700)
    check("[mobile] the search works on a phone, with the keyboard-friendly Enter key closing the keyboard", page.locator(".inf-qa").count() >= 1 and (page.keyboard.press("Enter") or True) and page.evaluate("document.activeElement.id") != "faq-q")
    check("[mobile] the category chips scroll sideways inside their own row, not the page", no_overflow(page))
    ctx.close()

    # ------------------------------------------------------------------ 5. Help Center
    print("\n[5] Help Center")
    ctx, page, errors, seen = open_page(browser, "#/help", grant=True)
    check("Help has the search, eight topic tiles and the nine guide sections",
          page.locator("#help-q").is_visible() and page.locator('a[data-jump]').filter(has=page.locator(".inf-card-title")).count() == 8 and page.locator(".inf-section").count() >= 10, str(page.locator(".inf-section").count()))
    page.click('.inf-card--link[data-jump="troubleshooting"]'); page.wait_for_timeout(800)
    check("a topic tile jumps to its guide, under the top bar, without leaving #/help", abs(top_of(page, "#h-troubleshooting") - (nav_h(page) + 16)) <= 12 and page.evaluate("location.hash") == "#/help", f"{top_of(page, '#h-troubleshooting')} {page.evaluate('location.hash')}")
    check("…and moves keyboard focus to that heading", page.evaluate("document.activeElement.id") == "h-troubleshooting")
    page.click("#help-cant-log-in summary"); page.wait_for_timeout(150)
    check("troubleshooting items open like the FAQ", page.evaluate("document.getElementById('help-cant-log-in').open") is True)
    page.fill("#help-q", "password"); page.wait_for_timeout(700)
    sug = page.locator("#help-suggest a")
    check("typing in the search shows up to five suggested answers right below it, then 'See all … results'", page.locator("#help-suggest").is_visible() and 3 <= sug.count() <= 6 and sug.last.inner_text().strip().lower().startswith("see all"), f"{sug.count()} {sug.last.inner_text()!r}")
    page.fill("#help-q", "reset password"); page.wait_for_timeout(700)
    check("a suggestion links to the matching FAQ answer", (page.get_attribute("#help-suggest li a", "href") or "").startswith("#/faq?open="))
    page.keyboard.press("Enter"); page.wait_for_selector('.inf[data-page="faq"]', timeout=5000); page.wait_for_timeout(400)
    check("Enter in the Help search opens the FAQ with the same words", page.evaluate("location.hash") == "#/faq?q=reset%20password" and page.input_value("#faq-q") == "reset password", page.evaluate("location.hash"))
    goto_route(page, "#/help"); page.wait_for_selector('.inf[data-page="help"]'); page.wait_for_timeout(300)
    page.fill("#help-q", "qqzzxx"); page.wait_for_timeout(600)
    check("a search with no quick answer offers the FAQ search and 'Contact support'", "No quick answer" in page.inner_text("#help-suggest") and page.locator('#help-suggest a[href="#/help?section=contact"]').count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("Escape clears the Help search and hides the suggestions", page.input_value("#help-q") == "" and not page.locator("#help-suggest").is_visible())
    page.click('.inf-hero-links a[data-jump="contact"]'); page.wait_for_timeout(700)
    check("the 'Popular: Contact support' link jumps to the contact section", abs(top_of(page, "#h-contact") - (nav_h(page) + 16)) <= 12)
    mail = page.get_attribute(".inf-contact-actions a.btn", "href")
    check("'Email support' is a real mailto: with a subject and a 'what to include' template", mail.startswith(f"mailto:{SUPPORT_EMAIL}?subject=") and "body=" in mail and "Date%20and%20time" in mail, mail[:140])
    check("the support address is also shown as a plain mailto: link", page.locator(f'.inf-contact-mail[href="mailto:{SUPPORT_EMAIL}"]').count() == 1)
    page.click("[data-copy]"); page.wait_for_timeout(300)
    clip = ""
    try: clip = page.evaluate("navigator.clipboard.readText()")
    except Exception: pass
    check("'Copy address' copies the support address and says so", "copied" in page.inner_text("#help-copy-status").lower() and clip in ("", SUPPORT_EMAIL), f"{page.inner_text('#help-copy-status')!r} clip={clip!r}")
    check("no fake support: no form, text area, chat widget, iframe or ticket button on the Help page", page.locator(".inf form, .inf textarea, .inf iframe, [class*=chat], [id*=chat]").count() == 0 and not re.search(r"open a ticket|start a chat|chat now|talk to an agent|submit a ticket", page.inner_text(".inf"), re.I))
    check("no promised reply time", not re.search(r"within \d+ ?(hours|business days|days)|24 ?hours|24/7|instant(ly)? reply|reply (in|within)", page.inner_text("#contact"), re.I))
    rel = page.locator(".inf-related a").first.get_attribute("href")
    page.locator(".inf-related a").first.click(); page.wait_for_selector('.inf[data-page="faq"]', timeout=5000); page.wait_for_timeout(700)
    check("a 'Related questions' link opens that question in the FAQ", page.evaluate("location.hash") == rel and page.locator(".inf-qa[open]").count() == 1, rel)
    check("no errors on Help", not errors and not seen["bad"], str(errors))
    ctx.close()

    # ------------------------------------------------------------------ 6. Privacy + Terms
    print("\n[6] Privacy Policy and Terms & Conditions")
    for route, n_sections, deep, jump_to in (("privacy", 17, "your-rights", "retention"), ("terms", 15, "restrictions", "integrity")):
        ctx, page, errors, seen = open_page(browser, f"#/{route}")
        info = page.evaluate("""() => ({ secs: document.querySelectorAll('.inf-legal-sec').length, toc: document.querySelectorAll('[data-toc-link]').length,
                                         nums: [...document.querySelectorAll('.inf-num')].map((e) => e.textContent.trim()).join(','), chips: document.querySelectorAll('.inf-tbc').length,
                                         notes: document.querySelectorAll('.inf-note--tbc[data-pending]').length, time: (document.querySelector('.inf-meta time') || {}).getAttribute && document.querySelector('.inf-meta time').getAttribute('datetime'),
                                         maxLine: Math.max(...[...document.querySelectorAll('.inf-prose p')].map((p) => Math.round(p.getBoundingClientRect().width))) })""")
        check(f"[{route}] {n_sections} numbered sections, 1…{n_sections}, and a contents entry for each", info["secs"] == n_sections and info["toc"] == n_sections and info["nums"] == ",".join(str(i) for i in range(1, n_sections + 1)), str(info))
        check(f"[{route}] 'Last updated' shows the date set in info-config.js ({LEGAL_DATE[route]})", info["time"] == LEGAL_DATE[route], str(info["time"]))
        check(f"[{route}] while owner facts are missing the page says so — a notice on top and a marked note in place (and neither once they are filled in)", (info["chips"] > 0) == (info["notes"] > 0) and info["notes"] <= 1, str(info))
        check(f"[{route}] text is set in a readable line (≤ 760px wide)", info["maxLine"] <= 760, str(info["maxLine"]))
        page.click(f'[data-toc-link][data-jump="{jump_to}"]'); page.wait_for_timeout(900)
        check(f"[{route}] a contents link scrolls the section under the top bar and focuses its heading", abs(top_of(page, f"#{jump_to}") - (nav_h(page) + 16)) <= 12 and page.evaluate("document.activeElement.id") == f"h-{jump_to}", str(top_of(page, f"#{jump_to}")))
        check(f"[{route}] the contents list marks where you are (aria-current)", page.evaluate("(document.querySelector('[data-toc-link][aria-current]') || {dataset: {}}).dataset.jump") == jump_to)
        goto_route(page, f"#/{route}?section={deep}"); page.wait_for_timeout(800)
        check(f"[{route}] ?section={deep} deep link lands on that section", abs(top_of(page, f"#{deep}") - (nav_h(page) + 16)) <= 12, str(top_of(page, f"#{deep}")))
        goto_route(page, f"#/{route}"); page.wait_for_selector(".inf-legal-sec"); page.wait_for_timeout(300)
        page.evaluate("document.querySelector('.inf').dataset.marker = 'same'")
        link = page.locator(f'.inf-prose a[href="#/{route}?section=contact"]').first
        if link.count():
            link.click(); page.wait_for_timeout(800)
            check(f"[{route}] a link to another section of the same page scrolls there and does not redraw the page", abs(top_of(page, "#contact") - (nav_h(page) + 16)) <= 12 and page.evaluate("document.querySelector('.inf').dataset.marker") == "same", str(top_of(page, "#contact")))
        mails = page.eval_on_selector_all('.inf a[href^="mailto:"]', "els => els.map((e) => e.getAttribute('href'))")
        check(f"[{route}] every email link is a valid mailto: to the support address", mails and all(m.startswith(f"mailto:{SUPPORT_EMAIL}") for m in mails), str(mails))
        ext = page.eval_on_selector_all('.inf a[href^="https:"]', "els => els.map((e) => [e.target, e.rel])")
        check(f"[{route}] external links open in a new tab with rel=noopener", all(t == "_blank" and "noopener" in r for t, r in ext), str(ext))
        check(f"[{route}] no errors", not errors and not seen["bad"], str(errors))
        ctx.close()
        # phone: contents list is a closed accordion that folds away again after a jump
        ctx, page, errors, seen = open_page(browser, f"#/{route}", vp="mobile")
        check(f"[{route}] [mobile] the contents list starts folded", page.evaluate("document.querySelector('.inf-toc-box').open") is False)
        page.click(".inf-toc-sum"); page.wait_for_timeout(200)
        was_open = page.evaluate("document.querySelector('.inf-toc-box').open")
        page.click(f'[data-toc-link][data-jump="{jump_to}"]'); page.wait_for_timeout(900)
        check(f"[{route}] [mobile] opening it, choosing a section lands exactly on it and folds the list again",
              was_open and abs(top_of(page, f"#{jump_to}") - (nav_h(page) + 16)) <= 12 and page.evaluate("document.querySelector('.inf-toc-box').open") is False, str(top_of(page, f"#{jump_to}")))
        ctx.close()
    # a table stays readable on a phone (it turns into stacked cards with the column name above each value)
    ctx, page, errors, seen = open_page(browser, "#/privacy", vp="mobile")
    cell = page.evaluate("""() => { const td = document.querySelector('.inf-table td'); const cs = getComputedStyle(td, '::before'); return { label: td.getAttribute('data-label'), content: cs.content, display: cs.display }; }""")
    check("[mobile] table cells carry their column name (stacked card layout)", bool(cell["label"]) and cell["display"] == "block", str(cell))
    ctx.close()

    # ------------------------------------------------------------------ 7. Credits
    print("\n[7] Credits")
    ctx, page, errors, seen = open_page(browser, "#/credits")
    cards = page.locator(".inf-member")
    n = cards.count()
    n_ph = page.locator(".inf-member.is-placeholder").count()
    check("the team grid shows cards and a clear note while any card is still a placeholder", n >= 1 and (n_ph > 0) == (page.locator(".inf-note--tbc").count() == 1), f"{n} cards, {n_ph} placeholders")
    if n_ph:
        ph = page.evaluate("""() => { const c = document.querySelector('.inf-member.is-placeholder'); const cs = getComputedStyle(c);
              return { dashed: cs.borderTopStyle === 'dashed', icon: !!c.querySelector('.user-avatar i.fa-user'), flag: !!c.querySelector('.inf-tbc'), img: !!c.querySelector('img'), links: c.querySelectorAll('a').length }; }""")
        check("placeholder cards are dashed, show a person icon and 'To be confirmed' — no photo, no links, no invented name", ph["dashed"] and ph["icon"] and ph["flag"] and not ph["img"] and ph["links"] == 0, str(ph))
        check("the project invents nobody: placeholder cards carry only the generic wording", set(page.eval_on_selector_all(".inf-member.is-placeholder .inf-member-name", "els => els.map((e) => e.textContent.trim())")) == {"Team member name"})
    check("the tools section credits Firebase, Font Awesome and Google Fonts", all(w in page.inner_text("#tools") for w in ("Firebase", "Font Awesome", "Google Fonts")))
    check("no payment, donation or advertising content, no logos or outside images", not re.search(r"donat|sponsor|advert|payment|buy |subscribe|pricing", page.inner_text(".inf"), re.I) and page.locator(".inf img").count() == 0)
    check("the closing section thanks the students and offers a mailto: and the Help Center", page.locator(f'.inf-cta a[href="mailto:{SUPPORT_EMAIL}"]').count() == 1 and page.locator('.inf-cta a[href="#/help?section=contact"]').count() == 1 and page.locator('.inf-cta a[href="#/about"]').count() == 1)
    check("the shipped Credits data produces no warnings in the console", not [w for w in seen["warn"] if "Credits" in w], str(seen["warn"]))
    ctx.close()

    # fixtures: FAKE members, injected into the real page (never shipped) — fallbacks, validation, escaping
    FIXTURE = [
        {"name": "Test Person One", "role": "Fixture role", "bio": "A fake biography for a test.", "photo": "assets/logo.svg",
         "links": [{"type": "linkedin", "url": "https://www.linkedin.com/in/test-one"}, {"type": "github", "url": "https://github.com/test-one"}, {"type": "email", "url": "test.one@example.com"}]},
        {"name": "Test Person Two Who Has A Very Long Name That Must Wrap", "role": "A very long role description that has to wrap over several lines inside the card without overflowing", "bio": "", "photo": "https://example.com/missing-photo.jpg", "links": []},
        {"name": "<img src=x onerror=window.__pwned=1>", "role": "<b onmouseover=window.__pwned=1>role</b>", "bio": "<script>window.__pwned=1</script>", "photo": "javascript:window.__pwned=1",
         "links": [{"type": "website", "url": "javascript:window.__pwned=1"}, {"type": "linkedin", "url": "https://evil.example.org/in/x"}]},
        {"name": "", "role": "", "bio": "", "photo": "", "links": []},
        {"name": "রহিম উদ্দিন", "role": "Fixture", "bio": "", "photo": "", "links": []},
    ]
    for vp in ("desktop", "mobile"):
        ctx, page, errors, seen = open_page(browser, "#/credits", vp=vp)
        res = page.evaluate("""async (members) => {
          const core = await import('/js/info-core.js'); const mod = await import('/js/page-credits.js'); const ui = await import('/js/info-ui.js');
          const norm = members.map(core.normalizeMember);
          document.querySelector('#generic-page-content').innerHTML = mod.creditsPageHtml(norm);
          ui.bindImageFallbacks(document.querySelector('.inf'));
          return norm.flatMap((m) => m.problems).length;
        }""", FIXTURE)
        page.wait_for_timeout(800)
        av = page.eval_on_selector_all(".inf-avatar", "els => els.map((e) => e.querySelector('img') ? 'IMG' : (e.querySelector('i') ? 'ICON' : e.textContent.trim()))")
        check(f"[{vp}] avatars: working photo → picture · photo that cannot load → initials · no photo → initials · placeholder → icon", av[0] == "IMG" and av[1] == "TW" and av[3] == "ICON" and av[4] == "রউ", str(av))
        check(f"[{vp}] hostile text is shown as plain text and nothing runs", page.evaluate("window.__pwned") is None and page.locator(".inf-member-name").nth(2).inner_text().startswith("<img src=x") and page.locator(".inf-member img[src='x']").count() == 0 and page.locator(".inf-member script, .inf-member [onmouseover], .inf-member [onerror]").count() == 0)
        check(f"[{vp}] unsafe photo and links are refused (and counted as problems for the owner)", res >= 3 and page.locator('.inf-member a[href^="javascript"], .inf-member a[href*="evil.example"]').count() == 0 and page.locator(".inf-member").nth(2).locator("a").count() == 0, str(res))
        links = page.eval_on_selector_all(".inf-team > li:first-child .inf-member a", "els => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('target')])")
        check(f"[{vp}] profile links are named after the person, external ones open in a new tab, mailto: does not", links[:3] == [["Test Person One on LinkedIn (opens in a new tab)", "_blank"], ["Test Person One on GitHub (opens in a new tab)", "_blank"], ["Email Test Person One", None]], str(links))
        check(f"[{vp}] long names and roles wrap inside their cards", no_overflow(page) and page.evaluate(OVERFLOW)["off"] == [])
        shot(page, f"info-credits-fixture-{vp}")
        ctx.close()

    # ------------------------------------------------------------------ 8. No horizontal overflow
    print("\n[8] No horizontal overflow at 320 / 390 / 820 / 1366 px")
    SIZES = [("320", {"width": 320, "height": 640}), ("390", VIEWPORTS["mobile"]), ("820", VIEWPORTS["tablet"]), ("1366", VIEWPORTS["desktop"])]
    for label, vpz in SIZES:
        ctx = make_context(browser, vpz, user=None)
        page = new_page(ctx, [])
        for route, *_ in PAGES:
            go(page, f"#/{route}")
            page.wait_for_selector(f'.inf[data-page="{route}"]', timeout=8000)
            page.wait_for_timeout(250)
            if route == "faq":
                page.fill("#faq-q", "password"); page.wait_for_timeout(600)
            if route == "help":
                page.fill("#help-q", "reset password"); page.wait_for_timeout(600)
            o = page.evaluate(OVERFLOW)
            check(f"[{label}px] #/{route} fits the screen (page {o['scroll']}px in {o['client']}px)", o["scroll"] <= o["client"] and not o["off"], str(o))
            if route in ("privacy", "terms"):
                page.evaluate("document.querySelectorAll('.inf-toc-box').forEach((d) => d.open = true)")
                o = page.evaluate(OVERFLOW)
                check(f"[{label}px] #/{route} still fits with the contents list open", o["scroll"] <= o["client"] and not o["off"], str(o))
            if label in ("390", "820"):
                shot(page, f"info-{route}-{label}")
        ctx.close()
    ctx = make_context(browser, VIEWPORTS["mobile"], user=None)
    page = new_page(ctx, [])
    go(page, "#/privacy"); page.wait_for_selector(".inf-legal-sec")
    check("[mobile] the hero runs edge to edge under the top bar (no side gap)", page.evaluate("Math.round(document.querySelector('.inf-hero').getBoundingClientRect().left)") == 0)
    ctx.close()

    # ------------------------------------------------------------------ 9. Keyboard
    print("\n[9] Keyboard: tab order, visible focus, names")
    for route, *_ in PAGES:
        ctx, page, errors, seen = open_page(browser, f"#/{route}")
        stops = tab_stops(page, 45)
        no_ring = [s["label"] or s["tag"] for s in stops if not s["ring"]]
        unnamed = [s["tag"] for s in stops if not s["named"]]
        check(f"#/{route}: {len(stops)} tab stops inside the page, every one shows a focus ring", len(stops) >= (3 if route == "credits" else 6) and not no_ring, f"no ring: {no_ring}")
        check(f"#/{route}: every tab stop has an accessible name and is visible", not unnamed and all(s["visible"] for s in stops), f"unnamed: {unnamed}")
        ctx.close()
    ctx, page, errors, seen = open_page(browser, "#/privacy", vp="mobile")
    page.evaluate("document.querySelector('.inf-toc-sum').focus()")
    page.keyboard.press("Enter"); page.wait_for_timeout(150)
    opened = page.evaluate("document.querySelector('.inf-toc-box').open")
    page.evaluate("document.querySelector('[data-toc-link][data-jump=\"security\"]').focus()")
    page.keyboard.press("Enter"); page.wait_for_timeout(900)
    check("[mobile] the contents list opens with Enter, a link opened with Enter jumps there and focuses the heading", opened and page.evaluate("document.activeElement.id") == "h-security" and abs(top_of(page, "#security") - (nav_h(page) + 16)) <= 12, f"{page.evaluate('document.activeElement.id')} {top_of(page, '#security')}")
    ctx.close()
    ctx, page, errors, seen = open_page(browser, "#/credits")
    page.evaluate("document.querySelector('.inf-cta a[href=\"#/about\"]').focus()")
    page.keyboard.press("Enter"); page.wait_for_selector('.inf[data-page="about"]', timeout=5000)
    check("a link works with Enter (Credits → About)", page.evaluate("location.hash") == "#/about")
    ctx.close()

    # ------------------------------------------------------------------ 10. Markup
    print("\n[10] Markup: ids, references, names, headings, missing files")
    for route, *_ in PAGES:
        for label, vpz in (("desktop", VIEWPORTS["desktop"]), ("mobile", VIEWPORTS["mobile"])):
            ctx, page, errors, seen = open_page(browser, f"#/{route}", viewport=vpz)
            if route == "faq":
                page.fill("#faq-q", "password"); page.wait_for_timeout(600)
            problems = page.evaluate(LINT)
            check(f"[{label}] #/{route}: clean markup (no duplicate ids, every reference resolves, links / buttons / images named, headings in order)", not problems, "; ".join(problems[:6]))
            check(f"[{label}] #/{route}: every stylesheet, script and image it asks for exists", not seen["bad"], str(seen["bad"]))
            ctx.close()
    # every in-app link on every page leads somewhere that exists (route) — and its ?section= / ?open= target exists too
    ctx = make_context(browser, VIEWPORTS["desktop"], user=None)
    page = new_page(ctx, [])
    hrefs = set()
    for route, *_ in PAGES:
        go(page, f"#/{route}"); page.wait_for_selector(f'.inf[data-page="{route}"]', timeout=8000)
        page.evaluate("document.querySelectorAll('details').forEach((d) => d.open = true)")
        hrefs.update(page.eval_on_selector_all('.inf a[href^="#/"], #site-footer a[href^="#/"]', "els => els.map((e) => e.getAttribute('href'))"))
    hrefs.discard("#/home")
    broken = []
    for href in sorted(hrefs):
        route = href[2:].split("?")[0]
        qs = dict(p.split("=", 1) for p in href.split("?", 1)[1].split("&")) if "?" in href else {}
        go(page, "#/home"); page.wait_for_timeout(100)
        goto_route(page, href)
        page.wait_for_timeout(450)
        if "Page not found" in (page.title() or "") or page.locator("text=Page not found").count():
            broken.append(f"{href} → 404"); continue
        if "section" in qs and not page.evaluate("(id) => !!document.getElementById('h-' + id) || !!document.getElementById(id)", qs["section"]):
            broken.append(f"{href} → no such section")
        if "open" in qs and not page.evaluate("(id) => !!document.getElementById('faq-' + id)", qs["open"]):
            broken.append(f"{href} → no such question")
    check(f"all {len(hrefs)} distinct in-app links on the six pages and the footer reach a page that exists (and their section / question)", not broken, "; ".join(broken))
    ctx.close()

    # ------------------------------------------------------------------ 11. Lifecycle
    print("\n[11] Lifecycle: clean-up and no stacking")
    ctx = make_context(browser, VIEWPORTS["desktop"], user=None)
    ctx.add_init_script("""(() => { window.__lst = {}; const add = window.addEventListener, rem = window.removeEventListener;
      window.addEventListener = function (t, f, o) { (window.__lst[t] = window.__lst[t] || new Set()).add(f); return add.call(this, t, f, o); };
      window.removeEventListener = function (t, f, o) { if (window.__lst[t]) window.__lst[t].delete(f); return rem.call(this, t, f, o); }; })();""")
    mine = "({ scroll: [...(window.__lst.scroll || [])].filter((f) => f.name === 'onScroll').length, resize: [...(window.__lst.resize || [])].filter((f) => f.name === 'onScroll').length })"
    errors = []
    page = new_page(ctx, errors)
    go(page, "#/home"); page.wait_for_selector("#site-footer .ftr-main", timeout=8000); page.wait_for_timeout(500)
    goto_route(page, "#/privacy"); page.wait_for_selector(".inf-legal-sec"); page.wait_for_timeout(300)
    on_page = page.evaluate(mine)
    check("the contents list's 'you are here' marker listens to scroll and resize while a legal page is open (the probe sees it)", on_page["scroll"] == 1 and on_page["resize"] == 1, str(on_page))
    for _ in range(3):
        goto_route(page, "#/terms"); page.wait_for_selector('.inf[data-page="terms"]'); page.wait_for_timeout(200)
        goto_route(page, "#/privacy"); page.wait_for_selector('.inf[data-page="privacy"]'); page.wait_for_timeout(200)
    after3 = page.evaluate(mine)
    check("a legal page's scroll / resize listeners are removed when you leave it — six visits never pile up", after3["scroll"] == 1 and after3["resize"] == 1, str(after3))
    goto_route(page, "#/home"); page.wait_for_timeout(500)
    gone = page.evaluate(mine)
    check("…and none are left once you are back on Home", gone["scroll"] == 0 and gone["resize"] == 0, str(gone))
    page.evaluate("window.scrollTo(0, 400)"); page.wait_for_timeout(200)
    check("scrolling afterwards causes no errors", not errors, str(errors))
    goto_route(page, "#/faq"); page.wait_for_selector('.inf[data-page="faq"]')
    goto_route(page, "#/about"); page.wait_for_selector('.inf[data-page="about"]'); page.wait_for_timeout(300)
    check("leaving FAQ for About shows only About (one page root, the About title)", page.locator(".inf").count() == 1 and page.title() == "About Us — Tech Verse Exam")
    goto_route(page, "#/login"); page.wait_for_timeout(500)
    check("an existing page after the information pages is unaffected (Login keeps its own title and has no information page on it)", page.title().startswith("Log in") and page.locator(".inf").count() == 0, page.title())
    ctx.close()

    browser.close()

sys.exit(finish())
