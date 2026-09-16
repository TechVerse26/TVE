// ==========================================================================
// api/ai.js — Vercel Serverless Function: secure server-side proxy for the
// Gemini API.
//
// WHY THIS FILE EXISTS
//   The old setup (js/ai-config.js) put the Gemini API key straight into
//   the browser bundle — anyone could open devtools and steal it. This
//   function moves the key to the server, so it never reaches the client.
//   The browser now only ever talks to "/api/ai" on your own domain.
//
// Uses the firebase-admin v14 MODULAR API (firebase-admin/app,
// firebase-admin/auth, firebase-admin/firestore) — v14 removed the old
// admin.auth()/admin.firestore() namespace entirely, and requires
// Node.js 22.12+ (it loads the ESM-only `jose` package internally).
// package.json pins "engines.node": "24.x" to stay safely above that
// floor and ahead of Vercel's Node 20 retirement — don't lower it below
// 22.x without also downgrading firebase-admin to ^13.
//
// REQUIRED VERCEL ENVIRONMENT VARIABLES
//   (Vercel Dashboard → your project → Settings → Environment Variables)
//
//   GEMINI_API_KEY
//     Your Gemini key from https://aistudio.google.com/apikey
//
//   FIREBASE_SERVICE_ACCOUNT
//     The FULL JSON of a Firebase service-account key, pasted in as-is
//     (Firebase Console → Project settings (gear icon) → Service accounts
//     → "Generate new private key" → open the downloaded .json file →
//     copy EVERYTHING inside it → paste as the value of this variable).
//     Used only to (a) verify that a request really comes from a logged-in
//     user of this app, via Firebase Auth, and (b) read users/{uid} to
//     check the isAdmin flag for admin-only AI features. It never touches
//     the browser.
//
// OPTIONAL ENVIRONMENT VARIABLES
//   GEMINI_MODEL              default: "gemini-2.5-flash"
//   AI_DAILY_LIMIT_STUDENT    default: 40   (per-student daily AI calls)
//   AI_DAILY_LIMIT_ADMIN      default: 150  (per-admin daily AI calls)
//   These exist purely as a safety net so a bug, a bot, or one very
//   curious student can't silently run up your Gemini bill. Raise,
//   lower, or effectively disable them (set a very high number) any
//   time — no code changes needed.
//
// SECURITY MODEL
//   1. Every request must carry a valid Firebase ID token
//      (Authorization: Bearer <token>) — i.e. the caller must be logged
//      into this app. Anonymous/unauthenticated requests are rejected.
//   2. Requests are tagged with a `kind` that identifies which feature is
//      calling. Admin-only kinds additionally require the caller's
//      users/{uid}.isAdmin field to be true (same flag the rest of the
//      app already uses — see utils.js requireAdmin()).
//   3. A small per-user daily counter (stored in Firestore under
//      aiUsage/{uid}_{date}, written only by this server-side code via
//      the Admin SDK) caps how many AI calls one account can make per
//      day. This needs no firestore.rules changes — Admin SDK writes are
//      not subject to security rules.
// ==========================================================================

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const DAILY_LIMIT_STUDENT = Number(process.env.AI_DAILY_LIMIT_STUDENT) || 40;
const DAILY_LIMIT_ADMIN = Number(process.env.AI_DAILY_LIMIT_ADMIN) || 150;

// Every `kind` the client is allowed to send, and which ones are admin-only.
// Keep this in sync with the `kind` strings used in js/ai.js call sites.
const ADMIN_ONLY_KINDS = new Set(["exam-questions", "results-summary"]);
const VALID_KINDS = new Set([
  "doubt-chat",       // ai-doubt.js        — student "Ask AI" chat
  "result-comment",   // page-results.js    — one-line encouragement note
  "exam-questions",   // admin/exams.js     — AI question generator (admin)
  "results-summary",  // admin/results.js   — AI performance summary (admin)
]);

// ---------------------------------------------------------------------
// Firebase Admin — initialize once per warm serverless instance
// ---------------------------------------------------------------------
function ensureFirebaseApp() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    const err = new Error("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not set");
    err.status = 500;
    throw err;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    const err = new Error("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    err.status = 500;
    throw err;
  }
  initializeApp({ credential: cert(serviceAccount) });
}

async function verifyCaller(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    const err = new Error("লগইন করা নেই — আগে লগইন করো");
    err.status = 401;
    throw err;
  }
  ensureFirebaseApp();
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch {
    const err = new Error("সেশনের মেয়াদ শেষ হয়ে গেছে — আবার লগইন করো");
    err.status = 401;
    throw err;
  }
}

async function requireAdminUid(uid) {
  const snap = await getFirestore().collection("users").doc(uid).get();
  const isAdmin = !!(snap.exists && snap.data().isAdmin);
  if (!isAdmin) {
    const err = new Error("এই ফিচারটি শুধু অ্যাডমিনদের জন্য");
    err.status = 403;
    throw err;
  }
}

// Per-user, per-day request counter. Document id embeds today's date, so
// each day starts a fresh counter automatically — nothing to reset by hand.
async function checkAndBumpQuota(uid, limit) {
  const db = getFirestore();
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("aiUsage").doc(`${uid}_${day}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data().count || 0 : 0;
    if (count >= limit) {
      const err = new Error("আজকের জন্য AI ব্যবহারের সীমা শেষ হয়ে গেছে — আগামীকাল আবার চেষ্টা করো।");
      err.status = 429;
      throw err;
    }
    tx.set(ref, { count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

// Only accept the exact shape we expect — protects Gemini quota/cost from
// malformed or oversized payloads.
function sanitizeContents(contents) {
  if (!Array.isArray(contents) || !contents.length) {
    const err = new Error("অনুরোধের ফরম্যাট সঠিক নয়");
    err.status = 400;
    throw err;
  }
  if (contents.length > 40) {
    const err = new Error("কথোপকথন অনেক লম্বা হয়ে গেছে");
    err.status = 400;
    throw err;
  }
  return contents.map((c) => {
    const role = c && c.role === "model" ? "model" : "user";
    const rawText = c && Array.isArray(c.parts) && c.parts[0] ? c.parts[0].text : "";
    const text = String(rawText || "").slice(0, 8000);
    if (!text.trim()) {
      const err = new Error("খালি বার্তা পাঠানো যাবে না");
      err.status = 400;
      throw err;
    }
    return { role, parts: [{ text }] };
  });
}

async function callGemini(contents, systemText, { temperature, maxOutputTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("Server misconfigured: GEMINI_API_KEY is not set");
    err.status = 500;
    throw err;
  }

  const body = {
    contents,
    generationConfig: {
      temperature: typeof temperature === "number" ? temperature : 0.7,
      maxOutputTokens: typeof maxOutputTokens === "number" ? maxOutputTokens : 1024,
    },
  };
  if (systemText) body.system_instruction = { parts: [{ text: String(systemText).slice(0, 4000) }] };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  let res;
  try {
    res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(e.name === "AbortError" ? "Gemini সাড়া দিতে অনেক দেরি করছে" : "Gemini-তে পৌঁছানো যায়নি");
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) {
    const err = new Error("Gemini কোনো উত্তর দেয়নি (সম্ভবত সেফটি ফিল্টারে আটকেছে)");
    err.status = 502;
    throw err;
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    const err = new Error("Gemini খালি উত্তর দিয়েছে");
    err.status = 502;
    throw err;
  }
  return text;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { contents, system, temperature, maxOutputTokens, kind } = req.body || {};

    if (!kind || !VALID_KINDS.has(kind)) {
      return res.status(400).json({ error: "অনুরোধের ধরন (kind) সঠিক নয়" });
    }

    const uid = await verifyCaller(req);

    if (ADMIN_ONLY_KINDS.has(kind)) {
      await requireAdminUid(uid);
    }

    const limit = ADMIN_ONLY_KINDS.has(kind) ? DAILY_LIMIT_ADMIN : DAILY_LIMIT_STUDENT;
    await checkAndBumpQuota(uid, limit);

    const safeContents = sanitizeContents(contents);
    const cappedMaxTokens = Math.min(Number(maxOutputTokens) || 1024, 8192);
    const text = await callGemini(safeContents, system, {
      temperature: typeof temperature === "number" ? temperature : undefined,
      maxOutputTokens: cappedMaxTokens,
    });

    return res.status(200).json({ text });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("api/ai error:", err);
    return res.status(status).json({ error: err.message || "কিছু একটা ভুল হয়েছে" });
  }
};
