// ==========================================================================
// admin/core/bank-picker.js — pick questions from the Question Bank.
// Opens ABOVE whatever is on screen (the exam editor is itself a modal), so it uses its own
// overlay instead of openModal() — which would close the editor underneath.
// ==========================================================================
import { esc, $, debounce, createTable, chip, skeleton, errorState, fmtN } from "./ui.js";
import { loadBank, qHash } from "./qbank.js";
import { loadTaxonomy, subjectName, categoryPath, subjectOptionsHtml, categoryOptionsHtml } from "./taxonomy.js";

export async function openBankPicker({ title = "Question Bank", exclude = new Set(), onPick, confirmLabel = "Add selected" }) {
  const wrap = document.createElement("div");
  wrap.className = "picker-overlay";
  wrap.innerHTML = `
    <div class="picker" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="picker-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button></header>
      <div class="toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="bp-q" placeholder="Search questions…" autocomplete="off"></div>
        <select id="bp-subject" aria-label="Subject"></select>
        <select id="bp-category" aria-label="Category"></select>
        <select id="bp-diff" aria-label="Difficulty"><option value="">Any difficulty</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
      </div>
      <div class="picker-body" id="bp-body">${skeleton(5)}</div>
      <footer class="picker-foot"><span id="bp-note" class="muted"></span><div class="row"><button type="button" class="btn btn-outline btn-sm" data-x>Cancel</button><button type="button" class="btn btn-primary btn-sm" id="bp-ok" disabled>${esc(confirmLabel)}</button></div></footer>
    </div>`;
  document.body.appendChild(wrap);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey, true); document.body.style.overflow = prevOverflow; };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-x]")) close(); });

  let bank;
  try {
    await loadTaxonomy().catch(() => {});
    bank = await loadBank();
  } catch (err) {
    $("#bp-body", wrap).innerHTML = errorState({ title: "প্রশ্নব্যাংক লোড করা যায়নি", text: "firestore.rules Publish করা আছে কিনা দেখুন।", retry: false });
    return;
  }
  const hidden = bank.questions.filter((q) => exclude.has(qHash(q))).length;
  const pool = bank.questions.filter((q) => !exclude.has(qHash(q)));
  $("#bp-subject", wrap).innerHTML = subjectOptionsHtml("", "All subjects");
  $("#bp-category", wrap).innerHTML = categoryOptionsHtml("question", "", "All categories");
  $("#bp-note", wrap).textContent = hidden ? `${fmtN(hidden)} question${hidden === 1 ? "" : "s"} already in the exam hidden` : "";
  const okBtn = $("#bp-ok", wrap);

  const body = $("#bp-body", wrap);
  body.innerHTML = "";
  const table = createTable({
    mount: body, selectable: true, pageSize: 10, sizes: [10, 25, 50],
    onSelect: (ids) => { okBtn.disabled = !ids.length; okBtn.textContent = ids.length ? `${confirmLabel} (${ids.length})` : confirmLabel; },
    empty: { icon: "fa-circle-question", title: bank.questions.length ? "কিছু পাওয়া যায়নি" : "প্রশ্নব্যাংক খালি", text: bank.questions.length ? "ফিল্টার বদলান।" : "Question Bank পেজ থেকে প্রশ্ন যোগ করুন।" },
    columns: [
      { key: "text", label: "Question", render: (q) => `<div class="cell-main"><div class="t clamp2">${esc(q.text)}</div><div class="s">${q.options.length} options · answer: ${esc(q.options[q.correctIndex] || "—")}</div></div>` },
      { key: "subject", label: "Subject", render: (q) => esc(subjectName(q.subjectId) || "—") },
      { key: "difficulty", label: "Level", render: (q) => chip(q.difficulty, q.difficulty === "hard" ? "coral" : q.difficulty === "easy" ? "teal" : "amber") },
    ],
  });
  const f = { q: "", subject: "", category: "", diff: "" };
  const apply = () => {
    const needle = f.q.trim().toLowerCase();
    table.setRows(pool.filter((q) =>
      (!f.subject || q.subjectId === f.subject) && (!f.category || q.categoryId === f.category) && (!f.diff || q.difficulty === f.diff) &&
      (!needle || `${q.text} ${q.options.join(" ")} ${(q.tags || []).join(" ")}`.toLowerCase().includes(needle))));
  };
  $("#bp-q", wrap).addEventListener("input", debounce((e) => { f.q = e.target.value; apply(); }, 150));
  $("#bp-subject", wrap).addEventListener("change", (e) => { f.subject = e.target.value; apply(); });
  $("#bp-category", wrap).addEventListener("change", (e) => { f.category = e.target.value; apply(); });
  $("#bp-diff", wrap).addEventListener("change", (e) => { f.diff = e.target.value; apply(); });
  apply();

  okBtn.addEventListener("click", () => {
    const ids = new Set(table.getSelected());
    const picked = pool.filter((q) => ids.has(String(q.id)));
    close();
    onPick?.(picked);
  });
}
