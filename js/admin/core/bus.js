// ==========================================================================
// admin/core/bus.js — lets pages talk without importing each other.
//   emitChange("exams")  → other pages mark their data stale (re-read on next open)
//   setPending("new-exam") then go("exams") → the target page picks the action up when it opens
// ==========================================================================
const pend = new Map();
export const setPending = (key, value = true) => pend.set(key, value);
export const takePending = (key) => { const v = pend.get(key); pend.delete(key); return v; };

export const emitChange = (kind) => document.dispatchEvent(new CustomEvent("admin:changed", { detail: { kind } }));
export const onChange = (fn) => document.addEventListener("admin:changed", (e) => fn(e.detail.kind));
