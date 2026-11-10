// A tiny in-memory TTL cache (the website's js/cache.js idea): a screen never re-reads what it just loaded.
interface Entry { v: unknown; until: number }
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export const get = <T>(key: string): T | undefined => {
  const e = store.get(key);
  return e && e.until > Date.now() ? (e.v as T) : undefined;
};
export const set = (key: string, v: unknown, ttlMs: number) => { store.set(key, { v, until: Date.now() + ttlMs }); };
export const del = (key: string) => { store.delete(key); inflight.delete(key); };
export const delPrefix = (prefix: string) => { for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k); };
export const clearAll = () => { store.clear(); inflight.clear(); };

/** Returns the cached value, or runs `load` once (concurrent callers share it). Failed loads are never cached. */
export async function remember<T>(key: string, ttl: number | ((v: T) => number), load: () => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
  if (!opts.force) {
    const hit = get<T>(key);
    if (hit !== undefined) return hit;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }
  const p = load().then((v) => { set(key, v, typeof ttl === "function" ? ttl(v) : ttl); return v; }).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
