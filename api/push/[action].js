'use strict';
// ==========================================================================
// api/push/[action].js — Vercel serverless entry point:  /api/push/<action>
// A thin adapter only: all the logic lives in server/push/ (routes.js → engine.js → store.js …).
// It runs on Vercel's free Hobby plan — no Firebase Blaze plan, no card, no Cloud Functions.
// ==========================================================================
const { getContext } = require('../../server/push/runtime');
const { handle } = require('../../server/push/routes');

function actionOf(req) {
  const q = req.query && req.query.action;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const m = /\/api\/push\/([A-Za-z0-9_-]+)/.exec(String(req.url || ''));
  return m ? m[1] : '';
}

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try {
    const text = Buffer.isBuffer(b) ? b.toString('utf8') : (typeof b === 'string' ? b : '');
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

module.exports = async function handler(req, res) {
  let out;
  try {
    out = await handle(getContext(), {
      method: req.method, action: actionOf(req), query: req.query || {}, headers: req.headers || {}, body: parseBody(req),
    });
  } catch (e) {
    // handle() already turns every error into a response; this only guards against a bug in this adapter
    console.error(JSON.stringify({ level: 'error', msg: 'adapter failure', message: String(e && e.message).slice(0, 200) }));
    out = { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, error: { code: 'internal_error', message: 'Something went wrong on the server.' } }) };
  }
  res.statusCode = out.status;
  Object.entries(out.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(out.body);
};
