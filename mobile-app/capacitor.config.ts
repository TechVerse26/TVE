import type { CapacitorConfig } from "@capacitor/cli";

// The Android package name must match the "Android app" you register in Firebase (see ANDROID-FIREBASE.md).
const config: CapacitorConfig = {
  appId: process.env.APP_ID || "com.techverse.exam",
  appName: "Tech Verse Exam",
  webDir: "dist",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: "#0A1B4D", showSpinner: false },
    StatusBar: { style: "DARK", backgroundColor: "#0A1B4D", overlaysWebView: false },
    Keyboard: { resize: "body", resizeOnFullScreen: true },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
