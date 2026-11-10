#!/usr/bin/env node
// Builds the Android app from the web build. Works the same on your PC and in GitHub Actions.
//   node scripts/android.mjs init            create the native android/ project (first time) and apply the app's settings
//   node scripts/android.mjs sync            copy the latest web build into android/ (creates it if missing)
//   node scripts/android.mjs build debug     → dist-apk/TechVerseExam-<version>-debug.apk   (installable test build)
//   node scripts/android.mjs build release   → dist-apk/TechVerseExam-<version>-release.apk (needs your signing key, see docs)
//   node scripts/android.mjs patch           re-apply the app's settings (icons, permissions, signing, version)
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "android");
const res = join(android, "app", "src", "main", "res");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const isWin = process.platform === "win32";
const APP_ID = process.env.APP_ID || "com.techverse.exam";
const log = (m) => console.log(m);
const warn = (m) => console.warn(`⚠ ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: isWin, env: process.env, ...opts });
  if (r.error) die(`could not start "${cmd}": ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed (exit ${r.status}).`);
}
const npx = isWin ? "npx.cmd" : "npx";
const read = (f) => readFileSync(f, "utf8");
const save = (f, s) => writeFileSync(f, s);

function ensureProject() {
  if (existsSync(android)) return;
  if (!existsSync(join(root, "dist"))) die('The web build is missing. Run "npm run build" first.');
  log("▸ Creating the native Android project (npx cap add android)…");
  run(npx, ["cap", "add", "android"]);
}

function versionCode() {
  if (process.env.ANDROID_VERSION_CODE) return Number(process.env.ANDROID_VERSION_CODE);
  const [a = 0, b = 0, c = 0] = String(pkg.version).split(".").map((x) => parseInt(x, 10) || 0);
  return a * 10000 + b * 100 + c;
}

function patchManifest() {
  const f = join(android, "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(f)) return warn("AndroidManifest.xml not found — skipped manifest settings.");
  let m = read(f);
  if (m.includes("<!-- TVE -->")) return;
  const perms = ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.POST_NOTIFICATIONS"]
    .filter((p) => !m.includes(`"${p}"`)).map((p) => `    <uses-permission android:name="${p}" />`).join("\n");
  m = m.replace(/<\/manifest>/, `    <!-- TVE -->\n${perms}\n</manifest>`);
  m = m.replace('android:allowBackup="true"', 'android:allowBackup="false"'); // exam answers are kept in app storage — never restore them onto another phone
  m = m.replace(/<\/application>/, `        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="tvexam_default" />\n    </application>`);
  // tvexam://exams/<id> style links open the app
  m = m.replace(/<\/activity>/, `        <intent-filter>\n            <action android:name="android.intent.action.VIEW" />\n            <category android:name="android.intent.category.DEFAULT" />\n            <category android:name="android.intent.category.BROWSABLE" />\n            <data android:scheme="tvexam" />\n        </intent-filter>\n    </activity>`);
  save(f, m);
  log("✓ manifest: permissions, notification channel, tvexam:// links");
}

function patchGradle() {
  const f = join(android, "app", "build.gradle");
  if (!existsSync(f)) return warn("app/build.gradle not found — skipped version/signing.");
  let g = read(f);
  g = g.replace(/versionCode\s+\d+/, `versionCode ${versionCode()}`).replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  if (!g.includes("TVE-PATCH")) {
    const signing = `    // TVE-PATCH: release signing from keystore.properties or environment variables (never committed to git)
    signingConfigs {
        release {
            def props = new Properties()
            def propsFile = rootProject.file('keystore.properties')
            if (propsFile.exists()) { propsFile.withInputStream { props.load(it) } }
            def storePath = System.getenv('ANDROID_KEYSTORE_PATH') ?: props['storeFile']
            if (storePath) {
                storeFile file(storePath)
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD') ?: props['storePassword']
                keyAlias System.getenv('ANDROID_KEY_ALIAS') ?: props['keyAlias']
                keyPassword System.getenv('ANDROID_KEY_PASSWORD') ?: props['keyPassword']
            }
        }
    }
`;
    if (/buildTypes\s*\{/.test(g)) g = g.replace(/(\n\s*)buildTypes\s*\{/, `\n${signing}$1buildTypes {`);
    g = g.replace(/release\s*\{(\s*)minifyEnabled/, `release {$1if (signingConfigs.release.storeFile != null) { signingConfig signingConfigs.release }$1minifyEnabled`);
  }
  save(f, g);
  log(`✓ gradle: version ${pkg.version} (code ${versionCode()}) and release signing hook`);
}

function patchResources() {
  const src = join(root, "resources", "android", "res");
  if (!existsSync(src)) return warn("resources/android/res missing — default Capacitor icons kept.");
  cpSync(src, res, { recursive: true, force: true });
  // the template ships bitmap splash images that get stretched; our splash is a navy layer-list with the centred logo
  for (const d of readdirSync(res).filter((x) => x.startsWith("drawable"))) {
    const p = join(res, d, "splash.png");
    if (existsSync(p)) rmSync(p);
  }
  const styles = join(res, "values", "styles.xml");
  if (existsSync(styles)) {
    let s = read(styles);
    if (!s.includes("windowSplashScreenBackground") && /<style name="AppTheme\.NoActionBarLaunch"[^>]*>/.test(s)) {
      s = s.replace(/(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/, '$1\n        <item name="windowSplashScreenBackground">@color/ic_launcher_background</item>');
      save(styles, s);
    }
  }
  log("✓ icons, adaptive icon and splash");
}

function patchFirebase() {
  const dest = join(android, "app", "google-services.json");
  let text = "";
  if (process.env.GOOGLE_SERVICES_JSON) {
    const raw = process.env.GOOGLE_SERVICES_JSON.trim();
    text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  } else if (existsSync(join(root, "google-services.json"))) text = read(join(root, "google-services.json"));
  if (!text) return warn("No google-services.json — the app builds and works, but push notifications stay off (see ANDROID-FIREBASE.md).");
  try {
    const j = JSON.parse(text);
    const pkgs = (j.client || []).map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
    if (!pkgs.includes(APP_ID)) warn(`google-services.json is for ${pkgs.join(", ") || "another app"}, but this app is ${APP_ID}. Register an Android app with exactly that package name in Firebase.`);
    if (j.project_info?.project_id && j.project_info.project_id !== "tvsaccount") warn(`google-services.json belongs to Firebase project "${j.project_info.project_id}", not the website's "tvsaccount".`);
  } catch { die("google-services.json is not valid JSON."); }
  save(dest, text);
  log("✓ google-services.json installed (push notifications enabled)");
}

function patchKeystore() {
  if (!process.env.ANDROID_KEYSTORE_BASE64) return;
  const p = join(android, "release-keystore.jks");
  writeFileSync(p, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, "base64"));
  process.env.ANDROID_KEYSTORE_PATH = p;
  log("✓ signing key restored from the secret");
}

function patch() { patchManifest(); patchGradle(); patchResources(); patchFirebase(); patchKeystore(); }

function build(kind) {
  if (!["debug", "release"].includes(kind)) die('Use "build debug" or "build release".');
  if (!existsSync(android)) die('No android/ project yet. Run "npm run android:sync" first.');
  patchKeystore();
  const gradlew = join(android, isWin ? "gradlew.bat" : "gradlew");
  if (!existsSync(gradlew)) die("gradlew not found inside android/ — re-run: npm run android:init");
  if (!isWin) { try { chmodSync(gradlew, 0o755); } catch { /* ignore */ } }
  log(`▸ Gradle assemble${kind === "release" ? "Release" : "Debug"} (first run downloads Gradle and the Android libraries — a few minutes)…`);
  run(isWin ? "gradlew.bat" : "./gradlew", [kind === "release" ? "assembleRelease" : "assembleDebug", "--stacktrace"], { cwd: android });
  const dir = join(android, "app", "build", "outputs", "apk", kind);
  const apk = readdirSync(dir).find((f) => f.endsWith(".apk"));
  if (!apk) die(`Gradle finished but no APK was found in ${dir}.`);
  const unsigned = apk.includes("unsigned");
  const outDir = join(root, "dist-apk");
  mkdirSync(outDir, { recursive: true });
  const name = `TechVerseExam-${pkg.version}-${kind}${unsigned ? "-unsigned" : ""}.apk`;
  copyFileSync(join(dir, apk), join(outDir, name));
  log(`\n✓ APK ready: dist-apk/${name} (${(statSync(join(outDir, name)).size / 1048576).toFixed(1)} MB)`);
  if (unsigned) warn("This release APK is NOT signed, so Android will refuse to install it. Create a signing key first (docs/SIGNING.md) — or use the debug APK for testing.");
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "init") { ensureProject(); patch(); log("\n✓ Android project is ready. Next: npm run android:debug"); }
else if (cmd === "sync") { ensureProject(); log("▸ Copying the web build into Android (npx cap sync android)…"); run(npx, ["cap", "sync", "android"]); patch(); }
else if (cmd === "patch") { if (!existsSync(android)) die("No android/ project yet."); patch(); }
else if (cmd === "build") build(arg);
else die('Usage: node scripts/android.mjs <init | sync | patch | build debug|release>');
