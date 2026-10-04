// ==========================================================================
// admin/core/taxonomy.js — subjects + (nested) categories.
//
// Both live in ONE small document, examTaxonomy/main, exactly like examIndex/main: one read
// loads everything, one write saves it. Exams and bank questions only store the ids
// (subjectId / categoryId), so renaming here renames it everywhere.
//
//   subjects:   [{ id, name, note }]
//   categories: [{ id, name, parentId|null, type: "exam" | "question" | "both" }]
// ==========================================================================
import { db } from "../../firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "../../cache.js";

const REF = ["examTaxonomy", "main"];
const KEY = "admin:taxonomy";
const TTL = 10 * 60 * 1000;
let last = { subjects: [], categories: [], ok: false, blocked: false };

export const getTaxonomy = () => last;

export async function loadTaxonomy(opts) {
  last = await cache.remember(KEY, (v) => (v.ok ? TTL : 15000), async () => {
    try {
      const snap = await getDoc(doc(db, ...REF));
      const d = snap.exists() ? snap.data() : {};
      return {
        subjects: Array.isArray(d.subjects) ? d.subjects.filter((s) => s && s.id) : [],
        categories: Array.isArray(d.categories) ? d.categories.filter((c) => c && c.id) : [],
        ok: true, blocked: false,
      };
    } catch (err) {
      return { subjects: [], categories: [], ok: false, blocked: err?.code === "permission-denied" };
    }
  }, { force: cache.wantsFresh(opts) });
  return last;
}

export async function saveTaxonomy(subjects, categories) {
  await setDoc(doc(db, ...REF), { v: 1, subjects, categories, updatedAt: serverTimestamp() });
  last = { subjects, categories, ok: true, blocked: false };
  cache.set(KEY, last, TTL);
  return last;
}

/* ---------- Lookups (synchronous, from the last loaded copy) ---------- */
export const subjectName = (id) => last.subjects.find((s) => s.id === id)?.name || "";
export const categoryOf = (id) => last.categories.find((c) => c.id === id) || null;

export function categoryPath(id) {
  const names = [];
  let node = categoryOf(id);
  for (let guard = 0; node && guard < 12; guard++) {
    names.unshift(node.name);
    node = node.parentId ? categoryOf(node.parentId) : null;
  }
  return names.join(" › ");
}

export const childrenOf = (parentId) => last.categories.filter((c) => (c.parentId || null) === (parentId || null));

/** Every descendant id of a category (used when deleting a branch). */
export function descendantIds(id) {
  const out = [];
  const walk = (pid) => childrenOf(pid).forEach((c) => { out.push(c.id); walk(c.id); });
  walk(id);
  return out;
}

/** Flat, indented list for <select>s. `type` keeps only categories usable for that purpose. */
export function categoryOptions(type = "") {
  const out = [];
  const walk = (pid, depth) => {
    childrenOf(pid)
      .slice().sort((a, b) => a.name.localeCompare(b.name, "bn"))
      .forEach((c) => {
        const usable = !type || c.type === "both" || c.type === type || !c.type;
        if (usable) out.push({ id: c.id, depth, label: `${"— ".repeat(depth)}${c.name}`, path: categoryPath(c.id) });
        walk(c.id, depth + 1);
      });
  };
  walk(null, 0);
  return out;
}

export const subjectOptions = () => last.subjects.slice().sort((a, b) => a.name.localeCompare(b.name, "bn"));

/** <option> markup helpers shared by the exam, question and filter forms. */
export function subjectOptionsHtml(selected = "", blankLabel = "— None —") {
  return `<option value="">${blankLabel}</option>` + subjectOptions().map((s) =>
    `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${s.name.replace(/</g, "&lt;")}</option>`).join("");
}
export function categoryOptionsHtml(type, selected = "", blankLabel = "— None —") {
  return `<option value="">${blankLabel}</option>` + categoryOptions(type).map((c) =>
    `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${c.label.replace(/</g, "&lt;")}</option>`).join("");
}
