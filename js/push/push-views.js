// ==========================================================================
// push-views.js — the HTML of every piece of student-side push UI, as pure functions (state in → string out).
// No DOM and no network here, so the texts, the escaping and every state are unit-tested in plain Node
// (tests/unit/push.test.mjs). push-ui.js puts these strings on the page and wires the clicks.
// ==========================================================================
import * as C from "./push-core.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Everything that came from outside (a notification's title, a device name …) goes through this before it is put in HTML. */
export const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ESC[c]);

export const ICON = { announcement: "fa-bullhorn", exam: "fa-file-pen", result: "fa-square-poll-vertical" };

export const SUPPORT_TEXT = {
  insecure: "নোটিফিকেশনের জন্য নিরাপদ (HTTPS) সংযোগ দরকার। সাইটটি https:// দিয়ে খুলুন।",
  "ios-install": "iPhone / iPad-এ পুশ নোটিফিকেশন কাজ করে শুধু হোম স্ক্রিনে যোগ করা অ্যাপে। Safari-র শেয়ার বাটন → “Add to Home Screen” দিয়ে ইনস্টল করে অ্যাপটি খুলে এখানে আসুন।",
  "no-sw": "এই ব্রাউজারে নোটিফিকেশন সার্ভিস চলে না। Chrome, Edge বা Firefox-এর নতুন সংস্করণ ব্যবহার করুন।",
  "no-push": "এই ব্রাউজারে পুশ নোটিফিকেশন কাজ করে না। Chrome, Edge বা Firefox-এর নতুন সংস্করণ ব্যবহার করুন।",
  default: "এই ডিভাইসে পুশ নোটিফিকেশন কাজ করে না।",
};

const BADGE = {
  on: { cls: "badge-green", icon: "fa-circle-check", text: "চালু" },
  off: { cls: "badge-muted", icon: "fa-bell-slash", text: "বন্ধ" },
  denied: { cls: "badge-coral", icon: "fa-ban", text: "ব্লক করা" },
  unsupported: { cls: "badge-amber", icon: "fa-circle-info", text: "সমর্থিত নয়" },
  busy: { cls: "badge-accent", icon: "fa-spinner fa-spin", text: "অপেক্ষা করুন" },
};
const SUB = {
  on: "নতুন পরীক্ষা, ফলাফল ও ঘোষণার খবর এই ডিভাইসে আসবে।",
  off: "সাইট খোলা না থাকলেও নতুন পরীক্ষা, ফলাফল ও ঘোষণার খবর এই ডিভাইসে পান।",
  denied: "ব্রাউজার এই সাইটের নোটিফিকেশন ব্লক করে রেখেছে।",
  unsupported: "এই ডিভাইস বা ব্রাউজারে পুশ নোটিফিকেশন পাওয়া যাচ্ছে না।",
  busy: "একটু অপেক্ষা করুন…",
};

/* ---------- the explaining card ---------- */
export function promptHtml() {
  return `
    <span class="tvp-prompt-ico" aria-hidden="true"><i class="fa-solid fa-bell"></i></span>
    <div class="tvp-prompt-main">
      <h2 class="tvp-prompt-title" id="tvp-p-title">পরীক্ষার খবর সবার আগে পান</h2>
      <p class="tvp-prompt-text" id="tvp-p-text">নতুন পরীক্ষা, শুরুর রিমাইন্ডার, ফলাফল প্রকাশ ও জরুরি ঘোষণা — সাইট খোলা না থাকলেও নোটিফিকেশন আসবে। নোটিফিকেশন পেজ থেকে যেকোনো সময় বন্ধ করতে পারবেন।</p>
      <p class="tvp-error" data-tvp-error role="alert" hidden></p>
      <div class="tvp-actions">
        <button type="button" class="btn btn-primary btn-sm" data-tvp="enable">${enableLabel(false)}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-tvp="later">এখন নয়</button>
      </div>
      <button type="button" class="tvp-never" data-tvp="never">আর দেখাবেন না</button>
    </div>`;
}

/** The label inside the "turn on" buttons (both cards): normal, or "please wait" while the browser / server answers. */
export function enableLabel(busy) {
  return busy
    ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> অপেক্ষা করুন…'
    : '<i class="fa-solid fa-bell" aria-hidden="true"></i> নোটিফিকেশন চালু করুন';
}

/* ---------- the settings card (#/notifications) ---------- */
const errorLine = (code) => `<p class="tvp-error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${esc(C.errorText(code))}</p>`;

function switchHtml(cat, on) {
  return `<label class="tvp-switch">
      <span class="tvp-switch-text"><b>${esc(C.CATEGORY_LABEL[cat])}</b><small>${esc(C.CATEGORY_HINT[cat])}</small></span>
      <input type="checkbox" role="switch" data-pref="${esc(cat)}"${on ? " checked" : ""}>
      <span class="tvp-switch-ui" aria-hidden="true"></span>
    </label>`;
}

export function deviceRowHtml(d, now = Date.now()) {
  const phone = d.platform === "android" || d.platform === "ios";
  return `<li class="tvp-device">
      <i class="fa-solid ${phone ? "fa-mobile-screen" : "fa-laptop"}" aria-hidden="true"></i>
      <span class="tvp-device-main"><b>${esc(d.label || "ব্রাউজার")}</b><small>${d.current ? "এই ডিভাইস · " : ""}শেষ সক্রিয়: ${esc(C.agoBn(d.lastSeenAt, now))}</small></span>
    </li>`;
}

function bodyHtml(s, now) {
  const err = s.error && s.phase !== "denied" && s.phase !== "unsupported" ? errorLine(s.error) : "";

  if (s.phase === "unsupported") {
    return `<p class="tvp-note">${esc(SUPPORT_TEXT[s.support && s.support.reason] || SUPPORT_TEXT.default)}</p>`;
  }
  if (s.phase === "denied") {
    return `<p class="tvp-note">চালু করতে ঠিকানা বারের পাশের তালা (সাইট সেটিংস) আইকনে চেপে “নোটিফিকেশন”-কে “অনুমতি দিন” করুন। তারপর এই পেজে ফিরে এলেই নিজে থেকে বুঝে নেবে। জোর করে কিছু চালু হবে না।</p>`;
  }
  if (s.phase === "on") {
    const devices = (s.devices || []).length
      ? `<div class="tvp-devices"><h3>আপনার ডিভাইস</h3><ul>${s.devices.map((d) => deviceRowHtml(d, now)).join("")}</ul></div>`
      : "";
    return `<p class="tvp-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> এই ডিভাইসে নোটিফিকেশন চালু আছে।</p>
      <fieldset class="tvp-prefs"><legend>কোন খবর পেতে চান</legend>${C.CATEGORIES.map((c) => switchHtml(c, s.prefs && s.prefs[c] !== false)).join("")}</fieldset>
      ${err}
      ${s.syncPending ? '<p class="tvp-note">সংযোগ ফিরলে নিজে থেকে হালনাগাদ হবে।</p>' : ""}
      ${devices}
      <div class="tvp-actions"><button type="button" class="btn btn-danger btn-sm" data-tvp="disable"><i class="fa-solid fa-bell-slash" aria-hidden="true"></i> এই ডিভাইসে বন্ধ করুন</button></div>`;
  }
  // off · busy
  const busy = s.phase === "busy";
  return `<ul class="tvp-benefits">
      <li><i class="fa-solid ${ICON.exam}" aria-hidden="true"></i> নতুন পরীক্ষা ও শুরুর রিমাইন্ডার</li>
      <li><i class="fa-solid ${ICON.result}" aria-hidden="true"></i> ফলাফল প্রকাশের খবর</li>
      <li><i class="fa-solid ${ICON.announcement}" aria-hidden="true"></i> জরুরি ঘোষণা</li>
    </ul>
    <p class="tvp-note">শুধু এই ডিভাইসে চালু হবে। কখনো জোর করা হয় না — যেকোনো সময় এখান থেকেই বন্ধ করতে পারবেন।</p>
    ${err}
    <div class="tvp-actions"><button type="button" class="btn btn-primary" data-tvp="enable"${busy ? " disabled" : ""}>${enableLabel(busy)}</button></div>`;
}

/** The inside of the settings card for one status snapshot (see getStatus() in push-student.js). */
export function settingsHtml(s, now = Date.now()) {
  const phase = BADGE[s.phase] ? s.phase : "off";
  const b = BADGE[phase];
  return `<div class="card-head tvp-head">
      <span class="card-icon${phase === "on" ? " card-icon--green" : ""}" aria-hidden="true"><i class="fa-solid ${phase === "on" ? "fa-bell" : "fa-bell-slash"}"></i></span>
      <div class="tvp-head-text"><h2 class="card-title" id="tvp-s-title">পুশ নোটিফিকেশন</h2><p class="card-sub">${esc(SUB[phase])}</p></div>
      <span class="badge ${b.cls}"><i class="fa-solid ${b.icon}" aria-hidden="true"></i> ${b.text}</span>
    </div>
    ${bodyHtml({ ...s, phase }, now)}`;
}

/* ---------- the in-page banner (a notification that arrives while the site is open) ---------- */
export function bannerHtml(n) {
  return `<span class="tvp-banner-ico" aria-hidden="true"><i class="fa-solid ${ICON[n.cat] || ICON.announcement}"></i></span>
    <div class="tvp-banner-text">
      <b>${esc(n.title)}</b>
      ${n.body ? `<span class="tvp-banner-body">${esc(n.body)}</span>` : ""}
      <button type="button" class="btn btn-primary btn-sm" data-tvp="go">দেখুন</button>
    </div>
    <button type="button" class="tvp-x" data-tvp="close" aria-label="বন্ধ করুন"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
}
