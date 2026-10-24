// ==========================================================================
// page-about.js — About Us (#/about).
// The words live in about-data.js (edit them there); the shared building blocks live in info-ui.js. Everything on this
// page is public: a visitor who is not signed in sees the same page, with "Create an account" as the main call to action.
// ==========================================================================
import { waitForAuth, setPostLoginRedirect } from "./utils.js";
import { renderNav } from "./nav.js";
import { ABOUT } from "./about-data.js";
import { esc, inline, sectionParam } from "./info-core.js";
import {
  INFO_CTX, pageShell, heroHtml, sectionHtml, cardHtml, gridHtml, stepsHtml, ctaHtml, btnHtml,
  bindJumpLinks, scheduleDeepLink,
} from "./info-ui.js";

let renderToken = 0;

const icon = (name) => `<span class="card-icon" aria-hidden="true"><i class="fa-solid ${esc(name)}"></i></span>`;

/** Our Story: two paragraphs next to an "at a glance" card. */
function storyHtml(s) {
  const glance = `<aside class="card inf-glance" aria-labelledby="h-glance">
      <h3 class="inf-glance-title" id="h-glance">${esc(s.glanceTitle)}</h3>
      <ul role="list">${s.glance.map((g) => `<li>${icon(g.icon)}<div class="inf-glance-text"><b>${esc(g.title)}</b><span>${inline(g.text, INFO_CTX)}</span></div></li>`).join("")}</ul>
    </aside>`;
  const body = `<div class="inf-story"><div class="inf-prose">${s.paragraphs.map((p) => `<p>${inline(p, INFO_CTX)}</p>`).join("")}</div>${glance}</div>`;
  return sectionHtml({ id: "story", title: s.title, sub: s.sub, body });
}

/** Mission + Vision: two real sections (each with its own heading and #anchor) side by side on a wide screen. */
const purposeHtml = (list) => `<div class="inf-purpose">${list.map((p) => sectionHtml({
  id: p.id, title: p.title, icon: p.icon,
  body: `<div class="card inf-purpose-card"><p>${inline(p.text, INFO_CTX)}</p></div>`,
})).join("")}</div>`;

/** A titled grid of icon cards. */
const gridSection = (id, block, cols) => sectionHtml({ id, title: block.title, sub: block.sub, body: gridHtml(block.items.map((it) => cardHtml(it)), cols) });

/** Our Commitment to Students: heading on the left, a ruled list on the right (stacked on a phone). */
function commitmentHtml(c) {
  const rows = c.items.map((it) => `<li>${icon(it.icon)}<div class="inf-card-text"><h3 class="inf-card-title">${esc(it.title)}</h3><p class="inf-card-desc">${inline(it.text, INFO_CTX)}</p></div></li>`).join("");
  return sectionHtml({ id: "commitment", title: c.title, sub: c.sub, cls: "inf-section--split", body: `<ul class="card inf-commit" role="list">${rows}</ul>` });
}

/** Accessible Learning: what is in place today, and an honest note — no conformance claim. */
function accessibilityHtml(a) {
  const body = `<div class="inf-a11y">
      <p class="inf-a11y-intro">${inline(a.intro, INFO_CTX)}</p>
      <ul class="inf-checklist" role="list">${a.points.map((p) => `<li><i class="fa-solid fa-check" aria-hidden="true"></i><span>${inline(p, INFO_CTX)}</span></li>`).join("")}</ul>
      <aside class="inf-note" role="note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i><div>${inline(a.note, INFO_CTX)}</div></aside>
    </div>`;
  return sectionHtml({ id: "accessibility", title: a.title, sub: a.sub, cls: "inf-section--split", body });
}

/** The closing band. Signed out: create an account (and a way to explore the exams, which asks for a login first). Signed in: go straight to the exams. */
function ctaBlock(c, signedIn) {
  const actions = signedIn
    ? `${btnHtml({ href: "#/exams", label: "Explore exams", icon: "fa-file-pen" })}${btnHtml({ href: "#/results", label: "View my results", icon: "fa-chart-simple", kind: "outline" })}`
    : `${btnHtml({ href: "#/signup", label: "Create an account", icon: "fa-user-plus" })}${btnHtml({ href: "#/exams", label: "Explore exams", icon: "fa-file-pen", kind: "outline", attrs: 'data-after-login="#/exams"' })}`;
  return ctaHtml({ title: c.title, text: signedIn ? c.textSignedIn : c.textSignedOut, actions });
}

/** The whole page as one html string (pure: no DOM, no Firebase). */
export function aboutPageHtml(signedIn) {
  const A = ABOUT;
  return pageShell("about", [
    heroHtml(A.hero),
    storyHtml(A.story),
    purposeHtml(A.purpose),
    gridSection("offer", A.offer, 2),
    gridSection("features", A.features, 3),
    sectionHtml({ id: "how", title: A.how.title, sub: A.how.sub, body: stepsHtml(A.how.steps) }),
    commitmentHtml(A.commitment),
    accessibilityHtml(A.accessibility),
    gridSection("values", A.values, 3),
    ctaBlock(A.cta, signedIn),
  ].join(""));
}

export async function initAboutPage(params, mount) {
  const my = ++renderToken;
  await renderNav("about");
  const user = await waitForAuth();
  if (my !== renderToken) return;

  mount.innerHTML = aboutPageHtml(!!user);
  const root = mount.querySelector(".inf");

  // "Explore exams" for a visitor who is not signed in: the exam list needs an account, so remember where they wanted to go.
  root.addEventListener("click", (e) => {
    const a = e.target.closest?.("[data-after-login]");
    if (a && root.contains(a)) setPostLoginRedirect(a.dataset.afterLogin);
  });
  bindJumpLinks(root);
  scheduleDeepLink(root, sectionParam(params.get("section")));
}
