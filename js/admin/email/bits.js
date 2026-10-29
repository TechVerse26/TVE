// ==========================================================================
// admin/email/bits.js — small pieces the tabs share: status chips, banners, tab navigation, copy-to-clipboard.
// ==========================================================================
import { esc, chip } from "../core/ui.js";
import { toast } from "../../utils.js";
import { ROW_STATUS, CAMPAIGN_STATUS, EXAM_GROUPS, REASONS } from "../../email-core.js";
import { S, emit } from "./state.js";
import { settingsState, STATE_LABEL } from "./model.js";

export const rowChip = (status) => { const m = ROW_STATUS[status] || ROW_STATUS.pending; return chip(m.label, m.tone, m.icon); };
export const campaignChip = (status) => { const m = CAMPAIGN_STATUS[status] || CAMPAIGN_STATUS.draft; return chip(m.label, m.tone); };
export const groupChip = (status) => { const m = EXAM_GROUPS[status]; return m ? chip(m.label, m.tone, m.icon) : ""; };
export const reasonText = (r) => REASONS[r] || r;
export const examStateTone = { open: "teal", practice: "teal", upcoming: "accent", closed: "", cancelled: "coral", draft: "", registration_closed: "amber" };
export const examStateChip = (key) => (key && key !== "none" ? chip(STATE_LABEL[key] || key, examStateTone[key] || "") : "");

/** Switch tab from anywhere (the shell listens). */
export const goTab = (id) => emit("tab", id);

/** One-line status of the EmailJS configuration, used on Overview, Compose and Settings. */
export function configBanner({ compact = false } = {}) {
  const st = settingsState();
  const src = S.settingsMeta.source;
  if (src === "blocked") {
    return `<div class="note bad" role="alert"><i class="fa-solid fa-lock"></i> <b>Email settings পড়া যাচ্ছে না</b> (Firestore permission). firestore.rules-এর নতুন Email Center অংশ Publish করুন। <button type="button" class="link-btn" data-go-tab="settings">Settings দেখুন</button></div>`;
  }
  if (src === "error") return `<div class="note bad" role="alert"><i class="fa-solid fa-wifi"></i> Email settings লোড হয়নি (নেটওয়ার্ক?) — রিফ্রেশ করে দেখুন।</div>`;
  if (!st.complete) {
    return `<div class="note warn" role="alert"><i class="fa-solid fa-triangle-exclamation"></i> <b>EmailJS কনফিগার করা নেই</b> — ইমেইল পাঠানো বন্ধ আছে। ${S.canSettings ? `<button type="button" class="link-btn" data-go-tab="settings">Email Settings-এ গিয়ে Service ID, Template ID ও Public Key দিন</button>` : "একজন Super Admin-কে Email Settings পূরণ করতে বলুন।"}</div>`;
  }
  if (!st.tested) {
    return `<div class="note warn" role="status"><i class="fa-solid fa-flask-vial"></i> কনফিগারেশন আছে, কিন্তু <b>এখনো কোনো টেস্ট ইমেইল সফল হয়নি</b> — টেস্ট সফল না হওয়া পর্যন্ত পাঠানো বন্ধ। <button type="button" class="link-btn" data-go-tab="settings">টেস্ট পাঠান</button></div>`;
  }
  if (compact) return "";
  const t = S.settings.lastTest;
  return `<div class="note ok" role="status"><i class="fa-solid fa-circle-check"></i> কনফিগারেশন সম্পূর্ণ — শেষ টেস্টে EmailJS অনুরোধ গ্রহণ করেছে (${esc(new Date(t.at).toLocaleString())}). <small>ইনবক্সে পৌঁছানো নিশ্চিত হয় শুধু ইনবক্স দেখে।</small></div>`;
}

/** Delegated "go to tab" links: any [data-go-tab] inside `root`. */
export function bindTabLinks(root) {
  root.addEventListener("click", (e) => { const a = e.target.closest("[data-go-tab]"); if (a && root.contains(a)) { e.preventDefault(); goTab(a.dataset.goTab); } });
}

export async function copyText(text, okMsg = "কপি হয়েছে") {
  try { await navigator.clipboard.writeText(text); toast(okMsg, "success"); return true; }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove(); toast(ok ? okMsg : "কপি করা যায়নি — নিজে সিলেক্ট করে কপি করুন", ok ? "success" : "error"); return ok;
  }
}

/** Re-draw part of a tab without throwing the keyboard user's focus away: the same control is focused again afterwards. */
export function keepFocus(root, fn) {
  const a = document.activeElement;
  let sel = "";
  if (a && a !== document.body && root.contains(a)) {
    if (a.id) sel = `#${CSS.escape(a.id)}`;
    else for (const k of ["course", "group", "pick", "act", "lang", "fmt", "var", "prog", "goTab"]) {
      const key = k === "goTab" ? "goTab" : k;
      if (a.dataset?.[key] !== undefined) { sel = `[data-${k === "goTab" ? "go-tab" : k}="${CSS.escape(a.dataset[key])}"]`; break; }
    }
  }
  fn();
  if (sel) root.querySelector(sel)?.focus({ preventScroll: true });
}

/** Set innerHTML only when it actually changed. A live region that is re-drawn with identical markup must not replace the
 *  nodes under the user's finger — a click whose button was swapped between mouse-down and mouse-up is silently lost. */
export function setHtml(node, html) {
  if (!node) return;
  if (node.__html === html) return;
  node.__html = html;
  node.innerHTML = html;
}
