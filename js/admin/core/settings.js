// ==========================================================================
// admin/core/settings.js — panel + exam-site configuration.
//
// Stored in adminSettings/main (admin-only read; Super Admin write). Everything has a
// built-in default, so the panel works even before the rules are published.
//
// `site` (maintenance mode) is ALSO copied into examIndex/main.site. Students already read
// that one document for the exam list, so they learn about maintenance mode for free —
// no extra Firestore read on the student side.
// ==========================================================================
import { db } from "../../firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const DEFAULTS = Object.freeze({
  general: { orgName: "Tech Verse Exam", pageSize: 25, compact: false },
  exam: { examType: "live", duration: 20, maxAttempts: 0, negativeMarking: 0, shuffle: true, layout: "one" },
  result: { passPercent: 60 },
  users: { inactiveDays: 30 },
  question: { defaultDifficulty: "medium", minOptions: 2, maxOptions: 6, requireExplanation: false },
  notification: { defaultAudience: "all" },
  security: { idleMinutes: 30, typeToConfirm: true },
  site: { maintenance: false, message: "" },
});

const clone = (o) => JSON.parse(JSON.stringify(o));
let current = clone(DEFAULTS);
let meta = { source: "defaults" };

export const getSettings = () => current;
export const settingsMeta = () => meta;

/** Keep only known keys whose type matches the default — a corrupt document can never poison the panel. */
function merge(base, extra) {
  const out = clone(base);
  for (const sec of Object.keys(base)) {
    for (const key of Object.keys(base[sec])) {
      const v = extra?.[sec]?.[key];
      if (v !== undefined && typeof v === typeof base[sec][key] && !(typeof v === "number" && Number.isNaN(v))) out[sec][key] = v;
    }
  }
  return out;
}

export function applyAppearance() {
  document.body.classList.toggle("compact", !!current.general.compact);
  const brand = document.getElementById("admin-brand-name");
  if (brand) brand.textContent = current.general.orgName || DEFAULTS.general.orgName;
  document.title = `Admin — ${current.general.orgName || DEFAULTS.general.orgName}`;
}

export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "adminSettings", "main"));
    current = merge(DEFAULTS, snap.exists() ? snap.data() : {});
    meta = { source: snap.exists() ? "saved" : "defaults", updatedAt: snap.data()?.updatedAt || null, updatedBy: snap.data()?.updatedBy || "" };
  } catch (err) {
    current = clone(DEFAULTS);
    meta = { source: err?.code === "permission-denied" ? "blocked" : "error" };
  }
  applyAppearance();
  return current;
}

export async function saveSettings(next, byName = "") {
  const clean = merge(DEFAULTS, next);
  await setDoc(doc(db, "adminSettings", "main"), { ...clean, updatedAt: serverTimestamp(), updatedBy: byName });
  current = clean;
  meta = { source: "saved", updatedAt: null, updatedBy: byName };
  applyAppearance();
  return current;
}

/** Copy the student-facing part of the settings into examIndex/main.site (1 write; students read it for free). */
export async function publishSiteConfig(site) {
  const body = { maintenance: !!site.maintenance, message: String(site.message || "").slice(0, 300) };
  await setDoc(doc(db, "examIndex", "main"), { site: body }, { merge: true });
}
