// ==========================================================================
// ai.js — thin client for the /api/ai serverless function (see api/ai.js).
//
// The Gemini API key no longer lives in the browser at all. This file only
// calls our own backend at "/api/ai" (same domain, deployed by Vercel from
// the /api folder), sending the signed-in user's Firebase ID token so the
// server can confirm the request is legitimate before spending any quota.
//
// Used by (each passes its own `kind` — see api/ai.js for what each does):
//   • admin/exams.js   → generateText("exam-questions", ...)   AI question generator
//   • page-results.js  → generateText("result-comment", ...)  personalized result note
//   • ai-doubt.js       → chatTurn("doubt-chat", ...)           "Ask AI" doubt chat
//   • admin/results.js → generateText("results-summary", ...) AI performance summary
// ==========================================================================
import { auth } from "./firebase-config.js";

async function getIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("AI ফিচার ব্যবহার করতে আগে লগইন করো");
  return user.getIdToken();
}

async function callAI(kind, contents, systemText, { temperature, maxOutputTokens } = {}) {
  const token = await getIdToken();

  let res;
  try {
    res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, contents, system: systemText, temperature, maxOutputTokens }),
    });
  } catch {
    throw new Error("সার্ভারে পৌঁছানো যাচ্ছে না — ইন্টারনেট সংযোগ চেক করো");
  }

  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body, fall through */ }

  if (!res.ok) throw new Error(data.error || `AI সার্ভিসে সমস্যা হয়েছে (${res.status})`);
  if (!data.text) throw new Error("AI থেকে কোনো উত্তর পাওয়া যায়নি");
  return data.text;
}

/** One-shot text generation. `kind` tells the server which feature is
 * calling (drives admin-only checks + rate limits) — see api/ai.js. */
export async function generateText(kind, prompt, { system, temperature, maxOutputTokens } = {}) {
  return callAI(kind, [{ role: "user", parts: [{ text: prompt }] }], system, { temperature, maxOutputTokens });
}

/** Multi-turn chat. `history` is [{role:"user"|"model", text}], oldest first. */
export async function chatTurn(kind, history, { system, temperature, maxOutputTokens } = {}) {
  const contents = history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
  return callAI(kind, contents, system, { temperature, maxOutputTokens });
}
