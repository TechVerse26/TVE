# Android + Firebase setup (≈ 10 minutes, free)

The app uses the **same Firebase project as the website (`tvsaccount`)**. Email/password sign-in, Firestore and the admin roles work immediately. Only **push notifications** need the extra file below.

## 1. Register the Android app
1. Firebase console → project **tvsaccount** → ⚙ **Project settings** → **Your apps** → **Add app** → **Android**.
2. Android package name: `com.techverse.exam` (must match exactly). Nickname: Tech Verse Exam. Skip the SHA-1 (not needed for push).
3. **Download `google-services.json`**. Do not edit it.

## 2. Give the file to the build
* **GitHub Actions:** convert the file to one line and store it as a repository secret.
  * Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))`
  * Mac/Linux: `base64 -w0 google-services.json`
  * GitHub → Settings → Secrets and variables → Actions → **New repository secret** → name `GOOGLE_SERVICES_JSON`, value = that line.
* **Local build:** save the file as `mobile-app/google-services.json` (it is git-ignored). `npm run android:debug` copies it into `android/app/`.

The build prints `✓ google-services.json installed` when it is picked up, and a warning if the package name or project does not match. Never commit this file.

## 3. Redeploy the website API once
`server/push/engine.js` now adds an `android` block to push messages (native phones need it to show a notification while the app is closed; web browsers ignore it). Deploy the repository to Vercel as usual. Nothing else changes: the same `/api/push/*` endpoints, the same Admin SDK secrets.

## 4. Check the web API key (only if you restricted it)
Google Cloud Console → APIs & Services → Credentials → the key named *Browser key* / used in `js/firebase-config.js`. If "HTTP referrers" are restricted to your website domains, **add `https://localhost/*`** (this is the app's origin inside Android). Without it, sign-in inside the app shows a network error.

## 5. Test
Install the APK → Profile → Settings → **Turn on notifications** (allow the Android 13+ prompt) → on the website, Admin → Push → send yourself a test. The same message arrives in browsers and in the app. Tapping it opens the matching screen.

## Not needed / not done
No billing, no Cloud Functions, no extra Firebase project, no Google Sign-In (the app is email + password only). Existing Google-only students: *Forgot password* sends Firebase's reset mail; completing it adds a password to their **existing** account, keeping the original UID, profile, results and roll number. (Verify once with a test Google account before announcing it.)
