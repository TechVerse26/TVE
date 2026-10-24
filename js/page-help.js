// ==========================================================================
// page-help.js — Help Center (#/help).
// The guides live in help-data.js, the questions they point to in faq-data.js, the shared building blocks in info-ui.js.
//
//   • search      type a question: the best FAQ answers appear right under the box; Enter opens every match in the FAQ
//   • guides      one section per topic (#/help?section=account …), each with the FAQ questions that go with it
//   • contact     support is the e-mail address — a real mailto: link with a prepared subject and checklist, plus a copy button.
//                 There is deliberately no ticket form, chat box or "live support": none exists, so none is drawn.
// Nothing here talks to Firebase: the page is public and static.
// ==========================================================================
import { renderNav } from "./nav.js";
import { HELP } from "./help-data.js";
import { FAQ } from "./faq-data.js";
import { SITE } from "./info-config.js";
import { esc, inline, plainInline, renderBlocks, searchFaq, sectionParam } from "./info-core.js";
import {
  INFO_CTX, pageShell, heroHtml, sectionHtml, cardHtml, gridHtml, stepsHtml, accordionHtml, btnHtml, supportMailto,
  bindJumpLinks, bindCopyButtons, scheduleDeepLink, SUPPORT_SUBJECT,
} from "./info-ui.js";
import { onPageLeave } from "./page-lifecycle.js";

let renderToken = 0;
const MAX_QUERY = 120;
const FAQ_BY_ID = new Map(FAQ.map((f) => [f.id, f]));

const icon = (name) => `<span class="card-icon" aria-hidden="true"><i class="fa-solid ${esc(name)}"></i></span>`;
const chevron = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';

/* ---------- hero: search + popular links ---------- */
const searchHtml = (S) => `<div class="inf-search" role="search">
    <div class="inf-search-box">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input type="search" id="help-q" name="q" maxlength="${MAX_QUERY}" placeholder="${esc(S.placeholder)}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" aria-label="${esc(S.label)}" aria-controls="help-suggest">
      <button type="button" class="inf-search-clear" data-act="clear" aria-label="Clear the search" hidden><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </div>
  </div>
  <div class="inf-suggest" id="help-suggest" hidden></div>
  <p class="sr-only" id="help-live" role="status" aria-live="polite"></p>
  <p class="inf-hero-links">Popular: ${S.popular.map(([label, href, jump]) => `<a href="${esc(href)}"${jump ? ` data-jump="${esc(jump)}"` : ""}>${esc(label)}</a>`).join(" · ")}</p>`;

/* ---------- pieces shared by the sections ---------- */
/** "Related questions": links into the FAQ for the questions that go with a section (text read from the FAQ itself, so it cannot drift). */
function relatedHtml(ids = []) {
  const items = ids.map((id) => FAQ_BY_ID.get(id)).filter(Boolean);
  if (!items.length) return "";
  return `<aside class="inf-related" aria-label="Related questions"><h3 class="inf-related-title">Related questions</h3>
    <ul role="list">${items.map((f) => `<li><a href="#/faq?open=${esc(f.id)}"><span>${esc(plainInline(f.q))}</span>${chevron}</a></li>`).join("")}</ul></aside>`;
}
const split = (main, related) => `<div class="inf-split"><div class="inf-split-main">${main}</div>${relatedHtml(related)}</div>`;
const prose = (blocks) => `<div class="inf-prose">${renderBlocks(blocks, INFO_CTX)}</div>`;
const howtoCard = (c) => `<article class="card inf-howto"><h3 class="inf-card-title">${esc(c.title)}</h3><ol class="inf-list inf-list--num">${c.steps.map((s) => `<li>${inline(s, INFO_CTX)}</li>`).join("")}</ol></article>`;
const ruledList = (items) => `<ul class="card inf-commit" role="list">${items.map((it) => `<li>${icon(it.icon)}<div class="inf-card-text"><h3 class="inf-card-title">${esc(it.title)}</h3><p class="inf-card-desc">${inline(it.text, INFO_CTX)}</p></div></li>`).join("")}</ul>`;

/* ---------- the sections ---------- */
function sections(H) {
  const g = H.gettingStarted, a = H.account, e = H.exams, r = H.rules, rs = H.results, lb = H.leaderboard, t = H.troubleshooting, p = H.privacy, c = H.contact;
  const mailto = supportMailto();
  return [
    sectionHtml({ id: g.id, title: g.title, sub: g.sub, body: split(stepsHtml(g.steps, { layout: "list" }), g.related) }),

    sectionHtml({ id: a.id, title: a.title, sub: a.sub, body: split(gridHtml(a.cards.map(howtoCard), 2), a.related) }),

    sectionHtml({
      id: e.id, title: e.title, sub: e.sub,
      body: split([
        gridHtml(e.where.map((w) => cardHtml(w)), 2),
        prose([{ h: e.legendTitle }, { dl: e.legend }, { h: e.startTitle }, { ol: e.start }, { h: e.greyedTitle }, { dl: e.greyed }]),
      ].join(""), e.related),
    }),

    sectionHtml({ id: r.id, title: r.title, sub: r.sub, body: split(gridHtml(r.items.map((it) => cardHtml(it)), 2), r.related) }),

    sectionHtml({ id: rs.id, title: rs.title, sub: rs.sub, body: split(gridHtml(rs.items.map((it) => cardHtml(it)), 2), rs.related) }),

    sectionHtml({
      id: lb.id, title: lb.title, sub: lb.sub,
      body: split(`${prose([{ ul: lb.points }])}<div class="inf-cta-row">${btnHtml({ href: lb.cta[1], label: lb.cta[0], icon: "fa-trophy", kind: "outline" })}</div>`, lb.related),
    }),

    sectionHtml({ id: t.id, title: t.title, sub: t.sub, body: accordionHtml(t.items.map((it) => ({ id: `help-${it.id}`, q: it.q, a: it.a }))) }),

    sectionHtml({ id: p.id, title: p.title, sub: p.sub, body: split(ruledList(p.items), p.related) }),

    sectionHtml({
      id: c.id, title: c.title, sub: c.sub,
      body: `<div class="card inf-contact">
        <div class="inf-contact-main">
          <p class="inf-contact-lead">${inline(c.lead, INFO_CTX)}</p>
          <a class="inf-contact-mail" href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>
          <div class="inf-contact-actions">
            ${btnHtml({ href: mailto, label: "Email support", icon: "fa-envelope" })}
            <button type="button" class="btn btn-outline" data-copy="${esc(SITE.email)}" data-copy-status="#help-copy-status"><i class="fa-regular fa-copy" aria-hidden="true"></i>Copy address</button>
          </div>
          <p class="inf-copy-status" id="help-copy-status" role="status" aria-live="polite"></p>
          <p class="inf-fineprint">${esc(c.mailNote)} Subject: “${esc(SUPPORT_SUBJECT)}”.</p>
        </div>
        <div class="inf-contact-side">
          <h3 class="inf-card-title">${esc(c.includeTitle)}</h3>
          <ul class="inf-checklist" role="list">${c.include.map((x) => `<li><i class="fa-solid fa-check" aria-hidden="true"></i><span>${inline(x, INFO_CTX)}</span></li>`).join("")}</ul>
          <aside class="inf-note inf-note--warn" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div>${inline(c.warn, INFO_CTX)}</div></aside>
        </div>
      </div>`,
    }),

    sectionHtml({ id: "more-help", title: "More help", sub: "", body: gridHtml(H.more.map((m) => cardHtml(m)), 3) }),
  ].join("");
}

const topicsHtml = (H) => sectionHtml({
  id: "topics", title: "Browse by topic", sub: "Pick a topic to jump straight to its guide.",
  body: gridHtml(H.topics.map((t) => cardHtml({ icon: t.icon, title: t.title, text: t.text, href: `#/help?section=${t.id}`, attrs: `data-jump="${esc(t.id)}"` })), 4),
});

/** The whole page as one html string. */
function pageHtml(H) {
  return pageShell("help", `${heroHtml({ ...H.hero, extra: searchHtml(H.search) })}${topicsHtml(H)}${sections(H)}`);
}

/* ---------- search box behaviour ---------- */
function bindSearch(root) {
  const input = root.querySelector("#help-q");
  const clearBtn = root.querySelector(".inf-search-clear");
  const box = root.querySelector("#help-suggest");
  const live = root.querySelector("#help-live");
  let liveTimer = 0;
  onPageLeave(() => clearTimeout(liveTimer));

  const faqLink = (q) => `#/faq?q=${encodeURIComponent(q)}`;

  function paint() {
    const q = input.value.trim().slice(0, MAX_QUERY);
    clearBtn.hidden = !input.value;
    clearTimeout(liveTimer);
    if (!q) { box.hidden = true; box.innerHTML = ""; live.textContent = ""; return; }
    const found = searchFaq(FAQ, q);
    const top = found.slice(0, 5);
    box.hidden = false;
    box.innerHTML = top.length
      ? `<p class="inf-suggest-head">Suggested answers</p><ul role="list">${top.map((r) => `<li><a href="#/faq?open=${esc(r.item.id)}"><span>${esc(plainInline(r.item.q))}</span>${chevron}</a></li>`).join("")}<li class="inf-suggest-more"><a href="${esc(faqLink(q))}"><span>See ${found.length === 1 ? "the result" : `all ${found.length} results`} in the FAQ</span>${chevron}</a></li></ul>`
      : `<p class="inf-suggest-head">No quick answer found</p><ul role="list"><li class="inf-suggest-more"><a href="${esc(faqLink(q))}"><span>Search the FAQ for “${esc(q)}”</span>${chevron}</a></li><li class="inf-suggest-more"><a href="#/help?section=contact" data-jump="contact"><span>Contact support</span>${chevron}</a></li></ul>`;
    const text = top.length ? `${found.length} suggested ${found.length === 1 ? "answer" : "answers"} below the search box.` : "No quick answer found.";
    liveTimer = setTimeout(() => { live.textContent = text; }, 450);       // announced once typing pauses
  }

  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    const q = input.value.trim();
    if (e.key === "Enter" && q) { e.preventDefault(); window.location.hash = faqLink(q.slice(0, MAX_QUERY)); }
    else if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; paint(); }
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest?.('[data-act="clear"]')) { input.value = ""; paint(); input.focus(); }
  });
}

/* ---------- the page ---------- */
export async function initHelpPage(params, mount) {
  const my = ++renderToken;
  await renderNav("help");
  if (my !== renderToken) return;

  mount.innerHTML = pageHtml(HELP);
  const root = mount.querySelector(".inf");
  bindSearch(root);
  bindJumpLinks(root);
  bindCopyButtons(root);
  scheduleDeepLink(root, sectionParam(params.get("section")));
}
