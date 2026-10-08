// ==========================================================================
// perf-ui.js — the student performance widgets (summary cells + result bars), shared by the home
// page's "My Performance" section and the full #/performance page. Pure markup; data comes in as arguments.
// ==========================================================================
import { esc } from "./home-ui.js";

/** `perf` from home-core.performanceFromStats(); `rk` from home-core.rankOf(); `available` = exams the student can see.
 *  Four key numbers first (average · best · pass rate · attempts), the supporting three underneath. */
export function perfCellsHtml(perf, { rk = null, available = 0 } = {}) {
  const tile = (label, value, hint = "", cls = "") => `<div class="stat-tile pf-cell ${cls}"><b class="stat-value">${value}</b><span class="stat-label">${label}</span>${hint ? `<small class="stat-hint">${hint}</small>` : ""}</div>`;
  return `<div class="pf-grid pf-grid--key">
      ${tile("Average score", `${perf.avg}%`)}
      ${tile("Best score", `${perf.best}%`, "", "is-good")}
      ${tile("Pass rate", perf.passRate === null ? "—" : `${perf.passRate}%`)}
      ${tile("Total attempts", perf.attempts)}
    </div>
    <div class="pf-grid pf-grid--more">
      ${tile("Completed", perf.taken)}
      ${tile("Total exams", available, "available to you")}
      ${tile("Current rank", rk ? `#${rk.rank}` : "—", rk ? `of ${rk.total}` : "needs more data")}
    </div>`;
}

/** Latest results as CSS bars (no chart library), the pass line drawn across. `rows` = home-core.recentResultRows(). */
export function perfBarsHtml(rows, passLine, { max = 8 } = {}) {
  const list = rows.slice().sort((a, b) => a.at - b.at).slice(-max);
  if (list.length < 2) return "";
  return `<div class="pf-bars" role="img" aria-label="আপনার সাম্প্রতিক ফলাফলের শতাংশ">
    <i class="pf-pass" style="--p:${Math.min(100, passLine)}" aria-hidden="true"><span>Pass ${passLine}%</span></i>
    ${list.map((r) => `<div class="pf-col${r.pass ? "" : " is-fail"}" title="${esc(r.title)} — ${r.percent}%"><b style="--p:${Math.max(3, Math.min(100, r.percent))}"></b><span>${r.percent}</span></div>`).join("")}
  </div>`;
}
