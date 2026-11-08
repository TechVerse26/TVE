'use strict';
// ==========================================================================
// server/push/runtime.js — the ONLY file that touches the real firebase-admin SDK.
// Everything else receives a `ctx` object, so the whole backend can be tested with in-memory fakes.
//
//   ctx = { cfg, db, auth, messaging, state, setupError, now(), sleep(ms), serverTime(), log(level, msg, extra) }
//
// The service-account key arrives ONLY through environment variables (see config.js) and never leaves this process.
// ==========================================================================
const { readConfig } = require('./config');

function log(level, msg, extra) {
  const line = JSON.stringify({ level, msg, ...(extra || {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

let cached = null;

/** Builds the context once per server instance (warm invocations reuse it). Never throws: a broken setup becomes ctx.setupError. */
function getContext(env = process.env) {
  if (cached) return cached;
  const cfg = readConfig(env);
  const ctx = {
    cfg, db: null, auth: null, messaging: null, state: {}, setupError: '',
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    serverTime: () => null,
    log,
  };
  cached = ctx;
  if (!cfg.serviceAccount) { ctx.setupError = cfg.serviceAccountError || 'missing'; return ctx; }
  try {
    const { initializeApp, getApps, cert } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = getApps()[0] || initializeApp({ credential: cert(cfg.serviceAccount), projectId: cfg.projectId });
    const db = getFirestore(app);
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured in this instance */ }
    ctx.db = db;
    ctx.auth = getAuth(app);
    ctx.messaging = getMessaging(app);
    ctx.serverTime = () => FieldValue.serverTimestamp();
  } catch (e) {
    ctx.setupError = 'firebase_init_failed';
    log('error', 'firebase-admin could not start', { message: String(e && e.message).slice(0, 200) });
  }
  return ctx;
}

module.exports = { getContext, log };
