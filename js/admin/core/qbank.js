// ==========================================================================
// admin/core/qbank.js — the central question bank.
//
// Storage mirrors examBundles: questions are packed into a few ~600 KB chunk documents
// (questionBank/qb__0, qb__1 …) plus questionBank/meta {chunks, count}. Loading the whole
// bank costs 1 + (number of chunks) reads — NOT one read per question — and saving
// rewrites only those few documents in atomic batches.
//
// The bank is a LIBRARY: putting a question into an exam copies it into that exam's
// own bundle (the thing students load), so the student side is untouched.
//
//   { id, text, options[], correctIndex, explanation, subjectId, categoryId,
//     difficulty: "easy"|"medium"|"hard", tags[], source, createdAt, updatedAt }
// ==========================================================================
import { db } from "../../firebase-config.js";
import { doc, getDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import * as cache from "../../cache.js";
import { rid } from "./ui.js";

const COL = "questionBank";
const KEY = "admin:qbank";
const TTL = 10 * 60 * 1000;
const CHUNK_BYTES = 600 * 1024;
const CHUNKS_PER_BATCH = 8; // ≈ 5 MB per commit, under Firestore's request limit
export const DIFFICULTIES = ["easy", "medium", "hard"];

const bytesOf = (v) => { try { return new Blob([JSON.stringify(v)]).size; } catch { return 0; } };

export function loadBank(opts) {
  return cache.remember(KEY, TTL, async () => {
    const meta = await getDoc(doc(db, COL, "meta"));
    if (!meta.exists()) return { questions: [], chunks: 0 };
    const n = Math.max(0, Number(meta.data().chunks) || 0);
    const snaps = await Promise.all(Array.from({ length: n }, (_, i) => getDoc(doc(db, COL, `qb__${i}`))));
    const questions = snaps.flatMap((s) => (s.exists() && Array.isArray(s.data().questions) ? s.data().questions : []));
    return { questions, chunks: n };
  }, { force: cache.wantsFresh(opts) });
}

/** Cheap peek for the dashboard: the question count straight from the meta document (1 read). */
export async function bankCount() {
  const meta = await getDoc(doc(db, COL, "meta"));
  return meta.exists() ? Number(meta.data().count) || 0 : 0;
}

function pack(list) {
  const chunks = [];
  let cur = [], size = 0;
  for (const q of list) {
    const b = bytesOf(q);
    if (cur.length && size + b > CHUNK_BYTES) { chunks.push(cur); cur = []; size = 0; }
    cur.push(q); size += b;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks;
}

/** Replace the whole bank. Chunk documents first, meta last — a half-finished save never points at missing chunks. */
export async function saveBank(questions, prevChunks = 0) {
  const packs = pack(questions);
  for (let i = 0; i < packs.length; i += CHUNKS_PER_BATCH) {
    const batch = writeBatch(db);
    packs.slice(i, i + CHUNKS_PER_BATCH).forEach((qs, j) => batch.set(doc(db, COL, `qb__${i + j}`), { part: i + j, questions: qs, updatedAt: serverTimestamp() }));
    await batch.commit();
  }
  const tail = writeBatch(db);
  for (let i = packs.length; i < prevChunks; i++) tail.delete(doc(db, COL, `qb__${i}`));
  tail.set(doc(db, COL, "meta"), { chunks: packs.length, count: questions.length, updatedAt: serverTimestamp() });
  await tail.commit();
  cache.set(KEY, { questions, chunks: packs.length }, TTL);
  return packs.length;
}

/* ---------- Normalise / validate / dedupe ---------- */
export function normQuestion(q, defaults = {}) {
  const options = [];
  let correct = -1;
  (q.options || []).forEach((o, i) => {
    const t = String(o ?? "").trim();
    if (!t) return;
    if (i === q.correctIndex) correct = options.length;
    options.push(t);
  });
  const now = Date.now();
  return {
    id: q.id || rid("q_"),
    text: String(q.text || "").trim(),
    options,
    correctIndex: correct,
    explanation: String(q.explanation || "").trim(),
    subjectId: q.subjectId ?? defaults.subjectId ?? "",
    categoryId: q.categoryId ?? defaults.categoryId ?? "",
    difficulty: DIFFICULTIES.includes(q.difficulty) ? q.difficulty : (defaults.difficulty || "medium"),
    tags: (Array.isArray(q.tags) ? q.tags : String(q.tags || "").split(","))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
    source: q.source ?? defaults.source ?? "manual",
    createdAt: q.createdAt || now,
    updatedAt: now,
  };
}

export function validateQuestion(q, { minOptions = 2, maxOptions = 6, requireExplanation = false } = {}) {
  const errors = [];
  if (!q.text) errors.push("প্রশ্নের টেক্সট লিখুন");
  if (q.options.length < minOptions) errors.push(`কমপক্ষে ${minOptions}টি অপশন দিন`);
  if (q.options.length > maxOptions) errors.push(`সর্বোচ্চ ${maxOptions}টি অপশন দেওয়া যায়`);
  if (q.correctIndex < 0 || q.correctIndex >= q.options.length) errors.push("সঠিক উত্তরটি চিহ্নিত করুন");
  if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) errors.push("দুটি অপশন একই রকম");
  if (requireExplanation && !q.explanation) errors.push("ব্যাখ্যা (explanation) লিখুন");
  return errors;
}

/** Same question text + same correct answer = same question (case/space/punctuation-insensitive). */
export function qHash(q) {
  const clean = (s) => String(s || "").toLowerCase().replace(/[\s\u200c\u200d]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  const s = `${clean(q.text)}|${clean(q.options?.[q.correctIndex])}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + s.length.toString(36);
}

/* ---------- Bulk text format (identical to the exam editor's Bulk Import) ----------
   question line / *correct option / other options / Explanation: …, blocks split by a blank line */
export function parseBulk(text) {
  const questions = [], errors = [];
  String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).forEach((block, i) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const qText = lines.shift();
    const options = [];
    let correctIndex = -1, explanation = "", starred = 0;
    lines.forEach((line) => {
      const ex = line.match(/^(explanation|ব্যাখ্যা)\s*[:：]\s*(.*)$/i);
      if (ex) { explanation = ex[2].trim(); return; }
      if (line.startsWith("*")) { starred++; correctIndex = options.length; options.push(line.slice(1).trim()); } else options.push(line);
    });
    if (options.length < 2) errors.push({ n: i + 1, msg: "কমপক্ষে ২টি অপশন লাগবে", preview: qText });
    else if (starred !== 1) errors.push({ n: i + 1, msg: starred ? "একাধিক সঠিক উত্তর (*) আছে" : "সঠিক উত্তরের আগে * দিতে হবে", preview: qText });
    else questions.push({ text: qText, options, correctIndex, explanation });
  });
  return { questions, errors };
}

export function toCsvRows(list, { subjectName = () => "", categoryPath = () => "" } = {}) {
  const head = ["Question", "A", "B", "C", "D", "E", "F", "Correct", "Explanation", "Subject", "Category", "Difficulty", "Tags"];
  return [head, ...list.map((q) => [
    q.text, ...Array.from({ length: 6 }, (_, i) => q.options[i] || ""), String.fromCharCode(65 + q.correctIndex),
    q.explanation || "", subjectName(q.subjectId), categoryPath(q.categoryId), q.difficulty, (q.tags || []).join("; "),
  ])];
}
