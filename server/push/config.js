'use strict';
// ==========================================================================
// server/push/config.js — everything the push backend reads from environment variables
// (Vercel → Project → Settings → Environment Variables). Nothing secret is ever hard-coded.
//
//   FIREBASE_SERVICE_ACCOUNT      the service-account JSON (one line)        — or —
//   FIREBASE_SERVICE_ACCOUNT_B64  the same JSON, base64-encoded (safer to paste)
//   CRON_SECRET                   long random text; lets the free scheduler call /api/push/cron
//   SITE_URL                      optional: https://tvexam.vercel.app (default: Vercel's production domain)
//   PUSH_ALLOWED_ORIGINS          optional: extra origins allowed to call the API (only if the site is hosted elsewhere)
//   PUSH_MAX_RECIPIENTS / PUSH_ADMIN_PER_HOUR / PUSH_ADMIN_PER_DAY / PUSH_FUNCTION_BUDGET_MS   optional tuning
// ==========================================================================

const SITE_ROUTES = ['home', 'exam', 'exams', 'categories', 'schedule', 'notifications', 'leaderboard', 'performance', 'results', 'profile', 'about', 'faq', 'help', 'privacy', 'terms', 'credits'];
const CATEGORIES = ['announcement', 'exam', 'result'];

function intEnv(env, name, dflt, min, max) {
  const n = Number.parseInt(env[name], 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** → { value, error } — never throws, never echoes the key. */
function parseServiceAccount(env) {
  let raw = env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(String(env.FIREBASE_SERVICE_ACCOUNT_B64).trim(), 'base64').toString('utf8')
    : env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !String(raw).trim()) return { value: null, error: 'missing' };
  let obj;
  try {
    obj = JSON.parse(String(raw).trim());
    if (typeof obj === 'string') obj = JSON.parse(obj); // pasted as a JSON string of JSON
  } catch { return { value: null, error: 'invalid_json' }; }
  if (!obj || typeof obj !== 'object') return { value: null, error: 'invalid_json' };
  if (typeof obj.private_key === 'string') obj.private_key = obj.private_key.replace(/\\n/g, '\n'); // "\n" typed as two characters
  if (obj.type !== 'service_account' || !obj.project_id || !obj.client_email || !/BEGIN PRIVATE KEY/.test(String(obj.private_key || ''))) {
    return { value: null, error: 'not_a_service_account' };
  }
  return { value: obj, error: '' };
}

function normalizeSite(raw) {
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) return null;
    const path = u.pathname.replace(/\/+$/, '');
    return { url: `${u.origin}${path}`, origin: u.origin };
  } catch { return null; }
}

function readConfig(env = process.env) {
  const sa = parseServiceAccount(env);
  const site = normalizeSite(env.SITE_URL) || normalizeSite(env.VERCEL_PROJECT_PRODUCTION_URL);
  const allowed = new Set(String(env.PUSH_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean));
  if (site) allowed.add(site.origin);
  return {
    serviceAccount: sa.value,
    serviceAccountError: sa.error,
    projectId: sa.value ? sa.value.project_id : '',
    siteUrl: site ? site.url : '',
    siteOrigin: site ? site.origin : '',
    allowedOrigins: [...allowed],
    cronSecret: String(env.CRON_SECRET || ''),
    limits: {
      titleMax: 65,
      bodyMax: 240,
      imageUrlMax: 500,
      maxRecipients: intEnv(env, 'PUSH_MAX_RECIPIENTS', 5000, 10, 20000),
      adminPerHour: intEnv(env, 'PUSH_ADMIN_PER_HOUR', 20, 1, 500),
      adminPerDay: intEnv(env, 'PUSH_ADMIN_PER_DAY', 80, 1, 2000),
      adminMinGapMs: 4000,
      testPerHour: 15,
      uploadPerHour: 30,
      globalPerDay: 300,
      subscribePerHour: 40,
      maxDevicesPerUser: 8,
      maxImages: 60,
      imageMaxBytes: 700 * 1024,
      thumbMaxBytes: 24 * 1024,
      maxScheduleDays: 366,
    },
    budgetMs: intEnv(env, 'PUSH_FUNCTION_BUDGET_MS', 7500, 2000, 55000), // stays inside Vercel's default 10 s
    leaseMs: 60 * 1000,
    deviceBatch: 200,
    uidBatch: 30,
    ttlSeconds: 24 * 60 * 60,
    staleDeviceDays: 90,
  };
}

module.exports = { readConfig, parseServiceAccount, normalizeSite, SITE_ROUTES, CATEGORIES };
