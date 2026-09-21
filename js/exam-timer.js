// ==========================================================================
// exam-timer.js — the exam-duration countdown, plus "opens in Xh Ym" chips
// ==========================================================================
import { formatTime } from "./utils.js";
import { state } from "./exam-engine.js";

let timerInterval = null;
let visibilityHandler = null;

export function stopExamTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (visibilityHandler) { document.removeEventListener("visibilitychange", visibilityHandler); visibilityHandler = null; }
}

/* ---------- Exam countdown ----------
   Counts against a fixed wall-clock deadline instead of subtracting 1 on
   every setInterval tick. A decrementing counter drifts, and browsers slow
   timers in background tabs (Chrome can fire them once a minute after a few
   minutes hidden), which would silently hand a student extra time. With a
   deadline, whenever a tick finally runs it computes the true time left, and
   coming back to the tab re-checks immediately (visibilitychange). ---------- */
export function startExamTimer(onTick, onExpire) {
  stopExamTimer();
  const endAt = Date.now() + Math.max(0, state.secondsLeft) * 1000;
  let expired = false;
  const tick = () => {
    if (expired) return;
    const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    state.secondsLeft = left;
    onTick(left);
    if (left <= 0) {
      expired = true;
      stopExamTimer();
      onExpire();
    }
  };
  timerInterval = setInterval(tick, 500);
  visibilityHandler = () => { if (!document.hidden) tick(); };
  document.addEventListener("visibilitychange", visibilityHandler);
  tick();
}

export function formatClock(seconds) {
  return formatTime(seconds);
}

export function startCountdowns(container) {
  if (container._countdownTimer) clearInterval(container._countdownTimer);
  function tick() {
    const chips = container.querySelectorAll("[data-countdown]");
    if (!chips.length) { clearInterval(container._countdownTimer); return; }
    const now = Date.now();
    chips.forEach((chip) => {
      const target = Number(chip.dataset.countdown);
      const diff = Math.max(0, target - now);
      const valEl = chip.querySelector(".countdown-val");
      if (!valEl) return;
      if (diff === 0) { valEl.textContent = "শুরু হচ্ছে…"; return; }
      const totalSecs = Math.floor(diff / 1000);
      const d = Math.floor(totalSecs / 86400);
      const h = Math.floor((totalSecs % 86400) / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      let label = "";
      if (d > 0) label = `${d}d ${h}h`;
      else if (h > 0) label = `${h}h ${m}m`;
      else if (m > 0) label = `${m}m ${s}s`;
      else label = `${s}s`;
      valEl.textContent = label;
    });
  }
  tick();
  container._countdownTimer = setInterval(tick, 1000);
}
