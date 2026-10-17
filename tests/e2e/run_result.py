"""End-to-end checks for the post-exam Result Experience, against the in-memory Firestore (no network).
   python3 tests/e2e/run_result.py [--shots]      → exit code 0 = all checks passed

   submit moment → result reveal → analytics → save / retry → retake → PDF → themes → motion settings → failure paths.
   Expected numbers come from the seed exam "live1": 3 questions, +1 per right answer, −0.25 per wrong one, pass mark 50 %.
     right answers are option 1 · 2 · 2   (0-based picks 0 / 1 / 1)
   so  picks [0, 1, 0] → 2 right, 1 wrong → score 1.75 → 58 %.

   Not covered here (needs real devices / services): see the list printed in the final report of the task.
"""
import sys, os, re, json, subprocess, tempfile, datetime, time
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from playwright.sync_api import sync_playwright

BN = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")
bn = lambda v: str(v).translate(BN)
has = lambda s, *subs: all(x in s for x in subs)
before = lambda s, a, b: a in s and b in s and s.index(a) < s.index(b)

# The container has no Bengali web fonts (and no network to fetch them): map the site's three families onto the
# system FreeSans / FreeSerif, which do carry Bengali, so text wraps like real Bengali text. Layout is indicative only.
FONT_CSS = """
@font-face { font-family: 'Hind Siliguri'; font-weight: 100 600; src: local('FreeSans'); }
@font-face { font-family: 'Hind Siliguri'; font-weight: 601 900; src: local('FreeSansBold'), local('FreeSans Bold'); }
@font-face { font-family: 'Noto Sans Bengali'; font-weight: 100 600; src: local('FreeSans'); }
@font-face { font-family: 'Noto Sans Bengali'; font-weight: 601 900; src: local('FreeSansBold'), local('FreeSans Bold'); }
@font-face { font-family: 'Noto Serif Bengali'; font-weight: 100 600; src: local('FreeSerif'); }
@font-face { font-family: 'Noto Serif Bengali'; font-weight: 601 900; src: local('FreeSerifBold'), local('FreeSerif Bold'); }
"""

TINY = {"width": 320, "height": 640}


def fresh(browser, viewport="mobile", scheme="dark", reduced=False, seed=None, deny=None, user="stu1"):
    errors = []
    vp = VIEWPORTS[viewport] if isinstance(viewport, str) else viewport
    ctx = make_context(browser, vp, seed=seed, user=user, deny=deny)
    install_clock(ctx)
    ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = %s; document.head.appendChild(s); });" % json.dumps(FONT_CSS))
    page = new_page(ctx, errors)
    page.emulate_media(color_scheme=scheme, reduced_motion="reduce" if reduced else "no-preference")
    return ctx, page, errors


def open_exam(page, exam_id="live1"):
    go(page, f"#/exam?id={exam_id}")
    page.wait_for_selector("#exs-start-confirm", timeout=9000)
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    page.wait_for_selector(".exs-option", timeout=5000)


def think(page, seconds):
    """The student spends `seconds` on the question that is showing (the fake clock jumps; the 'server' clock follows)."""
    ms = int(seconds * 1000)
    advance[0] += ms
    page.clock.fast_forward(ms)


def pick(page, picks, thinks=None):
    """One question at a time: choose option picks[i] (None = leave it), spend thinks[i] seconds, move on; stop on the last question."""
    for i, p in enumerate(picks):
        if p is not None:
            page.locator(".exs-option").nth(p).click()
        if thinks:
            think(page, thinks[i])
        if i < len(picks) - 1:
            page.locator("#q-next").click()
            page.wait_for_timeout(120)
    page.wait_for_selector("#q-submit", state="visible", timeout=3000)


def pick_all_on_one_page(page, picks):
    for i, p in enumerate(picks):
        if p is not None:
            page.locator(".exs-question-card").nth(i).locator(".exs-option").nth(p).click()
            page.wait_for_timeout(60)


def double_click_in_page(page, selector):
    """Two click events in the same tick (what a nervous double tap or a key-repeat can produce) — Playwright's dblclick can't
    do that when the first click opens a dialog that covers the button."""
    page.evaluate("(sel) => { const b = document.querySelector(sel); b.click(); b.click(); }", selector)


SAMPLER = """() => {
  window.__samples = null;
  const obs = new MutationObserver(() => {
    const root = document.getElementById('rx-root');
    if (!root || window.__samples) return;
    obs.disconnect();
    const circle = root.querySelector('#rx-stage .rx-check-circle');
    const tick = root.querySelector('#rx-stage .rx-check-tick');
    const stage = root.querySelector('#rx-stage');
    const ring = root.querySelector('.rx-ring-text b');
    const t0 = performance.now(); const rows = []; window.__samples = rows;
    const off = (el) => (el ? parseFloat(getComputedStyle(el).strokeDashoffset) : null);
    (function frame() {
      const ins = [...root.querySelectorAll('.rx-in')];
      rows.push({ t: Math.round(performance.now() - t0), c: off(circle), k: off(tick), r: ring ? ring.textContent : null,
                  stage: stage ? getComputedStyle(stage).display : 'none', done: root.classList.contains('rx-stage-done'),
                  anim: root.classList.contains('rx-animate'), static: root.classList.contains('rx-static'),
                  tickAnim: tick ? getComputedStyle(tick).animationName : null,
                  hiddenIn: ins.filter((e) => parseFloat(getComputedStyle(e).opacity) < 0.99).length });
      if (performance.now() - t0 < 2700) requestAnimationFrame(frame);
    })();
  });
  obs.observe(document.body, { childList: true, subtree: true });
}"""

SNAPSHOT = """() => {
  const q = (s) => document.querySelector(s);
  const t = (s) => (q(s)?.innerText || '').replace(/\\s+/g, ' ').trim();
  const root = q('#rx-root');
  return {
    exists: !!root, theme: root?.dataset.theme, cls: root ? root.className : '',
    ring: t('.rx-ring-text b'), tier: t('#rx-tier-title'), tierMsg: t('.rx-tier-msg'), score: t('.rx-score'), pills: t('.rx-pills'),
    save: t('#exs-save-status'), saveCls: q('#exs-save-status')?.className || '', retry: document.querySelectorAll('.exs-save-retry').length,
    ok: t('.rx-stat--ok .rx-stat-num'), bad: t('.rx-stat--bad .rx-stat-num'), skip: t('.rx-stat--skip .rx-stat-num'), time: t('.rx-stat--time .rx-stat-num'),
    okSub: t('.rx-stat--ok .rx-stat-sub'), badSub: t('.rx-stat--bad .rx-stat-sub'), skipSub: t('.rx-stat--skip .rx-stat-sub'), timeSub: t('.rx-stat--time .rx-stat-sub'),
    notes: [...document.querySelectorAll('.rx-note')].map((n) => n.innerText.replace(/\\s+/g, ' ').trim()),
    neg: t('#rx-negative'), timeCard: t('#rx-time'), acc: t('#rx-accuracy'), cmp: t('#rx-compare'), subj: t('#rx-subjects'), tips: t('#rx-suggest'),
    review: t('#rx-review'), kicker: t('.rx-kicker'), srSummary: t('.rx-hero .sr-only'), live: t('#rx-live'), meta: t('.rx-meta'),
    stageSub: (q('#rx-stage .rx-stage-sub')?.textContent || '').trim(),
    actions: [...document.querySelectorAll('.rx-actions .rx-btn')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()),
    btnMinH: Math.min(...[...document.querySelectorAll('.rx-actions .rx-btn')].map((b) => b.getBoundingClientRect().height)),
    focus: document.activeElement ? document.activeElement.id : '',
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    stageDisplay: q('#rx-stage') ? getComputedStyle(q('#rx-stage')).display : 'absent',
    barAnim: q('.rx-ring-bar') ? getComputedStyle(q('.rx-ring-bar')).animationName : null,
    btnTransition: q('#exs-retake') ? getComputedStyle(q('#exs-retake')).transitionDuration : null,
    report: !!q('#exs-report'), reportClass: document.body.classList.contains('exs-has-report'),
    examTaking: document.body.classList.contains('exam-taking'), hash: location.hash,
  };
}"""

# Every visible text in the result sheet against its real, composited background (WCAG: 4.5:1, large text 3:1).
CONTRAST = """() => {
  const root = document.getElementById('rx-root'); if (!root) return { error: 'no root' };
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const e of chain.reverse()) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) base = over(c, base); } return base; };
  const bad = []; let n = 0; let worst = 99;
  const seen = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode; const txt = node.textContent.trim(); if (!txt) continue;
    const el = node.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width < 3 || r.height < 3 || parseFloat(cs.opacity) < 0.05) continue;
    if (el.closest('.rx-stage')) continue;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgOf(el); const fg = over(fg0, bg);
    const size = parseFloat(cs.fontSize); const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5; const cr = ratio(fg, bg); n++; worst = Math.min(worst, cr);
    if (cr < need) bad.push({ text: txt.slice(0, 40), ratio: Math.round(cr * 100) / 100, need, size, cls: el.className.toString().slice(0, 40) });
  }
  return { checked: n, bad, worst: Math.round(worst * 100) / 100 };
}"""

# Anything that spills out of the screen sideways or is clipped inside its own box.
LAYOUT_SCAN = """() => {
  const root = document.getElementById('rx-root'); const W = window.innerWidth; const out = [];
  root.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (cs.display === 'none' || r.width === 0) return;
    if (el.closest('#rx-stage') || el.classList.contains('sr-only') || el.closest('.sr-only')) return;
    if (r.right > W + 1 || r.left < -1) out.push({ why: 'outside viewport', el: el.tagName + '.' + el.className.toString().slice(0, 30), right: Math.round(r.right), left: Math.round(r.left) });
    if (['hidden', 'clip'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
      out.push({ why: 'clipped text', el: el.tagName + '.' + el.className.toString().slice(0, 30), sw: el.scrollWidth, cw: el.clientWidth });
  });
  return out;
}"""


def snap(page):
    return page.evaluate(SNAPSHOT)


def dump(page):
    return page.evaluate("window.__MOCK__.dump()")


def result_doc(page, uid="stu1", exam="live1"):
    return dump(page).get(f"results/{uid}_{exam}")


def stat_entry(page, exam="live1", uid="stu1"):
    return ((dump(page).get(f"userStats/{uid}") or {}).get("exams") or {}).get(exam)


def result_writes(page):
    return [w for w in writes(page) if w["path"].startswith("results/")]


def finish_stage(page):
    """Wait until the submit overlay has left and the count-up has settled."""
    page.wait_for_function("document.querySelector('#rx-root')?.classList.contains('rx-stage-done')", timeout=6000)
    page.wait_for_timeout(1500)


def submit_and_wait(page, selector="#q-submit"):
    page.locator(selector).click()
    page.wait_for_selector("#rx-root", timeout=4000)


def count_nums(samples):
    return [int(s["r"].rstrip("%")) for s in samples if s["r"] and s["r"].rstrip("%").isdigit()]


def only_expected(errors, *allowed):
    rest = [e for e in errors if not any(a in e for a in allowed)]
    return rest


def attempt_ids(doc):
    return [a.get("id") for a in (doc or {}).get("attempts", [])]


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ============================================================== 1. manual submit — the whole happy path
    print("\n[1] Manual submit, all answered (2 right, 1 wrong) — phone, dark: submit moment → reveal → analytics → save → PDF → retake")
    ctx, page, errors = fresh(browser, "mobile", scheme="dark")
    open_exam(page)
    pick(page, [0, 1, 0], thinks=[8, 75, 4])           # q2 takes much longer than the others
    page.evaluate(SAMPLER)
    t_click = time.time()
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    t_result = time.time() - t_click
    # — immediate: the screen exists right away, the exam is gone, the save starts without waiting for the animation
    check("result screen is drawn immediately after the tap (< 1 s)", t_result < 1.0, f"{t_result:.2f}s")
    page.wait_for_function("window.__MOCK__.writes.some(w => w.path.startsWith('results/'))", timeout=3000)
    early = page.evaluate("({ done: document.querySelector('#rx-root').classList.contains('rx-stage-done') })")
    check("the Firestore save starts while the submit animation is still playing", not early["done"], str(early))
    check("exam chrome is gone: body.exam-taking removed, bottom bar back", not snap(page)["examTaking"] and page.locator("#bottom-nav").is_visible())
    page.wait_for_timeout(2900)
    S = page.evaluate("window.__samples") or []
    check("animation sampled every frame (got a time series)", len(S) > 20, f"{len(S)} frames")
    if S:
        first = S[0]
        check("overlay visible from the very first frame", first["stage"] != "none" and first["anim"], str(first))
        check("check mark is DRAWN: circle + tick dashoffset animate from ~100 down to 0",
              first["c"] is not None and max(s["c"] for s in S) > 50 and min(s["c"] for s in S) <= 1 and max(s["k"] for s in S) > 50 and min(s["k"] for s in S) <= 1,
              f"circle {max(s['c'] for s in S)}→{min(s['c'] for s in S)}  tick {max(s['k'] for s in S)}→{min(s['k'] for s in S)}")
        check("tick animation is the CSS rx-draw keyframe (not a static image)", first["tickAnim"] == "rx-draw", str(first["tickAnim"]))
        nums = count_nums(S)
        check("percent counts up from 0 and never shows a wrong value (max = real score)", bool(nums) and nums[0] == 0 and nums == sorted(nums) and max(nums) == 58 and nums[-1] == 58, f"{nums[:3]}…{nums[-3:]}")
        done_at = next((s["t"] for s in S if s["done"]), None)
        check("overlay finishes by itself within ~1.7 s (no long wait)", done_at is not None and done_at <= 1700, str(done_at))
        check("count-up completes within ~2.6 s of the submit", any(s["r"] == "58%" and s["t"] <= 2600 for s in S))
    V = snap(page)
    check("overlay is gone, final percent 58 %", V["stageDisplay"] == "none" and V["ring"] == "58%", f"{V['stageDisplay']} {V['ring']}")
    check("stat cards: right 2 · wrong 1 · unanswered 0", (V["ok"], V["bad"], V["skip"]) == ("2", "1", "0"), str((V["ok"], V["bad"], V["skip"])))
    check("score text 1.75 / 3", has(V["score"], "1.75", "/ 3"), V["score"])
    check("time card shows mm:ss (≈ 1½ min of fake time) and the allowed time", re.fullmatch(r"01:[2-4]\d", V["time"]) is not None and "বরাদ্দ" in V["timeSub"], f"{V['time']} / {V['timeSub']}")
    check("pass line from the exam (50 %) is used and cleared", has(V["pills"], "পাস মার্ক ৫০%", "অতিক্রম করেছেন"), V["pills"])
    check("respectful Bengali tier message (no grade letter, no emoji)", re.search(r"[A-F][+-]?\s*(grade|গ্রেড)", V["tier"]) is None and bool(V["tier"]) and bool(V["tierMsg"]) and not re.search(r"[\U0001F300-\U0001FAFF]", V["tier"] + V["tierMsg"]), f"{V['tier']} | {V['tierMsg']}")
    check("negative marking explained with the real numbers", has(V["neg"], "০.২৫", "১টি ভুল", "1.75"), V["neg"])
    check("accuracy = 2 of 3 answered right = 66.7 %", has(V["acc"], "66.7%", "২টি সঠিক"), V["acc"])
    check("per-question time is real: slowest question named with its duration", has(V["timeCard"], "সবচেয়ে বেশি সময় লাগা প্রশ্ন", "প্রশ্ন ২") and re.search(r"১ মিনিট ১[5-6৫-৬]", V["timeCard"].translate(str.maketrans("56", "৫৬"))) is not None, V["timeCard"])
    check("time suggestion points at the same question", "প্রশ্ন ২-এ সবচেয়ে বেশি" in V["tips"], V["tips"])
    check("kicker + sr-only summary carry the same numbers", has(V["kicker"], "পরীক্ষা সফলভাবে জমা হয়েছে") and has(V["srSummary"], "সঠিক ২, ভুল ১"), V["srSummary"])
    check("live region announces the submission", V["live"] == "পরীক্ষা সফলভাবে জমা হয়েছে", V["live"])
    check("focus moved to the tier heading after the overlay", V["focus"] == "rx-tier-title", V["focus"])
    check("actions: detailed result · retake · course · PDF · mistakes", V["actions"][0].endswith("বিস্তারিত ফলাফল দেখুন") and any(a.endswith("আবার দিন") for a in V["actions"]) and any("PDF" in a for a in V["actions"]) and any("কোর্স" in a for a in V["actions"]) and any("ভুলগুলো দেখুন (১)" in a for a in V["actions"]), str(V["actions"]))
    check("action buttons are at least 44 px tall on a phone", V["btnMinH"] >= 44, str(V["btnMinH"]))
    check("attempt chip reads '#১' without a gap", "অ্যাটেম্পট #১" in V["meta"], repr(V["meta"]))
    check("review list shows the wrong question and its right answer", has(V["review"], "Which is a fruit?", "Apple"), V["review"][:200])
    # — history analytics from real data
    check("comparison: first attempt of this exam, said honestly", "প্রথম অ্যাটেম্পট" in V["cmp"], V["cmp"][:160])
    check("comparison: average of the OTHER live exams (80, 40, 90, 50 → 65 %)", "অন্যান্য পরীক্ষার গড় ৬৫%" in V["cmp"], V["cmp"])
    check("subjects: this exam's subject first, then weakest, from real results", before(V["subj"], "বাংলা", "General Knowledge") and has(V["subj"], "এই পরীক্ষা", "রিভিশন দরকার", "IQ"), V["subj"][:260])
    check("suggestions name the weak subject (General Knowledge 40 % < 60 %)", "দুর্বল বিষয়: General Knowledge" in V["tips"], V["tips"][:300])
    check("suggestions: negative-marking line uses the real penalty", "০.২৫ নম্বর কাটা গেছে" in V["tips"], V["tips"][:300])
    check("save status: saved", "ফলাফল সেভ হয়েছে" in V["save"] and V["retry"] == 0, V["save"])
    # — what was stored
    doc = result_doc(page)
    check("results doc = engine score (2 right / 1 wrong / 0 blank, 1.75 → 58 %)", bool(doc) and (doc["correctCount"], doc["wrongCount"], doc["unansweredCount"], doc["score"], doc["percent"], doc["total"]) == (2, 1, 0, 1.75, 58, 3), str(doc and {k: doc[k] for k in ("correctCount", "wrongCount", "unansweredCount", "score", "percent")}))
    check("exactly ONE attempt stored, with an attempt id and the one wrong question as review", bool(doc) and len(doc["attempts"]) == 1 and bool(doc["attempts"][0]["id"]) and len(doc["attempts"][0]["review"]) == 1 and doc["attemptNumber"] == 1)
    check("exactly one results write (no double submit)", len(result_writes(page)) == 1, str(result_writes(page)))
    st = stat_entry(page)
    check("userStats entry: n=1 p=58 b=58 + new detail fields c/w/u/tt", bool(st) and (st["n"], st["p"], st["b"], st["c"], st["w"], st["u"]) == (1, 58, 58, 2, 1, 0) and 80 <= st.get("tt", 0) <= 100, str(st))
    check("analysis-only fields are NOT written into the result doc", bool(doc) and not any(k in doc for k in ("qStats", "layout", "auto", "passPercent", "durationSeconds", "subjectId")), str(list(doc)))
    check("no horizontal overflow at 390 px", V["overflow"] <= 0, str(V["overflow"]))
    shot(page, "result-mobile-dark")
    # — PDF report: mounted only here, print layout has no UI chrome
    check("PDF report is mounted for this result screen", V["report"] and V["reportClass"])
    rep = page.evaluate("document.getElementById('exs-report').innerText.replace(/\\s+/g,' ')")
    check("report carries title, 58 %, 1.75 / 3, analysis, weak subject, the slow question", has(rep, "ফলাফল রিপোর্ট", "58%", "1.75 / 3", "বিশ্লেষণ", "General Knowledge"), rep[:300])
    page.evaluate("() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; }")
    page.locator("#exs-print-result").click()
    page.wait_for_function("window.__printCalls >= 1", timeout=4000)
    page.wait_for_timeout(300)
    check("'PDF ডাউনলোড' opens the print dialog exactly once, report still mounted", page.evaluate("window.__printCalls") == 1 and snap(page)["report"], str(page.evaluate("window.__printCalls")))
    page.emulate_media(media="print")
    pv = page.evaluate("""() => {
      const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : -1; };
      return { report: h('#exs-report'), sheet: h('#rx-root'), stage: h('#rx-stage'), actions: h('.rx-actions'), theme: h('#rx-theme'), nav: h('#topnav-root') };
    }""")
    check("print media: only the report is laid out — result sheet, overlay, buttons, theme toggle, nav take no space",
          pv["report"] > 100 and pv["sheet"] == 0 and pv["stage"] == 0 and pv["actions"] == 0 and pv["theme"] == 0 and pv["nav"] <= 0, str(pv))
    pdf_path = os.path.join(tempfile.gettempdir(), "tvexam-result-test.pdf")
    page.pdf(path=pdf_path, format="A4", print_background=True)
    txt = subprocess.run(["pdftotext", "-layout", pdf_path, "-"], capture_output=True, text=True).stdout
    info = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True).stdout
    npages = int(re.search(r"Pages:\s+(\d+)", info).group(1)) if "Pages:" in info else 0
    check("PDF text layer has the exam's real numbers (58%, 1.75 / 3, Tech Verse Exam)", has(txt, "58%", "1.75 / 3", "Tech Verse Exam"), txt[:300].replace("\n", " "))
    check("PDF has no button labels / theme toggle / animation text from the screen", "আবার দিন" not in txt and "PDF ডাউনলোড" not in txt and "লাইট / ডার্ক" not in txt)
    check("PDF is a short report (1–3 pages)", 1 <= npages <= 3, str(npages))
    subprocess.run(["pdftoppm", "-r", "70", "-png", "-f", "1", "-l", "2", pdf_path, os.path.join(SHOT_DIR if SHOTS else tempfile.gettempdir(), "result-pdf")], capture_output=True)
    page.emulate_media(media="screen")

    # — course navigation (saved → no confirm)
    page.locator("#exs-course-link").click()
    page.wait_for_function("location.hash.startsWith('#/exam?course=')", timeout=4000)
    page.wait_for_timeout(400)
    check("course link leaves the result with no 'unsaved' prompt; the PDF report is unmounted again", page.locator("#cf-ok").count() == 0 and page.locator("#rx-root").count() == 0 and page.locator("#exs-report").count() == 0 and not page.evaluate("document.body.classList.contains('exs-has-report')"), page.evaluate("location.hash"))

    # — a second attempt (the same route again): compared with the first, from the stored summary
    open_exam(page)
    pick(page, [0, 1, 1])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V2 = snap(page)
    check("second attempt: 3 right, 100 %, no 'mistakes' button", (V2["ok"], V2["bad"], V2["skip"], V2["ring"]) == ("3", "0", "0", "100%") and not any("ভুলগুলো" in a for a in V2["actions"]), str((V2["ok"], V2["ring"], V2["actions"])))
    check("negative-marking card says nothing was deducted", "কোনো ভুল উত্তর নেই" in V2["neg"], V2["neg"])
    check("comparison vs attempt #1: +42 %, new best, +1 right / −1 wrong from the stored c/w/u/tt", has(V2["cmp"], "৪২%", "নতুন সেরা ফলাফল", "সঠিক উত্তর", "+১টি", "−১টি", "(#১)"), V2["cmp"][:400])
    check("suggestions: perfect paper → praise, no 'review' nag", has(V2["tips"], "সব প্রশ্ন সঠিক") and "ভুলগুলো দেখুন" not in V2["tips"], V2["tips"][:200])
    doc2 = result_doc(page)
    st2 = stat_entry(page)
    check("second attempt stored as attempt #2 (2 attempts in the doc), best = 100", bool(doc2) and doc2["attemptNumber"] == 2 and len(doc2["attempts"]) == 2 and bool(st2) and (st2["n"], st2["p"], st2["b"]) == (2, 100, 100), str(st2))
    check("attempt #2 chip", "অ্যাটেম্পট #২" in snap(page)["meta"], snap(page)["meta"])
    check("[1] exam flow: no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================== 2. unanswered questions: confirm dialog, double tap
    print("\n[2] Unanswered questions → one confirm dialog; double tap submits once")
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, None, None])
    double_click_in_page(page, "#q-submit")
    page.wait_for_selector("#cf-ok", timeout=3000)
    page.wait_for_timeout(200)
    check("two quick taps open ONE dialog", page.locator("#cf-ok").count() == 1 and page.locator(".confirm-msg").count() == 1)
    check("dialog says how many are unanswered, in Bengali", "২টি প্রশ্নের উত্তর দেওয়া হয়নি" in page.inner_text(".confirm-msg"), page.inner_text(".confirm-msg"))
    page.locator("#cf-cancel").click()
    page.wait_for_timeout(200)
    check("'ফিরে যাই' keeps the student in the exam, nothing saved", snap(page)["examTaking"] and page.locator("#rx-root").count() == 0 and len(result_writes(page)) == 0)
    check("exam timer still running after cancelling", re.fullmatch(r"\d\d:\d\d", page.inner_text("#exam-timer").strip().split()[-1]) is not None and page.inner_text("#exam-timer").strip().split()[-1] != "00:00")
    page.locator("#q-submit").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    double_click_in_page(page, "#cf-ok")
    page.wait_for_selector("#rx-root", timeout=4000)
    finish_stage(page)
    V = snap(page)
    check("result: 1 right · 0 wrong · 2 unanswered → 33 %", (V["ok"], V["bad"], V["skip"], V["ring"]) == ("1", "0", "2", "33%"), str((V["ok"], V["bad"], V["skip"], V["ring"])))
    check("a below-pass paper gets a respectful, encouraging message (pass line 50 % → 17 % to go)", has(V["pills"], "আর ১৭% বাকি") and not has(V["tierMsg"], "ব্যর্থ", "ফেল"), f"{V['pills']} | {V['tier']} | {V['tierMsg']}")
    check("blank answers cost nothing and the card says so", "কোনো নম্বর কাটা যায়নি" in V["skipSub"] and "কোনো ভুল উত্তর নেই" in V["neg"], f"{V['skipSub']} | {V['neg']}")
    check("suggestion: 'finished early with time left' (not 'time ran out')", "সময় বাকি ছিল" in V["tips"] and "সময় শেষ হয়ে যাওয়ায়" not in V["tips"], V["tips"][:300])
    doc = result_doc(page)
    check("one attempt stored: 1 / 0 / 2, score 1, 33 %", bool(doc) and (doc["correctCount"], doc["wrongCount"], doc["unansweredCount"], doc["score"], doc["percent"]) == (1, 0, 2, 1, 33) and len(doc["attempts"]) == 1 and len(result_writes(page)) == 1, str(result_writes(page)))
    check("the two unanswered questions are in the saved review list", len(doc["attempts"][0]["review"]) == 2)
    check("[2] no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================== 3. auto-submit when the time runs out
    print("\n[3] Auto-submit (timer expiry): normal, with the confirm dialog open, and in a hidden tab")
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, None, None])
    advance[0] += 31 * 60 * 1000
    page.clock.fast_forward(31 * 60 * 1000)
    page.wait_for_selector("#rx-root", timeout=5000)
    page.wait_for_timeout(150)
    V = snap(page)
    check("auto-submit shows the result without any confirm dialog", page.locator("#cf-ok").count() == 0 and V["exists"])
    check("overlay subtitle says the time ran out", "সময় শেষ হওয়ায় স্বয়ংক্রিয়ভাবে জমা হয়েছে" in V["stageSub"], V["stageSub"])
    finish_stage(page)
    V = snap(page)
    check("auto-submit scores exactly what was answered: 1 right · 0 wrong · 2 blank → 33 %", (V["ok"], V["bad"], V["skip"], V["ring"]) == ("1", "0", "2", "33%"), str((V["ok"], V["bad"], V["skip"], V["ring"])))
    check("the screen explains why (time-up note, time card 'সময় শেষ হয়েছে', 30:00 used)", any("স্বয়ংক্রিয়ভাবে জমা হয়েছে" in n for n in V["notes"]) and "সময় শেষ হয়েছে" in V["timeCard"] and V["time"] == "30:00", f"{V['notes']} | {V['time']}")
    check("suggestion: 'time ran out' wording for the unanswered ones", "সময় শেষ হয়ে যাওয়ায় ২টি প্রশ্নের উত্তর" in V["tips"], V["tips"][:300])
    doc = result_doc(page)
    check("saved once, with the clamped time (1800 s)", bool(doc) and (doc["correctCount"], doc["unansweredCount"], doc["percent"], doc["timeTakenSeconds"]) == (1, 2, 33, 1800) and len(result_writes(page)) == 1, str(doc and doc.get("timeTakenSeconds")))
    check("[3a] no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    errors = []
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, None, None])
    page.locator("#q-submit").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    advance[0] += 31 * 60 * 1000
    page.clock.fast_forward(31 * 60 * 1000)
    page.wait_for_selector("#rx-root", timeout=5000)
    finish_stage(page)
    check("time runs out while the confirm dialog is open: dialog closes, result shown, ONE attempt stored", page.locator("#cf-ok").count() == 0 and snap(page)["ring"] == "33%" and len(result_writes(page)) == 1, str(result_writes(page)))
    check("[3b] no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 1])
    page.evaluate("() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); }")
    advance[0] += 31 * 60 * 1000
    page.evaluate(SAMPLER)
    page.clock.fast_forward(31 * 60 * 1000)
    page.wait_for_selector("#rx-root", timeout=5000)
    page.wait_for_timeout(400)
    S = page.evaluate("window.__samples") or []
    V = snap(page)
    check("hidden tab + time up: no animation is started, the finished result is there at once", bool(S) and S[0]["static"] and not S[0]["anim"] and S[0]["stage"] == "none" and S[0]["r"] == "100%", str(S[:1]))
    check("hidden tab: all 3 right → 100 %, saved once", (V["ok"], V["ring"]) == ("3", "100%") and len(result_writes(page)) == 1)
    check("[3c] no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # ============================================================== 4. save problems: the result stays, the status is honest, Retry works
    print("\n[4] Save failure → visible status, result intact, Retry Save, auto-retry, lost reply, attempt limit, dead connection")
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("() => { window.__MOCK__.fail = [{ prefix: 'results/', times: 99, code: 'unavailable' }]; }")
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_timeout(250)
    check("while saving: chip says 'সেভ হচ্ছে' and the result is already complete (final numbers are in the markup)",
          "সেভ হচ্ছে" in snap(page)["save"] and page.evaluate("document.querySelector('.rx-stat--ok [data-count]').dataset.count") == "2" and page.evaluate("document.querySelector('.rx-ring-text b').dataset.count") == "58")
    page.wait_for_selector(".exs-save-retry", timeout=12000)
    finish_stage(page)
    V = snap(page)
    check("after 3 failed tries: chip says it could not be saved, with a retry button", has(V["save"], "ফলাফল সেভ করা যায়নি", "আবার চেষ্টা করুন") and V["retry"] == 1, V["save"])
    check("the result itself is untouched by the failure (58 %, cards, review, PDF button)", (V["ring"], V["ok"], V["bad"]) == ("58%", "2", "1") and "Apple" in V["review"] and V["report"], str((V["ring"], V["ok"], V["bad"])))
    faults = page.evaluate("window.__MOCK__.faults")
    check("3 attempts were made, nothing was written", len(faults) == 3 and result_doc(page) is None, str(faults))
    page.locator("#exs-course-link").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    check("leaving with an unsaved result asks first (title 'সেভ হয়নি')", has(page.inner_text(".modal-head"), "সেভ হয়নি") and "#/exam?course=" not in page.evaluate("location.hash"), page.inner_text(".modal-head"))
    page.locator("#cf-cancel").click()
    page.wait_for_timeout(200)
    check("'থাকি' stays on the result", snap(page)["exists"] and snap(page)["ring"] == "58%")
    page.locator("#exs-retake").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    page.locator("#cf-cancel").click()
    page.wait_for_timeout(200)
    check("retake is guarded the same way", snap(page)["exists"])
    # the connection comes back: the browser's 'online' event retries by itself
    page.evaluate("() => { window.__MOCK__.fail = []; window.dispatchEvent(new Event('online')); }")
    page.wait_for_function("document.querySelector('#exs-save-status')?.classList.contains('is-saved')", timeout=6000)
    V = snap(page)
    doc = result_doc(page)
    check("'online' → automatic retry: saved, one attempt, retry button gone", "ফলাফল সেভ হয়েছে" in V["save"] and V["retry"] == 0 and bool(doc) and len(doc["attempts"]) == 1, V["save"])
    page.locator("#exs-retake").click()
    page.wait_for_selector("#exs-start-confirm", timeout=8000)
    check("retake → back at the rules gate (start screen), no prompt", page.locator("#cf-ok").count() == 0 and page.locator("#rx-root").count() == 0 and not snap(page)["reportClass"])
    check("[4a] only the expected 'could not save' console errors", not only_expected(errors, "Could not save the exam result"), "; ".join(only_expected(errors, "Could not save the exam result")[:3]))
    ctx.close()

    # — retry by button, pressed twice at once; the first try hangs (dead connection) and times out
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("() => { window.__MOCK__.hang = [{ prefix: 'results/', times: 3 }]; }")
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    check("dead connection: still 'saving', the result screen is fully usable meanwhile", "সেভ হচ্ছে" in snap(page)["save"] and snap(page)["ok"] == "2" and page.locator("#exs-print-result").is_enabled())
    for _ in range(4):
        page.clock.run_for(26000)
        page.wait_for_timeout(250)
    page.wait_for_selector(".exs-save-retry", timeout=8000)
    check("after 3 timeouts the chip offers 'আবার চেষ্টা করুন'", has(snap(page)["save"], "ফলাফল সেভ করা যায়নি") and result_doc(page) is None, snap(page)["save"])
    page.evaluate("() => { window.__MOCK__.hang = []; }")
    double_click_in_page(page, ".exs-save-retry")
    page.wait_for_function("document.querySelector('#exs-save-status')?.classList.contains('is-saved')", timeout=8000)
    doc = result_doc(page)
    check("'Retry Save' pressed twice at once → saved, exactly one attempt", bool(doc) and len(doc["attempts"]) == 1 and len(result_writes(page)) == 1 and snap(page)["retry"] == 0, str(result_writes(page)))
    check("[4b] only the expected 'could not save' console errors", not only_expected(errors, "Could not save the exam result"), "; ".join(only_expected(errors, "Could not save the exam result")[:3]))
    ctx.close()

    # — lost reply: the write went through but the answer never arrived → the retry must NOT add a second attempt
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("() => { window.__MOCK__.fail = [{ prefix: 'results/', times: 1, code: 'unavailable', after: true }]; }")
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_function("document.querySelector('#exs-save-status')?.classList.contains('is-saved')", timeout=9000)
    doc = result_doc(page)
    check("lost reply → automatic retry is idempotent: ONE attempt in the doc, status saved", bool(doc) and len(doc["attempts"]) == 1 and doc["attemptNumber"] == 1 and "ফলাফল সেভ হয়েছে" in snap(page)["save"], str(attempt_ids(doc)))
    check("summary entry written once with n=1", (stat_entry(page) or {}).get("n") == 1, str(stat_entry(page)))
    ctx.close()

    # — attempt limit reached by another tab while this one was open → 'blocked', not 'failed': no retry button, no scary prompt
    seed = fixtures.build(NOW)
    seed["exams/live1"]["maxAttempts"] = 1
    ctx, page, errors = fresh(browser, "mobile", seed=seed)
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("""() => { window.__MOCK__.db.set('results/stu1_live1', { uid: 'stu1', examId: 'live1', attemptNumber: 1, percent: 40, score: 1, total: 3,
        attempts: [{ id: 'other-tab', percent: 40, score: 1, total: 3, correctCount: 1, wrongCount: 2, unansweredCount: 0, timeTakenSeconds: 60, review: null }] }); }""")
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_function("document.querySelector('#exs-save-status')?.classList.contains('is-blocked')", timeout=6000)
    finish_stage(page)
    V = snap(page)
    check("attempt limit: honest message, NO retry button, result still shown", has(V["save"], "অ্যাটেম্পট সীমা পূর্ণ") and V["retry"] == 0 and V["ring"] == "58%", V["save"])
    check("the other tab's attempt is untouched (still 1 attempt, id 'other-tab')", attempt_ids(result_doc(page)) == ["other-tab"], str(attempt_ids(result_doc(page))))
    page.locator("#exs-course-link").click()
    page.wait_for_function("location.hash.startsWith('#/exam?course=')", timeout=4000)
    check("leaving a blocked result needs no 'unsaved' prompt", page.locator("#cf-ok").count() == 0)
    check("[4d] only the expected console errors", not only_expected(errors, "Could not save the exam result"), "; ".join(only_expected(errors, "Could not save the exam result")[:3]))
    ctx.close()

    # ============================================================== 5. a quick retake compares with the attempt that never reached the server
    print("\n[5] Retake right after a failed save: the comparison uses the earlier attempt of this session")
    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("() => { window.__MOCK__.fail = [{ prefix: 'results/', times: 99, code: 'unavailable' }]; }")
    page.locator("#q-submit").click()
    page.wait_for_selector(".exs-save-retry", timeout=12000)
    page.locator("#exs-retake").click()
    page.wait_for_selector("#cf-ok", timeout=3000)
    page.locator("#cf-ok").click()              # "তবুও যাব"
    page.wait_for_selector("#exs-start-confirm", timeout=8000)
    page.evaluate("() => { window.__MOCK__.fail = []; }")
    page.locator("#exs-start-confirm").click()
    page.wait_for_selector("body.exam-taking", timeout=8000)
    page.wait_for_selector(".exs-option")
    pick(page, [0, 1, 1])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V = snap(page)
    check("second result compares with the unsaved first one: +42 %, 'আগের অ্যাটেম্পট', not 'first attempt'", has(V["cmp"], "৪২%", "আগের অ্যাটেম্পট") and "প্রথম অ্যাটেম্পট" not in V["cmp"], V["cmp"][:300])
    check("this (second) attempt did save", "ফলাফল সেভ হয়েছে" in V["save"] and bool(result_doc(page)), V["save"])
    ctx.close()

    # ============================================================== 6. motion settings and failure modes of the animation itself
    print("\n[6] prefers-reduced-motion, animation failure, rich-screen failure (plain fallback)")
    ctx, page, errors = fresh(browser, "mobile", reduced=True)
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate(SAMPLER)
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_timeout(2800)
    S = page.evaluate("window.__samples") or []
    V = snap(page)
    check("reduced motion: no overlay at all, the final percent is there from the first frame", bool(S) and all(s["stage"] == "none" for s in S) and S[0]["r"] == "58%" and all(s["r"] == "58%" for s in S), str(S[:1]))
    check("reduced motion: nothing is animating (no rx-animate, tick/ring animation-name none, everything fully opaque)", bool(S) and not any(s["anim"] for s in S) and S[0]["tickAnim"] in (None, "none") and S[0]["hiddenIn"] == 0 and V["barAnim"] == "none", f"{S[:1]} {V['barAnim']}")
    check("reduced motion: transitions are off too", V["btnTransition"] in ("0s", "0s, 0s"), str(V["btnTransition"]))
    check("reduced motion: focus still moves to the heading", V["focus"] == "rx-tier-title", V["focus"])
    check("reduced motion: save + result identical (2 / 1 / 0, saved)", (V["ok"], V["bad"], V["skip"]) == ("2", "1", "0") and "সেভ হয়েছে" in V["save"] and bool(result_doc(page)))
    check("[6a] no JS errors", not errors, "; ".join(errors[:4]))
    ctx.close()

    # the CSS animation layer is unavailable / JS throws while starting it → finished result, save untouched
    ctx, page, errors = fresh(browser, "mobile")
    page.add_init_script("""(() => { const add = DOMTokenList.prototype.add; DOMTokenList.prototype.add = function (...a) { if (a[0] === 'rx-animate') throw new Error('boom: animation (test)'); return add.apply(this, a); }; })();""")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate(SAMPLER)
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_timeout(1500)
    S = page.evaluate("window.__samples") or []
    V = snap(page)
    check("animation setup throws → finished result immediately (no overlay, final numbers)", bool(S) and S[0]["static"] and S[0]["stage"] == "none" and S[0]["r"] == "58%" and V["ring"] == "58%", str(S[:1]))
    check("…and the save + analytics are unaffected", "ফলাফল সেভ হয়েছে" in V["save"] and bool(result_doc(page)) and has(V["cmp"], "প্রথম অ্যাটেম্পট"), V["save"])
    check("…the failure was logged, nothing else went wrong", len(only_expected(errors, "Result animation failed", "boom: animation")) == 0 and any("Result animation failed" in e for e in errors), "; ".join(errors[:4]))
    ctx.close()

    ctx, page, errors = fresh(browser, "mobile")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.evaluate("""() => { const orig = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (n === 'aria-pressed' && this.id === 'rx-theme') throw new Error('boom: rich screen (test)'); return orig.call(this, n, v); }; }""")
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    page.wait_for_timeout(1800)
    V = page.evaluate("""() => ({ fallback: document.getElementById('rx-root').classList.contains('rx-fallback'), text: document.getElementById('rx-root').innerText.replace(/\\s+/g, ' '),
        ids: ['exs-retake', 'exs-course-link', 'exs-print-result', 'exs-save-status'].map((i) => !!document.getElementById(i)), report: !!document.getElementById('exs-report'),
        save: (document.getElementById('exs-save-status')?.innerText || '').trim() })""")
    check("rich screen throws → the plain result screen takes over (rx-fallback)", V["fallback"] and has(V["text"], "পরীক্ষা সফলভাবে জমা হয়েছে", "58%", "সঠিক 2 · ভুল 1 · উত্তর দেওয়া হয়নি 0"), V["text"][:200])
    check("…with the same buttons and save chip", all(V["ids"]), str(V["ids"]))
    check("…the PDF report still exists and the result was saved", V["report"] and "ফলাফল সেভ হয়েছে" in V["save"] and bool(result_doc(page)), V["save"])
    page.evaluate("() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; }")
    page.locator("#exs-print-result").click()
    page.wait_for_function("window.__printCalls >= 1", timeout=4000)
    check("…and PDF download still opens the print dialog", page.evaluate("window.__printCalls") == 1)
    shot(page, "result-fallback-mobile")
    # leaving the screen: report unmounted, no stray timers throwing
    page.evaluate("location.hash = '#/home'")
    page.wait_for_selector("#hm-root:not([hidden]) .hm-hero", timeout=8000)
    page.wait_for_timeout(2500)
    sheet_visible = page.locator("#rx-root").count() > 0 and page.locator("#rx-root").first.is_visible()
    check("leaving the result for Home: PDF report removed, result sheet no longer visible",
          page.locator("#exs-report").count() == 0 and not page.evaluate("document.body.classList.contains('exs-has-report')") and not sheet_visible)
    check("[6c] only the expected console errors", len(only_expected(errors, "the rich layout failed", "boom: rich screen")) == 0 and any("rich layout failed" in e for e in errors), "; ".join(errors[:4]))
    ctx.close()

    # ============================================================== 7. other kinds of exams and honest empty states
    print("\n[7] All-questions layout · practice exam · history unavailable · exam without a subject")
    seed = fixtures.build(NOW)
    seed["exams/live1"]["layout"] = "all"
    ctx, page, errors = fresh(browser, "mobile", seed=seed)
    open_exam(page)
    pick_all_on_one_page(page, [0, 1, 0])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V = snap(page)
    check("'all questions on one page' exam: same scoring (2 / 1 / 0, 58 %)", (V["ok"], V["bad"], V["skip"], V["ring"]) == ("2", "1", "0", "58%"), str((V["ok"], V["ring"])))
    check("…per-question time is NOT invented: the card explains why there is none", has(V["timeCard"], "সব প্রশ্ন একসাথে দেখানো হয়") and "সবচেয়ে বেশি সময় লাগা প্রশ্ন" not in V["timeCard"], V["timeCard"][-200:])
    ctx.close()

    seed = fixtures.build(NOW)
    seed["exams/prac1"]["questionCount"] = 3
    seed["exams/prac1"]["shuffle"] = False
    seed["examBundles/prac1"] = json.loads(json.dumps(seed["examBundles/live1"]))
    ctx, page, errors = fresh(browser, "mobile", seed=seed)
    open_exam(page, "prac1")
    pick(page, [0, 1, 0])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V = snap(page)
    doc = result_doc(page, exam="prac1")
    check("practice exam: no negative marking → score 2 / 3 = 67 %, no negative-marking card", (V["ok"], V["bad"], V["ring"]) == ("2", "1", "67%") and V["neg"] == "" and bool(doc) and doc["score"] == 2, str((V["ring"], V["neg"][:40])))
    check("practice exam: chip says Practice, entry stored as practice", "Practice" in V["meta"] and (stat_entry(page, "prac1") or {}).get("ty") == "practice", V["meta"])
    check("practice comparison: previous 80 % (15 questions) → 13 % lower; per-count detail NOT shown for a different paper size", has(V["cmp"], "১৩%", "কম") and "সঠিক উত্তর" not in V["cmp"], V["cmp"][:300])
    check("practice: 'other exams' average only counts other PRACTICE exams (there are none → no sentence)", "অন্যান্য পরীক্ষার গড়" not in V["cmp"], V["cmp"][:300])
    ctx.close()

    ctx, page, errors = fresh(browser, "mobile", deny=["userStats"])
    open_exam(page)
    pick(page, [0, 1, 0])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V = snap(page)
    check("history unavailable: comparison says so — and does NOT claim 'first attempt'", has(V["cmp"], "আগের ফলাফল এই মুহূর্তে লোড করা যায়নি") and "প্রথম অ্যাটেম্পট" not in V["cmp"], V["cmp"][:200])
    check("history unavailable: subjects show only this exam, with the partial-data note", has(V["subj"], "বাংলা", "আগের ফলাফল লোড না হওয়ায়") and "General Knowledge" not in V["subj"], V["subj"][:300])
    check("history unavailable: the score, cards and negative-marking explanation are unaffected", (V["ring"], V["ok"], V["bad"]) == ("58%", "2", "1") and "১টি ভুল" in V["neg"])
    check("history unavailable: the result itself still saved", "ফলাফল সেভ হয়েছে" in V["save"] and bool(result_doc(page)), V["save"])
    ctx.close()

    seed = fixtures.build(NOW)
    for e in seed["examIndex/main"]["exams"]:
        e.pop("subjectId", None)
    for k in [k for k in seed if k.startswith("exams/")]:
        seed[k].pop("subjectId", None)
    ctx, page, errors = fresh(browser, "mobile", seed=seed)
    open_exam(page)
    pick(page, [0, 1, 0])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    V = snap(page)
    check("no subject anywhere: an honest empty state, no invented subjects", has(V["subj"], "কোনো বিষয় ঠিক করা নেই") and "বাংলা" not in V["subj"] and "দুর্বল বিষয়" not in V["tips"], V["subj"][:300])
    check("no subject: the rest of the analytics still works", has(V["cmp"], "প্রথম অ্যাটেম্পট") and (V["ring"], V["ok"]) == ("58%", "2"))
    ctx.close()

    # ============================================================== 8. themes, contrast and layout on real screen sizes
    print("\n[8] Light / dark themes, contrast (WCAG AA), no sideways overflow, 5 screen sizes")
    SIZES = [("tiny-320", TINY), ("phone-390", "mobile"), ("tablet-820", "tablet"), ("desktop-1366", "desktop")]
    for name, vp in SIZES:
        ctx, page, errors = fresh(browser, vp, scheme="dark")
        open_exam(page)
        pick(page, [0, 1, 0], thinks=[8, 75, 4])
        page.locator("#q-submit").click()
        page.wait_for_selector("#rx-root", timeout=3000)
        finish_stage(page)
        for theme in ("dark", "light"):
            if page.evaluate("document.getElementById('rx-root').dataset.theme") != theme:
                page.locator("#rx-theme").click()
                page.wait_for_timeout(350)
            V = snap(page)
            c = page.evaluate(CONTRAST)
            lay = page.evaluate(LAYOUT_SCAN)
            check(f"{name} · {theme}: data-theme applied, no horizontal overflow", V["theme"] == theme and V["overflow"] <= 0, f"{V['theme']} overflow={V['overflow']}")
            check(f"{name} · {theme}: nothing outside the viewport or clipped ({len(lay)} found)", not lay, str(lay[:3]))
            check(f"{name} · {theme}: all {c.get('checked')} visible texts meet WCAG AA (worst {c.get('worst')}:1)", c.get("checked", 0) > 40 and not c.get("bad"), str(c.get("bad", c)[:4]))
            shot(page, f"result-{name}-{theme}")
        check(f"{name}: the theme choice is remembered (localStorage) after toggling", page.evaluate("localStorage.getItem('tvexam:result-theme')") == "light")
        if name == "phone-390":
            check("phone: buttons ≥ 44 px", snap(page)["btnMinH"] >= 44, str(snap(page)["btnMinH"]))
        check(f"{name}: no JS errors", not errors, "; ".join(errors[:4]))
        ctx.close()

    # default theme follows the device, a stored choice wins, and a device change is followed until the student chooses
    ctx, page, errors = fresh(browser, "mobile", scheme="light")
    open_exam(page)
    pick(page, [0, 1, 0])
    page.locator("#q-submit").click()
    page.wait_for_selector("#rx-root", timeout=3000)
    finish_stage(page)
    check("device in light mode → result starts light", snap(page)["theme"] == "light")
    page.emulate_media(color_scheme="dark")
    page.wait_for_timeout(300)
    check("device switches to dark while nothing is stored → the sheet follows", snap(page)["theme"] == "dark")
    page.locator("#rx-theme").click()
    page.emulate_media(color_scheme="light")
    page.wait_for_timeout(300)
    check("after the student picks a theme the device no longer overrides it", snap(page)["theme"] == "light" and page.evaluate("localStorage.getItem('tvexam:result-theme')") == "light")
    ctx.close()

    browser.close()

sys.exit(finish())
