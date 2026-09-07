// ==========================================================================
// firebase-config.js — same Firebase project as TVcourse (tv-course), so
// exam-site accounts, enrollment, courses and results all read/write the
// exact same Firestore data. No new Firebase project, no new rules needed.
// ==========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7Bzpu_RPI8wqIkSqjmh4aXFK_ARXC88g",
  authDomain: "tv-course.firebaseapp.com",
  projectId: "tv-course",
  storageBucket: "tv-course.firebasestorage.app",
  messagingSenderId: "394638935623",
  appId: "1:394638935623:web:af274fe9001abfa9771362",
  measurementId: "G-VF48BD7CFS",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

enableIndexedDbPersistence(db).catch(() => {});
