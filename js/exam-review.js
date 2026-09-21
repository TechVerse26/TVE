// ==========================================================================
// exam-review.js — the ONE place a "wrong answers" review is drawn.
//
// Used by both:
//   • the result screen shown right after an exam (exam-render.js), and
//   • "My Activity" → an attempt's saved review (page-results.js),
// so a mistake looks identical (same numbering, same wording, same
// explanation box) whether you're looking at it seconds after submitting or
// a day later. Nothing here reads global state or touches Firestore — it only
// turns an array of review items into HTML.
//
// A review item is what exam.js snapshots at submit time:
//   { id, n, text, options[], correctIndex, explanation, selected }
//   n        — the question's original position in the exam (1-based). Older
//              saved reviews don't have it; they fall back to 1, 2, 3 …
//   selected — chosen option index, or null when the question was skipped.
// ==========================================================================
import { escapeHtml, toBnDigits } from "./utils.js";
import { REVIEW_TTL_MS } from "./exam-data.js";

/** How long a saved review stays viewable, in whole hours (48 today). */
export function reviewTtlHours() {
  return Math.round(REVIEW_TTL_MS / 3600000);
}

/** Keep only wrong / unanswered items and make sure each one has a display number. */
export function normalizeReview(review) {
  if (!Array.isArray(review)) return [];
  return review
    .filter((q) => q && Array.isArray(q.options) && (q.selected ?? null) !== q.correctIndex)
    .map((q, i) => ({ ...q, selected: q.selected ?? null, n: Number(q.n) > 0 ? Number(q.n) : i + 1 }));
}

function optionText(q, index) {
  return index === null || index === undefined ? "" : escapeHtml(q.options[index]);
}

export function reviewItemHtml(q) {
  const answered = q.selected !== null && q.selected !== undefined;
  const hasExplanation = q.explanation && String(q.explanation).trim();
  return `
    <div class="exs-review-item">
      <div class="exs-review-q">${q.n}. ${escapeHtml(q.text)}</div>
      <div class="exs-review-answer is-wrong"><i class="fa-solid fa-xmark"></i> আপনার উত্তর: ${answered ? optionText(q, q.selected) : "উত্তর দেওয়া হয়নি"}</div>
      <div class="exs-review-answer is-correct"><i class="fa-solid fa-check"></i> সঠিক উত্তর: ${optionText(q, q.correctIndex)}</div>
      ${hasExplanation ? `<div class="exs-review-explain"><i class="fa-solid fa-lightbulb"></i><span><b>ব্যাখ্যা:</b> ${escapeHtml(q.explanation)}</span></div>` : ""}
    </div>`;
}

/** The full block shown under the result hero right after an exam. */
export function reviewListHtml(items) {
  if (!items.length) {
    return `
      <div class="exs-review-list">
        <div class="exs-empty"><i class="fa-solid fa-champagne-glasses"></i><p>অভিনন্দন! আপনি সব প্রশ্নের সঠিক উত্তর দিয়েছেন — রিভিউ করার মতো কিছু নেই।</p></div>
      </div>`;
  }
  return `
    <p class="exs-muted exs-small exs-review-note"><i class="fa-solid fa-circle-info"></i><span>নিচে শুধু আপনার ভুল করা প্রশ্নগুলো দেখানো হচ্ছে। পেজ ছেড়ে গেলেও এগুলো <b>My Activity</b>-তে <b>${toBnDigits(reviewTtlHours())} ঘণ্টা</b> পর্যন্ত দেখা যাবে।</span></p>
    <div class="exs-review-list">${items.map(reviewItemHtml).join("")}</div>`;
}
