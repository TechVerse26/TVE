// ==========================================================================
// page-privacy.js — Privacy Policy (#/privacy).
// The wording lives in privacy-data.js, the "Last updated" date and the owner-supplied facts in info-config.js, the document layout
// (contents list, numbered sections) in info-ui.js. The page is public and static: nothing here talks to Firebase.
//   #/privacy?section=your-rights   opens the page scrolled to that section (the FAQ and the Help Center link this way)
// ==========================================================================
import { renderNav } from "./nav.js";
import { PRIVACY } from "./privacy-data.js";
import { LEGAL_DATES } from "./info-config.js";
import { legalPageHtml, bindLegalPage } from "./info-ui.js";

let renderToken = 0;

/** The whole page as one html string (pure: no DOM, no Firebase). */
export const privacyPageHtml = () => legalPageHtml({
  route: "privacy",
  kicker: PRIVACY.kicker, title: PRIVACY.title, lead: PRIVACY.lead,
  updatedIso: LEGAL_DATES.privacy,
  intro: PRIVACY.intro, sections: PRIVACY.sections, footer: PRIVACY.footer,
});

export async function initPrivacyPage(params, mount) {
  const my = ++renderToken;
  await renderNav("privacy");
  if (my !== renderToken) return;

  mount.innerHTML = privacyPageHtml();
  bindLegalPage(mount.querySelector(".inf"), params);
}
