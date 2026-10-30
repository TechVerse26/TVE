// ==========================================================================
// pwa-config.js — the ONE place to set the screenshot shown in the "Install app" popup.
//
//   1. Upload your app screenshot anywhere that serves a direct image link
//      (your own site, e.g.  "assets/pwa/screenshot.png"  — or any https:// image host).
//   2. Paste the link between the quotes below. Nothing else needs editing.
//   3. Deploy. The popup shows exactly this image, keeping its original proportions.
//
// While the value is still the placeholder (or the image cannot be loaded) the popup shows a
// neutral Tech Verse Exam tile instead — never a stock or generated picture.
//
// This file holds settings only. How the popup looks lives in css/pwa-install.css and
// how installing works lives in js/pwa-install.js.
// ==========================================================================

/** Direct link to your app screenshot (https://… or a path inside this site). */
export const PWA_PREVIEW_IMAGE_URL = "PASTE_MY_APP_SCREENSHOT_URL_HERE";

/** What a screen reader says for the screenshot. Describe what the picture shows. */
export const PWA_PREVIEW_IMAGE_ALT = "Screenshot of the Tech Verse Exam app";
