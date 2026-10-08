// ==========================================================================
// page-schedule.js — "Exam Schedule" (#/schedule): the timetable of every scheduled exam, grouped by day,
// with Upcoming / Live / Past tabs and subject + category filters. Same rows, same status rules as the home page.
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { startCountdowns, stopCountdowns } from "./exam-timer.js";
import { onPageLeave } from "./page-lifecycle.js";
import { DAY } from "./schedule-core.js";
import * as H from "./home-core.js";
import { scheduleRowHtml, bindExamCardActions, openExamDetails } from "./exam-card.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, dayHeading, tzLabel, pageHead } from "./home-ui.js";

let renderToken = 0;
const TABS = [["upcoming", "Upcoming"], ["live", "Live now"], ["past", "Past"], ["all", "All"]];
const PAST_WINDOW = 60 * DAY;

export async function initSchedulePage(params, mount) {
  const my = ++renderToken;
  await renderNav("schedule");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  let M = null, model = null;
  let tab = TABS.some(([k]) => k === params?.get?.("tab")) ? params.get("tab") : "upcoming";
  let subject = params?.get?.("subject") || "";
  let category = params?.get?.("category") || "";

  mount.innerHTML = `<div class="container page">
    ${pageHead("Schedule", `সময়সূচি আপনার ডিভাইসের স্থানীয় সময়ে দেখানো হচ্ছে (${tzLabel()})।`)}
    <div id="sc-bar"></div>
    <div id="sc-body">${skeleton("card", 3)}</div>
  </div>`;
  const bar = mount.querySelector("#sc-bar");
  const body = mount.querySelector("#sc-body");

  function barHtml() {
    const tax = M.feed.taxonomy;
    const vis = model.items.filter((it) => H.hasSchedule(it.exam)).map((it) => it.exam);
    const subjects = H.subjectRollup(tax, vis);
    const cats = H.categoryRollup(tax, vis);
    const counts = {
      live: H.liveItems(model.items).length,
      upcoming: H.scheduleItems(model.items, model.now).filter((it) => it.status.key !== "live").length,
    };
    return `<div class="sc-bar">
      <div class="seg-tabs" role="tablist" aria-label="Schedule view">
        ${TABS.map(([k, t]) => `<button type="button" role="tab" class="seg-tab${tab === k ? " is-on" : ""}" aria-selected="${tab === k}" data-tab="${k}">${t}${counts[k] ? `<em>${counts[k]}</em>` : ""}</button>`).join("")}
      </div>
      ${subjects.length || cats.length ? `<div class="sc-filters">
        <label class="fl-field"><span class="fl-lab">Subject</span><select data-sf="subject"><option value="">All subjects</option>${subjects.map((s) => `<option value="${esc(s.id)}"${s.id === subject ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <label class="fl-field"><span class="fl-lab">Category</span><select data-sf="category"><option value="">All categories</option>${cats.map((c) => `<option value="${esc(c.id)}"${c.id === category ? " selected" : ""}>${esc(H.categoryPathOf(tax, c.id) || c.name)}</option>`).join("")}</select></label>
      </div>` : ""}
    </div>`;
  }

  function rowsFor(items) {
    const filtered = H.filterExams(items, { subject, category }, { categories: M.feed.taxonomy.categories, now: model.now });
    const withPast = H.scheduleItems(filtered, model.now, { includePast: true, pastMs: PAST_WINDOW });
    const isPast = (it) => it.status.key === "completed" || it.status.key === "closed" || (it.status.key === "unavailable" && (it.status.endsAt ?? it.status.startsAt ?? 0) < model.now);
    if (tab === "live") return withPast.filter((it) => it.status.key === "live");
    if (tab === "past") return withPast.filter(isPast).sort((a, b) => (b.status.endsAt ?? b.status.startsAt ?? 0) - (a.status.endsAt ?? a.status.startsAt ?? 0));
    if (tab === "upcoming") return withPast.filter((it) => !isPast(it));
    return withPast;
  }

  function paint() {
    model = buildStudentModel(M);
    bar.innerHTML = barHtml();
    const rows = rowsFor(model.items);
    if (!rows.length) {
      body.innerHTML = emptyBlock("fa-calendar", tab === "past" ? "এখনো কোনো পুরোনো পরীক্ষা নেই।" : tab === "live" ? "এই মুহূর্তে কোনো পরীক্ষা চলছে না।" : "বর্তমানে কোনো পরীক্ষা scheduled নেই।", '<a class="btn btn-outline btn-sm" href="#/exams">সব পরীক্ষা দেখুন</a>');
    } else {
      body.innerHTML = H.groupByDay(rows, model.now).map((g) =>
        `<section class="sr-day"><h2 class="sr-day-title">${esc(dayHeading(g))}</h2><div class="sr-list">${g.rows.map((it) => scheduleRowHtml(it, model.ctx)).join("")}</div></section>`).join("");
    }
    startCountdowns(body, { onReach: () => paint() });
  }

  async function load(force) {
    M = await loadStudentContext(user, { force });
    if (my !== renderToken) return;
    if (M.catalogError) { bar.innerHTML = ""; body.innerHTML = errorBlock("schedule"); return; }
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    paint();
    const openId = params?.get?.("open");
    const it = openId && model.items.find((x) => x.exam.id === openId);
    if (it) openExamDetails(it, model.ctx);
  }
  await load(false);
  if (my !== renderToken) return;

  bindExamCardActions(body, (id) => {
    const it = model?.items.find((x) => x.exam.id === id);
    return it ? { item: it, ctx: model.ctx } : null;
  });
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 3); await load(true); });
  mount.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { tab = t.dataset.tab; paint(); }
  });
  mount.addEventListener("change", (e) => {
    const s = e.target.closest("[data-sf]");
    if (!s) return;
    if (s.dataset.sf === "subject") subject = s.value; else category = s.value;
    paint();
  });
  onPageLeave(() => stopCountdowns(body));
}
