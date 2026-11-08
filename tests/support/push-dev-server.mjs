// The REAL push routes (server/push/*) behind a tiny local HTTP server, backed by the in-memory fakes of Firestore / Auth / FCM.
// For browser tests only (tests/e2e/run_push.py): it lets the admin page and the student pages talk to the actual server code
// with no network, no key and no Google account.
//
//   node tests/support/push-dev-server.mjs <port> <startEpochMs>
//
// The API:      POST|GET /api/push/<action>        (exactly what Vercel would receive)
// Test hooks:   GET  /__state                      what the fake FCM got, the jobs, the devices, the audit trail
//               POST /__advance?ms=N               move the server clock forward (scheduled sends)
//               POST /__device?uid=U               give a user an active device (returns its token)
//               POST /__fcm-fail?code=C            make FCM refuse every send (code like "messaging/server-unavailable"); no code = stop failing
//               POST /__fail-token?uid=U&code=C    make FCM refuse one student's device
//               POST /__role?uid=U&role=R          set (or, with no role, remove) an admin's role on the server
//               start with --no-cron               to run without CRON_SECRET (the "free timer not set up" state)
import http from "node:http";
import { createRequire } from "node:module";
import * as F from "./fake-admin.mjs";

const require = createRequire(import.meta.url);
const R = require("../../server/push/routes.js");

const PORT = Number(process.argv[2] || 8766);
const START = Number(process.argv[3] || Date.now());
const NO_CRON = process.argv.includes("--no-cron");
const real0 = Date.now();
let advance = 0;

const env = F.makeEnv({ env: { SITE_URL: "https://tvexam.vercel.app", ...(NO_CRON ? { CRON_SECRET: "" } : {}) } });
const ctx = env.ctx;
const now = () => START + (Date.now() - real0) + advance;
ctx.now = now;
ctx.serverTime = now;
ctx.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10)));
if (NO_CRON) ctx.cfg.cronSecret = "";
env.clock.t = START;

// the people the browser fixtures know (tests/e2e/fixtures.py)
const people = [
  ["adm1", { isAdmin: true, displayName: "Admin One", email: "admin@example.com" }],
  ["stu1", { displayName: "Abdullah Rahman", email: "stu@example.com" }],
  ["stuA", { displayName: "Rahim Uddin" }], ["stuB", { displayName: "Karim Hossain" }], ["stuC", { displayName: "Nusrat Jahan" }],
];
people.forEach(([uid, o]) => F.addUser(env, uid, o));
env.auth.addUser("outsider", { email: "outsider@example.com", name: "Outsider" });   // signed in, but has no users/{uid} document
for (const uid of ["stu1", "stuA", "stuB"]) F.addDevice(env, uid);
F.addDevice(env, "stuC", { prefs: { announcement: false, exam: true, result: true } });   // switched announcements off

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body); };
const jsonOut = (res, v) => send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }, JSON.stringify(v));

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/__state") {
      return jsonOut(res, {
        now: now(), sent: env.messaging.sent, calls: env.messaging.calls,
        jobs: env.db.all("pushNotifications"), devices: env.db.all("pushDevices").map((d) => ({ id: d.id, uid: d.uid, status: d.status, prefs: d.prefs })),
        audit: env.db.all("pushAudit"), adminLogs: env.db.all("adminLogs"), images: env.db.all("pushImages").map((i) => ({ id: i.id, kind: i.kind, size: i.size })),
      });
    }
    if (url.pathname === "/__advance") { advance += Number(url.searchParams.get("ms") || 0); return jsonOut(res, { now: now() }); }
    if (url.pathname === "/__device") {
      env.clock.t = now();
      const d = F.addDevice(env, String(url.searchParams.get("uid") || "adm1"));
      return jsonOut(res, d);
    }
    if (url.pathname === "/__fcm-fail") { env.messaging.failEverything = url.searchParams.get("code") || null; return jsonOut(res, { ok: true }); }
    if (url.pathname === "/__fail-token") {                 // make FCM refuse ONE student's device (e.g. messaging/registration-token-not-registered)
      const uid = String(url.searchParams.get("uid") || "");
      const dev = env.db.all("pushDevices").find((d) => d.uid === uid && d.status === "active");
      if (dev) env.messaging.failToken(dev.token, String(url.searchParams.get("code") || "messaging/registration-token-not-registered"));
      return jsonOut(res, { ok: !!dev });
    }
    if (url.pathname === "/__role") {                       // change an admin's role on the SERVER (the browser fixture is changed by the test itself)
      const uid = String(url.searchParams.get("uid") || "adm1"), role = String(url.searchParams.get("role") || "");
      if (role) env.db.seed("adminRoles", uid, { role }); else env.db._docs.delete(`adminRoles/${uid}`);
      return jsonOut(res, { ok: true });
    }

    const m = /^\/api\/push\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!m) return send(res, 404, { "Content-Type": "text/plain" }, "not found");
    const text = req.method === "POST" ? await readBody(req) : "";
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    const out = await R.handle(ctx, {
      method: req.method, action: m[1], query: Object.fromEntries(url.searchParams), headers: { ...req.headers, host: "tvexam.vercel.app" }, body,
    });
    const headers = { ...(out.headers || {}) };
    return send(res, out.status, headers, out.body);
  } catch (e) {
    return send(res, 500, { "Content-Type": "application/json" }, JSON.stringify({ ok: false, error: { code: "dev_server_failure", message: String(e && e.stack || e) } }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`push dev server on ${PORT}`));
