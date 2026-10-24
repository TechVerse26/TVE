// ==========================================================================
// page-credits.js — Credits (#/credits).
// The people and the words live in credits-data.js (edit them there). Every entry goes through normalizeMember() in info-core.js,
// so a photo or a link that is not safe — or not on the website its type says — is left out instead of being drawn.
// The page is public: it is the same for a visitor who is signed out and for a signed-in student.
// ==========================================================================
import { renderNav } from "./nav.js";
import { CREDITS } from "./credits-data.js";
import { esc, inline, normalizeMember, tbcHtml, sectionParam } from "./info-core.js";
import {
  INFO_CTX, pageShell, heroHtml, sectionHtml, ctaHtml, btnHtml,
  bindJumpLinks, bindImageFallbacks, scheduleDeepLink,
} from "./info-ui.js";

let renderToken = 0;

/** The round picture: the person's photo, else their initials, else (a placeholder card) a plain person icon. */
function avatarHtml(m) {
  const person = '<i class="fa-solid fa-user"></i>';
  let inner = person;
  if (!m.placeholder) {
    inner = m.photo
      ? `<img src="${esc(m.photo)}" alt="" width="64" height="64" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fb="${esc(m.initials)}">`
      : esc(m.initials) || person;
  }
  return `<span class="user-avatar inf-avatar" aria-hidden="true">${inner}</span>`;   // the name is printed right next to it, so the picture itself says nothing
}

/** What a screen reader says for a profile link — the visible words ("LinkedIn") are inside it, and so is "opens in a new tab". */
function linkLabel(name, l) {
  const base = l.type === "email" ? `Email ${name}` : l.type === "website" ? `${name}’s website` : `${name} on ${l.label}`;
  return l.external ? `${base} (opens in a new tab)` : base;
}

const linksHtml = (m) => (m.links.length
  ? `<ul class="inf-member-links" role="list" aria-label="Profiles of ${esc(m.name)}">${m.links.map((l) =>
    `<li><a href="${esc(l.href)}"${l.external ? ' target="_blank" rel="noopener noreferrer"' : ""} aria-label="${esc(linkLabel(m.name, l))}"><i class="${esc(l.icon)}" aria-hidden="true"></i>${esc(l.label)}</a></li>`).join("")}</ul>`
  : "");

/** One team card. A placeholder card shows the wording of `team.placeholder` — never a name, a role or a photo. */
function memberHtml(m, i, T) {
  const ph = m.placeholder;
  const id = `member-${i + 1}-name`;
  const name = ph ? T.placeholder.name : m.name;
  const role = ph ? T.placeholder.role : m.role;
  const bio = ph ? T.placeholder.bio : m.bio;
  return `<article class="card inf-member${ph ? " is-placeholder" : ""}" aria-labelledby="${id}"${ph ? ' data-placeholder="true"' : ""}>
    <div class="inf-member-top">
      ${avatarHtml(m)}
      <div class="inf-member-id">
        <h3 class="inf-member-name" id="${id}">${esc(name)}</h3>
        ${role ? `<p class="inf-member-role">${esc(role)}</p>` : ""}
      </div>
    </div>
    ${bio ? `<p class="inf-member-bio">${esc(bio)}</p>` : ""}
    ${ph ? `<p class="inf-member-flag">${tbcHtml("team", T.placeholder.badge)}</p>` : linksHtml(m)}
  </article>`;
}

/** "Our Team": a note (only while some card is still a placeholder) and the grid. No cards at all → the section is left out. */
function teamHtml(T, members) {
  if (!members.length) return "";
  const pending = members.filter((m) => m.placeholder).length;
  const note = pending
    ? `<aside class="inf-note inf-note--tbc" role="note" data-pending="${pending}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i><div>${inline(T.placeholderNote, INFO_CTX)}</div></aside>`
    : "";
  const cards = members.map((m, i) => `<li>${memberHtml(m, i, T)}</li>`).join("");
  return sectionHtml({ id: "team", title: T.title, sub: T.sub, body: `<div class="inf-team-wrap">${note}<ul class="inf-team" role="list">${cards}</ul></div>` });
}

const introHtml = (s) => sectionHtml({
  id: "people", title: s.title, cls: "inf-section--split",
  body: `<div class="inf-prose">${s.paragraphs.map((p) => `<p>${inline(p, INFO_CTX)}</p>`).join("")}</div>`,
});

/** The tools the site really uses: a ruled list, name on the left, what it does on the right (stacked on a phone). */
const toolsHtml = (T) => (T.items.length
  ? sectionHtml({
    id: "tools", title: T.title, sub: T.sub,
    body: `<ul class="list-card inf-ack" role="list">${T.items.map((it) => `<li><b>${esc(it.name)}</b><span>${inline(it.text, INFO_CTX)}</span></li>`).join("")}</ul>`,
  })
  : "");

const closingHtml = (c) => ctaHtml({
  title: c.title,
  text: c.text,
  actions: `${btnHtml({ href: "#/about", label: "About Tech Verse Exam", icon: "fa-circle-info", kind: "outline" })}${btnHtml({ href: "#/help?section=contact", label: "Contact support", icon: "fa-envelope" })}`,
});

/** The whole page as one html string (pure: no DOM, no Firebase). `members` = CREDITS.team.members, already through normalizeMember(). */
export function creditsPageHtml(members = CREDITS.team.members.map(normalizeMember)) {
  const C = CREDITS;
  return pageShell("credits", [
    heroHtml(C.hero),
    introHtml(C.intro),
    teamHtml(C.team, members),
    toolsHtml(C.acknowledgements),
    closingHtml(C.closing),
  ].join(""));
}

export async function initCreditsPage(params, mount) {
  const my = ++renderToken;
  await renderNav("credits");
  if (my !== renderToken) return;

  const members = CREDITS.team.members.map(normalizeMember);
  const problems = members.flatMap((m) => m.problems);
  if (problems.length) console.warn(`Credits page — please check js/credits-data.js:\n• ${problems.join("\n• ")}`);   // for the site owner; visitors see nothing

  mount.innerHTML = creditsPageHtml(members);
  const root = mount.querySelector(".inf");
  bindImageFallbacks(root);
  bindJumpLinks(root);
  scheduleDeepLink(root, sectionParam(params.get("section")));
}
