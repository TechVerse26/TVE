// ==========================================================================
// page-faq.js — Frequently Asked Questions (#/faq).
// The questions live in faq-data.js; the search ranking and the text safety rules in info-core.js; the accordion in info-ui.js.
//
//   • search      every word must appear (question, keywords or answer); best matches first; matches are highlighted
//   • categories  filter chips with live counts; "All" shows the questions grouped under their category headings
//   • accordion   a native <details> per question — Enter / Space / tap open it, nothing here is needed for it to work
//   • links       #/faq?q=reset+password · #/faq?cat=results · #/faq?open=forgot-password   (the Help Center uses these)
// Nothing here talks to Firebase: the page is public and static.
// ==========================================================================
import { renderNav } from "./nav.js";
import { FAQ, FAQ_CATEGORIES } from "./faq-data.js";
import { esc, searchFaq, highlightTerms, highlightHtml, sectionParam } from "./info-core.js";
import {
  pageShell, heroHtml, qaHtml, ctaHtml, btnHtml, emptyHtml, supportMailto, scheduleDeepLink,
} from "./info-ui.js";
import { onPageLeave } from "./page-lifecycle.js";

let renderToken = 0;

const CAT = Object.fromEntries(FAQ_CATEGORIES.map((c) => [c.id, c]));
const MAX_QUERY = 120;
const domId = (id) => `faq-${id}`;                  // ids in the page are prefixed: "timer" can never clash with something else in the app

const validCat = (v) => (CAT[v] ? v : "all");

/* ---------- pieces of markup ---------- */
const searchBox = (value) => `<div class="inf-search" role="search">
    <div class="inf-search-box">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input type="search" id="faq-q" name="q" value="${esc(value)}" maxlength="${MAX_QUERY}" placeholder="Search questions, e.g. reset password" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" aria-label="Search the frequently asked questions" aria-controls="faq-results" aria-describedby="faq-status">
      <button type="button" class="inf-search-clear" data-act="clear" aria-label="Clear the search"${value ? "" : " hidden"}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </div>
  </div>`;

const chipsHtml = (cat) => `<div class="inf-chips fl-chips" role="group" aria-label="Filter the questions by category">
    ${[{ id: "all", title: "All", icon: "" }, ...FAQ_CATEGORIES].map((c) => `<button type="button" class="fl-chip${c.id === cat ? " is-on" : ""}" data-cat="${esc(c.id)}" aria-pressed="${c.id === cat}">${esc(c.title)} <span class="inf-chip-n" data-n="${esc(c.id)}"></span></button>`).join("")}
  </div>`;

function pageHtml(state) {
  const hero = heroHtml({
    kicker: "FAQ",
    title: "Frequently Asked Questions",
    lead: "Quick answers about accounts, exams, results and more. Can’t find yours? Visit the [Help Center](#/help) or [contact support](#/help?section=contact).",
    extra: searchBox(state.q),
  });
  const tools = `<div class="inf-faq-tools">${chipsHtml(state.cat)}<p class="inf-status" id="faq-status" role="status" aria-live="polite"></p></div>`;
  const cta = ctaHtml({
    title: "Still need help?",
    text: "The [Help Center](#/help) has step-by-step guides. For anything else, email {email}.",
    actions: `${btnHtml({ href: "#/help", label: "Open the Help Center", icon: "fa-life-ring" })}${btnHtml({ href: supportMailto(), label: "Email support", icon: "fa-envelope", kind: "outline" })}`,
  });
  return pageShell("faq", `${hero}${tools}<div id="faq-results" class="inf-faq-groups"></div>${cta}`);
}

/** One category block (heading + accordion). */
const groupHtml = (cat, rows, { terms, openId, openAll }) => `<section class="inf-faq-group" aria-labelledby="faq-h-${esc(cat.id)}">
    <h2 class="inf-faq-h" id="faq-h-${esc(cat.id)}"><i class="fa-solid ${esc(cat.icon)}" aria-hidden="true"></i>${esc(cat.title)}<span class="inf-count">${rows.length}</span></h2>
    <div class="inf-acc">${rows.map((r) => qa(r.item, { terms, openId, openAll })).join("")}</div>
  </section>`;

function qa(item, { terms, openId, openAll, showCat = false }) {
  const html = qaHtml({ id: domId(item.id), q: item.q, a: item.a, open: openAll || item.id === openId, meta: showCat ? CAT[item.cat]?.title || "" : "" });
  return terms?.length ? highlightHtml(html, terms) : html;
}

/* ---------- the page ---------- */
export async function initFaqPage(params, mount) {
  const my = ++renderToken;
  await renderNav("faq");
  if (my !== renderToken) return;

  const state = {
    q: String(params.get("q") || "").slice(0, MAX_QUERY),
    cat: validCat(params.get("cat")),
  };
  const openId = sectionParam(params.get("open"));
  let pendingOpen = openId;                    // a ?open= question is opened once, by the first draw — typing afterwards must not reopen it

  mount.innerHTML = pageHtml(state);
  const root = mount.querySelector(".inf");
  const input = root.querySelector("#faq-q");
  const clearBtn = root.querySelector(".inf-search-clear");
  const results = root.querySelector("#faq-results");
  const status = root.querySelector("#faq-status");
  let statusTimer = 0;
  onPageLeave(() => clearTimeout(statusTimer));

  /** What the current search and category show: { all (matches in every category), shown (after the category filter) }. */
  function compute() {
    const all = searchFaq(FAQ, state.q);
    const shown = state.cat === "all" ? all : all.filter((r) => r.item.cat === state.cat);
    return { all, shown };
  }

  function updateChips(all) {
    const counts = { all: all.length };
    for (const r of all) counts[r.item.cat] = (counts[r.item.cat] || 0) + 1;
    const searching = !!state.q.trim();
    root.querySelectorAll("[data-cat]").forEach((chip) => {
      const id = chip.dataset.cat;
      const on = id === state.cat;
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.disabled = searching && !on && !counts[id];                    // a category with no match for this search is greyed out
      root.querySelector(`[data-n="${id}"]`).textContent = String(counts[id] || 0);
    });
  }

  function statusText(shown) {
    const n = shown.length, q = state.q.trim();
    const where = state.cat === "all" ? "" : ` in ${CAT[state.cat].title}`;
    if (!q) return `Showing ${n} ${n === 1 ? "question" : "questions"}${where || " in all categories"}.`;
    if (!n) return `No questions match “${q}”${where}.`;
    return `${n} ${n === 1 ? "question matches" : "questions match"} “${q}”${where}.`;
  }

  function render({ announceNow = false } = {}) {
    const { all, shown } = compute();
    const q = state.q.trim();
    const terms = q ? highlightTerms(q) : [];
    if (!shown.length) {
      const actions = [
        q ? '<button type="button" class="btn btn-outline btn-sm" data-act="clear">Clear search</button>' : "",
        state.cat !== "all" ? '<button type="button" class="btn btn-outline btn-sm" data-act="all-cats">Show all categories</button>' : "",
        btnHtml({ href: "#/help", label: "Help Center", icon: "fa-life-ring", kind: "outline", size: "sm" }),
        btnHtml({ href: supportMailto(), label: "Contact support", icon: "fa-envelope", size: "sm" }),
      ].join("");
      results.innerHTML = emptyHtml({ icon: "fa-face-meh", text: q ? "No questions found. Try fewer or different words, or ask us directly." : "There are no questions in this category yet.", actions });
    } else if (q) {
      // A search: one list, best match first, each question names its category. Few matches → show the answers straight away.
      const openAll = shown.length <= 3;
      results.innerHTML = `<section class="inf-faq-group" aria-label="Search results">
        <h2 class="inf-faq-h">Search results<span class="inf-count">${shown.length}</span></h2>
        <div class="inf-acc">${shown.map((r) => qa(r.item, { terms, openId: pendingOpen, openAll, showCat: true })).join("")}</div>
      </section>`;
    } else if (state.cat !== "all") {
      results.innerHTML = groupHtml(CAT[state.cat], shown, { terms, openId: pendingOpen });
    } else {
      results.innerHTML = FAQ_CATEGORIES
        .map((c) => ({ c, rows: shown.filter((r) => r.item.cat === c.id) }))
        .filter((g) => g.rows.length)
        .map((g) => groupHtml(g.c, g.rows, { terms, openId: pendingOpen }))
        .join("");
    }
    pendingOpen = "";
    updateChips(all);
    clearBtn.hidden = !state.q;
    // The live region is told once typing pauses (a screen reader would otherwise read out every keystroke).
    clearTimeout(statusTimer);
    const text = statusText(shown);
    if (announceNow) status.textContent = text;
    else statusTimer = setTimeout(() => { status.textContent = text; }, 450);
  }

  function setQuery(value, { focus = false } = {}) {
    state.q = value.slice(0, MAX_QUERY);
    input.value = state.q;
    render({ announceNow: true });
    if (focus) input.focus();
  }

  input.addEventListener("input", () => { state.q = input.value.slice(0, MAX_QUERY); render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.preventDefault(); setQuery(""); }
    else if (e.key === "Enter") input.blur();                          // a phone's keyboard closes and the answers are in view
  });

  root.addEventListener("click", (e) => {
    const chip = e.target.closest?.("[data-cat]");
    if (chip && root.contains(chip) && !chip.disabled) { state.cat = chip.dataset.cat; render({ announceNow: true }); return; }
    const act = e.target.closest?.("[data-act]");
    if (!act || !root.contains(act)) return;
    if (act.dataset.act === "clear") setQuery("", { focus: true });
    else if (act.dataset.act === "all-cats") { state.cat = "all"; render({ announceNow: true }); }
  });

  render({ announceNow: true });
  if (openId && !state.q.trim()) scheduleDeepLink(root, domId(openId));
}
