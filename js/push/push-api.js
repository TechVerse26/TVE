// ==========================================================================
// push-api.js — the one place the browser talks to the push server (/api/push/<action>).
// Used by the student side AND the admin Push Notification center.
//
//   • Every call carries the signed-in user's Firebase ID token ("Authorization: Bearer …"). The SERVER verifies it and,
//     for admin actions, re-checks the admin role itself — nothing here is trusted.
//   • No cookies, no secrets. Timeouts, offline detection and ONE automatic retry with a fresh token.
// ==========================================================================
import { auth } from "../firebase-config.js";
import { PUSH } from "./push-config.js";

export class PushApiError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message || code);
    this.name = "PushApiError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** Where the API lives: this site's own /api/push/ (the normal case) or the configured Vercel project. */
export function apiBase() {
  const b = String(PUSH.apiBase || "").trim().replace(/\/+$/, "");
  return b ? `${b}/api/push/` : new URL("api/push/", document.baseURI).href;
}

async function once(action, body, { timeoutMs, forceToken }) {
  const user = auth.currentUser;
  if (!user) throw new PushApiError("unauthenticated", "Not signed in", 401);
  let token;
  try { token = await user.getIdToken(!!forceToken); } catch { throw new PushApiError("unauthenticated", "Could not get a session token", 401); }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(apiBase() + action, {
      method: "POST", cache: "no-store", credentials: "omit", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON (a 404 page, a proxy error …) */ }
    if (!res.ok || !data || data.ok !== true) {
      const e = (data && data.error) || {};
      throw new PushApiError(e.code || `http_${res.status}`, e.message || "", res.status, e);
    }
    return data;
  } catch (e) {
    if (e instanceof PushApiError) throw e;
    throw new PushApiError(e && e.name === "AbortError" ? "timeout" : "network", String((e && e.message) || ""), 0);
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/push/<action> with a JSON body → the parsed `{ ok: true, … }`; throws PushApiError otherwise. */
export async function api(action, body, { timeoutMs = 20000 } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new PushApiError("network", "offline", 0);
  try {
    return await once(action, body, { timeoutMs, forceToken: false });
  } catch (e) {
    if (e instanceof PushApiError && e.status === 401 && (e.code === "token_expired" || e.code === "invalid_token")) {
      return once(action, body, { timeoutMs, forceToken: true });      // the token was stale: one retry with a fresh one
    }
    throw e;
  }
}
