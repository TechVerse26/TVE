// Unit tests: academic markup safety · roles · firestore.rules structure · "images are URL strings only — no Firebase Storage".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as U from "../../js/academic-ui.js";
import * as A from "../../js/academic-core.js";
import { ROLES, setRole, can } from "../../js/admin/core/permissions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir, out = []) => {
  for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, f.name);
    if (f.isDirectory()) { if (!["node_modules", ".git", "tests"].includes(f.name)) walk(rel, out); } else out.push(rel);
  }
  return out;
};
const node = (o = {}) => A.normalizeNode(o.kind || "level", "L1", { name: "SSC", status: "active", sectionId: "P1", ...o });

/* ==========================================================================
   Markup: nothing the admin types can become HTML
   ========================================================================== */
test("cardHtml escapes the name, the description and the ids", () => {
  const n = node({ name: `<img src=x onerror=alert(1)>`, description: `"><script>alert(2)</script>` });
  const html = U.cardHtml(n, { href: A.academicHash({ program: "P1", level: "L1" }), meta: [{ icon: "fa-file-pen", text: "<b>3 Exams</b>" }] });
  assert.ok(!html.includes("<script>") && !html.includes("<img src=x"), html);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;b&gt;3 Exams&lt;/b&gt;"));
  assert.equal((html.match(/<a /g) || []).length, 1);
});

test("coverHtml: a valid https URL becomes ONE <img> element; unsafe or missing URLs never produce markup", () => {
  const ok = U.coverHtml(node({ coverImage: "https://cdn.example.com/a.webp" }));
  assert.equal((ok.match(/<img /g) || []).length, 1);
  assert.ok(ok.includes('src="https://cdn.example.com/a.webp"') && ok.includes('loading="lazy"') && ok.includes('alt=""') && ok.includes('referrerpolicy="no-referrer"'));
  for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "http://example.com/a.png", `https://x.example.com/a.png" onerror="alert(1)`, "", undefined]) {
    const html = U.coverHtml({ ...node(), coverImage: bad });
    assert.ok(!html.includes("<img"), String(bad));
    assert.ok(html.includes("ac-cover is-empty"), "falls back to the placeholder");
  }
});

test("the cover is never written as inline CSS (no url('…') injection surface)", () => {
  const html = U.cardHtml(node({ coverImage: "https://cdn.example.com/a.webp" }));
  assert.ok(!/style\s*=/.test(html) && !/url\(/.test(html));
});

test("a cover URL with quotes/angle brackets is percent-encoded by validation before it can reach an attribute", () => {
  const html = U.coverHtml({ ...node(), coverImage: `https://x.example.com/a.png?q="><svg onload=alert(1)>` });
  assert.ok(!html.includes("<svg") && !html.includes('onload="'), html);
});

test("accessBadgeHtml: Free, Paid (locked), Paid · Unlocked", () => {
  assert.match(U.accessBadgeHtml({ mode: "free", allowed: true, locked: false }), /ac-badge--free/);
  const locked = U.accessBadgeHtml({ mode: "paid", allowed: false, locked: true });
  assert.match(locked, /ac-badge--paid/); assert.match(locked, /fa-lock"/); assert.ok(!locked.includes("is-open"));
  const open = U.accessBadgeHtml({ mode: "paid", allowed: true, locked: false });
  assert.match(open, /is-open/); assert.match(open, /Unlocked/);
  assert.equal(U.accessBadgeHtml(null), "");
});

test("a locked card is flagged; the admin preview uses a non-link element", () => {
  assert.match(U.cardHtml(node(), { verdict: { mode: "paid", allowed: false, locked: true } }), /is-locked/);
  const preview = U.cardHtml(node(), { tag: "div" });
  assert.ok(preview.startsWith("\n    <div") && !preview.includes("href="));
});

test("plural / esc", () => {
  assert.equal(U.plural(1, "Level"), "1 Level"); assert.equal(U.plural(0, "Level"), "0 Levels"); assert.equal(U.plural(2, "Exam"), "2 Exams");
  assert.equal(U.esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

/* ==========================================================================
   Images are URL strings only — Firebase Storage is not used anywhere
   ========================================================================== */
test("no module imports or calls Firebase Storage, and none creates upload / base64 image code", () => {
  const files = walk("js").filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 50);
  for (const f of files) {
    const src = read(f);
    assert.ok(!/firebase-storage/i.test(src), `${f}: Firebase Storage import`);
    assert.ok(!/\b(getStorage|uploadBytes|uploadBytesResumable|uploadString|getDownloadURL)\b/.test(src), `${f}: Storage API`);
  }
  for (const f of ["js/academic-core.js", "js/academic-ui.js", "js/academic-data.js", "js/academic-render.js", "js/admin/academic.js", "js/admin/core/academic-data.js"]) {
    const src = read(f);
    assert.ok(!/FileReader|readAsDataURL|<input[^>]+type="file"|type=\\?"file/.test(src), `${f}: file upload / base64 code`);
    assert.ok(!/firebasestorage|appspot\.com\/o\//.test(src), `${f}: storage URL`);
  }
});

test("the pure modules import nothing from Firebase (they run in Node and in the browser alike)", () => {
  for (const f of ["js/academic-core.js", "js/academic-ui.js"]) assert.ok(!/from\s+["'](https?:|\.\/firebase|\.\.\/firebase)/.test(read(f)), f);
});

test("neither the student nor the admin academic code hard-codes a level or subject name", () => {
  const names = /\b(SSC|HSC|Masters|Honours|Mathematics|Physics|Chemistry|Biology)\b/;
  for (const f of ["js/academic-core.js", "js/academic-ui.js", "js/academic-data.js", "js/academic-render.js", "js/admin/core/academic-data.js"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!names.test(code), `${f}: ${code.match(names)?.[0]}`);
  }
  const admin = read("js/admin/academic.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // the only mentions allowed are the grey placeholder examples inside the create form
  const stripped = admin.replace(/placeholder="[^"]*"/g, "");
  assert.ok(!names.test(stripped), stripped.match(names)?.[0]);
});

/* ==========================================================================
   Roles
   ========================================================================== */
test("roles: Academic permissions are split view / write / delete / access", () => {
  const has = (role, perm) => ROLES[role].perms.includes("*") || ROLES[role].perms.includes(perm);
  for (const p of ["academic.view", "academic.write", "academic.delete", "academic.access"]) assert.ok(has("super", p) && has("manager", p), p);
  assert.ok(has("editor", "academic.view") && has("editor", "academic.write"));
  assert.ok(!has("editor", "academic.delete") && !has("editor", "academic.access"));
  assert.ok(has("viewer", "academic.view") && !has("viewer", "academic.write") && !has("viewer", "academic.delete") && !has("viewer", "academic.access"));
});

test("roles: can() follows the active role", () => {
  setRole("viewer"); assert.equal(can("academic.view"), true); assert.equal(can("academic.write"), false);
  setRole("editor"); assert.equal(can("academic.write"), true); assert.equal(can("academic.delete"), false);
  setRole("manager"); assert.equal(can("academic.access"), true);
  setRole("super");
});

/* ==========================================================================
   firestore.rules — structure checks (the rules themselves are exercised in the Firebase emulator / console)
   ========================================================================== */
const rules = read("firestore.rules");
const stripRules = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""').replace(/\/\/[^\n]*/g, "");
const block = (name) => {
  const start = rules.indexOf(`match /${name}/`);
  assert.ok(start > 0, `${name} block`);
  // the block opens at the first "{" after the path variable (e.g. {sectionId}) has closed
  const open = rules.indexOf("{", rules.indexOf("}", start) + 1);
  let depth = 0;
  for (let j = open; j < rules.length; j++) {
    if (rules[j] === "{") depth++;
    if (rules[j] === "}" && --depth === 0) return rules.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
};

test("rules: braces, parentheses and brackets are balanced; every called function exists", () => {
  const body = stripRules(rules);
  for (const [a, b] of ["{}", "()", "[]"]) assert.equal(body.split(a).length, body.split(b).length, `${a}${b}`);
  const defined = new Set([...body.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const builtin = new Set(["function", "get", "exists", "size", "matches", "hasAll", "hasAny", "hasOnly", "split", "keys", "diff", "affectedKeys", "toMillis", "path", "if", "in", "return", "database", "int", "string", "is", "request", "resource", "debug", "getAfter", "existsAfter"]);
  const called = [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]).filter((n) => !builtin.has(n));
  const undefinedCalls = [...new Set(called.filter((n) => !defined.has(n)))];
  assert.deepEqual(undefinedCalls, []);
});

test("rules: the four academic collections exist, and nothing in them mentions Storage or enrolledCourses", () => {
  for (const c of ["academicSections", "academicLevels", "academicSubjects", "academicEntitlements"]) assert.ok(rules.includes(`match /${c}/`), c);
  const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");               // rules code without comments
  const helpers = code.slice(code.indexOf("function hasAcademicGrant"), code.indexOf("function examOpenForStudents"));
  const collections = ["academicSections", "academicLevels", "academicSubjects", "academicEntitlements"].map((c) => block(c)).join("\n");
  assert.ok(helpers.length > 500 && collections.length > 500);
  for (const part of [helpers, collections, code.slice(code.indexOf("function validAcademicNode"), code.indexOf("match /academicSections/"))]) {
    assert.ok(!/enrolledCourses/.test(part), "Paid access must not rest on the client-editable enrolledCourses array");
    assert.ok(!/storage/i.test(part), "no Storage anywhere in the academic rules");
  }
});

test("rules: students read only ACTIVE nodes; only admins write; deleting is Super Admin / Manager", () => {
  for (const c of ["academicSections", "academicLevels", "academicSubjects"]) {
    const b = stripRules(block(c));
    assert.match(b, /allow read:\s*if isAdmin\(\)\s*\|\|\s*\(isSignedIn\(\)\s*&&\s*resource\.data\.status\s*==\s*''\)/, `${c} read`);
    assert.match(b, /allow create(, update)?:\s*if canEditContent\(\)\s*&&\s*validAcademicNode\(request\.resource\.data\)/, `${c} create`);
    if (c !== "academicSections") assert.match(b, /allow update:\s*if canEditContent\(\)\s*&&\s*validAcademicNode\(request\.resource\.data\)/, `${c} update`);
    assert.match(b, /allow delete:\s*if canManageComms\(\)/, `${c} delete`);
  }
});

test("rules: a level needs an existing section, a subject needs a level of the SAME section (server-side parent-child check)", () => {
  const level = stripRules(block("academicLevels")), subject = stripRules(block("academicSubjects"));
  // existsAfter / getAfter: inside one batch the level / section that moves WITH its children is seen in its new state
  assert.match(level, /existsAfter\(\/databases\/\$\(database\)\/documents\/academicSections\//);
  assert.match(subject, /getAfter\(\/databases\/\$\(database\)\/documents\/academicLevels\/[^)]*\)[^)]*\)\.data\.sectionId\s*==\s*request\.resource\.data\.sectionId/);
  // a rename / reorder / status change does not change the parent → no lookup at all
  assert.match(level, /request\.resource\.data\.sectionId\s*==\s*resource\.data\.get\(''?,\s*''\)/);
  assert.match(subject, /request\.resource\.data\.levelId\s*==\s*resource\.data\.get\(''?,\s*''\)/);
});

test("rules: cover images are validated as https URL strings, size-capped, never stored as anything else", () => {
  const fn = rules.slice(rules.indexOf("function validAcademicNode"), rules.indexOf("match /academicSections/"));
  assert.match(fn, /coverImage', ''\) is string/);
  assert.match(fn, /size\(\) <= 2048/);
  assert.match(fn, /matches\('https:\/\/\[\^ \]\+'\)/);
});

test("rules: grants are written only by Super Admin / Manager, never by the student, and the id is {uid}_{nodeId}", () => {
  const b = stripRules(block("academicEntitlements"));
  assert.match(b, /allow create, update:\s*if canManageComms\(\)/);
  assert.match(b, /allow delete:\s*if canManageComms\(\)/);
  assert.match(b, /entId\s*==\s*request\.resource\.data\.uid\s*\+\s*''\s*\+\s*request\.resource\.data\.nodeId/);
  assert.match(b, /allow read:\s*if isSignedIn\(\)\s*&&\s*\(resource\.data\.uid\s*==\s*request\.auth\.uid\s*\|\|\s*isAdmin\(\)\)/);
  assert.ok(!/allow (create|update|write)[^;]*isSignedIn\(\)\s*[;&]/.test(b.replace(/allow read[^;]*;/, "")), "a signed-in student must not be able to write a grant");
});

test("rules: question access (exams/{id}/questions and examBundles) goes through examOpenForStudents → academicAllowsStudent", () => {
  const fn = stripRules(rules.slice(rules.indexOf("function examOpenForStudents"), rules.indexOf("function examOpenForStudents") + 1800));
  assert.match(fn, /&&\s*academicAllowsStudent\(ex\)/);
  assert.match(rules, /match \/questions\/\{[^}]+\}\s*\{[^}]*examOpenForStudents\(examId\)/);
  assert.match(rules, /match \/examBundles\/\{bundleId\}[\s\S]{0,500}examOpenForStudents\(bundleExamId\(bundleId\)\)/);
});

test("rules: academicAllowsStudent is a no-op for exams without academic fields (existing exams unchanged, no extra reads)", () => {
  const fn = stripRules(rules.slice(rules.indexOf("function academicAllowsStudent"), rules.indexOf("function academicAllowsStudent") + 700));
  assert.match(fn, /return ex\.get\(''?,\s*''\)\s*==\s*''\s*\|\|/);
  assert.ok(rules.includes("function academicAllowsStudent(ex) {\n      return ex.get('academicSubjectId', '') == ''"));
});

test("rules: the academic gate checks status of all three nodes, the id consistency, Free/Paid inheritance and the three grant ids", () => {
  const src = rules.slice(rules.indexOf("function hasAcademicGrant"), rules.indexOf("function examOpenForStudents"));
  for (const needle of ["sub.get('status', 'inactive') == 'active'", "lvl.get('status', 'inactive') == 'active'", "sec.get('status', 'inactive') == 'active'",
    "sub.get('levelId', '') == ex.academicLevelId", "sub.get('sectionId', '') == ex.academicProgramId", "lvl.get('sectionId', '') == ex.academicProgramId",
    "hasAcademicGrant(ex.academicSubjectId)", "hasAcademicGrant(ex.academicLevelId)", "hasAcademicGrant(ex.academicProgramId)",
    "academicEntitlements/$(request.auth.uid + '_' + nodeId)"]) assert.ok(src.includes(needle), needle);
});

test("rules: existing collections keep their rules (the diff only ADDS academic parts and one clause in examOpenForStudents)", () => {
  for (const c of ["users", "courses", "exams", "examIndex", "examBundles", "examTaxonomy", "results", "purchaseRequests", "accessCodes", "adminRoles", "adminLogs", "homeFeed"]) {
    assert.ok(rules.includes(`match /${c}/`), `${c} rule still present`);
  }
});
