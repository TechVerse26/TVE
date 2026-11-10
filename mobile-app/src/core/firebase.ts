import { initializeApp } from "firebase/app";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager } from "firebase/firestore";

// The SAME Firebase project as the website (js/firebase-config.js). These web keys are public identifiers, not secrets —
// access is protected by Firebase Authentication and firestore.rules, which this app never bypasses.
export const firebaseConfig = {
  apiKey: "AIzaSyA33aia52cAM2n-W6IvuaTdBtdcy0xh-qQ",
  authDomain: "tvsaccount.firebaseapp.com",
  projectId: "tvsaccount",
  storageBucket: "tvsaccount.firebasestorage.app",
  messagingSenderId: "923190024339",
  appId: "1:923190024339:web:fede554f57feac35e91566",
};

export const app = initializeApp(firebaseConfig);
// No popup / redirect sign-in in the app (Email + Password only), so no resolver is needed.
export const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
// Offline cache like the website's enableIndexedDbPersistence, plus long-polling auto-detect for flaky mobile networks.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }),
  experimentalAutoDetectLongPolling: true,
});
