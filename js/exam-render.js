// ==========================================================================
// exam-render.js — every piece of markup the exam section draws to the DOM.
// No Firestore calls here (exam-data.js), no scoring/shuffle rules here
// (exam-engine.js) — this file only turns fetched data into HTML.
// ==========================================================================
import { escapeHtml, formatScore, formatDuration, getExamAvailability, getExamBucket, formatDateTime, getExamQuestionCount } from "./utils.js";
import { fetchAllExams, fetchResult, checkExamVisibility } from "./exam-data.js";
import { startCountdowns } from "./exam-timer.js";
import { state } from "./exam-engine.js";

function lessonTagHtml(ex) {
  return ex.lessonNames?.length
    ? `<span class="exs-chip exs-chip-tag"><i class="fa-solid fa-list-check"></i> ${escapeHtml(ex.lessonNames.join(", "))}</span>`
    : "";
}

/* ---------- Small Live/Practice corner badge — shown on every exam card ---------- */
function typeBadgeHtml(ex) {
  return ex.examType === "practice"
    ? `<span class="exs-type-badge exs-type-badge--practice">Practice</span>`
    : `<span class="exs-type-badge exs-type-badge--live">Live</span>`;
}

/* ---------- Practice score history — a small pure-CSS sparkline ----------
   Only appears once there's an actual trend to show (2+ attempts). Bars are
   sized with a --pct custom property (same pattern as the result ring),
   the most recent attempt is highlighted, and each bar's title attribute
   gives the exact score on hover — no JS charting library involved. ---------- */
function practiceHistoryHtml(result) {
  const attempts = result?.attempts;
  if (!attempts || attempts.length < 2) return "";
  const recent = attempts.slice(-10);
  const best = Math.max(...attempts.map((a) => Number(a.percent) || 0));
  const bars = recent.map((a, i) => {
    const pct = Math.max(6, Math.round(Number(a.percent) || 0));
    const isLast = i === recent.length - 1;
    return `<div class="exs-spark-bar${isLast ? " is-latest" : ""}" style="--pct:${pct}" title="অ্যাটেম্পট ${attempts.length - recent.length + i + 1}: ${formatScore(a.score)}/${a.total} (${Math.round(Number(a.percent) || 0)}%)"></div>`;
  }).join("");
  return `
    <div class="exs-spark">
      <div class="exs-spark-head">
        <span class="exs-spark-label"><i class="fa-solid fa-chart-line"></i>Total Refusals ${attempts.length} </span>
        <span class="exs-spark-best">your activity ${Math.round(best)}%</span>
      </div>
      <div class="exs-spark-bars">${bars}</div>
    </div>`;
}

export function setExamSectionHeader({ title, sub, showBack, backHref }) {
  const titleEl = document.getElementById("exam-section-title");
  const subEl = document.getElementById("exam-section-sub");
  const backBtn = document.getElementById("exam-back-btn");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub || "";
  if (backBtn) {
    backBtn.classList.toggle("hidden", !showBack);
    backBtn.dataset.href = backHref || "#/exam";
  }
}

function groupExamsByCourse(exams) {
  const groups = new Map();
  for (const ex of exams) {
    const key = ex.courseId || "general";
    if (!groups.has(key)) groups.set(key, { key, courseId: ex.courseId || null, courseName: ex.courseName || "General", exams: [] });
    groups.get(key).exams.push(ex);
  }
  return groups;
}

/* ---------- Course picker — landing view ----------
   Only shows a course card if the student can actually see at least one of
   its exams (enrolled in that course, or the exam has no course at all).
   Unenrolled courses' exam groups are skipped entirely — not shown as
   locked, just absent. ---------- */
export async function renderExamCourseList(grid) {
  setExamSectionHeader({ title: "Take the Test & Evaluate Yourself", sub: "Choose Your Course & Explore All Exams", showBack: false });
  grid.classList.add("exam-grid--courses");
  grid.innerHTML = `<div class="exs-loading"><span class="exs-spinner"></span>Possessing...</div>`;
  const myToken = state.navToken;
  try {
    const exams = await fetchAllExams();
    if (state.navToken !== myToken) return;
    if (!exams.length) {
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>No Exams Available Yet</p></div>`;
      return;
    }
    const groups = groupExamsByCourse(exams);
    const results = await Promise.all(
      Array.from(groups.values()).map(async (g) => {
        const info = g.courseId ? await checkExamVisibility(g.courseId, state.userProfile) : { visible: true };
        if (!info.visible) return null;

        const total = g.exams.length;
        let openCount = 0, upcomingCount = 0;
        g.exams.forEach((ex) => {
          const { state: availState } = getExamAvailability(ex);
          if (availState === "open") openCount++;
          else if (availState === "upcoming") upcomingCount++;
        });

        const title = g.courseId ? (info.title || g.courseName) : "Genarel Exam";
        const cover = g.courseId ? info.coverImage || "" : "";
        const latestCreated = Math.max(0, ...g.exams.map((ex) => ex.createdAt?.seconds || 0));

        const html = `
        <a href="#/exam?course=${encodeURIComponent(g.key)}" class="exs-course-card">
          <div class="exs-course-cover" ${cover ? `style="background-image:url('${cover}')"` : ""}>
            ${!cover ? `<i class="fa-solid ${g.courseId ? "fa-graduation-cap" : "fa-layer-group"}"></i>` : ""}
          </div>
          <div class="exs-course-body">
            <h3>${escapeHtml(title)}</h3>
            <div class="exs-meta-row">
              <span><i class="fa-solid fa-file-pen"></i> ${total} Exams</span>
              ${openCount > 0 ? `<span class="exs-course-open-tag"><i class="fa-solid fa-circle-check"></i> ${openCount} Exams Available</span>`
                : upcomingCount > 0 ? `<span class="exs-muted exs-small"><i class="fa-solid fa-hourglass-half"></i> ${upcomingCount} Upcoming Exams</span>` : ""}
            </div>
          </div>
          <i class="fa-solid fa-chevron-right exs-course-arrow"></i>
        </a>`;
        return { html, sortKey: latestCreated };
      })
    );
    if (state.navToken !== myToken) return;
    const cards = results.filter(Boolean);
    if (!cards.length) {
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>No Exams Yet — Exams from your enrolled courses will appear here.</p></div>`;
      return;
    }
    cards.sort((a, b) => b.sortKey - a.sortKey);
    grid.innerHTML = cards.map((c) => c.html).join("");
  } catch {
    if (state.navToken !== myToken) return;
    grid.innerHTML = `<div class="exs-empty"><p>No Exams loading</p></div>`;
  }
}

/* ---------- Course hub — landing page for one course's exams ----------
   Shown right after picking a course: three buttons (Upcoming / Live /
   Practice) instead of dumping every exam — upcoming and live exams no
   longer get mixed together in one list. ---------- */
const HUB_TABS = [
  { key: "upcoming", label: "Upcoming", sub: "Upcoming Live Exams", icon: "fa-hourglass-half" },
  { key: "live", label: "Live", sub: "Active Live Exams", icon: "fa-satellite-dish" },
  { key: "practice", label: "Practice", sub: "Practice Exams", icon: "fa-dumbbell" },
];

export async function renderExamCourseHub(grid, courseKey) {
  grid.classList.remove("exam-grid--courses");
  grid.innerHTML = `<div class="exs-loading"><span class="exs-spinner"></span> Loading...</div>`;
  const myToken = state.navToken;
  try {
    if (courseKey !== "general") {
      const info = await checkExamVisibility(courseKey, state.userProfile);
      if (state.navToken !== myToken) return;
      if (!info.visible) {
        setExamSectionHeader({ title: "No Course Enrolled yet", sub: "", showBack: true, backHref: "#/exam" });
        grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-lock"></i><p>You’re Not Enrolled in This Course Yet</p></div>`;
        return;
      }
    }

    const allExams = await fetchAllExams();
    if (state.navToken !== myToken) return;
    const exams = allExams.filter((ex) => (ex.courseId || "general") === courseKey);

    let title = "Course Exams";
    if (courseKey === "general") title = "Genarel Exam";
    else {
      const info = await checkExamVisibility(courseKey, state.userProfile);
      title = info.title || exams[0]?.courseName || "কোর্সের এক্সাম";
    }
    setExamSectionHeader({ title, sub: exams.length ? ` ${exams.length} Exams Available` : "No Exams Available Yet", showBack: true, backHref: "#/exam" });

    if (!exams.length) {
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>No Exams Available for This Course Yet</p></div>`;
      return;
    }

    const counts = { upcoming: 0, live: 0, practice: 0 };
    exams.forEach((ex) => { counts[getExamBucket(ex)]++; });

    grid.classList.add("exs-hub-grid");
    grid.innerHTML = HUB_TABS.map((tab) => `
      <a href="#/exam?course=${encodeURIComponent(courseKey)}&type=${tab.key}" class="exs-hub-btn exs-hub-btn--${tab.key}">
        <div class="exs-hub-icon"><i class="fa-solid ${tab.icon}"></i></div>
        <div class="exs-hub-body">
          <h3>${tab.label}</h3>
          <p>${tab.sub}</p>
        </div>
        <span class="exs-hub-count">${counts[tab.key]}</span>
        <i class="fa-solid fa-chevron-right exs-hub-arrow"></i>
      </a>`).join("");
  } catch {
    if (state.navToken !== myToken) return;
    grid.innerHTML = `<div class="exs-empty"><p>Unable to Load Exams</p></div>`;
  }
}

/* ---------- Exam list — one course's exams, filtered to one bucket ----------
   Re-checks visibility itself (not just trusting the hub), so a direct
   #/exam?course=xxx&type=yyy URL to a course the student isn't enrolled in
   shows nothing rather than leaking the exam list. ---------- */
export async function renderExamList(grid, courseKey = null, bucketKey = null) {
  grid.classList.remove("exam-grid--courses");
  grid.innerHTML = `<div class="exs-loading"><span class="exs-spinner"></span> loading...</div>`;
  const myToken = state.navToken;
  const backHref = courseKey ? `#/exam?course=${encodeURIComponent(courseKey)}` : "#/exam";
  const hubTab = HUB_TABS.find((t) => t.key === bucketKey);
  try {
    if (courseKey && courseKey !== "general") {
      const info = await checkExamVisibility(courseKey, state.userProfile);
      if (state.navToken !== myToken) return;
      if (!info.visible) {
        setExamSectionHeader({ title: "No Course Found", sub: "", showBack: true, backHref: "#/exam" });
        grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-lock"></i><p>You’re Not Enrolled in This Course.Enroll in this course to access its exams and learning materials.</p></div>`;
        return;
      }
    }

    const allExams = await fetchAllExams();
    if (state.navToken !== myToken) return;
    let exams = courseKey ? allExams.filter((ex) => (ex.courseId || "general") === courseKey) : allExams;
    if (bucketKey) exams = exams.filter((ex) => getExamBucket(ex) === bucketKey);

    if (courseKey) {
      let title = hubTab ? hubTab.label : "Course Exams";
      if (courseKey === "general" && !hubTab) title = "Genarel Exams";
      setExamSectionHeader({ title, sub: exams.length ? `${exams.length} Exams Available for This Course` : "No Exams Available for This Course Yet", showBack: true, backHref });
    }

    if (!exams.length) {
      const emptyMsg = bucketKey === "practice" ? "No Practice Exams Available Yet "
        : bucketKey === "upcoming" ? "No Exams"
        : bucketKey === "live" ? "No Upcoming Exams at the Moment"
        : "No Exams Available for This Course Yet";
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>${emptyMsg}</p></div>`;
      return;
    }

    const cards = (await Promise.all(exams.map(async (ex) => {
      const { visible } = await checkExamVisibility(ex.courseId, state.userProfile);
      if (!visible) return "";

      const { state: availState, publishAt, closesAt } = getExamAvailability(ex);
      if (availState === "upcoming") {
        return `
        <div class="exs-card exs-card--locked">
          <div class="exs-type-row">${typeBadgeHtml(ex)}</div>
          <div class="exs-card-top">
            <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
            <span class="exs-countdown" data-countdown="${publishAt.getTime()}"><i class="fa-solid fa-hourglass-half"></i> <span class="countdown-val">...</span></span>
          </div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} Minute</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
          </div>
          <span class="exs-tag exs-tag--amber"><i class="fa-solid fa-lock"></i> Starts Soon ${formatDateTime(publishAt)}</span>
        </div>`;
      }

      const result = await fetchResult(state.currentUser.uid, ex.id);
      const maxAttempts = Number(ex.maxAttempts || 0);
      const attemptsUsed = maxAttempts > 0 ? Number(result?.attemptNumber || 0) : 0;
      const attemptsExhausted = maxAttempts > 0 && attemptsUsed >= maxAttempts;
      const attemptsMeta = maxAttempts > 0
        ? `<span><i class="fa-solid fa-rotate"></i> Attempts ${attemptsUsed}/${maxAttempts}</span>`
        : `<span><i class="fa-solid fa-infinity"></i> Unlimited Attempts</span>`;

      if (availState === "closed") {
        return `
        <div class="exs-card exs-card--locked">
          <div class="exs-type-row">${typeBadgeHtml(ex)}</div>
          <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} Minute</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} Questions</span>
          </div>
          ${result ? `<span class="exs-tag exs-tag--amber">Last Score ${formatScore(result.score)}/${result.total}</span>` : ""}
          <span class="exs-tag exs-tag--coral"><i class="fa-solid fa-stopwatch"></i> Exam Closed (${formatDateTime(closesAt)} Ended)</span>
        </div>`;
      }

      if (attemptsExhausted) {
        return `
        <div class="exs-card exs-card--locked">
          <div class="exs-type-row">${typeBadgeHtml(ex)}</div>
          <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} Minute</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
          </div>
          ${result ? `<span class="exs-tag exs-tag--amber">Last Score${formatScore(result.score)}/${result.total}</span>` : ""}
          <span class="exs-tag exs-tag--coral"><i class="fa-solid fa-ban"></i> You’ve Already Attempted This Exam</span>
          ${ex.examType === "practice" ? practiceHistoryHtml(result) : ""}
        </div>`;
      }

      return `
      <div class="exs-card">
        <div class="exs-type-row">${typeBadgeHtml(ex)}</div>
        <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
        <h3>${escapeHtml(ex.title)}</h3>
        <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
        <div class="exs-meta-row">
          <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} Minute</span>
          <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} Questions</span>
        </div>
        <div class="exs-meta-row">${attemptsMeta}</div>
        ${result ? `<span class="exs-tag exs-tag--amber">Last Score ${formatScore(result.score)}/${result.total}</span>` : ""}
        ${closesAt ? `<span class="exs-muted exs-small">${formatDateTime(closesAt)} Ended</span>` : ""}
        ${ex.examType === "practice" ? practiceHistoryHtml(result) : ""}
        <a href="#/exam?id=${ex.id}" class="btn btn-primary btn-block">${result ? "Retake Exam" : "Start Exam"}</a>
      </div>`;
    }))).filter(Boolean);

    if (state.navToken !== myToken) return;
    grid.innerHTML = cards.length ? cards.join("") : `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>No Exams Available</p></div>`;
    startCountdowns(grid);
  } catch {
    if (state.navToken !== myToken) return;
    grid.innerHTML = `<div class="exs-empty"><p>Unable to Load Exams</p></div>`;
  }
}

function renderOptionsHtml(q) {
  const isLocked = state.lockedQuestions.has(q.id);
  return `
    <div class="exs-options ${isLocked ? "is-locked" : ""}" data-qid="${q.id}">
      ${q.options.map((opt, i) => `
        <div class="exs-option ${state.answers[q.id] === i ? "is-selected" : ""} ${isLocked ? "is-disabled" : ""}" data-qid="${q.id}" data-i="${i}">
          <span class="exs-option-letter">${String.fromCharCode(65 + i)}</span>
          <span class="exs-option-text">${escapeHtml(opt)}</span>
          ${state.answers[q.id] === i && isLocked ? '<i class="fa-solid fa-lock exs-option-lock"></i>' : ""}
        </div>`).join("")}
    </div>
    ${isLocked ? `<div class="exs-locked-hint"><i class="fa-solid fa-circle-info"></i> Displaying Your Answer </div>` : ""}`;
}

function bindOptionClicks(container, onAfterLock) {
  container.querySelectorAll(".exs-option").forEach((el) => {
    el.addEventListener("click", () => {
      const qid = el.dataset.qid;
      if (state.lockedQuestions.has(qid)) return;
      state.answers[qid] = Number(el.dataset.i);
      state.lockedQuestions.add(qid);
      onAfterLock();
    });
  });
}

export function renderQuestion(refs) {
  const q = state.questions[state.currentIndex];
  refs.progressFill.style.width = `${((state.currentIndex + 1) / state.questions.length) * 100}%`;
  refs.questionArea.innerHTML = `
    <div class="exs-question-card">
      <div class="exs-q-index">প্রশ্ন ${state.currentIndex + 1} / ${state.questions.length}</div>
      <h2>${escapeHtml(q.text)}</h2>
      ${renderOptionsHtml(q)}
    </div>`;
  bindOptionClicks(refs.questionArea, () => renderQuestion(refs));
  const isLast = state.currentIndex === state.questions.length - 1;
  refs.prevBtn.disabled = state.currentIndex === 0;
  refs.nextBtn.classList.toggle("hidden", isLast);
  refs.submitBtn.classList.toggle("hidden", !isLast);
}

export function renderAllQuestions(refs) {
  refs.questionArea.innerHTML = state.questions.map((q, i) => `
    <div class="exs-question-card exs-mb">
      <div class="exs-q-index">Question ${i + 1} / ${state.questions.length}</div>
      <h2>${escapeHtml(q.text)}</h2>
      ${renderOptionsHtml(q)}
    </div>`).join("");
  bindOptionClicks(refs.questionArea, () => renderAllQuestions(refs));
}

/* ---------- Post-submit review — only the questions the student actually
   got wrong (or left unanswered). Showing the full question bank here used
   to be the main reason this screen felt slow on a big exam: hundreds of
   `.exs-review-item` cards landing in the DOM at once. Correct answers
   don't need reviewing, so they're simply never rendered — the list stays
   small no matter how large the exam was. This mirrors what actually gets
   saved (see reviewSnapshot in exam.js) and what it's kept for: 48 hours,
   after which "আমার ফলাফল" stops offering it (see isReviewExpired in
   exam-data.js). ---------- */
function renderReviewListHtml(questions, answers) {
  const wrongOnes = questions
    .map((q, i) => ({ q, i, userAns: answers[q.id] }))
    .filter(({ q, userAns }) => userAns !== q.correctIndex);

  if (!wrongOnes.length) {
    return `
      <div class="exs-review-list">
        <div class="exs-empty"><i class="fa-solid fa-champagne-glasses"></i><p>অভিনন্দন! আপনি সব প্রশ্নের সঠিক উত্তর দিয়েছেন — রিভিউ করার মতো কিছু নেই।</p></div>
      </div>`;
  }

  return `
    <p class="exs-muted exs-small exs-review-note"><i class="fa-solid fa-circle-info"></i> নিচে শুধু আপনার ভুল করা প্রশ্নগুলো দেখানো হচ্ছে, এবং এগুলো এই পরীক্ষার ফলাফলে <b>৪৮ ঘণ্টা</b> পর্যন্ত দেখা যাবে।</p>
    <div class="exs-review-list">
      ${wrongOnes.map(({ q, i, userAns }) => `
        <div class="exs-review-item">
          <div class="exs-review-q">${i + 1}. ${escapeHtml(q.text)}</div>
          <div class="exs-review-answer is-wrong">
            <i class="fa-solid fa-xmark"></i> আপনার উত্তর: ${userAns !== undefined && userAns !== null ? escapeHtml(q.options[userAns]) : "উত্তর দেওয়া হয়নি"}
          </div>
          <div class="exs-review-answer is-correct"><i class="fa-solid fa-check"></i> সঠিক উত্তর: ${escapeHtml(q.options[q.correctIndex])}</div>
          ${q.explanation && q.explanation.trim() ? `<div class="exs-review-explain"><i class="fa-solid fa-lightbulb"></i><span><b>ব্যাখ্যা:</b> ${escapeHtml(q.explanation)}</span></div>` : ""}
        </div>`).join("")}
    </div>`;
}

export function renderResult(resultView, { score, total, percent, examTitle, breakdown }) {
  const { correctCount = 0, wrongCount = 0, unansweredCount = 0, negativeMarking = 0, timeTakenSeconds = 0 } = breakdown;
  resultView.innerHTML = `
    <div class="exs-result-hero" id="exs-print-area">
      <div class="exs-print-head">
        <div class="exs-print-title">Tech Verse Exam — Result</div>
        <div class="exs-print-sub">${escapeHtml(state.currentUser?.displayName || state.currentUser?.email || "")} · ${new Date().toLocaleString()}</div>
      </div>
      <div class="exs-result-ring" style="--pct:${percent}"><b>${percent}%</b></div>
      <h2>${percent >= 60 ? "চমৎকার! 🎉" : "আরেকটু চর্চা করলেই ভালো ফল হবে 💪"}</h2>
      <p class="exs-muted exs-mt-8">আপনার স্কোর: <b>${formatScore(score)} / ${total}</b></p>
      <div class="exs-result-badges">
        <span class="exs-tag exs-tag--teal"><i class="fa-solid fa-check"></i> সঠিক: ${correctCount}</span>
        <span class="exs-tag exs-tag--coral"><i class="fa-solid fa-xmark"></i> ভুল: ${wrongCount}</span>
        <span class="exs-tag exs-tag--amber"><i class="fa-solid fa-circle-minus"></i> উত্তর দেওয়া হয়নি: ${unansweredCount}</span>
        <span class="exs-tag exs-tag--amber"><i class="fa-solid fa-stopwatch"></i> সময় লেগেছে: ${formatDuration(timeTakenSeconds)}</span>
      </div>
      ${negativeMarking > 0 ? `<p class="exs-muted exs-small exs-mt-8"><i class="fa-solid fa-circle-info"></i> এই এক্সামে নেগেটিভ মার্কিং সক্রিয় ছিল — প্রতিটি ভুল উত্তরে ${formatScore(negativeMarking)} নম্বর কাটা হয়েছে</p>` : ""}
      <div class="exs-result-actions exs-no-print">
        <a href="#/exam?course=${encodeURIComponent(state.exam?.courseId || "general")}" class="exs-action-box"><i class="fa-solid fa-list"></i><span>কোর্সের এক্সাম</span></a>
        <a href="#/exam?id=${state.examId}" class="exs-action-box exs-action-box--primary"><i class="fa-solid fa-rotate-right"></i><span>আবার দিন</span></a>
        <button type="button" class="exs-action-box exs-action-box--teal" id="exs-print-result"><i class="fa-solid fa-print"></i><span>PDF / প্রিন্ট</span></button>
      </div>
    </div>
    ${renderReviewListHtml(state.questions, state.answers)}`;

  resultView.querySelector("#exs-print-result")?.addEventListener("click", () => window.print());
}
