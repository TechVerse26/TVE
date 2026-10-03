// ==========================================================================
// cache.js — tiny in-memory TTL cache with in-flight request sharing.
//
// Why it exists: every Firestore document read is billed (Spark plan: 50,000
// reads/day). Before this file existed the same data — the exam list, the
// signed-in user's profile, a student's results — was fetched again on
// every screen. Now each piece of data is fetched once, kept in memory for
// a short time, and if two parts of the page ask for it at the same moment
// they share ONE request instead of firing two.
//
// Memory only, on purpose: a page reload always starts fresh, so nobody can
// be stuck on stale data, and there is nothing to migrate or clean up.
// ==========================================================================

const store = new Map();     // key -> { v, exp }
const inflight = new Map();  // key -> Promise
const gens = new Map();      // key -> number (bumped by del(); guards against stale in-flight writes)

const now = () => Date.now();

/** Cached value, or `undefined` when missing / expired. (`null` is a real, cacheable value.) */
export function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp <= now()) { store.delete(key); return undefined; }
  return e.v;
}

export function set(key, value, ttlMs) {
  store.set(key, { v: value, exp: now() + ttlMs });
  return value;
}

/** Forget one key (also invalidates any request that is still on its way). */
export function del(key) {
  store.delete(key);
  inflight.delete(key);
  gens.set(key, (gens.get(key) || 0) + 1);
}

export function delPrefix(prefix) {
  for (const k of Array.from(store.keys())) if (k.startsWith(prefix)) del(k);
  for (const k of Array.from(inflight.keys())) if (k.startsWith(prefix)) del(k);
}

export function clearAll() {
  for (const k of Array.from(store.keys())) del(k);
  for (const k of Array.from(inflight.keys())) del(k);
}

/**
 * Return the cached value for `key`; otherwise run `loader()` once (even if many
 * callers ask meanwhile), cache what it returns for `ttl` ms and hand it back.
 * `ttl` may be a number or a function of the loaded value (to cache "not found" briefly).
 * Errors are never cached. `force: true` skips the cache and refreshes it.
 */
export function remember(key, ttl, loader, { force = false } = {}) {
  if (!force) {
    const hit = get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const gen = gens.get(key) || 0;
  const p = (async () => {
    try {
      const value = await loader();
      if (value !== undefined && (gens.get(key) || 0) === gen) {
        set(key, value, typeof ttl === "function" ? ttl(value) : ttl);
      }
      return value;
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Lets the existing "Refresh" buttons keep working unchanged: they pass the click
 * Event to the loader, which means "yes, really re-read from the server".
 * Also accepts `{ force: true }`.
 */
export function wantsFresh(arg) {
  return !!arg && (arg.force === true || typeof arg.preventDefault === "function");
}
