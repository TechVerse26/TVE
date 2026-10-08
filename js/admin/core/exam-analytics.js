// ==========================================================================
// admin/core/exam-analytics.js — the numbers behind "Exam analytics" (the per-exam statistics drawer).
// Pure functions: result documents (+ optional "started" counters, + optional question list) in, plain objects out.
//
// What each metric is based on (so the page can say it honestly):
//   participants / completed   result documents (a student appears once; every submitted attempt is "completed")
//   abandoned                  attempts a student STARTED but never submitted = examSessions.starts − submitted attempts.
//                              Tracked from the day this upgrade was published; null = not tracked (rules not published).
//   avg / highest / lowest     each student's LATEST attempt (same basis the drawer always used)
//   question-wise              attempts whose per-question review is still stored (48 h) — wrong answers and skips only,
//                              so the "easiest" list needs the exam's question list and a non-random exam.
// ==========================================================================

const num = (v) => Number(v) || 0;
export const attemptsOf = (r) => Math.max(num(r?.attemptNumber), Array.isArray(r?.attempts) ? r.attempts.length : 0, 1);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * @param {{rows:object[], starts:({uid:string,starts:number}[]|null), passPercent:number}} p
 */
export function examSummary({ rows, starts = null, passPercent = 60 }) {
  const pcts = rows.map((r) => num(r.percent));
  const times = rows.map((r) => num(r.timeTakenSeconds)).filter(Boolean);
  const attempts = rows.reduce((s, r) => s + attemptsOf(r), 0);
  const passed = pcts.filter((p) => p >= passPercent).length;

  let abandoned = null;
  let startedStudents = null;
  if (Array.isArray(starts)) {
    const done = new Map(rows.map((r) => [r.uid, attemptsOf(r)]));
    startedStudents = starts.length;
    abandoned = starts.reduce((s, x) => s + Math.max(0, num(x.starts) - (done.get(x.uid) || 0)), 0);
  }
  return {
    participants: rows.length,
    completed: attempts,
    abandoned,
    startedStudents,
    avg: rows.length ? avg(pcts) : null,
    highest: rows.length ? Math.max(...pcts) : null,
    lowest: rows.length ? Math.min(...pcts) : null,
    passRate: rows.length ? (passed / rows.length) * 100 : null,
    failRate: rows.length ? ((rows.length - passed) / rows.length) * 100 : null,
    avgTimeSeconds: times.length ? avg(times) : null,
    passPercent,
  };
}

/**
 * Per-question view from the reviews that are still stored.
 * @param {{rows:object[], questions?:{text:string}[]|null, randomPool?:boolean}} p
 * @returns {{base:number, hasData:boolean, items:object[], mostDifficult:object[], mostIncorrect:object[], mostSkipped:object[], easiest:object[], easiestNote:string}}
 */
export function questionPerformance({ rows, questions = null, randomPool = false }) {
  const byText = new Map(); // question text → { text, wrong, blank }
  let base = 0;            // attempts that still carry a review
  for (const r of rows) {
    const list = Array.isArray(r.attempts) && r.attempts.length ? r.attempts : [r];
    for (const a of list) {
      if (!Array.isArray(a.review)) continue;
      base++;
      for (const q of a.review) {
        if (!q || !q.text) continue;
        const cur = byText.get(q.text) || { text: q.text, wrong: 0, blank: 0 };
        cur.wrong++;
        if (q.selected === null || q.selected === undefined) cur.blank++;
        byText.set(q.text, cur);
      }
    }
  }
  const withRates = (o) => ({ ...o, answeredWrong: o.wrong - o.blank, wrongRate: base ? (o.wrong / base) * 100 : 0 });
  const seen = [...byText.values()].map(withRates);
  const top = (list, n = 5) => list.slice(0, n);

  const mostDifficult = top(seen.slice().sort((a, b) => b.wrongRate - a.wrongRate || b.wrong - a.wrong));
  const mostIncorrect = top(seen.filter((q) => q.answeredWrong > 0).sort((a, b) => b.answeredWrong - a.answeredWrong || b.wrong - a.wrong));
  const mostSkipped = top(seen.filter((q) => q.blank > 0).sort((a, b) => b.blank - a.blank || b.wrong - a.wrong));

  // "Easiest" needs every question (including the ones nobody got wrong) and a fixed question set.
  let easiest = [];
  let easiestNote = "";
  if (!base) easiestNote = "পর্যাপ্ত রিভিউ ডেটা নেই।";
  else if (randomPool) easiestNote = "র‍্যান্ডম প্রশ্ন-পুলের এক্সামে কোন প্রশ্ন কতবার এসেছে তা জানা যায় না, তাই সহজতম প্রশ্ন নির্ণয় করা যায়নি।";
  else if (!Array.isArray(questions) || !questions.length) easiestNote = "প্রশ্নের তালিকা লোড করা যায়নি।";
  else {
    easiest = top(questions
      .map((q) => withRates(byText.get(q.text) || { text: q.text, wrong: 0, blank: 0 }))
      .sort((a, b) => a.wrongRate - b.wrongRate || a.wrong - b.wrong));
  }
  return { base, hasData: base > 0, items: seen, mostDifficult, mostIncorrect, mostSkipped, easiest, easiestNote };
}
