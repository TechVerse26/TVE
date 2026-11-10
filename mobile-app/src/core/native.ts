import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

export const isNative = () => Capacitor.isNativePlatform();

/** Status bar colours follow the theme (light screens get dark icons). */
export async function styleStatusBar(dark: boolean) {
  if (!isNative()) return;
  try {
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: dark ? "#0B1220" : "#FFFFFF" });
  } catch { /* not supported on this device */ }
}

export async function hideSplash() { if (isNative()) { try { await SplashScreen.hide({ fadeOutDuration: 200 }); } catch { /* ignore */ } } }

export async function initNative() {
  if (!isNative()) return;
  try { await Keyboard.setAccessoryBarVisible({ isVisible: false }); } catch { /* android has none */ }
}

export async function haptic(kind: "tap" | "success" | "warning" = "tap") {
  if (!isNative()) return;
  try {
    if (kind === "tap") await Haptics.impact({ style: ImpactStyle.Light });
    else await Haptics.notification({ type: kind === "success" ? NotificationType.Success : NotificationType.Warning });
  } catch { /* ignore */ }
}
