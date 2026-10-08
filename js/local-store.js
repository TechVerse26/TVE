// ==========================================================================
// local-store.js — tiny, failure-proof wrapper around localStorage for per-student, per-device
// preferences (reminders, read/dismissed notifications). Nothing here ever touches Firestore:
// these are conveniences, not records, so they cost zero reads and zero writes.
// If storage is blocked (private mode, full quota) everything silently falls back to memory.
// ==========================================================================
const memory = new Map();

export function lsGet(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return JSON.parse(raw);
  } catch { /* blocked or corrupt → fall through to memory */ }
  return memory.has(key) ? memory.get(key) : fallback;
}

export function lsSet(key, value) {
  memory.set(key, value);
  try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function lsRemove(key) {
  memory.delete(key);
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}
