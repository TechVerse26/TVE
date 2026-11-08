'use strict';
// ==========================================================================
// server/push/routes.js — the HTTP surface of the push backend (framework-free, so it is easy to test).
//
//   handle(ctx, { method, action, query, headers, body }) → { status, headers, body }      (body: string | Buffer)
//
// Who may call what
//   public   img                                  pictures shown inside notifications (random, unguessable ids)
//   cron     cron                                 "Authorization: Bearer <CRON_SECRET>" — the free scheduler
//   student  subscribe · unsubscribe · me · prefs any signed-in student, ONLY for their own devices
//   admin    health · audience · send · test · process · cancel · history · audit · upload · images · image-delete
//            → a valid Firebase ID token  AND  users/{uid}.isAdmin === true  AND
//              (no adminRoles document  OR  role is "super" / "manager")   — exactly firestore.rules' canManageComms().
//              Checked again, on the server, on EVERY call. The browser's own role check only hides buttons.
// ==========================================================================
const crypto = require('crypto');
const { HttpError, bad, unauthorized, forbidden, notFound, conflict, tooMany } = require('./errors');
const V = require('./validate');
const S = require('./store');
const A = require('./audience');
const E = require('./engine');
const { CATEGORIES } = require('./config');
const { COL } = S;

const JSON_LIMIT = 64 * 1024;
const UPLOAD_LIMIT = 1536 * 1024;
const ADMIN_ROLES = new Set(['super', 'manager']);
const IMAGE_ID_RE = /^[a-f0-9]{24}$/;
const MIN = 60 * 1000;

/* ---------- small helpers ---------- */
function json(status, obj, cors, more) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors, ...(more || {}) },
    body: JSON.stringify(obj),
  };
}

function lowerKeys(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => { out[k.toLowerCase()] = Array.isArray(h[k]) ? h[k][0] : h[k]; });
  return out;
}

function corsHeaders(ctx, origin) {
  const h = { Vary: 'Origin' };
  if (origin && ctx.cfg.allowedOrigins.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return h;
}

/** Best-effort, per server instance. The durable limits (Firestore) are in store.consumeRate; this only stops accidental loops. */
function lightLimit(ctx, key, max, windowMs) {
  const st = ctx.state.light || (ctx.state.light = new Map());
  const now = ctx.now();
  const arr = (st.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    st.set(key, arr);
    throw tooMany('rate_limited', 'Too many requests — slow down a little.', Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)));
  }
  arr.push(now);
  st.set(key, arr);
  if (st.size > 2000) { let n = st.size - 1000; for (const k of st.keys()) { st.delete(k); if (--n <= 0) break; } }
}

const safeEqual = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest(),
);

const clientIp = (h) => String(h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim().slice(0, 64);

/** The https origin this request was addressed to — used to build absolute picture links. */
function selfOrigin(ctx, h) {
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return `https://${host}`;
  return ctx.cfg.siteOrigin || '';
}

/* ---------- authentication ---------- */
const bearer = (h) => { const m = /^Bearer\s+(\S{20,4096})$/i.exec(String(h.authorization || '')); return m ? m[1] : ''; };

async function verifyUser(ctx, h, { checkRevoked }) {
  const token = bearer(h);
  if (!token) throw unauthorized('unauthenticated', 'Sign in first.');
  try {
    const d = await ctx.auth.verifyIdToken(token, !!checkRevoked);
    return { uid: String(d.uid), email: String(d.email || ''), name: String(d.name || '') };
  } catch (e) {
    const code = String((e && e.code) || '');
    const msg = String((e && e.message) || '');
    const aud = /Expected "([^"]+)" but got "([^"]+)"/.exec(msg);
    if (aud) {
      throw new HttpError(401, 'project_mismatch', 'The push server belongs to a different Firebase project than this site.', { serverProject: aud[1], siteProject: aud[2] });
    }
    if (code === 'auth/id-token-expired') throw unauthorized('token_expired', 'Your session expired — reload the page.');
    if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') throw unauthorized('token_revoked', 'Sign in again.');
    if (code === 'auth/internal-error' || code === 'auth/network-request-failed' || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(msg)) {
      throw new HttpError(503, 'auth_unavailable', 'Could not check your sign-in right now — try again in a moment.');
    }
    throw unauthorized('invalid_token', 'Sign in again.');
  }
}

/** Mirrors firestore.rules → canManageComms(). Returns the actor stored in the audit trail. */
async function requireAdmin(ctx, user) {
  const [u, r] = await Promise.all([
    ctx.db.collection('users').doc(user.uid).get(),
    ctx.db.collection('adminRoles').doc(user.uid).get(),
  ]);
  if (!u.exists || u.data().isAdmin !== true) throw forbidden('not_admin', 'Only administrators can do this.');
  const role = r.exists ? String(r.data().role || '') : 'super'; // no adminRoles document = Super Admin (same as the rules)
  if (!ADMIN_ROLES.has(role)) throw forbidden('role_not_allowed', 'Your admin role is not allowed to manage push notifications.');
  const doc = u.data();
  return { uid: user.uid, email: user.email || String(doc.email || ''), name: String(doc.displayName || user.name || '').slice(0, 80), role };
}

async function requireCron(ctx, h) {
  if (!ctx.cfg.cronSecret) throw new HttpError(503, 'cron_not_configured', 'CRON_SECRET is not set on the server.');
  lightLimit(ctx, `cron:${clientIp(h)}`, 40, MIN);
  const token = bearer(h);
  if (!token || !safeEqual(token, ctx.cfg.cronSecret)) throw unauthorized('invalid_cron_secret', 'Wrong or missing scheduler secret.');
}

/* ---------- scheduler heartbeat ("the free trigger is alive") ---------- */
async function heartbeat(ctx, summary) {
  const st = ctx.state;
  const now = ctx.now();
  if (st.hbAt && now - st.hbAt < 10 * MIN) return;
  const ref = ctx.db.collection(COL.meta).doc('heartbeat');
  if (st.lastPruneAt === undefined) {
    const snap = await ref.get();
    st.lastPruneAt = snap.exists ? Number(snap.data().lastPruneAt || 0) : 0;
  }
  const patch = { lastTickAt: now, summary };
  if (now - st.lastPruneAt > S.DAY) {
    patch.lastPruned = await E.pruneDevices(ctx);
    patch.lastPruneAt = now;
    st.lastPruneAt = now;
  }
  await ref.set(patch, { merge: true });
  st.hbAt = now;
}

/* ---------- student actions ---------- */
const deviceKeyOf = (...srcs) => {
  for (const s of srcs) if (s && typeof s.deviceKey === 'string' && V.DEVICE_KEY_RE.test(s.deviceKey)) return s.deviceKey;
  return '';
};

async function requireActiveStudent(ctx, user) {
  const u = await ctx.db.collection('users').doc(user.uid).get();
  if (u.exists && u.data().disabled === true) throw forbidden('account_disabled', 'This account is deactivated.');
}

async function subscribe({ ctx, user, body }) {
  const sub = V.validateSubscribe(body);
  const rate = await S.consumeRate(ctx, user.uid, 'subscribe');
  if (!rate.ok) throw tooMany('rate_limited', 'Too many attempts — try again later.', rate.retryAfter);
  await requireActiveStudent(ctx, user);
  return { device: await S.upsertDevice(ctx, user.uid, sub) };
}

async function unsubscribe({ ctx, user, body }) {
  const key = deviceKeyOf(body);
  if (!key) throw bad('invalid_device', 'Missing device id.');
  return { removed: await S.unsubscribeDevice(ctx, user.uid, key) };
}

async function prefs({ ctx, user, body }) {
  const key = deviceKeyOf(body);
  if (!key) throw bad('invalid_device', 'Missing device id.');
  const saved = await S.setDevicePrefs(ctx, user.uid, key, V.validatePrefs(body.prefs));
  if (!saved) throw notFound('device_not_found', 'This device is not registered for notifications.');
  return { prefs: saved };
}

async function me({ ctx, user, body, query }) {
  const devices = await S.listDevicesOf(ctx, user.uid, deviceKeyOf(body, query));
  return { devices: devices.filter((d) => d.status === 'active' || d.current) };
}

/* ---------- admin actions ---------- */
async function health({ ctx, actor }) {
  const cfg = ctx.cfg;
  const hb = await ctx.db.collection(COL.meta).doc('heartbeat').get();
  let active = null;
  try { active = (await ctx.db.collection(COL.devices).where('status', '==', 'active').count().get()).data().count; } catch { /* optional number */ }
  const L = cfg.limits;
  return {
    now: ctx.now(),
    server: { projectId: cfg.projectId, siteUrl: cfg.siteUrl, cronConfigured: !!cfg.cronSecret },
    scheduler: hb.exists ? { lastTickAt: Number(hb.data().lastTickAt || 0) } : null,
    devices: { active },
    limits: { titleMax: L.titleMax, bodyMax: L.bodyMax, maxRecipients: L.maxRecipients, adminPerHour: L.adminPerHour, adminPerDay: L.adminPerDay, maxImages: L.maxImages, imageMaxBytes: L.imageMaxBytes, thumbMaxBytes: L.thumbMaxBytes, maxScheduleDays: L.maxScheduleDays },
    actor: { role: actor.role },
  };
}

async function audiencePreview({ ctx, body }) {
  const a = V.validateAudience(body.audience);
  const category = CATEGORIES.includes(body.category) ? body.category : 'announcement';
  const key = `${V.audienceKey(a)}|${category}`;
  const cache = ctx.state.preview || (ctx.state.preview = new Map());
  const now = ctx.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < 90 * 1000) return { preview: hit.value, cached: true };
  const value = await A.previewAudience(ctx, a, category);
  cache.set(key, { at: now, value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return { preview: value, cached: false };
}

async function send({ ctx, actor, body, deadline }) {
  const c = V.validateCompose(body, { now: ctx.now(), cfg: ctx.cfg });
  const sub = await E.submitNotification(ctx, actor, c);
  let job = sub.job;
  // a brand-new immediate notification — or a retry of one whose first request died half-way — is (continued) right now
  if (job.status === 'sending' && !job.test) job = (await E.processJob(ctx, job.id, { deadline })).job;
  return { job, duplicate: sub.duplicate, created: sub.created };
}

async function test({ ctx, actor, body, deadline }) {
  const c = V.validateCompose({ ...body, scheduleAt: null }, { now: ctx.now(), cfg: ctx.cfg, requireAudience: false });
  const sub = await E.submitTest(ctx, actor, c);
  let job = sub.job;
  if (job.status === 'sending') job = (await E.processJob(ctx, job.id, { deadline })).job;
  return { job, duplicate: sub.duplicate, created: sub.created };
}

async function processRoute({ ctx, body, deadline }) {
  if (body.id === undefined || body.id === null || body.id === '') {
    const t = await E.tick(ctx, { deadline });
    return { jobs: t.jobs, waiting: t.waiting };
  }
  if (typeof body.id !== 'string' || !V.ID_RE.test(body.id)) throw bad('invalid_id', 'Invalid notification id.');
  const r = await E.processJob(ctx, body.id, { deadline });
  return { job: r.job, done: r.done, busy: r.busy };
}

async function cancel({ ctx, actor, body }) {
  if (typeof body.id !== 'string' || !V.ID_RE.test(body.id)) throw bad('invalid_id', 'Invalid notification id.');
  return { job: await E.cancelJob(ctx, actor, body.id) };
}

const pageLimit = (v, dflt = 30) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : dflt; };
const cursorOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : null));

async function history({ ctx, body, query }) {
  const src = { ...query, ...body };
  return S.listJobs(ctx, { limit: pageLimit(src.limit), before: cursorOf(src.before) });
}

async function audit({ ctx, body, query }) {
  const src = { ...query, ...body };
  return S.listAudit(ctx, { limit: pageLimit(src.limit), before: cursorOf(src.before) });
}

const publicImage = (origin, id, d) => ({
  id, kind: d.kind || 'image', name: d.name || '', mime: d.mime || '', size: d.size || 0, thumb: d.thumb || '', createdAt: d.createdAt || 0,
  url: `${origin}/api/push/img?id=${id}`,
});

async function upload({ ctx, actor, headers, body }) {
  const up = V.validateUpload(body, ctx.cfg);
  const rate = await S.consumeRate(ctx, actor.uid, 'upload');
  if (!rate.ok) throw tooMany('rate_limited', 'Too many uploads — wait a little.', rate.retryAfter);
  const count = (await ctx.db.collection(COL.images).count().get()).data().count;
  if (count >= ctx.cfg.limits.maxImages) throw conflict('too_many_images', `You already have ${count} saved pictures. Delete an old one first.`);

  const id = S.randomId(12);
  const now = ctx.now();
  const meta = { id, kind: up.kind, name: up.name, mime: up.mime, size: up.data.length, thumb: up.thumb, createdAt: now, createdBy: { uid: actor.uid, name: actor.name } };
  const batch = ctx.db.batch();
  batch.set(ctx.db.collection(COL.imageData).doc(id), { mime: up.mime, b64: up.data.toString('base64'), size: up.data.length, createdAt: now });
  batch.set(ctx.db.collection(COL.images).doc(id), meta);
  await batch.commit();
  await S.writeAudit(ctx, actor, 'push.upload', { label: up.name || id, detail: `${up.kind}, ${Math.round(up.data.length / 1024)} KB` });
  return { image: publicImage(selfOrigin(ctx, headers), id, meta) };
}

async function images({ ctx, headers }) {
  const snap = await ctx.db.collection(COL.images).orderBy('createdAt', 'desc').limit(ctx.cfg.limits.maxImages).get();
  const origin = selfOrigin(ctx, headers);
  return { images: snap.docs.map((d) => publicImage(origin, d.id, d.data())) };
}

async function imageDelete({ ctx, actor, body }) {
  if (typeof body.id !== 'string' || !IMAGE_ID_RE.test(body.id)) throw bad('invalid_id', 'Invalid picture id.');
  const ref = ctx.db.collection(COL.images).doc(body.id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound('image_not_found', 'That picture does not exist.');
  const batch = ctx.db.batch();
  batch.delete(ref);
  batch.delete(ctx.db.collection(COL.imageData).doc(body.id));
  await batch.commit();
  await S.writeAudit(ctx, actor, 'push.image_delete', { label: snap.data().name || body.id });
  return { deleted: body.id };
}

/* ---------- public + scheduler ---------- */
async function getImage({ ctx, query }) {
  const id = String(query.id || '');
  if (!IMAGE_ID_RE.test(id)) throw notFound('image_not_found', 'No such picture.');
  const snap = await ctx.db.collection(COL.imageData).doc(id).get();
  if (!snap.exists) throw notFound('image_not_found', 'No such picture.');
  const d = snap.data();
  return { binary: Buffer.from(String(d.b64 || ''), 'base64'), mime: /^image\/(jpeg|png|webp)$/.test(d.mime) ? d.mime : 'application/octet-stream' };
}

async function cron({ ctx, deadline }) {
  const t = await E.tick(ctx, { deadline });
  await heartbeat(ctx, { ran: t.jobs.length, waiting: t.waiting });
  return { ran: t.jobs.length, waiting: t.waiting };
}

/* ---------- the table ---------- */
const ROUTES = {
  img: { m: ['GET'], auth: 'none', fn: getImage },
  cron: { m: ['GET', 'POST'], auth: 'cron', fn: cron },
  subscribe: { m: ['POST'], auth: 'user', fn: subscribe },
  unsubscribe: { m: ['POST'], auth: 'user', fn: unsubscribe },
  prefs: { m: ['POST'], auth: 'user', fn: prefs },
  me: { m: ['GET', 'POST'], auth: 'user', fn: me },
  health: { m: ['GET', 'POST'], auth: 'admin', fn: health },
  audience: { m: ['POST'], auth: 'admin', fn: audiencePreview },
  send: { m: ['POST'], auth: 'admin', fn: send },
  test: { m: ['POST'], auth: 'admin', fn: test },
  process: { m: ['POST'], auth: 'admin', fn: processRoute },
  cancel: { m: ['POST'], auth: 'admin', fn: cancel },
  history: { m: ['GET', 'POST'], auth: 'admin', fn: history },
  audit: { m: ['GET', 'POST'], auth: 'admin', fn: audit },
  upload: { m: ['POST'], auth: 'admin', fn: upload, limit: UPLOAD_LIMIT },
  images: { m: ['GET', 'POST'], auth: 'admin', fn: images },
  'image-delete': { m: ['POST'], auth: 'admin', fn: imageDelete },
};

function fail(ctx, e, cors) {
  if (e instanceof HttpError) {
    const more = {};
    if (e.status === 429 && e.extra && e.extra.retryAfter) more['Retry-After'] = String(e.extra.retryAfter);
    if (e.allow) more.Allow = e.allow;
    return json(e.status, { ok: false, error: { code: e.code, message: e.message, ...(e.extra || {}) } }, cors, more);
  }
  const msg = String((e && e.message) || '');
  if ((e && e.code === 8) || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg)) {
    ctx.log('warn', 'firestore quota exhausted', {});
    return json(503, { ok: false, error: { code: 'firestore_quota', message: 'The free Firestore daily limit has been reached. It resets every day — try again later.' } }, cors, { 'Retry-After': '3600' });
  }
  ctx.log('error', 'unhandled error', { message: msg.slice(0, 300), stack: String((e && e.stack) || '').split('\n').slice(0, 4).join(' | ').slice(0, 600) });
  return json(500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong on the server.' } }, cors);
}

async function handle(ctx, req) {
  ctx.state = ctx.state || {};
  const started = ctx.now();
  const headers = lowerKeys(req.headers);
  const cors = corsHeaders(ctx, String(headers.origin || ''));
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' }, body: '' };

    const route = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
    if (!route) throw notFound('unknown_action', 'Unknown action.');
    if (!route.m.includes(method)) { const e = new HttpError(405, 'method_not_allowed', `Use ${route.m.join(' or ')}.`); e.allow = route.m.join(', '); throw e; }
    if (ctx.setupError) throw new HttpError(503, 'server_not_configured', 'The push server is not set up yet.', { reason: ctx.setupError });
    if (Number(headers['content-length'] || 0) > (route.limit || JSON_LIMIT)) throw new HttpError(413, 'payload_too_large', 'The request is too large.');

    const h = {
      ctx, headers, deadline: started + ctx.cfg.budgetMs,
      query: req.query && typeof req.query === 'object' ? req.query : {},
      body: method === 'POST' && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {},
    };
    if (route.auth === 'cron') {
      await requireCron(ctx, headers);
    } else if (route.auth === 'user') {
      h.user = await verifyUser(ctx, headers, { checkRevoked: false });
      lightLimit(ctx, `u:${h.user.uid}:${req.action}`, 30, MIN);
    } else if (route.auth === 'admin') {
      const u = await verifyUser(ctx, headers, { checkRevoked: true });
      h.actor = await requireAdmin(ctx, u);
      lightLimit(ctx, `a:${u.uid}`, 240, MIN);
    } else {
      lightLimit(ctx, `ip:${clientIp(headers)}`, 120, MIN);
    }

    const out = await route.fn(h);
    if (out && out.binary) {
      return {
        status: 200,
        body: out.binary,
        headers: {
          'Content-Type': out.mime, 'Content-Length': String(out.binary.length),
          'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      };
    }
    return json(200, { ok: true, ...out }, cors);
  } catch (e) {
    return fail(ctx, e, cors);
  }
}

module.exports = { handle, ROUTES, verifyUser, requireAdmin, requireCron, corsHeaders, heartbeat, selfOrigin, lightLimit };
