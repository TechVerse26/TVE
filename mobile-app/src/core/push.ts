// Native push (Firebase Cloud Messaging) for the Android app. The website's push API stores the device and sends the
// messages; this file only obtains the FCM token on the phone and registers it with that same API
// (POST /api/push/subscribe — platform "android"), so web and app notifications live side by side.
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { apiPost } from "./api";
import { routeFromSiteUrl } from "./links";

const KEY_DEVICE = "tve:deviceKey";
const KEY_TOKEN = "tve:pushToken";
const KEY_ON = "tve:pushOn";
export const CHANNEL_ID = "tvexam_default";

export type PushState = "unsupported" | "off" | "on" | "denied" | "unconfigured";
let listenersReady = false;
let openHandler: ((route: string) => void) | null = null;
let foregroundHandler: ((n: { title: string; body: string }) => void) | null = null;

const ls = () => { try { return localStorage; } catch { return null; } };
function deviceKey(): string {
  let k = ls()?.getItem(KEY_DEVICE) || "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(k)) {
    const bytes = new Uint8Array(24);
    (globalThis.crypto || ({} as Crypto)).getRandomValues?.(bytes);
    k = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 40) || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    k = k.replace(/[^A-Za-z0-9_-]/g, "x").padEnd(16, "x");
    ls()?.setItem(KEY_DEVICE, k);
  }
  return k;
}

export const isPushSupported = () => Capacitor.isNativePlatform();
export function pushState(): PushState { return !isPushSupported() ? "unsupported" : ls()?.getItem(KEY_ON) === "1" ? "on" : "off"; }
export function onNotificationOpen(fn: (route: string) => void) { openHandler = fn; }
/** A push that arrives while the app is open is shown as a small in-app banner (the system tray stays quiet for foreground apps). */
export function onForegroundPush(fn: (n: { title: string; body: string }) => void) { foregroundHandler = fn; }

async function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;
  await PushNotifications.addListener("registration", async (t) => {
    try {
      const previous = ls()?.getItem(KEY_TOKEN) || "";
      await apiPost("subscribe", { token: t.value, deviceKey: deviceKey(), platform: "android", browser: "other", standalone: true, label: "Tech Verse Exam app", ...(previous && previous !== t.value ? { previousToken: previous } : {}) });
      ls()?.setItem(KEY_TOKEN, t.value);
      ls()?.setItem(KEY_ON, "1");
    } catch { /* retried on the next app start */ }
  });
  await PushNotifications.addListener("registrationError", () => { ls()?.removeItem(KEY_ON); });
  await PushNotifications.addListener("pushNotificationReceived", (n) => { foregroundHandler?.({ title: String(n.title || ""), body: String(n.body || "") }); });
  await PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
    const data = (a.notification?.data || {}) as Record<string, string>;
    openHandler?.(routeFromSiteUrl(data.url));
  });
  try { await PushNotifications.createChannel({ id: CHANNEL_ID, name: "Tech Verse Exam", description: "Exam, result and notice alerts", importance: 4, visibility: 1 }); } catch { /* channel is optional */ }
}

/** Ask for permission (Android 13+) and register this phone. */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  try {
    await ensureListeners();
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return "denied";
    await PushNotifications.register();
    ls()?.setItem(KEY_ON, "1");
    return "on";
  } catch {
    // Most likely google-services.json was not added to this build (see ANDROID-FIREBASE.md).
    return "unconfigured";
  }
}

/** Silent refresh at app start for a student who already turned push on. */
export async function resumePush() { if (pushState() === "on") await enablePush(); }

export async function disablePushOnThisDevice() {
  if (!isPushSupported()) return;
  try { await apiPost("unsubscribe", { deviceKey: deviceKey() }); } catch { /* dead tokens are dropped by the server */ }
  ls()?.removeItem(KEY_ON);
  ls()?.removeItem(KEY_TOKEN);
  try { await PushNotifications.removeAllListeners(); listenersReady = false; } catch { /* ignore */ }
}
