// In-memory stand-ins for firebase-admin (Firestore, Auth, Messaging) — just enough surface for server/push/*.
// They let the whole push backend run in tests with NO network, NO key and NO Google account.
//
// The Firestore fake is deliberately strict where the real one is strict (optimistic transactions that retry on conflict,
// `in` ≤ 30 values, create() on an existing document fails with code 6, documents missing an orderBy field are skipped …)
// so a mistake that would only show up in production shows up here first.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readConfig } = require("../../server/push/config.js");

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const err = (code, name, msg) => Object.assign(new Error(`${code} ${name}: ${msg}`), { code });

function getPath(obj, path) {
  return String(path).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function setPath(obj, path, value) {
  const keys = String(path).split(".");
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
}
function mergeDeep(dst, src) {
  Object.keys(src).forEach((k) => {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) mergeDeep(dst[k], src[k]);
    else dst[k] = clone(src[k]);
  });
  return dst;
}

class DocSnap {
  constructor(ref, rec) { this.ref = ref; this.id = ref.id; this.exists = !!rec; this._d = rec ? rec.data : undefined; this.version = rec ? rec.v : 0; }
  data() { return this.exists ? clone(this._d) : undefined; }
}
class QuerySnap {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
}

class DocRef {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; this.path = `${col}/${id}`; }
  get firestore() { return this.db; }
  async get() { this.db.reads += 1; return new DocSnap(this, this.db._docs.get(this.path)); }
  async set(data, opts) { this.db._write([{ op: opts && opts.merge ? "merge" : "set", ref: this, data }]); }
  async create(data) { this.db._write([{ op: "create", ref: this, data }]); }
  async update(patch) { this.db._write([{ op: "update", ref: this, data: patch }]); }
  async delete() { this.db._write([{ op: "delete", ref: this }]); }
}

class Query {
  constructor(db, col, spec) { this.db = db; this.col = col; this.spec = spec || { filters: [], order: null, limit: null, after: undefined, select: false }; }
  _with(p) { return new Query(this.db, this.col, { ...this.spec, ...p }); }
  where(f, op, v) {
    if (op === "in" && (!Array.isArray(v) || v.length === 0 || v.length > 30)) throw err(3, "INVALID_ARGUMENT", "'in' needs 1–30 values");
    return this._with({ filters: [...this.spec.filters, { f, op, v }] });
  }
  orderBy(f, dir = "asc") { return this._with({ order: { f, dir } }); }
  limit(n) { return this._with({ limit: n }); }
  startAfter(v) { return this._with({ after: v }); }
  select() { return this._with({ select: true }); }
  _run() {
    const { filters, order, limit, after, select } = this.spec;
    let rows = [...this.db._docs.entries()].filter(([p]) => p.startsWith(`${this.col}/`)).map(([p, rec]) => ({ id: p.slice(this.col.length + 1), rec }));
    rows = rows.filter(({ rec }) => filters.every(({ f, op, v }) => {
      const val = getPath(rec.data, f);
      switch (op) {
        case "==": return val === v;
        case "!=": return val !== undefined && val !== v;
        case "in": return v.includes(val);
        case "array-contains": return Array.isArray(val) && val.includes(v);
        case "<": return typeof val === "number" && val < v;
        case "<=": return typeof val === "number" && val <= v;
        case ">": return typeof val === "number" && val > v;
        case ">=": return typeof val === "number" && val >= v;
        default: throw err(3, "INVALID_ARGUMENT", `unsupported operator ${op}`);
      }
    }));
    if (order) {
      rows = rows.filter(({ rec }) => getPath(rec.data, order.f) !== undefined);
      const sgn = order.dir === "desc" ? -1 : 1;
      rows.sort((a, b) => { const x = getPath(a.rec.data, order.f); const y = getPath(b.rec.data, order.f); return x < y ? -sgn : x > y ? sgn : 0; });
      if (after !== undefined) rows = rows.filter(({ rec }) => (sgn === 1 ? getPath(rec.data, order.f) > after : getPath(rec.data, order.f) < after));
    } else {
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    if (limit) rows = rows.slice(0, limit);
    return rows.map(({ id, rec }) => {
      const ref = new DocRef(this.db, this.col, id);
      const snap = new DocSnap(ref, select ? { data: {}, v: rec.v } : rec);
      return snap;
    });
  }
  async get() { const docs = this._run(); this.db.reads += Math.max(1, docs.length); return new QuerySnap(docs); }
  count() {
    return { get: async () => { const n = this._run().length; this.db.reads += Math.max(1, Math.ceil(n / 1000)); return { data: () => ({ count: n }) }; } };
  }
}

class CollRef extends Query {
  constructor(db, col) { super(db, col); }
  doc(id) { return new DocRef(this.db, this.col, id || this.db._autoId()); }
  async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
}

export class FakeFirestore {
  constructor() { this._docs = new Map(); this._seq = 0; this._v = 0; this.reads = 0; this.writes = 0; this.fail = null; }
  _autoId() { this._seq += 1; return `auto${String(this._seq).padStart(6, "0")}`; }
  collection(name) { return new CollRef(this, name); }
  settings() {}
  async getAll(...refs) { this.reads += refs.length; return refs.map((r) => new DocSnap(r, this._docs.get(r.path))); }
  /** apply a list of writes atomically */
  _write(ops) {
    if (this.fail) { const f = this.fail; if (f.times === undefined || f.times-- > 0) { if (f.times <= 0) this.fail = null; throw f.error; } }
    // validate first so a failing op leaves nothing half-applied
    ops.forEach((o) => {
      const exists = this._docs.has(o.ref.path);
      if (o.op === "create" && exists) throw err(6, "ALREADY_EXISTS", "Document already exists");
      if (o.op === "update" && !exists) throw err(5, "NOT_FOUND", `No document to update: ${o.ref.path}`);
    });
    ops.forEach((o) => {
      this.writes += 1;
      this._v += 1;
      const cur = this._docs.get(o.ref.path);
      if (o.op === "delete") { this._docs.delete(o.ref.path); return; }
      if (o.op === "set" || o.op === "create") { this._docs.set(o.ref.path, { data: clone(o.data), v: this._v }); return; }
      if (o.op === "merge") { this._docs.set(o.ref.path, { data: mergeDeep(cur ? clone(cur.data) : {}, o.data), v: this._v }); return; }
      if (o.op === "update") {
        const next = clone(cur.data);
        Object.entries(o.data).forEach(([k, v]) => { if (k.includes(".")) setPath(next, k, clone(v)); else next[k] = clone(v); });
        this._docs.set(o.ref.path, { data: next, v: this._v });
      }
    });
  }
  batch() {
    const ops = [];
    const b = {
      set: (ref, data) => { ops.push({ op: "set", ref, data }); return b; },
      update: (ref, data) => { ops.push({ op: "update", ref, data }); return b; },
      delete: (ref) => { ops.push({ op: "delete", ref }); return b; },
      commit: async () => this._write(ops),
    };
    return b;
  }
  /** optimistic transaction: reads are versioned, a conflicting commit is retried (like the real SDK) */
  async runTransaction(fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reads = new Map();
      const ops = [];
      const tx = {
        get: async (ref) => { const snap = await ref.get(); reads.set(ref.path, snap.version); return snap; },
        set: (ref, data) => { ops.push({ op: "set", ref, data }); return tx; },
        update: (ref, data) => { ops.push({ op: "update", ref, data }); return tx; },
        delete: (ref) => { ops.push({ op: "delete", ref }); return tx; },
        create: (ref, data) => { ops.push({ op: "create", ref, data }); return tx; },
      };
      const out = await fn(tx);
      const stale = [...reads].some(([path, v]) => (this._docs.get(path) ? this._docs.get(path).v : 0) !== v);
      if (stale) continue;
      if (ops.length) this._write(ops);
      return out;
    }
    throw err(10, "ABORTED", "Too much contention on these documents");
  }
  /* ---- test helpers ---- */
  seed(col, id, data) { this._v += 1; this._docs.set(`${col}/${id}`, { data: clone(data), v: this._v }); }
  peek(col, id) { const r = this._docs.get(`${col}/${id}`); return r ? clone(r.data) : undefined; }
  all(col) { return [...this._docs.entries()].filter(([p]) => p.startsWith(`${col}/`)).map(([p, r]) => ({ id: p.slice(col.length + 1), ...clone(r.data) })); }
  resetCounters() { this.reads = 0; this.writes = 0; }
}

export class FakeAuth {
  constructor(project = "tvsaccount") { this.project = project; this.users = new Map(); this.calls = []; }
  addUser(uid, claims = {}) { this.users.set(uid, { uid, email: `${uid}@example.com`, name: uid, ...claims }); return this.tokenFor(uid); }
  tokenFor(uid) { return `fake.${uid}.${"x".repeat(24)}`; }
  async verifyIdToken(token, checkRevoked) {
    this.calls.push({ checkRevoked: !!checkRevoked });
    if (token.startsWith("expired.")) throw Object.assign(new Error("Firebase ID token has expired."), { code: "auth/id-token-expired" });
    if (token.startsWith("revoked.")) {
      if (checkRevoked) throw Object.assign(new Error("The Firebase ID token has been revoked."), { code: "auth/id-token-revoked" });
      return { uid: "revoked-user" };
    }
    if (token.startsWith("wrongaud.")) {
      throw Object.assign(new Error('Firebase ID token has incorrect "aud" (audience) claim. Expected "tvsaccount" but got "some-other-app". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.'), { code: "auth/argument-error" });
    }
    if (token.startsWith("flaky.")) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "auth/internal-error" });
    const m = /^fake\.(.+)\.x{24}$/.exec(token);
    if (!m || !this.users.has(m[1])) throw Object.assign(new Error("Decoding Firebase ID token failed."), { code: "auth/argument-error" });
    return { ...this.users.get(m[1]) };
  }
}

const RESERVED = /^(from|notification|message_type|collapse_key|google|gcm)/i;
export class FakeMessaging {
  constructor() { this.sent = []; this.calls = 0; this.errors = new Map(); this.failEverything = null; this.transientOnce = new Set(); this.delayMs = 0; }
  /** token → fcm error code for every future send */
  failToken(token, code) { this.errors.set(token, code); }
  async sendEachForMulticast(msg) {
    this.calls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.onSend) this.onSend(msg); // lets a test move the fake clock while FCM "works"
    if (!Array.isArray(msg.tokens) || msg.tokens.length === 0 || msg.tokens.length > 500) throw Object.assign(new Error("tokens must be 1–500"), { code: "messaging/invalid-argument" });
    const data = msg.data || {};
    Object.entries(data).forEach(([k, v]) => {
      if (typeof v !== "string") throw Object.assign(new Error(`data["${k}"] must be a string`), { code: "messaging/invalid-payload" });
      if (RESERVED.test(k)) throw Object.assign(new Error(`reserved key ${k}`), { code: "messaging/invalid-payload" });
    });
    if (Buffer.byteLength(JSON.stringify(data)) > 4000) throw Object.assign(new Error("payload too large"), { code: "messaging/payload-size-limit-exceeded" });
    const h = (msg.webpush && msg.webpush.headers) || {};
    if (h.Topic !== undefined && !/^[A-Za-z0-9\-_~.%]{1,32}$/.test(h.Topic)) throw Object.assign(new Error("bad Topic header"), { code: "messaging/invalid-payload" });
    if (h.TTL !== undefined && !/^\d+$/.test(h.TTL)) throw Object.assign(new Error("bad TTL header"), { code: "messaging/invalid-payload" });
    if (this.failEverything) {
      const code = this.failEverything;
      return { successCount: 0, failureCount: msg.tokens.length, responses: msg.tokens.map(() => ({ success: false, error: Object.assign(new Error(code), { code, errorInfo: { code } }) })) };
    }
    const responses = msg.tokens.map((t) => {
      let code = this.errors.get(t);
      if (!code && this.transientOnce.has(t)) { this.transientOnce.delete(t); code = "messaging/server-unavailable"; }
      return code ? { success: false, error: Object.assign(new Error(code), { code, errorInfo: { code } }) } : { success: true, messageId: `m-${this.calls}` };
    });
    this.sent.push({ tokens: msg.tokens.filter((_, i) => responses[i].success), data: { ...data }, webpush: msg.webpush });
    const successCount = responses.filter((r) => r.success).length;
    return { successCount, failureCount: responses.length - successCount, responses };
  }
  /** every token an actual (successful) message reached, flattened */
  deliveredTokens() { return this.sent.flatMap((s) => s.tokens); }
}

export const FAKE_SA = {
  type: "service_account", project_id: "tvsaccount", private_key_id: "abc123",
  private_key: "-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-x@tvsaccount.iam.gserviceaccount.com", client_id: "1",
};
export const CRON_SECRET = "c".repeat(48);
export const SITE = "https://tvexam.vercel.app";

/** A complete, isolated backend: ctx + the three fakes + a controllable clock. */
export function makeEnv(opts = {}) {
  const clock = { t: Date.UTC(2026, 10, 5, 6, 0, 0) };
  const cfg = readConfig({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(FAKE_SA), CRON_SECRET, SITE_URL: SITE, ...(opts.env || {}) });
  const db = new FakeFirestore();
  const auth = new FakeAuth();
  const messaging = new FakeMessaging();
  const ctx = {
    cfg, db, auth, messaging, state: {}, setupError: "", logs: [],
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    serverTime: () => clock.t,
    log: (level, msg, extra) => ctx.logs.push({ level, msg, extra }),
  };
  return { ctx, clock, db, auth, messaging, cfg };
}

/* ---- seeding helpers ---- */
export function addUser(env, uid, { isAdmin = false, role, disabled = false, displayName, email, enrolledCourses } = {}) {
  env.db.seed("users", uid, { isAdmin, ...(disabled ? { disabled: true } : {}), displayName: displayName || uid, email: email || `${uid}@example.com`, ...(enrolledCourses ? { enrolledCourses } : {}) });
  if (role) env.db.seed("adminRoles", uid, { role });
  return env.auth.addUser(uid, { email: email || `${uid}@example.com`, name: displayName || uid });
}

let tokSeq = 0;
export const fakeToken = (label = "t") => `${label}_${String(++tokSeq).padStart(4, "0")}:APA91b${"Z".repeat(60)}`;
export const fakeKey = () => `dk_${String(++tokSeq).padStart(4, "0")}${"a".repeat(24)}`;
export const reqId = () => `req_${String(++tokSeq).padStart(4, "0")}${"b".repeat(20)}`;

/** a registered device straight in the database (bypasses the API) */
export function addDevice(env, uid, { token, status = "active", prefs, lastSeenAt, key } = {}) {
  const S = require("../../server/push/store.js");
  const deviceKey = key || fakeKey();
  const id = S.deviceDocId(uid, deviceKey);
  const tk = token || fakeToken(uid);
  env.db.seed("pushDevices", id, {
    uid, token: tk, status, prefs: prefs || { announcement: true, exam: true, result: true }, label: "Test device", platform: "android", browser: "chrome",
    standalone: false, createdAt: env.clock.t, updatedAt: env.clock.t, lastSeenAt: lastSeenAt ?? env.clock.t, failCount: 0,
  });
  return { id, token: tk, deviceKey };
}

/** a ready JSON request for routes.handle() */
export function call(action, { method = "POST", body, query, token, headers, origin } = {}) {
  return {
    method, action, query: query || {}, body: body === undefined ? {} : body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), host: "tvexam.vercel.app", "x-forwarded-for": "203.0.113.9", ...(headers || {}) },
  };
}
export const parse = (res) => (typeof res.body === "string" && res.body ? JSON.parse(res.body) : null);
