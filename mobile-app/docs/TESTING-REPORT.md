# Testing report (honest)

## Update 2026-11-26 — first real GitHub Actions run, and what was fixed
* **Why run #7 failed:** the step `android-actions/setup-android@v3` asks `sdkmanager` to install the legacy package `tools` by default. Google has removed that package, so the step failed before the build started. (The action's own fix, v4.0.2, only changes that default.) The workflow no longer uses that action: GitHub's Ubuntu runner already contains the Android SDK, so the workflow just accepts the SDK licences and lets Gradle fetch anything missing.
* **A second bug, found before it could bite:** the "Validate the APK" step used `unzip -l | grep -q` under `set -o pipefail`. With a large APK `grep -q` closes the pipe early, `unzip` dies with SIGPIPE and the step reports a false "classes.dex is missing" (reproduced 200 / 200 times with a 3 000-entry APK). It now reads the file list once and searches that.
* **Now executed for real** (Node 22, npm 10, Capacitor 7.6.11): `npm install` · `npm test` **19 / 19** · `tsc --noEmit` **0 errors** · `vite build` OK · `node scripts/android.mjs sync` creates the Android project and every patch applies to the real template (manifest, version code and name, release-signing hook, icons, splash); all generated XML is well-formed.
* **Website tests:** the 3 tests listed below now check the real configuration instead of the placeholder; `npm test` → **476 / 476 pass**, `npm run check` → 142 modules parse (two empty 1-byte leftovers, `api/push/H` and `js/admin/push/mode.js`, were deleted).
* **Added:** `package-lock.json` (reproducible `npm ci`), a fixed public test key for debug builds (see [SIGNING.md](SIGNING.md)), and a download link on the Releases page after every build.
* **Still not executed:** the Gradle build itself (it needs Google's and Maven's servers, which were not reachable from the sandbox) and anything on a physical phone. The next GitHub Actions run is the first real Gradle build of this app.

---

Built and checked in a sandbox with **no internet access**. That decides what could and could not be run.

## Executed — and the real results
| # | Check | Result |
| --- | --- | --- |
| 1 | Website baseline before any change: `npm test`, `npm run check` | 473 tests: 470 pass, **3 fail (already failing in the uploaded project)**, 143 modules parse |
| 2 | Website after my change (`server/push/engine.js` Android block + 3 new tests) | 476 tests: 473 pass, the **same 3** fail, 143 modules parse. Nothing regressed |
| 3 | App rules + parity tests (`mobile-app: npm test`) | **19 / 19 pass**: exam engine compared with the website's own `js/exam-engine.js` (300 random scoring rounds, 25 shuffle cases with identical random numbers), result/attempt caps and 48 h review expiry, `userStats` entries, schedule status rules, start-eligibility order, saved-attempt deadline / resume / expiry / tamper detection, save retry, admin role map, push-link mapping, Help/FAQ/Privacy/Terms conversion |
| 4 | Shared website modules identical to `../js` | 17 / 17 identical (`npm run check:shared`) |
| 5 | Browser smoke test: the **real app code** in Chromium with the website's own in-memory Firebase test doubles (`npm run test:e2e`) | **43 / 43 pass** (details below) |
| 6 | Type check of all app code against offline stubs (React typed, other libraries `any`) | 0 errors; a deliberate error was caught, so the check is live |
| 7 | esbuild bundle of the whole app (all relative imports and named exports resolve) | OK, 36 chunks |
| 8 | `scripts/android.mjs patch` on a Capacitor-style template, run twice | manifest permissions / channel / `tvexam://`, `allowBackup=false`, version, signing hook, icons, splash all applied; second run changes nothing |
| 9 | GitHub workflow YAML parsed; existing `push-scheduler.yml` byte-identical to the original | OK |

Browser smoke test coverage (phone 390×820, tablet 1024×768): signed-out redirect, email-only sign-in, Firebase password-reset request (Bengali mail, returns to website login, Google-only note), sign-up validation, public Privacy page; student Home / Exams / detail, eligibility checks, rules screen, timer, answer locking, autosave, submit, scoring (1 correct, 1 wrong with −0.5, 1 skipped = 17 %), result document / attempt / review snapshot / `userStats` written in the website's shape, saved copy removed, Results list, attempt history + review, attempt counter and retake, resume after a reload and from Home, student blocked from `/admin`, tablet navigation rail; admin dashboard aggregates, exam list, creating an exam with a question → `exams`, `examBundles`, refreshed `examIndex`, `adminLogs`.
The smoke test caught one real bug (relative asset base broke a reload on a nested route); it is fixed (`base: "/"`).

The 3 website tests that were failing (not caused by this work): *"dormant by default: nothing runs until the VAPID key is pasted"*, *"pwa-config.js exposes the documented settings and ships with the placeholder"*, *"manifest.webmanifest is valid, complete and every file it references exists with the right size"* — they expected placeholder configuration that has since been filled in with real values. **Fixed on 2026-11-26:** they now accept either the placeholder or a well-formed real value (VAPID key, screenshot link, short name).

## NOT executed — please treat these as unverified
* `npm install`, the real TypeScript check with the real React / Ionic / Firebase / Capacitor type packages, `vite build`.
* **Gradle / APK build, Android Studio, any device or emulator.** No APK is included in this ZIP. The first GitHub Actions run is the first real build. If it fails, the most likely causes are a dependency version or a type mismatch — open the failed step in the log; the type check step is non-blocking, the build itself is not.
* On-device behaviour: Back button, keyboard, status bar, splash, safe areas, WebView quirks, push delivery, `tvexam://` links.
* Real Firebase (Auth, Firestore rules, FCM). The smoke test used the website's test doubles, and Ionic / router were replaced by small stand-ins, so real Ionic rendering and transitions are unchecked.
* Google-only account → *Forgot password* → password added to the same UID is standard Firebase behaviour but was not exercised against your project.
* Performance on low-end phones, dark-mode visuals, screen-reader (TalkBack) review, an accessibility audit.

## Manual checklist for the first real phone
1. Install the debug APK; sign in with an existing website student — same name, roll, results.
2. Start a practice exam, answer one, swipe the app away, reopen: Home shows **Resume**.
3. Let a live exam run out of time in the background: result is saved automatically on return.
4. Switch off data during submit: result shows *Not saved yet*; switch on, tap Retry.
5. Admin account: create an exam in the app → see it on the website; publish on the website → see it in the app.
6. Settings → turn on notifications → send a test from Admin → Push; close the app; tap the notification.
7. Rotate / use a tablet; try dark mode; Android Back inside the exam (confirm dialog).
