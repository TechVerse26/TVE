// ==========================================================================
// footer-config.js — the ONLY file to edit when a social page, a help page or a legal page goes live.
//
//   ""            not connected yet → the item stays in the footer, greyed out and not clickable (no broken links)
//   "https://…"   opens in a new tab
//   "#/route"     opens inside the app (the route must exist in app.js)
//   "mailto:…"    opens the mail app
//
// The footer itself lives in footer.js; its styles in css/footer.css.
// ==========================================================================
const SUPPORT_EMAIL = "tv.support.info@gmail.com";

export const FOOTER_CONFIG = {
  contact: {
    email: SUPPORT_EMAIL,
    website: "https://tvsites.vercel.app",
  },

  // Paste the real page links here — nothing is invented.
  social: {
    facebook: "https://www.facebook.com/irnahmed360",   // e.g. "https://www.facebook.com/<your-page>"
    youtube: "https://www.youtube.com/@techverseofficial26",    // e.g. "https://www.youtube.com/@<your-channel>"
    telegram: "https://t.me/techverseofficial26",   // e.g. "https://t.me/<your-channel>"
    whatsapp: "https://wa.me/8801957329211",
    github: "https://github.com/TechVerse26",
    linkedin: "https://www.linkedin.com/groups/42836312",   // e.g. "https://www.linkedin.com/company/<your-company>"
  },

  // "Student Resources" column + the legal links in the bottom bar. All seven are real pages of the app (routes in js/app.js,
  // words in js/about-data.js … js/credits-data.js). Clear one to "" and its footer item turns grey and unclickable again.
  pages: {
    about: "#/about",                      // About Us
    help: "#/help",                        // Help Center
    faq: "#/faq",                          // Frequently Asked Questions
    support: "#/help?section=contact",     // Contact Support → the Help Center's contact section (e-mail button + what to include)
    terms: "#/terms",                      // Terms & Conditions
    privacy: "#/privacy",                  // Privacy Policy
    credits: "#/credits",                  // Credits
  },
};
