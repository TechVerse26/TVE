// Unit tests for the information pages' pure logic (no DOM, no Firebase). Run:  node --test tests/unit/info.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../../js/info-core.js";
import { readFileSync } from "node:fs";
import { FAQ as FAQ_DATA, FAQ_CATEGORIES } from "../../js/faq-data.js";
import { HELP } from "../../js/help-data.js";
import { ABOUT } from "../../js/about-data.js";
import { PRIVACY } from "../../js/privacy-data.js";
import { TERMS } from "../../js/terms-data.js";
import { CREDITS } from "../../js/credits-data.js";
import { SITE, LEGAL_DATES, OWNER_DETAILS } from "../../js/info-config.js";
import { FOOTER_CONFIG } from "../../js/footer-config.js";

/* ---------- escaping and addresses ---------- */
test("esc escapes the five HTML characters and tolerates null", () => {
  assert.equal(C.esc(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  assert.equal(C.esc(null), "");
  assert.equal(C.esc(undefined), "");
  assert.equal(C.esc(5), "5");
});

test("safeHref allows only #/routes, mailto: and https", () => {
  assert.equal(C.safeHref("#/faq"), "#/faq");
  assert.equal(C.safeHref("#/faq?open=a-reset&q=pass%20word"), "#/faq?open=a-reset&q=pass%20word");
  assert.equal(C.safeHref("mailto:a@b.co?subject=Hi%20there"), "mailto:a@b.co?subject=Hi%20there");
  assert.equal(C.safeHref("https://example.com/a?b=c"), "https://example.com/a?b=c");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "http://example.com", "//evil.com", "ftp://x.y", "#home", "/faq", "", null, undefined, "https://", "https://localhost", "https://user:pw@example.com", 'https://a.com/"onmouseover="x', "#/faq<script>", "vbscript:x"]) {
    assert.equal(C.safeHref(bad), "", `must refuse ${bad}`);
  }
});

test("safeExternalUrl needs https, a dotted host and no credentials", () => {
  assert.equal(C.safeExternalUrl("https://github.com/someone"), "https://github.com/someone");
  assert.equal(C.safeExternalUrl("http://github.com/someone"), "");
  assert.equal(C.safeExternalUrl("https://github"), "");
  assert.equal(C.safeExternalUrl("https://me@github.com"), "");
});

test("safeImageSrc: https pictures or files inside assets/ only", () => {
  assert.equal(C.safeImageSrc("assets/team/rahim.jpg"), "assets/team/rahim.jpg");
  assert.equal(C.safeImageSrc("https://example.com/a.png"), "https://example.com/a.png");
  for (const bad of ["../secret.png", "assets/../x.png", "assets//x.png", "assets/x.exe", "/assets/x.png", "javascript:x", "data:image/png;base64,AAAA", "assets/x.png\" onerror=\"x", ""]) {
    assert.equal(C.safeImageSrc(bad), "", `must refuse ${bad}`);
  }
});

test("linkHtml: routes stay in the app, https opens a new tab, unsafe targets become plain text", () => {
  assert.equal(C.linkHtml("FAQ", "#/faq"), '<a href="#/faq">FAQ</a>');
  const ext = C.linkHtml("Site", "https://example.com");
  assert.match(ext, /target="_blank" rel="noopener noreferrer"/);
  assert.match(ext, /sr-only/);
  assert.equal(C.linkHtml("<b>x</b>", "javascript:alert(1)"), "&lt;b&gt;x&lt;/b&gt;");
});

test("mailtoHref builds an encoded mailto: and refuses a bad address", () => {
  const href = C.mailtoHref({ to: "help@example.com", subject: "Exam help: Q&A", body: "Name:\nExam: (name)" });
  assert.ok(href.startsWith("mailto:help@example.com?subject="));
  assert.ok(href.includes("subject=Exam%20help%3A%20Q%26A"));
  assert.ok(href.includes("body=Name%3A%0D%0AExam%3A%20%28name%29"), href);
  assert.ok(!/['()!*]/.test(href.slice(7)), "no characters that could break an attribute or a [label](href) token");
  assert.equal(C.safeHref(href), href, "the generated link passes the same safety check the pages use");
  assert.equal(C.mailtoHref({ to: "help@example.com" }), "mailto:help@example.com");
  for (const bad of ["", "nope", "a@b", "a b@c.de", "<x@y.zz>", "a@b.co,c@d.ee", null]) assert.equal(C.mailtoHref({ to: bad }), "", `must refuse ${bad}`);
});

/* ---------- inline mark-up ---------- */
test("inline: escapes text, renders bold and links, leaves unknown shapes as text", () => {
  assert.equal(C.inline("Plain <script>alert(1)</script> & more"), "Plain &lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
  assert.equal(C.inline("a **bold <i>** b"), "a <strong>bold &lt;i&gt;</strong> b");
  assert.equal(C.inline("see [the FAQ](#/faq) now"), 'see <a href="#/faq">the FAQ</a> now');
  const unsafe = C.inline("[x](javascript:alert(1))");   // the label survives as text, no link is made
  assert.ok(unsafe.startsWith("x") && !unsafe.includes("<a") && !unsafe.includes("href"), unsafe);
  assert.equal(C.inline("2 * 3 ** 4 not bold"), "2 * 3 ** 4 not bold");
  assert.equal(C.inline("[broken(link"), "[broken(link");
  assert.equal(C.inline(null), "");
});

test("inline: {tokens} need a resolver; without one they print nothing", () => {
  assert.equal(C.inline("Mail {email}!"), "Mail !");
  const ctx = { token: (name, arg) => `<i>${name}${arg ? `/${arg}` : ""}</i>` };
  assert.equal(C.inline("A {email} B {owner:retention} C", ctx), "A <i>email</i> B <i>owner/retention</i> C");
});

test("inline: HTML inside a link label or href cannot escape the attribute", () => {
  const out = C.inline('[<img src=x onerror=alert(1)>](https://example.com/"><script>)');
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<script"));
});

test("plainInline strips the mark-up", () => {
  assert.equal(C.plainInline("Open the [Help Center](#/help) and **log in** {email}."), "Open the Help Center and log in .");
});

/* ---------- blocks ---------- */
test("renderBlocks: every block type produces escaped, well-formed HTML", () => {
  const html = C.renderBlocks([
    "First <paragraph>",
    { p: "Second" },
    { h: "Heading & more" },
    { ul: ["one", "two **b**"] },
    { ol: ["a", "b"] },
    { note: "careful", tone: "warn" },
    { note: "plain note" },
    { dl: [["Term", "Desc"]] },
    { table: { caption: "Cap", cols: ["Col A", "Col B"], rows: [["r1a", "r1b"], ["r2a", "r2b <x>"]] } },
    { unknown: true },
    null,
  ]);
  assert.ok(html.includes("<p>First &lt;paragraph&gt;</p>"));
  assert.ok(html.includes('<h3 class="inf-h3">Heading &amp; more</h3>'));
  assert.ok(html.includes('<ul class="inf-list"><li>one</li><li>two <strong>b</strong></li></ul>'));
  assert.ok(html.includes('<ol class="inf-list inf-list--num">'));
  assert.ok(html.includes("inf-note--warn"));
  assert.ok(html.includes("inf-note--info"));
  assert.ok(html.includes("<dt>Term</dt><dd>Desc</dd>"));
  assert.ok(html.includes('<th scope="row" role="rowheader" data-label="Col A">r1a</th>'));
  assert.ok(html.includes('<td role="cell" data-label="Col B">r2b &lt;x&gt;</td>'));
  assert.ok(html.includes('<caption class="sr-only">Cap</caption>'));
  assert.ok(!html.includes("<x>"));
  // balanced tags for the elements we emit
  for (const tag of ["p", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tr", "th", "td", "aside", "div"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.equal(open, close, `<${tag}> balanced`);
  }
});

test("plainBlocks reads every block type", () => {
  const text = C.plainBlocks(["Para [link](#/x)", { h: "Head" }, { ul: ["u1", "**u2**"] }, { dl: [["T", "D"]] }, { table: { caption: "C", cols: ["A"], rows: [["cell"]] } }, { note: "N" }]);
  for (const word of ["Para link", "Head", "u1", "u2", "T", "D", "C", "A", "cell", "N"]) assert.ok(text.includes(word), word);
});

/* ---------- small helpers ---------- */
test("slugify and prepareSections give unique, stable ids and numbers", () => {
  assert.equal(C.slugify("Data & Storage"), "data-and-storage");
  assert.equal(C.slugify("  !!  "), "section");
  const s = C.prepareSections([{ title: "Intro" }, { title: "Intro" }, { id: "custom Id", title: "Other" }]);
  assert.deepEqual(s.map((x) => x.id), ["intro", "intro-2", "custom-id"]);
  assert.deepEqual(s.map((x) => x.num), [1, 2, 3]);
});

test("sectionParam keeps only id characters", () => {
  assert.equal(C.sectionParam("Data-Security"), "data-security");
  assert.equal(C.sectionParam('x"><script>'), "xscript");
  assert.equal(C.sectionParam(null), "");
});

test("formatLongDate is timezone-proof and strict", () => {
  assert.equal(C.formatLongDate("2026-10-22"), "22 October 2026");
  assert.equal(C.formatLongDate("2026-02-29"), "");
  assert.equal(C.formatLongDate("2028-02-29"), "29 February 2028");
  assert.equal(C.formatLongDate("2026-13-01"), "");
  assert.equal(C.formatLongDate("22/10/2026"), "");
  assert.equal(C.formatLongDate(""), "");
});

test("initialsOf", () => {
  assert.equal(C.initialsOf("Rahim Uddin"), "RU");
  assert.equal(C.initialsOf("Rahim"), "RA");
  assert.equal(C.initialsOf("a"), "A");
  assert.equal(C.initialsOf("  mary  jane  watson "), "MW");
  assert.equal(C.initialsOf(""), "");
  assert.equal(C.initialsOf(null), "");
  assert.equal(C.initialsOf("(Dr.) A. Rahman"), "DR", "punctuation is skipped, the first and last WORD count");
  assert.equal(C.initialsOf("<img src=x>"), "IS");
  assert.equal(C.initialsOf("— · —"), "", "only symbols → no initials (the page draws an icon)");
  assert.equal(C.initialsOf("Ünal Çelik"), "ÜÇ");
  assert.equal(C.initialsOf("১২ জন"), "১জ", "digits and other scripts work too");
});

/* ---------- owner-confirmed facts ---------- */
test("owner tokens: collected, resolved, and shown as 'to be confirmed' until the owner fills them in", () => {
  const keys = C.collectOwnerKeys([{ p: "a {owner:retention}" }, { ul: ["{owner:deletion} and {owner:retention}"] }, "no token {email}"]);
  assert.deepEqual([...keys].sort(), ["deletion", "retention"]);

  const owner = { retention: { value: "", label: "retention period" }, deletion: { value: "  Within 30 days <b>  ", label: "deletion handling" } };
  assert.deepEqual(C.pendingOwnerKeys(keys, owner), ["retention"]);
  const site = { name: "Tech Verse Exam", email: "help@example.com", website: "https://example.com" };
  const resolve = C.makeTokenResolver({ site, owner });
  assert.match(resolve("owner", "retention"), /inf-tbc[^>]*data-owner="retention".*To be confirmed: retention period/);
  const filled = resolve("owner", "deletion");
  assert.match(filled, /class="inf-owner"/);
  assert.ok(filled.includes("Within 30 days &lt;b&gt;"), "the owner's text is escaped");
  assert.match(resolve("owner", "unknownKey"), /To be confirmed: unknownKey/);
  assert.equal(resolve("email"), '<a href="mailto:help@example.com">help@example.com</a>');
  assert.match(resolve("site"), /href="https:\/\/example.com"/);
  assert.equal(resolve("name"), "Tech Verse Exam");
  assert.equal(resolve("nothing"), "");
});

/* ---------- FAQ search ---------- */
const FAQ = [
  { id: "reset", q: "How do I reset my password?", a: "Open **Login** and choose Forgot password. A link is emailed to you.", kw: ["forgot", "sign in", "login"] },
  { id: "attempts", q: "How many attempts do I get?", a: ["Each exam sets its own limit.", { ul: ["Shown on the rules page"] }], kw: ["retake"] },
  { id: "roll", q: "What is a roll number?", a: "A serial number assigned to your account.", kw: [] },
  { id: "timer", q: "Does the timer stop if I close the app?", a: "No. The timer keeps running.", kw: ["clock", "time"] },
  { id: "support", q: "How do I contact support?", a: "Email the support address.", kw: ["help", "email", "mail"] },
];

test("tokenize drops filler words, duplicates and one-letter words", () => {
  assert.deepEqual(C.tokenize("How do I reset my password?"), ["reset", "password"]);
  assert.deepEqual(C.tokenize("reset reset  RESET"), ["reset"]);
  assert.deepEqual(C.tokenize("how do i"), ["how", "do"], "a search made only of filler words keeps them");
  assert.deepEqual(C.tokenize("   "), []);
  assert.equal(C.tokenize("a b c d e f g h i j k l m n o p").length <= 8, true);
});

test("variants cover simple plurals and verb forms", () => {
  assert.ok(C.variants("passwords").includes("password"));
  assert.ok(C.variants("attempts").includes("attempt"));
  assert.ok(C.variants("queries").includes("query"));
  assert.ok(C.variants("resetting").includes("reset"));
  assert.ok(C.variants("closed").includes("close"));
  assert.ok(C.variants("class").every((v) => v !== "clas"), "'ss' is not a plural");
});

test("searchFaq: empty search matches everything in the original order", () => {
  const all = C.searchFaq(FAQ, "");
  assert.deepEqual(all.map((r) => r.item.id), FAQ.map((f) => f.id));
  assert.deepEqual(C.searchFaq(FAQ, " ? ").map((r) => r.item.id), FAQ.map((f) => f.id));
});

test("searchFaq: finds by question, keyword, answer and plural forms", () => {
  const ids = (q) => C.searchFaq(FAQ, q).map((r) => r.item.id);
  assert.deepEqual(ids("reset password"), ["reset"]);
  assert.deepEqual(ids("how do i reset my password"), ["reset"]);
  assert.deepEqual(ids("passwords"), ["reset"]);
  assert.deepEqual(ids("forgot"), ["reset"]);               // keyword only
  assert.ok(ids("emailed").includes("reset"));              // answer only ("emailed" → "email" also hits the support keywords)
  assert.ok(ids("retake").includes("attempts"));
  assert.deepEqual(ids("rules page"), ["attempts"]);       // inside a nested list block
  assert.deepEqual(ids("zzzz"), []);
  assert.deepEqual(ids("reset zzzz"), [], "every word must match");
});

test("searchFaq: a word in the question outranks the same word in the answer", () => {
  const items = [
    { id: "answer-only", q: "Something else entirely", a: "You can retake it later.", kw: [] },
    { id: "question", q: "Can I retake an exam?", a: "Yes.", kw: [] },
  ];
  assert.deepEqual(C.searchFaq(items, "retake").map((r) => r.item.id), ["question", "answer-only"]);
});

test("searchFaq: the words together in the question get a bonus", () => {
  const items = [
    { id: "split", q: "Where is the password? Reset it later", a: "", kw: [] },
    { id: "phrase", q: "How to reset password", a: "", kw: [] },
  ];
  assert.equal(C.searchFaq(items, "reset password")[0].item.id, "phrase");
});

test("highlightTerms lists words and their forms, longest first", () => {
  const terms = C.highlightTerms("passwords");
  assert.deepEqual(terms, ["passwords", "password"]);
});

test("highlightHtml marks words in text only — never in tags or entities", () => {
  const html = '<p>Reset your <a href="#/help?section=reset" title="reset it">password</a> &amp; amp up. Reset!</p>';
  const out = C.highlightHtml(html, ["reset", "amp"]);
  assert.equal(out, '<p><mark>Reset</mark> your <a href="#/help?section=reset" title="reset it">password</a> &amp; <mark>amp</mark> up. <mark>Reset</mark>!</p>');
  assert.equal(C.highlightHtml("<p>x</p>", []), "<p>x</p>");
  assert.equal(C.highlightHtml("<p>x</p>", ["p"]), "<p>x</p>", "one-letter terms are ignored");
  assert.equal(C.highlightHtml("a.b (c)", ["a.b", "(c)"]), "<mark>a.b</mark> <mark>(c)</mark>", "regex characters are literal");
  assert.equal(C.highlightHtml("", ["x"]), "");
});

test("highlightHtml keeps the markup balanced on real answer HTML", () => {
  const html = C.renderBlocks(["Use **Login** then [Forgot password](#/login) & reset."]);
  const out = C.highlightHtml(html, C.highlightTerms("login reset"));
  assert.equal(out.replace(/<\/?mark>/g, ""), html);
  assert.ok(out.includes("<mark>Login</mark>"));
});


/* ==========================================================================
   Team members (the Credits page)
   ========================================================================== */
test("normalizeMember: a card without a name is a placeholder and shows nothing that was typed on it", () => {
  for (const raw of [undefined, null, {}, { name: "" }, { name: "   " }, "text", 5]) {
    const m = C.normalizeMember(raw);
    assert.equal(m.placeholder, true);
    assert.deepEqual([m.name, m.role, m.bio, m.photo, m.initials, m.links.length], ["", "", "", "", "", 0]);
    assert.deepEqual(m.problems, [], "an empty card is the normal placeholder, not a mistake");
  }
  const typed = C.normalizeMember({ name: "", role: "Teacher", photo: "assets/a.jpg", links: [{ type: "github", url: "https://github.com/x" }] });
  assert.equal(typed.placeholder, true);
  assert.equal(typed.role, "", "the role of an unnamed card is never shown");
  assert.equal(typed.links.length, 0);
  assert.equal(typed.problems.length, 1, "…but the owner is told why");
  assert.match(typed.problems[0], /role, photo, links/);
});

test("normalizeMember: a real card keeps its words, tidies spaces and draws initials", () => {
  const m = C.normalizeMember({ name: "  Test   Person ", role: " Role  here ", bio: "One.\n\nTwo." });
  assert.equal(m.placeholder, false);
  assert.deepEqual([m.name, m.role, m.bio, m.initials], ["Test Person", "Role here", "One. Two.", "TP"]);
  assert.deepEqual(m.problems, []);
  assert.deepEqual(C.normalizeMember({ name: "Solo" }).problems, ["Solo: no role or contribution given"]);
  assert.match(C.normalizeMember({ name: "Long", role: "r", bio: "x".repeat(C.BIO_SOFT_LIMIT + 1) }).problems[0], /biography is longer/);
  assert.equal(C.normalizeMember({ name: "রহিম উদ্দিন", role: "r" }).initials, "রউ");
});

test("normalizeMember: a photo is an https address or a file inside assets/ — anything else is dropped and reported", () => {
  assert.equal(C.normalizeMember({ name: "A", role: "r", photo: "assets/team/a.jpg" }).photo, "assets/team/a.jpg");
  assert.equal(C.normalizeMember({ name: "A", role: "r", photo: "https://example.com/a.png" }).photo, "https://example.com/a.png");
  for (const bad of ["javascript:alert(1)", "http://example.com/a.png", "../a.png", "data:image/png;base64,AAAA", "assets/../a.png", "/a.png"]) {
    const m = C.normalizeMember({ name: "A", role: "r", photo: bad });
    assert.equal(m.photo, "", `must drop ${bad}`);
    assert.match(m.problems.join(" "), /photo .* ignored/);
  }
});

test("normalizeMember: a profile link must be https on the website its type names; an email must be an address", () => {
  const link = (type, url) => C.normalizeMember({ name: "A", role: "r", links: [{ type, url }] });
  const good = [
    ["linkedin", "https://www.linkedin.com/in/someone"], ["linkedin", "https://linkedin.com/in/someone"],
    ["github", "https://github.com/someone"], ["facebook", "https://www.facebook.com/someone"], ["facebook", "https://fb.com/someone"],
    ["youtube", "https://www.youtube.com/@someone"], ["youtube", "https://youtu.be/abc"], ["telegram", "https://t.me/someone"],
    ["website", "https://example.com/me"], ["email", "someone@example.com"],
  ];
  for (const [type, url] of good) {
    const m = link(type, url);
    assert.equal(m.links.length, 1, `${type} ${url}`);
    assert.deepEqual(m.problems, []);
  }
  assert.equal(link("email", "someone@example.com").links[0].href, "mailto:someone@example.com");
  assert.equal(link("email", "someone@example.com").links[0].external, false);
  assert.equal(link("github", "https://github.com/someone").links[0].external, true);
  const bad = [
    ["linkedin", "https://example.org/in/someone"], ["linkedin", "https://notlinkedin.com/in/x"], ["linkedin", "https://linkedin.com.evil.org/in/x"],
    ["github", "http://github.com/someone"], ["github", "javascript:alert(1)"], ["website", "http://example.com"], ["website", "//example.com"],
    ["email", "not-an-address"], ["email", "a@b"], ["telegram", "https://t.me@evil.example/x"], ["youtube", ""],
  ];
  for (const [type, url] of bad) {
    const m = link(type, url);
    assert.equal(m.links.length, 0, `must drop ${type} ${url}`);
    assert.equal(m.problems.length, 1, `must report ${type} ${url}`);
  }
});

test("normalizeMember: unknown link types, repeated links and junk input are handled", () => {
  const m = C.normalizeMember({
    name: "A", role: "r",
    links: [{ type: "twitter", url: "https://x.com/a" }, null, "text", { type: "github", url: "https://github.com/a" }, { type: "GitHub", url: "https://github.com/a" }, { type: "constructor", url: "https://example.com" }],
  });
  assert.deepEqual(m.links.map((l) => l.type), ["github"], "the repeated GitHub link is shown once");
  assert.equal(m.problems.length, 4, m.problems.join(" | "));
  assert.deepEqual(C.normalizeMember({ name: "A", role: "r", links: "nope" }).links, []);
  assert.ok(Object.isFrozen(C.PROFILE_LINK_TYPES));
});

test("credits-data: the shipped team entries are valid — and nobody is named by the project itself", () => {
  const members = CREDITS.team.members.map(C.normalizeMember);
  assert.deepEqual(members.flatMap((m) => m.problems), [], "fix whatever this lists in js/credits-data.js");
  for (const m of members) if (!m.placeholder) assert.ok(m.name && m.role, "a named person needs a role");
  assert.ok(CREDITS.team.placeholder.name && CREDITS.team.placeholder.role && CREDITS.team.placeholder.bio && CREDITS.team.placeholder.badge);
  assert.ok(CREDITS.acknowledgements.items.length >= 3);
  for (const it of CREDITS.acknowledgements.items) assert.ok(it.name && it.text);
});

/* ==========================================================================
   Content integrity — the six pages' words, as data
   ========================================================================== */
const appSource = readFileSync(new URL("../../js/app.js", import.meta.url), "utf8");
const ROUTES = new Set([...appSource.matchAll(/^\s{4}([a-z0-9]+):\s*(?:genericRoute|examRoute)/gm)].map((m) => m[1]));
const CONTENT = { ABOUT, FAQ: FAQ_DATA, HELP, PRIVACY, TERMS, CREDITS };
/** The Help Center's sections, in page order (each has an id — that is its #anchor and its ?section= value). */
const HELP_SECTIONS = ["gettingStarted", "account", "exams", "rules", "results", "leaderboard", "troubleshooting", "privacy", "contact"].map((k) => HELP[k]);

/** Every string a visitor can read inside a content object (search keywords are never shown, so they are skipped). */
function* visibleStrings(value, key = "") {
  if (typeof value === "string") { if (key !== "kw") yield value; }
  else if (Array.isArray(value)) for (const v of value) yield* visibleStrings(v, key);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* visibleStrings(v, k);
}
/** Every link target in a content object: [label](target) tokens, and fields that hold a bare #/route. */
function linksIn(content) {
  const found = [];
  for (const s of visibleStrings(content)) {
    if (/^#\/[a-z]/.test(s)) found.push(s);
    for (const m of s.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) found.push(m[2]);
  }
  return found;
}
/** A small well-formedness check: every opening tag is closed, in order. */
function assertBalanced(html, where) {
  const VOID = new Set(["br", "hr", "img", "input"]);
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const [, closing, tag] = m, name = tag.toLowerCase();
    if (VOID.has(name)) continue;
    if (!closing) stack.push(name);
    else assert.equal(stack.pop(), name, `${where}: </${name}> does not match the open tag`);
  }
  assert.deepEqual(stack, [], `${where}: tags left open`);
}

test("the app registers all six information routes (and the test can read the route table)", () => {
  for (const r of ["about", "faq", "help", "privacy", "terms", "credits"]) assert.ok(ROUTES.has(r), `app.js has no #/${r} route`);
  for (const r of ["home", "exams", "results", "login", "signup", "leaderboard"]) assert.ok(ROUTES.has(r), `the route table was not read correctly (#/${r} missing)`);
});

test("every {owner:key} used in the words exists in OWNER_DETAILS, and OWNER_DETAILS is well-formed", () => {
  const used = C.collectOwnerKeys(CONTENT);
  assert.ok(used.size >= 5, "the legal pages should lean on owner-confirmed facts");
  for (const key of used) assert.ok(Object.hasOwn(OWNER_DETAILS, key), `{owner:${key}} is used but not defined in info-config.js`);
  for (const [key, d] of Object.entries(OWNER_DETAILS)) {
    assert.equal(typeof d.value, "string", `${key}.value must be text`);
    assert.ok(d.label && d.label.length > 5, `${key} needs a label that says what to supply`);
    assert.ok(used.has(key), `OWNER_DETAILS.${key} is not used by any page — remove it or use it`);
  }
});

test("every link in the content is safe, and every in-app link goes to a route that exists", () => {
  const links = linksIn(CONTENT);
  assert.ok(links.length > 60, `expected plenty of links, found ${links.length}`);
  const faqIds = new Set(FAQ_DATA.map((f) => f.id));
  const sections = { privacy: new Set(C.prepareSections(PRIVACY.sections).map((s) => s.id)), terms: new Set(C.prepareSections(TERMS.sections).map((s) => s.id)) };
  for (const href of links) {
    assert.ok(C.safeHref(href), `unsafe or malformed link: ${href}`);
    if (!href.startsWith("#/")) continue;
    const [path, query = ""] = href.slice(2).split("?");
    assert.ok(ROUTES.has(path), `link to a route that does not exist: ${href}`);
    const q = new URLSearchParams(query);
    if (q.has("open")) assert.ok(faqIds.has(q.get("open")), `link opens an unknown FAQ question: ${href}`);
    if (q.has("cat")) assert.ok(FAQ_CATEGORIES.some((c) => c.id === q.get("cat")), `link filters by an unknown FAQ category: ${href}`);
    if (q.has("section") && sections[path]) assert.ok(sections[path].has(q.get("section")), `link to a section that does not exist: ${href}`);
    if (q.has("section") && path === "help") assert.ok(HELP_SECTIONS.some((x) => x.id === q.get("section")), `link to a Help section that does not exist: ${href}`);
    if (q.has("view")) assert.equal(path === "profile" && q.get("view") === "settings", true, `unknown view in: ${href}`);
  }
});

test("FAQ data: unique slug ids, valid categories, no empty answers, every category used", () => {
  const ids = new Set();
  for (const f of FAQ_DATA) {
    assert.match(f.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `bad id ${f.id}`);
    assert.ok(!ids.has(f.id), `duplicate FAQ id ${f.id}`);
    ids.add(f.id);
    assert.ok(FAQ_CATEGORIES.some((c) => c.id === f.cat), `${f.id}: unknown category ${f.cat}`);
    assert.ok(typeof f.q === "string" && f.q.trim().length > 8, `${f.id}: a question is needed`);
    assert.ok(C.plainBlocks(f.a).trim().length > 20, `${f.id}: the answer is empty`);
    if (f.kw !== undefined) assert.ok(Array.isArray(f.kw) && f.kw.every((k) => typeof k === "string" && k.trim()), `${f.id}: kw must be a list of words`);
  }
  assert.ok(FAQ_DATA.length >= 50);
  for (const c of FAQ_CATEGORIES) assert.ok(FAQ_DATA.some((f) => f.cat === c.id), `category ${c.id} has no questions`);
  assert.equal(new Set(FAQ_CATEGORIES.map((c) => c.id)).size, FAQ_CATEGORIES.length);
});

test("Help data: sections exist, every topic tile jumps to one, every 'related' question exists, popular links are real", () => {
  const faqIds = new Set(FAQ_DATA.map((f) => f.id));
  assert.equal(HELP_SECTIONS.length, 9);
  assert.ok(HELP_SECTIONS.every(Boolean), "a Help section is missing from HELP");
  const ids = HELP_SECTIONS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate Help section id");
  for (const x of HELP_SECTIONS) assert.ok(x.title && x.sub, `section ${x.id} needs a title and a one-line intro`);
  for (const t of HELP.topics) {
    assert.ok(t.id && t.title && t.icon && t.text, `topic ${t.id} is incomplete`);
    assert.ok(ids.includes(t.id), `topic tile "${t.id}" jumps to a section that does not exist`);
  }
  let related = 0;
  for (const x of HELP_SECTIONS) for (const id of x.related || []) { related++; assert.ok(faqIds.has(id), `${x.id}: related question "${id}" does not exist`); }
  assert.ok(related >= 20, "the guides should point at plenty of FAQ answers");
  for (const [label, href, jump] of HELP.search.popular) {
    assert.ok(label && C.safeHref(href), `popular link "${label}" is empty or unsafe`);
    if (jump) assert.ok(ids.includes(jump), `popular link "${label}" jumps to a section that does not exist`);
  }
  for (const m of HELP.more) assert.ok(m.title && m.icon && C.safeHref(m.href), `"more" link ${m.title}`);
});

test("search on the real FAQ: asking a question in its own words finds that question near the top", () => {
  const misses = [];
  for (const f of FAQ_DATA) {
    const ids = C.searchFaq(FAQ_DATA, f.q).map((r) => r.item.id);
    if (!ids.slice(0, 3).includes(f.id)) misses.push(`${f.id} → [${ids.slice(0, 3).join(", ")}]`);
  }
  assert.deepEqual(misses, [], "these questions are not found by their own wording — add keywords (kw) or reword");
  const top = (q) => C.searchFaq(FAQ_DATA, q)[0]?.item.id;
  assert.equal(top("reset password"), "forgot-password");
  assert.equal(top("zzzzqqqq nothing like this"), undefined, "a nonsense search finds nothing");
});

test("legal pages: required sections, unique ids, every section has text, the date is a real date", () => {
  const p = C.prepareSections(PRIVACY.sections), t = C.prepareSections(TERMS.sections);
  assert.equal(p.length, 17);
  assert.equal(t.length, 15);
  for (const id of ["introduction", "information-we-collect", "how-we-use", "security", "retention", "your-rights", "children", "third-parties", "updates", "contact", "sharing", "device-storage"]) {
    assert.ok(p.some((s) => s.id === id), `Privacy Policy has no section "${id}"`);
  }
  for (const id of ["acceptance", "eligibility", "account-security", "acceptable-use", "exam-participation", "results", "integrity", "content", "availability", "disclaimers", "contact"]) {
    assert.ok(t.some((s) => s.id === id), `Terms has no section "${id}"`);
  }
  for (const s of [...p, ...t]) {
    assert.ok(s.title.trim(), `section ${s.id} has no title`);
    assert.ok(C.plainBlocks(s.blocks).trim().length > 40, `section ${s.id} has no text`);
  }
  for (const key of ["privacy", "terms"]) assert.ok(C.formatLongDate(LEGAL_DATES[key]), `LEGAL_DATES.${key} is not a valid YYYY-MM-DD date`);
});

test("every answer and section renders to well-formed, escaped HTML (with the real owner / site tokens)", () => {
  const ctx = { token: C.makeTokenResolver({ site: SITE, owner: OWNER_DETAILS }) };
  const bodies = [
    ...FAQ_DATA.map((f) => [`FAQ ${f.id}`, f.a]),
    ...PRIVACY.sections.map((s) => [`Privacy ${s.id}`, s.blocks]),
    ...TERMS.sections.map((s) => [`Terms ${s.id}`, s.blocks]),
    ["Privacy intro", PRIVACY.intro], ["Privacy footer", PRIVACY.footer], ["Terms intro", TERMS.intro], ["Terms footer", TERMS.footer],
  ];
  for (const [where, blocks] of bodies) {
    const html = C.renderBlocks(blocks, ctx);
    assertBalanced(html, where);
    assert.ok(!/<script|javascript:|\son[a-z]+=/i.test(html), `${where}: unsafe markup`);
    assert.ok(!/\{(owner|email|site|name)[:}]/.test(html), `${where}: an unresolved {token} is printed`);
  }
});

test("claims lint: the pages never claim compliance, certification or security guarantees nobody has confirmed", () => {
  const banned = [
    /\bGDPR\b/i, /\bCCPA\b/i, /\bHIPAA\b/i, /\bFERPA\b/i, /\bCOPPA\b/i, /ISO ?27001/i, /SOC ?2/i, /end-to-end/i, /military[- ]grade/i, /bank[- ]level/i,
    /100% (secure|safe|private|accurate)/i, /fully (secure|encrypted)/i, /we (will )?never (sell|share)/i, /certified by/i, /award[- ]winning/i, /trusted by (over|more than)/i,
  ];
  for (const s of visibleStrings(CONTENT)) for (const re of banned) assert.ok(!re.test(s), `unconfirmed claim (${re}) in: ${s.slice(0, 120)}`);
});

test("footer-config: the page links are the real routes, every link is safe, social links are never invented", () => {
  const p = FOOTER_CONFIG.pages;
  assert.deepEqual(
    [p.about, p.faq, p.help, p.privacy, p.terms, p.credits],
    ["#/about", "#/faq", "#/help", "#/privacy", "#/terms", "#/credits"],
  );
  assert.equal(p.support, "#/help?section=contact");
  for (const [name, v] of Object.entries(p)) {
    assert.ok(C.safeHref(v), `footer page "${name}" is empty or unsafe`);
    if (v.startsWith("#/")) assert.ok(ROUTES.has(v.slice(2).split("?")[0]), `footer page "${name}" points at a route that does not exist`);
  }
  assert.ok(C.mailtoHref({ to: FOOTER_CONFIG.contact.email }), "the support address must be a valid email address");
  assert.equal(SITE.email, FOOTER_CONFIG.contact.email, "one support address everywhere");
  assert.equal(SITE.website, FOOTER_CONFIG.contact.website);
  assert.ok(C.safeExternalUrl(FOOTER_CONFIG.contact.website));
  for (const [name, v] of Object.entries(FOOTER_CONFIG.social)) assert.ok(v === "" || C.safeExternalUrl(v), `social "${name}" must stay empty until you have the real address`);
});
