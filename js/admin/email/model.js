// ==========================================================================
// admin/email/model.js — everything the Email Center does with data, without drawing anything.
//
//   loadBase()          users + exams + courses + settings + templates + history   (each cached by the existing helpers)
//   ensureExamData()    results + start-tracking of ONE exam (results are the proof of submission, examSessions of a start)
//   recompute()         classification of every student for the chosen exam, and who the campaign would go to
//   applyPreset()       "everyone eligible" / "a course" / "this exam's not-attempted students" → fills the selection
//   analyze()/readiness()   which {{variables}} lack data, and every reason the Send button must stay disabled
//   renderFor()         the real e-mail of one real recipient (preview, test and the send queue all use this)
//
// The tabs (view-*.js) only read S and call these functions, then re-draw.
// ==========================================================================
import { me, refreshCourses } from "../admin.js";
import { can } from "../core/permissions.js";
import { fetchAllUsersAdmin, fetchAllExamsAdmin, fetchExamStartsAdmin } from "../../exam-data.js";
import { resultsForExam } from "../core/data.js";
import { serverNow } from "../../server-time.js";
import { normalizeAudience } from "../../home-core.js";
import { SITE } from "../../info-config.js";
import * as cache from "../../cache.js";
import { isDenied } from "../core/ui.js";
import {
  CAMPAIGN_TYPES, VARIABLES, normalizeStudent, accountIssue, examEligibility, examEmailState, typeAllowed, classifyStudents, indexResults,
  indexSessions, buildValues, validateCampaign, campaignFingerprint, isValidEmail, zonedLocalToMs, msToZonedLocal, normLang, safeHttpUrl, variableMeta,
} from "../../email-core.js";
import { renderEmail, scanTokens, requiredKeys, contentStrings, sanitizeContent, buildEmailParams, paramsSize, EMAILJS_REQUEST_LIMIT_BYTES } from "../../email-render.js";
import { BUILTIN_TEMPLATES, templateById, templateForType, contentFor } from "../../email-templates-data.js";
import { isTested, settingsIssues, configFingerprint } from "../../email-service.js";
import * as store from "./store.js";
import { S, newDraft, emit, courseTitleOf } from "./state.js";

const TTL = 5 * 60 * 1000;
export const site = () => ({ website: SITE.website, email: SITE.email, name: SITE.name });
const BN_RE = /[\u0980-\u09FF]/;

/* ==========================================================================
   Identity + base data
   ========================================================================== */
export function initIdentity() {
  S.me = { uid: me?.user?.uid || "", name: me?.profile?.displayName || me?.user?.email || "Admin", email: me?.user?.email || "" };
  S.canManage = can("email.manage");
  S.canSettings = can("email.settings");
}

/** Loads (or refreshes) everything the page needs. Each source is independent: a failing history never hides the students. */
export async function loadBase({ force = false } = {}) {
  S.status = "loading"; S.error = null; S.denied = false;
  emit("status");
  const opts = force ? { force: true } : undefined;
  const [users, exams, courses, settings, templates, campaigns] = await Promise.allSettled([
    fetchAllUsersAdmin(opts), fetchAllExamsAdmin(opts), refreshCourses(opts), store.loadSettings(opts), store.listTemplates(opts), store.listCampaigns({ force }),
  ]);
  if (settings.status === "fulfilled") { S.settings = settings.value.settings; S.settingsMeta = settings.value; }
  S.templates = templates.status === "fulfilled" ? templates.value : []; S.templatesError = templates.status === "rejected" ? templates.reason : null;
  S.campaigns = campaigns.status === "fulfilled" ? campaigns.value : []; S.campaignsError = campaigns.status === "rejected" ? campaigns.reason : null;
  if (courses.status === "fulfilled") {
    S.courses = courses.value.map((c) => ({ id: c.id, title: c.title || c.name || c.id }));
    S.courseTitle = new Map(S.courses.map((c) => [c.id, c.title]));
  }
  if (users.status === "rejected" || exams.status === "rejected") {
    const err = users.status === "rejected" ? users.reason : exams.reason;
    S.status = "error"; S.error = err; S.denied = isDenied(err);
    emit("status");
    return;
  }
  S.students = users.value.map(normalizeStudent).filter((s) => s.uid).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "bn", { numeric: true }));
  S.byUid = new Map(S.students.map((s) => [s.uid, s]));
  S.exams = exams.value;
  S.examsById = new Map(exams.value.map((e) => [e.id, e]));
  S.loadedAt = Date.now();
  S.status = "ready";
  if (force) S.examData.clear();
  recompute();
  emit("status");
  if (S.draft.examId) ensureExamData(S.draft.examId);
}

/** Re-read only the history (after a send, a retry, a delete …). */
export async function refreshCampaigns({ force = true } = {}) {
  try { S.campaigns = await store.listCampaigns({ force }); S.campaignsError = null; } catch (err) { S.campaignsError = err; }
  emit("campaigns");
}
export async function refreshTemplates({ force = true } = {}) {
  try { S.templates = await store.listTemplates({ force }); S.templatesError = null; } catch (err) { S.templatesError = err; }
  emit("templates");
}
export async function refreshSettings({ force = true } = {}) {
  const r = await store.loadSettings({ force });
  S.settings = r.settings; S.settingsMeta = r;
  recompute();
  emit("settings");
}

/* ==========================================================================
   One exam's results + start-tracking
   ========================================================================== */
const startsKey = (examId) => `admin:email:starts:${examId}`;
function loadStarts(examId, force) {
  return cache.remember(startsKey(examId), (v) => (v.rows ? TTL : 30_000), async () => ({ rows: await fetchExamStartsAdmin(examId) }), { force });
}

/**
 * results/{uid}_{examId} documents prove a submission; examSessions/{uid}_{examId} prove a start.
 * Either source may be unreadable (rules not published, offline) — then it is stored as `null` and every screen says
 * "could not be verified" instead of guessing.
 */
export function ensureExamData(examId, { force = false } = {}) {
  if (!examId) return Promise.resolve(null);
  const have = S.examData.get(examId);
  if (have && !force) return have.promise || Promise.resolve(have);
  const ed = { status: "loading", resultsByUid: null, sessionsByUid: null, resultsError: null, loadedAt: 0, promise: null };
  ed.promise = (async () => {
    const [res, ses] = await Promise.allSettled([resultsForExam(examId, force ? { force: true } : undefined), loadStarts(examId, force)]);
    ed.resultsByUid = res.status === "fulfilled" ? indexResults(res.value, examId) : null;
    ed.resultsError = res.status === "rejected" ? res.reason : null;
    ed.sessionsByUid = ses.status === "fulfilled" ? indexSessions(ses.value.rows) : null;
    ed.status = "ready"; ed.loadedAt = Date.now(); ed.promise = null;
    if (S.draft.examId === examId || !S.draft.examId) { recompute(); }
    emit("examdata", examId);
    emit("change");
    return ed;
  })();
  S.examData.set(examId, ed);
  emit("examdata", examId);
  return ed.promise;
}

/* ==========================================================================
   Derived state: classification + who would receive the e-mail
   ========================================================================== */
export const isExamType = (type) => !!CAMPAIGN_TYPES[type]?.needsExam;
const parseDeadline = () => zonedLocalToMs(S.draft.deadline, S.settings.timeZone);
export const deadlineMs = parseDeadline;

export function recompute() {
  const d = S.draft;
  const now = serverNow();
  const exam = d.examId ? S.examsById.get(d.examId) || null : null;
  const examState = exam ? examEmailState(exam, now) : null;
  const ed = exam ? S.examData.get(exam.id) : null;
  let cls = null, counts = null, resultsOk = null, sessionsOk = null;
  const clsByUid = new Map();
  if (exam && ed?.status === "ready") {
    cls = classifyStudents({ students: S.students, exam, resultsByUid: ed.resultsByUid, sessionsByUid: ed.sessionsByUid });
    cls.rows.forEach((r) => clsByUid.set(r.uid, r));
    counts = cls.counts; resultsOk = cls.resultsOk; sessionsOk = cls.sessionsOk;
  }
  const enforceExam = isExamType(d.type);
  const sendable = [];
  const skipped = [];
  for (const uid of d.selected) {
    const s = S.byUid.get(uid);
    if (!s) { skipped.push({ uid, student: null, reason: "missing" }); continue; }
    let reason = examEligibility(s, enforceExam ? exam : null).reason;
    const row = clsByUid.get(uid) || null;
    if (!reason && !isValidEmail(s.email)) reason = "invalid_email";
    if (!reason && enforceExam && row?.status === "submitted") reason = "already_submitted";
    if (reason) skipped.push({ uid, student: s, reason }); else sendable.push({ uid, student: s, cls: row });
  }
  sendable.sort((a, b) => (a.student.name || a.student.email).localeCompare(b.student.name || b.student.email, "bn", { numeric: true }));
  S.derived = { exam, examState, cls, clsByUid, counts, sendable, skipped, selectedCount: d.selected.size, resultsOk, sessionsOk, examLoading: !!exam && ed?.status !== "ready" };
}

/* ==========================================================================
   Changing the campaign (every function re-computes and tells the tabs)
   ========================================================================== */
const touch = () => { recompute(); emit("change"); };

/** Which students does a preset pick? Only people who are eligible AND have a valid e-mail address. */
function presetUids(kind) {
  const d = S.draft;
  const ok = (s) => !accountIssue(s) && isValidEmail(s.email);
  if (kind === "all") return S.students.filter(ok).map((s) => s.uid);
  if (kind === "course") return S.students.filter((s) => ok(s) && s.courseIds.some((c) => d.courseIds.includes(c))).map((s) => s.uid);
  if (kind === "exam") {
    const rows = S.derived.cls?.rows || [];
    return rows.filter((r) => r.eligible && r.emailable && d.groups.includes(r.status)).map((r) => r.uid);
  }
  return null;
}

/** kind: all | course | exam | clear | manual(keep). Returns how many students were selected. */
export async function applyPreset(kind) {
  const d = S.draft;
  if (kind === "exam") {
    if (!d.examId) return 0;
    await ensureExamData(d.examId);
    recompute();
  }
  if (kind === "manual") { d.mode = "manual"; touch(); return d.selected.size; }
  const uids = kind === "clear" ? [] : presetUids(kind);
  d.mode = kind === "clear" ? "manual" : kind;
  d.selected = new Set(uids || []);
  touch();
  return d.selected.size;
}

export function toggleUid(uid, on) {
  const d = S.draft;
  if (on) d.selected.add(uid); else d.selected.delete(uid);
  recompute();
  emit("selection", { source: "row" });
}
export function selectMany(uids, on) {
  const d = S.draft;
  for (const u of uids) { if (on) d.selected.add(u); else d.selected.delete(u); }
  recompute();
  emit("selection");
}

export async function setType(type) {
  const t = CAMPAIGN_TYPES[type];
  if (!t) return;
  const d = S.draft;
  const prevMode = d.mode;
  d.type = type;
  if (t.needsExam) {
    d.groups = [...t.groups]; d.mode = "exam";
    recompute();
    if (d.examId) await applyPreset("exam"); else { d.selected = new Set(); touch(); }
    return;
  }
  // leaving an exam-based type: the ticked students stay ticked (nobody is silently swapped for "everyone")
  if (type === "custom") d.mode = "manual";
  else if (prevMode === "exam" || !t.modes.includes(prevMode)) d.mode = "manual";
  touch();
}
export async function setExam(examId) {
  const d = S.draft;
  d.examId = examId || "";
  if (examId) await ensureExamData(examId);
  recompute();
  if (d.mode === "exam") await applyPreset("exam"); else touch();
}
export async function setGroups(groups) {
  S.draft.groups = groups;
  if (S.draft.mode === "exam") await applyPreset("exam"); else touch();
}
export async function setCourses(ids) {
  S.draft.courseIds = ids;
  if (S.draft.mode === "course") await applyPreset("course"); else touch();
}
export function setLang(lang) {
  const d = S.draft;
  d.lang = normLang(lang);
  // a built-in template is re-worded in the new language as long as the admin has not edited it by hand
  if (!d.touched && templateById(d.templateId)) d.content = contentFor(templateById(d.templateId), d.lang);
  touch();
}

/** Put a template's words into the editor. Built-in templates follow the campaign language; own templates are used as saved. */
export function useTemplate(id) {
  const d = S.draft;
  const built = templateById(id);
  if (built) {
    d.content = contentFor(built, d.lang);
    d.templateId = built.id; d.templateName = built.name;
  } else {
    const own = S.templates.find((t) => t.id === id);
    if (!own) return false;
    d.content = sanitizeContent(own.content);
    d.templateId = own.id; d.templateName = own.name;
    if (own.lang && own.lang !== d.lang) d.lang = own.lang;
  }
  d.touched = false;
  touch();
  return true;
}
export const recommendedTemplate = () => templateForType(S.draft.type);

export function resetDraft() {
  S.draft = newDraft();
  S.draft.content = contentFor(templateById("general"), "en");
  S.draft.templateName = "General Announcement";
  recompute();
  emit("change");
  emit("draft-replaced");
}

/** A saved draft (campaign document with status "draft") → the editor. */
export async function openDraft(c) {
  const d = newDraft();
  d.id = c.id; d.name = c.name || ""; d.type = CAMPAIGN_TYPES[c.type] ? c.type : "announcement"; d.lang = normLang(c.lang);
  d.mode = c.audience?.mode || "manual"; d.examId = c.examId || ""; d.courseIds = c.courseIds || [];
  d.groups = c.audience?.groups?.length ? c.audience.groups : [...(CAMPAIGN_TYPES[d.type].groups || [])];
  d.selected = new Set(c.selectedUids || []);
  d.content = sanitizeContent(c.content); d.templateId = c.templateId || ""; d.templateName = c.templateName || "";
  d.personalMessage = c.personalMessage || ""; d.deadline = msToZonedLocal(c.deadlineMs, S.settings.timeZone);
  d.missingPolicy = c.missingPolicy || "block"; d.source = c.source || null; d.touched = true;
  S.draft = d;
  if (d.examId) await ensureExamData(d.examId);
  touch();
  emit("draft-replaced");
}

/** Copy a past campaign's words and settings into a NEW draft. The old recipients are not reused — the audience is re-computed from today's data. */
export async function duplicateCampaign(c) {
  await openDraft(c);
  const d = S.draft;
  d.id = null; d.name = `Copy of ${c.name || "campaign"}`.slice(0, 160); d.selected = new Set(); d.source = null; d.touched = true;
  if (d.mode === "exam" && d.examId) await applyPreset("exam");
  else if (d.mode === "all" || d.mode === "course") await applyPreset(d.mode);
  else touch();
  emit("draft-replaced");
}

/** "Prepare email" on a website notice: its title, text and audience become a draft. Nothing is sent. */
export async function prepareFromNotice(notice) {
  const d = newDraft();
  const text = `${notice.title || ""} ${notice.body || ""}`;
  d.lang = BN_RE.test(text) ? "bn" : "en";
  d.type = "announcement"; d.templateId = "general"; d.templateName = "General Announcement";
  d.content = contentFor(templateById("general"), d.lang);
  d.content.subject = String(notice.title || "").slice(0, 200);
  d.content.message = String(notice.body || "").slice(0, 6000);
  d.name = `Notice: ${notice.title || ""}`.slice(0, 160);
  d.source = { type: "notice", id: notice.id, title: String(notice.title || "").slice(0, 160) };
  d.touched = true;
  if (notice.examId && S.examsById.has(notice.examId)) d.examId = notice.examId;
  S.draft = d;
  const a = normalizeAudience(notice.audience);
  let note = "";
  if (a.type === "all") { d.mode = "all"; await applyPreset("all"); }
  else if (a.type === "course") { d.mode = "course"; d.courseIds = a.ids; await applyPreset("course"); }
  else if (a.type === "exam") {
    d.mode = "manual";
    const exams = a.ids.map((id) => S.examsById.get(id)).filter(Boolean);
    const uids = S.students.filter((s) => !accountIssue(s) && isValidEmail(s.email) && exams.some((e) => examEligibility(s, e).eligible)).map((s) => s.uid);
    d.selected = new Set(uids);
    if (!d.examId && exams.length === 1) d.examId = exams[0].id;
    touch();
  } else { d.mode = "manual"; note = "এই নোটিশের audience “category” — শিক্ষার্থীদের সাথে নির্ভরযোগ্যভাবে মেলানো যায় না। Student Recipients ট্যাব থেকে প্রাপক বেছে নিন।"; touch(); }
  if (d.examId) ensureExamData(d.examId);
  emit("draft-replaced");
  return { note, audience: a };
}

/* ==========================================================================
   Settings state
   ========================================================================== */
export function settingsState() {
  const issues = settingsIssues(S.settings);
  const complete = S.settingsMeta.source === "saved" && !issues.some((i) => i.required);
  return { complete, tested: complete && isTested(S.settings), issues, source: S.settingsMeta.source, fp: configFingerprint(S.settings), replyTo: replyToOf(S.settings) };
}
export const replyToOf = (settings) => (isValidEmail(settings.replyTo) ? settings.replyTo : SITE.email);
export function logoUrlOf(settings) {
  if (settings.showLogo === false) return "";
  return safeHttpUrl(settings.logoUrl) || safeHttpUrl(`${String(SITE.website).replace(/\/+$/, "")}/assets/email-logo.png`);
}

/* ==========================================================================
   Rendering for ONE recipient
   ========================================================================== */
/** Everything a render needs, frozen from the current draft — a running campaign keeps its own copy. */
export function ctxFromDraft(d = S.draft) {
  return {
    id: d.id, type: d.type, lang: d.lang, content: sanitizeContent(d.content), policy: d.missingPolicy,
    exam: S.derived.exam || (d.examId ? S.examsById.get(d.examId) || null : null),
    personalMessage: d.personalMessage, deadlineMs: parseDeadline(), courseIds: [...d.courseIds],
    settings: S.settings,
  };
}
export function valuesFor(ctx, student, cls) {
  return buildValues({
    student, exam: ctx.exam, courseTitleOf, classification: cls,
    campaign: { personalMessage: ctx.personalMessage, deadlineMs: ctx.deadlineMs, courseIds: ctx.courseIds },
    site: site(), tz: ctx.settings.timeZone, lang: ctx.lang, now: serverNow(),
  });
}
export function renderWith(ctx, values) {
  return renderEmail(ctx.content, values, { lang: ctx.lang, policy: ctx.policy, site: site(), logoUrl: logoUrlOf(ctx.settings), brand: SITE.name });
}
export function paramsFor(ctx, student, values, rendered) {
  return buildEmailParams({
    recipient: { email: student.email, name: student.name }, rendered, values,
    sender: { name: ctx.settings.senderName, replyTo: replyToOf(ctx.settings) },
  });
}
/** The classification row of a student for the exam in `ctx` (null when the campaign has no exam / the data is not loaded). */
export const clsOf = (uid) => S.derived.clsByUid.get(uid) || null;

/* ==========================================================================
   Analysis: which variables lack data?  Readiness: may the campaign be sent?
   ========================================================================== */
const ctaKeyOf = (url) => String(url || "").trim().match(/^\{\{\s*(website_url|exam_url)\s*\}\}$/)?.[1] || null;

export function analyze() {
  const d = S.draft;
  const D = S.derived;
  const ctx = ctxFromDraft(d);
  const scan = scanTokens(contentStrings(ctx.content));
  const need = requiredKeys(scan);
  const ck = ctx.content.ctaEnabled ? ctaKeyOf(ctx.content.ctaUrl) : null;
  if (ck && !need.includes(ck)) need.push(ck);
  const studentScope = need.filter((k) => variableMeta(k)?.scope === "student");
  const sharedScope = need.filter((k) => variableMeta(k)?.scope !== "student");
  // shared variables (exam / site / campaign) have the same value for everybody → one sample is enough
  const sampleStudent = D.sendable[0]?.student || S.students.find((s) => !accountIssue(s)) || normalizeStudent({ id: "sample" });
  const sample = valuesFor(ctx, sampleStudent, D.sendable[0]?.cls || null);
  const has = (v, k) => v[k] !== null && v[k] !== undefined && v[k] !== "";
  const campaignLevelMissing = sharedScope.filter((k) => !has(sample, k));
  const studentMissing = new Map();
  const keySet = new Set();
  if (studentScope.length) {
    for (const r of D.sendable) {
      const v = valuesFor(ctx, r.student, r.cls);
      const miss = studentScope.filter((k) => !has(v, k));
      if (miss.length) { studentMissing.set(r.uid, miss); miss.forEach((k) => keySet.add(k)); }
    }
  }
  // the size of a typical e-mail (the first recipient's) against EmailJS' per-request limit
  let sizeBytes = 0, oversize = false;
  if (sampleStudent) {
    const rendered = renderWith(ctx, sample);
    sizeBytes = paramsSize(paramsFor(ctx, sampleStudent, sample, rendered));
    oversize = sizeBytes > EMAILJS_REQUEST_LIMIT_BYTES;
  }
  return { scan, unknown: [...scan.unknown], need, campaignLevelMissing, studentMissing, studentMissingKeys: [...keySet], studentMissingCount: studentMissing.size, sizeBytes, oversize };
}

/** Everything that decides whether the campaign may be sent, as the lists the UI shows. */
export function readiness() {
  const d = S.draft;
  const D = S.derived;
  const a = analyze();
  const st = settingsState();
  const policy = d.missingPolicy;
  const sendableCount = D.sendable.length - (policy === "skip" ? a.studentMissingCount : 0);
  const content = d.content;
  const uids = D.sendable.map((r) => r.uid);
  const fp = campaignFingerprint({ type: d.type, examId: d.examId, subject: content.subject, message: content.message, uids });
  const dayAgo = serverNow() - 24 * 3600e3;
  const dup = S.campaigns.find((c) => c.fingerprint === fp && c.status !== "draft" && (c.createdAt?.toMillis?.() ?? 0) > dayAgo && c.id !== d.id);
  const v = validateCampaign({
    type: d.type, exam: D.exam, now: serverNow(), configComplete: st.complete, configTested: st.tested,
    resultsOk: D.resultsOk, sessionsOk: D.sessionsOk, subject: content.subject, hasMessage: !!String(content.message || "").trim(),
    sendableCount, unknownVariables: a.unknown, campaignLevelMissing: a.campaignLevelMissing,
    studentMissingCount: a.studentMissingCount, studentMissingKeys: a.studentMissingKeys, missingPolicy: policy, oversize: a.oversize,
    safetyCap: S.settings.safetyCap, counts: D.counts, duplicateOf: dup ? `“${dup.name || "campaign"}”` : "",
  });
  if (isExamType(d.type) && d.examId && D.examLoading) v.blockers.push({ code: "loading", message: "এক্সামের ফলাফল ও start-তথ্য এখনো লোড হচ্ছে…" });
  if (isExamType(d.type) && d.examId && D.exam === null && !D.examLoading) v.blockers.push({ code: "exam", message: "বাছাই করা এক্সামটি পাওয়া যায়নি।" });
  if (S.status !== "ready") v.blockers.push({ code: "data", message: "শিক্ষার্থীদের তালিকা লোড হয়নি।" });
  if (d.sentFps?.includes(fp)) v.blockers.push({ code: "already_sent", message: "এই ক্যাম্পেইনটি এইমাত্র পাঠানো হয়েছে — একই ইমেইল একই প্রাপকদের আবার পাঠানো যাবে না। কিছু বদলান, অথবা Campaign History থেকে Retry করুন।" });
  return { ...v, ok: v.blockers.length === 0, analysis: a, settings: st, fingerprint: fp, sendableCount, skippedForData: policy === "skip" ? a.studentMissingCount : 0 };
}

/** The final plan: who gets the e-mail, and every person who does not (with the reason). */
export function finalPlan() {
  const D = S.derived;
  const a = analyze();
  const policy = S.draft.missingPolicy;
  const send = [];
  const skipped = D.skipped.map((s) => ({ uid: s.uid, name: s.student?.name || "", email: s.student?.email || "", roll: s.student?.roll || "", reason: s.reason }));
  for (const r of D.sendable) {
    if (policy === "skip" && a.studentMissing.has(r.uid)) skipped.push({ uid: r.uid, name: r.student.name, email: r.student.email, roll: r.student.roll, reason: "missing_data" });
    else send.push(r);
  }
  return { send, skipped, analysis: a };
}

/* ==========================================================================
   Numbers for the overview
   ========================================================================== */
export function kpiNumbers() {
  const D = S.derived;
  const students = S.students.filter((s) => !s.isAdmin);
  const t = { accepted: 0, failed: 0, pending: 0, uncertain: 0 };
  for (const c of S.campaigns) {
    if (c.status === "draft") continue;
    const x = c.totals || {};
    t.accepted += x.accepted || 0; t.failed += x.failed || 0; t.pending += (x.pending || 0) + (x.sending || 0); t.uncertain += x.uncertain || 0;
  }
  return {
    students: students.length, deactivated: students.filter((s) => s.disabled).length, admins: S.students.length - students.length,
    eligible: D.sendable.length, selected: D.selectedCount, skipped: D.skipped.length,
    notSubmitted: D.counts ? D.counts.notSubmitted : null,
    startedNoSubmission: D.counts ? (D.sessionsOk ? D.counts.started_no_submission : null) : null,
    resultsOk: D.resultsOk, sessionsOk: D.sessionsOk,
    campaigns: S.campaigns.filter((c) => c.status !== "draft").length, ...t,
  };
}

/** Exams for a <select>, newest first, each tagged with what a reminder may say about it. */
export function examOptions() {
  const now = serverNow();
  return S.exams.map((e) => ({ id: e.id, title: e.title || e.id, state: examEmailState(e, now).key, courseId: e.courseId || "" }));
}
export const STATE_LABEL = { open: "Open", practice: "Practice", upcoming: "Upcoming", closed: "Closed", cancelled: "Cancelled", draft: "Draft", registration_closed: "Entries closed", none: "" };

export { typeAllowed, examEmailState, VARIABLES, BUILTIN_TEMPLATES };
