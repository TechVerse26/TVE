// ==========================================================================
// firebase-config.js — same Firebase project as TVcourse
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA33aia52cAM2n-W6IvuaTdBtdcy0xh-qQ",
  authDomain: "tvsaccount.firebaseapp.com",
  projectId: "tvsaccount",
  storageBucket: "tvsaccount.firebasestorage.app",
  messagingSenderId: "923190024339",
  appId: "1:923190024339:web:fede554f57feac35e91566",
  measurementId: "G-GXJR3YEBMS"
};
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

enableIndexedDbPersistence(db).catch(() => {});
