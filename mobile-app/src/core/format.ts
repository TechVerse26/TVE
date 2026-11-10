const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov 2026, 3:30 PM" in the phone's own time zone. */
export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const h = d.getHours();
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function formatTimeOfDay(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
/** "08:24" or "1:08:24" from an hour up — the exam clock. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}
/** "12 min 5 sec" / "1 h 4 min" for result screens. */
export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60} sec`;
  return `${s} sec`;
}
export const scoreText = (n: number) => (Math.round(Number(n) * 100) / 100).toString();
export const initialsOf = (name: string) => (String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?");
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** A <datetime-local> value ("2026-11-12T15:30") ↔ epoch ms in the phone's time zone. */
export function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): number | null { if (!v) return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; }
