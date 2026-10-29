// ==========================================================================
// admin/email/view-settings.js — "Email Settings": the EmailJS connection (Firestore: emailSettings/main).
//
// Only PUBLIC identifiers live here: Service ID, Template ID and the Public Key. EmailJS' PRIVATE key (accessToken) is for
// servers and must never be typed into a browser app — this screen has no field for it, on purpose.
// Saving needs a Super Admin (firestore.rules); a Manager can read the status and send tests.
// "Configured" is never claimed on the strength of the form alone: only a REAL test request that EmailJS accepted unlocks sending.
// ==========================================================================
import { toast } from "../../utils.js";
import { esc, chip, withBusy, isDenied } from "../core/ui.js";
import { logAction } from "../core/audit.js";
import { VARIABLES } from "../../email-core.js";
import { normalizeSettings, settingsIssues, maskKey, MIN_INTERVAL_MS, SDK_VERSION, estimateMs } from "../../email-service.js";
import { SITE } from "../../info-config.js";
import * as store from "./store.js";
import { S, on } from "./state.js";
import { settingsState, refreshSettings, replyToOf } from "./model.js";
import { configBanner, bindTabLinks, copyText } from "./bits.js";
import { openTestSend } from "./send.js";

let host = null;
const TZ_SUGGEST = ["Asia/Dhaka", "Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Asia/Kuala_Lumpur", "Europe/London", "America/New_York", "UTC"];

const TEMPLATE_FIELDS = [
  ["To Email", "{{to_email}}", "প্রতিটি ইমেইল শুধু এই একজন প্রাপকের কাছে যায়"],
  ["From Name", "{{from_name}}", "প্রেরকের প্রদর্শিত নাম (উপরের Sender name)"],
  ["Reply To", "{{reply_to}}", "উত্তর যাবে সাপোর্ট ইমেইলে"],
  ["Subject", "{{subject}}", "প্রতিটি প্রাপকের জন্য তৈরি করা বিষয়"],
  ["Content", "{{{html_body}}}", "তিনটি { } — না হলে HTML লেখা হিসেবে ছাপা হবে। Editor mode: Code Editor (HTML)"],
  ["Cc / Bcc", "(ফাঁকা রাখুন)", "কখনো সব শিক্ষার্থীকে CC/BCC করা হয় না"],
];

function statusPanel() {
  const st = settingsState();
  const s = S.settings;
  const need = (ok, label) => chip(`${label} ${ok ? "✓" : "missing"}`, ok ? "teal" : "coral", ok ? "fa-check" : "fa-xmark");
  const t = s.lastTest;
  const lastTest = !t ? `<span class="muted">কখনো টেস্ট করা হয়নি</span>`
    : st.tested ? `<span class="em-ok"><i class="fa-solid fa-circle-check"></i> সর্বশেষ টেস্টে EmailJS অনুরোধ গ্রহণ করেছে — ${esc(new Date(t.at).toLocaleString())} · ${esc(t.to || "")}</span>`
    : t.ok ? `<span class="em-warn"><i class="fa-solid fa-circle-question"></i> সর্বশেষ সফল টেস্ট ছিল অন্য কনফিগারেশনে (${esc(new Date(t.at).toLocaleString())}) — এখনকারটা আবার টেস্ট করুন</span>`
    : `<span class="em-bad"><i class="fa-solid fa-circle-xmark"></i> সর্বশেষ টেস্ট ব্যর্থ — HTTP ${esc(String(t.status || "—"))} ${esc(t.text || "")}</span>`;
  return `${configBanner()}
    <div class="em-chips">${need(!!s.serviceId, "Service ID")} ${need(!!s.templateId, "Template ID")} ${need(!!s.publicKey, "Public Key")} ${chip(`SDK v${SDK_VERSION}`, "")}</div>
    <p class="em-lasttest">${lastTest}</p>`;
}

function formHtml() {
  const s = S.settings;
  const ro = S.canSettings ? "" : "disabled";
  return `
    ${S.canSettings ? "" : `<div class="note"><i class="fa-solid fa-lock"></i> শুধু <b>Super Admin</b> EmailJS সেটিংস বদলাতে পারেন। আপনি অবস্থা দেখতে ও টেস্ট ইমেইল পাঠাতে পারেন।</div>`}
    <div class="admin-grid">
      <div class="field"><label for="st-service">EmailJS Service ID</label><input type="text" id="st-service" ${ro} autocomplete="off" spellcheck="false" value="${esc(s.serviceId)}" placeholder="service_xxxxxxx"></div>
      <div class="field"><label for="st-template">EmailJS Template ID</label><input type="text" id="st-template" ${ro} autocomplete="off" spellcheck="false" value="${esc(s.templateId)}" placeholder="template_xxxxxxx"></div>
      <div class="field"><label for="st-key">EmailJS Public Key <small>(গোপন চাবি নয়, তবে মাস্ক করা থাকে)</small></label>
        <div class="em-keyrow"><input type="password" id="st-key" ${ro} autocomplete="new-password" spellcheck="false" value="" placeholder="${s.publicKey ? esc(maskKey(s.publicKey)) + " (সেভ করা আছে — বদলাতে নতুন কী লিখুন)" : "Account → General → Public Key"}">
          <button type="button" class="btn btn-outline btn-sm" data-act="reveal" ${s.publicKey ? "" : "disabled"} aria-pressed="false">Show</button></div>
        <small class="form-hint">⚠ এখানে EmailJS-এর <b>Private Key</b> কখনো বসাবেন না — সেটি শুধু সার্ভারের জন্য।</small></div>
      <div class="field"><label for="st-sender">Default sender name</label><input type="text" id="st-sender" ${ro} maxlength="80" value="${esc(s.senderName)}"></div>
      <div class="field"><label for="st-reply">Reply-to address <small>(ফাঁকা = সাপোর্ট ইমেইল)</small></label><input type="email" id="st-reply" ${ro} value="${esc(s.replyTo)}" placeholder="${esc(SITE.email)}" autocomplete="off"></div>
      <div class="field"><label for="st-test">Test email address</label><input type="email" id="st-test" ${ro} value="${esc(s.testEmail)}" placeholder="you@example.com" autocomplete="off"></div>
      <div class="field"><label for="st-cap">Safety cap <small>(এক ক্যাম্পেইনে সর্বোচ্চ প্রাপক; 0 = সীমা নেই)</small></label><input type="number" id="st-cap" ${ro} min="0" max="100000" value="${s.safetyCap}"></div>
      <div class="field"><label for="st-int">Gap between emails (ms)</label><input type="number" id="st-int" ${ro} min="${MIN_INTERVAL_MS}" max="10000" step="100" value="${s.intervalMs}"><small class="form-hint">EmailJS প্রতি সেকেন্ডে ১টি রিকোয়েস্ট অনুমোদন করে — তাই ${MIN_INTERVAL_MS} ms-এর নিচে নামানো যায় না। ১০০ জনে ≈ ${Math.round(estimateMs(100, s.intervalMs) / 1000)} সেকেন্ড।</small></div>
      <div class="field"><label for="st-tz">Time zone for dates in emails</label><input type="text" id="st-tz" ${ro} list="st-tzs" value="${esc(s.timeZone)}" autocomplete="off" spellcheck="false"><datalist id="st-tzs">${TZ_SUGGEST.map((z) => `<option value="${z}">`).join("")}</datalist></div>
    </div>
    <div class="admin-grid">
      <div class="field"><label class="em-check"><input type="checkbox" id="st-logo" ${ro} ${s.showLogo ? "checked" : ""}> Show the logo image in the e-mail header</label>
        <label for="st-logourl" class="sr">Logo URL</label><input type="url" id="st-logourl" ${ro} value="${esc(s.logoUrl)}" placeholder="${esc(`${String(SITE.website).replace(/\/+$/, "")}/assets/email-logo.png`)}" autocomplete="off">
        <small class="form-hint">ফাঁকা = সাইটের <code>assets/email-logo.png</code> (এই আপডেটের সাথে দেওয়া PNG — সাইট ডিপ্লয় করলে চালু হয়)। PNG/JPG লাগবে; Gmail SVG দেখায় না।</small></div>
      <div class="field"><label>Website &amp; support e-mail <small>(js/footer-config.js — একমাত্র উৎস)</small></label>
        <dl class="em-kv sm"><div><dt>Website</dt><dd>${esc(SITE.website)}</dd></div><div><dt>Support / footer</dt><dd>${esc(SITE.email)}</dd></div><div><dt>Reply-to used</dt><dd>${esc(replyToOf(s))}</dd></div></dl>
        <small class="form-hint">এগুলো বদলাতে <code>js/footer-config.js</code> এডিট করুন — এখানে আলাদা কপি রাখা হয় না।</small></div>
    </div>
    <div class="em-form-actions">
      ${S.canSettings ? `<button type="button" class="btn btn-primary" data-act="save"><i class="fa-solid fa-floppy-disk"></i> Save settings</button>` : ""}
      <button type="button" class="btn btn-outline" data-act="test"><i class="fa-solid fa-flask-vial"></i> Send test email</button>
      <small class="form-hint" id="st-hint">টেস্ট সবসময় <b>সেভ করা</b> কনফিগারেশন দিয়ে যায় — আগে Save করুন।</small>
    </div>`;
}

function checklistHtml() {
  return `<p>EmailJS Dashboard → <b>Email Templates</b> → আপনার টেমপ্লেট → Settings ট্যাবে ঠিক এই মানগুলো বসান:</p>
    <div class="tbl-wrap"><table class="tbl em-map"><thead><tr><th>EmailJS field</th><th>Value</th><th>Why</th></tr></thead><tbody>
      ${TEMPLATE_FIELDS.map(([k, v, w]) => `<tr><td data-label="Field"><b>${esc(k)}</b></td><td data-label="Value"><code>${esc(v)}</code>${v.startsWith("{") ? ` <button type="button" class="icon-btn" data-copy="${esc(v)}" aria-label="Copy ${esc(v)}"><i class="fa-regular fa-copy"></i></button>` : ""}</td><td data-label="Why">${esc(w)}</td></tr>`).join("")}
    </tbody></table></div>
    <details class="em-vars"><summary>প্রতিটি ইমেইলের সাথে যে প্যারামিটারগুলো পাঠানো হয় (নিজের EmailJS টেমপ্লেটে ব্যবহার করতে চাইলে)</summary>
      <div class="em-var-grid">${["to_email", "to_name", "from_name", "reply_to", "subject", "html_body", "message_text", ...VARIABLES.map((v) => v.key)].map((k) => `<span class="em-var static"><code>{{${k}}}</code></span>`).join("")}</div>
      <p class="form-hint"><code>{{{html_body}}}</code> = সম্পূর্ণ তৈরি-করা HTML ইমেইল · <code>{{message_text}}</code> = শুধু-টেক্সট সংস্করণ (প্লেইন-টেক্সট টেমপ্লেটের জন্য)। EmailJS নিজেই HTML-এর সাথে একটি টেক্সট অংশও (multipart) পাঠায়।</p></details>
    <details class="em-vars"><summary>ভেরিয়েবল → ডেটার উৎস (সম্পূর্ণ ম্যাপিং)</summary>
      <div class="tbl-wrap"><table class="tbl em-map"><thead><tr><th>Variable</th><th>Comes from</th></tr></thead><tbody>${VARIABLES.map((v) => `<tr><td data-label="Variable"><code>{{${v.key}}}</code></td><td data-label="Source">${esc(v.source)}</td></tr>`).join("")}</tbody></table></div></details>`;
}

function guideHtml() {
  return `<ol class="em-steps">
    <li><b>EmailJS অ্যাকাউন্ট</b> খুলুন/লগইন করুন (emailjs.com)।</li>
    <li><b>Email Services → Add New Service</b> → আপনার ইমেইল প্রোভাইডার (যেমন Gmail) বেছে সংযুক্ত করুন। যে ইমেইল অ্যাকাউন্ট সংযুক্ত করবেন, <u>সেটিই প্রেরকের ঠিকানা</u> হিসেবে দেখা যাবে — কোড থেকে প্রেরকের ঠিকানা বদলানো যায় না। সার্ভিসের <b>Service ID</b> কপি করুন।</li>
    <li><b>Email Templates → Create New Template</b> → Editor হিসেবে <b>Code Editor</b> নিন। Content-এ শুধু <code>{{{html_body}}}</code> লিখুন। ওপরের চেকলিস্ট অনুযায়ী To Email, From Name, Reply To, Subject বসান; Cc/Bcc ফাঁকা রাখুন। Save করে <b>Template ID</b> কপি করুন।</li>
    <li><b>Account → General</b> থেকে <b>Public Key</b> কপি করুন (Private Key নয়)।</li>
    <li><b>Account → Security</b>-তে: “non-browser API calls” বন্ধ রাখুন; আপনার প্ল্যানে থাকলে <b>Allowed domains / origins</b>-এ শুধু আপনার অ্যাডমিন সাইটের ডোমেইন দিন এবং headless-ব্রাউজার ব্লক চালু করুন।</li>
    <li>এখানে তিনটি মান বসিয়ে <b>Save settings</b> চাপুন, তারপর <b>Send test email</b> — ইনবক্সে (স্প্যামসহ) সত্যিই এসেছে কিনা দেখুন।</li>
  </ol>
  <div class="note warn"><i class="fa-solid fa-shield-halved"></i> <b>নিরাপত্তা সীমাবদ্ধতা (সৎভাবে):</b> ব্রাউজার-থেকে-EmailJS পদ্ধতিতে Public Key + Service ID + Template ID জানা যে কেউ (Allowed-domains না থাকলে) EmailJS API-তে অনুরোধ পাঠাতে পারে — আর এই টেমপ্লেটে প্রাপক ঠিকানা ভেরিয়েবল। তাই: (১) এই আইডিগুলো সোর্স-কোডে নয়, Firestore-এ থাকে এবং শুধু Super Admin/Manager পড়তে পারেন; (২) ওপরের Allowed-domains সেটিং চালু করুন; (৩) আলাদা, শুধু-এই-কাজের সার্ভিস/টেমপ্লেট ব্যবহার করুন; (৪) সন্দেহ হলে EmailJS-এ Public Key বদলে এখানে নতুনটি দিন। পুরোপুরি সার্ভার-সাইড নিয়ন্ত্রণ চাইলে একটি Cloud Function লাগবে — বর্তমান আর্কিটেকচারে (ব্যাকএন্ড নেই) এটাই সবচেয়ে নিরাপদ সম্ভব রূপ।</div>`;
}

const readForm = (el) => normalizeSettings({
  ...S.settings,
  serviceId: el.querySelector("#st-service").value, templateId: el.querySelector("#st-template").value,
  publicKey: el.querySelector("#st-key").value.trim() || S.settings.publicKey,
  senderName: el.querySelector("#st-sender").value, replyTo: el.querySelector("#st-reply").value, testEmail: el.querySelector("#st-test").value,
  safetyCap: el.querySelector("#st-cap").value, intervalMs: el.querySelector("#st-int").value, timeZone: el.querySelector("#st-tz").value.trim(),
  showLogo: el.querySelector("#st-logo").checked, logoUrl: el.querySelector("#st-logourl").value,
});

function paint(el) {
  el.querySelector("#st-status").innerHTML = statusPanel();
  el.querySelector("#st-form").innerHTML = formHtml();
}

export const settings = {
  mount(el) {
    host = el;
    el.innerHTML = `
      <div class="panel"><div class="panel-head"><div><h2>EmailJS connection</h2><small>শুধু পাবলিক আইডি — কোনো গোপন চাবি নয়</small></div></div><div class="panel-body"><div id="st-status"></div><div id="st-form"></div></div></div>
      <div class="panel"><div class="panel-head"><div><h2>EmailJS template checklist</h2><small>EmailJS-এর টেমপ্লেটে কী কী থাকতে হবে</small></div></div><div class="panel-body">${checklistHtml()}</div></div>
      <div class="panel"><div class="panel-head"><div><h2>Setup guide</h2><small>EmailJS Dashboard-এ ধাপে ধাপে</small></div></div><div class="panel-body">${guideHtml()}</div></div>`;
    bindTabLinks(el);
    el.addEventListener("click", async (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) { copyText(copy.dataset.copy); return; }
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "reveal") {
        const input = el.querySelector("#st-key");
        const showing = input.type === "text";
        if (!showing && !input.value) input.value = S.settings.publicKey;
        input.type = showing ? "password" : "text";
        a.textContent = showing ? "Show" : "Hide"; a.setAttribute("aria-pressed", String(!showing));
      } else if (a.dataset.act === "test") {
        openTestSend("");
      } else if (a.dataset.act === "save") {
        const next = readForm(el);
        const problems = settingsIssues(next).filter((i) => i.required);
        if (problems.length) { toast(problems[0].message, "error"); el.querySelector(`#st-${{ serviceId: "service", templateId: "template", publicKey: "key", replyTo: "reply", timeZone: "tz" }[problems[0].field] || "service"}`)?.focus(); return; }
        const prev = S.settings;
        const changed = ["serviceId", "templateId", "publicKey", "senderName", "replyTo", "testEmail", "safetyCap", "intervalMs", "timeZone", "showLogo", "logoUrl"].filter((k) => String(prev[k]) !== String(next[k]));
        await withBusy(a, async () => {
          try {
            await store.saveSettings(next, S.me?.name || "");
            logAction("email.settings", { type: "email-settings", label: "EmailJS settings", detail: changed.length ? `changed: ${changed.join(", ")}` : "saved (no change)" });
            await refreshSettings();
            toast(changed.some((k) => ["serviceId", "templateId", "publicKey"].includes(k)) ? "সেভ হয়েছে — কনফিগারেশন বদলেছে, তাই আবার একটি টেস্ট ইমেইল পাঠান" : "সেটিংস সেভ হয়েছে", "success");
          } catch (err) {
            toast(isDenied(err) ? "সেভ করার অনুমতি নেই — শুধু Super Admin পারেন, এবং firestore.rules Publish করা থাকতে হবে" : `সেভ হয়নি: ${err?.message || err}`, "error");
          }
        });
      }
    });
    on("settings", () => { if (S.tab === "settings") paint(el); });
    paint(el);
  },
  refresh(el) { paint(el); },
};
