// ==========================================================================
// page-terms.js — Terms & Conditions (#/terms).
// The wording lives in terms-data.js, the "Last updated" date and the owner-supplied facts in info-config.js, the document layout
// (contents list, numbered sections) in info-ui.js. The page is public and static: nothing here talks to Firebase.
//   #/terms?section=integrity   opens the page scrolled to that section
// ==========================================================================
import { renderNav } from "./nav.js";
import { TERMS } from "./terms-data.js";
import { LEGAL_DATES } from "./info-config.js";
import { legalPageHtml, bindLegalPage } from "./info-ui.js";

let renderToken = 0;

/** The whole page as one html string (pure: no DOM, no Firebase). */
export const termsPageHtml = () => legalPageHtml({
  route: "terms",
  kicker: TERMS.kicker, title: TERMS.title, lead: TERMS.lead,
  updatedIso: LEGAL_DATES.terms,
  intro: TERMS.intro, sections: TERMS.sections, footer: TERMS.footer,
});

export async function initTermsPage(params, mount) {
  const my = ++renderToken;
  await renderNav("terms");
  if (my !== renderToken) return;

  mount.innerHTML = termsPageHtml();
  bindLegalPage(mount.querySelector(".inf"), params);
}
