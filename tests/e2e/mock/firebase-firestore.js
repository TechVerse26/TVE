// In-memory Firestore for end-to-end tests: documents, queries, batches, transactions, field sentinels, aggregates.
// Every read / write is logged on window.__MOCK__ so tests can assert the Firestore budget.
const M = window.__MOCK__;

export class Timestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (((ms % 1000) + 1000) % 1000) * 1e6); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return o instanceof Timestamp && o.toMillis() === this.toMillis(); }
}
class Sentinel { constructor(kind, arg) { this.kind = kind; this.arg = arg; } }
export const serverTimestamp = () => new Sentinel("ts");
export const increment = (n) => new Sentinel("inc", n);
export const deleteField = () => new Sentinel("del");
export const arrayUnion = (...v) => new Sentinel("union", v);
export const arrayRemove = (...v) => new Sentinel("remove", v);

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Sentinel) && !(v instanceof Date);
const revive = (v) => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && typeof v.__ts === "number") return Timestamp.fromMillis(v.__ts);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  }
  return v;
};
const clone = (v) => {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (Array.isArray(v)) return v.map(clone);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

if (!M.db) M.db = new Map(Object.entries(revive(M.seed || {})));
M.reads = M.reads || [];
M.writes = M.writes || [];
M.deny = M.deny || [];

// Serialise the whole database (Timestamps as {__ts}) so a test can carry it into another browser session.
const dumpValue = (v) => (v instanceof Timestamp ? { __ts: v.toMillis() } : Array.isArray(v) ? v.map(dumpValue) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dumpValue(x)])) : v);
M.dump = () => Object.fromEntries([...M.db.entries()].map(([k, v]) => [k, dumpValue(v)]));

const denied = (path) => M.deny.some((p) => path === p || path.startsWith(p + "/"));
const permissionError = () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
const segs = (parts) => parts.flatMap((p) => String(p).split("/")).filter(Boolean);
const newId = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);

export const getFirestore = () => ({ __db: true });
export const enableIndexedDbPersistence = async () => {};
export const collection = (db, ...parts) => ({ type: "col", path: segs(parts).join("/") });
export function doc(base, ...parts) {
  if (base && base.type === "col" && !parts.length) return { type: "doc", path: `${base.path}/${newId()}` };
  const p = base && base.type === "col" ? [base.path, ...parts] : parts;
  return { type: "doc", path: segs(p).join("/") };
}
const idOf = (path) => path.split("/").pop();

function resolveValue(v, existing) {
  if (v instanceof Sentinel) {
    if (v.kind === "ts") return Timestamp.now();
    if (v.kind === "inc") return (typeof existing === "number" ? existing : 0) + v.arg;
    if (v.kind === "union") { const a = Array.isArray(existing) ? existing.slice() : []; v.arg.forEach((x) => { if (!a.some((y) => JSON.stringify(y) === JSON.stringify(x))) a.push(x); }); return a; }
    if (v.kind === "remove") return (Array.isArray(existing) ? existing : []).filter((y) => !v.arg.some((x) => JSON.stringify(x) === JSON.stringify(y)));
    return undefined;
  }
  if (isPlain(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const r = resolveValue(x, existing?.[k]); if (r !== undefined) out[k] = r; }
    return out;
  }
  return clone(v);
}
function mergeInto(target, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Sentinel && v.kind === "del") { delete target[k]; continue; }
    if (isPlain(v) && isPlain(target[k])) { mergeInto(target[k], v); continue; }
    const r = resolveValue(v, target[k]);
    if (r !== undefined) target[k] = r;
  }
}
function applyUpdate(target, data) {
  for (const [key, v] of Object.entries(data)) {
    const path = key.split(".");
    let node = target;
    for (let i = 0; i < path.length - 1; i++) { if (!isPlain(node[path[i]])) node[path[i]] = {}; node = node[path[i]]; }
    const last = path[path.length - 1];
    if (v instanceof Sentinel && v.kind === "del") delete node[last];
    else node[last] = resolveValue(v, node[last]);
  }
}
const snapOf = (path, data) => ({
  id: idOf(path), ref: { type: "doc", path },
  exists: () => data !== undefined && data !== null,
  data: () => (data ? clone(data) : undefined),
  get: (f) => data?.[f],
});

function doSet(path, data, opts) {
  const existing = M.db.get(path);
  let next;
  if (opts && opts.merge) { next = existing ? clone(existing) : {}; mergeInto(next, data); }
  else if (opts && opts.mergeFields) { next = existing ? clone(existing) : {}; opts.mergeFields.forEach((f) => { const r = resolveValue(data[f], existing?.[f]); if (r === undefined) delete next[f]; else next[f] = r; }); }
  else next = resolveValue(data, undefined);
  M.db.set(path, next);
  M.writes.push({ op: "set", path });
}
function doUpdate(path, data) {
  const existing = M.db.get(path);
  if (!existing) throw Object.assign(new Error("No document to update"), { code: "not-found" });
  const next = clone(existing);
  applyUpdate(next, data);
  M.db.set(path, next);
  M.writes.push({ op: "update", path });
}
function doDelete(path) { M.db.delete(path); M.writes.push({ op: "delete", path }); }

export async function getDoc(ref) {
  if (denied(ref.path)) throw permissionError();
  M.reads.push(ref.path);
  return snapOf(ref.path, M.db.get(ref.path));
}
export async function setDoc(ref, data, opts) { if (denied(ref.path)) throw permissionError(); doSet(ref.path, data, opts); }
export async function updateDoc(ref, data) { if (denied(ref.path)) throw permissionError(); doUpdate(ref.path, data); }
export async function deleteDoc(ref) { doDelete(ref.path); }
export async function addDoc(col, data) { const path = `${col.path}/${newId()}`; doSet(path, data); return { type: "doc", path, id: idOf(path) }; }

export function writeBatch() {
  const ops = [];
  const b = {
    set: (r, d, o) => { ops.push(() => doSet(r.path, d, o)); return b; },
    update: (r, d) => { ops.push(() => doUpdate(r.path, d)); return b; },
    delete: (r) => { ops.push(() => doDelete(r.path)); return b; },
    commit: async () => { ops.forEach((f) => f()); },
  };
  return b;
}
export async function runTransaction(db, fn) {
  const tx = {
    get: async (r) => getDoc(r),
    set: (r, d, o) => { doSet(r.path, d, o); return tx; },
    update: (r, d) => { doUpdate(r.path, d); return tx; },
    delete: (r) => { doDelete(r.path); return tx; },
  };
  return fn(tx);
}

/* ---------- queries ---------- */
export const where = (field, op, value) => ({ t: "where", field, op, value });
export const orderBy = (field, dir = "asc") => ({ t: "order", field, dir });
export const limit = (n) => ({ t: "limit", n });
export const startAfter = (...v) => ({ t: "after", v });
export const query = (base, ...cons) => ({ type: "query", path: base.path, cons });

const num = (v) => (v instanceof Timestamp ? v.toMillis() : v);
const cmp = (a, b) => { a = num(a); b = num(b); return a < b ? -1 : a > b ? 1 : 0; };
const getField = (data, f) => f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data);
function matches(data, c) {
  const v = getField(data, c.field);
  switch (c.op) {
    case "==": return JSON.stringify(num(v)) === JSON.stringify(num(c.value));
    case "!=": return JSON.stringify(num(v)) !== JSON.stringify(num(c.value));
    case "<": return v !== undefined && cmp(v, c.value) < 0;
    case "<=": return v !== undefined && cmp(v, c.value) <= 0;
    case ">": return v !== undefined && cmp(v, c.value) > 0;
    case ">=": return v !== undefined && cmp(v, c.value) >= 0;
    case "in": return c.value.some((x) => JSON.stringify(num(x)) === JSON.stringify(num(v)));
    case "array-contains": return Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(c.value));
    case "array-contains-any": return Array.isArray(v) && v.some((x) => c.value.some((y) => JSON.stringify(x) === JSON.stringify(y)));
    default: return true;
  }
}
function runQuery(q) {
  const colPath = q.path;
  let rows = [...M.db.entries()]
    .filter(([p]) => p.startsWith(colPath + "/") && !p.slice(colPath.length + 1).includes("/"))
    .map(([p, data]) => ({ path: p, data }));
  const cons = q.cons || [];
  for (const c of cons.filter((x) => x.t === "where")) rows = rows.filter((r) => matches(r.data, c));
  const orders = cons.filter((x) => x.t === "order");
  if (orders.length) {
    // Firestore drops documents that lack an orderBy field.
    rows = rows.filter((r) => orders.every((o) => getField(r.data, o.field) !== undefined));
    rows.sort((a, b) => { for (const o of orders) { const d = cmp(getField(a.data, o.field), getField(b.data, o.field)); if (d) return o.dir === "desc" ? -d : d; } return 0; });
  }
  const after = cons.find((x) => x.t === "after");
  if (after && orders.length) {
    const ref = after.v[0] && after.v[0].data ? after.v[0].data() : null;
    const keyOf = (d, i) => (ref ? getField(d, orders[i].field) : after.v[i]);
    const idx = rows.findIndex((r) => orders.every((o, i) => cmp(getField(r.data, o.field), keyOf(ref || {}, i)) === 0));
    if (idx >= 0) rows = rows.slice(idx + 1);
  }
  const lim = cons.find((x) => x.t === "limit");
  if (lim) rows = rows.slice(0, lim.n);
  return rows;
}
export async function getDocs(q) {
  const path = q.path;
  if (denied(path)) throw permissionError();
  const rows = runQuery(q.type === "query" ? q : { path, cons: [] });
  rows.forEach((r) => M.reads.push(r.path));
  if (!rows.length) M.reads.push(`${path}/(empty query)`);
  const docs = rows.map((r) => snapOf(r.path, r.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
}

/* ---------- aggregates ---------- */
export const count = () => ({ k: "count" });
export const sum = (field) => ({ k: "sum", field });
export const average = (field) => ({ k: "avg", field });
export async function getAggregateFromServer(q, spec) {
  const rows = runQuery(q.type === "query" ? q : { path: q.path, cons: [] });
  M.reads.push(`agg:${q.path}`);
  const out = {};
  for (const [name, a] of Object.entries(spec)) {
    const vals = a.field ? rows.map((r) => Number(getField(r.data, a.field))).filter((n) => Number.isFinite(n)) : [];
    out[name] = a.k === "count" ? rows.length : a.k === "sum" ? vals.reduce((s, n) => s + n, 0) : vals.length ? vals.reduce((s, n) => s + n, 0) / vals.length : null;
  }
  return { data: () => out };
}
export const getCountFromServer = async (q) => ({ data: () => ({ count: runQuery(q.type === "query" ? q : { path: q.path, cons: [] }).length }) });
