// Unit tests for the Academic Management logic (pure: no Firebase, no DOM).   node --test tests/unit
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../../js/academic-core.js";

/* ---------- fixtures: SSC / HSC / Masters, nothing hard-coded in the code under test ---------- */
const sec = (id, name, o = {}) => A.normalizeNode("section", id, { name, status: "active", accessMode: "inherit", order: 10, ...o });
const lvl = (id, sectionId, name, o = {}) => A.normalizeNode("level", id, { sectionId, name, status: "active", accessMode: "inherit", order: 10, ...o });
const sub = (id, sectionId, levelId, name, o = {}) => A.normalizeNode("subject", id, { sectionId, levelId, name, status: "active", accessMode: "inherit", order: 10, ...o });

const data = () => ({
  sections: [sec("P1", "Academic"), sec("P2", "Admission", { order: 20 })],
  levels: [lvl("L-ssc", "P1", "SSC"), lvl("L-hsc", "P1", "HSC", { order: 20 }), lvl("L-ms", "P1", "Masters", { order: 30 })],
  subjects: [
    sub("S-ssc-math", "P1", "L-ssc", "Mathematics"),
    sub("S-hsc-math", "P1", "L-hsc", "Mathematics"),
    sub("S-hsc-phy", "P1", "L-hsc", "পদার্থবিজ্ঞান", { order: 20 }),
  ],
});

/* ==========================================================================
   Cover image URL — only safe https strings are ever accepted
   ========================================================================== */
test("validateImageUrl accepts a normal https image link and trims it", () => {
  const v = A.validateImageUrl("  https://cdn.example.com/images/ssc-cover.webp  ");
  assert.equal(v.ok, true);
  assert.equal(v.url, "https://cdn.example.com/images/ssc-cover.webp");
});

test("validateImageUrl: empty is allowed (no image) unless asked otherwise", () => {
  assert.deepEqual(A.validateImageUrl(""), { ok: true, url: "", empty: true });
  assert.deepEqual(A.validateImageUrl(null), { ok: true, url: "", empty: true });
  assert.equal(A.validateImageUrl("", { allowEmpty: false }).reason, "empty");
});

test("validateImageUrl rejects every unsafe scheme and plain http", () => {
  const bad = {
    "http://example.com/a.png": "not-https",
    "javascript:alert(1)": "unsafe-scheme",
    "JaVaScRiPt:alert(1)": "unsafe-scheme",
    "data:image/png;base64,iVBORw0KGgo=": "unsafe-scheme",
    "file:///etc/passwd": "unsafe-scheme",
    "blob:https://example.com/1234": "unsafe-scheme",
    "ftp://example.com/a.png": "unsafe-scheme",
    "vbscript:msgbox(1)": "unsafe-scheme",
  };
  for (const [url, reason] of Object.entries(bad)) {
    const v = A.validateImageUrl(url);
    assert.equal(v.ok, false, url);
    assert.equal(v.reason, reason, url);
  }
});

test("validateImageUrl rejects junk: spaces, control chars, credentials, no host, protocol-relative, too long", () => {
  assert.equal(A.validateImageUrl("https://example.com/a b.png").reason, "whitespace");
  assert.equal(A.validateImageUrl("https://example.com/a\n.png").reason, "whitespace");
  assert.equal(A.validateImageUrl("https://user:pass@example.com/a.png").reason, "credentials");
  assert.equal(A.validateImageUrl("//evil.example.com/a.png").reason, "invalid");
  assert.equal(A.validateImageUrl("example.com/a.png").reason, "invalid");
  assert.equal(A.validateImageUrl("https://localhost/a.png").reason, "invalid");
  assert.equal(A.validateImageUrl("https://").reason, "invalid");
  assert.equal(A.validateImageUrl(`https://example.com/${"a".repeat(2100)}.png`).reason, "too-long");
});

test("validateImageUrl output can never break out of an HTML attribute", () => {
  const v = A.validateImageUrl(`https://example.com/a.png?x="><script>alert(1)</script>`);
  assert.equal(v.ok, true);
  assert.ok(!/[<>"]/.test(v.url), v.url);
});

test("safeImageUrl: valid URL or empty string — bad data never reaches the markup", () => {
  assert.equal(A.safeImageUrl("https://example.com/x.jpg"), "https://example.com/x.jpg");
  assert.equal(A.safeImageUrl("javascript:alert(1)"), "");
  assert.equal(A.safeImageUrl("data:image/svg+xml;base64,AAAA"), "");
  assert.equal(A.safeImageUrl(undefined), "");
  assert.equal(A.safeImageUrl(42), "");
});

test("every image rejection reason has a message", () => {
  for (const r of ["empty", "too-long", "whitespace", "invalid", "not-https", "unsafe-scheme", "credentials"]) {
    assert.ok(A.IMAGE_REASON_TEXT[r], r);
  }
});

/* ==========================================================================
   Normalising Firestore documents
   ========================================================================== */
test("normalizeNode fills defaults, fixes types and drops an unsafe cover image", () => {
  const n = A.normalizeNode("subject", "abc", { name: "  Higher   Math ", coverImage: "javascript:x", status: "weird", order: "7", accessMode: "vip", sectionId: "S", levelId: "L" });
  assert.equal(n.name, "Higher Math");
  assert.equal(n.coverImage, "");
  assert.equal(n.status, "inactive");          // a broken status is never published
  assert.equal(n.order, 7);
  assert.equal(n.accessMode, "inherit");
  assert.equal(n.sectionId, "S");
  assert.equal(n.levelId, "L");
  assert.equal(n.kind, "subject");
});

test("normalizeNode: a section has no parent fields, a level has sectionId only", () => {
  const s = A.normalizeNode("section", "a", { name: "X", sectionId: "ignored" });
  assert.ok(!("sectionId" in s) && !("levelId" in s));
  const l = A.normalizeNode("level", "b", { name: "Y", sectionId: "a", levelId: "ignored" });
  assert.equal(l.sectionId, "a");
  assert.ok(!("levelId" in l));
});

test("normalizeNode survives null / garbage documents", () => {
  assert.equal(A.normalizeNode("section", "z", null).status, "inactive");
  assert.equal(A.normalizeNode("section", "z", "oops").name, "");
  assert.equal(A.displayName(A.normalizeNode("section", "z", {})), "Untitled");
});

/* ==========================================================================
   Validating the admin's form
   ========================================================================== */
test("validateNodeInput: a valid section", () => {
  const r = A.validateNodeInput("section", { name: " Academic ", description: "School & college", coverImage: "https://x.example.com/a.webp", status: "active", accessMode: "free", order: "10", linkedCourseId: "" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.clean, { name: "Academic", description: "School & college", coverImage: "https://x.example.com/a.webp", status: "active", order: 10, accessMode: "free", linkedCourseId: "" });
});

test("validateNodeInput: name rules — required, length, duplicate among siblings only", () => {
  assert.equal(A.validateNodeInput("section", { name: "   " }).errors.name, "name-required");
  assert.equal(A.validateNodeInput("section", { name: "x".repeat(81) }).errors.name, "name-too-long");
  const siblings = [sec("a", "SSC")];
  assert.equal(A.validateNodeInput("section", { name: "ssc" }, { siblings }).errors.name, "name-duplicate");
  assert.equal(A.validateNodeInput("section", { name: "SSC" }, { siblings, editingId: "a" }).ok, true, "editing itself is not a duplicate");
});

test("SSC Mathematics and HSC Mathematics are separate subjects (same name, different parent)", () => {
  const d = data();
  const inHsc = d.subjects.filter((s) => s.levelId === "L-hsc");
  const dup = A.validateNodeInput("subject", { name: "Mathematics", sectionId: "P1", levelId: "L-hsc" }, { siblings: inHsc, sections: d.sections, levels: d.levels });
  assert.equal(dup.errors.name, "name-duplicate");
  const inMs = d.subjects.filter((s) => s.levelId === "L-ms");
  const ok = A.validateNodeInput("subject", { name: "Mathematics", sectionId: "P1", levelId: "L-ms" }, { siblings: inMs, sections: d.sections, levels: d.levels });
  assert.equal(ok.ok, true);
});

test("validateNodeInput: bad image / status / access / order / course are all reported", () => {
  const r = A.validateNodeInput("section", { name: "A", coverImage: "http://x.example.com/a.png", status: "deleted", accessMode: "vip", order: "-3", linkedCourseId: "bad id!" });
  assert.equal(r.ok, false);
  assert.equal(r.errors.coverImage, "image-not-https");
  assert.equal(r.errors.status, "status-invalid");
  assert.equal(r.errors.accessMode, "access-invalid");
  assert.equal(r.errors.order, "order-invalid");
  assert.equal(r.errors.linkedCourseId, "course-invalid");
  assert.equal(A.validateNodeInput("section", { name: "A", order: "1.5" }).errors.order, "order-invalid");
});

test("validateNodeInput: description limit; blank order falls back to the default order", () => {
  assert.equal(A.validateNodeInput("section", { name: "A", description: "d".repeat(401) }).errors.description, "desc-too-long");
  assert.equal(A.validateNodeInput("section", { name: "A", order: "" }, { defaultOrder: 40 }).clean.order, 40);
});

test("validateNodeInput: parent must exist, and a subject's level must belong to its section", () => {
  const d = data();
  const ctx = { sections: d.sections, levels: d.levels };
  assert.equal(A.validateNodeInput("level", { name: "Honours", sectionId: "nope" }, ctx).errors.sectionId, "parent-missing");
  assert.equal(A.validateNodeInput("level", { name: "Honours", sectionId: "" }, ctx).errors.sectionId, "parent-missing");
  assert.equal(A.validateNodeInput("subject", { name: "Bio", sectionId: "P1", levelId: "nope" }, ctx).errors.levelId, "parent-missing");
  assert.equal(A.validateNodeInput("subject", { name: "Bio", sectionId: "P2", levelId: "L-ssc" }, ctx).errors.levelId, "parent-mismatch");
  assert.equal(A.validateNodeInput("subject", { name: "Bio", sectionId: "P1", levelId: "L-ssc" }, ctx).ok, true);
});

/* ==========================================================================
   Free / Paid / Inherit
   ========================================================================== */
const chainOf = (d, kind, id) => A.indexNodes(d).chainOf(kind, id);

test("access: everything inherits → Free by default", () => {
  const eff = A.resolveAccess(chainOf(data(), "subject", "S-hsc-phy"));
  assert.equal(eff.mode, "free");
  assert.equal(eff.source, "default");
});

test("access: the example from the brief — Academic Free, SSC Free, HSC Paid, Masters Paid", () => {
  const d = data();
  d.sections[0].accessMode = "free";
  d.levels.find((l) => l.id === "L-ssc").accessMode = "free";
  d.levels.find((l) => l.id === "L-hsc").accessMode = "paid";
  d.levels.find((l) => l.id === "L-ms").accessMode = "paid";
  assert.equal(A.resolveAccess(chainOf(d, "level", "L-ssc")).mode, "free");
  assert.equal(A.resolveAccess(chainOf(d, "level", "L-hsc")).mode, "paid");
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-math")).mode, "paid");      // a subject inheriting from a Paid level
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-math")).inherited, true);
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-math")).nodeId, "L-hsc");
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-ssc-math")).mode, "free");
});

test("access: the second example — Academic Paid, SSC Inherit, HSC Free, Masters Inherit", () => {
  const d = data();
  d.sections[0].accessMode = "paid";
  d.levels.find((l) => l.id === "L-hsc").accessMode = "free";
  assert.equal(A.resolveAccess(chainOf(d, "level", "L-ssc")).mode, "paid");   // inherits Paid from the section
  assert.equal(A.resolveAccess(chainOf(d, "level", "L-hsc")).mode, "free");   // explicit override
  assert.equal(A.resolveAccess(chainOf(d, "level", "L-ms")).mode, "paid");
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-math")).mode, "free");
});

test("access: a single subject can be overridden to Paid inside a Free level", () => {
  const d = data();
  d.subjects.find((s) => s.id === "S-hsc-phy").accessMode = "paid";
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-phy")).mode, "paid");
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-phy")).inherited, false);
  assert.equal(A.resolveAccess(chainOf(d, "subject", "S-hsc-math")).mode, "free");
});

test("verdict: Paid content needs an entitlement on the subject, its level or its section", () => {
  const d = data();
  d.levels.find((l) => l.id === "L-hsc").accessMode = "paid";
  const chain = chainOf(d, "subject", "S-hsc-math");
  const none = A.accessVerdict(chain, new Set());
  assert.equal(none.allowed, false); assert.equal(none.locked, true); assert.equal(none.reason, "payment-required");
  assert.equal(A.accessVerdict(chain, new Set(["L-hsc"])).allowed, true);      // bought the level
  assert.equal(A.accessVerdict(chain, ["P1"]).allowed, true);                  // bought the whole section
  assert.equal(A.accessVerdict(chain, new Set(["S-hsc-math"])).allowed, true); // bought just this subject
  assert.equal(A.accessVerdict(chain, new Set(["S-hsc-phy"])).allowed, false); // another subject's entitlement does not help
  assert.equal(A.accessVerdict(chain, new Set(["L-ssc"])).allowed, false);     // nor does a sibling level's
  assert.equal(A.accessVerdict(chain, undefined).allowed, false);
});

test("verdict: Free content is open; admins always get in; a hidden chain is not available to students", () => {
  const d = data();
  const free = A.accessVerdict(chainOf(d, "subject", "S-ssc-math"), new Set());
  assert.equal(free.allowed, true); assert.equal(free.reason, "free");

  d.levels.find((l) => l.id === "L-hsc").accessMode = "paid";
  const paid = chainOf(d, "subject", "S-hsc-math");
  assert.equal(A.accessVerdict(paid, new Set(), { isAdmin: true }).allowed, true);
  assert.equal(A.accessVerdict(paid, new Set(), { isAdmin: true }).reason, "admin");

  d.levels.find((l) => l.id === "L-hsc").status = "archived";
  const hidden = A.accessVerdict(chainOf(d, "subject", "S-hsc-math"), new Set(["L-hsc"]));
  assert.equal(hidden.allowed, false); assert.equal(hidden.reason, "hidden");
  assert.equal(A.accessVerdict(chainOf(d, "subject", "S-hsc-math"), new Set(), { isAdmin: true }).allowed, true);
});

test("entitlementId is the (uid, node) pair the security rules look up", () => {
  assert.equal(A.entitlementId("u123", "L-hsc"), "u123_L-hsc");
});

/* ==========================================================================
   Tree, ordering, reordering
   ========================================================================== */
test("buildTree nests sections › levels › subjects in display order", () => {
  const d = data();
  d.levels.reverse(); d.subjects.reverse();
  const { tree, orphanLevels, orphanSubjects } = A.buildTree(d);
  assert.deepEqual(tree.map((s) => s.name), ["Academic", "Admission"]);
  assert.deepEqual(tree[0].levels.map((l) => l.name), ["SSC", "HSC", "Masters"]);
  assert.deepEqual(tree[0].levels[1].subjects.map((s) => s.id), ["S-hsc-math", "S-hsc-phy"]);
  assert.equal(orphanLevels.length, 0); assert.equal(orphanSubjects.length, 0);
});

test("buildTree reports orphans (a parent that no longer exists, or a subject filed under the wrong section)", () => {
  const d = data();
  d.levels.push(lvl("L-x", "gone", "Lost"));
  d.subjects.push(sub("S-x", "P1", "missing-level", "Lost subject"));
  d.subjects.push(sub("S-y", "P2", "L-ssc", "Wrong section"));
  const { orphanLevels, orphanSubjects } = A.buildTree(d);
  assert.deepEqual(orphanLevels.map((l) => l.id), ["L-x"]);
  assert.deepEqual(orphanSubjects.map((s) => s.id).sort(), ["S-x", "S-y"]);
});

test("buildTree: a subject under a level whose section is gone is an orphan too (it can still be found and fixed)", () => {
  const d = data();
  d.levels.push(lvl("L-x", "gone", "Lost"));
  d.subjects.push(sub("S-under-lost", "gone", "L-x", "Under a lost level"));
  const { orphanLevels, orphanSubjects } = A.buildTree(d);
  assert.deepEqual(orphanLevels.map((l) => l.id), ["L-x"]);
  assert.deepEqual(orphanSubjects.map((s) => s.id), ["S-under-lost"]);
});

test("byOrder: order first, then name (Bengali and numbers sort without crashing)", () => {
  const list = [sec("1", "Class 10", { order: 5 }), sec("2", "Class 9", { order: 5 }), sec("3", "ক্লাস", { order: 1 })];
  assert.deepEqual(list.sort(A.byOrder).map((n) => n.id), ["3", "2", "1"]);
});

test("nextOrder / reorderPlan: swap neighbours, renumber 10-20-30, stop at the ends", () => {
  const sibs = [sec("a", "A", { order: 10 }), sec("b", "B", { order: 20 }), sec("c", "C", { order: 30 })];
  assert.equal(A.nextOrder(sibs), 40);
  assert.equal(A.nextOrder([]), 10);
  assert.deepEqual(A.reorderPlan(sibs, "b", "up"), [{ id: "b", order: 10 }, { id: "a", order: 20 }]);
  assert.deepEqual(A.reorderPlan(sibs, "b", "down"), [{ id: "c", order: 20 }, { id: "b", order: 30 }]);
  assert.deepEqual(A.reorderPlan(sibs, "a", "up"), []);
  assert.deepEqual(A.reorderPlan(sibs, "c", "down"), []);
  assert.deepEqual(A.reorderPlan(sibs, "zzz", "up"), []);
});

test("reorderPlan fixes a list where every order is the same", () => {
  const sibs = [sec("a", "A", { order: 0 }), sec("b", "B", { order: 0 }), sec("c", "C", { order: 0 })];
  const plan = A.reorderPlan(sibs, "c", "up");
  assert.deepEqual(plan.sort((x, y) => x.order - y.order), [{ id: "a", order: 10 }, { id: "c", order: 20 }, { id: "b", order: 30 }]);
});

/* ==========================================================================
   Deleting safely, hiding, placement
   ========================================================================== */
test("deletionBlockers: a parent with subjects or exams cannot be deleted outright", () => {
  const d = data();
  const exams = [{ id: "e1", academicProgramId: "P1", academicLevelId: "L-hsc", academicSubjectId: "S-hsc-math" }, { id: "e2" }];
  const s = A.deletionBlockers("section", "P1", { ...d, exams });
  assert.deepEqual([s.levels, s.subjects, s.exams, s.blocked], [3, 3, 1, true]);
  const l = A.deletionBlockers("level", "L-hsc", { ...d, exams });
  assert.deepEqual([l.subjects, l.exams, l.blocked], [2, 1, true]);
  assert.equal(A.deletionBlockers("level", "L-ms", { ...d, exams }).blocked, false);
  assert.equal(A.deletionBlockers("subject", "S-hsc-math", { ...d, exams }).exams, 1);
  assert.equal(A.deletionBlockers("subject", "S-ssc-math", { ...d, exams }).blocked, false);
  assert.equal(A.deletionBlockers("section", "P2", { ...d, exams }).blocked, false);
});

test("computeHiddenIds lists exactly the nodes that are not active; isAcademicHidden checks an exam's three ids", () => {
  const d = data();
  d.levels.find((l) => l.id === "L-ms").status = "inactive";
  d.subjects.find((s) => s.id === "S-hsc-phy").status = "archived";
  const ids = A.computeHiddenIds(d);
  assert.deepEqual(ids, ["L-ms", "S-hsc-phy"]);
  const hidden = new Set(ids);
  assert.equal(A.isAcademicHidden({ academicProgramId: "P1", academicLevelId: "L-ms", academicSubjectId: "S-x" }, hidden), true);
  assert.equal(A.isAcademicHidden({ academicProgramId: "P1", academicLevelId: "L-hsc", academicSubjectId: "S-hsc-phy" }, hidden), true);
  assert.equal(A.isAcademicHidden({ academicProgramId: "P1", academicLevelId: "L-hsc", academicSubjectId: "S-hsc-math" }, hidden), false);
  assert.equal(A.isAcademicHidden({ id: "old exam without academic fields" }, hidden), false);   // existing exams are never affected
  assert.equal(A.isAcademicHidden({ academicSubjectId: "S-hsc-phy" }, new Set()), false);
  assert.equal(A.isAcademicHidden(null, hidden), false);
});

test("validatePlacement: all empty = not academic; all three set and consistent = ok; anything else is an error", () => {
  const index = A.indexNodes(data());
  assert.deepEqual(A.validatePlacement({}, index), { ok: true, empty: true, payload: { academicProgramId: "", academicLevelId: "", academicSubjectId: "" } });
  const ok = A.validatePlacement({ sectionId: "P1", levelId: "L-hsc", subjectId: "S-hsc-math" }, index);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, { academicProgramId: "P1", academicLevelId: "L-hsc", academicSubjectId: "S-hsc-math" });
  assert.equal(A.validatePlacement({ sectionId: "P1", levelId: "L-hsc" }, index).error, "incomplete");
  assert.equal(A.validatePlacement({ sectionId: "P1", levelId: "L-hsc", subjectId: "ghost" }, index).error, "missing");
  assert.equal(A.validatePlacement({ sectionId: "P1", levelId: "L-ssc", subjectId: "S-hsc-math" }, index).error, "mismatch");
  assert.equal(A.validatePlacement({ sectionId: "P2", levelId: "L-hsc", subjectId: "S-hsc-math" }, index).error, "mismatch");
});

test("examsOfNode / hasAcademic / placementPath", () => {
  const index = A.indexNodes(data());
  const exams = [
    { id: "e1", academicProgramId: "P1", academicLevelId: "L-hsc", academicSubjectId: "S-hsc-math" },
    { id: "e2", academicProgramId: "P1", academicLevelId: "L-ssc", academicSubjectId: "S-ssc-math" },
    { id: "legacy", title: "Old exam" },
  ];
  assert.deepEqual(A.examsOfNode(exams, "subject", "S-hsc-math").map((e) => e.id), ["e1"]);
  assert.deepEqual(A.examsOfNode(exams, "section", "P1").map((e) => e.id), ["e1", "e2"]);
  assert.deepEqual(A.examsOfNode(exams, "level", "L-ssc").map((e) => e.id), ["e2"]);
  assert.equal(A.hasAcademic(exams[2]), false);
  assert.equal(A.placementPath(exams[0], index), "Academic › HSC › Mathematics");
  assert.equal(A.placementPath(exams[2], index), "");
});

test("academicSummary: the numbers on the admin dashboard", () => {
  const d = data();
  d.sections[1].accessMode = "paid";
  d.levels.find((l) => l.id === "L-ms").status = "inactive";
  d.subjects.find((s) => s.id === "S-hsc-phy").accessMode = "paid";
  const s = A.academicSummary(d, [{ academicSubjectId: "S-hsc-math" }, { title: "legacy" }]);
  assert.deepEqual([s.sections, s.levels, s.subjects, s.exams], [2, 3, 3, 1]);
  assert.equal(s.paid, 2);                  // the Admission section + the Physics subject
  assert.equal(s.free, 8 - 2);
  assert.equal(s.active, 7);
  assert.equal(s.inactive, 1);
});

/* ==========================================================================
   Routes
   ========================================================================== */
test("parseAcademicParams: not academic → null; each depth parsed; type only on a subject", () => {
  assert.equal(A.parseAcademicParams(new URLSearchParams("course=abc")), null);
  assert.equal(A.parseAcademicParams(new URLSearchParams("")), null);
  assert.deepEqual(A.parseAcademicParams(new URLSearchParams("academicProgram=P1")), { program: "P1", level: "", subject: "", type: "", invalid: false });
  const full = A.parseAcademicParams(new URLSearchParams("academicProgram=P1&academicLevel=L1&academicSubject=S1&type=practice"));
  assert.deepEqual(full, { program: "P1", level: "L1", subject: "S1", type: "practice", invalid: false });
});

test("parseAcademicParams flags broken URLs instead of trusting them", () => {
  const bad = [
    "academicProgram=P1&academicSubject=S1",                         // subject without level
    "academicProgram=P1&academicLevel=L1&type=live",                 // type without subject
    "academicProgram=P1&academicLevel=L1&academicSubject=S1&type=hack",
    "academicProgram=%3Cscript%3E",
    "academicProgram=P1&academicLevel=a/b",
    `academicProgram=${"x".repeat(200)}`,
  ];
  for (const q of bad) assert.equal(A.parseAcademicParams(new URLSearchParams(q)).invalid, true, q);
});

test("academicHash builds the documented URLs and round-trips through parseAcademicParams", () => {
  assert.equal(A.academicHash(), "#/exam");
  assert.equal(A.academicHash({ program: "P1" }), "#/exam?academicProgram=P1");
  assert.equal(A.academicHash({ program: "P1", level: "L1" }), "#/exam?academicProgram=P1&academicLevel=L1");
  assert.equal(A.academicHash({ program: "P1", level: "L1", subject: "S1" }), "#/exam?academicProgram=P1&academicLevel=L1&academicSubject=S1");
  assert.equal(A.academicHash({ program: "P1", level: "L1", subject: "S1", type: "practice" }), "#/exam?academicProgram=P1&academicLevel=L1&academicSubject=S1&type=practice");
  assert.equal(A.academicHash({ program: "P1", subject: "S1" }), "#/exam?academicProgram=P1", "a child without its parent is dropped");
  assert.equal(A.academicHash({ program: "P1", level: "L1", subject: "S1", type: "nope" }), "#/exam?academicProgram=P1&academicLevel=L1&academicSubject=S1");
  const hash = A.academicHash({ program: "P1", level: "L1", subject: "S1", type: "live" });
  const back = A.parseAcademicParams(new URLSearchParams(hash.split("?")[1]));
  assert.deepEqual(back, { program: "P1", level: "L1", subject: "S1", type: "live", invalid: false });
});

test("isSafeId / cleanText", () => {
  assert.equal(A.isSafeId("Ab1_-x"), true);
  for (const bad of ["", "a b", "a/b", "a<b", "x".repeat(129), null, 5]) assert.equal(A.isSafeId(bad), false, String(bad));
  assert.equal(A.cleanText("  a \n b\t c  ", 10), "a b c");
  assert.equal(A.cleanText("abcdef", 3), "abc");
  assert.equal(A.cleanText(undefined), "");
});

test("the three collections the brief asks for + the exam fields keep their documented names", () => {
  assert.equal(A.COL.section, "academicSections");
  assert.equal(A.COL.level, "academicLevels");
  assert.equal(A.COL.subject, "academicSubjects");
  assert.deepEqual({ ...A.EXAM_FIELD }, { section: "academicProgramId", level: "academicLevelId", subject: "academicSubjectId" });
});

/* ==========================================================================
   Safe delete → move content elsewhere; "Move to…" (pure planners)
   ========================================================================== */
const exam = (id, p, l, s) => ({ id, academicProgramId: p, academicLevelId: l, academicSubjectId: s });
const nodesOf = (d) => ({ sections: d.sections, levels: d.levels, subjects: d.subjects });

test("reassignPlan(subject): the exams follow to the target subject, with its level and section", () => {
  const d = data();
  const exams = [exam("e1", "P1", "L-hsc", "S-hsc-math"), exam("e2", "P1", "L-ssc", "S-ssc-math"), { id: "legacy" }];
  const plan = A.reassignPlan("subject", "S-hsc-math", "S-ssc-math", nodesOf(d), exams);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops, [{ type: "exam", id: "e1", patch: { academicProgramId: "P1", academicLevelId: "L-ssc", academicSubjectId: "S-ssc-math" } }]);
  assert.deepEqual(plan.counts, { levels: 0, subjects: 0, exams: 1 });
});

test("reassignPlan(level): subjects change level + section, their exams change level + section", () => {
  const d = data();
  d.sections.push(sec("P3", "Other"));
  d.levels.push(lvl("L-other", "P3", "Other level"));
  const exams = [exam("e1", "P1", "L-hsc", "S-hsc-math"), exam("e2", "P1", "L-ssc", "S-ssc-math")];
  const plan = A.reassignPlan("level", "L-hsc", "L-other", nodesOf(d), exams);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops.filter((o) => o.type === "subject").map((o) => [o.id, o.patch]).sort(), [
    ["S-hsc-math", { levelId: "L-other", sectionId: "P3" }],
    ["S-hsc-phy", { levelId: "L-other", sectionId: "P3" }],
  ]);
  assert.deepEqual(plan.ops.filter((o) => o.type === "exam"), [{ type: "exam", id: "e1", patch: { academicLevelId: "L-other", academicProgramId: "P3" } }]);
  assert.deepEqual(plan.counts, { levels: 0, subjects: 2, exams: 1 });
});

test("reassignPlan(section): levels, subjects and exams all re-pointed to the target section", () => {
  const d = data();
  const exams = [exam("e1", "P1", "L-hsc", "S-hsc-math")];
  const plan = A.reassignPlan("section", "P1", "P2", nodesOf(d), exams);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.counts, { levels: 3, subjects: 3, exams: 1 });
  assert.ok(plan.ops.filter((o) => o.type !== "exam").every((o) => o.patch.sectionId === "P2"));
  assert.deepEqual(plan.ops.find((o) => o.type === "exam").patch, { academicProgramId: "P2" });
});

test("reassignPlan refuses a missing target, the same node, and a target whose parent is gone", () => {
  const d = data();
  assert.equal(A.reassignPlan("subject", "S-hsc-math", "ghost", nodesOf(d), []).ok, false);
  assert.equal(A.reassignPlan("subject", "S-hsc-math", "S-hsc-math", nodesOf(d), []).ok, false);
  assert.equal(A.reassignPlan("subject", "ghost", "S-ssc-math", nodesOf(d), []).ok, false);
  d.subjects.push(sub("S-lost", "P1", "no-such-level", "Lost"));
  assert.equal(A.reassignPlan("subject", "S-hsc-math", "S-lost", nodesOf(d), []).error, "target-broken");
});

test("reassignPlan is idempotent: once everything moved, planning again finds nothing left to do", () => {
  const d = data();
  const exams = [exam("e1", "P1", "L-hsc", "S-hsc-math")];
  const plan = A.reassignPlan("subject", "S-hsc-math", "S-ssc-math", nodesOf(d), exams);
  for (const op of plan.ops) Object.assign(exams.find((e) => e.id === op.id), op.patch);   // apply
  const again = A.reassignPlan("subject", "S-hsc-math", "S-ssc-math", nodesOf(d), exams);
  assert.equal(again.ok, true);
  assert.equal(again.ops.length, 0);
  assert.equal(A.placementPath(exams[0], A.indexNodes(d)), "Academic › SSC › Mathematics");
});

test("moveCollisions: same-named children that would meet under one parent", () => {
  const d = data();
  d.subjects.push(sub("S-ms-math", "P1", "L-ms", "mathematics"));
  assert.deepEqual(A.moveCollisions("level", "L-ssc", "L-ms", d), ["Mathematics"]);
  assert.deepEqual(A.moveCollisions("level", "L-ssc", "L-hsc", d), ["Mathematics"]);
  assert.deepEqual(A.moveCollisions("level", "L-hsc", "L-ssc", d), ["Mathematics"]);
  assert.deepEqual(A.moveCollisions("section", "P1", "P2", d), []);
  assert.deepEqual(A.moveCollisions("subject", "S-hsc-math", "S-ssc-math", d), []);
  assert.deepEqual(A.moveCollisions("level", "L-ssc", "L-nothing", d), []);
});

test("movePlan(subject): the subject, and only its own exams, move to the new level", () => {
  const d = data();
  const exams = [exam("e1", "P1", "L-hsc", "S-hsc-phy"), exam("e2", "P1", "L-hsc", "S-hsc-math")];
  const plan = A.movePlan("subject", "S-hsc-phy", "L-ms", nodesOf(d), exams);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops, [
    { type: "subject", id: "S-hsc-phy", parent: "L-ms", patch: { levelId: "L-ms", sectionId: "P1" } },
    { type: "exam", id: "e1", patch: { academicLevelId: "L-ms", academicProgramId: "P1" } },
  ]);
});

test("movePlan(level): the level, its subjects and the exams under it move to the new section", () => {
  const d = data();
  const exams = [exam("e1", "P1", "L-ssc", "S-ssc-math")];
  const plan = A.movePlan("level", "L-ssc", "P2", nodesOf(d), exams);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops, [
    { type: "level", id: "L-ssc", parent: "P2", patch: { sectionId: "P2" } },
    { type: "subject", id: "S-ssc-math", parent: "L-ssc", patch: { sectionId: "P2" } },
    { type: "exam", id: "e1", patch: { academicProgramId: "P2" } },
  ]);
});

test("movePlan refuses: a section, the same parent, a missing parent, a name clash", () => {
  const d = data();
  assert.equal(A.movePlan("section", "P1", "P2", nodesOf(d), []).error, "kind");
  assert.equal(A.movePlan("level", "L-ssc", "P1", nodesOf(d), []).error, "same");
  assert.equal(A.movePlan("level", "L-ssc", "ghost", nodesOf(d), []).error, "target");
  assert.equal(A.movePlan("subject", "S-hsc-phy", "ghost", nodesOf(d), []).error, "target");
  assert.equal(A.movePlan("subject", "S-ssc-math", "L-hsc", nodesOf(d), []).error, "name-duplicate");
  d.levels.push(lvl("L-dup", "P2", "ssc"));
  assert.equal(A.movePlan("level", "L-ssc", "P2", nodesOf(d), []).error, "name-duplicate");
});

test("examBackHref: an academic exam goes back to its subject dashboard; every other exam keeps its old target", () => {
  const legacy = "#/exam?course=general";
  assert.equal(A.examBackHref({ academicProgramId: "P1", academicLevelId: "L-ssc", academicSubjectId: "S-ssc-math" }, legacy), "#/exam?academicProgram=P1&academicLevel=L-ssc&academicSubject=S-ssc-math");
  assert.equal(A.examBackHref({ id: "old", courseId: "c1" }, legacy), legacy);
  assert.equal(A.examBackHref({ academicProgramId: "P1", academicLevelId: "", academicSubjectId: "S1" }, legacy), legacy, "half-filled ids are ignored");
  assert.equal(A.examBackHref({ academicProgramId: "<x>", academicLevelId: "L", academicSubjectId: "S" }, legacy), legacy, "unsafe ids are ignored");
  assert.equal(A.examBackHref(null, legacy), legacy);
  assert.equal(A.examBackHref(undefined, ""), "");
});

/* ==========================================================================
   Write batches for moving content (Firestore: 500 writes / batch; the rules look up each changed parent, ~20 lookups / batch)
   ========================================================================== */
const op = (type, id, parent) => ({ type, id, ...(parent ? { parent } : {}), patch: {} });

test("chunkOps: parents first — levels before the subjects in them, exams last; nothing lost or duplicated", () => {
  const ops = [op("exam", "e1"), op("subject", "s1", "L1"), op("level", "L1", "P2"), op("exam", "e2"), op("subject", "s2", "L1")];
  const [only] = A.chunkOps(ops);
  assert.deepEqual(only.map((o) => o.id), ["L1", "s1", "s2", "e1", "e2"]);
  assert.equal(A.chunkOps([]).length, 0);
});

test("chunkOps: at most maxOps per batch", () => {
  const ops = Array.from({ length: 1000 }, (_, i) => op("exam", `e${i}`));
  const batches = A.chunkOps(ops, { maxOps: 400 });
  assert.deepEqual(batches.map((b) => b.length), [400, 400, 200]);
  assert.equal(new Set(batches.flat().map((o) => o.id)).size, 1000);
});

test("chunkOps: a batch references at most maxParents different parents (the rules' lookup budget), and same-parent ops stay together", () => {
  const ops = [];
  for (let l = 0; l < 25; l++) for (let k = 0; k < 3; k++) ops.push(op("subject", `s${l}-${k}`, `L${String(l).padStart(2, "0")}`));
  const batches = A.chunkOps(ops, { maxOps: 400, maxParents: 10 });
  assert.deepEqual(batches.map((b) => new Set(b.map((o) => o.parent)).size), [10, 10, 5]);
  for (const b of batches) for (const parent of new Set(b.map((o) => o.parent))) assert.equal(b.filter((o) => o.parent === parent).length, 3, "one level's subjects are never split");
  assert.equal(batches.flat().length, 75);
});

test("chunkOps: when levels are split from their subjects the levels are committed first", () => {
  const ops = [...Array.from({ length: 450 }, (_, i) => op("level", `L${i}`, "P-target")), ...Array.from({ length: 30 }, (_, i) => op("subject", `s${i}`, `L${i}`))];
  const batches = A.chunkOps(ops, { maxOps: 400, maxParents: 10 });
  const order = batches.flat().map((o) => o.type);
  assert.equal(order.lastIndexOf("level") < order.indexOf("subject"), true, "every level op precedes every subject op");
  assert.ok(batches.every((b) => b.length <= 400));
});

test("chunkOps: exams (no parent lookup) never count against the parent budget", () => {
  const ops = [...Array.from({ length: 30 }, (_, i) => op("exam", `e${i}`)), op("subject", "s", "L1")];
  const batches = A.chunkOps(ops, { maxParents: 1 });
  assert.equal(batches.length, 1);
});
