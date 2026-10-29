"""Shared pieces of the Email Center end-to-end tests: seed data, a fake EmailJS SDK, small page helpers."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures

D = 24 * 3600 * 1000
HR = 3600 * 1000
SERVICE, TEMPLATE, KEY = "service_test123", "template_test456", "pubKeyTest789abc"


def fnv32(s):
    """Same as hash32() in js/email-core.js (FNV-1a, 32 bit) — used to seed a 'tested' configuration."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def email_seed(now, tested=True, role=None, extra=None):
    """build_admin + a roster designed for the Email Center:
       stu1 Abdullah (c1, not attempted) · stuA Rahim, stuB Karim, stuC Nusrat (submitted live1) · stuD Tanvir (started live1, no result)
       stuE Mitu (deactivated) · stuF (invalid e-mail) · stuG Sadia (no roll, not attempted) · adm1 (admin)."""
    seed = fixtures.build_admin(now)
    ts = fixtures.ts
    seed["courses/c1"] = {"title": "Main Course"}
    seed["courses/c2"] = {"title": "Second Course"}
    def user(uid, name, email, **kw):
        base = {"displayName": name, "email": email, "enrolledCourses": [], "isAdmin": False, "createdAt": ts(now - 10 * D)}
        base.update(kw)
        seed[f"users/{uid}"] = base
    user("stuA", "Rahim Uddin", "stuA@example.com", roll="0101", enrolledCourses=["c1"])
    user("stuB", "Karim Hossain", "stuB@example.com", roll="0102", enrolledCourses=["c1", "c2"])
    user("stuC", "Nusrat Jahan", "stuC@example.com", roll="0103", enrolledCourses=["c2"])
    user("stuD", "Tanvir Ahmed", "stuD@example.com", roll="0104", enrolledCourses=["c1"])
    user("stuE", "Mitu Akter", "stuE@example.com", roll="0105", disabled=True)
    user("stuF", "Bad Mail", "not-an-email", roll="0106")
    user("stuG", "Sadia Islam", "stuG@example.com")
    seed["users/stu1"]["roll"] = "0100"
    seed["notices/nEm1"] = {"title": "পরীক্ষার সময়সূচি পরিবর্তন", "body": "আগামী শনিবারের পরীক্ষা রবিবার সকাল ১০টায় অনুষ্ঠিত হবে।\n\nসবাই সময়মতো উপস্থিত থাকুন।", "category": "exam", "priority": "important", "status": "published",
                            "publishAt": ts(now - HR), "expiresAt": None, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": ts(now - HR)}
    if tested:
        seed["emailSettings/main"] = {"serviceId": SERVICE, "templateId": TEMPLATE, "publicKey": KEY, "senderName": "Tech Verse Exam", "replyTo": "", "intervalMs": 1100,
                                      "safetyCap": 0, "timeZone": "Asia/Dhaka", "testEmail": "admin@example.com", "showLogo": True, "logoUrl": "",
                                      "lastTest": {"ok": True, "at": now - HR, "fp": fnv32(f"{SERVICE}|{TEMPLATE}|{KEY}"), "to": "a•••@example.com", "status": 200, "text": "OK"},
                                      "updatedAt": ts(now - D), "updatedBy": "Admin One"}
    if role:
        seed["adminRoles/adm1"] = {"role": role}
    if extra:
        seed.update(extra)
    return seed


FAKE_SDK = """
(function () {
  const S = window.__EMAILJS__ = window.__EMAILJS__ || { calls: [], script: [] };
  window.emailjs = {
    send(service, template, params, opts) {
      S.calls.push({ service, template, params, opts, at: Date.now() });
      const next = S.script.length ? S.script.shift() : 'ok';
      if (next === 'ok') return Promise.resolve({ status: 200, text: 'OK' });
      if (next === 'hang') return new Promise(() => {});
      if (next === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.reject({ status: next.status, text: next.text });
    },
  };
})();
"""


def attach_sdk(ctx):
    """Route the EmailJS CDN URL to a fake SDK that records every call on window.__EMAILJS__ (no real e-mail is ever sent)."""
    ctx.add_init_script("window.__EMAILJS__ = window.__EMAILJS__ || { calls: [], script: [] };")
    ctx.route("**/cdn.jsdelivr.net/npm/@emailjs/browser@*/dist/email.min.js", lambda route, req: route.fulfill(status=200, content_type="text/javascript", body=FAKE_SDK, headers={"access-control-allow-origin": "*"}))


def sdk_calls(page):
    return page.evaluate("(window.__EMAILJS__ || {calls: []}).calls.map(c => ({service: c.service, template: c.template, to: c.params.to_email, subject: c.params.subject, html: c.params.html_body, text: c.params.message_text, name: c.params.student_name, at: c.at, keys: Object.keys(c.params), reply: c.params.reply_to, from: c.params.from_name, opts: c.opts}))")


def script_sdk(page, outcomes):
    page.evaluate("(o) => { window.__EMAILJS__ = window.__EMAILJS__ || { calls: [], script: [] }; window.__EMAILJS__.script = o; }", outcomes)


def open_email(page, hash_="#/email-center", wait="#em-body .em-tabs"):
    page.goto(f"{BASE}/admin.html{hash_}")
    page.wait_for_selector(wait, timeout=12000)


def tab(page, name):
    page.click(f'#em-tab-{name}')
    page.wait_for_selector(f'#em-panel-{name}:not([hidden])')


def dbdoc(page, path):
    return page.evaluate("(p) => window.__MOCK__.dump()[p] || null", path)


def dbpaths(page, prefix):
    return page.evaluate("(p) => Object.keys(window.__MOCK__.dump()).filter(k => k.startsWith(p))", prefix)


def kpi_value(page, label):
    return page.locator("#em-panel-overview .kpi", has=page.locator(".kpi-label", has_text=label)).first.locator(".kpi-value").inner_text().strip()


def real_errors(errors):
    """Playwright injects its init script into every frame, including the sandboxed e-mail preview iframe, where the browser
    refuses to run it. That message exists only under test — a real browser never logs it — so it is not an application error."""
    return [e for e in errors if "about:srcdoc" not in e]


def db(page):
    return page.evaluate("window.__MOCK__.dump()")


def campaigns(page):
    return {k.split("/")[1]: v for k, v in db(page).items() if re.fullmatch(r"emailCampaigns/[^/]+", k)}


def campaign_rows(page, cid):
    d = db(page)
    parts = sorted([v for k, v in d.items() if k.startswith(f"emailCampaigns/{cid}/parts/")], key=lambda p: p["n"])
    return [r for p in parts for r in p["rows"]]


def log_actions(page):
    return [v["action"] for k, v in db(page).items() if k.startswith("adminLogs/")]
