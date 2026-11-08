// ==========================================================================
// push-config.js — the ONLY setting a site owner edits for push notifications (student side + admin side).
//
//   Until `vapidKey` is filled in, push notifications are completely dormant: no extra file is downloaded, no
//   prompt is shown, no button appears. The site behaves exactly as it did before this feature existed.
//
//   vapidKey   The PUBLIC "Web Push certificate" key of your Firebase project — NOT a secret, safe in the browser:
//              Firebase Console → Project settings → Cloud Messaging → "Web configuration" → Web Push certificates
//              → Generate key pair → copy the "Key pair" text (starts with "B…", about 87 characters).
//              Free on the Spark plan. No card, no billing.
//   apiBase    "" (the normal case) = the push API lives on this same site: https://YOUR-SITE/api/push/…
//              Only if the website is hosted somewhere else, write the origin of the Vercel project that runs the API,
//              e.g. "https://tvexam-push.vercel.app". (Then also add the website's origin to PUSH_ALLOWED_ORIGINS there.)
//   enabled    A master switch: set to false to switch the whole feature off again without removing the key.
//
//   NEVER put a service-account file, a private key, CRON_SECRET or any server token in this file (or any file under js/).
//   Those live only in the server's environment variables (see doc/PUSH-NOTIFICATIONS.md).
// ==========================================================================
export const PUSH = {
  enabled: true,
  vapidKey: "",
  apiBase: "",
};

/** True only when the one-time setup has been done. Everything else in js/push/ is gated on this. */
export const pushConfigured = () => !!(PUSH.enabled && typeof PUSH.vapidKey === "string" && /^[A-Za-z0-9_-]{60,120}$/.test(PUSH.vapidKey.trim()));
