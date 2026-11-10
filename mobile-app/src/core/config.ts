const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;

/** The website. Its /api/push serverless API and its clock are reused by the app. */
export const SITE_URL = (env.VITE_SITE_URL || "https://tvexam.vercel.app").replace(/\/+$/, "");
export const API_BASE = `${(env.VITE_API_BASE || SITE_URL).replace(/\/+$/, "")}/api/push/`;
export const APP_VERSION = env.VITE_APP_VERSION || "1.0.0";
export const SUPPORT_EMAIL = "";
