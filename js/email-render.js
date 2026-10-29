// ==========================================================================
// email-render.js — turns a campaign's content + ONE student's values into the actual e-mail:
// subject, responsive HTML (inline CSS, table layout — what mail clients understand) and a plain-text version.
//
// Pure functions only (no DOM / Firebase / network) → unit-tested in tests/unit/email.test.mjs.
//
// SAFETY MODEL (read this before changing anything)
//   • The admin writes a tiny, safe markup:  **bold**  _italic_  [label](https://link)  "- bullet"  "1. numbered".
//     The text is HTML-ESCAPED FIRST, then the markup is turned into tags — so an admin can never inject raw HTML.
//   • {{variables}} are substituted AFTER that step and always HTML-escaped. A student who types
//     "<img onerror=…>" or "[click](https://evil)" as their display name only ever gets that text printed.
//   • A link may only be http(s)://… or one of the three trusted tokens ({{website_url}}, {{exam_url}}, mailto:{{support_email}}).
//   • Header fields (subject, names) are flattened to one line — no CR/LF can reach the mail headers.
// ==========================================================================
import {
  BRAND, escHtml, stripTags, oneLine, pick, normLang, safeHttpUrl, isValidEmail, VARIABLE_KEYS, OPTIONAL_KEYS,
} from "./email-core.js";

/** EmailJS refuses requests above this size (Free plan). We check before sending instead of failing 300 times. */
export const EMAILJS_REQUEST_LIMIT_BYTES = 50 * 1024;

/* ==========================================================================
   Tokens  {{key}}  or  {{key|fallback text}}
   ========================================================================== */
const tokenRe = () => /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*))?\}\}/g;

/** Which variables does this text use? `without` counts uses that have no explicit fallback (those are the ones that can be "missing"). */
export function scanTokens(strings) {
  const keys = new Map();
  const unknown = new Set();
  for (const str of strings) {
    for (const m of String(str ?? "").matchAll(tokenRe())) {
      const key = m[1];
      if (!VARIABLE_KEYS.includes(key)) { unknown.add(key); continue; }
      const e = keys.get(key) || { withFallback: 0, without: 0 };
      if (m[2] !== undefined && m[2].trim() !== "") e.withFallback++; else e.without++;
      keys.set(key, e);
    }
  }
  return { keys, unknown };
}
/** Variables that must have a value for a recipient (used without a fallback, and not optional). */
export function requiredKeys(scan) {
  return [...scan.keys].filter(([k, c]) => c.without > 0 && !OPTIONAL_KEYS.includes(k)).map(([k]) => k);
}

/** Substitute tokens. mode "html" escapes every inserted value. Records what was unknown / missing / fell back. */
export function fillTokens(str, values, { mode = "text", policy = "block", na = "", acc = null } = {}) {
  const out = String(str ?? "").replace(tokenRe(), (m, key, fb) => {
    if (!VARIABLE_KEYS.includes(key)) { acc?.unknown.add(key); return mode === "html" ? escHtml(m) : m; }
    const val = values?.[key];
    const put = (x) => (mode === "html" ? escHtml(x) : String(x));
    if (val !== null && val !== undefined && val !== "") return put(val);
    if (fb !== undefined && fb.trim() !== "") { acc?.fallbackUsed.add(key); return put(fb.trim()); }
    if (OPTIONAL_KEYS.includes(key)) return "";
    acc?.missing.add(key);
    return policy === "fallback" ? put(na) : "";
  });
  return out;
}

/* ==========================================================================
   Safe markup → blocks → HTML / text
   ========================================================================== */
export function parseBlocks(text) {
  const norm = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!norm) return [];
  return norm.split(/\n{2,}/).map((chunk) => {
    const lines = chunk.split("\n").map((l) => l.replace(/\s+$/, ""));
    if (lines.every((l) => /^\s*[-•*]\s+\S/.test(l))) return { type: "ul", items: lines.map((l) => l.replace(/^\s*[-•*]\s+/, "")) };
    if (lines.every((l) => /^\s*\d{1,2}[.)]\s+\S/.test(l))) return { type: "ol", items: lines.map((l) => l.replace(/^\s*\d{1,2}[.)]\s+/, "")) };
    return { type: "p", lines };
  });
}

const LINK_STYLE = "color:#1558E0;text-decoration:underline;";
const TOKEN_URLS = new Set(["{{website_url}}", "{{exam_url}}", "mailto:{{support_email}}"]);

function protectTokens(s) {
  const toks = [];
  const out = s.replace(tokenRe(), (m) => { toks.push(m); return `\u0001${toks.length - 1}\u0002`; });
  return { out, toks };
}
const restoreTokens = (s, toks) => s.replace(/\u0001(\d+)\u0002/g, (_, i) => toks[Number(i)]);

/** One line of the markup → HTML (tokens stay in place; they are filled afterwards, escaped). */
export function inlineToHtml(raw) {
  const { out, toks } = protectTokens(String(raw ?? ""));
  let s = escHtml(out);
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label, url) => {
    const asToken = restoreTokens(url, toks).replace(/\s+/g, "");
    if (TOKEN_URLS.has(asToken)) return `<a href="${restoreTokens(url, toks)}" target="_blank" rel="noopener" style="${LINK_STYLE}">${label}</a>`;
    if (/^https?:\/\/[^\s"'<>{}\u0001\u0002]+$/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener" style="${LINK_STYLE}">${label}</a>`;
    return m; // anything else (javascript:, data:, a token inside a URL …) stays plain, escaped text
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(>])_([^_\n]+?)_(?=$|[\s).,!?:;<])/g, "$1<em>$2</em>");
  return restoreTokens(s, toks);
}
/** The same line as plain text: markup removed, links written as "label (url)". */
export function inlineToText(raw) {
  return String(raw ?? "")
    .replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?:;])/g, "$1$2");
}

const P_STYLE = "margin:0 0 14px;font-size:15px;line-height:1.7;color:#0B1B3F;";
const LIST_STYLE = "margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.7;color:#0B1B3F;";

/** Blocks → HTML. Blocks (or list items) that end up empty after substitution disappear — no empty paragraphs. */
export function blocksToHtml(blocks, fill, { pStyle = P_STYLE } = {}) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "p") {
      const html = b.lines.map((l) => fill(inlineToHtml(l))).join("<br>");
      if (stripTags(html).trim()) parts.push(`<p style="${pStyle}">${html}</p>`);
    } else {
      const items = b.items.map((it) => fill(inlineToHtml(it))).filter((h) => stripTags(h).trim());
      if (items.length) {
        const tag = b.type === "ol" ? "ol" : "ul";
        parts.push(`<${tag} style="${LIST_STYLE}">${items.map((h) => `<li style="margin:0 0 6px;">${h}</li>`).join("")}</${tag}>`);
      }
    }
  }
  return parts.join("");
}
export function blocksToText(blocks, fill) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "p") {
      const t = b.lines.map((l) => fill(inlineToText(l))).join("\n");
      if (t.trim()) parts.push(t);
    } else {
      const items = b.items.map((it) => fill(inlineToText(it))).filter((t) => t.trim());
      if (items.length) parts.push(items.map((t, i) => (b.type === "ol" ? `${i + 1}. ${t}` : `- ${t}`)).join("\n"));
    }
  }
  return parts.join("\n\n");
}

/* ==========================================================================
   Campaign content
   ========================================================================== */
export const INFO_FIELDS = Object.freeze({
  name: { label: ["Name", "নাম"], key: "student_name" },
  email: { label: ["Registered email", "নিবন্ধিত ইমেইল"], key: "student_email" },
  roll: { label: ["Roll", "রোল"], key: "student_roll" },
  student_id: { label: ["Student ID", "স্টুডেন্ট আইডি"], key: "student_id" },
  course: { label: ["Course", "কোর্স"], key: "course_name" },
  status: { label: ["Current status", "বর্তমান অবস্থা"], key: "attempt_status" },
  attempts: { label: ["Submitted attempts", "জমা দেওয়া অ্যাটেম্পট"], key: "attempt_count" },
});
const EXAM_FIELDS = Object.freeze([
  { label: ["Examination", "পরীক্ষা"], key: "exam_title" },
  { label: ["Date", "তারিখ"], key: "exam_date" },
  { label: ["Start time", "শুরুর সময়"], key: "exam_time" },
  { label: ["Duration", "সময়সীমা"], key: "exam_duration" },
  { label: ["Last time to start", "শুরু করার শেষ সময়"], key: "deadline" },
  { label: ["Availability", "বর্তমান অবস্থা"], key: "exam_status" },
]);

export function emptyContent() {
  return {
    subject: "", greeting: "", message: "", instructions: "", closing: "", signature: "",
    showStudentInfo: true, infoFields: ["name", "email", "roll", "course"],
    showExamDetails: false,
    ctaEnabled: false, ctaLabel: "", ctaUrl: "{{website_url}}",
  };
}
const CAPS = { subject: 200, greeting: 200, message: 6000, instructions: 3000, closing: 2000, signature: 400, ctaLabel: 80, ctaUrl: 500 };
/** Content as it may be stored / loaded: known fields only, capped lengths, booleans and field lists validated. */
export function sanitizeContent(c) {
  const base = emptyContent();
  const src = c && typeof c === "object" ? c : {};
  const out = { ...base };
  for (const [k, max] of Object.entries(CAPS)) out[k] = String(src[k] ?? base[k]).slice(0, max);
  out.showStudentInfo = src.showStudentInfo !== false;
  out.showExamDetails = src.showExamDetails === true;
  out.ctaEnabled = src.ctaEnabled === true;
  out.infoFields = Array.isArray(src.infoFields) ? src.infoFields.filter((f) => INFO_FIELDS[f]).slice(0, 10) : base.infoFields;
  return out;
}
/** Every text the content can contain — for variable scanning. */
export function contentStrings(c) {
  return [c.subject, c.greeting, c.message, c.instructions, c.closing, c.signature, c.ctaEnabled ? c.ctaLabel : "", c.ctaEnabled ? c.ctaUrl : ""];
}

const NA_TEXT = (L) => pick(L, "Not available", "পাওয়া যায়নি");

/** Which key does the CTA link need? "{{website_url}}" → "website_url"; a plain https URL → null. */
function ctaTokenKey(url) {
  const m = String(url || "").trim().match(/^\{\{\s*(website_url|exam_url)\s*\}\}$/);
  return m ? m[1] : null;
}

/**
 * Render one recipient's e-mail.
 *   content   the campaign content (see emptyContent)
 *   values    buildValues() of that recipient
 *   opts      { lang, policy: "block"|"skip"|"fallback", site: { website, email }, logoUrl, brand }
 * Returns { subject, html, text, preheader, sizeBytes, missing[], unknown[], fallbackUsed[] }.
 * `missing` lists variables used WITHOUT a fallback that this recipient has no data for.
 */
export function renderEmail(content, values, opts = {}) {
  const L = normLang(opts.lang);
  const policy = opts.policy || "block";
  const na = NA_TEXT(L);
  const acc = { missing: new Set(), unknown: new Set(), fallbackUsed: new Set() };
  const fh = (s) => fillTokens(s, values, { mode: "html", policy, na, acc });
  const ft = (s) => fillTokens(s, values, { mode: "text", policy, na, acc });
  const c = { ...emptyContent(), ...content };

  const subject = oneLine(ft(c.subject));
  const greetingHtml = fh(inlineToHtml(c.greeting));
  const greetingText = ft(inlineToText(c.greeting)).trim();
  const messageBlocks = parseBlocks(c.message);
  const bodyHtml = blocksToHtml(messageBlocks, fh);
  const bodyText = blocksToText(messageBlocks, ft);
  const instrBlocks = parseBlocks(c.instructions);
  const instrHtml = blocksToHtml(instrBlocks, fh, { pStyle: "margin:0 0 8px;font-size:14px;line-height:1.65;color:#0B1B3F;" });
  const instrText = blocksToText(instrBlocks, ft);
  const closingBlocks = parseBlocks(c.closing);
  const closingHtml = blocksToHtml(closingBlocks, fh);
  const closingText = blocksToText(closingBlocks, ft);
  const sigLines = String(c.signature || "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  const sigHtml = sigLines.map((l) => fh(inlineToHtml(l))).filter((h) => stripTags(h).trim()).join("<br>");
  const sigText = sigLines.map((l) => ft(inlineToText(l))).filter((t) => t.trim()).join("\n");

  const infoRows = c.showStudentInfo
    ? (c.infoFields || []).map((f) => INFO_FIELDS[f]).filter(Boolean)
      .map((f) => ({ label: pick(L, f.label[0], f.label[1]), value: values?.[f.key] })).filter((r) => r.value)
    : [];
  const examRows = c.showExamDetails
    ? EXAM_FIELDS.map((f) => ({ label: pick(L, f.label[0], f.label[1]), value: values?.[f.key] })).filter((r) => r.value)
    : [];

  // call-to-action button
  let cta = null;
  if (c.ctaEnabled) {
    const label = oneLine(ft(c.ctaLabel), 80);
    const tokenKey = ctaTokenKey(c.ctaUrl);
    const url = tokenKey ? (values?.[tokenKey] ? safeHttpUrl(values[tokenKey]) : "") : safeHttpUrl(fillTokens(c.ctaUrl, values, { mode: "text", acc }));
    if (tokenKey && !url) acc.missing.add(tokenKey);
    if (label && url) cta = { label, url };
    else if (c.ctaEnabled && !url && !tokenKey) acc.unknown.add("cta_url");
  }

  const site = opts.site || {};
  const supportEmail = isValidEmail(site.email) ? String(site.email).trim() : "";
  const siteUrl = safeHttpUrl(site.website);
  const recipientEmail = values?.student_email || "";
  const preheader = oneLine(bodyText.replace(/\s+/g, " "), 120);
  const brand = opts.brand || BRAND;

  const html = buildHtml({ L, subject, preheader, greetingHtml, bodyHtml, instrHtml, infoRows, examRows, cta, closingHtml, sigHtml, brand, logoUrl: safeHttpUrl(opts.logoUrl), supportEmail, siteUrl, recipientEmail });
  const text = buildText({ L, subject, greetingText, bodyText, instrText, infoRows, examRows, cta, closingText, sigText, brand, supportEmail, siteUrl, recipientEmail });
  return {
    subject, html, text, preheader,
    sizeBytes: new TextEncoder().encode(html).length + new TextEncoder().encode(text).length,
    missing: [...acc.missing], unknown: [...acc.unknown], fallbackUsed: [...acc.fallbackUsed],
  };
}

/* ==========================================================================
   The HTML shell (inline CSS only — no scripts, no web fonts, no CSS the mail clients drop)
   ========================================================================== */
const FONT = "'Segoe UI','Noto Sans Bengali','Hind Siliguri',Arial,Helvetica,sans-serif";

function rowsTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map((r, i) =>
    `<tr class="em-row"><td class="em-k" width="38%" valign="top" style="padding:7px 12px 7px 0;${i ? "border-top:1px solid #DCE4F4;" : ""}font-family:${FONT};font-size:13px;line-height:1.5;color:#566884;">${escHtml(r.label)}</td>` +
    `<td class="em-v" valign="top" style="padding:7px 0;${i ? "border-top:1px solid #DCE4F4;" : ""}font-family:${FONT};font-size:14px;line-height:1.5;color:#0B1B3F;font-weight:600;word-break:break-word;">${escHtml(r.value)}</td></tr>`).join("")}</table>`;
}
function panel(title, inner, { bg = "#F3F6FC", border = "#DCE4F4", titleColor = "#566884" } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${bg};border:1px solid ${border};border-radius:10px;">` +
    `<tr><td style="padding:14px 18px 4px;font-family:${FONT};font-size:13px;font-weight:700;color:${titleColor};">${escHtml(title)}</td></tr>` +
    `<tr><td style="padding:2px 18px 12px;">${inner}</td></tr></table>`;
}

function buildHtml(m) {
  const { L } = m;
  const t = (en, bn) => pick(L, en, bn);
  const header = m.logoUrl
    ? `<img src="${escHtml(m.logoUrl)}" alt="${escHtml(m.brand)}" height="30" style="display:block;border:0;height:30px;width:auto;font-family:${FONT};font-size:18px;font-weight:700;color:#FFFFFF;">`
    : `<span style="font-family:${FONT};font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:.2px;">${escHtml(m.brand)}</span>`;
  const instr = m.instrHtml ? panel(t("Important instructions", "গুরুত্বপূর্ণ নির্দেশনা"), m.instrHtml, { bg: "#FFF6E5", border: "#F1D9A8", titleColor: "#A86200" }) : "";
  const info = m.infoRows.length ? panel(t("Student information", "শিক্ষার্থীর তথ্য"), rowsTable(m.infoRows)) : "";
  const exam = m.examRows.length ? panel(t("Examination details", "পরীক্ষার তথ্য"), rowsTable(m.examRows), { bg: "#EEF4FF", border: "#CFDDF8", titleColor: "#1558E0" }) : "";
  const button = m.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px;"><tr><td align="center" bgcolor="#1558E0" style="border-radius:8px;"><a href="${escHtml(m.cta.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escHtml(m.cta.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 20px;font-family:${FONT};font-size:12px;line-height:1.6;color:#566884;">${escHtml(t("If the button does not work, copy this link into your browser:", "বাটনটি কাজ না করলে এই লিংকটি ব্রাউজারে কপি করে খুলুন:"))}<br><a href="${escHtml(m.cta.url)}" target="_blank" rel="noopener" style="color:#1558E0;word-break:break-all;">${escHtml(m.cta.url)}</a></p>`
    : "";
  const support = m.supportEmail
    ? `${escHtml(t("Need help? Write to", "সাহায্য দরকার? লিখুন:"))} <a href="mailto:${escHtml(m.supportEmail)}" style="color:#1558E0;">${escHtml(m.supportEmail)}</a>`
    : "";
  const site = m.siteUrl ? `${escHtml(t("Website", "ওয়েবসাইট"))}: <a href="${escHtml(m.siteUrl)}" target="_blank" rel="noopener" style="color:#1558E0;">${escHtml(m.siteUrl)}</a>` : "";
  const why = m.recipientEmail
    ? escHtml(t(`This email was sent to ${m.recipientEmail} because it is the registered address of your ${m.brand} account. It contains only information about your own account.`,
      `এই ইমেইলটি ${m.recipientEmail} ঠিকানায় পাঠানো হয়েছে, কারণ এটি আপনার ${m.brand} অ্যাকাউন্টের নিবন্ধিত ঠিকানা। এতে শুধু আপনার নিজের অ্যাকাউন্টের তথ্য আছে।`))
    : "";
  const lang = L === "bn" ? "bn" : "en";
  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<title>${escHtml(m.subject)}</title>
<style>
@media only screen and (max-width:620px){
  .em-box{width:100% !important;border-radius:0 !important;border-left:0 !important;border-right:0 !important;}
  .em-pad{padding-left:18px !important;padding-right:18px !important;}
  .em-k,.em-v{display:block !important;width:100% !important;padding-top:2px !important;padding-bottom:2px !important;border-top:0 !important;}
  .em-row{border-top:1px solid #DCE4F4;}
}
</style>
</head>
<body style="margin:0;padding:0;background:#F3F6FC;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F3F6FC;font-size:1px;line-height:1px;">${escHtml(m.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F6FC;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="em-box" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid #DCE4F4;border-radius:12px;overflow:hidden;">
<tr><td class="em-pad" style="background:#0A1B4D;padding:20px 28px;">${header}</td></tr>
<tr><td class="em-pad" style="padding:28px 28px 6px;font-family:${FONT};">
<h1 style="margin:0 0 18px;font-family:${FONT};font-size:21px;line-height:1.35;color:#0A1B4D;">${escHtml(m.subject)}</h1>
${m.greetingHtml ? `<p style="${P_STYLE}font-weight:600;">${m.greetingHtml}</p>` : ""}
${m.bodyHtml}
${instr}${info}${exam}${button}
${m.closingHtml}
${m.sigHtml ? `<p style="${P_STYLE}margin-top:6px;">${m.sigHtml}</p>` : ""}
</td></tr>
<tr><td class="em-pad" style="padding:18px 28px 24px;border-top:1px solid #DCE4F4;background:#F8FAFE;font-family:${FONT};font-size:12px;line-height:1.7;color:#566884;">
<strong style="color:#0A1B4D;">${escHtml(m.brand)}</strong><br>
${support}${support && site ? " &nbsp;·&nbsp; " : ""}${site}
${why ? `<br><span style="display:block;margin-top:8px;color:#7A8AA3;">${why}</span>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildText(m) {
  const { L } = m;
  const t = (en, bn) => pick(L, en, bn);
  const lines = [m.subject, "=".repeat(Math.min(60, Math.max(8, m.subject.length))), ""];
  if (m.greetingText) lines.push(m.greetingText, "");
  if (m.bodyText) lines.push(m.bodyText, "");
  if (m.instrText) lines.push(`${t("IMPORTANT INSTRUCTIONS", "গুরুত্বপূর্ণ নির্দেশনা")}`, m.instrText, "");
  if (m.infoRows.length) lines.push(t("STUDENT INFORMATION", "শিক্ষার্থীর তথ্য"), ...m.infoRows.map((r) => `- ${r.label}: ${r.value}`), "");
  if (m.examRows.length) lines.push(t("EXAMINATION DETAILS", "পরীক্ষার তথ্য"), ...m.examRows.map((r) => `- ${r.label}: ${r.value}`), "");
  if (m.cta) lines.push(`${m.cta.label}: ${m.cta.url}`, "");
  if (m.closingText) lines.push(m.closingText, "");
  if (m.sigText) lines.push(m.sigText, "");
  lines.push("--", m.brand);
  if (m.supportEmail) lines.push(`${t("Need help? Write to", "সাহায্য দরকার? লিখুন:")} ${m.supportEmail}`);
  if (m.siteUrl) lines.push(`${t("Website", "ওয়েবসাইট")}: ${m.siteUrl}`);
  return lines.join("\n");
}

/* ==========================================================================
   EmailJS template parameters
   ========================================================================== */
/**
 * What is handed to emailjs.send() for ONE recipient. The EmailJS template only needs:
 *   To Email {{to_email}} · From Name {{from_name}} · Reply To {{reply_to}} · Subject {{subject}} · Content {{{html_body}}}
 * Every variable is also passed under its own name, so a hand-made EmailJS template can use {{student_name}} etc.
 * `message_text` is the plain-text version ({{message_text}}) for anyone who wants a text-only template.
 */
export function buildEmailParams({ recipient, rendered, values, sender }) {
  const p = {
    to_email: String(recipient.email || "").trim(),
    to_name: oneLine(recipient.name, 120),
    from_name: oneLine(sender?.name || BRAND, 80),
    reply_to: isValidEmail(sender?.replyTo) ? String(sender.replyTo).trim() : "",
    subject: rendered.subject,
    html_body: rendered.html,
    message_text: rendered.text,
  };
  for (const k of VARIABLE_KEYS) p[k] = values?.[k] === null || values?.[k] === undefined ? "" : String(values[k]);
  return p;
}
export function paramsSize(params) {
  return new TextEncoder().encode(JSON.stringify(params)).length;
}

/** Clearly-fake values for test e-mails — a test never needs a real student's data. */
export function sampleValues({ lang = "en", site = {}, testEmail = "", exam = null } = {}) {
  const L = normLang(lang);
  const v = Object.fromEntries(VARIABLE_KEYS.map((k) => [k, null]));
  v.student_name = pick(L, "Sample Student", "নমুনা শিক্ষার্থী");
  v.student_email = isValidEmail(testEmail) ? testEmail : "sample.student@example.com";
  v.student_roll = "0000";
  v.course_name = pick(L, "Sample Course", "নমুনা কোর্স");
  v.exam_title = exam?.title || pick(L, "Sample Exam", "নমুনা পরীক্ষা");
  v.exam_duration = pick(L, "30 minutes", "৩০ মিনিট");
  v.exam_status = pick(L, "Sample data — not a real exam", "নমুনা তথ্য — আসল পরীক্ষা নয়");
  v.attempt_status = pick(L, "Sample status", "নমুনা অবস্থা");
  v.attempt_count = "0";
  v.website_url = safeHttpUrl(site.website) ? safeHttpUrl(site.website).replace(/\/+$/, "") : null;
  v.support_email = isValidEmail(site.email) ? site.email : null;
  v.exam_url = v.website_url ? `${v.website_url}/#/exam?id=sample` : null;
  v.personal_message = pick(L, "This is a test message.", "এটি একটি টেস্ট বার্তা।");
  return v;
}

