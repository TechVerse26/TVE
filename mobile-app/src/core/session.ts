// Saved-attempt storage for the exam player. The rules (deadline, resume / expired / unsaved verdicts, integrity
// signature) are the website's own js/exam-session-core.js; this file only reads and writes localStorage.
import { Session as S } from "./shared";

const ls = (): Storage | null => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };

export type SavedSession = any;
export interface SessionVerdict { state: "resume" | "expired" | "unsaved" | "stale"; left: number; answered: number; total: number }

export function loadSession(uid: string, examId: string): SavedSession | null {
  const raw = ls()?.getItem(S.sessionKey(uid, examId));
  if (!raw) return null;
  const parsed = S.parseSession(raw, { uid, examId });
  if (!parsed.ok) { if (parsed.reason !== "owner") removeSession(uid, examId); return null; }
  return parsed.session;
}

export function saveSession(session: SavedSession): boolean {
  const text = S.serializeSession(session);
  if (!text) return false;
  try { ls()?.setItem(S.sessionKey(session.uid, session.examId), text); return true; } catch { return false; }
}

export function removeSession(uid: string, examId: string) { try { ls()?.removeItem(S.sessionKey(uid, examId)); } catch { /* ignore */ } }

/** Every saved attempt of this student with the verdict at `now` (stale ones are deleted on the way). */
export function listSessions(uid: string, now: number): { session: SavedSession; verdict: SessionVerdict }[] {
  const store = ls();
  if (!store) return [];
  const prefix = `${S.KEY_PREFIX}${uid}:`;
  const out: { session: SavedSession; verdict: SessionVerdict }[] = [];
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const parsed = S.parseSession(store.getItem(key), { uid });
    if (!parsed.ok) { store.removeItem(key); continue; }
    const verdict = S.judge(parsed.session, now) as SessionVerdict;
    if (verdict.state === "stale") { store.removeItem(key); continue; }
    out.push({ session: parsed.session, verdict });
  }
  return out;
}

export function clearAllSessions() {
  const store = ls();
  if (!store) return;
  for (let i = store.length - 1; i >= 0; i--) { const k = store.key(i); if (k && k.startsWith(S.KEY_PREFIX)) store.removeItem(k); }
}
