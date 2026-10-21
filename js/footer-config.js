// ==========================================================================
// footer-config.js — the ONLY file to edit when a social page, a help page or a legal page goes live.
//
//   ""            not connected yet → the item stays in the footer, greyed out and not clickable (no broken links)
//   "https://…"   opens in a new tab
//   "#/route"     opens inside the app (e.g. "#/faq" once that page exists in app.js)
//   "mailto:…"    opens the mail app
//
// The footer itself lives in footer.js; its styles in css/footer.css.
// ==========================================================================
const SUPPORT_EMAIL = "tv.support.info@gmail.com";

export const FOOTER_CONFIG = {
  contact: {
    email: SUPPORT_EMAIL,
    website: "https://tvexam.vercel.app",
  },

  // Paste the real page links here — nothing is invented.
  social: {
    facebook: "",   // e.g. "https://www.facebook.com/<your-page>"
    youtube: "",    // e.g. "https://www.youtube.com/@<your-channel>"
    telegram: "",   // e.g. "https://t.me/<your-channel>"
    linkedin: "",   // e.g. "https://www.linkedin.com/company/<your-company>"
  },

  // "Student Resources" column + the legal links in the bottom bar.
  pages: {
    help: "",                              // Help Center
    faq: "",                               // Frequently Asked Questions
    support: `mailto:${SUPPORT_EMAIL}`,    // Contact Support → the support inbox until a support page exists
    terms: "",                             // Terms & Conditions
    privacy: "",                           // Privacy Policy
  },
};
