// ==========================================================================
// exam-render.js — every piece of markup the exam section draws to the DOM.
// No Firestore calls here (exam-data.js), no scoring/shuffle rules here
// (exam-engine.js) — this file only turns fetched data into HTML.
// ==========================================================================
import { escapeHtml, formatScore, formatDuration, getExamAvailability, formatDateTime, getExamQuestionCount } from "./utils.js";
import { fetchAllExams, fetchResult, checkExamVisibility } from "./exam-data.js";
import { startCountdowns } from "./exam-timer.js";
import { state } from "./exam-engine.js";

function lessonTagHtml(ex) {
  return ex.lessonNames?.length
    ? `<span class="exs-chip exs-chip-tag"><i class="fa-solid fa-list-check"></i> ${escapeHtml(ex.lessonNames.join(", "))}</span>`
    : "";
}

export function setExamSectionHeader({ title, sub, showBack }) {
  const titleEl = document.getElementById("exam-section-title");
  const subEl = document.getElementById("exam-section-sub");
  const backBtn = document.getElementById("exam-back-btn");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub || "";
  if (backBtn) backBtn.classList.toggle("hidden", !showBack);
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
  setExamSectionHeader({ title: "নিজেকে যাচাই করুন", sub: "আপনার কোর্স বেছে নিন, তারপর সেই কোর্সের সব এক্সাম দেখুন", showBack: false });
  grid.classList.add("exam-grid--courses");
  grid.innerHTML = `<div class="exs-loading"><span class="exs-spinner"></span> লোড হচ্ছে...</div>`;
  const myToken = state.navToken;
  try {
    const exams = await fetchAllExams();
    if (state.navToken !== myToken) return;
    if (!exams.length) {
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এখনো কোনো এক্সাম যোগ করা হয়নি</p></div>`;
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

        const title = g.courseId ? (info.title || g.courseName) : "সাধারণ এক্সাম (সবার জন্য)";
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
              <span><i class="fa-solid fa-file-pen"></i> ${total} টি এক্সাম</span>
              ${openCount > 0 ? `<span class="exs-course-open-tag"><i class="fa-solid fa-circle-check"></i> ${openCount} টি চালু আছে</span>`
                : upcomingCount > 0 ? `<span class="exs-muted exs-small"><i class="fa-solid fa-hourglass-half"></i> ${upcomingCount} টি আসছে</span>` : ""}
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
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এখনো কোনো এক্সাম নেই — আপনার এনরোল করা কোর্সের এক্সাম এখানে দেখাবে</p></div>`;
      return;
    }
    cards.sort((a, b) => b.sortKey - a.sortKey);
    grid.innerHTML = cards.map((c) => c.html).join("");
  } catch {
    if (state.navToken !== myToken) return;
    grid.innerHTML = `<div class="exs-empty"><p>এক্সাম লোড করা যায়নি</p></div>`;
  }
}

/* ---------- Exam list — all exams, or one course's exams ----------
   Re-checks visibility itself (not just trusting the picker), so a direct
   #/exam?course=xxx URL to a course the student isn't enrolled in shows
   nothing rather than leaking the exam list. ---------- */
export async function renderExamList(grid, courseKey = null) {
  grid.classList.remove("exam-grid--courses");
  grid.innerHTML = `<div class="exs-loading"><span class="exs-spinner"></span> লোড হচ্ছে...</div>`;
  const myToken = state.navToken;
  try {
    if (courseKey && courseKey !== "general") {
      const info = await checkExamVisibility(courseKey, state.userProfile);
      if (state.navToken !== myToken) return;
      if (!info.visible) {
        setExamSectionHeader({ title: "কোর্স পাওয়া যায়নি", sub: "", showBack: true });
        grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-lock"></i><p>এই কোর্সে আপনি এনরোল করা নেই</p></div>`;
        return;
      }
    }

    const allExams = await fetchAllExams();
    if (state.navToken !== myToken) return;
    const exams = courseKey ? allExams.filter((ex) => (ex.courseId || "general") === courseKey) : allExams;

    if (courseKey) {
      let title = "কোর্সের এক্সাম";
      if (courseKey === "general") title = "সাধারণ এক্সাম (সবার জন্য)";
      else {
        const info = await checkExamVisibility(courseKey, state.userProfile);
        title = info.title || exams[0]?.courseName || "কোর্সের এক্সাম";
      }
      setExamSectionHeader({ title, sub: exams.length ? `এই কোর্সে মোট ${exams.length} টি এক্সাম রয়েছে` : "এই কোর্সে এখনো কোনো এক্সাম যোগ করা হয়নি", showBack: true });
    }

    if (!exams.length) {
      grid.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এই কোর্সে এখনো কোনো এক্সাম নেই</p></div>`;
      return;
    }

    const cards = (await Promise.all(exams.map(async (ex) => {
      const { visible } = await checkExamVisibility(ex.courseId, state.userProfile);
      if (!visible) return "";

      const { state: availState, publishAt, closesAt } = getExamAvailability(ex);
      if (availState === "upcoming") {
        return `
        <div class="exs-card exs-card--locked">
          <div class="exs-card-top">
            <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
            <span class="exs-countdown" data-countdown="${publishAt.getTime()}"><i class="fa-solid fa-hourglass-half"></i> <span class="countdown-val">...</span></span>
          </div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} মিনিট</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
          </div>
          <span class="exs-tag exs-tag--amber"><i class="fa-solid fa-lock"></i> চালু হবে: ${formatDateTime(publishAt)}</span>
        </div>`;
      }

      const result = await fetchResult(state.currentUser.uid, ex.id);
      const maxAttempts = Number(ex.maxAttempts || 0);
      const attemptsUsed = maxAttempts > 0 ? Number(result?.attemptNumber || 0) : 0;
      const attemptsExhausted = maxAttempts > 0 && attemptsUsed >= maxAttempts;
      const attemptsMeta = maxAttempts > 0
        ? `<span><i class="fa-solid fa-rotate"></i> অ্যাটেম্পট: ${attemptsUsed}/${maxAttempts}</span>`
        : `<span><i class="fa-solid fa-infinity"></i> সীমাহীন অ্যাটেম্পট</span>`;

      if (availState === "closed") {
        return `
        <div class="exs-card exs-card--locked">
          <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} মিনিট</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
          </div>
          ${result ? `<span class="exs-tag exs-tag--amber">আগের স্কোর: ${formatScore(result.score)}/${result.total}</span>` : ""}
          <span class="exs-tag exs-tag--coral"><i class="fa-solid fa-stopwatch"></i> সময় শেষ (${formatDateTime(closesAt)} পর্যন্ত খোলা ছিল)</span>
        </div>`;
      }

      if (attemptsExhausted) {
        return `
        <div class="exs-card exs-card--locked">
          <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
          <h3>${escapeHtml(ex.title)}</h3>
          <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
          <div class="exs-meta-row">
            <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} মিনিট</span>
            <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
          </div>
          ${result ? `<span class="exs-tag exs-tag--amber">সর্বশেষ স্কোর: ${formatScore(result.score)}/${result.total}</span>` : ""}
          <span class="exs-tag exs-tag--coral"><i class="fa-solid fa-ban"></i> আপনি ইতিমধ্যে এই এক্সাম দিয়ে ফেলেছেন</span>
        </div>`;
      }

      return `
      <div class="exs-card">
        <div><span class="exs-chip exs-chip-course">${escapeHtml(ex.courseName || "General")}</span> ${lessonTagHtml(ex)}</div>
        <h3>${escapeHtml(ex.title)}</h3>
        <p class="exs-muted">${escapeHtml(ex.description || "")}</p>
        <div class="exs-meta-row">
          <span><i class="fa-solid fa-stopwatch"></i> ${ex.duration || 10} মিনিট</span>
          <span><i class="fa-solid fa-circle-question"></i> ${getExamQuestionCount(ex)} টি প্রশ্ন</span>
        </div>
        <div class="exs-meta-row">${attemptsMeta}</div>
        ${result ? `<span class="exs-tag exs-tag--amber">আগের স্কোর: ${formatScore(result.score)}/${result.total}</span>` : ""}
        ${closesAt ? `<span class="exs-muted exs-small">${formatDateTime(closesAt)} পর্যন্ত খোলা</span>` : ""}
        <a href="#/exam?id=${ex.id}" class="btn btn-primary btn-block">${result ? "আবার দিন" : "Start Exam"}</a>
      </div>`;
    }))).filter(Boolean);

    if (state.navToken !== myToken) return;
    grid.innerHTML = cards.length ? cards.join("") : `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এখন কোনো এক্সাম নেই</p></div>`;
    startCountdowns(grid);
  } catch {
    if (state.navToken !== myToken) return;
    grid.innerHTML = `<div class="exs-empty"><p>এক্সাম লোড করা যায়নি</p></div>`;
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
    ${isLocked ? `<div class="exs-locked-hint"><i class="fa-solid fa-circle-info"></i> আপনার উত্তর দেখানো হচ্ছে</div>` : ""}`;
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
      <div class="exs-q-index">প্রশ্ন ${i + 1} / ${state.questions.length}</div>
      <h2>${escapeHtml(q.text)}</h2>
      ${renderOptionsHtml(q)}
    </div>`).join("");
  bindOptionClicks(refs.questionArea, () => renderAllQuestions(refs));
}

export function renderResult(resultView, { score, total, percent, examTitle, breakdown }) {
  const { correctCount = 0, wrongCount = 0, unansweredCount = 0, negativeMarking = 0, timeTakenSeconds = 0 } = breakdown;
  resultView.innerHTML = `
    <div class="exs-result-hero" id="exs-print-area">
      <div class="exs-print-head">
        <div class="exs-print-title">Tech Verse Exam — ফলাফল</div>
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
    <div class="exs-review-list">
      ${state.questions.map((q, i) => {
        const userAns = state.answers[q.id];
        const correct = userAns === q.correctIndex;
        return `
        <div class="exs-review-item">
          <div class="exs-review-q">${i + 1}. ${escapeHtml(q.text)}</div>
          <div class="exs-review-answer ${correct ? "is-correct" : "is-wrong"}">
            ${correct ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'} আপনার উত্তর: ${userAns !== undefined ? escapeHtml(q.options[userAns]) : "উত্তর দেওয়া হয়নি"}
          </div>
          ${!correct ? `<div class="exs-review-answer is-correct"><i class="fa-solid fa-check"></i> সঠিক উত্তর: ${escapeHtml(q.options[q.correctIndex])}</div>` : ""}
          ${q.explanation && q.explanation.trim() ? `<div class="exs-review-explain"><i class="fa-solid fa-lightbulb"></i><span><b>ব্যাখ্যা:</b> ${escapeHtml(q.explanation)}</span></div>` : ""}
        </div>`;
      }).join("")}
    </div>`;

  resultView.querySelector("#exs-print-result")?.addEventListener("click", () => window.print());
}
