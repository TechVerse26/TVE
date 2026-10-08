// ==========================================================================
// exam-card.js — the one "smart" exam card used by the home page, All Exams, Schedule, Featured and
// the course exam list; plus the shared click handling (Details sheet, Remind me).
//
// The card never decides anything about time itself: it renders what schedule-core.computeStatus()
// said — status badge, countdown, and which button to show (Start Exam / Retake / Continue Practice /
// View Result / Coming Soon / Not Available) — so every screen agrees.
// ==========================================================================
import { passMarksFor, getExamQuestionCount, DIFFICULTY } from "./schedule-core.js";
import { subjectNameOf, categoryPathOf } from "./home-core.js";
import { esc, statusBadge, fmtRange, fmtDate, fmtDay, fmtTime, ctaHtml, tzLabel } from "./home-ui.js";
import { canRemind, hasReminder, setReminder, cancelReminder, maybeAskBrowserPermission } from "./reminders.js";
import { openModal, closeModal, toast } from "./utils.js";
import { serverNow } from "./server-time.js";

/* ---------- what the main button says and does ---------- */
export function ctaFor({ exam, status }) {
  const id = encodeURIComponent(exam.id);
  const practice = exam.examType === "practice";
  switch (status.cta) {
    case "start": return { label: "Start Exam", href: `#/exam?id=${id}`, primary: true, icon: "fa-play" };
    case "retake": return { label: practice ? "Continue Practice" : "Retake Exam", href: `#/exam?id=${id}`, primary: true, icon: "fa-rotate-right" };
    case "result": return { label: "View Result", href: "#/results", primary: false, icon: "fa-square-poll-vertical" };
    case "soon": return { label: "Coming Soon", disabled: true, icon: "fa-hourglass-half" };
    default: {
      const label = { cancelled: "Not Available", maintenance: "Under Maintenance", disabled: "Account Disabled", "registration-closed": "Registration Closed" }[status.reason] || "Closed";
      return { label, disabled: true, icon: "fa-lock" };
    }
  }
}

/* ---------- shared bits of exam information ---------- */
export function examFacts(exam, { defaultPass = 60 } = {}) {
  const questions = getExamQuestionCount(exam);
  return {
    questions,
    marks: questions, // 1 mark per correct answer
    passMarks: passMarksFor(exam, defaultPass),
    duration: Number(exam.duration) || 0,
    difficulty: DIFFICULTY[exam.difficulty] || null,
    attemptsLimit: Number(exam.maxAttempts) || 0,
    negative: exam.examType === "practice" ? 0 : Math.max(0, Number(exam.negativeMarking) || 0),
    practice: exam.examType === "practice",
  };
}

export function examSubline(exam, tax) {
  const lessons = Array.isArray(exam.lessonNames) && exam.lessonNames.length ? exam.lessonNames.join(", ") : "";
  const bits = [subjectNameOf(tax, exam.subjectId), categoryPathOf(tax, exam.categoryId), exam.courseName, lessons].filter(Boolean);
  return bits.join(" · ");
}

/** "Last 8/10 (80%)" · "Attempts 1/3" — the student's own history on this exam. */
export function attemptLine({ exam, last, attemptsUsed }) {
  const bits = [];
  if (last) bits.push(`Last score <b>${esc(last.s)}/${esc(last.t)}</b> (${esc(last.p)}%)`);
  const limit = Number(exam.maxAttempts) || 0;
  if (limit > 0) bits.push(`Attempts <b>${attemptsUsed}/${limit}</b>`);
  else if (attemptsUsed > 0) bits.push(`Attempted <b>${attemptsUsed}</b>×`);
  return bits.join(" · ");
}

/** Remind-me button (only when a reminder makes sense for this exam). */
export function remindButtonHtml(exam, ctx, { compact = false } = {}) {
  if (!ctx.loggedIn || !canRemind(exam, ctx.now)) return "";
  const on = ctx.reminders?.has(exam.id);
  return `<button type="button" class="btn btn-outline btn-sm xc-remind${on ? " is-on" : ""}" data-act="remind" data-id="${esc(exam.id)}" data-compact="${compact ? 1 : 0}" aria-pressed="${on ? "true" : "false"}" title="${on ? "Cancel reminder" : "Remind me before it starts"}">
    <i class="fa-${on ? "solid" : "regular"} fa-bell" aria-hidden="true"></i><span>${compact ? (on ? "Set" : "Remind") : on ? "Reminder set" : "Remind me"}</span></button>`;
}

export const detailsButtonHtml = (exam) =>
  `<button type="button" class="btn btn-outline btn-sm" data-act="details" data-id="${esc(exam.id)}"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>Details</span></button>`;

/** The countdown line under the date: "Starts in …" for upcoming, "Closes in …" while live. */
export function countdownLineHtml(status) {
  if (status.key === "live" && status.countdownTo) {
    return `<p class="xc-clock xc-clock--live"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Closes in <b data-countdown="${status.countdownTo}"><span class="countdown-val">…</span></b></p>`;
  }
  if ((status.key === "soon" || status.key === "upcoming") && status.countdownTo) {
    return `<p class="xc-clock"><i class="fa-regular fa-clock" aria-hidden="true"></i> Starts in <b data-countdown="${status.countdownTo}"><span class="countdown-val">…</span></b></p>`;
  }
  return "";
}

/**
 * The card. item = { exam, status, last, attemptsUsed }.
 * ctx  = { tax, now, reminders:Set, loggedIn, participants:{}, defaultPass }
 * opts = { featured: bool, extra: html }  — Featured adds pass mark + participants; `extra` is injected above the buttons.
 */
export function examCardHtml(item, ctx, { featured = false, extra = "" } = {}) {
  const { exam, status } = item;
  const f = examFacts(exam, { defaultPass: ctx.defaultPass });
  const cta = ctaFor(item);
  const sub = examSubline(exam, ctx.tax);
  const range = fmtRange(status.startsAt, status.endsAt, ctx.now);
  const attempt = attemptLine(item);
  const participants = Number(ctx.participants?.[exam.id]) || 0;
  return `<article class="card xc xc--${status.tone}${featured ? " xc--featured" : ""}" data-exam-id="${esc(exam.id)}" data-status="${status.key}">
    <header class="xc-top">
      ${statusBadge(status)}
      <span class="xc-kind">${f.practice ? "Practice" : "Live exam"}</span>
      ${exam.featured ? '<span class="xc-star" title="Featured exam"><i class="fa-solid fa-star" aria-hidden="true"></i></span>' : ""}
    </header>
    <h3 class="xc-title">${esc(exam.title || "Exam")}</h3>
    ${sub ? `<p class="xc-sub">${esc(sub)}</p>` : ""}
    <dl class="xc-stats">
      <div><dt>Questions</dt><dd>${f.questions}</dd></div>
      <div><dt>Marks</dt><dd>${f.marks}</dd></div>
      <div><dt>Duration</dt><dd>${f.duration ? `${f.duration} min` : "—"}</dd></div>
      <div><dt>Level</dt><dd>${f.difficulty ? esc(f.difficulty.label) : "—"}</dd></div>
      ${featured ? `<div><dt>Pass mark</dt><dd>${f.passMarks}</dd></div><div><dt>Participants</dt><dd>${participants > 0 ? participants : "—"}</dd></div>` : ""}
    </dl>
    ${range ? `<p class="xc-when"><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${esc(range)}</p>` : ""}
    ${countdownLineHtml(status)}
    ${attempt ? `<p class="xc-attempt">${attempt}</p>` : ""}
    ${extra}
    <footer class="xc-actions">
      ${ctaHtml(cta, { cls: "btn btn-sm xc-cta" })}
      ${remindButtonHtml(exam, ctx, { compact: true })}
      ${detailsButtonHtml(exam)}
    </footer>
  </article>`;
}

/* ==========================================================================
   Details sheet
   ========================================================================== */
export function openExamDetails(item, ctx) {
  const { exam, status } = item;
  const f = examFacts(exam, { defaultPass: ctx.defaultPass });
  const cta = ctaFor(item);
  const sub = examSubline(exam, ctx.tax);
  const row = (k, v) => (v === "" || v === null || v === undefined ? "" : `<div class="xd-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`);
  const when = status.startsAt !== null || status.endsAt !== null;
  const startTxt = status.startsAt !== null ? `${esc(fmtDay(status.startsAt))} · ${esc(fmtTime(status.startsAt))}` : "";
  const endTxt = status.endsAt !== null ? `${esc(fmtDay(status.endsAt))} · ${esc(fmtTime(status.endsAt))}` : "";
  const overlay = openModal(`
    <div class="modal-head">
      <h3>${esc(exam.title || "Exam")}</h3>
      <button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="xd-badges">${statusBadge(status)}<span class="xc-kind">${f.practice ? "Practice" : "Live exam"}</span></div>
    ${sub ? `<p class="xc-sub">${esc(sub)}</p>` : ""}
    ${exam.description ? `<p class="xd-desc">${esc(exam.description)}</p>` : ""}
    ${countdownLineHtml(status)}
    <dl class="xd-grid">
      ${row("Questions", f.questions)}
      ${row("Total marks", f.marks)}
      ${row("Pass mark", `${f.passMarks} <span class="exs-muted">(${esc(Math.round((f.passMarks / Math.max(1, f.marks)) * 100))}%)</span>`)}
      ${row("Duration", f.duration ? `${f.duration} minutes` : "")}
      ${row("Difficulty", f.difficulty ? esc(f.difficulty.label) : "")}
      ${row("Negative marking", f.negative > 0 ? `−${esc(f.negative)} per wrong answer` : "None")}
      ${row("Attempts", f.attemptsLimit > 0 ? `${item.attemptsUsed}/${f.attemptsLimit} used` : "Unlimited")}
      ${when ? row("Starts", startTxt) : ""}
      ${when ? row("Closes", endTxt || "No closing time") : ""}
      ${when ? row("Time zone", esc(tzLabel())) : ""}
      ${item.last ? row("Your last score", `${esc(item.last.s)}/${esc(item.last.t)} (${esc(item.last.p)}%)`) : ""}
      ${Number(ctx.participants?.[exam.id]) > 0 ? row("Participants", esc(ctx.participants[exam.id])) : ""}
    </dl>
    ${status.key === "unavailable" ? '<p class="note warn xd-note">এই পরীক্ষার সময়সূচি বাতিল করা হয়েছে।</p>' : ""}
    ${status.reason === "registration-closed" ? '<p class="note warn xd-note">নতুন করে এই পরীক্ষায় অংশগ্রহণের সুযোগ বন্ধ করা হয়েছে।</p>' : ""}
    <div class="xd-actions">
      ${ctaHtml(cta, { cls: "btn", block: false })}
      ${remindButtonHtml(exam, ctx)}
    </div>`);
  // The countdown inside the sheet ticks too.
  import("./exam-timer.js").then(({ startCountdowns }) => startCountdowns(overlay));
  overlay.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener("click", () => closeModal()));
  const rem = overlay.querySelector('[data-act="remind"]');
  if (rem) rem.addEventListener("click", () => toggleReminder(exam, ctx));
  return overlay;
}

/* ==========================================================================
   Click handling (one delegated listener per page root)
   ========================================================================== */
function paintRemindButton(btn, on, compact) {
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? "Cancel reminder" : "Remind me before it starts";
  const icon = btn.querySelector("i");
  if (icon) icon.className = `fa-${on ? "solid" : "regular"} fa-bell`;
  const label = btn.querySelector("span");
  if (label) label.textContent = compact ? (on ? "Set" : "Remind") : on ? "Reminder set" : "Remind me";
}

/** Set / cancel a reminder and update every button for that exam in place — no re-render, no Firestore. */
export function toggleReminder(exam, ctx) {
  if (!ctx.uid) return;
  const on = hasReminder(ctx.uid, exam.id);
  if (on) {
    cancelReminder(ctx.uid, exam.id);
    ctx.reminders?.delete(exam.id);
    toast("রিমাইন্ডার বাতিল করা হয়েছে।");
  } else if (setReminder(ctx.uid, exam, serverNow())) {
    ctx.reminders?.add(exam.id);
    toast(`রিমাইন্ডার সেট হয়েছে — শুরুর ১৫ মিনিট আগে জানানো হবে।`, "success");
    maybeAskBrowserPermission();
  } else {
    toast("এই পরীক্ষার জন্য রিমাইন্ডার দেওয়া যাচ্ছে না।", "error");
    return;
  }
  const now = !on;
  document.querySelectorAll(`[data-act="remind"][data-id="${CSS.escape(exam.id)}"]`).forEach((b) => paintRemindButton(b, now, b.dataset.compact === "1"));
}

/**
 * Wire Details + Remind me for every card / row inside `root`.
 * `lookup(id)` → { item, ctx } with FRESH data at click time (so a re-render never leaves stale closures).
 */
export function bindExamCardActions(root, lookup) {
  if (root._xcBound) return;
  root._xcBound = true;
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !root.contains(btn)) return;
    const found = lookup(btn.dataset.id);
    if (!found) return;
    if (btn.dataset.act === "details") openExamDetails(found.item, found.ctx);
    else if (btn.dataset.act === "remind") toggleReminder(found.item.exam, found.ctx);
  });
}

/* ==========================================================================
   Schedule row (time-first, denser than the card) — used by the home "Exam Schedule" and #/schedule
   ========================================================================== */
export function scheduleRowHtml(item, ctx) {
  const { exam, status } = item;
  const f = examFacts(exam, { defaultPass: ctx.defaultPass });
  const cta = ctaFor(item);
  const sub = examSubline(exam, ctx.tax);
  const t = status.startsAt;
  const e = status.endsAt;
  // "closes 1:00 PM", or "closes 9 Oct · 10:00 AM" when the window runs into another day.
  const closes = e === null ? "" : t !== null && new Date(t).toDateString() !== new Date(e).toDateString()
    ? `closes ${esc(fmtDate(e, ctx.now))}<br>${esc(fmtTime(e))}` : `closes ${esc(fmtTime(e))}`;
  return `<article class="sr sr--${status.tone}" data-exam-id="${esc(exam.id)}" data-status="${status.key}">
    <div class="sr-time">
      <b>${t !== null ? esc(fmtTime(t)) : "—"}</b>
      ${closes ? `<span>${closes}</span>` : ""}
    </div>
    <div class="sr-main">
      <div class="sr-line">${statusBadge(status)}<h3 class="sr-title">${esc(exam.title || "Exam")}</h3></div>
      ${sub ? `<p class="xc-sub">${esc(sub)}</p>` : ""}
      <p class="sr-meta">${f.questions} questions · ${f.marks} marks · pass ${f.passMarks}${f.duration ? ` · ${f.duration} min` : ""}${f.difficulty ? ` · ${esc(f.difficulty.label)}` : ""}</p>
      ${countdownLineHtml(status)}
    </div>
    <div class="sr-actions">
      ${ctaHtml(cta, { cls: "btn btn-sm xc-cta" })}
      ${remindButtonHtml(exam, ctx, { compact: true })}
      ${detailsButtonHtml(exam)}
    </div>
  </article>`;
}

