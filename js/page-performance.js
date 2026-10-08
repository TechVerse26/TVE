// ==========================================================================
// page-performance.js — "My Performance" (#/performance): the home dashboard's summary, in full, plus a
// per-exam table. Built from the student's own userStats summary (1 cached read) — no result documents are
// downloaded here; the detailed answer review lives in My Activity (#/results).
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { passPercentFor } from "./schedule-core.js";
import * as H from "./home-core.js";
import { perfCellsHtml, perfBarsHtml } from "./perf-ui.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, fmtDate, pageHead } from "./home-ui.js";

let renderToken = 0;

export async function initPerformancePage(params, mount) {
  const my = ++renderToken;
  await renderNav("performance");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  mount.innerHTML = `<div class="container page">
    ${pageHead("My Performance", "আপনার সব পরীক্ষার সারসংক্ষেপ — গড়, সেরা স্কোর, পাস রেট ও অবস্থান।", '<a class="btn btn-outline btn-sm" href="#/results"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Detailed review</a>')}
    <div id="pf-body">${skeleton("card", 2)}</div>
  </div>`;
  const body = mount.querySelector("#pf-body");

  async function load(force) {
    const M = await loadStudentContext(user, { force, rank: true });
    if (my !== renderToken) return;
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    if (!M.stats) { body.innerHTML = errorBlock("pf"); return; }
    const m = buildStudentModel(M);
    const perf = H.performanceFromStats(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent });
    if (!perf.taken) {
      body.innerHTML = emptyBlock("fa-chart-simple", "এখনো কোনো পরীক্ষা দেননি। প্রথম পরীক্ষা দিলেই এখানে আপনার পারফরম্যান্স দেখা যাবে।", '<a class="btn btn-primary btn-sm" href="#/exams">পরীক্ষা দেখুন</a>');
      return;
    }
    const rk = H.rankOf(M.pct?.percents, perf.ownLiveAvg);
    const recent = H.recentResultRows(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent, limit: 12 });
    const rows = perf.rows.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    body.innerHTML = `<div class="card">
        ${perfCellsHtml(perf, { rk, available: m.items.length })}
        ${perfBarsHtml(recent, passPercentFor(null, m.feed.passPercent), { max: 12 })}
      </div>
      <section class="section" aria-labelledby="h-pf-table">
        <div class="section-head"><div class="section-head-text"><h2 class="section-title" id="h-pf-table">Every exam you took</h2>
          <p class="section-sub">${perf.basis === "live" ? "গড়, সেরা স্কোর ও পাস রেট শুধু লাইভ পরীক্ষার সেরা অ্যাটেম্পট ধরে হিসাব করা।" : "এখনো কোনো লাইভ পরীক্ষা দেননি — হিসাব প্র্যাকটিস পরীক্ষা থেকে।"}</p></div></div>
        <div class="tbl-scroll"><table class="pf-table">
          <thead><tr><th>Exam</th><th>Type</th><th class="num">Attempts</th><th class="num">Latest</th><th class="num">Best</th><th>Result</th><th>Date</th></tr></thead>
          <tbody>${rows.map((r) => {
            const best = H.bestOf(r);
            const pass = best >= passPercentFor(m.examsById[r.examId], m.feed.passPercent);
            return `<tr><td data-l="Exam"><b>${esc(r.ti || m.examsById[r.examId]?.title || "Exam")}</b></td><td data-l="Type">${r.ty === "practice" ? "Practice" : "Live"}</td>
              <td class="num" data-l="Attempts">${Number(r.n) || 0}</td><td class="num" data-l="Latest">${Number(r.p) || 0}%</td><td class="num" data-l="Best">${best}%</td>
              <td data-l="Result"><span class="rs-pf badge ${pass ? "badge-pass is-pass" : "badge-fail is-fail"}">${pass ? "Pass" : "Fail"}</span></td><td data-l="Date">${r.at ? esc(fmtDate(r.at, m.now)) : "—"}</td></tr>`;
          }).join("")}</tbody></table></div>
      </section>`;
  }
  try { await load(false); } catch { body.innerHTML = errorBlock("pf"); }
  if (my !== renderToken) return;
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 2); try { await load(true); } catch { body.innerHTML = errorBlock("pf"); } });
}
