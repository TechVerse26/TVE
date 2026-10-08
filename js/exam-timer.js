// ==========================================================================
// exam-timer.js — the exam-duration countdown, plus "opens in Xh Ym" chips
// ==========================================================================
import { formatTime } from "./utils.js";
import { state } from "./exam-engine.js";
import { serverNow } from "./server-time.js";
import { countdownParts, countdownShort } from "./schedule-core.js";

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

/**
 * Ticks every [data-countdown="<epoch ms>"] element inside `container` once a second, against the SERVER clock
 * (server-time.js) so a phone with the wrong time still counts down correctly.
 *   data-cd-mode="short" (default)  writes "2d 5h" / "1h 15m" / "4m 09s" into .countdown-val (or the element itself)
 *   data-cd-mode="parts"            fills four boxes marked [data-cd="days|hours|minutes|seconds"] with 02 / 05 / 32 / 18
 *   data-cd-zero="text"             what to show at zero (default "শুরু হচ্ছে…")
 * `onReach(el)` (optional) is called once, the first time any element reaches zero — the caller can then
 * flip the UI (Upcoming → Live, Live → Closed) without any extra Firestore read.
 */
export function startCountdowns(container, { onReach } = {}) {
  if (container._countdownTimer) clearInterval(container._countdownTimer);
  function tick() {
    const chips = container.querySelectorAll("[data-countdown]");
    if (!chips.length) { clearInterval(container._countdownTimer); return; }
    const now = serverNow();
    let reached = null;
    chips.forEach((chip) => {
      const diff = Math.max(0, Number(chip.dataset.countdown) - now);
      if (chip.dataset.cdMode === "parts") {
        const parts = countdownParts(diff);
        ["days", "hours", "minutes", "seconds"].forEach((unit, i) => {
          const el = chip.querySelector(`[data-cd="${unit}"]`);
          if (el && el.textContent !== parts[i].value) el.textContent = parts[i].value;
        });
      } else {
        const valEl = chip.querySelector(".countdown-val") || chip;
        const text = diff === 0 ? (chip.dataset.cdZero || "শুরু হচ্ছে…") : countdownShort(diff);
        if (valEl.textContent !== text) valEl.textContent = text;
      }
      if (diff === 0 && !chip.dataset.reached) { chip.dataset.reached = "1"; reached = reached || chip; }
    });
    // Deferred (never synchronous): the callback usually repaints and calls startCountdowns() again — running it
    // inside this tick could recurse if an exam sits exactly on the boundary millisecond.
    if (reached && typeof onReach === "function") setTimeout(() => onReach(reached), 0);
  }
  tick();
  container._countdownTimer = setInterval(tick, 1000);
}

export function stopCountdowns(container) {
  if (container?._countdownTimer) clearInterval(container._countdownTimer);
  if (container) container._countdownTimer = null;
}
