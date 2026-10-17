// ==========================================================================
// page-categories.js — "All Categories" (#/categories) and one subject's page (#/categories?subject=<id>)
//
// Source: the same student model as All Exams (buildStudentModel → only exams this student may see), so counts can
// never include an exam that is hidden from them. Subjects/categories come from the admin taxonomy — nothing is
// hardcoded. A row leads to the existing All Exams list, pre-filtered (#/exams?subject=… / ?category=…).
// ==========================================================================
import { waitForAuth } from "./utils.js";
import { renderNav } from "./nav.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { onPageLeave } from "./page-lifecycle.js";
import * as H from "./home-core.js";
import { catStyle } from "./exam-card.js";
import { esc, emptyBlock, errorBlock, skeleton, onRetry, pageHeadBack } from "./home-ui.js";

let renderToken = 0;
const examsLabel = (n) => `${n} Exam${n === 1 ? "" : "s"}`;
const testsLabel = (n) => `${n} Test${n === 1 ? "" : "s"}`;

/* ---------- All Categories ---------- */
function subjectRows(m) {
  const tax = m.feed.taxonomy;
  const exams = m.items.map((it) => it.exam);
  return H.subjectRollup(tax, exams).map((s) => {
    const st = catStyle(s.name);
    const tags = H.tagLine(H.subjectTags(tax, exams, s.id));
    return { id: s.id, name: s.name, count: s.count, tags, st };
  });
}
function allHtml(rows, total) {
  return `<label class="cg-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input type="search" id="cg-q" placeholder="Search categories…" aria-label="Search categories" autocomplete="off"></label>
    <div class="cg-list" id="cg-list">${rows.map((r) => `<a class="cg-row" href="#/categories?subject=${encodeURIComponent(r.id)}" data-name="${esc(`${r.name} ${r.tags}`.toLowerCase())}">
        <span class="cg-ico" data-tone="${r.st.tone}" aria-hidden="true"><i class="fa-solid ${r.st.icon}"></i></span>
        <span class="cg-body"><b>${esc(r.name)}</b>${r.tags ? `<span class="cg-tags">${esc(r.tags)}</span>` : ""}<span class="cg-count">${examsLabel(r.count)}</span></span>
        <i class="fa-solid fa-chevron-right cg-go" aria-hidden="true"></i></a>`).join("")}</div>
    <p class="cg-empty hidden" id="cg-empty">এই নামে কোনো ক্যাটাগরি পাওয়া যায়নি।</p>
    <p class="cg-all"><a class="section-link" href="#/exams">Browse all ${total} exams <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></p>`;
}

/* ---------- One subject: banner, category chips, a row per category ---------- */
function subjectHtml(m, ctx, subject) {
  const tax = m.feed.taxonomy;
  const own = m.items.map((it) => it.exam).filter((e) => e.subjectId === subject.id);
  const roll = H.categoryRollup(tax, own);
  const top = roll.filter((c) => !c.parentId);
  const cats = top.length ? top : roll;
  const st = catStyle(subject.name);
  const tags = H.subjectTags(tax, own.map((e) => e), subject.id);   // same names the tile shows
  const sumPart = (set) => own.filter((e) => e.categoryId && set.has(e.categoryId)).reduce((n, e) => n + (Number(ctx.participants?.[e.id]) || 0), 0);
  const rows = cats.map((c) => {
    const set = H.categoryDescendants(tax.categories, [c.id]);
    const cs = catStyle(`${c.name} ${subject.name}`);
    const people = sumPart(set);
    return `<article class="cg-item" data-cat="${esc(c.id)}">
      <a class="cg-ico cg-ico--round" data-tone="${cs.tone}" href="#/exams?category=${encodeURIComponent(c.id)}" aria-hidden="true" tabindex="-1"><i class="fa-solid ${cs.icon}"></i></a>
      <div class="cg-body"><a class="cg-title" href="#/exams?category=${encodeURIComponent(c.id)}">${esc(c.name)}</a>
        <span class="cg-count">${testsLabel(c.count)}${people ? ` • ${people.toLocaleString("en")} participants` : ""}</span>
        <a class="btn btn-primary btn-sm cg-start" href="#/exams?category=${encodeURIComponent(c.id)}">Start Exam</a></div>
      <i class="fa-solid fa-chevron-right cg-go" aria-hidden="true"></i></article>`;
  });
  const loose = own.filter((e) => !e.categoryId).length;        // exams of this subject that sit directly under it
  if (loose || !cats.length) {
    rows.push(`<article class="cg-item" data-cat="">
      <a class="cg-ico cg-ico--round" data-tone="${st.tone}" href="#/exams?subject=${encodeURIComponent(subject.id)}" aria-hidden="true" tabindex="-1"><i class="fa-solid ${st.icon}"></i></a>
      <div class="cg-body"><a class="cg-title" href="#/exams?subject=${encodeURIComponent(subject.id)}">${cats.length ? "Other " : "All "}${esc(subject.name)} exams</a>
        <span class="cg-count">${testsLabel(cats.length ? loose : own.length)}</span>
        <a class="btn btn-primary btn-sm cg-start" href="#/exams?subject=${encodeURIComponent(subject.id)}">Start Exam</a></div>
      <i class="fa-solid fa-chevron-right cg-go" aria-hidden="true"></i></article>`);
  }
  return `<section class="cg-banner" aria-label="${esc(subject.name)}">
      <h2>${esc(subject.name)}</h2>
      <p>${tags.names.length ? `Prepare for ${esc(tags.names.join(", "))}${tags.more ? " and more" : ""} with our mock tests.` : `${examsLabel(own.length)} available — practice and test yourself.`}</p>
      <i class="fa-solid ${st.icon} cg-banner-ico" aria-hidden="true"></i></section>
    ${cats.length > 1 ? `<div class="fl-chips" role="group" aria-label="Filter by category">
      <button type="button" class="fl-chip is-on" data-chip="" aria-pressed="true">All</button>
      ${cats.map((c) => `<button type="button" class="fl-chip" data-chip="${esc(c.id)}" aria-pressed="false">${esc(c.name)}</button>`).join("")}</div>` : ""}
    <div class="cg-list" id="cg-list">${rows.join("")}</div>`;
}

export async function initCategoriesPage(params, mount) {
  const my = ++renderToken;
  await renderNav("categories");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { window.location.hash = "#/login"; return; }

  const subjectId = params?.get?.("subject") || "";
  mount.innerHTML = `<div class="container page">
    ${pageHeadBack(subjectId ? "Category" : "All Categories", "বিষয় ও ক্যাটাগরি অনুযায়ী পরীক্ষা খুঁজুন।")}
    <div id="cg-body">${skeleton("card", 3)}</div>
  </div>`;
  const body = mount.querySelector("#cg-body");

  async function load(force) {
    const M = await loadStudentContext(user, { force });
    if (my !== renderToken) return;
    if (M.catalogError) { body.innerHTML = errorBlock("categories"); return; }
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    const m = buildStudentModel(M);
    if (!m.items.length) { body.innerHTML = emptyBlock("fa-layer-group", "এখনো কোনো পরীক্ষা পাওয়া যায়নি।"); return; }
    if (!subjectId) {
      const rows = subjectRows(m);
      body.innerHTML = rows.length ? allHtml(rows, m.items.length)
        : emptyBlock("fa-layer-group", "কোনো ক্যাটাগরি সাজানো হয়নি।", '<a class="btn btn-outline btn-sm" href="#/exams">সব পরীক্ষা দেখুন</a>');
      return;
    }
    const subject = (m.feed.taxonomy.subjects || []).find((s) => s.id === subjectId);
    if (!subject) { body.innerHTML = emptyBlock("fa-face-meh", "এই ক্যাটাগরিটি পাওয়া যায়নি।", '<a class="btn btn-outline btn-sm" href="#/categories">সব ক্যাটাগরি</a>'); return; }
    mount.querySelector(".page-title").textContent = subject.name;
    body.innerHTML = subjectHtml(m, m.ctx, subject);
  }
  await load(false);
  if (my !== renderToken) return;
  onRetry(mount, async () => { body.innerHTML = skeleton("card", 3); await load(true); });

  const onInput = (e) => {                                   // client-side search over the rows already on screen
    if (e.target.id !== "cg-q") return;
    const q = e.target.value.trim().toLowerCase();
    let shown = 0;
    mount.querySelectorAll("#cg-list .cg-row").forEach((r) => { const hit = !q || r.dataset.name.includes(q); r.hidden = !hit; if (hit) shown++; });
    mount.querySelector("#cg-empty")?.classList.toggle("hidden", shown > 0);
  };
  const onClick = (e) => {                                   // category chips on a subject page
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    const id = chip.dataset.chip;
    mount.querySelectorAll(".fl-chip").forEach((c) => { const on = c === chip; c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", String(on)); });
    mount.querySelectorAll("#cg-list .cg-item").forEach((r) => { r.hidden = !!id && r.dataset.cat !== id; });
  };
  mount.addEventListener("input", onInput);
  mount.addEventListener("click", onClick);
  onPageLeave(() => { mount.removeEventListener("input", onInput); mount.removeEventListener("click", onClick); });
}
