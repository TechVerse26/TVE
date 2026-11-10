"""Browser smoke test of the REAL app (student exam flow + admin exam creation) on in-memory Firebase doubles.
   node build.mjs   (needs esbuild + global react)   then   python3 run.py"""
import json, os, socketserver, sys, threading, http.server, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, ".out"); PORT = 8777; BASE = f"http://127.0.0.1:{PORT}"
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=OUT, **k)
    def log_message(s, *a): pass
    def do_GET(s):
        if not os.path.exists(os.path.join(OUT, s.path.lstrip("/").split("?")[0])) or s.path in ("/", ""): s.path = "/index.html"
        return super().do_GET()
socketserver.TCPServer.allow_reuse_address = True
threading.Thread(target=socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H).serve_forever, daemon=True).start()

NOW = int(time.time() * 1000); HOUR = 3600_000; ts = lambda ms: {"__ts": ms}
Q = [{"id": "q1", "text": "2+2?", "options": ["3", "4", "5", "6"], "correctIndex": 1, "explanation": "basic arithmetic"},
     {"id": "q2", "text": "Capital of France?", "options": ["Rome", "Paris", "Oslo", "Bern"], "correctIndex": 1, "explanation": ""},
     {"id": "q3", "text": "H2O is?", "options": ["Water", "Salt", "Gold", "Air"], "correctIndex": 0, "explanation": ""}]
live = {"id": "e1", "title": "Physics Live", "examType": "live", "duration": 10, "questionCount": 3, "negativeMarking": 0.5, "maxAttempts": 2, "layout": "one", "shuffle": False, "qFormat": 2, "qChunks": 1, "publishAt": ts(NOW - HOUR), "closesAt": ts(NOW + 2 * HOUR), "createdAt": ts(NOW - 5 * HOUR)}
prac = {"id": "p1", "title": "Practice Set", "examType": "practice", "duration": 5, "questionCount": 3, "maxAttempts": 0, "layout": "one", "shuffle": False, "qFormat": 2, "qChunks": 1, "createdAt": ts(NOW - 9 * HOUR)}
bundle = lambda eid: {"examId": eid, "part": 0, "chunks": 1, "count": 3, "questions": Q}
SEED = {
  "users/u1": {"displayName": "Rahim Uddin", "email": "s@x.com", "isAdmin": False, "roll": "0007", "enrolledCourses": [], "createdAt": ts(NOW - 99 * HOUR)},
  "users/a1": {"displayName": "Admin Anika", "email": "a@x.com", "isAdmin": True, "enrolledCourses": [], "createdAt": ts(NOW - 99 * HOUR)},
  "adminRoles/a1": {"role": "super", "name": "Admin Anika"},
  "examIndex/main": {"v": 1, "exams": [live, prac], "courses": {}, "count": 2},
  "exams/e1": live, "exams/p1": prac, "examBundles/e1": bundle("e1"), "examBundles/p1": bundle("p1"),
  "homeFeed/main": {"notices": [{"id": "n1", "title": "Welcome notice", "body": "Hello students", "category": "general", "priority": "important", "publishAt": NOW - HOUR, "expiresAt": 0, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": NOW - HOUR}], "content": {}, "taxonomy": {"subjects": [], "categories": []}, "passPercent": 60},
}
def user(uid, email, name): return {"uid": uid, "email": email, "displayName": name, "emailVerified": True, "providerData": [{"providerId": "password"}], "photoURL": ""}

passed, failed = [], []
def check(name, cond, detail=""):
    (passed if cond else failed).append(name); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def open_page(browser, who, width=390, height=820):
    ctx = browser.new_context(viewport={"width": width, "height": height})
    u = user(*who) if who else None
    ctx.add_init_script(f"window.__MOCK__ = {{ seed: {json.dumps(SEED)}, user: {json.dumps(u)} }}; if (window.__MOCK__.user) window.__MOCK__.user.getIdToken = async () => 'tok';")
    page = ctx.new_page(); errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200])); page.on("console", lambda m: errs.append(m.text[:200]) if m.type == "error" else None)
    return ctx, page, errs

def body(page): return page.inner_text("body")
def db(page, key): return page.evaluate("(k) => { const v = window.__MOCK__.db.get(k); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }", key)

with sync_playwright() as p:
    browser = p.chromium.launch()
    # ---------------------------------------------------------------- student
    ctx, page, errs = open_page(browser, ("u1", "s@x.com", "Rahim Uddin"))
    page.goto(BASE + "/"); page.wait_for_selector("text=Physics Live", timeout=10000)
    t = body(page)
    check("Home loads real catalog and shows the live exam hero", "Physics Live" in t and "Live now" in t)
    check("Home greets the student by first name", "Rahim" in t)
    check("Home shows the notice from homeFeed", "Welcome notice" in t)
    check("Phone layout shows the bottom navigation", page.locator("nav.bottombar").count() == 1 and page.locator("nav.rail").count() == 0)
    page.click("nav.bottombar button:has-text('Exams')"); page.wait_for_selector(".card:has-text('Practice Set')")
    check("Exams list shows both exams", "Physics Live" in body(page) and "Practice Set" in body(page))
    page.click("text=Physics Live"); page.wait_for_selector("button:has-text('Start exam')")
    t = body(page); check("Exam detail shows duration, negative marking, attempts", "10 min" in t and "−0.5" in t and "0 of 2" in t, t[:200])
    page.click("button:has-text('Start exam')"); page.wait_for_selector("text=Not now", timeout=8000)
    check("Eligibility checks pass and the rules screen appears", "locked" in body(page) and page.url.endswith("/exams/e1/play"))
    check("Bottom navigation is hidden during the exam", page.locator("nav.bottombar").count() == 0)
    page.click("button:has-text('Start exam')"); page.wait_for_selector(".qtext")
    check("First question is shown with 4 options and a running timer", page.locator("button.option").count() == 4 and ":" in page.inner_text(".timer"))
    page.click("button.option:has-text('4')")
    check("Choosing an answer locks it (others disabled)", page.locator("button.option[aria-checked=true]").count() == 1 and page.locator("button.option[disabled]").count() == 3)
    page.click("button.option:has-text('Salt')") if False else None
    page.click("button[aria-label='Next question']"); page.wait_for_selector("text=Capital of France?")
    page.click("button.option:has-text('Rome')")  # wrong on purpose
    page.click("button[aria-label='Next question']"); page.wait_for_selector("text=H2O is?")
    sess = page.evaluate("Object.keys(localStorage).filter(k => k.includes('session') || k.includes('tve'))")
    check("Progress is autosaved to the device while answering", len(sess) >= 1, str(sess))
    page.click(".xfoot button:has-text('Submit')"); page.wait_for_url("**/exams/e1/result", timeout=8000)
    page.wait_for_selector("text=Result saved", timeout=10000)
    t = body(page)
    check("Result: 1 correct, 1 wrong, 1 skipped, score 0.5 of 3 = 17%", "17%" in t and "Skipped" in t and "0.5/3" in t, t[:300])
    check("Result review lists the wrong and the skipped question", "Capital of France?" in t and "H2O is?" in t and "Wrong" in t)
    res = db(page, "results/u1_e1")
    check("Result document written with the website's shape", bool(res) and res["uid"] == "u1" and res["examId"] == "e1" and res["attemptNumber"] == 1 and len(res["attempts"]) == 1 and res["attempts"][0]["correctCount"] == 1 and res["percent"] == 17, json.dumps(res)[:200])
    check("Attempt review snapshot stored (wrong + skipped only)", res and len(res["attempts"][0]["review"]) == 2)
    st = db(page, "userStats/u1")
    check("userStats summary updated like the website", bool(st) and st["exams"]["e1"]["p"] == 17 and st["exams"]["e1"]["n"] == 1, json.dumps(st)[:160])
    check("Saved copy on the device is removed after a successful save", not [k for k in page.evaluate("Object.keys(localStorage)") if "session" in k.lower()], str(page.evaluate("Object.keys(localStorage)")))
    page.evaluate("history.pushState({}, '', '/results'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector(".card:has-text('Physics Live')")
    check("Results page lists the attempt with its percent", "17%" in body(page))
    page.click(".card:has-text('Physics Live')"); page.wait_for_selector("text=Attempt 1")
    check("Attempt history opens with a review button", page.locator("button:has-text('Review')").count() == 1)
    page.click("button:has-text('Review')"); page.wait_for_selector("text=Review your mistakes"); page.wait_for_selector("text=Capital of France?")
    check("Past attempt review opens from saved data", "Explanation" in body(page) or "Wrong" in body(page))
    # attempt limit
    for _ in range(1):
        page.evaluate("history.pushState({}, '', '/exams/e1'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("button:has-text('Retake exam'), button:has-text('Start exam')")
    check("Detail now shows 1 of 2 attempts used and offers a retake", "1 of 2" in body(page) and page.locator("button:has-text('Retake exam')").count() == 1)
    # resume after a restart (practice exam)
    page.evaluate("history.pushState({}, '', '/exams/p1'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("button:has-text('Start exam')")
    page.click("button:has-text('Start exam')"); page.wait_for_selector("text=Not now"); page.click("button:has-text('Start exam')"); page.wait_for_selector(".qtext")
    page.click("button.option:has-text('4')"); time.sleep(0.4)
    page.reload(); page.wait_for_selector(".qtext", timeout=10000)
    check("Reloading the app on the exam screen resumes it with the locked answer", page.locator("button.option[aria-checked=true]").count() == 1 and page.locator("button.option[disabled]").count() == 3)
    page.evaluate("history.pushState({}, '', '/home'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("text=Exam in progress", timeout=10000)
    check("Home offers to resume the exam in progress", "Practice Set" in body(page) and page.locator("button:has-text('Resume')").count() == 1)
    page.click("button:has-text('Resume')"); page.wait_for_selector(".qtext")
    check("Resume button returns to the same question", page.url.endswith("/exams/p1/play"))
    # students cannot open admin screens
    page.evaluate("history.pushState({}, '', '/admin'); dispatchEvent(new PopStateEvent('popstate'))"); time.sleep(0.8)
    check("A student opening /admin is sent back to Home", page.url.endswith("/home"), page.url)
    bad = [e for e in errs if "favicon" not in e]
    check("No runtime errors in the student session", not bad, "; ".join(bad)[:300]); ctx.close()

    # ---------------------------------------------------------------- signed out
    ctx, page, errs = open_page(browser, None)
    page.goto(BASE + "/home"); page.wait_for_selector("text=Sign in", timeout=10000)
    check("A signed-out visitor is sent to the sign-in screen", page.url.endswith("/login") and page.locator("nav.bottombar").count() == 0, page.url)
    check("Sign-in offers only email + password (no Google / phone)", "Google" not in body(page) and "phone" not in body(page).lower() and page.locator("input[type=password]").count() == 1)
    page.click("button:has-text('Forgot password?')"); page.wait_for_selector("#fe"); page.fill("#fe", "Student@Example.com")
    page.click("button:has-text('Send reset link')"); page.wait_for_selector("text=রিসেট লিংক পাঠানো হয়েছে", timeout=8000)
    r = page.evaluate("window.__MOCK__.resets")
    check("Password reset email requested through Firebase (Bengali mail, returns to the website login)", len(r) == 1 and r[0]["email"] == "student@example.com" and r[0]["lang"] == "bn" and r[0]["settings"]["url"].endswith("/#/login"), json.dumps(r)[:200])
    check("Reset screen explains Google-only accounts keep the same account", "same account" in body(page))
    page.evaluate("history.pushState({}, '', '/signup'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("text=Create account")
    page.fill("#n", "New Student"); page.fill("#e", "n@x.com"); page.fill("#p", "secret1"); page.fill("#c", "secret2"); page.click("button:has-text('Create account')")
    page.wait_for_selector("text=do not match"); check("Sign-up validates that the two passwords match", True)
    page.evaluate("history.pushState({}, '', '/info/privacy'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("text=Privacy", timeout=8000)
    check("Privacy policy is readable without signing in", page.locator("details").count() >= 10, str(page.locator("details").count()))
    bad = [e for e in errs if "favicon" not in e]
    check("No runtime errors on the signed-out screens", not bad, "; ".join(bad)[:300]); ctx.close()

    # ---------------------------------------------------------------- tablet
    ctx, page, errs = open_page(browser, ("u1", "s@x.com", "Rahim Uddin"), 1024, 768)
    page.goto(BASE + "/"); page.wait_for_selector("text=Physics Live", timeout=10000)
    check("Tablet layout swaps the bottom bar for a navigation rail", page.locator("nav.rail").count() == 1 and page.locator("nav.bottombar").count() == 0); ctx.close()

    # ---------------------------------------------------------------- admin
    ctx, page, errs = open_page(browser, ("a1", "a@x.com", "Admin Anika"))
    page.goto(BASE + "/admin"); page.wait_for_selector("text=Welcome, Admin", timeout=10000)
    page.wait_for_selector("text=Active students", timeout=8000)
    check("Admin dashboard loads aggregated numbers", "Students" in body(page) and "Exams" in body(page))
    page.evaluate("history.pushState({}, '', '/admin/exams'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector(".card:has-text('Physics Live')")
    check("Admin exam list shows every exam with its status", "Practice Set" in body(page) and "Live" in body(page))
    page.evaluate("history.pushState({}, '', '/admin/exams/new'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_selector("#t")
    page.fill("#t", "Chemistry Quiz"); page.click("button:has-text('Practice')")
    page.click("button:has-text('Published')")
    page.click("button:has-text('Questions (0)')"); page.click("button:has-text('Add question')"); page.wait_for_selector("#qt")
    page.fill("#qt", "Symbol of gold?"); page.fill("input[placeholder='Option A']", "Ag"); page.fill("input[placeholder='Option B']", "Au"); page.fill("input[placeholder='Option C']", "Gd")
    page.click("button[aria-label='Option B']"); page.click("button:has-text('Done')")
    check("Question added to the editor list", "Symbol of gold?" in body(page) and "Correct: B" in body(page))
    page.click("button:has-text('Create exam')"); page.wait_for_url("**/admin/exams", timeout=10000)
    keys = page.evaluate("[...window.__MOCK__.db.keys()]")
    new = [k for k in keys if k.startswith("exams/") and k not in ("exams/e1", "exams/p1")]
    check("New exam document created", len(new) == 1, str(new))
    doc = db(page, new[0]) if new else {}
    check("Exam saved with the website's field names and bundle format", doc.get("title") == "Chemistry Quiz" and doc.get("examType") == "practice" and doc.get("status") == "published" and doc.get("qFormat") == 2 and doc.get("questionCount") == 1, json.dumps(doc)[:260])
    bun = db(page, "examBundles/" + new[0].split("/")[1]) if new else None
    check("Questions stored in examBundles exactly like the website", bool(bun) and bun["questions"][0]["correctIndex"] == 1 and bun["questions"][0]["options"] == ["Ag", "Au", "Gd"], json.dumps(bun)[:200])
    idx = db(page, "examIndex/main")
    check("Students' examIndex refreshed so the exam appears on the website too", any(e["title"] == "Chemistry Quiz" for e in idx["exams"]), str([e["title"] for e in idx["exams"]]))
    logs = [k for k in keys if k.startswith("adminLogs/")]
    check("Audit log entry written", len(logs) >= 1 and db(page, logs[0])["action"] == "exam.create", str(logs))
    bad = [e for e in errs if "favicon" not in e]
    check("No runtime errors in the admin session", not bad, "; ".join(bad)[:300]); ctx.close(); browser.close()

print(f"\n{len(passed)} passed, {len(failed)} failed"); sys.exit(1 if failed else 0)
