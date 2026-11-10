// The website's Help / FAQ / About / Privacy / Terms / Credits / What's New text, reshaped for a phone screen.
// The words are the website's own (shared/web/*-data.js); only the layout is new.
import { inline, makeTokenResolver, searchFaq } from "../shared/web/info-core.js";
import { SITE, OWNER_DETAILS } from "../shared/web/info-config.js";
import { FAQ, FAQ_CATEGORIES } from "../shared/web/faq-data.js";
import { HELP } from "../shared/web/help-data.js";
import { ABOUT } from "../shared/web/about-data.js";
import { CREDITS } from "../shared/web/credits-data.js";
import { WHATS_NEW } from "../shared/web/whats-new-data.js";
import { PRIVACY } from "../shared/web/privacy-data.js";
import { TERMS } from "../shared/web/terms-data.js";

export type Block =
  | { t: "p"; html: string } | { t: "ul"; items: string[] } | { t: "ol"; items: string[] } | { t: "h"; text: string }
  | { t: "note"; html: string; tone: string } | { t: "table"; caption: string; cols: string[]; rows: string[][] }
  | { t: "dl"; rows: { term: string; html: string }[] } | { t: "cards"; items: { title: string; html: string }[] };
export interface DocSection { id: string; title: string; sub?: string; blocks: Block[] }
export interface Doc { title: string; lead: string; sections: DocSection[] }

const token = makeTokenResolver({ site: SITE, owner: OWNER_DETAILS });
/** Website mark-up (**bold**, [label](link), {name} …) → escaped, safe HTML. */
export const html = (text: unknown): string => inline(String(text ?? ""), { token });
const arr = (v: any): any[] => (Array.isArray(v) ? v : []);

function legalBlocks(list: any[]): Block[] {
  const out: Block[] = [];
  for (const b of list) {
    if (typeof b === "string") out.push({ t: "p", html: html(b) });
    else if (b?.ul) out.push({ t: "ul", items: arr(b.ul).map(html) });
    else if (b?.table) out.push({ t: "table", caption: String(b.table.caption || ""), cols: arr(b.table.cols).map(String), rows: arr(b.table.rows).map((r) => arr(r).map(html)) });
    else if (b?.dl) out.push({ t: "dl", rows: arr(b.dl).map(([term, def]) => ({ term: html(term), html: html(def) })) });
    else if (b?.h) out.push({ t: "h", text: String(b.h) });
    else if (b?.note) out.push({ t: "note", html: html(b.note), tone: String(b.tone || "info") });
  }
  return out;
}
function legalDoc(d: any): Doc {
  const sections: DocSection[] = [];
  if (arr(d.intro).length) sections.push({ id: "intro", title: "", blocks: legalBlocks(d.intro) });
  arr(d.sections).forEach((s) => sections.push({ id: String(s.id), title: String(s.title), blocks: legalBlocks(s.blocks) }));
  if (arr(d.footer).length) sections.push({ id: "see-also", title: "", blocks: legalBlocks(d.footer) });
  return { title: String(d.title), lead: String(d.lead || ""), sections };
}

/** Walks one Help/About section object and turns each field into blocks (a field "xTitle" heads the field "x"). */
function genericBlocks(section: any): Block[] {
  const out: Block[] = [];
  const skip = new Set(["id", "title", "sub", "related", "href", "icon", "tone", "kicker", "textSignedOut", "textSignedIn", "glanceTitle"]);
  for (const [key, v] of Object.entries(section)) {
    if (skip.has(key) || key.endsWith("Title") || v == null) continue;
    const heading = (section as any)[`${key}Title`];
    if (heading) out.push({ t: "h", text: String(heading) });
    if (typeof v === "string") { out.push(key === "warn" ? { t: "note", html: html(v), tone: "warn" } : { t: "p", html: html(v) }); continue; }
    if (!Array.isArray(v) || !v.length) continue;
    if (v.every((x) => typeof x === "string")) out.push({ t: key === "start" || key === "steps" ? "ol" : "ul", items: v.map(html) });
    else if (v.every(Array.isArray)) out.push({ t: "dl", rows: v.map(([term, def]: any[]) => ({ term: html(term), html: html(def) })) });
    else if (v.every((x) => x && typeof x === "object")) {
      if ("q" in v[0]) out.push({ t: "dl", rows: v.map((x: any) => ({ term: html(x.q), html: arr(x.a).length ? arr(x.a).map(html).join("<br>") : html(x.a) })) });
      else if ("steps" in v[0]) v.forEach((x: any) => { out.push({ t: "h", text: String(x.title) }); out.push({ t: "ol", items: arr(x.steps).map(html) }); });
      else out.push({ t: "cards", items: v.map((x: any) => ({ title: String(x.title || x.name || ""), html: html(x.text || x.bio || "") })) });
    }
  }
  return out;
}

export function helpDoc(): Doc {
  const H: any = HELP;
  const order = ["gettingStarted", "account", "exams", "rules", "results", "leaderboard", "troubleshooting", "privacy", "contact"];
  const sections = order.filter((k) => H[k]).map((k) => ({ id: String(H[k].id || k), title: String(H[k].title), sub: String(H[k].sub || ""), blocks: genericBlocks(H[k]) }));
  return { title: String(H.hero?.title || "Help Center"), lead: String(H.hero?.lead || ""), sections };
}

export function aboutDoc(): Doc {
  const A: any = ABOUT;
  const sections: DocSection[] = [];
  sections.push({ id: "story", title: String(A.story.title), sub: String(A.story.sub || ""), blocks: [...arr(A.story.paragraphs).map((p) => ({ t: "p" as const, html: html(p) })), { t: "h" as const, text: String(A.story.glanceTitle || "") }, { t: "cards" as const, items: arr(A.story.glance).map((g) => ({ title: String(g.title), html: html(g.text) })) }] });
  sections.push({ id: "purpose", title: "Mission and vision", blocks: [{ t: "cards", items: arr(A.purpose).map((g) => ({ title: String(g.title), html: html(g.text) })) }] });
  for (const k of ["offer", "features", "how", "commitment", "values"]) if (A[k]) sections.push({ id: k, title: String(A[k].title), sub: String(A[k].sub || ""), blocks: genericBlocks(A[k]) });
  if (A.accessibility) sections.push({ id: "accessibility", title: String(A.accessibility.title), sub: String(A.accessibility.sub || ""), blocks: [{ t: "p", html: html(A.accessibility.intro) }, { t: "ul", items: arr(A.accessibility.points).map(html) }, ...(A.accessibility.note ? [{ t: "note" as const, html: html(A.accessibility.note), tone: "info" }] : [])] });
  return { title: String(A.hero.title), lead: String(A.hero.lead || ""), sections };
}

export function creditsDoc(): Doc {
  const C: any = CREDITS;
  const sections: DocSection[] = [
    { id: "who", title: String(C.intro.title), blocks: arr(C.intro.paragraphs).map((p) => ({ t: "p" as const, html: html(p) })) },
    { id: "team", title: String(C.team.title), sub: String(C.team.sub || ""), blocks: [{ t: "cards", items: arr(C.team.members).map((m) => ({ title: `${m.name}${m.role ? " · " + m.role : ""}`, html: html(m.bio) })) }] },
    { id: "tools", title: String(C.acknowledgements.title), sub: String(C.acknowledgements.sub || ""), blocks: [{ t: "cards", items: arr(C.acknowledgements.items).map((m) => ({ title: String(m.name), html: html(m.text) })) }] },
    { id: "thanks", title: String(C.closing.title), blocks: [{ t: "p", html: html(C.closing.text) }] },
  ];
  return { title: String(C.hero.title), lead: String(C.hero.lead || ""), sections };
}

export const privacyDoc = () => legalDoc(PRIVACY);
export const termsDoc = () => legalDoc(TERMS);
export const DOCS: Record<string, { title: string; build: () => Doc }> = {
  help: { title: "Help Center", build: helpDoc }, about: { title: "About", build: aboutDoc }, credits: { title: "Credits", build: creditsDoc },
  privacy: { title: "Privacy Policy", build: privacyDoc }, terms: { title: "Terms & Conditions", build: termsDoc },
};

export const faqCategories = (): { id: string; title: string }[] => arr(FAQ_CATEGORIES).map((c) => ({ id: String(c.id), title: String(c.title) }));
export interface FaqItem { id: string; cat: string; q: string; a: string[] }
/** Search the FAQ with the website's own ranking; an empty query returns everything. */
export function faqSearch(query: string, cat = ""): FaqItem[] {
  const items = arr(FAQ) as FaqItem[];
  const found = (searchFaq(items, query) as { item: FaqItem }[]).map((r) => r.item);
  return cat ? found.filter((i) => i.cat === cat) : found;
}
export const faqAnswerHtml = (a: string[] | string) => (Array.isArray(a) ? a : [a]).map((p) => `<p>${html(p)}</p>`).join("");

export interface WhatsNew { enabled: boolean; version: string; date: string; title: string; lead: string; items: { tone: string; title: string; text: string }[] }
export const whatsNew = (): WhatsNew => ({ ...(WHATS_NEW as any), items: arr((WHATS_NEW as any).items).map((i) => ({ tone: String(i.tone || "blue"), title: String(i.title), text: String(i.text) })) });
export const siteInfo = () => ({ name: SITE.name as string, email: SITE.email as string, website: SITE.website as string });
