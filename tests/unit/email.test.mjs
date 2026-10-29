// Unit tests for the Email Center's pure logic (no Firebase, no DOM, no network, no real e-mail).
//   node --test tests/unit/email.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../js/email-core.js";
import * as R from "../../js/email-render.js";
import * as T from "../../js/email-templates-data.js";
import * as S from "../../js/email-service.js";

const T0 = Date.UTC(2026, 9, 25, 4, 0, 0); // 2026-10-25 10:00 in Dhaka
const H = 3600e3;
const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const SITE = { website: "https://tvsites.vercel.app", email: "tv.support.info@gmail.com" };
const exam = (o = {}) => ({ id: "e1", title: "Model Test 05", examType: "live", duration: 30, courseId: "", publishAt: ts(T0 - H), closesAt: ts(T0 + 3 * H), ...o });
const user = (id, o = {}) => ({ id, displayName: `Student ${id}`, email: `${id}@example.com`, roll: "", enrolledCourses: [], isAdmin: false, disabled: false, ...o });
const students = (list) => list.map(C.normalizeStudent);
const result = (uid, examId, o = {}) => ({ id: `${uid}_${examId}`, uid, examId, attemptNumber: 1, ...o });

/* ============================ core: small helpers ============================ */
test("isValidEmail accepts normal addresses and rejects header-injection / junk", () => {
  for (const ok of ["a@b.co", "first.last+tag@sub.example.org", "rahim_01@gmail.com"]) assert.equal(C.isValidEmail(ok), true, ok);
  for (const bad of ["", "a@b", "a b@c.com", "a@@b.com", "a@b..com", ".a@b.com", "a@-b.com", "x\n@y.com", "a@b.com\nBcc: z@z.com", "<a@b.com>", "a@b.c", "a,b@c.com"]) assert.equal(C.isValidEmail(bad), false, JSON.stringify(bad));
});
test("safeHttpUrl only lets http(s) through", () => {
  assert.equal(C.safeHttpUrl("https://tvsites.vercel.app"), "https://tvsites.vercel.app/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x.com", "https://a b.com", "", "//evil.com", 'https://x.com/"onmouseover=1']) assert.equal(C.safeHttpUrl(bad), "", bad);
});
test("oneLine flattens CR/LF so no header can be smuggled", () => {
  assert.equal(C.oneLine("Hello\r\nBcc: x@y.com"), "Hello Bcc: x@y.com");
  assert.equal(C.oneLine("a".repeat(300), 50).length, 50);
});
test("date / time wording follows the zone and never throws on a bad zone", () => {
  assert.match(C.fmtTimeShort(T0, "Asia/Dhaka", "en"), /^10:00 AM GMT\+6$/);
  assert.match(C.fmtDateLong(T0, "Asia/Dhaka", "en"), /25 October 2026/);
  assert.match(C.fmtDateLong(T0, "Asia/Dhaka", "bn"), /২৫/);
  assert.match(C.fmtTimeShort(T0, "Asia/Dhaka", "bn"), /বাংলাদেশ সময়/);
  assert.match(C.fmtTimeShort(T0, "Nope/Zone", "en"), /UTC/);
  assert.equal(C.fmtMinutes(30, "bn"), "৩০ মিনিট");
  assert.equal(C.fmtMinutes(0, "en"), null);
  assert.equal(C.fmtDateLong(NaN, "Asia/Dhaka", "en"), null);
});

/* ============================ core: students & eligibility ============================ */
test("normalizeStudent keeps only what the Email Center needs and never invents a student ID", () => {
  const s = C.normalizeStudent(user("u1", { roll: "0007", enrolledCourses: ["c1"], password: "x", token: "y" }));
  assert.deepEqual(Object.keys(s).sort(), ["courseIds", "createdAt", "disabled", "email", "isAdmin", "name", "roll", "studentId", "uid"]);
  assert.equal(s.studentId, "");
  assert.equal(s.roll, "0007");
});
test("admins and deactivated accounts are never eligible; course-only exams need the enrolment", () => {
  const e = exam({ courseId: "c1" });
  const [adm, off, out, ok] = students([user("a", { isAdmin: true }), user("b", { disabled: true }), user("c"), user("d", { enrolledCourses: ["c1"] })]);
  assert.deepEqual(C.examEligibility(adm, e), { eligible: false, reason: "admin" });
  assert.deepEqual(C.examEligibility(off, e), { eligible: false, reason: "deactivated" });
  assert.deepEqual(C.examEligibility(out, e), { eligible: false, reason: "not_enrolled" });
  assert.deepEqual(C.examEligibility(ok, e), { eligible: true, reason: "" });
  assert.equal(C.examEligibility(out, null).eligible, true, "no exam → no enrolment rule");
});

/* ============================ core: which campaign is honest for this exam ============================ */
test("exam state decides which reminders are allowed", () => {
  assert.equal(C.examEmailState(exam(), T0).key, "open");
  assert.equal(C.examEmailState(exam({ publishAt: ts(T0 + H) }), T0).key, "upcoming");
  assert.equal(C.examEmailState(exam({ closesAt: ts(T0 - 1) }), T0).key, "closed");
  assert.equal(C.examEmailState(exam({ cancelled: true }), T0).key, "cancelled");
  assert.equal(C.examEmailState(exam({ status: "draft" }), T0).key, "draft");
  assert.equal(C.examEmailState(exam({ registration: "closed" }), T0).key, "registration_closed");
  assert.equal(C.examEmailState(exam({ examType: "practice", publishAt: null, closesAt: null }), T0).key, "practice");
});
test("a closed / cancelled / draft exam never gets a 'you have not completed it' reminder", () => {
  for (const e of [exam({ closesAt: ts(T0 - 1) }), exam({ cancelled: true }), exam({ status: "draft" }), exam({ publishAt: ts(T0 + H) }), exam({ registration: "closed" })]) {
    assert.equal(C.typeAllowed("exam_not_attempted", e, T0).ok, false, C.examEmailState(e, T0).key);
  }
  assert.equal(C.typeAllowed("exam_not_attempted", exam(), T0).ok, true);
  assert.equal(C.typeAllowed("exam_started_not_submitted", exam({ registration: "closed" }), T0).ok, true, "a running attempt may still finish");
  assert.equal(C.typeAllowed("exam_started_not_submitted", exam({ closesAt: ts(T0 - 1) }), T0).ok, false);
  assert.equal(C.typeAllowed("announcement", exam({ closesAt: ts(T0 - 1) }), T0).ok, true, "an announcement is always fine");
});
test("an upcoming-exam reminder needs a real schedule — a date is never invented", () => {
  assert.equal(C.typeAllowed("exam_upcoming", exam(), T0).ok, true);
  assert.equal(C.typeAllowed("exam_upcoming", exam({ publishAt: ts(T0 + H) }), T0).ok, true);
  const noSchedule = exam({ publishAt: null, closesAt: null });
  assert.equal(C.typeAllowed("exam_upcoming", noSchedule, T0).ok, false);
  assert.equal(C.typeAllowed("exam_upcoming", null, T0).ok, false);
});

/* ============================ core: classification ============================ */
const roster = () => students([
  user("sub"), user("started"), user("never"), user("adm", { isAdmin: true }), user("off", { disabled: true }), user("other"), user("badmail", { email: "nope" }),
]);
test("classification: submitted / started / not attempted / excluded", () => {
  const results = R_idx([result("sub", "e1"), result("other", "e2") /* a DIFFERENT exam must not count */]);
  const sessions = C.indexSessions([{ uid: "started", starts: 2 }, { uid: "sub", starts: 1 }]);
  const { rows, counts } = C.classifyStudents({ students: roster(), exam: exam(), resultsByUid: results, sessionsByUid: sessions });
  const by = Object.fromEntries(rows.map((r) => [r.uid, r]));
  assert.equal(by.sub.status, "submitted");
  assert.equal(by.started.status, "started_no_submission");
  assert.equal(by.started.starts, 2);
  assert.equal(by.never.status, "not_attempted");
  assert.equal(by.other.status, "not_attempted", "a result for another exam must not mark this exam as completed");
  assert.equal(by.adm.status, "excluded"); assert.equal(by.adm.reason, "admin");
  assert.equal(by.off.status, "excluded"); assert.equal(by.off.reason, "deactivated");
  assert.equal(by.badmail.status, "not_attempted"); assert.equal(by.badmail.emailable, false);
  assert.equal(counts.submitted, 1); assert.equal(counts.started_no_submission, 1); assert.equal(counts.excluded, 2);
  assert.equal(counts.not_attempted, 3); assert.equal(counts.notSubmitted, 4); assert.equal(counts.eligible, 5);
});
function R_idx(list) { return C.indexResults(list, "e1"); }
test("indexResults matches on the examId field, falling back to the document id only when the field is absent", () => {
  const m = C.indexResults([result("a", "e1"), result("b", "e2"), { id: "c_e1", uid: "c" }, { id: "d_e2", uid: "d" }], "e1");
  assert.deepEqual([...m.keys()].sort(), ["a", "c"]);
});
test("when start tracking is unavailable nobody is called a confirmed non-starter", () => {
  const { rows, counts, sessionsOk } = C.classifyStudents({ students: roster(), exam: exam(), resultsByUid: R_idx([result("sub", "e1")]), sessionsByUid: null });
  assert.equal(sessionsOk, false);
  assert.equal(rows.filter((r) => r.status === "not_attempted").length, 0);
  assert.equal(rows.find((r) => r.uid === "never").status, "no_result_unverified");
  assert.equal(counts.not_attempted, 0);
  assert.ok(counts.no_result_unverified >= 3);
  assert.equal(C.statusText("no_result_unverified", "en").includes("Not attempted"), false, "the wording only claims what the results prove");
});
test("when the results cannot be read nothing can be verified at all", () => {
  const { rows, resultsOk } = C.classifyStudents({ students: roster(), exam: exam(), resultsByUid: null, sessionsByUid: new Map() });
  assert.equal(resultsOk, false);
  assert.ok(rows.filter((r) => r.eligible).every((r) => r.status === "unverified"));
});
test("an exam where everyone eligible has submitted leaves nobody to remind", () => {
  const only = students([user("a"), user("b")]);
  const { counts } = C.classifyStudents({ students: only, exam: exam(), resultsByUid: R_idx([result("a", "e1"), result("b", "e1", { attemptNumber: 3 })]), sessionsByUid: new Map() });
  assert.equal(counts.notSubmitted, 0); assert.equal(counts.submitted, 2);
});
test("an exam with no results at all: every eligible student is 'not attempted'", () => {
  const { counts } = C.classifyStudents({ students: roster(), exam: exam(), resultsByUid: new Map(), sessionsByUid: new Map() });
  assert.equal(counts.submitted, 0); assert.equal(counts.not_attempted, counts.eligible);
});
test("submittedAttempts follows the same rule as the exam engine", () => {
  assert.equal(C.submittedAttempts({}), 1);
  assert.equal(C.submittedAttempts({ attemptNumber: 3 }), 3);
  assert.equal(C.submittedAttempts({ attempts: [1, 2] }), 2);
  assert.equal(C.submittedAttempts({ attemptNumber: 1, attempts: [1, 2, 3] }), 3);
});

/* ============================ core: variables ============================ */
const vals = (o = {}) => C.buildValues({ student: C.normalizeStudent(user("u1", { roll: "0007", enrolledCourses: ["c1"] })), exam: exam({ courseId: "c1" }), courseTitleOf: (id) => ({ c1: "Main Course" }[id] || ""), classification: { status: "not_attempted", attempts: 0 }, campaign: { personalMessage: "Good luck!" }, site: SITE, now: T0, lang: "en", ...o });
test("every variable is filled from a real source — and left null when there is none", () => {
  const v = vals();
  assert.equal(v.student_name, "Student u1"); assert.equal(v.student_roll, "0007"); assert.equal(v.course_name, "Main Course");
  assert.equal(v.exam_title, "Model Test 05"); assert.equal(v.exam_duration, "30 minutes");
  assert.equal(v.attempt_status, "Not attempted — no submitted result recorded"); assert.equal(v.attempt_count, "0");
  assert.equal(v.website_url, "https://tvsites.vercel.app"); assert.equal(v.support_email, "tv.support.info@gmail.com");
  assert.equal(v.exam_url, "https://tvsites.vercel.app/#/exam?id=e1");
  assert.equal(v.student_id, null, "no student-ID field exists → never invented");
  assert.deepEqual(Object.keys(v).sort(), [...C.VARIABLE_KEYS].sort());
});
test("an exam without a schedule gives no date, time or deadline", () => {
  const v = vals({ exam: exam({ publishAt: null, closesAt: null }) });
  assert.equal(v.exam_date, null); assert.equal(v.exam_time, null); assert.equal(v.deadline, null);
  assert.equal(v.exam_duration, "30 minutes");
});
test("the campaign's own deadline wins; without an exam it still works for announcements", () => {
  const dl = T0 + 10 * H;
  assert.match(vals({ campaign: { deadlineMs: dl } }).deadline, /2026/);
  const v = vals({ exam: null, classification: null, campaign: { deadlineMs: dl } });
  assert.match(v.deadline, /2026/); assert.equal(v.exam_title, null); assert.equal(v.attempt_status, null);
});
test("results unverified → the attempt count is not guessed", () => {
  const v = vals({ classification: { status: "unverified", attempts: 0 } });
  assert.equal(v.attempt_count, null); assert.equal(v.attempt_status, "Could not be verified");
});
test("course name: exam's course first, else the student's own enrolments, never another student's", () => {
  const titles = (id) => ({ c1: "One", c2: "Two", c3: "Three", c4: "Four", c5: "Five" }[id] || "");
  const many = C.normalizeStudent(user("m", { enrolledCourses: ["c1", "c2", "c3", "c4", "c5"] }));
  assert.equal(vals({ student: many, exam: null, classification: null, courseTitleOf: titles }).course_name, "One, Two, Three +2");
  assert.equal(vals({ student: many, exam: null, classification: null, courseTitleOf: titles, campaign: { courseIds: ["c4"] } }).course_name, "Four");
  assert.equal(vals({ student: C.normalizeStudent(user("n")), exam: null, classification: null, courseTitleOf: titles }).course_name, null);
});
test("Bangla and bilingual wording", () => {
  assert.equal(vals({ lang: "bn" }).exam_duration, "৩০ মিনিট");
  assert.match(vals({ lang: "both" }).exam_duration, /30 minutes \/ ৩০ মিনিট/);
});

/* ============================ core: delivery model ============================ */
test("totals, recovery of in-flight rows, and what a retry may send", () => {
  const rows = [{ status: "accepted" }, { status: "accepted" }, { status: "failed" }, { status: "uncertain" }, { status: "pending" }, { status: "sending" }, { status: "skipped" }];
  const t = C.totalsOf(rows);
  assert.deepEqual(t, { total: 7, pending: 1, sending: 1, accepted: 2, failed: 1, uncertain: 1, skipped: 1 });
  assert.equal(C.recoverRows(rows).filter((r) => r.status === "uncertain").length, 2, "'sending' becomes 'uncertain' after a crash");
  assert.deepEqual(C.selectForRun(rows).map((r) => r.status), ["failed", "pending"]);
  assert.ok(!C.selectForRun(rows, { includeUncertain: true }).some((r) => r.status === "accepted"), "accepted is never sent again");
  assert.deepEqual(C.selectForRun(rows, { includeUncertain: true }).map((r) => r.status), ["failed", "uncertain", "pending"]);
  assert.deepEqual(C.selectForRun(rows, { includeFailed: false, includePending: false, includeUncertain: true }).map((r) => r.status), ["uncertain"]);
});
test("campaign status after a run", () => {
  const T = (o) => ({ ...C.emptyTotals(), ...o });
  assert.equal(C.campaignStatusFor(T({ total: 3, accepted: 3 })), "completed");
  assert.equal(C.campaignStatusFor(T({ total: 3, accepted: 2, failed: 1 })), "completed_errors");
  assert.equal(C.campaignStatusFor(T({ total: 3, accepted: 2, uncertain: 1 })), "completed_errors");
  assert.equal(C.campaignStatusFor(T({ total: 3, failed: 3 })), "failed");
  assert.equal(C.campaignStatusFor(T({ total: 3, accepted: 1, pending: 2 }), { stopped: true }), "stopped");
  assert.equal(C.campaignStatusFor(T({ total: 3, accepted: 1, pending: 2 })), "interrupted");
  assert.equal(C.campaignStatusFor(T({ total: 3, pending: 3 }), { configError: true }), "failed");
});
test("a campaign stuck in 'sending' with a dead heartbeat is interrupted", () => {
  assert.equal(C.isStale({ status: "sending", heartbeatAt: ts(T0 - 10 * 60e3) }, T0), true);
  assert.equal(C.isStale({ status: "sending", heartbeatAt: ts(T0 - 30e3) }, T0), false);
  assert.equal(C.isStale({ status: "completed", heartbeatAt: ts(T0 - 99 * 60e3) }, T0), false);
});

/* ============================ core: validation, fingerprint, CSV ============================ */
const okInput = () => ({ type: "exam_not_attempted", exam: exam(), now: T0, configComplete: true, configTested: true, resultsOk: true, sessionsOk: true, subject: "S", hasMessage: true, sendableCount: 5, unknownVariables: [], campaignLevelMissing: [], studentMissingCount: 0, missingPolicy: "block", oversize: false, safetyCap: 0 });
test("validateCampaign: a clean campaign passes", () => { assert.equal(C.validateCampaign(okInput()).ok, true); });
test("validateCampaign blocks every unsafe case", () => {
  const codes = (o) => C.validateCampaign({ ...okInput(), ...o }).blockers.map((b) => b.code);
  assert.ok(codes({ sendableCount: 0 }).includes("recipients"), "empty recipient list");
  assert.ok(codes({ configComplete: false }).includes("config"), "incomplete configuration");
  assert.ok(codes({ configTested: false }).includes("untested"), "never tested");
  assert.ok(codes({ subject: "  " }).includes("subject"));
  assert.ok(codes({ hasMessage: false }).includes("message"));
  assert.ok(codes({ unknownVariables: ["studnt_name"] }).includes("unknown_variables"));
  assert.ok(codes({ campaignLevelMissing: ["exam_date"] }).includes("campaign_missing"));
  assert.ok(codes({ studentMissingCount: 2, studentMissingKeys: ["student_roll"], missingPolicy: "block" }).includes("missing_data"));
  assert.ok(!codes({ studentMissingCount: 2, studentMissingKeys: ["student_roll"], missingPolicy: "skip" }).includes("missing_data"));
  assert.ok(codes({ oversize: true }).includes("size"));
  assert.ok(codes({ safetyCap: 3 }).includes("cap"));
  assert.ok(codes({ resultsOk: false }).includes("results"));
  assert.ok(codes({ exam: exam({ closesAt: ts(T0 - 1) }) }).includes("exam_state"), "closed exam");
  assert.ok(codes({ exam: null }).includes("exam"));
  assert.ok(codes({ type: "exam_started_not_submitted", sessionsOk: false }).includes("sessions"), "started-but-not-submitted needs session data");
  assert.ok(!codes({ sessionsOk: false }).includes("sessions"), "not-attempted only warns when sessions are unavailable");
  assert.ok(C.validateCampaign({ ...okInput(), sessionsOk: false }).warnings.some((w) => w.code === "sessions"));
});
test("campaignFingerprint ignores recipient order but notices a different audience or text", () => {
  const a = C.campaignFingerprint({ type: "x", examId: "e1", subject: "S", message: "M", uids: ["b", "a"] });
  assert.equal(a, C.campaignFingerprint({ type: "x", examId: "e1", subject: "S", message: "M", uids: ["a", "b"] }));
  assert.notEqual(a, C.campaignFingerprint({ type: "x", examId: "e1", subject: "S", message: "M", uids: ["a", "b", "c"] }));
  assert.notEqual(a, C.campaignFingerprint({ type: "x", examId: "e1", subject: "S2", message: "M", uids: ["a", "b"] }));
});
test("CSV cells that look like formulas are neutralised", () => {
  assert.equal(C.csvSafe("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(C.csvSafe("+1"), "'+1"); assert.equal(C.csvSafe("-1"), "'-1"); assert.equal(C.csvSafe("@a"), "'@a");
  assert.equal(C.csvSafe("Rahim"), "Rahim");
  const rows = C.campaignCsv({ name: "N", type: "announcement", subject: "S" }, [{ name: "=cmd", email: "a@b.co", status: "accepted" }]);
  assert.equal(rows[1][4], "'=cmd"); assert.equal(rows[1][7], "Request accepted");
});

/* ============================ render: markup & tokens ============================ */
test("raw HTML typed by the admin is escaped, not executed", () => {
  const html = R.blocksToHtml(R.parseBlocks('Hello <script>alert(1)</script> <b onclick="x">b</b>'), (s) => s);
  assert.ok(!/<script/i.test(html)); assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<b onclick"));
});
test("markup: bold, italic, bullets, numbered list, line breaks", () => {
  const h = R.blocksToHtml(R.parseBlocks("**Bold** and _italic_\nsecond line\n\n- one\n- two\n\n1. a\n2. b"), (s) => s);
  assert.ok(h.includes("<strong>Bold</strong>")); assert.ok(h.includes("<em>italic</em>")); assert.ok(h.includes("<br>"));
  assert.ok(h.includes("<ul")); assert.equal((h.match(/<li/g) || []).length, 4); assert.ok(h.includes("<ol"));
});
test("links: https and the trusted tokens work; javascript:, data: and tokens-in-URLs stay plain text", () => {
  const link = (md) => R.inlineToHtml(md);
  assert.ok(link("[ok](https://example.com/a?b=1&c=2)").includes('<a href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(link("[site]({{website_url}})").includes('href="{{website_url}}"'));
  assert.ok(link("[mail](mailto:{{support_email}})").includes('href="mailto:{{support_email}}"'));
  for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html;base64,AAAA)", "[x](https://a.com/{{student_name}})", "[x](//evil.com)", "[x](ftp://a.com)"]) assert.ok(!link(bad).includes("<a "), bad);
});
test("variables are inserted escaped — a hostile display name cannot become markup or a link", () => {
  const name = 'Rahim <img src=x onerror=alert(1)> [click](https://evil.example) **bold**';
  const v = vals({ student: C.normalizeStudent(user("h", { displayName: name })) });
  const out = R.renderEmail({ ...R.emptyContent(), subject: "Hi {{student_name}}", greeting: "Dear {{student_name}},", message: "Name: {{student_name}}", showStudentInfo: true, infoFields: ["name"] }, v, { lang: "en", site: SITE });
  assert.ok(!out.html.includes("<img src=x"), "no raw tag");
  assert.ok(!out.html.includes('href="https://evil.example'), "no link made from a name");
  assert.ok(!out.html.includes("<strong>bold</strong>"), "no markup made from a name");
  assert.ok(out.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/\n|\r/.test(out.subject));
});
test("a subject can never carry a header injection", () => {
  const out = R.renderEmail({ ...R.emptyContent(), subject: "Hello {{student_name}}", message: "x" }, vals({ student: C.normalizeStudent(user("h", { displayName: "A\r\nBcc: victim@x.com" })) }), { lang: "en", site: SITE });
  assert.ok(!/[\r\n]/.test(out.subject));
});
test("token scan finds unknown variables, uses with/without fallback, and required keys", () => {
  const s = R.scanTokens(["Hi {{student_name|Student}} {{ exam_date }} {{exam_date|soon}} {{studnt_name}} {{personal_message}}", "{{exam_title}}"]);
  assert.deepEqual([...s.unknown], ["studnt_name"]);
  assert.deepEqual(s.keys.get("exam_date"), { withFallback: 1, without: 1 });
  assert.deepEqual(R.requiredKeys(s).sort(), ["exam_date", "exam_title"], "optional personal_message and fully-fallbacked student_name are not required");
});
test("fallback text is used and escaped; unknown tokens are shown, flagged and escaped", () => {
  const acc = { missing: new Set(), unknown: new Set(), fallbackUsed: new Set() };
  const out = R.fillTokens("{{exam_date|<b>soon</b>}} {{nope|<i>}}", { exam_date: null }, { mode: "html", acc });
  assert.ok(out.includes("&lt;b&gt;soon&lt;/b&gt;")); assert.ok(!out.includes("<b>") && !out.includes("<i>"));
  assert.deepEqual([...acc.unknown], ["nope"]); assert.deepEqual([...acc.fallbackUsed], ["exam_date"]);
});
test("missing data: block/skip leave it empty and report it; fallback prints 'Not available'", () => {
  const content = { ...R.emptyContent(), subject: "S", message: "Roll: {{student_roll}}" };
  const v = vals({ student: C.normalizeStudent(user("n")) });
  const a = R.renderEmail(content, v, { lang: "en", policy: "block", site: SITE });
  assert.deepEqual(a.missing, ["student_roll"]);
  const b = R.renderEmail(content, v, { lang: "en", policy: "fallback", site: SITE });
  assert.ok(b.html.includes("Not available")); assert.deepEqual(b.missing, ["student_roll"]);
  const c = R.renderEmail({ ...content, message: "Roll: {{student_roll|—}}" }, v, { lang: "en", policy: "block", site: SITE });
  assert.deepEqual(c.missing, []); assert.deepEqual(c.fallbackUsed, ["student_roll"]);
});
test("an empty optional personal message leaves no empty paragraph behind", () => {
  const out = R.renderEmail({ ...R.emptyContent(), subject: "S", message: "Before\n\n{{personal_message}}\n\nAfter" }, vals({ campaign: {} }), { lang: "en", site: SITE });
  assert.equal((out.html.match(/<p style="margin:0 0 14px;font-size:15px/g) || []).length, 2);
  assert.deepEqual(out.missing, []);
});
test("student-info and exam panels list only data that exists", () => {
  const v = vals({ student: C.normalizeStudent(user("n")), exam: exam({ publishAt: null, closesAt: null }) });
  const out = R.renderEmail({ ...R.emptyContent(), subject: "S", message: "x", showStudentInfo: true, infoFields: ["name", "roll", "student_id", "course"], showExamDetails: true }, v, { lang: "en", site: SITE });
  assert.ok(out.html.includes("Student information")); assert.ok(!out.html.includes(">Roll<")); assert.ok(!out.html.includes("Student ID"));
  assert.ok(out.html.includes("Examination details")); assert.ok(!out.html.includes(">Date<")); assert.ok(out.html.includes("30 minutes"));
});

/* ============================ render: templates ============================ */
test("every built-in template renders cleanly in every language when the data exists", () => {
  for (const tpl of T.BUILTIN_TEMPLATES) {
    if (tpl.id === "custom") continue;
    for (const lang of ["en", "bn", "both"]) {
      const v = vals({ lang, campaign: { personalMessage: "Note", deadlineMs: T0 + 5 * H } });
      const out = R.renderEmail(T.contentFor(tpl, lang), v, { lang, site: SITE });
      assert.deepEqual(out.missing, [], `${tpl.id}/${lang} missing`);
      assert.deepEqual(out.unknown, [], `${tpl.id}/${lang} unknown`);
      assert.ok(out.subject.length > 3, `${tpl.id}/${lang} subject`);
      assert.ok(!/\{\{|\}\}/.test(out.html + out.text), `${tpl.id}/${lang} leftover braces`);
      assert.ok(out.sizeBytes < R.EMAILJS_REQUEST_LIMIT_BYTES / 2, `${tpl.id}/${lang} size ${out.sizeBytes}`);
    }
  }
});
test("the 'not attempted' template only claims what the records prove", () => {
  const out = R.renderEmail(T.contentFor(T.templateById("exam_not_attempted"), "en"), vals(), { lang: "en", site: SITE });
  assert.ok(out.text.includes("no submitted result has been recorded"));
  assert.ok(!/you did not (take|attempt)/i.test(out.text));
  assert.ok(!/refresh/i.test(out.text), "no invented exam rules");
});
test("a schedule-dependent template is blocked when the exam has no schedule (nothing invented)", () => {
  const v = vals({ exam: exam({ publishAt: null, closesAt: null }), classification: null });
  const content = { ...T.contentFor(T.templateById("deadline_reminder"), "en") };
  const out = R.renderEmail(content, v, { lang: "en", site: SITE });
  assert.deepEqual(out.missing, ["deadline"]);
});
test("the HTML is inline-styled, script-free and links only where intended", () => {
  const out = R.renderEmail(T.contentFor(T.templateById("exam_not_attempted"), "en"), vals(), { lang: "en", site: SITE, logoUrl: "https://tvsites.vercel.app/assets/email-logo.png" });
  assert.ok(!/<script/i.test(out.html)); assert.ok(!/javascript:/i.test(out.html));
  assert.ok(out.html.startsWith("<!DOCTYPE html>")); assert.ok(out.html.includes("max-width:600px"));
  assert.ok(out.html.includes('href="https://tvsites.vercel.app/#/exam?id=e1"'));
  assert.ok(out.html.includes('href="mailto:tv.support.info@gmail.com"'));
  assert.ok(out.html.includes('alt="Tech Verse Exam"'));
  const hrefs = [...out.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.every((h) => /^(https:\/\/tvsites\.vercel\.app|mailto:tv\.support\.info@gmail\.com)/.test(h)), hrefs.join(" "));
});
test("a button whose link has no value is reported, not rendered", () => {
  const v = vals({ site: { website: "", email: SITE.email } });
  const out = R.renderEmail({ ...R.emptyContent(), subject: "S", message: "x", ctaEnabled: true, ctaLabel: "Go", ctaUrl: "{{website_url}}" }, v, { lang: "en", site: { email: SITE.email } });
  assert.deepEqual(out.missing, ["website_url"]); assert.ok(!out.html.includes(">Go<"));
});
test("PRIVACY: one student's e-mail never contains another student's data", () => {
  const A = C.normalizeStudent(user("a", { displayName: "Alice Alpha", email: "alice@example.com", roll: "0001" }));
  const B = C.normalizeStudent(user("b", { displayName: "Bob Beta", email: "bob@example.com", roll: "0002" }));
  const content = T.contentFor(T.templateById("exam_not_attempted"), "en");
  const render = (s) => R.renderEmail(content, vals({ student: s }), { lang: "en", site: SITE });
  const a = render(A), b = render(B);
  for (const [out, own, other] of [[a, A, B], [b, B, A]]) {
    const blob = out.subject + out.html + out.text;
    assert.ok(blob.includes(own.name) && blob.includes(own.email) && blob.includes(own.roll));
    assert.ok(!blob.includes(other.name) && !blob.includes(other.email) && !blob.includes(`Roll</td><td`) === false || true);
    assert.ok(!blob.includes(other.email) && !blob.includes(other.name) && !blob.includes(other.roll), `${own.name}'s e-mail leaked ${other.name}`);
  }
});
test("EmailJS params: one recipient, every variable by name, nothing sensitive", () => {
  const v = vals();
  const rendered = R.renderEmail(T.contentFor(T.templateById("general"), "en"), v, { lang: "en", site: SITE });
  const p = R.buildEmailParams({ recipient: { email: "u1@example.com", name: "Student u1", uid: "SECRET-UID" }, rendered, values: v, sender: { name: "Tech Verse Exam", replyTo: SITE.email } });
  assert.equal(p.to_email, "u1@example.com"); assert.equal(p.reply_to, SITE.email); assert.equal(p.from_name, "Tech Verse Exam");
  assert.equal(p.html_body, rendered.html); assert.equal(p.message_text, rendered.text); assert.equal(p.subject, rendered.subject);
  for (const k of C.VARIABLE_KEYS) assert.ok(k in p, k);
  assert.equal(p.student_id, "");
  assert.ok(!JSON.stringify(p).includes("SECRET-UID"), "no internal ids");
  assert.ok(!/password|token|secret|apikey/i.test(Object.keys(p).join(",")));
  assert.ok(R.paramsSize(p) < R.EMAILJS_REQUEST_LIMIT_BYTES);
  assert.equal(R.buildEmailParams({ recipient: { email: "a@b.co", name: "x" }, rendered, values: v, sender: { name: "N\r\nBcc: x", replyTo: "not-an-email" } }).reply_to, "", "an invalid reply-to is dropped");
  assert.ok(!/[\r\n]/.test(R.buildEmailParams({ recipient: { email: "a@b.co", name: "x" }, rendered, values: v, sender: { name: "N\r\nBcc: x" } }).from_name));
});
test("test e-mails use clearly fake data, never a real student", () => {
  const v = R.sampleValues({ lang: "en", site: SITE, testEmail: "admin@example.com" });
  assert.equal(v.student_name, "Sample Student"); assert.equal(v.student_email, "admin@example.com");
  const out = R.renderEmail(T.contentFor(T.templateById("general"), "en"), v, { lang: "en", site: SITE });
  assert.ok(out.html.includes("Sample Student"));
});
test("bilingual content does not repeat the personal message", () => {
  const c = T.contentFor(T.templateById("general"), "both");
  assert.equal((c.message.match(/\{\{personal_message\}\}/g) || []).length, 1);
  assert.ok(c.subject.includes(" | ")); assert.ok(c.message.includes("Tech Verse Exam-এর পক্ষ থেকে"));
});

/* ============================ service: settings ============================ */
test("settings: incomplete / invalid configuration is reported; complete is accepted", () => {
  const empty = S.normalizeSettings({});
  assert.equal(S.isConfigured(empty), false);
  assert.deepEqual(S.settingsIssues(empty).filter((i) => i.required).map((i) => i.field).sort(), ["publicKey", "serviceId", "templateId"]);
  const ok = S.normalizeSettings({ serviceId: "service_abc123", templateId: "template_xyz789", publicKey: "AbC123dEf456GhI" });
  assert.equal(S.isConfigured(ok), true);
  assert.equal(S.isConfigured({ ...ok, serviceId: "has space" }), false);
  assert.equal(S.isConfigured({ ...ok, replyTo: "bad" }), false);
  assert.equal(S.isConfigured({ ...ok, timeZone: "Mars/Base" }), false);
});
test("settings: values are clamped (the 1 request/second limit can't be configured away)", () => {
  assert.equal(S.normalizeSettings({ intervalMs: 10 }).intervalMs, 1000);
  assert.equal(S.normalizeSettings({ intervalMs: 99999 }).intervalMs, 10000);
  assert.equal(S.normalizeSettings({ intervalMs: "junk" }).intervalMs, 1100);
  assert.equal(S.normalizeSettings({ safetyCap: -5 }).safetyCap, 0);
});
test("a test only counts for the exact configuration it ran with", () => {
  const base = S.normalizeSettings({ serviceId: "service_a", templateId: "template_b", publicKey: "keykeykey" });
  assert.equal(S.isTested(base), false);
  const tested = { ...base, lastTest: { ok: true, at: 1, fp: S.configFingerprint(base) } };
  assert.equal(S.isTested(tested), true);
  assert.equal(S.isTested({ ...tested, templateId: "template_other" }), false, "changing the template invalidates the test");
  assert.equal(S.isTested({ ...tested, lastTest: { ...tested.lastTest, ok: false } }), false);
});
test("the public key is masked for display", () => {
  assert.equal(S.maskKey(""), "");
  assert.ok(!S.maskKey("AbC123dEf456GhI").includes("123dEf456"));
  assert.ok(S.maskKey("AbC123dEf456GhI").startsWith("AbC"));
});

/* ============================ service: one request ============================ */
const fakeSdk = (impl) => ({ calls: [], send(...a) { this.calls.push(a); return impl(...a); } });
const CFG = S.normalizeSettings({ serviceId: "service_a", templateId: "template_b", publicKey: "keykeykey" });
test("sendOne: 200 means accepted — and uses the documented argument order", async () => {
  const sdk = fakeSdk(async () => ({ status: 200, text: "OK" }));
  const o = await S.sendOne(CFG, { to_email: "a@b.co" }, { sdk });
  assert.equal(o.ok, true); assert.equal(o.kind, "accepted");
  assert.deepEqual(sdk.calls[0], ["service_a", "template_b", { to_email: "a@b.co" }, { publicKey: "keykeykey" }]);
});
test("sendOne: an error answer is 'failed' (EmailJS refused it); no answer is 'uncertain'", async () => {
  const run = (impl) => S.sendOne(CFG, {}, { sdk: fakeSdk(impl), timeoutMs: 40 });
  const f400 = await run(async () => { throw { status: 400, text: "The Public Key is invalid" }; });
  assert.equal(f400.ok, false); assert.equal(f400.kind, "failed"); assert.equal(f400.status, 400); assert.match(f400.text, /Public Key/);
  const f429 = await run(async () => { throw { status: 429, text: "Too Many Requests" }; });
  assert.equal(f429.kind, "failed"); assert.equal(f429.rateLimited, true);
  const f403 = await run(async () => { throw { status: 403, text: "Forbidden" }; });
  assert.equal(f403.fatal, true);
  const f500 = await run(async () => { throw { status: 500, text: "Oops" }; });
  assert.equal(f500.kind, "failed"); assert.equal(f500.reason, "server");
  const net = await run(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(net.kind, "uncertain"); assert.equal(net.reason, "network");
  const hung = await run(() => new Promise(() => {}));
  assert.equal(hung.kind, "uncertain"); assert.equal(hung.reason, "timeout");
  const odd = await run(async () => ({ status: 302, text: "?" }));
  assert.equal(odd.ok, false);
});
test("explainOutcome gives a plain-language hint for every failure reason", () => {
  for (const reason of ["sdk", "rate_limited", "not_allowed", "server", "refused", "timeout", "network"]) assert.ok(S.explainOutcome({ ok: false, reason }).length > 10, reason);
  assert.equal(S.explainOutcome({ ok: true }), "");
});

/* ============================ service: the queue ============================ */
function harness() {
  let t = 1_000_000; const waits = []; const starts = []; let inflight = 0, maxInflight = 0;
  return {
    waits, starts, get maxInflight() { return maxInflight; },
    now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; },
    sender: (script = () => ({ ok: true, kind: "accepted", status: 200, text: "OK" })) => async (item) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight); starts.push({ id: item.id, at: t });
      await Promise.resolve(); inflight--;
      return script(item, starts.filter((s) => s.id === item.id).length);
    },
  };
}
const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `u${i}` }));
test("queue: strictly one at a time, in order, never closer together than the interval", async () => {
  const h = harness(); const done = [];
  const res = await S.runQueue({ items: items(5), send: h.sender(), intervalMs: 1100, now: h.now, sleep: h.sleep, onUpdate: (e) => e.type === "done" && done.push(e.item.id) });
  assert.equal(res.processed, 5); assert.equal(res.stopped, false); assert.equal(res.tripped, null);
  assert.deepEqual(done, ["u0", "u1", "u2", "u3", "u4"]);
  assert.equal(h.maxInflight, 1, "never two requests at once");
  for (let i = 1; i < h.starts.length; i++) assert.ok(h.starts[i].at - h.starts[i - 1].at >= 1100, `gap ${i}`);
});
test("queue: the interval can never go below EmailJS' 1 request per second", async () => {
  const h = harness();
  await S.runQueue({ items: items(3), send: h.sender(), intervalMs: 5, now: h.now, sleep: h.sleep });
  for (let i = 1; i < h.starts.length; i++) assert.ok(h.starts[i].at - h.starts[i - 1].at >= 1000);
});
test("queue: Stop is honoured before the next request; the rest stays pending", async () => {
  const h = harness(); let stop = false;
  const res = await S.runQueue({ items: items(6), send: h.sender(), now: h.now, sleep: h.sleep, shouldStop: () => stop, onUpdate: (e) => { if (e.type === "done" && e.index === 2) stop = true; } });
  assert.equal(res.processed, 3); assert.equal(res.stopped, true); assert.equal(res.remaining, 3);
});
test("queue: HTTP 429 is retried (the request was refused, so no duplicate) then succeeds", async () => {
  const h = harness();
  const send = h.sender((item, n) => (item.id === "u1" && n < 3 ? { ok: false, kind: "failed", status: 429, text: "Too Many Requests", rateLimited: true } : { ok: true, kind: "accepted", status: 200, text: "OK" }));
  const done = [];
  const res = await S.runQueue({ items: items(3), send, now: h.now, sleep: h.sleep, onUpdate: (e) => e.type === "done" && done.push([e.item.id, e.outcome.ok, e.tries]) });
  assert.equal(res.processed, 3);
  assert.deepEqual(done, [["u0", true, 1], ["u1", true, 3], ["u2", true, 1]]);
  assert.ok(h.waits.some((w) => w >= 2500), "backed off");
});
test("queue: a 429 that never clears ends as 'failed' after the retries — not an endless loop", async () => {
  const h = harness();
  const send = h.sender(() => ({ ok: false, kind: "failed", status: 429, text: "Too Many Requests", rateLimited: true }));
  const done = [];
  await S.runQueue({ items: items(1), send, now: h.now, sleep: h.sleep, maxRateRetries: 2, onUpdate: (e) => e.type === "done" && done.push(e) });
  assert.equal(done[0].tries, 3); assert.equal(done[0].outcome.ok, false);
});
test("queue: three identical failures in a row stop the run (a configuration problem, not bad luck)", async () => {
  const h = harness();
  const send = h.sender(() => ({ ok: false, kind: "failed", status: 400, text: "The service ID not found", reason: "refused" }));
  const res = await S.runQueue({ items: items(10), send, now: h.now, sleep: h.sleep });
  assert.equal(res.processed, 3); assert.equal(res.remaining, 7); assert.equal(res.tripped.status, 400);
});
test("queue: different failures do not trip it, and a success resets the streak", async () => {
  const h = harness();
  const plan = { u0: "a", u1: "b", u2: "a", u3: "ok", u4: "a", u5: "a", u6: "ok", u7: "a" };
  const script = (item) => (plan[item.id] === "ok" ? { ok: true, kind: "accepted", status: 200, text: "OK" } : { ok: false, kind: "failed", status: 400, text: plan[item.id], reason: "refused" });
  const res = await S.runQueue({ items: items(8), send: h.sender(script), now: h.now, sleep: h.sleep });
  assert.equal(res.tripped, null); assert.equal(res.processed, 8);
});
test("queue: a fatal answer (401/403) stops at once", async () => {
  const h = harness();
  const res = await S.runQueue({ items: items(5), send: h.sender(() => ({ ok: false, kind: "failed", status: 403, text: "Forbidden", fatal: true, reason: "not_allowed" })), now: h.now, sleep: h.sleep });
  assert.equal(res.processed, 1); assert.equal(res.tripped.reason, "not_allowed");
});
test("queue: an 'uncertain' outcome neither retries nor trips the breaker", async () => {
  const h = harness();
  const res = await S.runQueue({ items: items(5), send: h.sender(() => ({ ok: false, kind: "uncertain", status: 0, text: "Network", reason: "network" })), now: h.now, sleep: h.sleep });
  assert.equal(res.processed, 5); assert.equal(res.tripped, null);
});
test("RETRY: re-running only the failed rows never touches the accepted ones", async () => {
  const rows = items(6).map((r) => ({ ...r, status: "pending" }));
  const h = harness();
  const flaky = (item) => (["u1", "u4"].includes(item.id) ? { ok: false, kind: "failed", status: 500, text: "boom", reason: "server" } : { ok: true, kind: "accepted", status: 200, text: "OK" });
  const apply = (outcome, row) => { row.status = outcome.ok ? "accepted" : outcome.kind; };
  const sentFirst = [];
  await S.runQueue({ items: C.selectForRun(rows), send: h.sender(flaky), now: h.now, sleep: h.sleep, onUpdate: (e) => { if (e.type === "done") { apply(e.outcome, rows[e.index]); sentFirst.push(e.item.id); } } });
  assert.deepEqual(C.totalsOf(rows), { total: 6, pending: 0, sending: 0, accepted: 4, failed: 2, uncertain: 0, skipped: 0 });
  const again = []; const h2 = harness();
  const retryList = C.selectForRun(rows);
  await S.runQueue({ items: retryList, send: h2.sender(() => ({ ok: true, kind: "accepted", status: 200, text: "OK" })), now: h2.now, sleep: h2.sleep, onUpdate: (e) => { if (e.type === "done") { again.push(e.item.id); retryList[e.index].status = "accepted"; } } });
  assert.deepEqual(again, ["u1", "u4"], "only the failed ones were sent again");
  assert.equal(C.totalsOf(rows).accepted, 6);
});
test("estimateMs is honest about the 1 request/second limit", () => { assert.equal(S.estimateMs(100, 1100), 110000); assert.equal(S.estimateMs(10, 1), 10000); });

/* ============================ permissions ============================ */
import { setRole, can, ROLES, ROLE_ORDER } from "../../js/admin/core/permissions.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("only Super Admin and Manager may send e-mail; only Super Admin may change the EmailJS settings", () => {
  const can_ = (role, perm) => { setRole(role); return can(perm); };
  assert.equal(can_("super", "email.manage"), true); assert.equal(can_("super", "email.settings"), true);
  assert.equal(can_("manager", "email.manage"), true); assert.equal(can_("manager", "email.settings"), false);
  for (const role of ["editor", "viewer"]) { assert.equal(can_(role, "email.manage"), false, role); assert.equal(can_(role, "email.settings"), false, role); }
  assert.equal(can_("nonsense", "email.manage"), false, "an unknown role gets the least privilege");
  setRole("super");
  assert.deepEqual(ROLE_ORDER, Object.keys(ROLES));
});

/* ============================ wall-clock <-> instant ============================ */
test("a datetime-local value is read in the e-mail's time zone and survives a round trip", () => {
  const ms = C.zonedLocalToMs("2026-10-25T20:00", "Asia/Dhaka");
  assert.equal(new Date(ms).toISOString(), "2026-10-25T14:00:00.000Z");
  assert.equal(C.msToZonedLocal(ms, "Asia/Dhaka"), "2026-10-25T20:00");
  assert.equal(C.zonedLocalToMs("2026-10-25T20:00", "UTC"), Date.UTC(2026, 9, 25, 20, 0));
  assert.equal(C.zonedLocalToMs("", "Asia/Dhaka"), null);
  assert.equal(C.zonedLocalToMs("not a date", "Asia/Dhaka"), null);
  assert.equal(C.msToZonedLocal(NaN, "Asia/Dhaka"), "");
  assert.equal(C.zonedLocalToMs("2026-10-25T20:00", "Mars/Base") === null || Number.isFinite(C.zonedLocalToMs("2026-10-25T20:00", "Mars/Base")), true, "a bad zone never throws");
});

/* ============================ stored content is sanitised ============================ */
test("sanitizeContent keeps known fields only, caps lengths and validates the lists", () => {
  const c = R.sanitizeContent({ subject: "x".repeat(999), message: "m".repeat(99999), infoFields: ["name", "password", "roll"], showStudentInfo: "yes", ctaEnabled: 1, evil: "<script>", ctaUrl: "{{website_url}}" });
  assert.equal(c.subject.length, 200); assert.equal(c.message.length, 6000);
  assert.deepEqual(c.infoFields, ["name", "roll"]);
  assert.equal(c.showStudentInfo, true); assert.equal(c.ctaEnabled, false, "only a real boolean true enables it");
  assert.ok(!("evil" in c));
  assert.deepEqual(Object.keys(R.sanitizeContent(null)).sort(), Object.keys(R.emptyContent()).sort());
});

/* ============================ no secrets, pinned SDK, rules shape ============================ */
const sources = () => {
  const out = [];
  const walk = (dir) => { for (const f of readdirSync(join(ROOT, dir))) { const p = join(dir, f); if (statSync(join(ROOT, p)).isDirectory()) walk(p); else if (p.endsWith(".js")) out.push(p); } };
  walk("js/admin/email");
  out.push("js/email-core.js", "js/email-render.js", "js/email-service.js", "js/email-templates-data.js", "js/admin/email-center.js");
  return out;
};
test("PRIVATE CREDENTIALS: none of the Email Center sources contains a key, token, PEM block or service account", () => {
  const bad = [
    [/accessToken\s*[:=]/i, "EmailJS accessToken (private key)"], [/private_?key["']?\s*[:=]/i, "a privateKey assignment"], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
    [/"type"\s*:\s*"service_account"/, "a Firebase service-account JSON"], [/["'`]service_(?!x+["'`])[a-z0-9]{6,}["'`]/i, "a hard-coded EmailJS Service ID"], [/["'`]template_(?!x+["'`])[a-z0-9]{6,}["'`]/i, "a hard-coded EmailJS Template ID"],
    [/user_id\s*:\s*["'][A-Za-z0-9_-]{10,}/, "a hard-coded EmailJS user_id / public key"], [/AIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  ];
  for (const file of sources()) {
    const text = read(file);
    for (const [re, what] of bad) assert.equal(re.test(text), false, `${file} contains ${what}`);
  }
});
test("the EmailJS SDK is pinned to an exact version and called with the PUBLIC key only", () => {
  assert.match(S.SDK_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@emailjs\/browser@\d+\.\d+\.\d+\/dist\/email\.min\.js$/);
  assert.doesNotMatch(S.SDK_URL, /latest|@\d+\/|\^|~/);
  const svc = read("js/email-service.js");
  assert.match(svc, /api\.send\(settings\.serviceId, settings\.templateId, params, \{ publicKey: settings\.publicKey \}\)/);
  assert.doesNotMatch(svc, /accessToken\s*[:=]/);
  assert.doesNotMatch(svc, /privateKey\s*[:=]/);
});
test("the credentials live in Firestore (admin-readable), not in the repository", () => {
  const settingsView = read("js/admin/email/view-settings.js");
  assert.match(settingsView, /type="password"/, "the public key field is masked");
  assert.doesNotMatch(settingsView, /name="private|id="st-private|id="st-token/i);
  assert.match(read("js/admin/email/store.js"), /doc\(db, "emailSettings", "main"\)/);
});
test("firestore.rules: Email Center collections are admin-only and narrowly scoped", () => {
  const rules = read("firestore.rules");
  const block = rules.slice(rules.indexOf("Email Center"));
  assert.equal((rules.match(/\{/g) || []).length, (rules.match(/\}/g) || []).length, "balanced braces");
  for (const col of ["emailSettings", "emailTemplates", "emailCampaigns"]) assert.match(block, new RegExp(`match /${col}/`), col);
  assert.match(block, /match \/parts\/\{partId\}/);
  const settings = block.slice(block.indexOf("match /emailSettings"), block.indexOf("match /emailTemplates"));
  assert.match(settings, /allow create: if isSuperAdmin\(\)/);
  assert.match(settings, /hasOnly\(\['lastTest'\]\)/, "a Manager may only record the test result");
  assert.match(settings, /allow read: if canManageComms\(\)/);
  assert.doesNotMatch(block, /allow (read|write)[^;]*: if true/i);
  assert.doesNotMatch(block, /allow [a-z, ]*: if isSignedIn\(\);/, "no student-reachable rule");
  assert.match(block.slice(block.indexOf("match /emailCampaigns")), /createdBy\.uid == request\.auth\.uid/, "the author is the signed-in admin");
});
test("every Email Center action is in the audit catalogue", () => {
  const audit = read("js/admin/core/audit.js");
  for (const a of ["email.settings", "email.test", "email.template.create", "email.template.update", "email.template.delete", "email.campaign.draft", "email.campaign.start", "email.campaign.complete", "email.campaign.interrupt", "email.campaign.fail", "email.campaign.retry", "email.campaign.export"]) assert.match(audit, new RegExp(`"${a.replaceAll(".", "\\.")}"`), a);
  const emitted = new Set([...sources().map(read).join("\n").matchAll(/logAction\("(email\.[a-z.]+)"/g)].map((m) => m[1]));
  for (const a of emitted) assert.match(audit, new RegExp(`"${a.replaceAll(".", "\\.")}"`), `${a} is logged but not in the catalogue`);
});
