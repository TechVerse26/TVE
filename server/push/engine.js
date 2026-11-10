'use strict';
// ==========================================================================
// server/push/engine.js — creating, sending, scheduling and cancelling notifications.
//
// A notification is ONE Firestore document (pushNotifications/{requestId}) that moves through
//   scheduled → sending → completed | completed_with_errors | failed        (or scheduled → cancelled)
// Sending works in small chunks so it fits any serverless time limit: each call takes a short "lease" on the job,
// sends as many chunks as its time budget allows, saves progress after EVERY chunk and hands back. Whoever calls next
// (the admin page, the free scheduler) simply continues from the saved position — so nothing is ever sent twice by design,
// and a crash only repeats at most one chunk (and the device itself ignores a second copy of the same notification id).
//
// FCM only tells us whether it ACCEPTED a message. We store exactly that — "accepted" — and never claim it reached a phone.
// ==========================================================================
const crypto = require('crypto');
const S = require('./store');
const { COL } = S;
const A = require('./audience');
const { conflict, tooMany, notFound, bad } = require('./errors');
const { contentHash } = require('./validate');

const SAFETY_MS = 1200;
const DAY = S.DAY;
const TRANSIENT = new Set(['messaging/server-unavailable', 'messaging/internal-error', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded', 'messaging/unknown-error']);
const emptyCounts = () => ({ targeted: 0, accepted: 0, failed: 0, invalid: 0, skipped: 0 });

/* ---------- the message FCM carries (data-only: the service worker draws the notification itself) ---------- */
function buildMessage(ctx, job, tokens) {
  const data = {
    nid: job.id, title: job.title, body: job.body, url: job.url, cat: job.category, ts: String(job.createdAt),
    tag: `tvp-${job.id.slice(0, 40)}`,
  };
  if (job.image) data.image = job.image;
  if (job.icon) data.icon = job.icon;
  const topic = crypto.createHash('sha256').update(job.id).digest('base64url').slice(0, 22); // same id → a second copy replaces the first on an offline phone
  return {
    tokens,
    data,
    webpush: { headers: { TTL: String(ctx.cfg.ttlSeconds), Urgency: job.category === 'announcement' ? 'normal' : 'high', Topic: topic } },
    // Native Android app (Capacitor) tokens: the system tray must draw the notification while the app is closed. Web-push
    // tokens ignore this block entirely, so website notifications behave exactly as before.
    android: {
      priority: job.category === 'announcement' ? 'normal' : 'high',
      ...(Number(ctx.cfg.ttlSeconds) > 0 ? { ttl: Number(ctx.cfg.ttlSeconds) * 1000 } : {}),
      notification: { title: job.title, body: job.body, tag: data.tag, channelId: 'tvexam_default', ...(job.image ? { imageUrl: job.image } : {}) },
    },
  };
}

const codeOf = (e) => String((e && (e.code || (e.errorInfo && e.errorInfo.code))) || 'unknown');
const isDeadToken = (r) => r.code === 'messaging/registration-token-not-registered' || r.code === 'messaging/invalid-registration-token'
  || (r.code === 'messaging/invalid-argument' && /registration token/i.test(r.message || ''));

/** One FCM call for many tokens → [{ ok } | { ok:false, code, message }] in the same order. One retry for temporary trouble. */
async function sendBatch(ctx, job, tokens, deadline) {
  const results = new Array(tokens.length).fill(null);
  let pending = tokens.map((_, i) => i);
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    let resp;
    try {
      resp = await ctx.messaging.sendEachForMulticast(buildMessage(ctx, job, pending.map((i) => tokens[i])));
    } catch (e) {
      pending.forEach((i) => { results[i] = { ok: false, code: codeOf(e), message: String(e && e.message || '') }; });
      return results;
    }
    const retry = [];
    resp.responses.forEach((r, k) => {
      const i = pending[k];
      if (r.success) { results[i] = { ok: true }; return; }
      const code = codeOf(r.error);
      results[i] = { ok: false, code, message: String(r.error && r.error.message || '') };
      if (TRANSIENT.has(code)) retry.push(i);
    });
    pending = retry;
    if (!pending.length || attempt === 1 || ctx.now() + 2500 > deadline) break;
    await ctx.sleep(700);
  }
  return results;
}

function finalStatus(c) {
  if (c.accepted === 0 && c.failed > 0) return 'failed';
  if (c.failed > 0) return 'completed_with_errors';
  return 'completed';
}

async function finalize(ctx, ref, job, patch) {
  const now = ctx.now();
  const counts = patch.counts || job.counts;
  const status = patch.status || finalStatus(counts);
  const upd = { ...patch, status, finishedAt: now, lock: null, noRecipients: counts.targeted === 0 && counts.skipped === 0 };
  await ref.update(upd);
  const done = { ...job, ...upd };
  await S.writeAudit(ctx, done.createdBy || {}, 'push.complete', {
    jobId: done.id, label: done.title,
    detail: `${done.audienceLabel || ''} — accepted ${counts.accepted}, failed ${counts.failed}${counts.invalid ? `, removed ${counts.invalid} dead tokens` : ''}${done.scheduledAt ? ' (scheduled send)' : ''}`,
  });
  return done;
}

/**
 * Continue one notification as far as the time budget allows.
 * → { job (public), done, busy }
 */
async function processJob(ctx, id, { deadline } = {}) {
  const dl = deadline || ctx.now() + ctx.cfg.budgetMs;
  const ref = S.jobRef(ctx, id);
  const lockId = S.randomId(6);

  const claim = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { state: 'missing' };
    const j = snap.data();
    const now = ctx.now();
    if (j.status === 'scheduled') {
      if (!j.scheduledAt || j.scheduledAt > now) return { state: 'not_due', job: j };
      tx.update(ref, { status: 'sending', startedAt: now, lock: { id: lockId, until: now + ctx.cfg.leaseMs } });
      return { state: 'claimed', job: { ...j, status: 'sending', startedAt: now } };
    }
    if (j.status === 'sending') {
      if (j.lock && j.lock.until > now) return { state: 'busy', job: j };
      tx.update(ref, { lock: { id: lockId, until: now + ctx.cfg.leaseMs } });
      return { state: 'claimed', job: j };
    }
    return { state: 'final', job: j };
  });
  if (claim.state === 'missing') throw notFound('job_not_found', 'That notification does not exist.');
  if (claim.state !== 'claimed') return { job: S.publicJob(claim.job), done: claim.state === 'final', busy: claim.state === 'busy' };

  let job = claim.job;
  try {
    /* 1 — freeze the audience the first time we get here (scheduled jobs: at send time, so the list is fresh) */
    if (!job.resolved) {
      let deviceIds;
      let students = null;
      if (job.test) {
        deviceIds = (await A.resolveAudience(ctx, { type: 'user', uid: job.createdBy.uid }, { category: job.category, ignorePrefs: true })).deviceIds;
      } else {
        const r = await A.resolveAudience(ctx, job.audience, { category: job.category });
        deviceIds = r.deviceIds; students = r.students;
      }
      job = { ...job, resolved: true, deviceIds, cursor: { idx: 0 }, estimate: deviceIds.length, students };
      await ref.update({ resolved: true, deviceIds, cursor: { idx: 0 }, estimate: deviceIds.length, students, lock: { id: lockId, until: ctx.now() + ctx.cfg.leaseMs } });
    }

    /* 2 — chunk by chunk */
    const counts = { ...emptyCounts(), ...(job.counts || {}) };
    const errors = { ...(job.errors || {}) };
    let idx = (job.cursor && job.cursor.idx) || 0;
    let lastError = job.lastError || '';
    const total = job.deviceIds.length;

    while (idx < total) {
      if (ctx.now() > dl - SAFETY_MS) {
        await ref.update({ lock: null }); // hand back — the next caller continues from the saved position
        return { job: S.publicJob({ ...job, counts, errors, cursor: { idx } }), done: false, busy: false };
      }
      const ids = job.deviceIds.slice(idx, idx + ctx.cfg.deviceBatch);
      const snaps = await ctx.db.getAll(...ids.map((d) => ctx.db.collection(COL.devices).doc(d)));
      const targets = [];
      const seen = new Set();
      let skipped = 0;
      snaps.forEach((s) => {
        const d = s.exists ? s.data() : null;
        if (!A.eligible(d, job.category, !!job.test) || seen.has(d.token)) { skipped++; return; }
        seen.add(d.token);
        targets.push({ id: s.id, token: d.token });
      });

      let accepted = 0, failed = 0, invalid = 0;
      const dead = [];
      if (targets.length) {
        const res = await sendBatch(ctx, job, targets.map((t) => t.token), dl);
        const failures = res.filter((r) => !r.ok);
        const sameCode = failures.length > 0 && failures.every((f) => f.code === failures[0].code);
        const systemic = targets.length >= 20 && failures.length === targets.length && sameCode;   // every token failing the same way = our setup, not their phones
        res.forEach((r, i) => {
          if (r.ok) { accepted++; return; }
          failed++;
          const k = S.slug(String(r.code).replace(/^messaging\//, ''));
          errors[k] = (errors[k] || 0) + 1;
          lastError = r.code;
          if (isDeadToken(r) && !systemic) { invalid++; dead.push(targets[i].id); }
        });
        if (dead.length) await Promise.all(dead.map((d) => ctx.db.collection(COL.devices).doc(d).delete()));
        // a broken setup (bad key, API switched off …) fails everything at once — stop instead of hammering FCM
        const setupBroken = targets.length >= 1 && accepted === 0 && failures.every((f) => /authentication|third-party-auth|invalid-credential|mismatched-credential|permission|invalid-argument/.test(f.code) && !isDeadToken(f));
        if (setupBroken && counts.accepted === 0) {
          counts.targeted += targets.length; counts.failed += failed; counts.skipped += skipped;
          idx += ids.length;
          const done = await finalize(ctx, ref, job, { counts, errors, cursor: { idx }, lastError, status: 'failed' });
          return { job: S.publicJob(done), done: true, busy: false };
        }
      }
      counts.targeted += targets.length; counts.accepted += accepted; counts.failed += failed; counts.invalid += invalid; counts.skipped += skipped;
      idx += ids.length;
      await ref.update({ counts, errors, cursor: { idx }, lastError, lock: { id: lockId, until: ctx.now() + ctx.cfg.leaseMs } });
      job = { ...job, counts, errors, cursor: { idx }, lastError };
    }

    const done = await finalize(ctx, ref, job, { counts, errors, cursor: { idx }, lastError });
    return { job: S.publicJob(done), done: true, busy: false };
  } catch (e) {
    // the audience could not be built (exam deleted since scheduling, list too large …) or Firestore hiccuped
    const code = (e && e.code) || 'internal_error';
    ctx.log('error', 'processJob failed', { id, code, message: String(e && e.message) });
    if (e && e.status && e.status < 500) {
      const done = await finalize(ctx, ref, job, { status: 'failed', lastError: String(code), counts: job.counts || emptyCounts() });
      return { job: S.publicJob(done), done: true, busy: false };
    }
    try { await ref.update({ lock: null }); } catch { /* the lease expires by itself */ }
    throw e;
  }
}

/* ---------- creating ---------- */
/** The same request id arriving twice at once (a double click, two tabs) is ONE request: the second waits for the first. */
function once(ctx, key, fn) {
  const m = ctx.state.inflight || (ctx.state.inflight = new Map());
  if (m.has(key)) return m.get(key).then((r) => ({ ...r, duplicate: true, created: false }));
  const p = fn().finally(() => m.delete(key));
  m.set(key, p);
  return p;
}

/** Another server instance may have created the very same request a moment ago — then that job IS the answer. */
async function existingOrThrow(ctx, id, e) {
  if (e && (e.status === 429 || e.code === 'duplicate_content')) {
    for (let i = 0; i < 2; i++) {
      const j = await S.getJob(ctx, id);
      if (j) return { job: S.publicJob(j), duplicate: true, created: false };
      if (i === 0) await ctx.sleep(300); // the twin request is probably a few milliseconds from creating it
    }
  }
  throw e;
}

const submitNotification = (ctx, actor, c) => once(ctx, `n:${c.requestId}`, () => submitNotificationOnce(ctx, actor, c));
const submitTest = (ctx, actor, c) => once(ctx, `t:${c.requestId}`, () => submitTestOnce(ctx, actor, c));

async function submitNotificationOnce(ctx, actor, c) {
  const existing = await S.getJob(ctx, c.requestId);
  if (existing) return { job: S.publicJob(existing), duplicate: true, created: false };

  const described = await A.describeAudience(ctx, c.audience);
  const hash = contentHash(c);
  try {
    const rate = await S.consumeRate(ctx, actor.uid, 'send');
    if (!rate.ok) throw tooMany('rate_limited', 'Too many notifications — wait a little and try again.', rate.retryAfter);
    const dup = await S.guardDuplicate(ctx, hash);
    if (dup.duplicate) throw conflict('duplicate_content', `The same notification was sent ${dup.ageSec} seconds ago.`, { ageSec: dup.ageSec });
  } catch (e) { return existingOrThrow(ctx, c.requestId, e); }

  const now = ctx.now();
  const job = {
    id: c.requestId, title: c.title, body: c.body, category: c.category, url: c.url, image: c.image, icon: c.icon, hash,
    audience: c.audience, audienceLabel: described.label, status: c.scheduleAt ? 'scheduled' : 'sending', test: false,
    createdAt: now, createdBy: { uid: actor.uid, name: actor.name, email: actor.email, role: actor.role },
    scheduledAt: c.scheduleAt || null, startedAt: c.scheduleAt ? null : now,
    resolved: false, deviceIds: null, cursor: { idx: 0 }, counts: emptyCounts(), errors: {}, lastError: '', estimate: null, lock: null,
  };
  const made = await S.createJob(ctx, job);
  if (!made.created) return { job: S.publicJob(made.doc), duplicate: true, created: false };
  await S.writeAudit(ctx, actor, c.scheduleAt ? 'push.schedule' : 'push.send', {
    jobId: job.id, label: job.title,
    detail: `${job.audienceLabel}${c.scheduleAt ? ` — scheduled for ${new Date(c.scheduleAt).toISOString()}` : ''}`,
  });
  return { job: S.publicJob(job), duplicate: false, created: true };
}

async function submitTestOnce(ctx, actor, c) {
  const existing = await S.getJob(ctx, c.requestId);
  if (existing) return { job: S.publicJob(existing), duplicate: true, created: false };

  const mine = await A.resolveAudience(ctx, { type: 'user', uid: actor.uid }, { category: c.category, ignorePrefs: true });
  if (!mine.deviceIds.length) throw conflict('no_own_device', 'Turn notifications on for this device first, then send the test.');
  try {
    const rate = await S.consumeRate(ctx, actor.uid, 'test');
    if (!rate.ok) throw tooMany('rate_limited', 'Too many test notifications — wait a little.', rate.retryAfter);
  } catch (e) { return existingOrThrow(ctx, c.requestId, e); }

  const now = ctx.now();
  const job = {
    id: c.requestId, title: c.title, body: c.body, category: c.category, url: c.url, image: c.image, icon: c.icon, hash: contentHash(c),
    audience: { type: 'self' }, audienceLabel: 'Test — my own devices', status: 'sending', test: true,
    createdAt: now, createdBy: { uid: actor.uid, name: actor.name, email: actor.email, role: actor.role },
    scheduledAt: null, startedAt: now,
    resolved: true, deviceIds: mine.deviceIds, cursor: { idx: 0 }, counts: emptyCounts(), errors: {}, lastError: '', estimate: mine.deviceIds.length, lock: null,
  };
  const made = await S.createJob(ctx, job);
  if (!made.created) return { job: S.publicJob(made.doc), duplicate: true, created: false };
  await S.writeAudit(ctx, actor, 'push.test', { jobId: job.id, label: job.title, detail: `${mine.deviceIds.length} device(s) of ${actor.email || actor.uid}` });
  return { job: S.publicJob(job), duplicate: false, created: true };
}

async function cancelJob(ctx, actor, id) {
  const ref = S.jobRef(ctx, id);
  const now = ctx.now();
  const r = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { state: 'missing' };
    const j = snap.data();
    if (j.status !== 'scheduled') return { state: 'not_cancellable', status: j.status };
    tx.update(ref, { status: 'cancelled', cancelledAt: now, cancelledBy: { uid: actor.uid, name: actor.name, email: actor.email }, finishedAt: now });
    return { state: 'ok', job: { ...j, status: 'cancelled', cancelledAt: now, cancelledBy: { uid: actor.uid, name: actor.name, email: actor.email }, finishedAt: now } };
  });
  if (r.state === 'missing') throw notFound('job_not_found', 'That notification does not exist.');
  if (r.state === 'not_cancellable') throw conflict('not_cancellable', `Only a pending scheduled notification can be cancelled (this one is ${r.status}).`, { status: r.status });
  await S.writeAudit(ctx, actor, 'push.cancel', { jobId: id, label: r.job.title, detail: r.job.audienceLabel || '' });
  return S.publicJob(r.job);
}

/* ---------- the "tick": due scheduled jobs + unfinished ones. Called by the free scheduler and by the open admin page. ---------- */
async function tick(ctx, { deadline } = {}) {
  const dl = deadline || ctx.now() + ctx.cfg.budgetMs;
  const now = ctx.now();
  const active = (await S.listActiveJobs(ctx))
    .filter((j) => j.status === 'sending' || (j.status === 'scheduled' && j.scheduledAt && j.scheduledAt <= now))
    .sort((a, b) => (a.scheduledAt || a.createdAt) - (b.scheduledAt || b.createdAt));
  const out = [];
  for (const j of active) {
    if (ctx.now() > dl - 2000) break;
    try { out.push((await processJob(ctx, j.id, { deadline: dl })).job); } catch (e) { out.push({ id: j.id, error: (e && e.code) || 'internal_error' }); }
  }
  return { jobs: out, waiting: Math.max(0, active.length - out.length) };
}

/* ---------- housekeeping: dead weight leaves once a day ---------- */
async function pruneDevices(ctx) {
  const now = ctx.now();
  const col = ctx.db.collection(COL.devices);
  let removed = 0;
  const stale = await col.where('lastSeenAt', '<', now - ctx.cfg.staleDeviceDays * DAY).limit(300).get();
  await Promise.all(stale.docs.map((d) => d.ref.delete()));
  removed += stale.size;
  const off = await col.where('status', '==', 'unsubscribed').limit(300).get();
  const old = off.docs.filter((d) => (d.data().unsubscribedAt || 0) < now - 30 * DAY);
  await Promise.all(old.map((d) => d.ref.delete()));
  return removed + old.length;
}

module.exports = {
  buildMessage, sendBatch, isDeadToken, finalStatus, processJob, submitNotification, submitTest, cancelJob, tick, pruneDevices, emptyCounts,
};
