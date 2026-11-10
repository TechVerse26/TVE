#!/usr/bin/env node
// Copies the website's PURE-LOGIC modules (no DOM, no Firebase imports) into src/shared/web/ byte for byte,
// so the app uses exactly the website's scheduling, status, analytics, academic-tree and content rules.
//   node scripts/sync-shared.mjs          copy
//   node scripts/sync-shared.mjs --check  fail if a copy has drifted from the website (used by `npm test`)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..", "..", "js");
const out = resolve(here, "..", "src", "shared", "web");
const FILES = [
  ["schedule-core.js", "schedule-core.js"], ["home-core.js", "home-core.js"],
  ["exam-session-core.js", "exam-session-core.js"], ["exam-analytics.js", "exam-analytics.js"],
  ["academic-core.js", "academic-core.js"], ["auth-reset-core.js", "auth-reset-core.js"],
  ["faq-data.js", "faq-data.js"], ["help-data.js", "help-data.js"], ["about-data.js", "about-data.js"],
  ["credits-data.js", "credits-data.js"], ["whats-new-data.js", "whats-new-data.js"],
  ["privacy-data.js", "privacy-data.js"], ["terms-data.js", "terms-data.js"],
  ["info-config.js", "info-config.js"], ["info-core.js", "info-core.js"], ["footer-config.js", "footer-config.js"],
  ["admin/core/permissions.js", "permissions.js"],
];
const check = process.argv.includes("--check");
if (!existsSync(site)) {
  // The app was moved out of the repository: keep the committed copies as they are.
  console.log("sync-shared: website folder not found next to mobile-app/ — using the committed copies.");
  process.exit(0);
}
let drift = 0;
mkdirSync(out, { recursive: true });
for (const [from, to] of FILES) {
  const src = readFileSync(join(site, from));
  const dst = join(out, to);
  if (check) {
    if (!existsSync(dst) || !readFileSync(dst).equals(src)) { console.error(`✗ drifted: ${to}`); drift++; }
  } else {
    writeFileSync(dst, src);
  }
}
if (check) {
  if (drift) { console.error(`${drift} shared module(s) differ from the website — run: npm run sync:shared`); process.exit(1); }
  console.log(`✓ ${FILES.length} shared modules identical to the website`);
} else {
  console.log(`✓ synced ${FILES.length} shared modules from ../js`);
}
