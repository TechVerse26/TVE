// ==========================================================================
// footer.js — the shared site footer: markup + two tiny behaviours.
//
//   • phone (< 600px): the three link groups are native <details> accordions, closed by default
//   • a footer link that points at the page you are already on scrolls to the top instead of doing nothing
//
// Every URL comes from footer-config.js. Routes are the app's real routes (see app.js). Styles: css/footer.css.
// Deliberately independent of the app bundle (no Firebase import): it can never delay or break login / exams.
// ==========================================================================
import { FOOTER_CONFIG as CFG } from "./footer-config.js";

const WIDE = "(min-width: 600px)";   // at or above this width the groups are plain columns (never collapsed)

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------- destinations ---------- */
// Existing app routes only. "Browse Courses" is the navbar's Courses (#/exam); "My Exams" is the student's own
// per-exam performance page (#/performance); nothing here creates a page.
const QUICK = [
  { label: "Home", href: "#/home", icon: "fa-house" },
  { label: "Browse Courses", href: "#/exam", icon: "fa-book-open" },
  { label: "Practice Exams", href: "#/exams", icon: "fa-clipboard-check" },
  { label: "Exam Schedule", href: "#/schedule", icon: "fa-calendar-days" },
  { label: "Results", href: "#/results", icon: "fa-chart-column" },
  { label: "Leaderboard", href: "#/leaderboard", icon: "fa-ranking-star" },
];
const RESOURCES = [
  { label: "Help Center", href: CFG.pages.help, icon: "fa-circle-question" },
  { label: "Frequently Asked Questions", href: CFG.pages.faq, icon: "fa-comments" },
  { label: "Contact Support", href: CFG.pages.support, icon: "fa-headset" },
  { label: "Terms & Conditions", href: CFG.pages.terms, icon: "fa-file-contract" },
  { label: "Privacy Policy", href: CFG.pages.privacy, icon: "fa-shield-halved" },
];
const ACCOUNT = [
  { label: "Student Login", href: "#/login", icon: "fa-right-to-bracket" },
  { label: "Create Account", href: "#/signup", icon: "fa-user-plus" },
  { label: "My Exams", href: "#/performance", icon: "fa-file-circle-check" },
  { label: "My Results", href: "#/results", icon: "fa-chart-line" },
];
const SOCIAL = [
  { key: "facebook", label: "Facebook", icon: "fa-facebook-f" },
  { key: "youtube", label: "YouTube", icon: "fa-youtube" },
  { key: "whatsapp", label: "WhatsApp", icon: "fa-whatsapp" },
  { key: "telegram", label: "Telegram", icon: "fa-telegram" },
  { key: "linkedin", label: "LinkedIn", icon: "fa-linkedin-in" },
];
const LEGAL = [
  { label: "Privacy Policy", href: CFG.pages.privacy },
  { label: "Terms & Conditions", href: CFG.pages.terms },
];

/* ---------- link attributes ----------
   Empty / unsafe target → a disabled link (role=link + aria-disabled, no href): visible, announced, never a dead click.
   External https target → new tab with rel=noopener. Everything else (#/route, mailto:) stays in place. */
function linkAttrs(href, { newTab = false } = {}) {
  const h = String(href ?? "").trim();
  if (!h || /^(javascript|data|vbscript):/i.test(h)) return { live: false, ext: false, attr: ' role="link" aria-disabled="true" title="Coming soon"' };
  const ext = newTab || (/^https?:\/\//i.test(h) && !h.startsWith(window.location.origin));
  return { live: true, ext, attr: ` href="${esc(h)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}` };
}
const SR_NEW_TAB = '<span class="sr-only"> (opens in a new tab)</span>';
const SR_SOON = '<span class="sr-only"> — coming soon</span>';

/* ---------- markup ---------- */
function linkRow(it, chevron) {
  const a = linkAttrs(it.href);
  return `<li><a class="ftr-link${a.live ? "" : " is-pending"}"${a.attr}>`
    + `<i class="fa-solid ${it.icon} ftr-ico" aria-hidden="true"></i>`
    + `<span class="ftr-link-text">${esc(it.label)}${a.ext ? SR_NEW_TAB : ""}${a.live ? "" : SR_SOON}</span>`
    + (chevron ? '<i class="fa-solid fa-chevron-right ftr-chev" aria-hidden="true"></i>' : "")
    + "</a></li>";
}

// One group = a static heading (tablet / desktop) + a <details> accordion whose <summary> replaces that heading on phones.
function group(title, navLabel, items, { chevron = false } = {}) {
  return `<div class="ftr-group">
    <h2 class="ftr-heading ftr-heading--static">${esc(title)}</h2>
    <details class="ftr-acc" open>
      <summary class="ftr-summary"><span>${esc(title)}</span><i class="fa-solid fa-chevron-down ftr-caret" aria-hidden="true"></i></summary>
      <nav aria-label="${esc(navLabel)}"><ul class="ftr-links">${items.map((it) => linkRow(it, chevron)).join("")}</ul></nav>
    </details>
  </div>`;
}

function socialBtn(s) {
  const a = linkAttrs(CFG.social?.[s.key]);
  const name = a.live ? `${s.label}${a.ext ? " (opens in a new tab)" : ""}` : `${s.label} — coming soon`;
  return `<li><a class="ftr-social-btn${a.live ? "" : " is-pending"}"${a.attr} aria-label="Tech Verse Exam on ${esc(name)}"><i class="fa-brands ${s.icon}" aria-hidden="true"></i></a></li>`;
}

function contactItem(icon, label, valueHtml) {
  return `<li class="ftr-contact-item"><span class="ftr-contact-ico" aria-hidden="true"><i class="fa-solid ${icon}"></i></span>`
    + `<div class="ftr-contact-text"><span class="ftr-contact-label">${label}</span>${valueHtml}</div></li>`;
}

function legalLink(it) {
  const a = linkAttrs(it.href);
  return `<li><a class="ftr-legal-link${a.live ? "" : " is-pending"}"${a.attr}>${esc(it.label)}${a.ext ? SR_NEW_TAB : ""}${a.live ? "" : SR_SOON}</a></li>`;
}

function footerHtml() {
  const email = esc(CFG.contact.email);
  const site = esc(CFG.contact.website);
  return `<div class="container">
    <div class="ftr-main">
      <section class="ftr-brand" aria-label="About Tech Verse Exam">
        <a class="ftr-logo" href="#/home" aria-label="Tech Verse Exam — Home">
          <img src="assets/logo.svg" alt="" width="108" height="36" loading="lazy" decoding="async">
          <span class="ftr-logo-name"><b>Tech Verse</b><span>Exam</span></span>
        </a>
        <p class="ftr-about">Your trusted platform for online exams, practice tests, performance tracking, and academic excellence.</p>
        <ul class="ftr-social" aria-label="Social media">${SOCIAL.map(socialBtn).join("")}</ul>
      </section>
      ${group("Quick Navigation", "Footer quick navigation", QUICK, { chevron: true })}
      ${group("Student Resources", "Footer student resources", RESOURCES)}
      ${group("Account & Examination", "Footer account and examination", ACCOUNT)}
    </div>

    <section class="ftr-contact" aria-labelledby="ftr-contact-title">
      <h2 class="ftr-heading" id="ftr-contact-title">Contact Information</h2>
      <ul class="ftr-contact-list">
        ${contactItem("fa-envelope", "Email", `<a class="ftr-contact-value" href="mailto:${email}">${email}</a>`)}
        ${contactItem("fa-globe", "Website", `<a class="ftr-contact-value" href="${site}" target="_blank" rel="noopener noreferrer">${site}${SR_NEW_TAB}</a>`)}
      </ul>
    </section>

    <div class="ftr-bottom">
      <p class="ftr-copy">&copy; <span id="footer-year">${new Date().getFullYear()}</span> Tech Verse Exam. Your partner in learning and success.</p>
      <ul class="ftr-legal" aria-label="Legal">${LEGAL.map(legalLink).join("")}</ul>
    </div>
  </div>`;
}

/* ---------- behaviour ---------- */
function bindAccordions(root) {
  const mq = window.matchMedia(WIDE);
  const groups = [...root.querySelectorAll("details.ftr-acc")];
  const sync = () => groups.forEach((d) => { d.open = mq.matches; });   // columns: always open · phone: closed until tapped
  sync();
  if (mq.addEventListener) mq.addEventListener("change", sync); else mq.addListener?.(sync);
}

function bindSamePageLinks(root) {
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='#/']");
    if (!a || a.hash !== window.location.hash) return;   // a different route: the router handles it
    e.preventDefault();                                   // same route: the hash would not change → bring the page back to the top
    window.scrollTo({ top: 0 });
  });
}

export function mountFooter(root = document.getElementById("site-footer")) {
  if (!root || root.dataset.mounted) return;
  root.dataset.mounted = "1";
  root.innerHTML = footerHtml();
  bindAccordions(root);
  bindSamePageLinks(root);
}

/* The footer is drawn once the app has booted (window "load" fires after app.js and its imports ran), so it never
   flashes on a blank screen while the first page is still loading. The timer is only a safety net. */
let booted = false;
const boot = () => { if (!booted) { booted = true; mountFooter(); } };
if (document.readyState === "complete") boot();
else { window.addEventListener("load", boot, { once: true }); window.setTimeout(boot, 3000); }
