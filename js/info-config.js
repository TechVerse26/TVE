// ==========================================================================
// info-config.js — the ONE place to edit the facts printed on the six information pages
// (About Us · FAQ · Help Center · Privacy Policy · Terms & Conditions · Credits).
//
//   SITE           name, support e-mail and website. Taken from footer-config.js, so the footer, the Help Center and the
//                  legal pages can never disagree about the support address.
//   LEGAL_DATES    the "Last updated" date printed on the Privacy Policy and on the Terms (YYYY-MM-DD).
//                  Change it whenever you change the wording of either document.
//   OWNER_DETAILS  facts that CANNOT be read from the source code (legal entity, data location, retention period …).
//                  Nothing is invented for them: while `value` is empty, the page shows a clearly marked
//                  "To be confirmed" note in that place. Type the confirmed text into `value` and the note turns into
//                  ordinary text — no other file needs to change.
//
// Pure data, no DOM and no Firebase: safe to import from the Node unit tests.
// ==========================================================================
import { FOOTER_CONFIG } from "./footer-config.js";

export const SITE = Object.freeze({
  name: "Tech Verse Exam",
  email: FOOTER_CONFIG.contact.email,
  website: FOOTER_CONFIG.contact.website,
});

export const LEGAL_DATES = Object.freeze({
  privacy: "2026-10-23",
  terms: "2026-10-23",
});

export const OWNER_DETAILS = {
  operator: {
    value: "",   // e.g. "Example Education Ltd., 12 Example Road, Dhaka" — the organisation that legally operates the site
    label: "operator's legal name and registered address",
  },
  minimumAge: {
    value: "",   // e.g. "You must be at least 13 years old. Students under 18 should use the platform with a parent's or guardian's permission."
    label: "minimum age and guardian-consent rules",
  },
  dataLocation: {
    value: "",   // the region chosen for the Firestore database in the Firebase console
    label: "region where data is stored",
  },
  hostingLogs: {
    value: "",   // what the hosting provider of the website address logs, and whether its analytics are switched on
    label: "hosting provider logs and analytics",
  },
  retention: {
    value: "",   // e.g. "Account and result records are kept for as long as the account exists and are removed on request."
    label: "retention period for account and result records",
  },
  deletion: {
    value: "",   // how a request to correct or delete data is handled and how long it takes
    label: "how correction and deletion requests are handled",
  },
  dataLaw: {
    value: "",   // the data-protection law(s) that apply to the students you serve, and what rights they give
    label: "data-protection laws that apply",
  },
  governingLaw: {
    value: "",   // e.g. "the laws of Bangladesh; disputes are subject to the courts of Dhaka"
    label: "governing law and place of jurisdiction",
  },
  contentOwnership: {
    value: "",   // who owns the exam questions and course material shown on the site, and under what licence
    label: "ownership and licensing of exam content",
  },
};
