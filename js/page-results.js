import { requireAuth, escapeHtml, formatScore, formatDateTime } from "./utils.js";
import { fetchMyResults } from "./exam-data.js";
import { renderNav } from "./nav.js";

export async function initResultsPage(params, container) {
  await renderNav("results");
  const user = await requireAuth();
  if (!user) return;

  container.innerHTML = `
    <div class="container page-pad">
      <div class="page-head"><h1><i class="fa-solid fa-chart-simple"></i> আমার ফলাফল</h1><p>আপনার দেওয়া সব এক্সামের ফলাফল এখানে দেখতে পাবেন</p></div>
      <div id="my-results-list" class="exs-loading"><span class="exs-spinner"></span> লোড হচ্ছে...</div>
    </div>`;

  const listEl = container.querySelector("#my-results-list");
  try {
    const results = await fetchMyResults(user.uid);
    if (!results.length) {
      listEl.innerHTML = `<div class="exs-empty"><i class="fa-solid fa-file-pen"></i><p>এখনো কোনো এক্সাম দেননি</p></div>`;
      return;
    }
    listEl.className = "results-grid";
    listEl.innerHTML = results.map((r) => `
      <div class="result-row-card">
        <div class="result-row-main">
          <h3>${escapeHtml(r.examTitle || "এক্সাম")}</h3>
          <span class="exs-muted exs-small">${formatDateTime(r.submittedAt)} · অ্যাটেম্পট #${r.attemptNumber || 1}</span>
        </div>
        <div class="result-row-score">
          <b>${formatScore(r.score)} / ${r.total}</b>
          <span class="exs-tag ${r.percent >= 60 ? "exs-tag--teal" : "exs-tag--coral"}">${r.percent}%</span>
        </div>
      </div>`).join("");
  } catch {
    listEl.innerHTML = `<div class="exs-empty"><p>ফলাফল লোড করা যায়নি</p></div>`;
  }
}
