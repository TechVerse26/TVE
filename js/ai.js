// ==========================================================================
// ai.js — thin wrapper around the Gemini API (generateContent), used by:
//   • admin/exams.js              → AI question generator
//   • page-results.js             → personalized result comment
//   • ai-doubt.js                 → "Ask AI" doubt chat
//   • admin/results.js            → AI performance summary
//
// Calls Gemini directly from the browser (no backend) using a key
// restricted by HTTP referrer — see ai-config.js. This trades a bit of
// security for zero server cost; keep the key restricted.
// ==========================================================================
import { GEMINI_API_KEY, GEMINI_MODEL } from "./ai-config.js";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGemini(contents, systemText, { temperature = 0.7, maxOutputTokens = 1024 } = {}) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.startsWith("PASTE_")) {
    throw new Error("Gemini API key is not set in js/ai-config.js");
  }
  const body = { contents, generationConfig: { temperature, maxOutputTokens } };
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no answer (possibly blocked by safety filters)");
  const text = (candidate.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty answer");
  return text;
}

/** One-shot text generation. */
export async function generateText(prompt, { system, temperature, maxOutputTokens } = {}) {
  return callGemini([{ role: "user", parts: [{ text: prompt }] }], system, { temperature, maxOutputTokens });
}

/** Multi-turn chat. `history` is [{role:"user"|"model", text}], oldest first. */
export async function chatTurn(history, { system, temperature, maxOutputTokens } = {}) {
  const contents = history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
  return callGemini(contents, system, { temperature, maxOutputTokens });
}
