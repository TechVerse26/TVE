// Unit tests for the pure logic (no Firebase, no DOM). Run:  node --test tests/unit
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../../js/schedule-core.js";
import * as H from "../../js/home-core.js";

const T0 = Date.UTC(2026, 9, 5, 4, 0, 0); // 2026-10-05 04:00 UTC
const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
const exam = (o = {}) => ({ id: "e1", title: "T", examType: "live", duration: 20, questionCount: 10, publishAt: ts(T0 + 2 * S.HOUR), closesAt: ts(T0 + 5 * S.HOUR), ...o });

test("toMs handles Timestamp, {seconds}, Date, number, junk", () => {
  assert.equal(S.toMs(ts(5)), 5);
  assert.equal(S.toMs({ seconds: 2, nanoseconds: 5e6 }), 2005);
  assert.equal(S.toMs(new Date(9)), 9);
  assert.equal(S.toMs(7), 7);
  assert.equal(S.toMs(null), null);
  assert.equal(S.toMs("nope"), null);
});

test("window boundaries: start inclusive of open, end inclusive of open", () => {
  const e = exam();
  assert.equal(S.windowState(e, T0 + 2 * S.HOUR - 1), "upcoming");
  assert.equal(S.windowState(e, T0 + 2 * S.HOUR), "open");
  assert.equal(S.windowState(e, T0 + 5 * S.HOUR), "open");
  assert.equal(S.windowState(e, T0 + 5 * S.HOUR + 1), "closed");
});

test("practice exams ignore any leftover schedule", () => {
  const e = exam({ examType: "practice" });
  assert.equal(S.windowState(e, T0), "open");
  assert.equal(S.computeStatus(e, T0).key, "open");
});

test("status ladder: upcoming → soon → live → closed", () => {
  const e = exam();
  assert.equal(S.computeStatus(e, T0).key, "upcoming");
  assert.equal(S.computeStatus(e, T0 + 2 * S.HOUR - 30 * S.MINUTE).key, "soon");
  const live = S.computeStatus(e, T0 + 3 * S.HOUR);
  assert.equal(live.key, "live"); assert.equal(live.canStart, true); assert.equal(live.cta, "start");
  assert.equal(live.msToEnd, 2 * S.HOUR);
  assert.equal(S.computeStatus(e, T0 + 6 * S.HOUR).key, "closed");
});

test("completed vs closed depends on whether the student has a result", () => {
  const e = exam();
  assert.equal(S.computeStatus(e, T0 + 6 * S.HOUR, { hasResult: true }).key, "completed");
  assert.equal(S.computeStatus(e, T0 + 6 * S.HOUR, { hasResult: true }).cta, "result");
  assert.equal(S.computeStatus(e, T0 + 6 * S.HOUR, { hasResult: false }).cta, "none");
});

test("attempts exhausted → completed, no start; retake allowed when attempts remain", () => {
  const e = exam({ maxAttempts: 2 });
  const now = T0 + 3 * S.HOUR;
  assert.equal(S.computeStatus(e, now, { hasResult: true, attemptsUsed: 2 }).key, "completed");
  assert.equal(S.computeStatus(e, now, { hasResult: true, attemptsUsed: 2 }).canStart, false);
  const again = S.computeStatus(e, now, { hasResult: true, attemptsUsed: 1 });
  assert.equal(again.canStart, true); assert.equal(again.cta, "retake");
});

test("cancelled, registration closed, maintenance and disabled accounts", () => {
  const now = T0 + 3 * S.HOUR;
  assert.equal(S.computeStatus(exam({ cancelled: true }), now).key, "unavailable");
  assert.equal(S.computeStatus(exam({ cancelled: true }), T0).key, "unavailable");
  const rc = S.computeStatus(exam({ registration: "closed" }), now);
  assert.equal(rc.key, "closed"); assert.equal(rc.canStart, false); assert.equal(rc.reason, "registration-closed");
  const m = S.computeStatus(exam(), now, { maintenance: true });
  assert.equal(m.canStart, false); assert.equal(m.reason, "maintenance"); assert.equal(m.key, "live");
  assert.equal(S.computeStatus(exam(), now, { disabled: true }).canStart, false);
});

test("exam with no end is Available, not Live", () => {
  const e = exam({ closesAt: null });
  const st = S.computeStatus(e, T0 + 3 * S.HOUR);
  assert.equal(st.key, "open"); assert.equal(st.msToEnd, null);
});

test("registration closed does not affect practice", () => {
  assert.equal(S.computeStatus(exam({ examType: "practice", registration: "closed" }), T0).canStart, true);
});

test("countdown formatting", () => {
  const ms = ((2 * 24 + 5) * 60 * 60 + 32 * 60 + 18) * 1000;
  assert.deepEqual(S.countdownParts(ms).map((p) => p.value), ["02", "05", "32", "18"]);
  assert.equal(S.countdownShort(ms), "2d 5h");
  assert.equal(S.countdownShort(75 * S.MINUTE), "1h 15m");
  assert.equal(S.countdownShort(90 * 1000), "1m 30s");
  assert.equal(S.countdownShort(-5), "0s");
  assert.equal(S.humanizeBn(135 * S.MINUTE), "২ ঘণ্টা ১৫ মিনিট");
  assert.equal(S.humanizeBn(30 * 1000), "এক মিনিটেরও কম");
  assert.equal(S.toBnDigits("৩ 12"), "৩ ১২");
});

test("marks and pass mark", () => {
  const e = { questionCount: 40, questionsPerAttempt: 25, passPercent: 0 };
  assert.equal(S.getExamQuestionCount(e), 25);
  assert.equal(S.passPercentFor(e, 60), 60);
  assert.equal(S.passMarksFor(e, 60), 15);
  assert.equal(S.passPercentFor({ passPercent: 40 }, 60), 40);
  assert.equal(S.passMarksFor({ questionCount: 10, passPercent: 33 }, 60), 4); // ceil(3.3)
});

test("availabilityOf keeps the legacy shape", () => {
  const a = S.availabilityOf(exam(), T0);
  assert.equal(a.state, "upcoming"); assert.ok(a.publishAt instanceof Date); assert.ok(a.closesAt instanceof Date);
  assert.equal(S.availabilityOf(exam({ examType: "practice" }), T0).publishAt, null);
});

test("visibility: enrolment + unlisted", () => {
  assert.equal(S.isExamVisibleTo({ courseId: "" }, null), true);
  assert.equal(S.isExamVisibleTo({ courseId: "c1" }, { enrolledCourses: ["c1"] }), true);
  assert.equal(S.isExamVisibleTo({ courseId: "c1" }, { enrolledCourses: [] }), false);
  assert.equal(S.isListed({ visibility: "unlisted" }), false);
  assert.equal(S.isListed({}), true);
});

test("adminScheduleState", () => {
  assert.equal(S.adminScheduleState(exam({ status: "draft" }), T0), "draft");
  assert.equal(S.adminScheduleState(exam({ cancelled: true }), T0), "cancelled");
  assert.equal(S.adminScheduleState(exam(), T0), "scheduled");
  assert.equal(S.adminScheduleState(exam(), T0 + 3 * S.HOUR), "live");
  assert.equal(S.adminScheduleState(exam(), T0 + 9 * S.HOUR), "completed");
  assert.equal(S.adminScheduleState(exam({ examType: "practice" }), T0), "practice");
});

test("a device clock that is 3h wrong is corrected by the server offset", () => {
  const e = exam();
  const deviceNow = T0 + 3 * S.HOUR;          // device thinks the exam is live
  const offset = -3 * S.HOUR;                  // server says it is T0
  assert.equal(S.computeStatus(e, deviceNow).key, "live");
  assert.equal(S.computeStatus(e, deviceNow + offset).key, "upcoming");
});

/* ---------------- home-core ---------------- */
test("normalizeContent: defaults, clamping, bad input", () => {
  const c = H.normalizeContent(null);
  assert.equal(c.heroTitle, H.DEFAULT_CONTENT.heroTitle);
  assert.equal(c.sections.live, true);
  const d = H.normalizeContent({ heroTitle: "x".repeat(500), sections: { live: false, quick: "no" }, banner: { enabled: true, title: "B" }, leaderboardNames: "weird", guidelines: ["a", "", 5] });
  assert.equal(d.heroTitle.length, 120);
  assert.equal(d.sections.live, false); assert.equal(d.sections.quick, true);
  assert.equal(d.banner.enabled, true); assert.equal(d.leaderboardNames, "full"); assert.deepEqual(d.guidelines, ["a"]);
});

test("motivation: pinned wins, otherwise rotates by local day", () => {
  const pinned = H.normalizeContent({ motivation: { pinned: "Hi" } });
  assert.deepEqual(H.pickMotivation(pinned, T0), { text: "Hi", pinned: true });
  const rot = H.normalizeContent({ motivation: { rotation: ["a", "b", "c"] } });
  const d1 = H.pickMotivation(rot, T0).text, d2 = H.pickMotivation(rot, T0 + 24 * S.HOUR).text;
  assert.notEqual(d1, d2);
  assert.equal(H.pickMotivation(H.normalizeContent({}), T0).pinned, false);
});

test("safeHref blocks scripts", () => {
  assert.equal(H.safeHref("javascript:alert(1)"), "");
  assert.equal(H.safeHref("#/exams?type=practice"), "#/exams?type=practice");
  assert.equal(H.safeHref("https://example.com/a"), "https://example.com/a");
  assert.equal(H.safeHref("//evil.com"), "");
  assert.equal(H.safeHref("data:text/html,x"), "");
});

test("notice lifecycle + audience + ordering", () => {
  const now = T0;
  const mk = (o) => H.toMirrorNotice(o.id, { title: "t" + o.id, body: "b", priority: "normal", ...o });
  const list = [
    mk({ id: "1", priority: "normal", publishAt: ts(now - S.HOUR) }),
    mk({ id: "2", priority: "urgent", publishAt: ts(now - 2 * S.HOUR) }),
    mk({ id: "3", expiresAt: ts(now - 1) }),                           // expired
    mk({ id: "4", publishAt: ts(now + S.HOUR) }),                      // scheduled
    mk({ id: "5", audience: { type: "course", ids: ["cX"] } }),         // other course
    mk({ id: "6", audience: { type: "course", ids: ["c1"] }, priority: "important" }),
  ];
  const got = H.visibleNotices(list, { now, profile: { enrolledCourses: ["c1"] }, exams: [], categories: [] }).map((n) => n.id);
  assert.deepEqual(got, ["2", "6", "1"]);
  assert.equal(H.noticeState({ status: "draft" }, now), "draft");
  assert.equal(H.noticeState({ status: "published", expiresAt: ts(now + 5) }, now), "live");
  assert.equal(H.noticeState({ publishAt: ts(now + 5) }, now), "scheduled");
});

test("notice audience by exam / category (with sub-categories)", () => {
  const cats = [{ id: "c", parentId: null }, { id: "c2", parentId: "c" }];
  const exams = [{ id: "ex1", categoryId: "c2" }, { id: "ex2", courseId: "locked" }];
  const p = { enrolledCourses: [] };
  assert.equal(H.audienceMatches({ audience: { type: "category", ids: ["c"] } }, { profile: p, exams, categories: cats }), true);
  assert.equal(H.audienceMatches({ audience: { type: "exam", ids: ["ex2"] } }, { profile: p, exams, categories: cats }), false);
  assert.equal(H.audienceMatches({ audience: { type: "exam", ids: ["ex1"] } }, { profile: p, exams, categories: cats }), true);
});

test("hero numbers, next exam, live items, schedule grouping", () => {
  const now = T0 + 3 * S.HOUR;
  const exams = [
    exam({ id: "live", publishAt: ts(T0), closesAt: ts(T0 + 6 * S.HOUR) }),
    exam({ id: "soon", publishAt: ts(now + 30 * S.MINUTE), closesAt: ts(now + 4 * S.HOUR) }),
    exam({ id: "later", publishAt: ts(now + 3 * S.DAY), closesAt: null }),
    exam({ id: "prac", examType: "practice", publishAt: null, closesAt: null }),
    exam({ id: "done", publishAt: ts(T0 - S.DAY), closesAt: ts(T0 - S.DAY + S.HOUR) }),
    exam({ id: "cx", cancelled: true, publishAt: ts(now + S.DAY), closesAt: null }),
  ];
  const items = H.decorateAll(exams, now, {});
  const hn = H.heroNumbers(items, now);
  assert.equal(hn.live, 1); assert.equal(hn.upcoming, 2);
  assert.equal(H.nextExamItem(items).exam.id, "soon");
  assert.deepEqual(H.liveItems(items).map((i) => i.exam.id), ["live"]);
  const sched = H.scheduleItems(items, now).map((i) => i.exam.id);
  assert.deepEqual(sched, ["live", "soon", "cx", "later"]); // live first, then by start time; practice + finished excluded
  assert.ok(!sched.includes("prac")); assert.ok(!sched.includes("done"));
  assert.ok(H.scheduleItems(items, now, { includePast: true }).some((i) => i.exam.id === "done"));
  const g = H.groupByDay(H.scheduleItems(items, now), now);
  assert.ok(g.length >= 2);
});

test("filters and sorting", () => {
  const now = T0;
  const exams = [
    exam({ id: "a", title: "বাংলা মডেল টেস্ট", subjectId: "s1", categoryId: "k2", difficulty: "hard" }),
    exam({ id: "b", title: "English", examType: "practice", publishAt: null, closesAt: null, subjectId: "s2", difficulty: "easy" }),
    exam({ id: "c", title: "Math", publishAt: ts(T0 - S.DAY), closesAt: ts(T0 - S.HOUR) }),
  ];
  const items = H.decorateAll(exams, now, {});
  const cats = [{ id: "k1", parentId: null }, { id: "k2", parentId: "k1" }];
  assert.deepEqual(H.filterExams(items, { type: "practice" }, { categories: cats, now }).map((i) => i.exam.id), ["b"]);
  assert.deepEqual(H.filterExams(items, { q: "বাংলা" }, { categories: cats, now }).map((i) => i.exam.id), ["a"]);
  assert.deepEqual(H.filterExams(items, { category: "k1" }, { categories: cats, now }).map((i) => i.exam.id), ["a"]);
  assert.deepEqual(H.filterExams(items, { status: "upcoming" }, { categories: cats, now }).map((i) => i.exam.id), ["a"]);
  assert.deepEqual(H.filterExams(items, { status: "closed" }, { categories: cats, now }).map((i) => i.exam.id), ["c"]);
  assert.deepEqual(H.filterExams(items, { difficulty: "easy" }, { categories: cats, now }).map((i) => i.exam.id), ["b"]);
  assert.deepEqual(H.sortExams(items).map((i) => i.exam.id), ["a", "b", "c"]);
});

test("performance + rank + recent results", () => {
  const stats = { exams: {
    e1: { n: 3, s: 7, t: 10, p: 70, b: 90, at: 3000, ty: "live", ti: "One" },
    e2: { n: 1, s: 4, t: 10, p: 40, at: 2000, ty: "live", ti: "Two" },
    pr: { n: 5, s: 9, t: 10, p: 90, at: 1000, ty: "practice", ti: "Prac" },
  } };
  const p = H.performanceFromStats(stats, { examsById: { e2: { passPercent: 35 } }, defaultPass: 60 });
  assert.equal(p.taken, 3); assert.equal(p.liveTaken, 2); assert.equal(p.attempts, 9);
  assert.equal(p.avg, 65); assert.equal(p.best, 90); assert.equal(p.passRate, 100); assert.equal(p.ownLiveAvg, 65);
  assert.deepEqual(H.rankOf([90, 80, 65, 50], 65), { rank: 3, total: 4 });
  assert.equal(H.rankOf([90], 65), null);
  assert.equal(H.rankOf([90, 80], null), null);
  const rr = H.recentResultRows(stats, { limit: 2 });
  assert.deepEqual(rr.map((r) => r.examId), ["e1", "e2"]);
  assert.equal(rr[0].pass, true); assert.equal(rr[1].pass, false);
  assert.equal(H.performanceFromStats({ exams: {} }).passRate, null);
  assert.equal(H.performanceFromStats({ exams: { pr: stats.exams.pr } }).basis, "practice");
});

test("top performers honour the privacy mode", () => {
  const pub = { top: [{ n: "Rahim Uddin", p: 95, e: 4 }, { n: "Karim", p: 90, e: 3 }] };
  assert.equal(H.topPerformers(pub, "full")[0].name, "Rahim Uddin");
  assert.equal(H.topPerformers(pub, "first")[0].name, "Rahim U.");
  assert.equal(H.topPerformers(pub, "hidden")[1].name, "Student 2");
  assert.deepEqual(H.topPerformers({}, "full"), []);
  assert.equal(H.buildTopList([{ displayName: "A", avgPercent: 91.4, examsTaken: 2 }], 5)[0].p, 91);
  const rows = [{ displayName: "Rahim Uddin", avgPercent: 90, examsTaken: 1 }];
  assert.equal(H.buildTopList(rows, 5, "first")[0].n, "Rahim U.");
  assert.deepEqual(H.buildTopList(rows, 5, "hidden"), []);   // hidden = nothing published at all
  assert.equal(H.shortName("Rahim U."), "Rahim U.");        // idempotent
});

test("taxonomy rollups", () => {
  const tax = H.normalizeTaxonomy({ subjects: [{ id: "s1", name: "English" }, { id: "s2", name: "Math" }], categories: [{ id: "k1", name: "Model", parentId: null }, { id: "k2", name: "Set A", parentId: "k1" }] });
  const exams = [{ subjectId: "s1", categoryId: "k2" }, { subjectId: "s1" }];
  assert.deepEqual(H.subjectRollup(tax, exams), [{ id: "s1", name: "English", count: 2 }]);
  const cr = H.categoryRollup(tax, exams);
  assert.equal(cr.find((c) => c.id === "k1").count, 1);
  assert.equal(H.categoryPathOf(tax, "k2"), "Model › Set A");
});

/* ---------------- admin exam analytics ---------------- */
import * as A from "../../js/admin/core/exam-analytics.js";

test("exam summary: participants, completed, lowest, fail rate, abandoned", () => {
  const rows = [
    { uid: "a", percent: 90, attemptNumber: 2, timeTakenSeconds: 600 },
    { uid: "b", percent: 40, attempts: [{}, {}, {}], timeTakenSeconds: 300 },
    { uid: "c", percent: 60 },
  ];
  const s = A.examSummary({ rows, starts: [{ uid: "a", starts: 3 }, { uid: "b", starts: 3 }, { uid: "z", starts: 2 }], passPercent: 60 });
  assert.equal(s.participants, 3); assert.equal(s.completed, 2 + 3 + 1);
  assert.equal(s.highest, 90); assert.equal(s.lowest, 40); assert.equal(Math.round(s.avg), 63);
  assert.equal(Math.round(s.passRate), 67); assert.equal(Math.round(s.failRate), 33);
  assert.equal(s.avgTimeSeconds, 450);
  assert.equal(s.abandoned, 1 + 0 + 2);       // a: 3 starts vs 2 submitted · b: 3 vs 3 · z: started twice, never submitted
  assert.equal(s.startedStudents, 3);
  assert.equal(A.examSummary({ rows, starts: null }).abandoned, null);   // not tracked
  const empty = A.examSummary({ rows: [] });
  assert.equal(empty.avg, null); assert.equal(empty.passRate, null);
});

test("question-wise performance from stored reviews", () => {
  const rv = (text, selected) => ({ text, selected });
  const rows = [
    { uid: "a", attempts: [{ review: [rv("Q1", 1), rv("Q2", null)] }, { review: [rv("Q1", 2)] }] },
    { uid: "b", attempts: [{ review: [rv("Q1", 0), rv("Q3", null)] }, { review: null }] },
  ];
  const p = A.questionPerformance({ rows, questions: [{ text: "Q1" }, { text: "Q2" }, { text: "Q3" }, { text: "Q4" }] });
  assert.equal(p.base, 3);                                         // 3 attempts still carry a review
  assert.equal(p.mostDifficult[0].text, "Q1");                     // wrong in all 3
  assert.equal(p.mostIncorrect[0].text, "Q1");
  assert.deepEqual(p.mostSkipped.map((q) => q.text).sort(), ["Q2", "Q3"]);
  assert.equal(p.easiest[0].text, "Q4");                           // never wrong
  const pool = A.questionPerformance({ rows, questions: [{ text: "Q1" }], randomPool: true });
  assert.equal(pool.easiest.length, 0); assert.ok(pool.easiestNote);
  assert.equal(A.questionPerformance({ rows: [{ uid: "a", percent: 50 }] }).hasData, false);
});

/* ---------------- admin schedule editor logic ---------------- */
import * as SE from "../../js/admin/core/schedule-edit.js";

test("schedule validation", () => {
  const ok = { start: T0, end: T0 + S.HOUR, duration: 30, status: "published" };
  assert.deepEqual(SE.validateSchedule(ok, { questionCount: 5 }), []);
  assert.equal(SE.validateSchedule({ ...ok, end: T0 - 1 }, { questionCount: 5 }).length, 1);       // end before start
  assert.equal(SE.validateSchedule({ ...ok, start: null }, { questionCount: 5 }).length, 1);       // end without start
  assert.equal(SE.validateSchedule({ ...ok, duration: 0 }, { questionCount: 5 }).length, 1);
  assert.equal(SE.validateSchedule({ ...ok, duration: 601 }, { questionCount: 5 }).length, 1);
  assert.equal(SE.validateSchedule(ok, { questionCount: 0 }).length, 1);                           // publishing an empty exam
  assert.equal(SE.validateSchedule({ ...ok, status: "draft" }, { questionCount: 0 }).length, 0);
});

test("schedule patch: derived hours, defaults, 'schedule updated' stamping", () => {
  const prev = { publishAt: ts(T0), closesAt: ts(T0 + 2 * S.HOUR), duration: 20, status: "published" };
  const form = { start: T0 + S.HOUR, end: T0 + 3 * S.HOUR + 30 * S.MINUTE, duration: 20, status: "published", registration: "open", visibility: "public", remind: true, featured: true, difficulty: "hard" };
  const r = SE.buildSchedulePatch(prev, form, 777);
  assert.equal(r.patch.availableHours, 2.5);
  assert.deepEqual(r.changes, ["start", "end"]);
  assert.equal(r.stamped, true); assert.equal(r.patch.scheduleUpdatedAt, 777);
  assert.equal(r.patch.featured, true); assert.equal(r.patch.difficulty, "hard");
  // nothing time-related changed → not stamped
  const same = SE.buildSchedulePatch(prev, { ...form, start: T0, end: T0 + 2 * S.HOUR, featured: false }, 5);
  assert.equal(same.stamped, false); assert.equal("scheduleUpdatedAt" in same.patch, false);
  // first-time schedule (no previous start) → not stamped; drafts are invisible to students → not stamped
  assert.equal(SE.buildSchedulePatch({}, form, 5).stamped, false);
  assert.equal(SE.buildSchedulePatch({ ...prev, status: "draft" }, form, 5).stamped, false);
  // registration closing counts as a schedule change
  assert.equal(SE.buildSchedulePatch(prev, { ...form, start: T0, end: T0 + 2 * S.HOUR, registration: "closed" }, 5).stamped, true);
  // junk values fall back to safe defaults
  const junk = SE.buildSchedulePatch(prev, { ...form, registration: "x", visibility: "y", difficulty: "z", status: "?" }, 5).patch;
  assert.equal(junk.registration, "open"); assert.equal(junk.visibility, "public"); assert.equal(junk.difficulty, ""); assert.equal(junk.status, "published");
  assert.equal(SE.removeSchedulePatch().status, "draft");
  const fake = { fromMillis: (ms) => ({ ms }) };
  assert.deepEqual(SE.toFirestorePatch({ publishAt: 5, closesAt: null, duration: 3 }, fake), { publishAt: { ms: 5 }, closesAt: null, duration: 3 });
});

/* ---------------- firestore.rules ↔ schedule-core equivalence ----------------
   firestore.rules `examOpenForStudents` is hand-translated below (same operators, same defaults) and compared with the
   client's schedule-core on a grid of exams × moments, including the exact boundary milliseconds. */
function rulesOpen(ex, requestTime) {
  const get = (k, d) => (k in ex && ex[k] !== undefined ? ex[k] : d);
  const ms = (v) => (v === null || v === undefined ? null : S.toMs(v));
  const publishAt = get("publishAt", null), closesAt = get("closesAt", null);
  return get("status", "published") !== "draft"
    && get("cancelled", false) !== true
    && (get("examType", "live") === "practice"
      || (get("registration", "open") !== "closed"
        && (publishAt === null || ms(publishAt) <= requestTime)
        && (closesAt === null || ms(closesAt) >= requestTime)));
}

test("rules gate == client window logic (schedule part), boundaries included", () => {
  const base = { id: "e", examType: "live", duration: 10, questionCount: 5 };
  const variants = [
    {}, { status: "draft" }, { cancelled: true }, { registration: "closed" }, { examType: "practice", publishAt: ts(T0 + S.DAY), closesAt: ts(T0 - S.DAY) },
    { publishAt: ts(T0), closesAt: ts(T0 + S.HOUR) }, { publishAt: ts(T0 + S.HOUR) }, { closesAt: ts(T0 - 1) }, { publishAt: null, closesAt: null },
  ];
  const moments = [T0 - 1, T0, T0 + 1, T0 + S.HOUR - 1, T0 + S.HOUR, T0 + S.HOUR + 1, T0 + S.DAY];
  for (const v of variants) {
    for (const t of moments) {
      const e = { ...base, ...v };
      const st = S.computeStatus(e, t);
      const clientOpen = e.status !== "draft" && st.reason !== "upcoming" && st.reason !== "window-closed" && st.reason !== "cancelled" && st.reason !== "registration-closed";
      assert.equal(rulesOpen(e, t), clientOpen, `${JSON.stringify(v)} @ ${t - T0}`);
    }
  }
});

/* ---------------- calendar-day maths survives DST and any time zone ---------------- */
test("addDays / endOfDay land on local midnight (23h, 24h and 25h days)", () => {
  // Use whichever zone the test process runs in (CI runs this file under several TZ values).
  for (const [y, m, d] of [[2026, 2, 7], [2026, 2, 8], [2026, 9, 31], [2026, 10, 1], [2026, 5, 15]]) {
    const noon = new Date(y, m, d, 12, 0).getTime();
    const next = S.endOfDay(noon);
    const n = new Date(next);
    assert.equal(n.getHours(), 0); assert.equal(n.getMinutes(), 0);
    assert.equal(n.getDate(), new Date(y, m, d + 1).getDate());
    assert.equal(S.dayDiff(next, noon), 1);
    assert.equal(S.dayDiff(S.addDays(noon, -3), noon), -3);
    assert.equal(new Date(S.addDays(noon, 7)).getDate(), new Date(y, m, d + 7).getDate());
  }
});
