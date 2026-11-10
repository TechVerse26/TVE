import { CapacitorHttp } from "@capacitor/core";
import { auth } from "./firebase";
import { API_BASE } from "./config";

export class ApiError extends Error {
  code: string; status: number; extra: Record<string, unknown>;
  constructor(code: string, message = "", status = 0, extra: Record<string, unknown> = {}) { super(message || code); this.name = "ApiError"; this.code = code; this.status = status; this.extra = extra; }
}

/** POST to the website's /api/push/<action> with the signed-in user's Firebase ID token (the server re-checks the role on every call).
 *  CapacitorHttp is the native HTTP client, so the website's browser-origin CORS list does not get in the way. */
export async function apiPost<T = any>(action: string, body: unknown = {}, { timeoutMs = 20_000 } = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError("unauthenticated", "Not signed in", 401);
  let token: string;
  try { token = await user.getIdToken(); } catch { throw new ApiError("unauthenticated", "Could not get a session token", 401); }
  try {
    const res = await CapacitorHttp.post({
      url: API_BASE + action, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      data: body ?? {}, connectTimeout: timeoutMs, readTimeout: timeoutMs,
    });
    let data: any = res.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
    if (res.status < 200 || res.status >= 300 || !data || data.ok !== true) {
      const e = (data && data.error) || {};
      throw new ApiError(e.code || `http_${res.status}`, e.message || "", res.status, e);
    }
    return data as T;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("network", String(e?.message || ""), 0);
  }
}
