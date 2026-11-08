'use strict';
// ==========================================================================
// server/push/validate.js — PURE input checking (no Firebase, no network). Everything the browser sends is
// treated as hostile: it is re-validated here, on the server, whatever the admin page already checked.
// ==========================================================================
const crypto = require('crypto');
const { bad } = require('./errors');
const { SITE_ROUTES, CATEGORIES } = require('./config');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DEVICE_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DEST_RE = new RegExp(`^#/(?:${SITE_ROUTES.join('|')})(?:\\?[A-Za-z0-9_=&%.-]{1,200})?$`);
const PLATFORMS = ['android', 'ios', 'windows', 'mac', 'linux', 'chromeos', 'other'];
const BROWSERS = ['chrome', 'edge', 'firefox', 'safari', 'samsung', 'opera', 'other'];

const cpLen = (s) => Array.from(s).length;

/** Plain text only: control characters, BiDi overrides and zero-width spaces go; ZWJ/ZWNJ stay (Bengali conjuncts need them). */
function cleanText(v, { multiline = false } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F​‪-‮⁦-⁩﻿]/g, '');
  if (multiline) {
    s = s.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  return s;
}

/** https only, no credentials / port, no IP literals or local names. → normalized href or '' */
function safeHttpsUrl(raw, max = 500) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.length > max) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h.includes(':')) return '';
  return u.href;
}

/**
 * Where a tap on the notification may lead. ONLY a page of this site, written as its hash route
 * ("#/results", "#/exam?id=abc"). A full link is accepted only when it is this site's own address.
 * → { ok, value }
 */
function normalizeDestination(raw, siteUrl) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: true, value: '#/home' };
  if (s.length > 260) return { ok: false, value: '' };
  let rel = s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) {
    let u, base;
    try { u = new URL(s); base = new URL(`${String(siteUrl || '').replace(/\/+$/, '')}/`); } catch { return { ok: false, value: '' }; }
    if (!siteUrl || u.origin !== base.origin || u.search) return { ok: false, value: '' };
    const p = u.pathname.replace(/\/+$/, '');
    const bp = base.pathname.replace(/\/+$/, '');
    if (p !== bp && p !== `${bp}/index.html`) return { ok: false, value: '' };
    rel = u.hash || '#/home';
  }
  return DEST_RE.test(rel) ? { ok: true, value: rel } : { ok: false, value: '' };
}

const needId = (v, code, msg) => { if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(code, msg); return v; };

function validateAudience(a) {
  if (!a || typeof a !== 'object') throw bad('invalid_audience', 'Choose who should receive this notification.', { field: 'audience' });
  switch (a.type) {
    case 'all': return { type: 'all' };
    case 'user': return { type: 'user', uid: needId(a.uid, 'invalid_audience', 'Pick a student.') };
    case 'exam': {
      const filter = ['all', 'not_submitted', 'submitted'].includes(a.filter) ? a.filter : 'all';
      return { type: 'exam', examId: needId(a.examId, 'invalid_audience', 'Pick an exam.'), filter };
    }
    case 'section': return { type: 'section', sectionId: needId(a.sectionId, 'invalid_audience', 'Pick a section.') };
    case 'level': return { type: 'level', levelId: needId(a.levelId, 'invalid_audience', 'Pick a level.') };
    default: throw bad('invalid_audience', 'Unknown audience.', { field: 'audience' });
  }
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; }
  return NaN;
}

/**
 * The composer's payload → the exact, normalized document the server stores and sends.
 *   opts: { now, cfg, requireAudience (default true) }
 */
function validateCompose(input, { now, cfg, requireAudience = true }) {
  if (!input || typeof input !== 'object') throw bad('invalid_body', 'Missing request body.');
  const L = cfg.limits;
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  if (!REQUEST_ID_RE.test(requestId)) throw bad('invalid_request_id', 'Missing or invalid request id.');

  const title = cleanText(input.title);
  if (!title || cpLen(title) > L.titleMax) throw bad('invalid_title', `Title must be 1–${L.titleMax} characters.`, { field: 'title' });
  const body = cleanText(input.body, { multiline: true });
  if (!body || cpLen(body) > L.bodyMax) throw bad('invalid_body_text', `Message must be 1–${L.bodyMax} characters.`, { field: 'body' });

  const category = input.category === undefined || input.category === '' ? 'announcement' : input.category;
  if (!CATEGORIES.includes(category)) throw bad('invalid_category', 'Unknown notification type.', { field: 'category' });

  const dest = normalizeDestination(input.url, cfg.siteUrl);
  if (!dest.ok) throw bad('invalid_url', 'The destination must be a page of this site (for example #/results).', { field: 'url' });

  const image = input.image ? safeHttpsUrl(input.image, L.imageUrlMax) : '';
  if (input.image && !image) throw bad('invalid_image', 'The image must be an https link to a public picture.', { field: 'image' });
  const icon = input.icon ? safeHttpsUrl(input.icon, L.imageUrlMax) : '';
  if (input.icon && !icon) throw bad('invalid_icon', 'The icon must be an https link to a public picture.', { field: 'icon' });

  const audience = requireAudience ? validateAudience(input.audience) : { type: 'self' };

  let scheduleAt = null;
  if (input.scheduleAt !== undefined && input.scheduleAt !== null && input.scheduleAt !== '') {
    scheduleAt = toMs(input.scheduleAt);
    if (!Number.isFinite(scheduleAt)) throw bad('invalid_schedule', 'The schedule time is not valid.', { field: 'schedule' });
    if (scheduleAt < now + 60 * 1000) throw bad('schedule_in_past', 'Pick a time at least one minute from now.', { field: 'schedule' });
    if (scheduleAt > now + L.maxScheduleDays * 86400000) throw bad('schedule_too_far', 'The schedule is too far in the future.', { field: 'schedule' });
  }

  return { requestId, title, body, category, url: dest.value, image, icon, audience, scheduleAt };
}

function contentHash(c) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([c.title, c.body, c.category, c.url, c.image, c.icon, c.audience]))
    .digest('hex').slice(0, 32);
}

/** Human text for an audience, e.g. history rows. Names (exam title …) are added by the caller. */
function audienceKey(a) {
  return a.type === 'all' ? 'all' : `${a.type}:${a.uid || a.examId || a.sectionId || a.levelId}${a.filter && a.filter !== 'all' ? `:${a.filter}` : ''}`;
}

function validatePrefs(p) {
  const out = {};
  CATEGORIES.forEach((c) => { out[c] = !(p && typeof p === 'object' && p[c] === false); });
  return out;
}

function validateSubscribe(input) {
  if (!input || typeof input !== 'object') throw bad('invalid_body', 'Missing request body.');
  if (typeof input.token !== 'string' || !TOKEN_RE.test(input.token)) throw bad('invalid_token', 'That is not a valid push token.');
  if (typeof input.deviceKey !== 'string' || !DEVICE_KEY_RE.test(input.deviceKey)) throw bad('invalid_device', 'Missing device id.');
  const previousToken = typeof input.previousToken === 'string' && TOKEN_RE.test(input.previousToken) ? input.previousToken : '';
  return {
    token: input.token,
    deviceKey: input.deviceKey,
    previousToken,
    prefs: input.prefs && typeof input.prefs === 'object' ? validatePrefs(input.prefs) : null, // null = "keep what is stored"
    label: cleanText(String(input.label || '')).slice(0, 60),
    platform: PLATFORMS.includes(input.platform) ? input.platform : 'other',
    browser: BROWSERS.includes(input.browser) ? input.browser : 'other',
    standalone: input.standalone === true,
  };
}

function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function decodeImage(b64, maxBytes, field) {
  if (typeof b64 !== 'string' || !b64 || b64.length > Math.ceil(maxBytes * 4 / 3) + 8 || !B64_RE.test(b64)) {
    throw bad('invalid_image_file', 'The picture is missing, too large or damaged.', { field });
  }
  const buf = Buffer.from(b64, 'base64');
  const mime = sniffImage(buf);
  if (!mime || buf.length > maxBytes) throw bad('invalid_image_file', 'Only JPEG, PNG or WebP pictures up to 700 KB are allowed.', { field });
  return { buf, mime };
}

function validateUpload(input, cfg) {
  if (!input || typeof input !== 'object') throw bad('invalid_body', 'Missing request body.');
  const kind = input.kind === 'icon' ? 'icon' : 'image';
  const main = decodeImage(input.data, cfg.limits.imageMaxBytes, 'data');
  const thumb = decodeImage(input.thumb, cfg.limits.thumbMaxBytes, 'thumb');
  return { kind, mime: main.mime, data: main.buf, thumb: `data:${thumb.mime};base64,${thumb.buf.toString('base64')}`, name: cleanText(String(input.name || '')).slice(0, 60) };
}

module.exports = {
  ID_RE, REQUEST_ID_RE, DEVICE_KEY_RE, TOKEN_RE, DEST_RE,
  cleanText, safeHttpsUrl, normalizeDestination, validateAudience, validateCompose, contentHash, audienceKey,
  validatePrefs, validateSubscribe, validateUpload, sniffImage, cpLen, toMs,
};
