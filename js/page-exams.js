// ==========================================================================
// page-exams.js — "All Exams" (#/exams): every exam the student can see, in one searchable, filterable list
// of smart cards. Filters are kept in the URL (…#/exams?type=practice&subject=…) so a link from Quick Actions,
// a category tile or a notification lands on the right view and the browser Back button behaves.
//
// The older course-by-course browser (#/exam → course → Upcoming/Live/Practice) is untouched; a link here leads to it.
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { startCountdowns, stopCountdowns } from "./exam-timer.js";
import { onPageLeave } from "./page-lifecycle.js";
import * as H from "./home-core.js";
import { examCardHtml, bindExamCardActions, openExamDetails } from "./exam-card.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, pageHead } from "./home-ui.js";

const PAGE_SIZE = 18;
let renderToken = 0;

const FILTER_KEYS = ["q", "type", "status", "subject", "category", "difficulty", "date", "sort"];
const STATUS_OPTS = [["", "All statuses"], ["live", "Live now"], ["upcoming", "Upcoming"], ["available", "Available"], ["completed", "Completed"], ["closed", "Closed / unavailable"]];
const DATE_OPTS = [["", "Any date"], ["today", "Today"], ["week", "Next 7 days"], ["upcoming", "Upcoming"], ["past", "Past"]];
const DIFF_OPTS = [["", "Any difficulty"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]];
const SORT_OPTS = [["smart", "Best match"], ["newest", "Newest first"], ["title", "Title A–Z"]];

const readFilters = (params) => Object.fromEntries(FILTER_KEYS.map((k) => [k, params?.get?.(k) || ""]));

function writeUrl(f) {
  const qs = new URLSearchParams();
  FILTER_KEYS.forEach((k) => { if (f[k] && !(k === "sort" && f[k] === "smart")) qs.set(k, f[k]); });
  const hash = `#/exams${qs.toString() ? `?${qs}` : ""}`;
  if (window.location.hash !== hash) history.replaceState(null, "", hash); // replaceState: no hashchange, no re-render
}

const select = (id, label, opts, value) => `<label class="fl-field"><span class="fl-lab">${esc(label)}</span>
  <select id="${id}" data-f="${id.replace("fl-", "")}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;

export async function initExamsPage(params, mount) {
  const my = ++renderToken;
  await renderNav("exams");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  let M = null;
  let f = readFilters(params);
  let shown = PAGE_SIZE;
  let model = null;
  let panelOpen = null; // filter panel on phones: null = automatic (open when a filter is active), else the user's choice

  mount.innerHTML = `<div class="container page">
    ${pageHead("Exams", "সব লাইভ ও প্র্যাকটিস পরীক্ষা — খুঁজুন, ফিল্টার করুন, শুরু করুন।", '<a class="btn btn-outline btn-sm" href="#/exam"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> Browse by course</a>')}
    <div class="section">
      <div id="ex-filters"></div>
      <p class="fl-count" id="ex-count" aria-live="polite"></p>
    </div>
    <div id="ex-body">${skeleton("card", 3)}</div>
  </div>`;
  const filtersEl = mount.querySelector("#ex-filters");
  const countEl = mount.querySelector("#ex-count");
  const body = mount.querySelector("#ex-body");

  function filtersHtml() {
    const tax = M.feed.taxonomy;
    const vis = model.items.map((it) => it.exam);
    const subjects = H.subjectRollup(tax, vis);
    const cats = H.categoryRollup(tax, vis);
    const active = FILTER_KEYS.filter((k) => f[k] && k !== "q" && !(k === "sort" && f[k] === "smart")).length;
    const wide = window.matchMedia("(min-width: 760px)").matches;
    const open = panelOpen !== null ? panelOpen : wide || active > 0;
    return `<form class="fl card" role="search" onsubmit="return false">
      <label class="fl-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input type="search" id="fl-q" data-f="q" placeholder="Search exams, subjects, courses…" value="${esc(f.q)}" autocomplete="off" aria-label="Search exams"></label>
      <details class="fl-details"${open ? " open" : ""}>
      <summary class="fl-toggle"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Filters${active ? ` <em>${active}</em>` : ""}<i class="fa-solid fa-chevron-down hm-caret" aria-hidden="true"></i></summary>
      <div class="fl-grid">
        ${select("fl-type", "Type", [["", "All types"], ["live", "Live exams"], ["practice", "Practice"]], f.type)}
        ${select("fl-status", "Status", STATUS_OPTS, f.status)}
        ${select("fl-subject", "Subject", [["", "All subjects"], ...subjects.map((s) => [s.id, `${s.name} (${s.count})`])], f.subject)}
        ${select("fl-category", "Category", [["", "All categories"], ...cats.map((c) => [c.id, `${H.categoryPathOf(tax, c.id) || c.name} (${c.count})`])], f.category)}
        ${select("fl-difficulty", "Difficulty", DIFF_OPTS, f.difficulty)}
        ${select("fl-date", "Date", DATE_OPTS, f.date)}
        ${select("fl-sort", "Sort", SORT_OPTS, f.sort || "smart")}
        <button type="button" class="btn btn-outline btn-sm fl-clear" id="fl-clear"${active || f.q ? "" : " disabled"}><i class="fa-solid fa-xmark" aria-hidden="true"></i> Clear${active ? ` (${active})` : ""}</button>
      </div>
      </details>
    </form>`;
  }

  function paintList() {
    model = buildStudentModel(M);
    const tax = M.feed.taxonomy;
    const names = (e) => `${H.subjectNameOf(tax, e.subjectId)} ${H.categoryPathOf(tax, e.categoryId)}`;
    const list = H.sortExams(H.filterExams(model.items, { ...f, _names: names }, { categories: tax.categories, now: model.now }), f.sort || "smart");
    countEl.textContent = model.items.length ? `${list.length} of ${model.items.length} exams` : "";
    if (!model.items.length) {
      body.innerHTML = emptyBlock("fa-file-lines", "এখনো কোনো পরীক্ষা পাওয়া যায়নি।");
    } else if (!list.length) {
      body.innerHTML = emptyBlock("fa-face-meh", "এই ফিল্টারে কোনো পরীক্ষা পাওয়া যায়নি।", '<button type="button" class="btn btn-outline btn-sm" id="fl-clear-2">ফিল্টার মুছুন</button>');
    } else {
      const page = list.slice(0, shown);
      body.innerHTML = `<div class="xc-grid">${page.map((it) => examCardHtml(it, model.ctx)).join("")}</div>
        ${list.length > shown ? `<div class="hm-more-wrap"><button type="button" class="btn btn-outline" id="ex-more">Show more (${list.length - shown})</button></div>` : ""}`;
    }
    startCountdowns(body, { onReach: () => paintList() });
  }

  function paintAll() {
    model = buildStudentModel(M);
    filtersEl.innerHTML = filtersHtml();
    paintList();
  }

  async function load(force) {
    M = await loadStudentContext(user, { force });
    if (my !== renderToken) return;
    if (M.catalogError) {
      filtersEl.innerHTML = "";
      body.innerHTML = errorBlock("exams");
      return;
    }
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    paintAll();
    const openId = params?.get?.("open");
    if (openId) {
      const it = model.items.find((x) => x.exam.id === openId);
      if (it) openExamDetails(it, model.ctx);
    }
  }
  await load(false);
  if (my !== renderToken) return;

  /* ----- interactions ----- */
  bindExamCardActions(body, (id) => {
    const it = model?.items.find((x) => x.exam.id === id);
    return it ? { item: it, ctx: model.ctx } : null;
  });
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 3); await load(true); });

  let typing = null;
  const apply = () => { shown = PAGE_SIZE; writeUrl(f); paintAll(); };
  mount.addEventListener("input", (e) => {
    const el = e.target.closest("[data-f]");
    if (!el || el.tagName !== "INPUT") return;
    f[el.dataset.f] = el.value;
    clearTimeout(typing);
    typing = setTimeout(() => { // keep the search box focused: only the list is repainted while typing
      shown = PAGE_SIZE; writeUrl(f); paintList();
      const clear = mount.querySelector("#fl-clear");
      if (clear) clear.disabled = !FILTER_KEYS.some((k) => f[k] && !(k === "sort" && f[k] === "smart"));
    }, 180);
  });
  mount.addEventListener("toggle", (e) => { if (e.target.classList?.contains("fl-details")) panelOpen = e.target.open; }, true);
  mount.addEventListener("change", (e) => {
    const el = e.target.closest("select[data-f]");
    if (!el) return;
    f[el.dataset.f] = el.value;
    apply();
  });
  mount.addEventListener("click", (e) => {
    if (e.target.closest("#fl-clear") || e.target.closest("#fl-clear-2")) { f = readFilters(null); apply(); return; }
    if (e.target.closest("#ex-more")) { shown += PAGE_SIZE; paintList(); }
  });
  onPageLeave(() => { clearTimeout(typing); stopCountdowns(body); });
}
