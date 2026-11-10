# Signing a release APK (free)

A debug APK is enough for testing. For a release you hand to students, sign it with **your own key**. Android only installs updates signed by the same key, so keep the keystore backed up in two safe places — if you lose it you cannot update the installed app.

## 1. Create the key (once)
Needs the JDK (`keytool` comes with it):
```bash
keytool -genkeypair -v -keystore tve-release.jks -alias tve -keyalg RSA -keysize 2048 -validity 10000
```
Choose strong passwords; remember the alias (`tve`). Never put this file or the passwords in git — `.gitignore` already blocks `*.jks`, `*.keystore` and `keystore.properties`.

## 2. GitHub Actions (recommended)
Add four repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore as one line: PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("tve-release.jks"))` · Mac/Linux `base64 -w0 tve-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `tve` |
| `ANDROID_KEY_PASSWORD` | the key password |

Run **Actions → Android APK → Run workflow → release**, or push a tag `android-v1.0.0` (attaches the APK to a GitHub Release). The workflow verifies the signature with `apksigner` before uploading.

## 3. On your computer
Create `mobile-app/android/keystore.properties` (git-ignored):
```
storeFile=/full/path/to/tve-release.jks
storePassword=...
keyAlias=tve
keyPassword=...
```
Then `npm run android:release` → `dist-apk/TechVerseExam-<version>-release.apk`. Without the key the build produces an *unsigned* APK that Android refuses to install (the script warns you).
