// ==========================================================================
// pwa-core.js — pure helpers for the install experience (no DOM writes, no side effects: unit-tested in
// tests/unit/pwa.test.mjs).
//
//   resolvePreviewImageUrl()  validates the screenshot link from pwa-config.js
//   isStandaloneDisplay()     "is this window the installed app?"
//   detectPlatform()          which OS / browser family the visitor is on
//   getInstallGuide()         the browser-specific steps shown when no native install prompt exists
//
// Steps use **double asterisks** for emphasis; pwa-install.js turns them into <strong> without innerHTML.
// ==========================================================================

/* ---------- screenshot link ---------- */

/**
 * Returns the link exactly as written in pwa-config.js when it is usable, otherwise null
 * (empty, still the PASTE_… placeholder, or not an http(s) / site-relative / data:image link).
 */
export function resolvePreviewImageUrl(raw, base = "https://placeholder.invalid/") {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || /^PASTE_/i.test(value)) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol === "https:" || u.protocol === "http:") return value;
    if (u.protocol === "data:" && /^data:image\//i.test(value)) return value;
  } catch { /* not a URL */ }
  return null;
}

/* ---------- installed-app (standalone) detection ---------- */

/**
 * True when the page runs as the installed app: display-mode standalone / minimal-ui / window-controls-overlay,
 * iOS "Add to Home Screen" (navigator.standalone), or an Android trusted-web-activity launch.
 * Browser fullscreen (F11, video) is deliberately NOT counted.
 */
export function isStandaloneDisplay(win = globalThis.window) {
  if (!win) return false;
  const matches = (q) => { try { return !!win.matchMedia?.(q).matches; } catch { return false; } };
  return (
    matches("(display-mode: standalone)") ||
    matches("(display-mode: minimal-ui)") ||
    matches("(display-mode: window-controls-overlay)") ||
    win.navigator?.standalone === true ||
    String(win.document?.referrer || "").startsWith("android-app://")
  );
}

/* ---------- platform ---------- */

export function detectPlatform({ ua = "", platform = "", maxTouchPoints = 0 } = {}) {
  const isIPadOS = platform === "MacIntel" && maxTouchPoints > 1;           // iPadOS Safari reports a Mac UA
  const isIOS = /iPad|iPhone|iPod/.test(ua) || isIPadOS;
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid;
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Snapchat|TikTok|musical_ly|Twitter|MicroMessenger|Messenger|GSA\//i.test(ua) ||
    (isAndroid && /; wv\)/.test(ua));                                       // social-app / WebView browsers cannot install

  let browser = "other";
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = "edge";
  else if (/OPR\/|OPiOS|Opera/.test(ua)) browser = "opera";
  else if (/SamsungBrowser/.test(ua)) browser = "samsung";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "firefox";
  else if (/CriOS|Chrome\/|Chromium\//.test(ua)) browser = "chrome";        // Brave, Vivaldi, Arc … present as Chrome
  else if (/Safari\//.test(ua) || (isIOS && /AppleWebKit/.test(ua))) browser = "safari";

  return { isIOS, isAndroid, isMobile, isDesktop: !isMobile, inApp, browser };
}

/* ---------- manual install steps ---------- */

export function getInstallGuide(p) {
  if (p.isIOS) {
    if (p.inApp) {
      return {
        title: "Open in Safari first",
        steps: [
          "Tap the **•••** or **Share** button and choose **Open in Safari**",
          "In Safari, tap the **Share** button",
          "Choose **Add to Home Screen**, then tap **Add**",
        ],
      };
    }
    if (p.browser === "safari") {
      return {
        title: "Add to your Home Screen",
        steps: [
          "Tap the **Share** button (the square with an arrow) in Safari",
          "Scroll down and tap **Add to Home Screen**",
          "Tap **Add** — Tech Verse Exam appears on your Home Screen",
        ],
      };
    }
    return {
      title: "Add to your Home Screen",
      steps: [
        "Tap the **Share** button in your browser's address bar or menu",
        "Choose **Add to Home Screen**, then tap **Add**",
      ],
      note: "Needs iOS 16.4 or later. If you don't see it, open this page in Safari instead.",
    };
  }

  if (p.isAndroid) {
    if (p.inApp) {
      return {
        title: "Open in Chrome first",
        steps: [
          "Tap the **⋮** menu and choose **Open in browser** (or **Open in Chrome**)",
          "In Chrome, open the **⋮** menu and tap **Install app**",
        ],
      };
    }
    if (p.browser === "samsung") {
      return {
        title: "Add from the browser menu",
        steps: ["Tap the **menu** button (☰)", "Choose **Add page to**, then **Home screen**", "Tap **Add** to confirm"],
      };
    }
    if (p.browser === "firefox") {
      return { title: "Install from the browser menu", steps: ["Tap the **⋮** menu", "Tap **Install**", "Tap **Add** to confirm"] };
    }
    if (p.browser === "edge") {
      return { title: "Install from the browser menu", steps: ["Tap the **•••** menu", "Tap **Add to phone**", "Tap **Add** to confirm"] };
    }
    if (p.browser === "chrome") {
      return {
        title: "Install from the browser menu",
        steps: ["Tap the **⋮** menu at the top right", "Tap **Install app** (or **Add to Home screen**)", "Tap **Install** to confirm"],
      };
    }
    return {
      title: "Install from the browser menu",
      steps: ["Open your browser's **menu**", "Look for **Install app** or **Add to Home screen**", "Confirm when asked"],
    };
  }

  // desktop
  if (p.browser === "chrome") {
    return {
      title: "Install from the browser",
      steps: [
        "Click the **Install** icon at the right end of the address bar",
        "Or open the **⋮** menu → **Cast, save, and share** → **Install page as app…**",
        "Click **Install** to confirm",
      ],
    };
  }
  if (p.browser === "edge") {
    return {
      title: "Install from the browser",
      steps: [
        "Click the **App available** icon at the right end of the address bar",
        "Or open the **⋯** menu → **Apps** → **Install this site as an app**",
        "Click **Install** to confirm",
      ],
    };
  }
  if (p.browser === "safari") {
    return {
      title: "Add to your Dock",
      steps: ["Open Safari's **File** menu (or click **Share**)", "Choose **Add to Dock…**", "Click **Add**"],
      note: "Needs macOS Sonoma (14) or later.",
    };
  }
  if (p.browser === "firefox") {
    return {
      title: "Not available in Firefox",
      steps: ["Open this page in **Chrome** or **Edge** to install it as an app"],
      note: "Firefox for desktop doesn't offer installing websites as apps.",
    };
  }
  return {
    title: "Install from the browser",
    steps: ["Open your browser's **menu**", "Look for **Install app** or **Add to Home screen**", "Confirm when asked"],
  };
}
