// ==========================================================================
// admin/email/store.js — Firestore persistence of the Email Center.
//
//   emailSettings/main         EmailJS Service ID / Template ID / PUBLIC key, sender name … (no private keys — ever)
//   emailTemplates/{id}        the admin's own templates
//   emailCampaigns/{id}        campaign summary + the e-mail text with {{placeholders}} (no personal data)
//   emailCampaigns/{id}/parts/{n}   recipient-level results, 150 recipients per document
//
// Why recipients live in "parts": one document per recipient would mean one WRITE per e-mail. With 150 recipients
// per part a 500-student campaign costs a few dozen writes in total — the same read/write frugality as the rest of the panel.
// Every read goes through cache.remember (5-minute TTL for settings/templates, 2 minutes for the history); every write
// invalidates what it changed. Access rules: see firestore.rules ("Email Center").
// ==========================================================================
import { db } from "../../firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, writeBatch, query, orderBy, limit, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "../../cache.js";
import { normalizeSettings } from "../../email-service.js";
import { sanitizeContent } from "../../email-render.js";
import { totalsOf, normLang, CAMPAIGN_TYPES } from "../../email-core.js";
import { isDenied } from "../core/ui.js";

const TTL = 5 * 60 * 1000;
const K = { settings: "admin:email:settings", templates: "admin:email:templates", campaigns: "admin:email:campaigns" };
export const PART_SIZE = 150;
const MAX_PARTS = 480; // one batch may hold 500 writes (parts + the summary)

const cut = (v, n) => String(v ?? "").slice(0, n);
export const invalidateEmailCaches = () => cache.delPrefix("admin:email:");
/** Field values the callers need without importing the Firestore SDK themselves. */
export const serverStamp = () => serverTimestamp();
export const fieldDelete = () => deleteField();

/* ============================ settings ============================ */
/** → { settings, source: "saved" | "defaults" | "blocked" | "error", updatedBy, updatedAt, error } — never throws. */
export function loadSettings(opts) {
  return cache.remember(K.settings, (v) => (v.source === "error" ? 10_000 : TTL), async () => {
    try {
      const snap = await getDoc(doc(db, "emailSettings", "main"));
      if (!snap.exists()) return { settings: normalizeSettings({}), source: "defaults" };
      const d = snap.data();
      return { settings: normalizeSettings(d), source: "saved", updatedAt: d.updatedAt || null, updatedBy: d.updatedBy || "" };
    } catch (err) {
      return { settings: normalizeSettings({}), source: isDenied(err) ? "blocked" : "error", error: String(err?.message || err) };
    }
  }, { force: cache.wantsFresh(opts) });
}
/** Super Admin only (firestore.rules). Replaces the whole document; `lastTest` is kept as given. */
export async function saveSettings(next, byName = "") {
  const s = normalizeSettings(next);
  await setDoc(doc(db, "emailSettings", "main"), { ...s, lastTest: s.lastTest || null, updatedAt: serverTimestamp(), updatedBy: cut(byName, 120) });
  cache.del(K.settings);
  return s;
}
/** The outcome of the last REAL test request. Managers may write only this one field (firestore.rules). */
export async function recordTest(result) {
  const r = { ok: result.ok === true, at: Number(result.at) || Date.now(), fp: cut(result.fp, 16), to: cut(result.to, 254), status: Number(result.status) || 0, text: cut(result.text, 200) };
  await setDoc(doc(db, "emailSettings", "main"), { lastTest: r }, { merge: true });
  cache.del(K.settings);
  return r;
}

/* ============================ templates ============================ */
export function listTemplates(opts) {
  return cache.remember(K.templates, TTL, async () => {
    const snap = await getDocs(collection(db, "emailTemplates"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data(), content: sanitizeContent(d.data().content) }))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "bn", { numeric: true }));
  }, { force: cache.wantsFresh(opts) });
}
export async function saveTemplate(t, { id = "", byName = "" } = {}) {
  const base = {
    name: cut(t.name, 120).trim(), desc: cut(t.desc, 300).trim(),
    type: CAMPAIGN_TYPES[t.type] ? t.type : "custom", lang: normLang(t.lang), content: sanitizeContent(t.content),
  };
  if (!base.name) throw new Error("টেমপ্লেটের নাম দিন");
  const ref = id ? doc(db, "emailTemplates", id) : doc(collection(db, "emailTemplates"));
  if (id) await setDoc(ref, { ...base, updatedAt: serverTimestamp(), updatedBy: cut(byName, 120) }, { merge: true });
  else await setDoc(ref, { ...base, createdAt: serverTimestamp(), createdBy: cut(byName, 120), updatedAt: serverTimestamp(), updatedBy: cut(byName, 120) });
  cache.del(K.templates);
  return ref.id;
}
export async function deleteTemplate(id) {
  const b = writeBatch(db);
  b.delete(doc(db, "emailTemplates", id));
  await b.commit();
  cache.del(K.templates);
}

/* ============================ campaigns ============================ */
export const newCampaignId = () => doc(collection(db, "emailCampaigns")).id;

/** Newest first. The summary documents only (no recipients) → cheap. */
export function listCampaigns({ max = 80, force } = {}) {
  return cache.remember(K.campaigns, 2 * 60 * 1000, async () => {
    const snap = await getDocs(query(collection(db, "emailCampaigns"), orderBy("createdAt", "desc"), limit(max)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, { force: force === true });
}

const compactRow = (r) => ({
  uid: cut(r.uid, 128), name: cut(r.name, 120), email: cut(r.email, 254), roll: cut(r.roll, 40),
  status: cut(r.status, 12), tries: Number(r.tries) || 0, at: Number(r.at) || null, note: cut(r.note, 160),
});
export const chunkRows = (rows) => { const out = []; for (let i = 0; i < rows.length; i += PART_SIZE) out.push(rows.slice(i, i + PART_SIZE)); return out; };
export const partOf = (index) => Math.floor(index / PART_SIZE);

/** What may be stored of a campaign's settings/content — the placeholders, never a student's data. */
export function campaignMeta(c) {
  return {
    name: cut(c.name, 160), type: CAMPAIGN_TYPES[c.type] ? c.type : "custom", lang: normLang(c.lang),
    examId: cut(c.examId, 128), examTitle: cut(c.examTitle, 200), courseIds: (c.courseIds || []).slice(0, 50).map((x) => cut(x, 128)),
    subject: cut(c.subject, 200), content: sanitizeContent(c.content), templateId: cut(c.templateId, 128), templateName: cut(c.templateName, 120),
    personalMessage: cut(c.personalMessage, 1000), deadlineMs: Number(c.deadlineMs) || null, missingPolicy: ["block", "skip", "fallback"].includes(c.missingPolicy) ? c.missingPolicy : "block",
    audience: { mode: cut(c.audience?.mode, 12), groups: (c.audience?.groups || []).slice(0, 8).map((x) => cut(x, 30)), summary: cut(c.audience?.summary, 300) },
    senderName: cut(c.senderName, 80), replyTo: cut(c.replyTo, 254), fingerprint: cut(c.fingerprint, 16), configFp: cut(c.configFp, 16),
    source: c.source ? { type: cut(c.source.type, 20), id: cut(c.source.id, 128), title: cut(c.source.title, 160) } : null,
    createdBy: { uid: cut(c.createdBy?.uid, 128), name: cut(c.createdBy?.name, 120), email: cut(c.createdBy?.email, 254) },
  };
}

/** A draft = the settings + the chosen recipients (uids only). One document, saved only when the admin presses "Save draft". */
export async function saveDraft(id, meta, selectedUids, { isNew }) {
  const { createdBy, ...rest } = meta; // the author of an existing draft is never rewritten (firestore.rules)
  const data = { ...(isNew ? meta : rest), status: "draft", selectedUids: (selectedUids || []).slice(0, 5000).map((x) => cut(x, 128)), updatedAt: serverTimestamp() };
  if (isNew) data.createdAt = serverTimestamp();
  await setDoc(doc(db, "emailCampaigns", id), data, { merge: true });
  cache.del(K.campaigns);
}

/** First write of a sending campaign: the summary and ALL recipient rows in one atomic batch. */
export async function createCampaign(id, meta, rows, extra = {}) {
  const parts = chunkRows(rows);
  if (parts.length > MAX_PARTS) throw new Error("প্রাপক সংখ্যা এত বেশি যে এক ক্যাম্পেইনে ধরবে না — দুই ভাগে ভাগ করুন");
  const b = writeBatch(db);
  b.set(doc(db, "emailCampaigns", id), {
    ...meta, status: "sending", totals: totalsOf(rows), parts: parts.length, runs: 1,
    createdAt: serverTimestamp(), startedAt: serverTimestamp(), heartbeatAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra,
  }, { merge: true });
  parts.forEach((p, n) => b.set(doc(db, "emailCampaigns", id, "parts", String(n)), { n, rows: p.map(compactRow) }));
  await b.commit();
  cache.del(K.campaigns);
}

/** A checkpoint: rewrite the touched parts + the summary (totals, status, heartbeat) atomically. */
export async function saveProgress(id, { rows, dirtyParts = [], totals, status = "", extra = {} }) {
  const b = writeBatch(db);
  for (const n of dirtyParts) b.set(doc(db, "emailCampaigns", id, "parts", String(n)), { n, rows: rows.slice(n * PART_SIZE, (n + 1) * PART_SIZE).map(compactRow) });
  b.update(doc(db, "emailCampaigns", id), { totals, ...(status ? { status } : {}), heartbeatAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra });
  await b.commit();
  cache.del(K.campaigns);
}

/** Every recipient row of a campaign, in order. One read per 150 recipients. */
export async function loadCampaignRows(id) {
  const snap = await getDocs(collection(db, "emailCampaigns", id, "parts"));
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.n || 0) - (b.n || 0)).flatMap((p) => Array.isArray(p.rows) ? p.rows : []);
}
export async function loadCampaign(id) {
  const snap = await getDoc(doc(db, "emailCampaigns", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function deleteCampaign(id) {
  const parts = await getDocs(collection(db, "emailCampaigns", id, "parts"));
  const b = writeBatch(db);
  parts.docs.forEach((d) => b.delete(d.ref));
  b.delete(doc(db, "emailCampaigns", id));
  await b.commit();
  cache.del(K.campaigns);
}

/* ============================ notices (read-only, for "Prepare email") ============================ */
export async function loadNotice(id) {
  const hit = cache.get("admin:notices")?.find?.((n) => n.id === id);
  if (hit) return hit;
  const snap = await getDoc(doc(db, "notices", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
