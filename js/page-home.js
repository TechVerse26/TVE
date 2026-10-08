// ==========================================================================
// page-home.js — the student home dashboard (#/home).
//
// One screen that answers: what is live right now, what is next and when, what notices came, how am I
// doing, and what should I do next. Every section below is a small pure render function over ONE model
// (`buildStudentModel`) that is derived from data already cached by the data layer:
//
//   examIndex/main (catalog) · homeFeed/main (content, notices, categories, participants)
//   userStats/{uid} (my results) · leaderboard/publicStats (rank pool + top performers)
//   = 4 documents on a cold visit, then nothing for 5–10 minutes. No listeners, no per-exam reads.
//
// Time-dependent sections (hero, live, next, schedule, featured) are repainted by themselves when a
// countdown reaches zero, so the page never needs a refresh to flip an exam from Upcoming to Live.
// ==========================================================================
import { waitForAuth, toBnDigits } from "./utils.js";
import { renderNav } from "./nav.js";
import { getExamCatalog } from "./exam-data.js";
import { loadStudentContext, buildStudentModel } from "./student-data.js";
import { isDeviceClockOff } from "./server-time.js";
import { startCountdowns, stopCountdowns } from "./exam-timer.js";
import { dismissedNotices, dismissNotice, markRead, loadReadMap } from "./notify.js";
import { onPageLeave } from "./page-lifecycle.js";
import { humanizeBn, passPercentFor } from "./schedule-core.js";
import * as H from "./home-core.js";
import { examCardHtml, scheduleRowHtml, bindExamCardActions, ctaFor, examSubline, examFacts, openExamDetails, remindButtonHtml, detailsButtonHtml } from "./exam-card.js";
import { perfCellsHtml, perfBarsHtml } from "./perf-ui.js";
import {
  esc, fmtTime, fmtDate, fmtRange, tzLabel, dayHeading, sectionHead, emptyBlock, errorBlock, skeleton, ctaHtml, onRetry, statusBadge,
} from "./home-ui.js";

let renderToken = 0;
let lastForcedCatalogAt = 0;

/* Section slots, in display order. `duo` slots sit side by side on wide screens. */
const SLOTS = [
  "hero", "alerts", "info", "live", "next", "quick", "notices", "performance",
  { duo: ["results", "leaderboard"] }, "schedule", "featured", "categories", { duo: ["motivation", "guidelines"] },
];
const TIMED = ["hero", "live", "next", "schedule", "featured"]; // repainted when a countdown reaches zero

const QUICK = [
  { icon: "fa-file-pen", label: "All Exams", desc: "Browse and start", href: "#/exams" },
  { icon: "fa-calendar-days", label: "Schedule", desc: "Dates and times", href: "#/schedule" },
  { icon: "fa-square-poll-vertical", label: "My Results", desc: "Scores and review", href: "#/results" },
  { icon: "fa-trophy", label: "Leaderboard", desc: "Top performers", href: "#/leaderboard" },
  { icon: "fa-dumbbell", label: "Practice", desc: "Practise anytime", href: "#/exams?type=practice" },
  { icon: "fa-chart-line", label: "Performance", desc: "Average and pass rate", href: "#/performance" },
  { icon: "fa-bell", label: "Notifications", desc: "Updates and notices", href: "#/notifications", badge: "notif" },
  { icon: "fa-user", label: "Profile", desc: "Account and roll", href: "#/profile" },
];

/* ==========================================================================
   Public landing (signed out): static, zero Firestore reads
   ========================================================================== */
function publicLanding(mount) {
  mount.innerHTML = `
    <div class="container page">
      <section class="hm-hero hm-hero--public card card--highlight">
        <div class="hm-hero-main">
          <p class="hm-greet">Tech Verse Exam</p>
          <h1 class="hm-hero-title">${esc(H.DEFAULT_CONTENT.heroTitle)}</h1>
          <p class="hm-hero-line">লাইভ পরীক্ষা, প্র্যাকটিস, ফলাফল ও লিডারবোর্ড — সবকিছু এক জায়গায়। শুরু করতে লগইন করুন।</p>
          <div class="hm-cta"><a class="btn btn-primary" href="#/login">Login</a><a class="btn btn-outline" href="#/signup">Sign up</a></div>
        </div>
      </section>
      <section class="section" aria-labelledby="h-pub-features">
        ${sectionHead("h-pub-features", "What you get")}
        <div class="hm-quick hm-quick--info">
          ${[["fa-tower-broadcast", "Live exams", "নির্ধারিত সময়ে লাইভ পরীক্ষা ও কাউন্টডাউন"], ["fa-dumbbell", "Practice", "যেকোনো সময় প্র্যাকটিস, ঝুঁকিমুক্ত"], ["fa-square-poll-vertical", "Instant results", "জমা দিলেই স্কোর ও রিভিউ"], ["fa-trophy", "Leaderboard", "নিজের অবস্থান জানুন"]]
            .map(([i, t, d]) => `<div class="hm-qa hm-qa--static"><span class="hm-qa-icon"><i class="fa-solid ${i}" aria-hidden="true"></i></span><span><b>${t}</b><small>${d}</small></span></div>`).join("")}
        </div>
      </section>
      <section class="section" aria-labelledby="h-pub-guide">
        ${sectionHead("h-pub-guide", "Exam Guidelines")}
        <div class="card"><ul class="hm-guides">${H.DEFAULT_GUIDELINES.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>
      </section>
    </div>`;
}

const sectionOn = (m, key) => m.content.sections[key] !== false;
const bn = toBnDigits;

/* ==========================================================================
   Sections — each returns an HTML string ("" = hidden)
   ========================================================================== */
function heroHtml(m, M) {
  const c = m.content;
  const hn = H.heroNumbers(m.items, m.now);
  const live = H.liveItems(m.items);
  const next = H.nextExamItem(m.items);
  const first = H.firstName(M.name);
  let line;
  if (!m.items.length) line = "এখনো কোনো পরীক্ষা পাওয়া যায়নি।";
  else if (live.length) {
    const head = live.length === 1 ? `“${live[0].exam.title}”` : `${bn(live.length)}টি পরীক্ষা`;
    line = `এখন ${head} চলছে — আর ${live[0].status.msToEnd !== null ? humanizeBn(live[0].status.msToEnd) : "কিছুক্ষণ"} পর্যন্ত শুরু করা যাবে।`;
  } else if (next) line = `আপনার পরবর্তী পরীক্ষা ${humanizeBn(next.status.msToStart)} পরে।`;
  else line = "বর্তমানে কোনো পরীক্ষা scheduled নেই।";
  const today = hn.today ? `আজ আপনি ${bn(hn.today)}টি পরীক্ষা দিতে পারবেন।` : "";

  // Primary button: straight into the one live exam, else the list.
  const liveStartable = live.filter((it) => it.status.canStart);
  const hasAction = liveStartable.length > 0 || hn.available > 0;
  const primaryHref = liveStartable.length === 1 ? `#/exam?id=${encodeURIComponent(liveStartable[0].exam.id)}` : liveStartable.length > 1 ? "#/exams?status=live" : "#/exams";
  const primaryLabel = hasAction ? c.ctaText : "View Exams";

  return `<section class="hm-hero card card--highlight" aria-labelledby="h-hero">
    <div class="hm-hero-main">
    <p class="hm-greet">${first ? `Welcome back, ${esc(first)} 👋` : "Welcome back 👋"}</p>
    <h1 class="hm-hero-title" id="h-hero">${esc(c.heroTitle)}</h1>
    <p class="hm-hero-line">${esc(line)}${today ? ` <span class="hm-hero-today">${esc(today)}</span>` : ""}</p>
    ${c.heroSubtitle ? `<p class="hm-hero-sub">${esc(c.heroSubtitle)}</p>` : ""}
    <div class="hm-cta">
      <a class="btn btn-primary" href="${esc(primaryHref)}"><i class="fa-solid ${hasAction ? "fa-play" : "fa-file-pen"}" aria-hidden="true"></i> ${esc(primaryLabel)}</a>
      <a class="btn btn-outline" href="#/schedule"><i class="fa-regular fa-calendar" aria-hidden="true"></i> View Schedule</a>
    </div>
    </div>
    <ul class="hm-stats" aria-label="আজকের পরীক্ষার অবস্থা">
      <li class="${hn.live ? "is-live" : ""}"><b>${hn.live}</b><span>Live now</span></li>
      <li><b>${hn.upcoming}</b><span>Upcoming</span></li>
      <li><b>${hn.available}</b><span>Available</span></li>
      <li><b>${hn.today}</b><span>Today for you</span></li>
    </ul>
  </section>`;
}

function alertsHtml(m) {
  const out = [];
  if (m.maintenance) {
    const msg = m.site?.message || "";
    out.push(`<div class="hm-alert hm-alert--warn" role="status"><i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i><div><b>রক্ষণাবেক্ষণ চলছে</b><p>${esc(msg || "এই মুহূর্তে নতুন পরীক্ষা শুরু করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।")}</p></div></div>`);
  }
  if (isDeviceClockOff()) {
    out.push(`<div class="hm-alert" role="status"><i class="fa-regular fa-clock" aria-hidden="true"></i><div><b>আপনার ডিভাইসের সময় সঠিক নয়</b><p>কাউন্টডাউন ও সময়সূচি সার্ভারের সময় অনুযায়ী দেখানো হচ্ছে।</p></div></div>`);
  }
  return out.join("");
}

function liveHtml(m) {
  if (!sectionOn(m, "live")) return "";
  const live = H.liveItems(m.items);
  if (!live.length) return "";
  const shown = live.slice(0, 3);
  return `<section class="section hm-live" aria-labelledby="h-live">
    <div class="section-head"><div class="section-head-text"><h2 class="section-title" id="h-live"><span class="badge-dot" aria-hidden="true"></span> Live Now</h2>
      <p class="section-sub">এই মুহূর্তে চলছে — সময় শেষ হওয়ার আগেই শুরু করুন।</p></div>
      ${live.length > 3 ? `<a class="section-link" href="#/exams?status=live">All live (${live.length}) <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>` : ""}</div>
    <div class="hm-live-list">
      ${shown.map((it) => {
        const { exam, status } = it;
        const f = examFacts(exam, { defaultPass: m.ctx.defaultPass });
        const cta = ctaFor(it);
        if (cta.label === "Start Exam" || cta.label === "Retake Exam") cta.label = "Enter Exam";
        const p = Number(m.ctx.participants?.[exam.id]) || 0;
        return `<article class="lv" data-exam-id="${esc(exam.id)}">
          <div class="lv-main">
            <div class="lv-top">${statusBadge(status)}<span class="xc-kind">${f.practice ? "Practice" : "Live exam"}</span></div>
            <h3 class="lv-title">${esc(exam.title)}</h3>
            ${examSubline(exam, m.ctx.tax) ? `<p class="xc-sub">${esc(examSubline(exam, m.ctx.tax))}</p>` : ""}
            <dl class="lv-facts">
              <div class="lv-clock"><dt>Remaining</dt><dd data-countdown="${status.endsAt}" data-cd-zero="সময় শেষ"><span class="countdown-val">…</span></dd></div>
              <div><dt>Closes at</dt><dd>${status.endsAt !== null ? esc(fmtTime(status.endsAt)) : "—"}</dd></div>
              <div><dt>Duration</dt><dd>${f.duration ? `${f.duration} min` : "—"}</dd></div>
              <div><dt>Questions</dt><dd>${f.questions}</dd></div>
              ${p > 0 ? `<div><dt>Participants</dt><dd>${p}</dd></div>` : ""}
            </dl>
          </div>
          <div class="lv-cta">${ctaHtml(cta, { cls: "btn lv-btn" })}${detailsButtonHtml(exam)}</div>
        </article>`;
      }).join("")}
    </div>
  </section>`;
}

function noticeHtml(n, now, read) {
  const urgent = n.priority === "urgent";
  const pr = H.noticePriority(n.priority);
  const cat = H.noticeCategory(n.category);
  const long = n.body.length > 150 || n.body.includes("\n");
  const when = n.publishAt || n.createdAt;
  const link = n.examId ? `<a class="nt-link" href="#/exams?open=${encodeURIComponent(n.examId)}">View exam <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>`
    : n.courseId ? `<a class="nt-link" href="#/exam?course=${encodeURIComponent(n.courseId)}">Open course <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>` : "";
  return `<article class="nt nt--${esc(n.priority)}${read ? " is-read" : ""}" data-nid="${esc(n.id)}">
    <div class="nt-ico" aria-hidden="true"><i class="fa-solid ${urgent ? "fa-bell" : esc(cat.icon)}"></i></div>
    <div class="nt-body">
      <p class="nt-kicker">${urgent ? "গুরুত্বপূর্ণ ঘোষণা" : esc(cat.label)}<span class="badge badge-${n.priority === "urgent" ? "coral" : n.priority === "important" ? "amber" : "muted"}">${esc(pr.label)}</span>${when ? `<span class="nt-date">${esc(fmtDate(when, now))}</span>` : ""}</p>
      <h3 class="nt-title">${esc(n.title)}</h3>
      ${n.body ? `<p class="nt-text">${esc(n.body)}</p>` : ""}
      <div class="nt-actions">
        ${long ? '<button type="button" class="nt-btn" data-nt="more" aria-expanded="false">Read more</button>' : ""}
        ${read ? "" : '<button type="button" class="nt-btn" data-nt="read">Mark as read</button>'}
        ${link}
      </div>
    </div>
    <button type="button" class="nt-x" data-nt="close" aria-label="Dismiss notice"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
  </article>`;
}

function noticesHtml(m, M) {
  if (!sectionOn(m, "notices")) return "";
  const all = H.visibleNotices(m.feed.notices, { now: m.now, profile: M.profile, exams: M.catalog?.exams || [], categories: m.feed.taxonomy.categories });
  const hidden = dismissedNotices(M.uid);
  const shown = all.filter((n) => !hidden.has(n.id));
  if (!shown.length) return "";
  const read = loadReadMap(M.uid);
  const urgent = shown.filter((n) => n.priority === "urgent");
  const rest = shown.filter((n) => n.priority !== "urgent");
  const list = [...urgent, ...rest.slice(0, Math.max(0, 3 - urgent.length))];
  const more = shown.length - list.length;
  return `<section class="section hm-notices" aria-labelledby="h-notices">
    ${sectionHead("h-notices", "Notice Board", { icon: "fa-bullhorn", href: "#/notifications", action: more > 0 ? `All notices (${shown.length})` : "Notification centre" })}
    <div class="nt-list">${list.map((n) => noticeHtml(n, m.now, !!read[`notice:${n.id}`])).join("")}</div>
  </section>`;
}

function infoHtml(m) {
  const c = m.content;
  const out = [];
  if (c.info && sectionOn(m, "info")) {
    out.push(`<div class="hm-info" role="note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><p>${esc(c.info)}</p></div>`);
  }
  const b = c.banner;
  if (b.enabled && sectionOn(m, "banner") && (b.title || b.text)) {
    const href = H.safeHref(b.link);
    out.push(`<aside class="hm-banner">
      <div><h3>${esc(b.title)}</h3>${b.text ? `<p>${esc(b.text)}</p>` : ""}</div>
      ${href ? `<a class="btn btn-sm btn-primary" href="${esc(href)}"${href.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(b.linkText || "Learn more")}</a>` : ""}
    </aside>`);
  }
  return out.join("");
}

function nextHtml(m) {
  if (!sectionOn(m, "next")) return "";
  const next = H.nextExamItem(m.items);
  if (!next) {
    // Say "nothing scheduled" only when the page has nothing else to show about time.
    const anything = H.liveItems(m.items).length || H.scheduleItems(m.items, m.now).length;
    return anything ? "" : `<section class="section" aria-label="Next exam">${emptyBlock("fa-calendar", m.items.length ? "বর্তমানে কোনো পরীক্ষা scheduled নেই।" : "এখনো কোনো পরীক্ষা পাওয়া যায়নি।", '<a class="btn btn-outline btn-sm" href="#/exams">সব পরীক্ষা দেখুন</a>')}</section>`;
  }
  const { exam, status } = next;
  const f = examFacts(exam, { defaultPass: m.ctx.defaultPass });
  const cell = (key, label) => `<div class="nx-cell"><b data-cd="${key}">00</b><span>${label}</span></div>`;
  return `<section class="section" aria-labelledby="h-next">
    <div class="nx card card--highlight" data-exam-id="${esc(exam.id)}">
      <div class="nx-head">
        <p class="nx-kicker" id="h-next">NEXT EXAM ${status.key === "soon" ? '<span class="badge badge-soon">SOON</span>' : ""}</p>
        <h2 class="nx-title">${esc(exam.title)}</h2>
        ${examSubline(exam, m.ctx.tax) ? `<p class="xc-sub">${esc(examSubline(exam, m.ctx.tax))}</p>` : ""}
      </div>
      <div class="nx-timer">
        <p class="nx-lab">Starts in</p>
        <div class="nx-clock" data-countdown="${status.startsAt}" data-cd-mode="parts" role="timer" aria-label="পরীক্ষা শুরু হতে বাকি সময়">
          ${cell("days", "Days")}<i aria-hidden="true">:</i>${cell("hours", "Hours")}<i aria-hidden="true">:</i>${cell("minutes", "Minutes")}<i aria-hidden="true">:</i>${cell("seconds", "Seconds")}
        </div>
      </div>
      <div class="nx-body">
        <dl class="nx-facts">
          <div class="nx-when"><dt>Date &amp; time</dt><dd><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${esc(fmtRange(status.startsAt, status.endsAt, m.now))} <span class="nx-tz">${esc(tzLabel())}</span></dd></div>
          <div><dt>Duration</dt><dd>${f.duration ? `${f.duration} min` : "—"}</dd></div>
          <div><dt>Questions</dt><dd>${f.questions}</dd></div>
          <div><dt>Marks</dt><dd>${f.marks}</dd></div>
          ${f.difficulty ? `<div><dt>Level</dt><dd>${esc(f.difficulty.label)}</dd></div>` : ""}
        </dl>
        <div class="nx-actions">
          <button type="button" class="btn btn-sm btn-outline" disabled><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Coming Soon</button>
          ${remindButtonHtml(exam, m.ctx)}
          ${detailsButtonHtml(exam)}
        </div>
      </div>
    </div>
  </section>`;
}

function scheduleHtml(m) {
  if (!sectionOn(m, "schedule")) return "";
  const rows = H.scheduleItems(m.items, m.now).slice(0, 6);
  if (!rows.length) return "";
  const groups = H.groupByDay(rows, m.now);
  return `<section class="section" aria-labelledby="h-sched">
    ${sectionHead("h-sched", "Exam Schedule", { icon: "fa-calendar-days", sub: `Times shown in your local time (${tzLabel()})`, href: "#/schedule", action: "Full schedule" })}
    ${groups.map((g) => `<div class="sr-day"><h3 class="sr-day-title">${esc(dayHeading(g))}</h3><div class="sr-list">${g.rows.map((it) => scheduleRowHtml(it, m.ctx)).join("")}</div></div>`).join("")}
  </section>`;
}

function quickHtml(m, M) {
  if (!sectionOn(m, "quick")) return "";
  return `<section class="section" aria-labelledby="h-quick">
    ${sectionHead("h-quick", "Quick Actions", { icon: "fa-bolt" })}
    <nav class="hm-quick" aria-label="Quick actions">
      ${QUICK.map((q) => `<a class="hm-qa" href="${q.href}"><span class="hm-qa-icon"><i class="fa-solid ${q.icon}" aria-hidden="true"></i></span><span><b>${q.label}</b><small>${q.desc}</small></span>${q.badge === "notif" && M.unread > 0 ? `<em class="hm-qa-badge" aria-label="${M.unread} unread">${M.unread > 9 ? "9+" : M.unread}</em>` : ""}</a>`).join("")}
    </nav>
  </section>`;
}

function featuredHtml(m) {
  if (!sectionOn(m, "featured")) return "";
  const rank = { live: 0, soon: 1, upcoming: 2, open: 3 };
  const list = m.items
    .filter((it) => it.exam.featured === true && rank[it.status.key] !== undefined)
    .sort((a, b) => rank[a.status.key] - rank[b.status.key] || (a.status.startsAt ?? 0) - (b.status.startsAt ?? 0))
    .slice(0, 3);
  if (!list.length) return "";
  return `<section class="section" aria-labelledby="h-feat">
    ${sectionHead("h-feat", "Featured Exams", { icon: "fa-star", href: "#/exams", action: "All exams" })}
    <div class="xc-grid xc-grid--featured">${list.map((it) => examCardHtml(it, m.ctx, { featured: true })).join("")}</div>
  </section>`;
}

function categoriesHtml(m) {
  if (!sectionOn(m, "categories")) return "";
  const visible = m.items.map((it) => it.exam);
  const subjects = H.subjectRollup(m.feed.taxonomy, visible);
  const cats = H.categoryRollup(m.feed.taxonomy, visible);
  if (!subjects.length && !cats.length) return "";
  return `<section class="section" aria-labelledby="h-cats">
    ${sectionHead("h-cats", "Subjects & Categories", { icon: "fa-layer-group", href: "#/exams", action: "Browse all" })}
    ${subjects.length ? `<div class="hm-tiles">${subjects.slice(0, 8).map((s) => `<a class="hm-tile" href="#/exams?subject=${encodeURIComponent(s.id)}"><b>${esc(s.name)}</b><span>${s.count} exam${s.count > 1 ? "s" : ""}</span></a>`).join("")}</div>` : ""}
    ${cats.length ? `<div class="hm-chips" role="list">${cats.slice(0, 12).map((c) => `<a class="hm-chip" role="listitem" href="#/exams?category=${encodeURIComponent(c.id)}">${esc(c.name)} <em>${c.count}</em></a>`).join("")}</div>` : ""}
  </section>`;
}

function performanceHtml(m, M) {
  if (!sectionOn(m, "performance") || !M.stats) return "";
  const perf = H.performanceFromStats(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent });
  if (!perf.taken) return "";
  const rk = H.rankOf(M.pct?.percents, perf.ownLiveAvg);
  const recent = H.recentResultRows(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent, limit: 8 });
  const basis = perf.basis === "live" ? "Live exams · best attempt" : "Practice exams";
  return `<section class="section" aria-labelledby="h-perf">
    ${sectionHead("h-perf", "My Performance", { icon: "fa-chart-line", sub: basis, href: "#/performance", action: "Details" })}
    <div class="card">
      ${perfCellsHtml(perf, { rk, available: m.items.length })}
      ${perfBarsHtml(recent, passPercentFor(null, m.feed.passPercent))}
    </div>
  </section>`;
}

function resultsHtml(m, M) {
  if (!sectionOn(m, "results") || !M.stats) return "";
  const rows = H.recentResultRows(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent, limit: 4 });
  if (!rows.length) return "";
  return `<section class="section" aria-labelledby="h-res">
    ${sectionHead("h-res", "Recent Results", { icon: "fa-square-poll-vertical", href: "#/results", action: "View all" })}
    <div class="list-card section-fill">
      ${rows.map((r) => `<a class="rs" href="#/results">
        <div class="rs-main"><b>${esc(r.title)}</b><span>${r.at ? esc(fmtDate(r.at, m.now)) : ""}${r.type === "practice" ? " · Practice" : ""}</span></div>
        <div class="rs-score"><b>${esc(r.score)}/${esc(r.total)}</b><span>${r.percent}%</span></div>
        <span class="rs-pf badge ${r.pass ? "badge-pass is-pass" : "badge-fail is-fail"}">${r.pass ? "Pass" : "Fail"}</span>
        <span class="rs-view" aria-label="View result of ${esc(r.title)}"><span>View Result</span> <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
      </a>`).join("")}
    </div>
  </section>`;
}

function leaderboardHtml(m, M) {
  if (!sectionOn(m, "leaderboard")) return "";
  const top = H.topPerformers(M.pct, m.content.leaderboardNames, 5);
  const perf = M.stats ? H.performanceFromStats(M.stats, { examsById: m.examsById, defaultPass: m.feed.passPercent }) : null;
  const rk = H.rankOf(M.pct?.percents, perf?.ownLiveAvg);
  if (!top.length && !rk) return "";
  return `<section class="section" aria-labelledby="h-lb">
    ${sectionHead("h-lb", "Top Performers", { icon: "fa-trophy", href: "#/leaderboard", action: "Leaderboard" })}
    <div class="list-card section-fill">
      ${top.length ? `<ol class="lb-list">${top.map((t) => `<li class="lb-row lb-row--${t.rank <= 3 ? t.rank : "n"}"><span class="lb-rank">${t.rank}</span><span class="lb-name">${esc(t.name)}</span><b class="lb-pct">${t.percent}%</b></li>`).join("")}</ol>` : ""}
      ${rk ? `<p class="lb-me"><i class="fa-solid fa-ranking-star" aria-hidden="true"></i> Your Rank: <b>#${rk.rank}</b> <span>of ${rk.total}</span></p>` : ""}
    </div>
  </section>`;
}

function motivationHtml(m) {
  if (!sectionOn(m, "motivation")) return "";
  const q = H.pickMotivation(m.content, m.now);
  return `<section class="section" aria-labelledby="h-mot">
    ${sectionHead("h-mot", "Today's Motivation", { icon: "fa-seedling" })}
    <blockquote class="hm-quote card"><i class="fa-solid fa-quote-left" aria-hidden="true"></i><p>${esc(q.text)}</p></blockquote>
  </section>`;
}

function guidelinesHtml(m) {
  if (!sectionOn(m, "guidelines")) return "";
  return `<section class="section" aria-labelledby="h-guide">
    <details class="hm-details card" id="hm-guide-details">
      <summary><h2 class="section-title" id="h-guide"><i class="fa-solid fa-list-check" aria-hidden="true"></i>Exam Guidelines</h2><i class="fa-solid fa-chevron-down hm-caret" aria-hidden="true"></i></summary>
      <ul class="hm-guides">${H.guidelinesOf(m.content).map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
    </details>
  </section>`;
}

const RENDER = {
  hero: heroHtml, alerts: alertsHtml, live: liveHtml, notices: noticesHtml, info: infoHtml, next: nextHtml,
  schedule: scheduleHtml, quick: quickHtml, featured: featuredHtml, categories: categoriesHtml,
  performance: performanceHtml, results: resultsHtml, leaderboard: leaderboardHtml, motivation: motivationHtml, guidelines: guidelinesHtml,
};

/* ==========================================================================
   Page
   ========================================================================== */
const slotNames = SLOTS.flatMap((s) => (typeof s === "string" ? [s] : s.duo));

function shellHtml() {
  const slot = (n) => `<div class="hm-slot" data-slot="${n}" hidden></div>`;
  return `<div class="container page" id="hm-page">
    <div id="hm-skeleton" aria-hidden="true">${skeleton("hero")}${skeleton("card", 2)}</div>
    <div id="hm-root" hidden>
      ${SLOTS.map((s) => (typeof s === "string" ? slot(s) : `<div class="hm-duo">${s.duo.map(slot).join("")}</div>`)).join("")}
    </div>
  </div>`;
}

export async function initHomePage(params, mount) {
  const my = ++renderToken;
  await renderNav("home");
  const user = await waitForAuth();
  if (my !== renderToken) return;
  if (!user) { publicLanding(mount); return; }

  mount.innerHTML = shellHtml();
  const root = mount.querySelector("#hm-root");
  const skel = mount.querySelector("#hm-skeleton");

  let M = { uid: user.uid, profile: {}, name: "", catalog: null, catalogError: false, feed: null, stats: null, pct: null, reminders: new Set(), unread: 0 };
  let latestModel = null;
  let onceOpened = false;

  /* ----- painting ----- */
  function paint(names = slotNames) {
    const m = buildStudentModel(M);
    latestModel = m;
    for (const n of names) {
      const el = root.querySelector(`[data-slot="${n}"]`);
      if (!el) continue;
      let html = "";
      try {
        const needsCatalog = ["hero", "live", "next", "schedule", "featured", "categories", "performance"].includes(n);
        html = M.catalogError && needsCatalog
          ? (n === "hero" ? errorBlock("home") : "")
          : RENDER[n](m, M);
      } catch (err) {
        console.error(`home section "${n}" failed:`, err);
        html = errorBlock("home");
      }
      el.innerHTML = html;
      el.hidden = !html;
    }
    startCountdowns(root, { onReach: handleReach });
  }

  let reaching = false;
  async function handleReach() {
    if (reaching) return;
    reaching = true;
    try {
      // An exam just crossed a boundary. Re-read the catalog once (max once a minute) so a schedule the admin
      // changed in the meantime is picked up, then repaint — no page refresh needed.
      if (Date.now() - lastForcedCatalogAt > 60 * 1000) {
        lastForcedCatalogAt = Date.now();
        try { M.catalog = await getExamCatalog({ force: true }); } catch { /* keep what we have */ }
      }
      if (my !== renderToken) return;
      const before = H.liveItems(buildStudentModel(M).items).length;
      paint(TIMED);
      if (H.liveItems(latestModel.items).length > before) {
        const liveEl = root.querySelector('[data-slot="live"]');
        liveEl?.classList.add("hm-flash");
        setTimeout(() => liveEl?.classList.remove("hm-flash"), 2400);
      }
    } finally { reaching = false; }
  }

  /* ----- loading ----- */
  async function load({ force = false } = {}) {
    const next = await loadStudentContext(user, { force, rank: true });
    if (my !== renderToken) return false;
    M = { ...next, unread: 0 };
    window.dispatchEvent(new CustomEvent("tvexam:data-ready"));
    // Unread badge for the Notifications quick action (cache-only, no reads).
    try {
      const { peekNotificationFeed, unreadCount } = await import("./notify.js");
      const feedItems = peekNotificationFeed(user.uid, M.profile);
      M.unread = feedItems ? unreadCount(feedItems, loadReadMap(user.uid)) : 0;
    } catch { M.unread = 0; }
    return true;
  }

  const first = await load();
  if (!first) return;
  skel.remove();
  root.hidden = false;
  paint();
  if (window.matchMedia("(min-width: 900px)").matches) root.querySelector("#hm-guide-details")?.setAttribute("open", "");

  /* ----- interactions ----- */
  bindExamCardActions(root, (id) => {
    const it = latestModel?.items.find((x) => x.exam.id === id);
    return it ? { item: it, ctx: latestModel.ctx } : null;
  });
  onRetry(root, async () => {
    skel.remove();
    root.querySelectorAll("[data-slot]").forEach((el) => { el.hidden = true; });
    const ok = await load({ force: true });
    if (ok) { root.hidden = false; paint(); }
  });
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nt]");
    if (!btn) return;
    const card = btn.closest(".nt");
    const nid = card?.dataset.nid;
    if (!nid) return;
    if (btn.dataset.nt === "more") {
      const open = card.classList.toggle("is-open");
      btn.textContent = open ? "Show less" : "Read more";
      btn.setAttribute("aria-expanded", String(open));
    } else if (btn.dataset.nt === "read") {
      markRead(user.uid, `notice:${nid}`);
      card.classList.add("is-read");
      btn.remove();
    } else if (btn.dataset.nt === "close") {
      dismissNotice(user.uid, nid);
      markRead(user.uid, `notice:${nid}`);
      const slot = card.closest("[data-slot]");
      card.remove();
      if (slot && !slot.querySelector(".nt")) { slot.innerHTML = ""; slot.hidden = true; }
    }
  });

  // ?open=<examId> (from a notification / reminder link) → show that exam's details once.
  const openId = params?.get?.("open");
  if (openId && !onceOpened) {
    onceOpened = true;
    const it = latestModel.items.find((x) => x.exam.id === openId);
    if (it) openExamDetails(it, latestModel.ctx);
  }

  /* ----- keep the hero sentence honest, and refresh after a long absence ----- */
  const tick = setInterval(() => { if (document.visibilityState === "visible") paint(["hero"]); }, 30 * 1000);
  const onVisible = async () => {
    if (document.visibilityState !== "visible" || my !== renderToken) return;
    await load(); // cached → a real read only if the 5-minute cache has expired
    if (my === renderToken) paint();
  };
  document.addEventListener("visibilitychange", onVisible);
  onPageLeave(() => {
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisible);
    stopCountdowns(root);
  });
}
