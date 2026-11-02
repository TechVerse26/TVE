// ==========================================================================
// academic-render.js — every piece of markup the student-side Academic flow draws.
//
//   #/exam                                         the course cards (unchanged) + an "Academic Programs" block
//   #/exam?academicProgram=P                       the program's levels
//   #/exam?academicProgram=P&academicLevel=L       the level's subjects
//   …&academicSubject=S                            the subject dashboard: Upcoming / Live / Practice
//   …&academicSubject=S&type=practice              that subject's exams — drawn by the EXISTING exam list (exam-render.js renderExamList)
//
// No Firestore calls here (academic-data.js / exam-data.js), no rules here (academic-core.js) — only data → HTML.
// Loaded with a dynamic import() from exam.js: if anything in this flow ever fails, the course list keeps working.
// ==========================================================================
import { getExamBucket } from "./utils.js";
import { fetchAllExams } from "./exam-data.js";
import { isExamVisibleTo } from "./schedule-core.js";
import { state } from "./exam-engine.js";
import { setExamSectionHeader, renderExamList, HUB_TABS } from "./exam-render.js";
import { loadSections, loadSectionTree, loadSectionStats, loadMyEntitlements, loadCourseInfo, invalidateAcademic, isPermissionDenied } from "./academic-data.js";
import * as AC from "./academic-core.js";
import { cardHtml, bindCoverFallbacks, esc, plural, KIND_ICON } from "./academic-ui.js";

export const BLOCK_ID = "exam-academic-block";
export const CRUMBS_ID = "exam-breadcrumb";

const loadingHtml = `<div class="exs-loading"><span class="exs-spinner"></span> Loading...</div>`;
const isAdminUser = () => !!state.userProfile?.isAdmin;
const uid = () => state.currentUser?.uid || "";

/** Exams this student can see in lists (enrolment for course-linked ones, not unlisted). Comes from the cached exam catalog. */
async function listedExams() {
  const all = await fetchAllExams();
  return all.filter((e) => isExamVisibleTo(e, state.userProfile) && e.visibility !== "unlisted");
}

/* ==========================================================================
   Small building blocks: states, breadcrumb, notices
   ========================================================================== */
function stateHtml({ icon, title, text = "", note = "", actions = "", tone = "" }) {
  return `
    <div class="ac-state ${tone ? `ac-state--${tone}` : ""}" role="status">
      <span class="ac-state-ico"><i class="fa-solid ${esc(icon)}" aria-hidden="true"></i></span>
      <h2>${esc(title)}</h2>
      ${text ? `<p>${esc(text)}</p>` : ""}
      ${note ? `<p class="ac-state-note">${esc(note)}</p>` : ""}
      ${actions ? `<div class="ac-state-actions">${actions}</div>` : ""}
    </div>`;
}
const backLink = (href, label) => `<a class="btn btn-outline" href="${esc(href)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${esc(label)}</a>`;

function emptyHtml(icon, text) {
  return `<div class="exs-empty ac-span"><i class="fa-solid ${esc(icon)}"></i><p>${esc(text)}</p></div>`;
}

/** "Courses › SSC › Mathematics" above the page title. Everything but the last item is a link. */
function setBreadcrumb(items) {
  const view = document.getElementById("exam-list-view");
  const head = view?.querySelector(".page-head");
  if (!view || !head) return;
  let nav = document.getElementById(CRUMBS_ID);
  if (!nav) {
    nav = document.createElement("nav");
    nav.id = CRUMBS_ID;
    nav.className = "ac-crumbs";
    nav.setAttribute("aria-label", "Breadcrumb");
    view.insertBefore(nav, head);
  }
  nav.innerHTML = `<ol>${items.map((it, i) => (it.href && i < items.length - 1
    ? `<li><a href="${esc(it.href)}">${esc(it.label)}</a></li>`
    : `<li aria-current="page"><span>${esc(it.label)}</span></li>`)).join("")}</ol>`;
}

/** Shown on top of a page whose content is Paid and not unlocked for this student. */
function lockedNotice(verdict, name) {
  if (!verdict || !verdict.locked) return "";
  return `
    <div class="ac-notice ac-span" role="note">
      <i class="fa-solid fa-lock" aria-hidden="true"></i>
      <div><b>${esc(name)} is a paid program.</b>
      <p>You can look around, but its exams open only after your access is activated.</p></div>
    </div>`;
}

/* ==========================================================================
   #/exam — the Academic block under the course cards
   ========================================================================== */
export async function mountAcademicHome(grid, token) {
  let block = document.getElementById(BLOCK_ID);
  if (!block) {
    block = document.createElement("section");
    block.id = BLOCK_ID;
    block.className = "ac-block";
    block.setAttribute("aria-labelledby", "ac-block-title");
    grid.after(block);
  }
  block.hidden = true;
  block.innerHTML = "";
  try {
    const sections = await loadSections();
    if (state.navToken !== token) return;
    if (!sections.length) { block.remove(); return; }       // nothing published yet → the page looks exactly as before

    const [exams, stats, entitled] = await Promise.all([
      listedExams().catch(() => []),
      Promise.all(sections.map((s) => loadSectionStats(s.id).catch(() => null))),
      loadMyEntitlements(uid()).catch(() => new Set()),
    ]);
    if (state.navToken !== token) return;

    const cards = sections.map((s, i) => cardHtml(s, {
      href: AC.academicHash({ program: s.id }),
      verdict: AC.accessVerdict([s], entitled, { isAdmin: isAdminUser() }),
      meta: [
        stats[i] ? { icon: KIND_ICON.level, text: plural(stats[i].levels, "Level") } : null,
        { icon: "fa-file-pen", text: plural(AC.examsOfNode(exams, "section", s.id).length, "Exam") },
      ],
    })).join("");

    block.innerHTML = `
      <div class="section-head">
        <div class="section-head-text">
          <h2 class="section-title" id="ac-block-title"><i class="fa-solid fa-graduation-cap" aria-hidden="true"></i> Academic Programs</h2>
          <p class="section-sub">Pick a program, then a level and a subject.</p>
        </div>
      </div>
      <div class="ac-grid">${cards}</div>`;
    bindCoverFallbacks(block);
    block.hidden = false;
  } catch (err) {
    if (state.navToken !== token) return;
    // Rules not published yet (or this account may not read them): the page stays exactly as it was, with no block at all.
    if (isPermissionDenied(err)) { block.remove(); return; }
    console.warn("[academic] could not load the academic programs:", err);
    block.innerHTML = `
      <div class="ac-notice" role="note">
        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
        <div><b>Academic programs couldn't be loaded.</b><p>Check your connection and try again.</p></div>
        <button type="button" class="btn btn-outline btn-sm" data-ac-retry>Try again</button>
      </div>`;
    block.hidden = false;
    block.querySelector("[data-ac-retry]")?.addEventListener("click", () => { invalidateAcademic(); mountAcademicHome(grid, state.navToken); });
  }
}

/* ==========================================================================
   #/exam?academicProgram=… — the drill-down
   ========================================================================== */
export async function renderAcademicRoute(grid, parsed, token) {
  grid.classList.remove("exam-grid--courses", "exs-hub-grid");
  grid.innerHTML = loadingHtml;
  setBreadcrumb([{ label: "Courses", href: "#/exam" }, { label: "Academic" }]);
  setExamSectionHeader({ title: "Academic", sub: "", showBack: true, backHref: "#/exam" });

  const notFound = (what, backHref = "#/exam", backLabel = "Back to courses") => {
    setBreadcrumb([{ label: "Courses", href: "#/exam" }, { label: "Not found" }]);
    setExamSectionHeader({ title: "Not found", sub: "", showBack: true, backHref });
    grid.innerHTML = stateHtml({
      icon: "fa-compass", title: `This ${what} isn't available`,
      text: "It may have been removed, hidden by your teachers, or the link is incorrect.",
      actions: backLink(backHref, backLabel),
    });
  };

  if (parsed.invalid) { notFound("page"); return; }

  try {
    const tree = await loadSectionTree(parsed.program);
    if (state.navToken !== token) return;
    if (!tree) { notFound("program"); return; }

    const { section, levels, subjects } = tree;
    const level = parsed.level ? levels.find((l) => l.id === parsed.level) : null;
    if (parsed.level && !level) { notFound("level", AC.academicHash({ program: section.id }), `Back to ${section.name}`); return; }
    const subject = parsed.subject ? subjects.find((s) => s.id === parsed.subject && s.levelId === level.id) : null;
    if (parsed.subject && !subject) { notFound("subject", AC.academicHash({ program: section.id, level: level.id }), `Back to ${level.name}`); return; }

    const [exams, entitled] = await Promise.all([
      listedExams().catch(() => []),
      loadMyEntitlements(uid()).catch(() => new Set()),
    ]);
    if (state.navToken !== token) return;
    const ctx = { grid, token, section, level, subject, levels, subjects, exams, entitled, parsed };

    if (!level) renderLevels(ctx);
    else if (!subject) renderSubjects(ctx);
    else if (!parsed.type) renderSubjectHub(ctx);
    else await renderSubjectExams(ctx);
  } catch (err) {
    if (state.navToken !== token) return;
    console.warn("[academic] page failed:", err);
    grid.innerHTML = stateHtml({
      icon: "fa-triangle-exclamation", tone: "error", title: "Couldn't load this page",
      text: isPermissionDenied(err) ? "Academic programs aren't available for your account right now." : "Check your connection and try again.",
      actions: `<button type="button" class="btn btn-primary" data-ac-retry>Try again</button>${backLink("#/exam", "Back to courses")}`,
    });
    grid.querySelector("[data-ac-retry]")?.addEventListener("click", () => { invalidateAcademic(); renderAcademicRoute(grid, parsed, state.navToken); });
  }
}

const verdictFor = (chain, ctx) => AC.accessVerdict(chain, ctx.entitled, { isAdmin: isAdminUser() });

/* ---------- step 2: the levels of a program ---------- */
function renderLevels(ctx) {
  const { grid, section, levels, subjects, exams } = ctx;
  setBreadcrumb([{ label: "Courses", href: "#/exam" }, { label: section.name }]);
  setExamSectionHeader({ title: section.name, sub: section.description || "Choose your level", showBack: true, backHref: "#/exam" });

  const notice = lockedNotice(verdictFor([section], ctx), section.name);
  if (!levels.length) {
    grid.innerHTML = notice + emptyHtml("fa-layer-group", "No levels have been added to this program yet");
    return;
  }
  grid.innerHTML = `${notice}<div class="ac-grid">${levels.map((l) => cardHtml(l, {
    href: AC.academicHash({ program: section.id, level: l.id }),
    verdict: verdictFor([l, section], ctx),
    meta: [
      { icon: KIND_ICON.subject, text: plural(subjects.filter((s) => s.levelId === l.id).length, "Subject") },
      { icon: "fa-file-pen", text: plural(AC.examsOfNode(exams, "level", l.id).length, "Exam") },
    ],
  })).join("")}</div>`;
  bindCoverFallbacks(grid);
}

/* ---------- step 3: the subjects of ONE level (only that level's) ---------- */
function renderSubjects(ctx) {
  const { grid, section, level, subjects, exams } = ctx;
  const mine = subjects.filter((s) => s.levelId === level.id);
  setBreadcrumb([{ label: "Courses", href: "#/exam" }, { label: section.name, href: AC.academicHash({ program: section.id }) }, { label: level.name }]);
  setExamSectionHeader({ title: level.name, sub: level.description || "Choose a subject", showBack: true, backHref: AC.academicHash({ program: section.id }) });

  const notice = lockedNotice(verdictFor([level, section], ctx), level.name);
  if (!mine.length) {
    grid.innerHTML = notice + emptyHtml("fa-book-open", "No subjects have been added to this level yet");
    return;
  }
  grid.innerHTML = `${notice}<div class="ac-grid">${mine.map((s) => cardHtml(s, {
    href: AC.academicHash({ program: section.id, level: level.id, subject: s.id }),
    verdict: verdictFor([s, level, section], ctx),
    meta: [{ icon: "fa-file-pen", text: plural(subjectExams(exams, section, level, s).length, "Exam") }],
  })).join("")}</div>`;
  bindCoverFallbacks(grid);
}

/** Exams of one subject — all three ids must match, so an exam can only ever appear under its own subject. */
const subjectExams = (exams, section, level, subject) =>
  exams.filter((e) => e.academicSubjectId === subject.id && e.academicLevelId === level.id && e.academicProgramId === section.id);

/* ---------- the "no access" screen (Paid, no entitlement) ---------- */
function renderAccessDenied(ctx, verdict) {
  const { grid, section, level, subject } = ctx;
  const back = AC.academicHash({ program: section.id, level: level.id });
  grid.innerHTML = stateHtml({
    icon: "fa-lock", tone: "locked", title: "Premium access required",
    text: `${level.name} › ${subject.name} is part of a paid program, and your account doesn't have access to it yet.`,
    note: "Already paid? Access is switched on by the Tech Verse team — contact support with your registered email and it will be activated.",
    actions: `<a class="btn btn-primary" href="#/help?section=contact"><i class="fa-solid fa-headset" aria-hidden="true"></i> Contact support</a>${backLink(back, `Back to ${level.name}`)}`,
  });
  // the existing course this program is linked to (its title; Paid/Free by the existing pricing rule)
  const chain = [ctx.subject, ctx.level, ctx.section];
  const courseId = (chain.find((n) => n.id === verdict.nodeId) || {}).linkedCourseId || (chain.find((n) => n.linkedCourseId) || {}).linkedCourseId;
  if (courseId) {
    loadCourseInfo(courseId).then((info) => {
      const host = ctx.grid.querySelector(".ac-state");
      if (!info || !info.title || !host || state.navToken !== ctx.token) return;
      host.querySelector("h2")?.insertAdjacentHTML("afterend", `<p class="ac-state-course"><i class="fa-solid fa-link" aria-hidden="true"></i> Part of the course <b>${esc(info.title)}</b>${info.isPaid ? " (paid course)" : ""}</p>`);
    }).catch(() => {});
  }
}

/* ---------- step 4: the subject dashboard — Upcoming / Live / Practice ---------- */
function renderSubjectHub(ctx) {
  const { grid, section, level, subject, exams } = ctx;
  const back = AC.academicHash({ program: section.id, level: level.id });
  const crumbs = [{ label: "Courses", href: "#/exam" }, { label: section.name, href: AC.academicHash({ program: section.id }) }, { label: level.name, href: back }, { label: subject.name }];
  setBreadcrumb(crumbs);
  setExamSectionHeader({ title: subject.name, sub: subject.description || `${level.name} · exams for this subject`, showBack: true, backHref: back });

  const verdict = verdictFor([subject, level, section], ctx);
  if (!verdict.allowed) { renderAccessDenied(ctx, verdict); return; }

  const mine = subjectExams(exams, section, level, subject);
  if (!mine.length) {
    grid.innerHTML = emptyHtml("fa-file-pen", "No exams have been added to this subject yet");
    return;
  }
  const counts = { upcoming: 0, live: 0, practice: 0 };
  mine.forEach((e) => { counts[getExamBucket(e)]++; });
  grid.innerHTML = `<div class="ac-hub">${HUB_TABS.map((tab) => `
    <a href="${esc(AC.academicHash({ program: section.id, level: level.id, subject: subject.id, type: tab.key }))}" class="exs-hub-btn exs-hub-btn--${tab.key}">
      <div class="exs-hub-icon"><i class="fa-solid ${tab.icon}"></i></div>
      <div class="exs-hub-body"><h3>${esc(tab.label)}</h3><p>${esc(tab.sub)}</p></div>
      <span class="exs-hub-count">${counts[tab.key]}</span>
      <i class="fa-solid fa-chevron-right exs-hub-arrow"></i>
    </a>`).join("")}</div>`;
}

/* ---------- one bucket of one subject: the existing exam list, scoped ---------- */
async function renderSubjectExams(ctx) {
  const { grid, token, section, level, subject, parsed } = ctx;
  const hub = AC.academicHash({ program: section.id, level: level.id, subject: subject.id });
  const tab = HUB_TABS.find((t) => t.key === parsed.type);
  setBreadcrumb([
    { label: "Courses", href: "#/exam" }, { label: section.name, href: AC.academicHash({ program: section.id }) },
    { label: level.name, href: AC.academicHash({ program: section.id, level: level.id }) },
    { label: subject.name, href: hub }, { label: tab ? tab.label : "Exams" },
  ]);
  const verdict = verdictFor([subject, level, section], ctx);
  if (!verdict.allowed) {
    setExamSectionHeader({ title: subject.name, sub: "", showBack: true, backHref: hub });
    renderAccessDenied(ctx, verdict);
    return;
  }
  await renderExamList(grid, null, parsed.type, {
    scope: {
      // evaluated against the latest catalog on every repaint (countdown reached, cache refreshed): all three ids must match
      filter: (e) => subjectExams([e], section, level, subject).length === 1,
      backHref: hub,
      title: (t) => `${subject.name} · ${t ? t.label : "Exams"}`,
      sub: (n) => (n ? `${n} ${n === 1 ? "Exam" : "Exams"} Available` : "No Exams Available Yet"),
      emptyMessages: {
        upcoming: "No upcoming exams in this subject at the moment",
        live: "No live exams in this subject right now",
        practice: "No practice exams in this subject yet",
      },
    },
  });
  if (state.navToken !== token) return;
}
