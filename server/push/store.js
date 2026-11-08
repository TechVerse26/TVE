'use strict';
// ==========================================================================
// server/push/store.js — every Firestore read/write the push backend does (Admin SDK: bypasses the security rules, which
// is why these collections are simply NOT in firestore.rules — a browser can never touch them).
//
//   pushDevices/{id}        one document per (student, browser): token, status, preferences        — id = sha256(uid:deviceKey)
//   pushNotifications/{id}  one document per notification (the "job" + its history)                 — id = the browser's requestId
//   pushAudit/{auto}        append-only log of every push action
//   pushMeta/{doc}          rate-limit windows, duplicate guard, scheduler heartbeat
//   pushImages / pushImageData   uploaded notification pictures (small metadata / the bytes)
// ==========================================================================
const crypto = require('crypto');

const COL = {
  devices: 'pushDevices', jobs: 'pushNotifications', audit: 'pushAudit', meta: 'pushMeta',
  images: 'pushImages', imageData: 'pushImageData', adminLogs: 'adminLogs',
};
const DAY = 86400000;
const HOUR = 3600000;

const deviceDocId = (uid, deviceKey) => crypto.createHash('sha256').update(`${uid}:${deviceKey}`).digest('hex').slice(0, 40);
const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');
const isAlreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message || '')));
const slug = (s) => String(s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unknown';

/* ---------- devices ---------- */
const publicDevice = (id, d, currentId) => ({
  id, label: d.label || '', platform: d.platform || 'other', browser: d.browser || 'other', standalone: !!d.standalone,
  status: d.status || 'active', prefs: d.prefs || {}, lastSeenAt: d.lastSeenAt || 0, createdAt: d.createdAt || 0, current: id === currentId,
});

async function upsertDevice(ctx, uid, sub) {
  const { db, cfg } = ctx;
  const now = ctx.now();
  const col = db.collection(COL.devices);
  const id = deviceDocId(uid, sub.deviceKey);

  // the same physical token must live in exactly ONE document (a shared computer handed to the next student, or a re-install)
  const same = await col.where('token', '==', sub.token).get();
  await Promise.all(same.docs.filter((d) => d.id !== id).map((d) => d.ref.delete()));
  if (sub.previousToken && sub.previousToken !== sub.token) {
    const old = await col.where('token', '==', sub.previousToken).get();
    await Promise.all(old.docs.filter((d) => d.data().uid === uid && d.id !== id).map((d) => d.ref.delete()));
  }

  // keep a student's device list short: the least recently used ones go first
  const mine = await col.where('uid', '==', uid).get();
  const others = mine.docs.filter((d) => d.id !== id).sort((a, b) => (a.data().lastSeenAt || 0) - (b.data().lastSeenAt || 0));
  const excess = others.length - (cfg.limits.maxDevicesPerUser - 1);
  if (excess > 0) await Promise.all(others.slice(0, excess).map((d) => d.ref.delete()));

  const ref = col.doc(id);
  const prev = await ref.get();
  const doc = {
    uid, token: sub.token, status: 'active', prefs: sub.prefs || (prev.exists && prev.data().prefs) || { announcement: true, exam: true, result: true },
    label: sub.label, platform: sub.platform, browser: sub.browser, standalone: sub.standalone,
    createdAt: prev.exists ? (prev.data().createdAt || now) : now, updatedAt: now, lastSeenAt: now, failCount: 0,
  };
  await ref.set(doc);
  return publicDevice(id, doc, id);
}

async function unsubscribeDevice(ctx, uid, deviceKey) {
  const ref = ctx.db.collection(COL.devices).doc(deviceDocId(uid, deviceKey));
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) return false;
  await ref.update({ status: 'unsubscribed', token: '', unsubscribedAt: ctx.now(), updatedAt: ctx.now() });
  return true;
}

async function setDevicePrefs(ctx, uid, deviceKey, prefs) {
  const ref = ctx.db.collection(COL.devices).doc(deviceDocId(uid, deviceKey));
  const snap = await ref.get();
  if (!snap.exists || snap.data().uid !== uid) return null;
  await ref.update({ prefs, updatedAt: ctx.now() });
  return prefs;
}

async function listDevicesOf(ctx, uid, deviceKey) {
  const currentId = deviceKey ? deviceDocId(uid, deviceKey) : '';
  const snap = await ctx.db.collection(COL.devices).where('uid', '==', uid).get();
  return snap.docs.map((d) => publicDevice(d.id, d.data(), currentId)).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/* ---------- rate limits & duplicate guard (pure decisions + one transaction each) ---------- */
function rateDecision(arr, kind, now, L) {
  const list = (Array.isArray(arr) ? arr : []).filter((t) => now - t < DAY);
  const inHour = list.filter((t) => now - t < HOUR);
  const last = list.length ? Math.max(...list) : 0;
  const cap = {
    send: [L.adminPerHour, L.adminPerDay, L.adminMinGapMs], test: [L.testPerHour, L.testPerHour * 4, 2000],
    upload: [L.uploadPerHour, L.uploadPerHour * 4, 1000], subscribe: [L.subscribePerHour, L.subscribePerHour * 4, 1000],
  }[kind];
  const [perHour, perDay, gap] = cap;
  if (last && now - last < gap) return { ok: false, retryAfter: Math.ceil((gap - (now - last)) / 1000), why: 'too_fast', list };
  if (inHour.length >= perHour) return { ok: false, retryAfter: Math.ceil((HOUR - (now - Math.min(...inHour))) / 1000), why: 'hour', list };
  if (list.length >= perDay) return { ok: false, retryAfter: Math.ceil((DAY - (now - Math.min(...list))) / 1000), why: 'day', list };
  return { ok: true, retryAfter: 0, why: '', list: [...list, now].slice(-300) };
}

async function consumeRate(ctx, uid, kind) {
  const { db, cfg } = ctx;
  const now = ctx.now();
  const ref = db.collection(COL.meta).doc(`rl_${uid}`);
  const gref = db.collection(COL.meta).doc('rl_global');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const gsnap = kind === 'send' ? await tx.get(gref) : null;
    const state = snap.exists ? snap.data() : {};
    const d = rateDecision(state[kind], kind, now, cfg.limits);
    if (!d.ok) return { ok: false, retryAfter: d.retryAfter, why: d.why };
    if (gsnap) {
      const g = (gsnap.exists ? gsnap.data().send || [] : []).filter((t) => now - t < DAY);
      if (g.length >= cfg.limits.globalPerDay) return { ok: false, retryAfter: 3600, why: 'global' };
      tx.set(gref, { send: [...g, now].slice(-1000) });
    }
    tx.set(ref, { ...state, [kind]: d.list });
    return { ok: true };
  });
}

/** Same words, same audience within `windowMs` → refuse (a double click, or two admins pressing send together). */
async function guardDuplicate(ctx, hash, windowMs = 2 * 60 * 1000) {
  const { db } = ctx;
  const now = ctx.now();
  const ref = db.collection(COL.meta).doc('recent');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const items = (snap.exists ? snap.data().items || [] : []).filter((x) => now - x.at < 10 * 60 * 1000);
    const hit = items.find((x) => x.h === hash && now - x.at < windowMs);
    if (hit) return { duplicate: true, ageSec: Math.round((now - hit.at) / 1000) };
    tx.set(ref, { items: [...items, { h: hash, at: now }].slice(-40) });
    return { duplicate: false };
  });
}

/* ---------- jobs ---------- */
const jobRef = (ctx, id) => ctx.db.collection(COL.jobs).doc(id);

async function createJob(ctx, doc) {
  try { await jobRef(ctx, doc.id).create(doc); return { created: true, doc }; } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    const snap = await jobRef(ctx, doc.id).get();
    return { created: false, doc: snap.data() };
  }
}

async function getJob(ctx, id) {
  const snap = await jobRef(ctx, id).get();
  return snap.exists ? snap.data() : null;
}

/** What the browser may see of a job: never the id lists, the lock or the cursor. */
function publicJob(j) {
  if (!j) return null;
  return {
    id: j.id, title: j.title, body: j.body, category: j.category, url: j.url, image: j.image || '', icon: j.icon || '',
    audience: j.audience, audienceLabel: j.audienceLabel || '', status: j.status, test: !!j.test,
    createdAt: j.createdAt || 0, scheduledAt: j.scheduledAt || null, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
    createdBy: j.createdBy || {}, counts: j.counts || { targeted: 0, accepted: 0, failed: 0, invalid: 0, skipped: 0 },
    errors: j.errors || {}, lastError: j.lastError || '', estimate: j.estimate ?? null, noRecipients: !!j.noRecipients,
    progress: j.deviceIds ? { done: Math.min((j.cursor && j.cursor.idx) || 0, j.deviceIds.length), total: j.deviceIds.length } : null,
    cancelledBy: j.cancelledBy || null, cancelledAt: j.cancelledAt || null,
  };
}

async function listJobs(ctx, { limit = 50, before = null } = {}) {
  let q = ctx.db.collection(COL.jobs).orderBy('createdAt', 'desc');
  if (before) q = q.startAfter(before);
  const snap = await q.limit(limit).get();
  const items = snap.docs.map((d) => publicJob(d.data()));
  return { items, next: items.length === limit ? items[items.length - 1].createdAt : null };
}

async function listActiveJobs(ctx) {
  const snap = await ctx.db.collection(COL.jobs).where('status', 'in', ['scheduled', 'sending']).get();
  return snap.docs.map((d) => d.data());
}

/* ---------- audit ---------- */
const ACTION_LABEL = {
  'push.send': 'Push notification sent', 'push.schedule': 'Push notification scheduled', 'push.test': 'Test push sent',
  'push.cancel': 'Scheduled push cancelled', 'push.complete': 'Push notification finished', 'push.upload': 'Push picture uploaded',
  'push.image_delete': 'Push picture deleted',
};

async function writeAudit(ctx, actor, action, { jobId = '', label = '', detail = '', extra = {} } = {}) {
  const now = ctx.now();
  const base = { uid: actor.uid || '', name: actor.name || '', email: actor.email || '', role: actor.role || '' };
  try {
    await ctx.db.collection(COL.audit).add({ at: now, ...base, action, jobId, label: String(label).slice(0, 160), detail: String(detail).slice(0, 400), ...extra });
  } catch (e) { ctx.log('warn', 'audit write failed', { action, error: String(e && e.message) }); }
  try { // mirror into the panel's existing Activity Logs page
    await ctx.db.collection(COL.adminLogs).add({
      at: ctx.serverTime(), ...base, action, targetType: 'push', targetId: jobId,
      label: String(label).slice(0, 160), detail: String(detail).slice(0, 400),
    });
  } catch (e) { ctx.log('warn', 'activity-log mirror failed', { action, error: String(e && e.message) }); }
}

async function listAudit(ctx, { limit = 50, before = null } = {}) {
  let q = ctx.db.collection(COL.audit).orderBy('at', 'desc');
  if (before) q = q.startAfter(before);
  const snap = await q.limit(limit).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { items, next: items.length === limit ? items[items.length - 1].at : null };
}

module.exports = {
  COL, DAY, HOUR, deviceDocId, randomId, isAlreadyExists, slug, publicDevice,
  upsertDevice, unsubscribeDevice, setDevicePrefs, listDevicesOf,
  rateDecision, consumeRate, guardDuplicate,
  jobRef, createJob, getJob, publicJob, listJobs, listActiveJobs,
  ACTION_LABEL, writeAudit, listAudit,
};
