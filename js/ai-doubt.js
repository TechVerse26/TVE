// ==========================================================================
// ai-doubt.js — "Ask AI" follow-up chat attached to a wrong-answer review
// item. Shared between the immediate post-submit review (exam-render.js)
// and the "আমার ফলাফল" history review (page-results.js) — both render the
// same .exs-review-item markup, so one wiring function covers both.
// ==========================================================================
import { escapeHtml } from "./utils.js";
import { chatTurn } from "./ai.js";

function detectLang(text) {
  return /[\u0980-\u09FF]/.test(text) ? "bn" : "en";
}
function systemPrompt(lang) {
  return lang === "bn"
    ? "তুমি একজন ধৈর্যশীল, বন্ধুত্বপূর্ণ শিক্ষক। শিক্ষার্থীকে তার পরীক্ষার একটা নির্দিষ্ট ভুল প্রশ্ন বুঝতে সাহায্য করছ। উত্তর সংক্ষিপ্ত, স্পষ্ট এবং বাংলায় দাও।"
    : "You are a patient, friendly tutor helping a student understand one specific exam question they got wrong. Keep answers short and clear.";
}
function questionContextText(q) {
  const optionsList = q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("\n");
  const userAns = q.selected != null ? q.options[q.selected] : "not answered";
  return `Question: ${q.text}\nOptions:\n${optionsList}\nCorrect answer: ${q.options[q.correctIndex]}\nStudent's answer: ${userAns}${q.explanation ? `\nGiven explanation: ${q.explanation}` : ""}`;
}
function bubbleHtml(role, text) {
  return `<div class="ai-doubt-msg ${role === "user" ? "is-user" : "is-ai"}">${escapeHtml(text)}</div>`;
}

function buildPanel(q) {
  const lang = detectLang(q.text);
  const panel = document.createElement("div");
  panel.className = "ai-doubt-panel";
  panel.innerHTML = `
    <div class="ai-doubt-msgs"></div>
    <form class="ai-doubt-form">
      <input type="text" class="ai-doubt-input" placeholder="${lang === "bn" ? "এই প্রশ্ন নিয়ে যা জানতে চাও লেখো..." : "Ask anything about this question..."}" required>
      <button type="submit" class="ai-doubt-send"><i class="fa-solid fa-paper-plane"></i></button>
    </form>`;

  const msgsEl = panel.querySelector(".ai-doubt-msgs");
  const context = questionContextText(q);
  const history = [];

  async function ask(userText) {
    history.push({ role: "user", text: history.length ? userText : `${context}\n\nStudent's question: ${userText}` });
    msgsEl.insertAdjacentHTML("beforeend", bubbleHtml("user", userText));
    const loadingEl = document.createElement("div");
    loadingEl.className = "ai-doubt-msg is-ai is-loading";
    loadingEl.innerHTML = `<span class="exs-spinner"></span>`;
    msgsEl.appendChild(loadingEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    try {
      const reply = await chatTurn("doubt-chat", history, { system: systemPrompt(lang), temperature: 0.6, maxOutputTokens: 512 });
      history.push({ role: "model", text: reply });
      loadingEl.remove();
      msgsEl.insertAdjacentHTML("beforeend", bubbleHtml("ai", reply));
    } catch (err) {
      loadingEl.remove();
      const fallback = lang === "bn" ? "দুঃখিত, উত্তর আনতে সমস্যা হয়েছে। আবার চেষ্টা করো।" : "Sorry, something went wrong. Try again.";
      msgsEl.insertAdjacentHTML("beforeend", bubbleHtml("ai", err?.message || fallback));
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  panel.querySelector(".ai-doubt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = panel.querySelector(".ai-doubt-input");
    const val = input.value.trim();
    if (!val) return;
    input.value = "";
    ask(val);
  });

  panel.openWithGreeting = () => ask(lang === "bn"
    ? "আমি এই প্রশ্নে ভুল করেছি — সহজভাবে বুঝিয়ে বলো কেন সঠিক উত্তরটা সঠিক, আর আমি কোথায় গুলিয়ে ফেলেছি হতে পারে।"
    : "I got this wrong — explain simply why the correct answer is right, and where my thinking likely went wrong.");
  return panel;
}

/** Scan `root` for `.exs-review-item[data-ai-q]` and attach an "Ask AI"
 * button + collapsible chat to each. Call once after review HTML lands. */
export function attachDoubtButtons(root) {
  root.querySelectorAll(".exs-review-item[data-ai-q]:not([data-ai-wired])").forEach((item) => {
    item.dataset.aiWired = "1";
    let q;
    try { q = JSON.parse(decodeURIComponent(item.dataset.aiQ)); } catch { return; }
    const lang = detectLang(q.text);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-doubt-btn";
    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${lang === "bn" ? "AI-কে জিজ্ঞেস করো" : "Ask AI"}`;
    item.appendChild(btn);

    let panel = null;
    btn.addEventListener("click", () => {
      if (!panel) {
        panel = buildPanel(q);
        item.appendChild(panel);
        panel.openWithGreeting();
        btn.classList.add("is-open");
        return;
      }
      panel.hidden = !panel.hidden;
      btn.classList.toggle("is-open", !panel.hidden);
    });
  });
}
