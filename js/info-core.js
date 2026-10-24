// ==========================================================================
// info-core.js — the pure logic behind the six information pages (About · FAQ · Help · Privacy · Terms · Credits).
//
// No DOM, no Firebase, no clock: strings in, strings out — so tests/unit/info.test.mjs pins every rule down in Node.
//
//   inline()          the tiny, safe mark-up used by every content file:
//                       **bold**   [label](#/route · https://… · mailto:…)   {email} {site} {name}   {owner:key}
//   renderBlocks()    content blocks  { p } { h } { ul } { ol } { note } { dl } { table }  →  HTML
//   searchFaq()       the FAQ search: every word must match · question > keywords > answer · best match first
//   highlightHtml()   wraps matched words in <mark> — in text only, never inside a tag or an entity
//   mailtoHref()      a mailto: link with a prepared subject and body
//   safeHref() / safeExternalUrl() / safeImageSrc()   the only kinds of address a page is allowed to print
//
// Every piece of text is escaped HERE, once. Page modules never glue raw strings into HTML themselves.
// ==========================================================================

/* ==========================================================================
   Escaping and addresses
   ========================================================================== */
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

const ROUTE_RE = /^#\/[A-Za-z0-9_\-/?=&%.]*$/;
const MAILTO_RE = /^mailto:[^\s"'<>]+$/i;
const HTTPS_RE = /^https:\/\/[^\s"'<>]+$/i;
const NEW_TAB = '<span class="sr-only"> (opens in a new tab)</span>';

/** An https address with a real host (a dot, no user:password@ trick) — or "". */
export function safeExternalUrl(url) {
  const s = String(url ?? "").trim();
  if (!HTTPS_RE.test(s)) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return "";
    return s;
  } catch { return ""; }
}

/** The link target when it is one of the three kinds the pages use — an in-app #/route, a mailto: or https — otherwise "". */
export function safeHref(href) {
  const s = String(href ?? "").trim();
  if (!s) return "";
  if (ROUTE_RE.test(s)) return s;
  if (MAILTO_RE.test(s)) return s;
  return safeExternalUrl(s);
}

/** A photo that may be drawn: an https address, or a picture file inside the project's own assets/ folder. */
export function safeImageSrc(src) {
  const s = String(src ?? "").trim();
  if (!s) return "";
  if (/^assets\/[A-Za-z0-9_\-/.]+\.(png|jpe?g|webp|avif|gif|svg)$/i.test(s) && !s.includes("..") && !s.includes("//")) return s;
  return safeExternalUrl(s);
}

/** <a> for a label + target. Unsafe target → the label alone (never a dead or dangerous link). https opens in a new tab. */
export function linkHtml(label, href) {
  const h = safeHref(href);
  if (!h) return esc(label);
  const external = h.startsWith("https:");
  return `<a href="${esc(h)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(label)}${external ? NEW_TAB : ""}</a>`;
}

/** mailto:address?subject=…&body=… — or "" when the address is not an address. Line breaks become CRLF, as RFC 6068 asks. */
export function mailtoHref({ to, subject = "", body = "" } = {}) {
  const addr = String(to ?? "").trim();
  if (!/^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+$/.test(addr)) return "";
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [];
  if (subject) query.push(`subject=${enc(String(subject))}`);
  if (body) query.push(`body=${enc(String(body).replace(/\r?\n/g, "\r\n"))}`);
  return `mailto:${addr}${query.length ? `?${query.join("&")}` : ""}`;
}

/* ==========================================================================
   Inline mark-up → HTML
   ========================================================================== */
const TOKEN_SPLIT = /(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|\{[A-Za-z]+(?::[A-Za-z0-9]+)?\})/;
const LINK_TOKEN = /^\[([^\]]+)\]\(([^)]+)\)$/;

/**
 * Text with the small mark-up → safe HTML. Everything that is not a token is escaped.
 * ctx.token(name, arg) answers {name} / {name:arg} tokens with ready HTML (see makeTokenResolver); without it they print nothing.
 */
export function inline(text, ctx = {}) {
  return String(text ?? "").split(TOKEN_SPLIT).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    if (part.startsWith("**")) return `<strong>${esc(part.slice(2, -2))}</strong>`;
    if (part.startsWith("[")) {
      const m = LINK_TOKEN.exec(part);
      return m ? linkHtml(m[1], m[2]) : esc(part);
    }
    const [name, arg] = part.slice(1, -1).split(":");
    return typeof ctx.token === "function" ? String(ctx.token(name, arg) ?? "") : "";
  }).join("");
}

/** The same text without any mark-up (search index, aria labels). {tokens} print nothing. */
export function plainInline(text) {
  return String(text ?? "").split(TOKEN_SPLIT).map((part, i) => {
    if (i % 2 === 0) return part;
    if (part.startsWith("**")) return part.slice(2, -2);
    if (part.startsWith("[")) { const m = LINK_TOKEN.exec(part); return m ? m[1] : ""; }
    return "";
  }).join("");
}

/* ==========================================================================
   Content blocks → HTML
     "text"                      a paragraph            { p: "text" }
     { h: "Heading" }            a sub-heading (h3)
     { ul: ["a", "b"] }          a bulleted list        { ol: [...] }  a numbered list
     { note: "text", tone }      a call-out · tone: info (default) | warn | tbc
     { dl: [["Term", "text"]] }  a definition list
     { table: { caption, cols: [...], rows: [[...]] } }   a table (stacks into cards on phones — see info-pages.css)
   ========================================================================== */
const NOTE_ICON = { info: "fa-circle-info", warn: "fa-triangle-exclamation", tbc: "fa-pen-to-square" };

function noteHtml(block, ctx) {
  const tone = NOTE_ICON[block.tone] ? block.tone : "info";
  return `<aside class="inf-note inf-note--${tone}" role="note"><i class="fa-solid ${NOTE_ICON[tone]}" aria-hidden="true"></i><div>${inline(block.note, ctx)}</div></aside>`;
}

function tableHtml(t, ctx) {
  const cols = Array.isArray(t.cols) ? t.cols : [];
  const rows = Array.isArray(t.rows) ? t.rows : [];
  const head = `<thead><tr role="row">${cols.map((c) => `<th scope="col" role="columnheader">${inline(c, ctx)}</th>`).join("")}</tr></thead>`;
  const body = rows.map((row) => `<tr role="row">${row.map((cell, i) => (i === 0
    ? `<th scope="row" role="rowheader" data-label="${esc(plainInline(cols[0]))}">${inline(cell, ctx)}</th>`
    : `<td role="cell" data-label="${esc(plainInline(cols[i]))}">${inline(cell, ctx)}</td>`)).join("")}</tr>`).join("");
  return `<div class="inf-table-wrap"><table class="inf-table" role="table">${t.caption ? `<caption class="sr-only">${esc(plainInline(t.caption))}</caption>` : ""}${head}<tbody>${body}</tbody></table></div>`;
}

function blockHtml(b, ctx) {
  if (typeof b === "string") return `<p>${inline(b, ctx)}</p>`;
  if (!b || typeof b !== "object") return "";
  if ("p" in b) return `<p>${inline(b.p, ctx)}</p>`;
  if ("h" in b) return `<h3 class="inf-h3">${inline(b.h, ctx)}</h3>`;
  if ("ul" in b) return `<ul class="inf-list">${b.ul.map((x) => `<li>${inline(x, ctx)}</li>`).join("")}</ul>`;
  if ("ol" in b) return `<ol class="inf-list inf-list--num">${b.ol.map((x) => `<li>${inline(x, ctx)}</li>`).join("")}</ol>`;
  if ("note" in b) return noteHtml(b, ctx);
  if ("dl" in b) return `<dl class="inf-dl">${b.dl.map(([t, d]) => `<div><dt>${inline(t, ctx)}</dt><dd>${inline(d, ctx)}</dd></div>`).join("")}</dl>`;
  if ("table" in b) return tableHtml(b.table, ctx);
  return "";
}

export function renderBlocks(blocks, ctx = {}) {
  const list = Array.isArray(blocks) ? blocks : [blocks];
  return list.map((b) => blockHtml(b, ctx)).join("");
}

/** Plain text of a content value (string · block · array of blocks) — what the FAQ search reads. */
export function plainBlocks(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return plainInline(value);
  if (Array.isArray(value)) return value.map(plainBlocks).join(" ");
  if (typeof value !== "object") return "";
  if ("table" in value) return [value.table?.caption, ...(value.table?.cols || []), ...(value.table?.rows || []).flat()].map(plainInline).join(" ");
  if ("dl" in value) return value.dl.flat().map(plainInline).join(" ");
  for (const key of ["p", "h", "note"]) if (key in value) return plainInline(value[key]);
  for (const key of ["ul", "ol"]) if (key in value) return value[key].map(plainInline).join(" ");
  return "";
}

/* ==========================================================================
   Small helpers
   ========================================================================== */
/** "Data & Storage" → "data-and-storage" */
export function slugify(text) {
  const s = String(text ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "section";
}

/** Gives every section a stable, unique id (from its title unless it has one) and a 1-based number. */
export function prepareSections(sections) {
  const used = new Set();
  return sections.map((s, i) => {
    const base = slugify(s.id || s.title);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { ...s, id, num: i + 1 };
  });
}

/** A ?section= value from the address bar, reduced to what an id may contain. */
export const sectionParam = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10-22" → "22 October 2026" (no time zone maths: a date is a date). Anything else → "". */
export function formatLongDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return "";
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

/** "Rahim Uddin" → "RU" · "Rahim" → "RA" · "(Dr.) A. Rahman" → "AR" · "" or only symbols → "" (the page then draws an icon instead). Letters and digits only. */
export function initialsOf(name) {
  const letters = (w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  const words = String(name ?? "").trim().split(/\s+/).map(letters).filter((w) => w.length);
  if (!words.length) return "";
  const first = words[0];
  const second = words.length > 1 ? words[words.length - 1][0] : first[1];
  return `${first[0]}${second || ""}`.toUpperCase();
}

/* ==========================================================================
   Team members   (credits-data.js → the Credits page)
   ========================================================================== */
/** The kinds of profile link a member may have: its name, its icon, and the hosts it may point at (null = any https address). */
export const PROFILE_LINK_TYPES = Object.freeze({
  website: { label: "Website", icon: "fa-solid fa-globe", hosts: null },
  linkedin: { label: "LinkedIn", icon: "fa-brands fa-linkedin-in", hosts: ["linkedin.com"] },
  github: { label: "GitHub", icon: "fa-brands fa-github", hosts: ["github.com"] },
  facebook: { label: "Facebook", icon: "fa-brands fa-facebook-f", hosts: ["facebook.com", "fb.com"] },
  youtube: { label: "YouTube", icon: "fa-brands fa-youtube", hosts: ["youtube.com", "youtu.be"] },
  telegram: { label: "Telegram", icon: "fa-brands fa-telegram", hosts: ["t.me", "telegram.me"] },
  email: { label: "Email", icon: "fa-solid fa-envelope", hosts: null },        // for this type `url` is an e-mail address
});

const onHost = (host, hosts) => !hosts || hosts.some((h) => host === h || host.endsWith(`.${h}`));
const squash = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
export const BIO_SOFT_LIMIT = 600;

/**
 * One entry of credits-data.js → exactly what the Credits page may draw. Nothing is invented and nothing unsafe gets through:
 *   • no name  → a PLACEHOLDER card (placeholder: true). Whatever else was typed on it is ignored — nobody is credited without a name;
 *   • photo    → an https address or a file inside assets/ (safeImageSrc), otherwise dropped;
 *   • each link → https on the host that belongs to its type (a "linkedin" link has to be on linkedin.com); an email has to be an address;
 *                 anything else is dropped;
 *   • problems → one plain sentence for everything that was dropped or is missing, so the owner finds out. The unit test fails on any
 *                 problem in the shipped data, and the page prints them to the browser console.
 */
export function normalizeMember(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  const name = squash(m.name);
  const problems = [];

  if (!name) {
    const extra = ["role", "bio", "photo"].filter((k) => squash(m[k])).concat(Array.isArray(m.links) && m.links.length ? ["links"] : []);
    if (extra.length) problems.push(`a card without a name stays a placeholder — its ${extra.join(", ")} will not be shown until a name is added`);
    return { placeholder: true, name: "", role: "", bio: "", photo: "", initials: "", links: [], problems };
  }

  const role = squash(m.role);
  if (!role) problems.push(`${name}: no role or contribution given`);
  const bio = squash(m.bio);
  if (bio.length > BIO_SOFT_LIMIT) problems.push(`${name}: the biography is longer than ${BIO_SOFT_LIMIT} characters — keep it to a sentence or two`);

  const photoText = squash(m.photo);
  const photo = photoText ? safeImageSrc(photoText) : "";
  if (photoText && !photo) problems.push(`${name}: photo “${photoText}” ignored — use an https address or a picture file inside assets/`);

  const links = [];
  for (const entry of Array.isArray(m.links) ? m.links : []) {
    const type = squash(entry?.type).toLowerCase();
    const spec = Object.prototype.hasOwnProperty.call(PROFILE_LINK_TYPES, type) ? PROFILE_LINK_TYPES[type] : null;
    if (!spec) { problems.push(`${name}: link type “${squash(entry?.type)}” is unknown — use one of ${Object.keys(PROFILE_LINK_TYPES).join(", ")}`); continue; }
    const target = squash(entry?.url);
    let href = "";
    if (type === "email") href = mailtoHref({ to: target });
    else {
      href = safeExternalUrl(target);
      if (href) { try { if (!onHost(new URL(href).hostname.toLowerCase(), spec.hosts)) href = ""; } catch { href = ""; } }
    }
    if (!href) { problems.push(`${name}: ${spec.label} link “${target}” ignored — it must be ${type === "email" ? "an e-mail address" : spec.hosts ? `an https address on ${spec.hosts[0]}` : "an https address"}`); continue; }
    if (links.some((l) => l.href === href)) continue;
    links.push({ type, label: spec.label, icon: spec.icon, href, external: href.startsWith("https:") });
  }

  return { placeholder: false, name, role, bio, photo, initials: initialsOf(name), links, problems };
}

/* ==========================================================================
   Owner-confirmed facts   (info-config.js → OWNER_DETAILS)
   {owner:key} in any text prints the owner's value, or — while it is empty — a clearly marked "To be confirmed" note.
   ========================================================================== */
export function collectOwnerKeys(value, found = new Set()) {
  if (typeof value === "string") for (const m of value.matchAll(/\{owner:([A-Za-z0-9]+)\}/g)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => collectOwnerKeys(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectOwnerKeys(v, found));
  return found;
}

export const ownerValue = (owner, key) => String(owner?.[key]?.value ?? "").trim();
export const pendingOwnerKeys = (keys, owner) => [...keys].filter((k) => !ownerValue(owner, k));

export function tbcHtml(key, label) {
  return `<span class="inf-tbc" data-owner="${esc(key)}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> To be confirmed: ${esc(label)}</span>`;
}

/** The {token} answers: {name} {email} {site} {owner:key}. Unknown tokens print nothing; an unknown owner key prints a visible "to be confirmed". */
export function makeTokenResolver({ site = {}, owner = {} } = {}) {
  return (name, arg) => {
    switch (name) {
      case "name": return esc(site.name);
      case "email": return linkHtml(site.email, `mailto:${site.email}`);
      case "site": return linkHtml(String(site.website || "").replace(/^https:\/\//, ""), site.website);
      case "owner": {
        const value = ownerValue(owner, arg);
        if (value) return `<span class="inf-owner" data-owner="${esc(arg)}">${esc(value)}</span>`;
        return tbcHtml(arg, owner?.[arg]?.label || arg);
      }
      default: return "";
    }
  };
}

/* ==========================================================================
   FAQ search
   ========================================================================== */
/** Words that carry no meaning in a typed question ("how do I reset my password" → reset, password). */
const STOP = new Set(("a an and are as at be by can could did do does for from get got how i if in is it me my of on or our so that the this to "
  + "was we what when where which who why will with would you your am cannot there").split(" "));

/** Lower case, accents off, everything that is not a letter or a digit becomes one space. */
export function normalize(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The words of a search box: unique, 2+ letters, filler words dropped (unless nothing else is left). At most 8. */
export function tokenize(query, max = 8) {
  const all = [];
  for (const w of normalize(query).split(" ")) if (w.length >= 2 && !all.includes(w)) all.push(w);
  const meaningful = all.filter((w) => !STOP.has(w));
  return (meaningful.length ? meaningful : all).slice(0, max);
}

/** A word and its simple forms: passwords → password, attempts → attempt, logging → login-ish stems. */
export function variants(token) {
  const out = [token];
  const add = (s) => { if (s && s.length >= 3 && !out.includes(s)) out.push(s); };
  const undouble = (s) => (/([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : "");
  if (token.endsWith("ies")) add(`${token.slice(0, -3)}y`);
  if (token.endsWith("es")) add(token.slice(0, -2));
  if (token.endsWith("s") && !token.endsWith("ss")) add(token.slice(0, -1));
  if (token.endsWith("ing")) { const b = token.slice(0, -3); add(b); add(undouble(b)); add(`${b}e`); }
  if (token.endsWith("ed")) { const b = token.slice(0, -2); add(b); add(undouble(b)); add(token.slice(0, -1)); }
  return out;
}

const indexCache = new WeakMap();
function indexOf(item) {
  let ix = indexCache.get(item);
  if (!ix) {
    ix = { q: normalize(plainInline(item.q)), k: normalize((item.kw || []).join(" ")), a: normalize(plainBlocks(item.a)) };
    indexCache.set(item, ix);
  }
  return ix;
}

const hit = (text, vs) => vs.some((v) => text.includes(v));
const wordStart = (text, vs) => vs.some((v) => ` ${text}`.includes(` ${v}`));

/**
 * Ranked matches for a search box. EVERY word must be found somewhere (question, keywords or answer);
 * a word in the question counts most, then in the keywords, then in the answer; the words together in the
 * question get a bonus. An empty search matches everything in the original order.
 * → [{ item, score, index }]
 */
export function searchFaq(items, query) {
  const tokens = tokenize(query);
  if (!tokens.length) return items.map((item, index) => ({ item, score: 0, index }));
  const phrase = tokens.join(" ");
  const out = [];
  items.forEach((item, index) => {
    const ix = indexOf(item);
    let score = 0;
    for (const t of tokens) {
      const vs = variants(t);
      let best = 0;
      if (hit(ix.q, vs)) best = wordStart(ix.q, vs) ? 8 : 6;
      else if (hit(ix.k, vs)) best = wordStart(ix.k, vs) ? 5 : 4;
      else if (hit(ix.a, vs)) best = 1;
      if (!best) return;                       // one word is nowhere → this question does not match
      score += best;
    }
    if (tokens.length > 1 && ix.q.includes(phrase)) score += 8;
    out.push({ item, score, index });
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}

/** The strings to mark in the results for a search box (every word and its forms, longest first). */
export function highlightTerms(query) {
  const all = tokenize(query).flatMap(variants);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Wraps every occurrence of the terms in <mark>. Works on finished HTML: tags are skipped completely and so are
 * entities (&amp; …), so the markup can never be broken — only the words people read are touched.
 */
export function highlightHtml(html, terms) {
  const list = [...new Set((terms || []).map((t) => String(t).trim()).filter((t) => t.length >= 2))].sort((a, b) => b.length - a.length);
  if (!list.length || !html) return html;
  const re = new RegExp(list.map(escapeRegExp).join("|"), "gi");
  return String(html).split(/(<[^>]*>)/).map((chunk, i) => {
    if (i % 2) return chunk;                                          // a tag
    return chunk.split(/(&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/).map((part, j) => (j % 2 ? part : part.replace(re, (m) => `<mark>${m}</mark>`))).join("");
  }).join("");
}
