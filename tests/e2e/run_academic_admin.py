"""End-to-end checks for the ADMIN side of Academic Management, against the in-memory Firestore:
   create / rename / reorder / status / archive · Cover Image URL (validate, live preview, replace, remove) · nothing but a URL string is stored ·
   Section → Level → Subject cascade in the exam editor · safe delete (blocked → archive or move content) · Paid access grants ·
   roles · and finally the data the admin created, opened on the STUDENT site.
   python3 tests/e2e/run_academic_admin.py [--shots]
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from harness import *
import harness as H
import fixtures
from fixtures import ts
from playwright.sync_api import sync_playwright

D = 24 * 3600 * 1000
IMG = "https://img.example.com/academic.webp"
import base64
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")   # a 1×1 picture


def dump(page):
    return page.evaluate("window.__MOCK__.dump()")


def col(page, prefix):
    return {k.split("/", 1)[1]: v for k, v in dump(page).items() if k.startswith(prefix + "/")}


def by_name(page, prefix, name, **where):
    rows = [(i, d) for i, d in col(page, prefix).items() if d.get("name") == name and all(d.get(k) == v for k, v in where.items())]
    return rows[0] if rows else (None, None)


def admin_page(page, hash_, wait=".admin-nav-item"):
    page.goto(f"{BASE}/admin.html{hash_}")
    page.wait_for_selector(wait, timeout=9000)


def kpi(page, label):
    return page.locator(".kpi", has=page.locator(".kpi-label", has_text=label)).first.locator(".kpi-value").inner_text().strip()


def confirm_danger(page, phrase=None):
    page.wait_for_selector("#cd-ok")
    if page.locator("#cd-phrase").count():
        page.fill("#cd-phrase", phrase or "x")
    page.click("#cd-ok")


def row(page, kind, id_):
    return page.locator(f'li.ac-node[data-kind="{kind}"][data-id="{id_}"] > .ac-row')


def act(page, kind, id_, what):
    row(page, kind, id_).locator(f'[data-act="{what}"]').click()


def sheet(page, name):
    page.wait_for_selector(".ac-sheet")
    page.locator(f'.ac-sheet [data-sheet="{name}"]').click()


def fill_node(page, name, desc=None, access=None, image=None, status=None, order=None, course=None):
    page.wait_for_selector("#ac-form")
    page.fill("#ac-name", name)
    if desc is not None: page.fill("#ac-desc", desc)
    if image is not None: page.fill("#ac-img", image)
    if access: page.select_option("#ac-access-sel", access)
    if status: page.select_option("#ac-status-sel", status)
    if order is not None: page.fill("#ac-order", str(order))
    if course: page.select_option("#ac-course", course)


def save_node(page):
    page.click("#ac-save")


def tree_names(page, kind):
    return [t.strip() for t in page.locator(f'li.ac-node[data-kind="{kind}"] > .ac-row .ac-title b').all_inner_texts()]


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    errors = []
    storage_requests = []

    seed = fixtures.build_admin(NOW)
    seed["accessCodes/CODE1"] = {"uid": "stuB", "courseId": "c1", "used": True, "usedAt": ts(NOW - D)}
    seed["accessCodes/CODE2"] = {"uid": "stuC", "courseId": "c1", "used": False}
    seed["accessCodes/CODE3"] = {"uid": "stuA", "courseId": "c-other", "used": True}
    seed["courses/c1"] = {"title": "Main Course", "price": 0}
    ctx = make_context(browser, VIEWPORTS["desktop"], seed=seed, user="adm1")
    install_clock(ctx)
    page = new_page(ctx, errors)
    page.set_default_timeout(9000)
    page.route("https://img.example.com/ok.png", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG))
    page.on("request", lambda r: storage_requests.append(r.url) if ("firebasestorage" in r.url or "storage.googleapis" in r.url or "appspot.com/o/" in r.url) else None)

    # ------------------------------------------------------------------ A. The page, empty
    print("\n[A] Academic Management — sidebar item, empty state, dashboard numbers")
    admin_page(page, "#/academic", "#ac-kpis .kpi")
    check("sidebar has 'Academic Management'", page.locator(".admin-nav-item", has_text="Academic Management").count() == 1)
    check("empty state invites the first section", "No academic sections yet" in page.inner_text("#ac-tree"))
    check("eight dashboard cards, all zero", page.locator("#ac-kpis .kpi").count() == 8 and kpi(page, "Academic sections") == "0" and kpi(page, "Paid programs") == "0")
    check("the 'first section' button opens the form", page.locator('#ac-tree [data-act="add"]').count() == 1)

    # ------------------------------------------------------------------ B. Section form + Cover Image URL
    print("\n[B] New section — validation and the Cover Image URL field")
    page.click("#ac-new")
    page.wait_for_selector("#ac-form")
    check("form fields: name, description, cover URL, status, order, access, linked course",
          all(page.locator(s).count() == 1 for s in ("#ac-name", "#ac-desc", "#ac-img", "#ac-status-sel", "#ac-order", "#ac-access-sel", "#ac-course")))
    check("URL field label + placeholder as specified", "Cover Image URL" in page.inner_text('[data-f="coverImage"] label') and page.get_attribute("#ac-img", "placeholder") == "Paste your direct image URL here...")
    check("preview / update / replace / remove controls present", all(page.locator(s).count() == 1 for s in ("#ac-img-prev", "#ac-img-update", "#ac-img-replace", "#ac-img-remove")))
    save_node(page)
    check("empty name is refused, nothing written", page.locator('[data-f="name"].has-error').count() == 1 and "নাম লিখুন" in page.inner_text('[data-f="name"]') and not [w for w in writes(page) if "academic" in w["path"]])
    page.fill("#ac-name", "Academic")
    for bad, needle in (("javascript:alert(1)", "https://"), ("data:image/png;base64,iVBORw0KGgo=", "https://"), ("http://img.example.com/a.png", "http://"),
                        ("file:///etc/passwd", "https://"), ("https://img.example.com/a b.png", "spaces"), ("not a url", "spaces")):
        page.fill("#ac-img", bad); page.locator("#ac-img").blur()
        msg = page.inner_text("#ac-img-msg")
        check(f"unsafe/invalid URL warned: {bad[:34]}", needle in msg and page.locator("#ac-img-prev.is-bad").count() == 1, msg)
    page.fill("#ac-img", "javascript:alert(1)")
    save_node(page)
    check("saving with an unsafe URL is blocked", page.locator('[data-f="coverImage"].has-error').count() == 1 and not [w for w in writes(page) if "academic" in w["path"]])
    page.fill("#ac-img", IMG); page.locator("#ac-img").blur()
    page.wait_for_selector("#ac-img-prev.is-bad")
    check("a valid link whose picture can't load shows the loading-error state (not 'invalid')", "didn't load" in page.inner_text("#ac-img-msg") or "did not load" in page.inner_text("#ac-img-msg"), page.inner_text("#ac-img-msg"))
    page.fill("#ac-img", "https://img.example.com/ok.png"); page.locator("#ac-img").blur()
    page.wait_for_selector("#ac-img-prev.is-ok")
    check("a picture that loads is previewed in a real <img> element (with its size reported)", page.locator("#ac-img-prev img").count() == 1 and page.get_attribute("#ac-img-prev img", "src") == "https://img.example.com/ok.png" and "1×1" in page.inner_text("#ac-img-msg"), page.inner_text("#ac-img-msg"))
    page.fill("#ac-img", IMG); page.locator("#ac-img").blur()
    page.wait_for_selector("#ac-img-prev.is-bad")
    page.click("#ac-img-remove")
    check("Remove image clears the field and the preview", page.input_value("#ac-img") == "" and "No image" in page.inner_text("#ac-img-prev"))
    page.fill("#ac-img", IMG)
    page.click("#ac-img-update")
    page.click("#ac-img-replace")
    page.wait_for_function("document.activeElement && document.activeElement.id === 'ac-img'", timeout=4000)
    check("Replace URL (no clipboard text) simply focuses the field so a new link can be pasted", page.evaluate("document.activeElement.id") == "ac-img")
    page.fill("#ac-desc", "School & college programs — pick a level, then a subject.")
    page.select_option("#ac-access-sel", "free")
    shot(page, "academic-admin-form")
    save_node(page)
    page.wait_for_selector('li.ac-node[data-kind="section"]')
    sid, sdoc = by_name(page, "academicSections", "Academic")
    check("section saved with the documented fields", sdoc is not None and all(k in sdoc for k in ("name", "coverImage", "description", "status", "order", "accessMode", "linkedCourseId", "createdAt", "updatedAt")), str(sdoc))
    check("coverImage is ONLY the URL string", sdoc["coverImage"] == IMG and isinstance(sdoc["coverImage"], str) and len(json.dumps(sdoc)) < 600)
    check("defaults: active, order 10, free", (sdoc["status"], sdoc["order"], sdoc["accessMode"]) == ("active", 10, "free"), str(sdoc))
    check("NO Firebase Storage request was made at all", storage_requests == [], str(storage_requests))
    check("a Firestore-generated stable id", bool(sid) and len(sid) >= 8)
    check("KPI: 1 section", kpi(page, "Academic sections") == "1")

    # ------------------------------------------------------------------ C. Levels and subjects
    print("\n[C] Levels and subjects — parent/child by stable id; same subject name under different levels")
    act(page, "section", sid, "add")
    page.wait_for_selector("#ac-form")
    check("'Add level' opens a LEVEL form with its section preselected", "New level" in page.inner_text(".modal-head") and page.input_value("#ac-section") == sid)
    fill_node(page, "SSC", desc="Secondary School Certificate", image="https://img.example.com/ssc.webp")
    save_node(page); page.wait_for_selector('li.ac-node[data-kind="level"]')
    act(page, "section", sid, "add"); fill_node(page, "HSC", desc="Higher Secondary Certificate", access="paid"); save_node(page)
    page.wait_for_function("document.querySelectorAll('li.ac-node[data-kind=\"level\"]').length === 2")
    ssc_id, ssc = by_name(page, "academicLevels", "SSC"); hsc_id, hsc = by_name(page, "academicLevels", "HSC")
    check("levels reference their section by id", ssc["sectionId"] == sid and hsc["sectionId"] == sid and ssc["order"] == 10 and hsc["order"] == 20, f"{ssc} {hsc}")
    check("access: SSC inherits, HSC is paid", (ssc["accessMode"], hsc["accessMode"]) == ("inherit", "paid"))
    act(page, "section", sid, "add"); fill_node(page, "ssc"); save_node(page)
    check("a second level with the same name (any case) under the same section is refused", page.locator('[data-f="name"].has-error').count() == 1 and "একই নামের" in page.inner_text('[data-f="name"]'))
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)
    if page.locator("#ac-form").count(): page.locator("#ac-form [data-modal-close]").first.click()
    act(page, "level", ssc_id, "add")
    page.wait_for_selector("#ac-form")
    check("'Add subject' under SSC preselects section AND level, level list holds only that section's levels",
          "New subject" in page.inner_text(".modal-head") and page.input_value("#ac-section") == sid and page.input_value("#ac-level") == ssc_id and page.locator("#ac-level option").count() == 3)
    fill_node(page, "Mathematics", desc="Algebra, geometry, trigonometry"); save_node(page)
    page.wait_for_selector('li.ac-node[data-kind="subject"]')
    act(page, "level", hsc_id, "add"); fill_node(page, "Mathematics"); save_node(page)
    page.wait_for_function("document.querySelectorAll('li.ac-node[data-kind=\"subject\"]').length === 2")
    subs = col(page, "academicSubjects")
    ssc_math = next((i for i, d in subs.items() if d["levelId"] == ssc_id), None); hsc_math = next((i for i, d in subs.items() if d["levelId"] == hsc_id), None)
    check("SSC Mathematics and HSC Mathematics are two separate documents (same name, different parents)", ssc_math and hsc_math and ssc_math != hsc_math and all(subs[i]["name"] == "Mathematics" for i in subs), str(subs))
    check("each subject stores its section id and level id", all(subs[i]["sectionId"] == sid for i in subs) and subs[ssc_math]["levelId"] == ssc_id and subs[hsc_math]["levelId"] == hsc_id)
    act(page, "level", ssc_id, "add"); fill_node(page, "mathematics"); save_node(page)
    check("duplicate subject name inside one level is refused", page.locator('[data-f="name"].has-error').count() == 1)
    page.locator("#ac-form [data-modal-close]").first.click()
    check("dashboard numbers", (kpi(page, "Academic sections"), kpi(page, "Levels"), kpi(page, "Subjects")) == ("1", "2", "2"), str((kpi(page, "Academic sections"), kpi(page, "Levels"), kpi(page, "Subjects"))))
    check("free / paid counts use the EFFECTIVE access (HSC + its inheriting subject = 2 paid)", (kpi(page, "Free programs"), kpi(page, "Paid programs")) == ("3", "2"), str((kpi(page, "Free programs"), kpi(page, "Paid programs"))))
    check("tree rows: names, statuses, effective access chips", "Inherit · Paid" in row(page, "subject", hsc_math).inner_text() and "Paid" in row(page, "level", hsc_id).inner_text())
    shot(page, "academic-admin-tree")

    # ------------------------------------------------------------------ D. Rename keeps every relationship
    print("\n[D] Rename — the stable ids keep all relationships")
    act(page, "section", sid, "edit"); page.wait_for_selector("#ac-form")
    page.fill("#ac-name", "Academic Programs"); save_node(page)
    page.wait_for_function("document.querySelector('li.ac-node[data-kind=\"section\"] .ac-title b').textContent === 'Academic Programs'")
    levels_after = col(page, "academicLevels")
    check("after the rename the same section id is used, the levels still point at it", col(page, "academicSections")[sid]["name"] == "Academic Programs" and levels_after[ssc_id]["sectionId"] == sid and levels_after[hsc_id]["sectionId"] == sid)
    act(page, "subject", hsc_math, "edit"); page.wait_for_selector("#ac-form")
    check("editing a subject: location fields are locked", page.locator("#ac-section").is_disabled() and page.locator("#ac-level").is_disabled())
    page.fill("#ac-name", "Higher Mathematics"); save_node(page)
    page.wait_for_function("document.body.innerText.includes('Higher Mathematics')")
    check("subject renamed, still in HSC", col(page, "academicSubjects")[hsc_math]["name"] == "Higher Mathematics" and col(page, "academicSubjects")[hsc_math]["levelId"] == hsc_id)
    act(page, "subject", hsc_math, "edit"); page.fill("#ac-name", "Mathematics"); save_node(page)
    page.wait_for_function("!document.body.innerText.includes('Higher Mathematics')")

    # ------------------------------------------------------------------ E. Reorder
    print("\n[E] Display order")
    check("levels listed in creation order: SSC, HSC", tree_names(page, "level") == ["SSC", "HSC"], str(tree_names(page, "level")))
    act(page, "level", hsc_id, "up")
    page.wait_for_function("document.querySelector('li.ac-node[data-kind=\"level\"] .ac-title b').textContent === 'HSC'")
    lv = col(page, "academicLevels")
    check("move up: HSC now before SSC, orders renumbered 10 / 20", lv[hsc_id]["order"] == 10 and lv[ssc_id]["order"] == 20 and tree_names(page, "level") == ["HSC", "SSC"], str((lv[hsc_id]["order"], lv[ssc_id]["order"])))
    check("first item has no 'move up', last has no 'move down'", row(page, "level", hsc_id).locator('[data-act="up"]').is_disabled() and row(page, "level", ssc_id).locator('[data-act="down"]').is_disabled())

    # ------------------------------------------------------------------ F. Status, hidden list, archive
    print("\n[F] Active / inactive / archived — and what students are told")
    act(page, "level", ssc_id, "more"); sheet(page, "toggle")
    confirm_danger(page)
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"] .chip') && document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Inactive')" % (ssc_id, ssc_id))
    check("deactivating a level that has content asks first, then saves 'inactive'", col(page, "academicLevels")[ssc_id]["status"] == "inactive")
    hidden = dump(page)["examIndex/main"].get("academicHidden", [])
    check("examIndex/main.academicHidden now lists it (students' exam catalog skips its exams)", ssc_id in hidden and hsc_id not in hidden, str(hidden))
    check("existing exam index data survived (exams, courses, site)", len(dump(page)["examIndex/main"]["exams"]) == 11 and "courses" in dump(page)["examIndex/main"])
    act(page, "level", ssc_id, "more"); sheet(page, "toggle")
    page.wait_for_function("!document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Inactive')" % ssc_id)
    check("activating again removes it from the hidden list", ssc_id not in dump(page)["examIndex/main"].get("academicHidden", []))
    act(page, "subject", hsc_math, "more"); sheet(page, "archive")     # no exam under it yet → no confirmation needed
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Archived')" % hsc_math)
    check("archive: status archived, hidden list updated", col(page, "academicSubjects")[hsc_math]["status"] == "archived" and hsc_math in dump(page)["examIndex/main"]["academicHidden"])
    act(page, "subject", hsc_math, "more"); sheet(page, "archive")
    page.wait_for_function("!document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Archived')" % hsc_math)
    check("restore from archive", col(page, "academicSubjects")[hsc_math]["status"] == "active" and hsc_math not in dump(page)["examIndex/main"]["academicHidden"])
    act(page, "section", sid, "more"); sheet(page, "preview")
    page.wait_for_selector(".ac-preview-wrap .ac-card")
    check("Preview shows the student's card + the student link", "Academic Programs" in page.inner_text(".ac-preview-wrap") and f"academicProgram={sid}" in page.inner_text(".modal-box"))
    page.keyboard.press("Escape"); page.wait_for_timeout(250)
    if page.locator(".ac-preview-wrap").count(): page.locator(".modal-box [data-modal-close]").first.click()

    # ------------------------------------------------------------------ G. Search / filter
    print("\n[G] Search and filters")
    page.fill("#ac-q", "higher secondary")
    page.wait_for_timeout(400)
    check("search keeps the matching level, its subjects and its section", tree_names(page, "level") == ["HSC"] and tree_names(page, "subject") == ["Mathematics"] and tree_names(page, "section") == ["Academic Programs"], str((tree_names(page, "level"), tree_names(page, "subject"))))
    page.fill("#ac-q", "zzz-nothing")
    page.wait_for_timeout(400)
    check("no match → friendly message", "Nothing matches" in page.inner_text("#ac-tree"))
    page.fill("#ac-q", ""); page.wait_for_timeout(300)
    page.select_option("#ac-access", "paid"); page.wait_for_timeout(200)
    check("access filter: only the Paid level (plus its section as context)", tree_names(page, "level") == ["HSC"])
    page.select_option("#ac-access", "all"); page.select_option("#ac-status", "inactive"); page.wait_for_timeout(200)
    check("status filter: nothing is inactive right now", "Nothing matches" in page.inner_text("#ac-tree"))
    page.select_option("#ac-status", "all"); page.wait_for_timeout(200)
    check("filters cleared → full tree", tree_names(page, "level") == ["HSC", "SSC"])

    # ------------------------------------------------------------------ H. Exam editor placement
    print("\n[H] Exams → Create New Exam: Academic placement (Section → Level → Subject)")
    admin_page(page, "#/exams", "#add-exam-btn-top")
    page.wait_for_timeout(600)
    page.click("#add-exam-btn-top")
    page.wait_for_selector("#em-academic")
    check("existing fields are all still there", all(page.locator(s).count() == 1 for s in ("#em-title", "#em-exam-type", "#em-duration", "#em-negative-marking", "#em-max-attempts", "#em-course-id", "#em-subject", "#em-category")))
    check("placement box starts empty; level and subject are disabled until chosen", page.locator("#em-ac-level").is_disabled() and page.locator("#em-ac-subject").is_disabled())
    page.select_option("#em-ac-section", sid)
    opts = [o.strip() for o in page.locator("#em-ac-level option").all_inner_texts()]
    check("choosing the section loads ITS levels", opts == ["— Select level —", "HSC", "SSC"], str(opts))
    page.select_option("#em-ac-level", ssc_id)
    opts = [o.strip() for o in page.locator("#em-ac-subject option").all_inner_texts()]
    check("choosing the level loads ONLY that level's subjects", opts == ["— Select subject —", "Mathematics"], str(opts))
    page.select_option("#em-ac-subject", ssc_math)
    check("the academic path is spelled out", "Academic Programs" in page.inner_text("#em-ac-path") and "SSC" in page.inner_text("#em-ac-path") and "Mathematics" in page.inner_text("#em-ac-path"), page.inner_text("#em-ac-path"))
    page.select_option("#em-ac-subject", "")
    page.fill("#em-title", "SSC Mathematics Model Test 01")
    page.click("#em-tab-btn-questions")
    page.click("#em-add-question-btn")
    page.fill(".q-text-input", "2 + 2 = ?")
    for i, v in enumerate(["3", "4", "5", "6"]): page.locator(".q-option-input").nth(i).fill(v)
    page.click("#exam-modal-save-btn")
    page.wait_for_timeout(500)
    check("a half-finished placement (no subject) is refused with an explanation", page.locator("#exam-modal-form").count() == 1 and "choose the section, the level AND the subject" in page.inner_text("body"), page.inner_text("body")[-300:])
    page.select_option("#em-ac-subject", ssc_math)
    page.click("#exam-modal-save-btn")
    page.wait_for_function("document.querySelector('#exam-modal-form') === null", timeout=9000)
    exams = {i: d for i, d in col(page, "exams").items() if d.get("title") == "SSC Mathematics Model Test 01"}
    eid, edoc = next(iter(exams.items())) if exams else (None, None)
    check("exam saved with the three stable ids", edoc and (edoc["academicProgramId"], edoc["academicLevelId"], edoc["academicSubjectId"]) == (sid, ssc_id, ssc_math), str(edoc))
    check("all the usual exam fields are saved too", edoc and all(k in edoc for k in ("examType", "duration", "questionCount", "negativeMarking", "maxAttempts", "status", "subjectId", "categoryId", "courseId")))
    idx_entry = next((e for e in dump(page)["examIndex/main"]["exams"] if e["id"] == eid), None)
    check("the students' exam index carries the academic ids too", idx_entry and idx_entry["academicSubjectId"] == ssc_math, str(idx_entry))
    page.wait_for_timeout(500)
    check("exam list shows the academic path under the title", "Academic Programs › SSC › Mathematics" in page.inner_text("body"), "")
    page.locator(f'[data-act="edit"][data-id="{eid}"]').first.click()
    page.wait_for_selector("#em-academic")
    check("editing the exam shows its placement preselected",
          page.input_value("#em-ac-section") == sid and page.input_value("#em-ac-level") == ssc_id and page.input_value("#em-ac-subject") == ssc_math)
    page.locator(".modal-close-btn").first.dispatch_event("click")   # icon-only button: Font Awesome is not loaded in the sandbox, so it has no size
    page.wait_for_timeout(250)
    # an existing (non-academic) exam is edited and saved without ever gaining academic fields
    page.locator('[data-act="edit"][data-id="up2"]').first.click()
    page.wait_for_selector("#em-academic")
    check("an existing exam opens with the placement box empty", page.input_value("#em-ac-section") == "")
    page.click("#em-tab-btn-questions")
    page.click("#em-add-question-btn")
    page.fill(".q-text-input", "x?")
    for i, v in enumerate(["a", "b", "c", "d"]): page.locator(".q-option-input").nth(i).fill(v)
    page.click("#exam-modal-save-btn")
    page.wait_for_function("document.querySelector('#exam-modal-form') === null", timeout=9000)
    up2 = dump(page)["exams/up2"]
    check("…saved without any academic field appearing on it (backward compatible)", not any(k.startswith("academic") for k in up2) and up2["title"] == "Mathematics Speed Test", str([k for k in up2 if k.startswith("academic")]))

    # ------------------------------------------------------------------ I. Safe delete
    print("\n[I] Safe delete — a node with content is never deleted; archive it or move its content")
    admin_page(page, "#/academic", "#ac-kpis .kpi")
    page.wait_for_function("document.querySelector('#ac-kpis').innerText.includes('Academic exams')")
    page.wait_for_timeout(500)
    check("dashboard counts the academic exam", kpi(page, "Academic exams") == "1", kpi(page, "Academic exams"))
    check("tree row shows the exam count", "1 exam" in row(page, "subject", ssc_math).inner_text(), row(page, "subject", ssc_math).inner_text())
    act(page, "level", hsc_id, "more"); sheet(page, "delete")
    page.wait_for_selector("#ac-del-arch, .ac-usage")
    check("deleting a level that has subjects is blocked, with the numbers", "can't be deleted yet" in page.inner_text(".modal-box") and "1 subject" in page.inner_text(".ac-usage"), page.inner_text(".modal-box")[:200])
    page.locator("#ac-del-arch").click()
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Archived')" % hsc_id)
    check("…'Archive it instead' keeps everything and hides it", hsc_id in col(page, "academicLevels") and hsc_math in col(page, "academicSubjects") and hsc_id in dump(page)["examIndex/main"]["academicHidden"])
    act(page, "level", hsc_id, "more"); sheet(page, "archive")
    page.wait_for_function("!document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Archived')" % hsc_id)

    act(page, "subject", ssc_math, "more"); sheet(page, "delete")
    page.wait_for_selector("#ac-del-to")
    check("a subject that still has an exam is blocked too (1 exam)", "1 exam" in page.inner_text(".ac-usage"))
    page.select_option("#ac-del-to", hsc_math)
    page.wait_for_selector("#ac-del-move:not([disabled])")
    check("choosing a target explains what will move", "1 exam" in page.inner_text("#ac-del-info"), page.inner_text("#ac-del-info"))
    page.click("#ac-del-move")
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"]') === null" % ssc_math, timeout=9000)
    moved = dump(page)[f"exams/{eid}"]
    check("the exam followed to HSC Mathematics (section, level AND subject re-pointed)", (moved["academicProgramId"], moved["academicLevelId"], moved["academicSubjectId"]) == (sid, hsc_id, hsc_math), str(moved))
    check("the emptied SSC Mathematics is deleted", ssc_math not in col(page, "academicSubjects") and hsc_math in col(page, "academicSubjects"))
    idx_entry = next(e for e in dump(page)["examIndex/main"]["exams"] if e["id"] == eid)
    check("the students' index was rewritten for the moved exam", idx_entry["academicSubjectId"] == hsc_math and idx_entry["academicLevelId"] == hsc_id)
    check("the exam's other data is untouched", moved["title"] == "SSC Mathematics Model Test 01" and moved["questionCount"] == 1)

    act(page, "section", sid, "add"); fill_node(page, "Temp level"); save_node(page)
    page.wait_for_function("document.body.innerText.includes('Temp level')")
    temp_id, _ = by_name(page, "academicLevels", "Temp level")
    act(page, "level", temp_id, "more"); sheet(page, "delete"); confirm_danger(page, "Temp level")
    page.wait_for_function("!document.body.innerText.includes('Temp level')")
    check("an EMPTY level is deleted after typing its name", temp_id not in col(page, "academicLevels"))

    # ------------------------------------------------------------------ J. Paid access
    print("\n[J] Paid access — who may open a Paid level (academicEntitlements)")
    act(page, "level", hsc_id, "edit"); fill_node(page, "HSC", course="c1"); save_node(page)
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Main Course')" % hsc_id)
    check("linked course saved on the level (linkedCourseId)", col(page, "academicLevels")[hsc_id]["linkedCourseId"] == "c1")
    act(page, "level", hsc_id, "more"); sheet(page, "access")
    page.wait_for_selector("#ac-find")
    check("access dialog explains the item is Paid and enforced by the server", "Paid" in page.inner_text(".modal-box") and "firestore.rules" in page.inner_text(".modal-box"))
    page.fill("#ac-find", "Rahim")
    page.wait_for_selector("[data-grant]")
    page.click("[data-grant]")
    page.wait_for_function("document.querySelector('#ac-ents').innerText.includes('Rahim')")
    ent = dump(page).get(f"academicEntitlements/stuA_{hsc_id}")
    check("granting writes academicEntitlements/{uid}_{nodeId}", ent and ent["uid"] == "stuA" and ent["nodeId"] == hsc_id and ent["nodeKind"] == "level" and ent["source"] == "admin", str(ent))
    page.click("#ac-import")
    page.wait_for_function("document.querySelector('#ac-ents').innerText.includes('access code')")
    ents = {k: v for k, v in dump(page).items() if k.startswith("academicEntitlements/")}
    check("import from redeemed access codes: only USED codes of THIS course (stuB), not unused (stuC) or another course (stuA's c-other)",
          f"academicEntitlements/stuB_{hsc_id}" in ents and f"academicEntitlements/stuC_{hsc_id}" not in ents and ents[f"academicEntitlements/stuB_{hsc_id}"]["source"] == "accessCode", str(list(ents)))
    page.locator(".ac-ent", has_text="Rahim").locator("[data-revoke]").click()
    confirm_danger(page)
    page.wait_for_function("document.querySelector('#ac-ents') && !document.querySelector('#ac-ents').innerText.includes('Rahim') && document.querySelector('#ac-ents').innerText.includes('access code')")
    check("revoke removes the grant (the dialog comes back with the updated list)", f"academicEntitlements/stuA_{hsc_id}" not in dump(page) and f"academicEntitlements/stuB_{hsc_id}" in dump(page))
    page.locator(".modal-box [data-modal-close]").first.click()
    page.wait_for_timeout(250)

    # ------------------------------------------------------------------ K. Roles
    print("\n[K] Roles — a viewer can look, an editor can edit but not delete")
    state = dump(page)
    for role, can_write, can_delete, can_access in (("viewer", False, False, False), ("editor", True, False, False), ("manager", True, True, True)):
        s2 = dict(state); s2["adminRoles/adm1"] = {"role": role}
        c2 = make_context(browser, VIEWPORTS["desktop"], seed=s2, user="adm1"); install_clock(c2)
        p2 = new_page(c2, errors); p2.set_default_timeout(9000)
        admin_page(p2, "#/academic", f'li.ac-node[data-id="{sid}"]')
        check(f"{role}: sees the page", p2.locator("#ac-kpis .kpi").count() == 8)
        check(f"{role}: 'New section' / edit buttons {'present' if can_write else 'absent'}", (p2.locator("#ac-new").count() == 1) == can_write and (p2.locator('[data-act="edit"]').count() > 0) == can_write)
        p2.locator(f'li.ac-node[data-id="{hsc_id}"] > .ac-row [data-act="more"]').click()
        p2.wait_for_selector(".ac-sheet")
        check(f"{role}: ⋯ menu — delete {'yes' if can_delete else 'no'}, student access {'yes' if can_access else 'no'}",
              (p2.locator('[data-sheet="delete"]').count() == 1) == can_delete and (p2.locator('[data-sheet="access"]').count() == 1) == can_access)
        check(f"{role}: always can preview", p2.locator('[data-sheet="preview"]').count() == 1)
        if role == "viewer":
            check("viewer: opening the page wrote nothing", not [w for w in writes(p2) if w["path"].startswith("academic") or w["path"] == "examIndex/main"], str(writes(p2)))
        c2.close()

    print("\n[K2] The admin page on a phone")
    for vp, w in (("mobile", 390), ("mobile", 320)):
        pc = make_context(browser, VIEWPORTS[vp], seed=state, user="adm1"); install_clock(pc)
        pp = new_page(pc, errors); pp.set_default_timeout(9000)
        pp.set_viewport_size({"width": w, "height": 760})
        admin_page(pp, "#/academic", f'li.ac-node[data-id="{sid}"]'); pp.wait_for_timeout(500)
        check(f"{w}px: Academic Management has no horizontal overflow", no_overflow(pp))
        if w == 390:
            shot(pp, "academic-admin-mobile")
            pp.locator(f'li.ac-node[data-id="{sid}"] > .ac-row [data-act="edit"]').click(); pp.wait_for_selector("#ac-form")
            check("390px: the form fits the screen", no_overflow(pp))
            shot(pp, "academic-admin-form-mobile")
        pc.close()

    check("no storage requests during the whole admin run", storage_requests == [], str(storage_requests))
    check("no JS errors in the admin run", not errors, "; ".join(errors[:4]))

    # ------------------------------------------------------------------ L. What the admin created, on the student site
    print("\n[L] The same data on the STUDENT site (admin → student round trip)")
    # make SSC (level) inactive first, so the 'hidden' path is exercised with real admin-written data
    act(page, "level", ssc_id, "more"); sheet(page, "toggle")
    page.wait_for_function("document.querySelector('li.ac-node[data-id=\"%s\"]').innerText.includes('Inactive')" % ssc_id)
    final = dump(page)
    final["users/stu1"]["isAdmin"] = False
    sctx = make_context(browser, VIEWPORTS["mobile"], seed=final, user="stu1"); install_clock(sctx)
    errs2 = []
    sp = new_page(sctx, errs2); sp.set_default_timeout(9000)
    go(sp, "#/exam"); sp.wait_for_selector("#exam-academic-block .ac-card")
    check("the section the admin created (renamed) is on the student's Courses page", sp.locator("#exam-academic-block .ac-cover-title").first.inner_text().strip() == "Academic Programs")
    check("its cover URL is the one saved in Firestore", sp.locator("#exam-academic-block img.ac-cover-img").get_attribute("src") == IMG)
    go(sp, f"#/exam?academicProgram={sid}"); sp.wait_for_selector('.ac-card[data-kind="level"]')
    names = [t.strip() for t in sp.locator(".ac-grid .ac-cover-title").all_inner_texts()]
    check("levels: the inactive SSC is hidden, the Paid HSC (with its linked course) is shown", names == ["HSC"], str(names))
    go(sp, f"#/exam?academicProgram={sid}&academicLevel={hsc_id}&academicSubject={hsc_math}"); sp.wait_for_selector(".ac-state--locked")
    check("HSC Mathematics (Paid, no grant) is locked for this student", "Premium access required" in sp.inner_text("#exam-grid"))
    go(sp, f"#/exam?academicProgram={sid}&academicLevel={ssc_id}"); sp.wait_for_selector(".ac-state")
    check("the deactivated SSC level is 'not available' to students", "isn't available" in sp.inner_text("#exam-grid"))
    go(sp, f"#/exam?id={eid}"); sp.wait_for_selector(".exs-fail, .exs-fail-card, [class*=fail]", timeout=9000)
    check("the exam the admin created and moved is locked behind the same Paid gate", "Premium access required" in sp.inner_text("body"), sp.inner_text("body")[:160])
    check("no JS errors on the student site", not errs2, "; ".join(errs2[:3]))
    sctx.close()

    code = finish()
    browser.close()
    sys.exit(code)
