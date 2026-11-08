// ==========================================================================
// push-admin-core.js — the pure rules of the admin "Push Notifications" page.
// No DOM, no network, no Firebase here, so every rule below is unit-tested in plain Node (tests/unit/push-admin.test.mjs).
//
//   The page (js/admin/push.js + js/admin/push/*) only draws these results and forwards clicks. NOTHING in this file is a
//   security control: the server (server/push/*) re-validates every field and re-checks the admin role on every call. These
//   rules exist so the admin gets a clear message BEFORE a request is made — and so what the screen says matches the truth.
// ==========================================================================
import { safeRoute } from "./push-core.js";

export const DEFAULT_LIMITS = Object.freeze({
  titleMax: 65, bodyMax: 240, imageUrlMax: 500, maxRecipients: 5000, maxScheduleDays: 366, imageMaxBytes: 700 * 1024, thumbMaxBytes: 24 * 1024, maxImages: 60,
});

/** Same counting as the server: one unit per Unicode character (so Bengali letters + signs each count). */
export const cpLen = (s) => Array.from(String(s == null ? "" : s)).length;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/* ---------- what kind of notification ---------- */
export const TYPES = [
  { id: "announcement", label: "Announcement", bn: "ঘোষণা", icon: "fa-bullhorn", help: "Notices, news and urgent information." },
  { id: "exam", label: "Exam", bn: "পরীক্ষা", icon: "fa-file-pen", help: "A new exam, a schedule change, a reminder." },
  { id: "result", label: "Result", bn: "ফলাফল", icon: "fa-square-poll-vertical", help: "Results are published." },
];

/* ---------- where a tap leads (only pages of this site) ---------- */
export const PAGES = [
  ["#/home", "Home"], ["#/exams", "All exams"], ["#/schedule", "Exam schedule"], ["#/notifications", "Notifications"],
  ["#/results", "My results"], ["#/leaderboard", "Leaderboard"], ["#/performance", "My performance"], ["#/categories", "Categories"], ["#/profile", "Profile"],
];

/** → { ok, value } or { ok:false, error }.  The value is always "#/route[?query]" of this site — never another website. */
export function destinationFor(f) {
  const mode = f.destMode || "page";
  if (mode === "page") {
    const v = safeRoute(f.destPage || "#/home");
    return v ? { ok: true, value: v } : { ok: false, error: "Choose a page." };
  }
  if (mode === "exam") {
    if (typeof f.destExamId !== "string" || !ID_RE.test(f.destExamId)) return { ok: false, error: "Choose the exam to open." };
    return { ok: true, value: `#/exams?open=${f.destExamId}` };
  }
  const raw = String(f.destCustom || "").trim();
  if (!raw) return { ok: true, value: "#/home" };
  const v = safeRoute(raw);
  return v ? { ok: true, value: v } : { ok: false, error: "Use a page of this site, like #/results. Links to other websites are not allowed." };
}

/* ---------- who receives it ---------- */
export const AUDIENCES = [
  { id: "all", label: "All students", icon: "fa-users", help: "Every student who turned notifications on." },
  { id: "user", label: "One student", icon: "fa-user", help: "A single student's devices." },
  { id: "exam", label: "An exam's students", icon: "fa-file-pen", help: "Students who can take a chosen exam — everyone, only those who have not submitted yet, or only those who have." },
  { id: "section", label: "A program", icon: "fa-layer-group", help: "Students with access to a program (section), or who took one of its exams." },
  { id: "level", label: "A level", icon: "fa-stairs", help: "Students with access to a level, or who took one of its exams." },
];
export const EXAM_FILTERS = [
  ["all", "Everyone who can take it"],
  ["not_submitted", "Only those who have not submitted yet"],
  ["submitted", "Only those who already submitted"],
];

export function audienceFromForm(f) {
  switch (f.audienceType) {
    case "user": return { type: "user", uid: f.userId };
    case "exam": return { type: "exam", examId: f.examId, filter: EXAM_FILTERS.some(([k]) => k === f.examFilter) ? f.examFilter : "all" };
    case "section": return { type: "section", sectionId: f.sectionId };
    case "level": return { type: "level", levelId: f.levelId };
    default: return { type: "all" };
  }
}

/** "" when the audience is complete, otherwise what is missing. */
export function audienceProblem(f) {
  const need = { user: ["userId", "Pick a student."], exam: ["examId", "Pick an exam."], section: ["sectionId", "Pick a program."], level: ["levelId", "Pick a level."] }[f.audienceType];
  if (!need) return f.audienceType === "all" || !f.audienceType ? "" : "Choose who should receive this.";
  return typeof f[need[0]] === "string" && ID_RE.test(f[need[0]]) ? "" : need[1];
}

export const emptyForm = () => ({
  title: "", body: "", category: "announcement",
  destMode: "page", destPage: "#/home", destExamId: "", destCustom: "",
  image: null, icon: null,                                 // { url, thumb?, name?, id? }
  audienceType: "all", userId: "", userLabel: "", examId: "", examFilter: "all", sectionId: "", levelId: "",
  delivery: "now", scheduleLocal: "",
});

/**
 * Fill the composer from an earlier notification (its text, kind, destination and pictures) — never its audience or its time,
 * which the admin chooses again. Used by "Reuse" in the history.
 */
export function formFromJob(j) {
  const f = emptyForm();
  if (!j || typeof j !== "object") return f;
  f.title = String(j.title || "");
  f.body = String(j.body || "");
  if (TYPES.some((t) => t.id === j.category)) f.category = j.category;
  const url = String(j.url || "");
  const exam = /^#\/exams\?open=([A-Za-z0-9_-]{1,128})$/.exec(url);
  if (exam) { f.destMode = "exam"; f.destExamId = exam[1]; }
  else if (PAGES.some(([v]) => v === url)) f.destPage = url;
  else if (safeRoute(url)) { f.destMode = "custom"; f.destCustom = url; }
  if (j.image) f.image = { url: String(j.image) };
  if (j.icon) f.icon = { url: String(j.icon) };
  return f;
}

/* ---------- time ---------- */
const p2 = (n) => String(n).padStart(2, "0");
/** ms → the "YYYY-MM-DDTHH:MM" a <input type="datetime-local"> wants (the viewer's local time). */
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
/** The value typed into a datetime-local input → ms (local time); NaN when empty or invalid. */
export const scheduleMs = (local) => (typeof local === "string" && local ? new Date(local).getTime() : NaN);
/** A sensible first suggestion for "schedule": about an hour from now, on a 5-minute mark. */
export const defaultSchedule = (now = Date.now()) => toLocalInputValue(Math.ceil((now + 60 * 60000) / 300000) * 300000);

/* ---------- the whole form ---------- */
/**
 * → { ok, errors: { title, body, url, audience, schedule, image, icon }, warnings: [text] }
 *   ctx: { limits, now, cronConfigured }  (cronConfigured === false → scheduled sends rely on this page being open)
 */
export function validateForm(f, { limits = DEFAULT_LIMITS, now = Date.now(), cronConfigured = true } = {}) {
  const errors = {};
  const warnings = [];
  const title = String(f.title || "").trim();
  const body = String(f.body || "").trim();
  if (!title) errors.title = "Write a title.";
  else if (cpLen(title) > limits.titleMax) errors.title = `The title is too long (${cpLen(title)} / ${limits.titleMax}).`;
  if (!body) errors.body = "Write the message.";
  else if (cpLen(body) > limits.bodyMax) errors.body = `The message is too long (${cpLen(body)} / ${limits.bodyMax}).`;
  if (!["announcement", "exam", "result"].includes(f.category)) errors.category = "Choose the kind of notification.";

  const dest = destinationFor(f);
  if (!dest.ok) errors.url = dest.error;

  const aud = audienceProblem(f);
  if (aud) errors.audience = aud;

  for (const k of ["image", "icon"]) {
    const v = f[k];
    if (v && v.url && !/^https:\/\/[^\s]+$/i.test(v.url)) errors[k] = "The picture must be an https link.";
    else if (v && v.url && v.url.length > (limits.imageUrlMax || 500)) errors[k] = "The picture link is too long.";
  }

  if (f.delivery === "later") {
    const at = scheduleMs(f.scheduleLocal);
    if (!Number.isFinite(at)) errors.schedule = "Pick the date and time to send it.";
    else if (at < now + 60000) errors.schedule = "Pick a time at least one minute from now.";
    else if (at > now + limits.maxScheduleDays * 86400000) errors.schedule = `A notification can be scheduled at most ${limits.maxScheduleDays} days ahead.`;
    else if (!cronConfigured) warnings.push("The free scheduler is not set up on the server, so this is sent only if an admin has this page open and is still signed in at that time (the admin panel signs out after a period of inactivity). See the Setup tab.");
  }
  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

/** The exact request body for /api/push/send and /api/push/test. */
export function buildPayload(f, requestId) {
  return {
    requestId,
    title: String(f.title || "").trim(),
    body: String(f.body || "").trim(),
    category: f.category,
    url: destinationFor(f).value,
    image: (f.image && f.image.url) || "",
    icon: (f.icon && f.icon.url) || "",
    audience: audienceFromForm(f),
    scheduleAt: f.delivery === "later" ? scheduleMs(f.scheduleLocal) : null,
  };
}

/** Same content → same fingerprint. The page keeps ONE request id per fingerprint, so a double click or a retry after a lost
 *  answer can never send twice (the server treats a repeated request id as "already submitted"). */
export const fingerprint = (p) => JSON.stringify([p.title, p.body, p.category, p.url, p.image, p.icon, p.audience, p.scheduleAt]);

export function newRequestId(cryptoObj = globalThis.crypto) {
  const a = new Uint8Array(18);
  if (cryptoObj && cryptoObj.getRandomValues) cryptoObj.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  let bin = "";
  a.forEach((b) => { bin += String.fromCharCode(b); });
  return `req_${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * One request id per distinct content, kept until a DEFINITE answer arrives. A retry after a lost answer (timeout, dropped
 * connection) is then the very same request — the server answers "already submitted" instead of sending twice.
 * The page keeps one slot for real sends and another for tests: on the server both become a job whose id IS the request id,
 * so sharing an id would make a real send look like a duplicate of an earlier test.
 */
export function requestSlot(slot, payload, make = newRequestId) {
  const fp = fingerprint(payload);
  return slot && slot.fp === fp ? slot : { fp, id: make() };
}

/** What "reach" means on screen: devices, never "delivered". */
export function reachInfo(p) {
  if (!p) return null;
  const n = Number(p.devices) || 0;
  const bits = [];
  if (typeof p.students === "number") bits.push(`${p.students} student${p.students === 1 ? "" : "s"} in this audience`);
  if (typeof p.optedOut === "number" && p.optedOut > 0) bits.push(`${p.optedOut} device${p.optedOut === 1 ? "" : "s"} switched this kind off`);
  return {
    devices: n,
    tone: n === 0 ? "bad" : "ok",
    headline: n === 0 ? "No subscribed device matches — nobody would receive this." : `About ${n} device${n === 1 ? "" : "s"} will receive it`,
    detail: bits.join(" · ") || "Only students who turned notifications on, and kept this kind switched on, are counted.",
  };
}

export function confirmMessage(payload, info, audienceLabel) {
  const when = payload.scheduleAt ? `schedule it for ${new Date(payload.scheduleAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : "send it now";
  const reach = info ? ` to about ${info.devices} device${info.devices === 1 ? "" : "s"}` : "";
  return `“${payload.title}”${reach} (${audienceLabel || "selected audience"}). Do you want to ${when}? A sent notification cannot be taken back.`;
}

/* ==========================================================================
   History
   ========================================================================== */
export const STATUS = {
  scheduled: { label: "Scheduled", tone: "amber", icon: "fa-clock" },
  sending: { label: "Sending", tone: "accent", icon: "fa-paper-plane" },
  completed: { label: "Sent", tone: "teal", icon: "fa-circle-check" },
  completed_with_errors: { label: "Sent with errors", tone: "amber", icon: "fa-circle-exclamation" },
  failed: { label: "Failed", tone: "coral", icon: "fa-circle-xmark" },
  cancelled: { label: "Cancelled", tone: "", icon: "fa-ban" },
};
export const statusMeta = (s) => STATUS[s] || { label: String(s || "Unknown"), tone: "", icon: "fa-circle-question" };

export const GROUPS = [["all", "All"], ["scheduled", "Scheduled"], ["sending", "Sending"], ["completed", "Sent"], ["failed", "Failed"], ["cancelled", "Cancelled"]];
export const statusGroup = (s) => (s === "completed_with_errors" ? "completed" : s);

export function filterJobs(items, { group = "all", q = "", showTests = false } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (items || []).filter((j) => {
    if (j.test && !showTests) return false;
    if (group !== "all" && statusGroup(j.status) !== group) return false;
    if (!needle) return true;
    return [j.title, j.body, j.audienceLabel, j.createdBy && j.createdBy.name].filter(Boolean).join("\n").toLowerCase().includes(needle);
  });
}
export function groupCounts(items, showTests = false) {
  const out = Object.fromEntries(GROUPS.map(([k]) => [k, 0]));
  for (const j of items || []) {
    if (j.test && !showTests) continue;
    out.all += 1;
    const g = statusGroup(j.status);
    if (g in out) out[g] += 1;
  }
  return out;
}

/** The time that matters most for a row: when it will go / went / was cancelled. */
export function jobWhen(j) {
  if (j.status === "scheduled") return { label: "Scheduled for", at: j.scheduledAt || 0 };
  if (j.status === "sending") return { label: "Started", at: j.startedAt || j.createdAt || 0 };
  if (j.status === "cancelled") return { label: "Cancelled", at: j.cancelledAt || j.createdAt || 0 };
  return { label: "Finished", at: j.finishedAt || j.createdAt || 0 };
}

export const isActive = (j) => !!j && (j.status === "scheduled" || j.status === "sending");

/** Is there something the server should be asked to work on right now? (sending, or a scheduled one that has become due) */
export const dueNow = (items, now = Date.now()) => (items || []).some((j) => j.status === "sending" || (j.status === "scheduled" && (j.scheduledAt || 0) <= now + 1000));

/** How long to wait before looking again; null = nothing active, so no timer at all. */
export function nextCheckDelay(items, now = Date.now()) {
  let best = null;
  for (const j of items || []) {
    let d = null;
    if (j.status === "sending") d = 15000;
    else if (j.status === "scheduled") d = Math.min(Math.max((j.scheduledAt || 0) - now + 1500, 1500), 5 * 60000);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

export function progressPct(j) {
  const p = j && j.progress;
  return p && p.total > 0 ? Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100))) : null;
}

/** The numbers of a job, each with a sentence that says honestly what it means. NOTHING here claims a phone showed the message. */
export function countRows(c) {
  const n = { targeted: 0, accepted: 0, failed: 0, invalid: 0, skipped: 0, ...(c || {}) };
  return [
    { key: "targeted", label: "Devices targeted", value: n.targeted, tone: "", help: "The devices that were eligible when sending started." },
    { key: "accepted", label: "Accepted by FCM", value: n.accepted, tone: "teal", help: "Google’s push service took the message. This is NOT a confirmation that a phone showed it — FCM does not report that." },
    { key: "failed", label: "Rejected / failed", value: n.failed, tone: n.failed ? "coral" : "", help: "FCM refused the message or could not be reached for these devices (see the reasons below)." },
    { key: "invalid", label: "Dead devices removed", value: n.invalid, tone: n.invalid ? "amber" : "", help: "Browsers that were uninstalled, cleared or expired. They were switched off automatically and will not be tried again." },
    { key: "skipped", label: "Skipped", value: n.skipped, tone: "", help: "Turned this kind off, or unsubscribed, between choosing the audience and sending." },
  ];
}

export const ERROR_TEXT = {
  registration_token_not_registered: "Device no longer registered (removed)",
  invalid_registration_token: "Invalid device token (removed)",
  invalid_argument: "FCM rejected the message for this device",
  sender_id_mismatch: "Device belongs to another Firebase project",
  third_party_auth_error: "The browser’s push service rejected the credentials",
  quota_exceeded: "FCM sending limit reached",
  message_rate_exceeded: "Sending too fast for FCM — slowed down",
  device_message_rate_exceeded: "Too many messages to one device",
  unavailable: "FCM was temporarily unavailable",
  server_unavailable: "FCM was temporarily unavailable",
  authentication_error: "Firebase refused the server’s key — check the service account",
  invalid_credential: "Firebase refused the server’s key — check the service account",
  mismatched_credential: "The key belongs to another Firebase project",
  permission_denied: "The service account may not send for this project",
  internal: "FCM internal error",
  internal_error: "FCM internal error",
  unknown_error: "Unknown FCM error",
};
export const errorLabel = (key) => ERROR_TEXT[key] || String(key || "error").replace(/_/g, " ");
export const errorRows = (errors) => Object.entries(errors || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: errorLabel(key), n }));

/** One sentence under a finished job: what the numbers do and do not say. */
export function deliveryNote(j) {
  if (!j) return "";
  const c = j.counts || {};
  if (j.status === "scheduled") return "Not sent yet.";
  if (j.status === "cancelled") return "Cancelled before it was sent. Nobody received it.";
  if (j.status === "sending") return "Sending is in progress. Numbers update as batches are accepted.";
  if (j.noRecipients) return "No subscribed device matched when it was sent, so nothing was sent.";
  return `FCM accepted ${c.accepted || 0} of ${c.targeted || 0} devices. “Accepted” means Google’s push service took the message — it cannot confirm that a phone actually showed it.`;
}

/* ==========================================================================
   Errors from the server, in words an admin can act on
   ========================================================================== */
const SERVER_REASON = {
  missing: "The server has no Firebase service account yet. Add FIREBASE_SERVICE_ACCOUNT in the Vercel project settings and redeploy (see the Setup tab).",
  invalid_json: "FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded key file again.",
  not_a_service_account: "FIREBASE_SERVICE_ACCOUNT does not look like a Firebase service-account key file.",
  firebase_init_failed: "Firebase rejected the service account. Download a fresh key and update the variable.",
};
const waitText = (sec) => { const s = Number(sec); return !Number.isFinite(s) || s <= 0 ? "a little while" : s >= 120 ? `${Math.ceil(s / 60)} minutes` : `${Math.ceil(s)} seconds`; };

/** err = a PushApiError ({ code, message, status, extra }) or anything with those fields. */
export function adminErrorText(err) {
  const code = (err && err.code) || "";
  const x = (err && err.extra) || {};
  const msg = (err && err.message) || "";
  switch (code) {
    case "network": return "Could not reach the push server. Check your internet connection and try again.";
    case "timeout": return "The push server took too long to answer. If you were sending, look in History before trying again — it may have gone through.";
    case "unauthenticated": case "token_expired": case "invalid_token": case "token_revoked": return "Your admin sign-in could not be verified. Refresh the page and sign in again.";
    case "not_admin": case "role_not_allowed": return "Only a Super Admin or a Manager can use Push Notification.";
    case "account_disabled": return "This admin account is disabled.";
    case "auth_unavailable": return "Sign-in verification is temporarily unavailable. Try again in a minute.";
    case "server_not_configured": return SERVER_REASON[x.reason] || "The push server is not set up yet — see the Setup tab.";
    case "project_mismatch": return "The server’s Firebase service account belongs to a different project than this website.";
    case "http_404": case "http_405": return "The push API was not found on this site. It has to be deployed on Vercel (the api/ folder) — see the Setup tab.";
    case "firestore_quota": return "The free Firestore daily limit has been reached. It resets every day — try again later.";
    case "rate_limited": return `Too many notifications in a short time. Try again in ${waitText(x.retryAfter)}.`;
    case "duplicate_content": return `The same notification was sent ${x.ageSec !== undefined ? `${x.ageSec} seconds` : "a moment"} ago. Change the text or wait a little.`;
    case "no_own_device": return "Your own account has no subscribed device. Open the student site signed in as this admin, turn notifications on, then send the test again.";
    case "not_cancellable": return "It already started or finished, so it can no longer be cancelled.";
    case "job_not_found": return "That notification no longer exists.";
    case "payload_too_large": return "The file is too large to upload.";
    case "invalid_image_file": return "Only JPEG, PNG or WebP pictures within the size limit are accepted.";
    case "internal_error": return "Something went wrong on the server. Try again; if it keeps happening, check the Vercel logs.";
    default: return msg || (code ? `Something went wrong (${code}).` : "Something went wrong.");
  }
}

/* ==========================================================================
   Setup & health
   ========================================================================== */
const minutesAgo = (ms, now) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? "less than a minute ago" : m < 60 ? `${m} minute${m === 1 ? "" : "s"} ago` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? "" : "s"} ago` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? "" : "s"} ago`;
};

/**
 * The checklist on the Setup tab.
 *   in: { health: the /health answer or null, error: a PushApiError or null, vapid: bool (the browser key is set), now }
 *   out: { items: [{ id, tone: ok|warn|bad|mute, title, text }], canSend, canSchedule, cronConfigured }
 */
export function describeHealth({ health = null, error = null, vapid = false, now = Date.now() } = {}) {
  const items = [];
  const reachable = !!health || (error && !["network", "timeout", "http_404", "http_405"].includes(error.code));
  let canSend = false;

  if (health) items.push({ id: "api", tone: "ok", title: "Push server", text: "Running." });
  else if (reachable) items.push({ id: "api", tone: "ok", title: "Push server", text: "Reachable." });
  else items.push({ id: "api", tone: "bad", title: "Push server", text: adminErrorText(error || { code: "network" }) });

  if (health) {
    canSend = true;
    items.push({ id: "creds", tone: "ok", title: "Firebase credentials", text: `Connected to project “${health.server && health.server.projectId}”.` });
  } else if (error && error.code === "server_not_configured") {
    items.push({ id: "creds", tone: "bad", title: "Firebase credentials", text: adminErrorText(error) });
  } else if (reachable && error) {
    items.push({ id: "creds", tone: "bad", title: "Firebase credentials", text: adminErrorText(error) });
  } else {
    items.push({ id: "creds", tone: "mute", title: "Firebase credentials", text: "Checked once the push server answers." });
  }

  items.push(vapid
    ? { id: "vapid", tone: "ok", title: "Browser key (VAPID)", text: "The public key is set in js/push/push-config.js." }
    : { id: "vapid", tone: "warn", title: "Browser key (VAPID)", text: "Not set yet — students cannot turn notifications on until the public key is pasted into js/push/push-config.js." });

  let cronConfigured = false;
  if (health) {
    const n = health.devices && health.devices.active;
    items.push(typeof n !== "number"
      ? { id: "devices", tone: "mute", title: "Subscribed devices", text: "The count is not available right now." }
      : n === 0
        ? { id: "devices", tone: "warn", title: "Subscribed devices", text: "None yet. A student has to turn notifications on (Notifications page) before anything can be received." }
        : { id: "devices", tone: "ok", title: "Subscribed devices", text: `${n} active device${n === 1 ? "" : "s"}.` });

    cronConfigured = !!(health.server && health.server.cronConfigured);
    const last = health.scheduler && health.scheduler.lastTickAt;
    if (!cronConfigured) {
      items.push({ id: "scheduler", tone: "warn", title: "Scheduler (free timer)", text: "CRON_SECRET is not set. Scheduled notifications will only go out while an admin has this page open and is still signed in." });
    } else if (!last) {
      items.push({ id: "scheduler", tone: "warn", title: "Scheduler (free timer)", text: "The timer has not called the server yet. Set up the free timer (cron-job.org or GitHub Actions) — see the guide." });
    } else if (now - last > 15 * 60000) {
      items.push({ id: "scheduler", tone: "warn", title: "Scheduler (free timer)", text: `Last call ${minutesAgo(last, now)}. Scheduled notifications may go out late until the timer runs again.` });
    } else {
      items.push({ id: "scheduler", tone: "ok", title: "Scheduler (free timer)", text: `Last call ${minutesAgo(last, now)}.` });
    }
  }
  return { items, canSend, canSchedule: canSend, cronConfigured };
}

/* ==========================================================================
   Pictures
   ========================================================================== */
/** Scale (w, h) down to fit inside maxW × maxH, never up. */
export function fitWithin(w, h, maxW, maxH) {
  const s = Math.min(1, maxW / Math.max(1, w), maxH / Math.max(1, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
/** The centred square of a picture (for icons). */
export function coverSquare(w, h) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side };
}
export const fmtKB = (bytes) => `${Math.max(1, Math.round((Number(bytes) || 0) / 1024))} KB`;
