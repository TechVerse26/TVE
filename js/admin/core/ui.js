// ==========================================================================
// admin/core/ui.js — small, dependency-free UI toolkit shared by every admin page:
// formatters, status chips, a sortable/paginated/selectable table, a side drawer,
// typed-confirmation dialogs and the loading / empty / error states.
// ==========================================================================
import { escapeHtml, openModal, closeModal } from "../../utils.js";
import { getSettings } from "./settings.js";

export const esc = escapeHtml;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function debounce(fn, wait = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/* ---------- Formatting ---------- */
const NF = new Intl.NumberFormat("en-US");
export const fmtN = (n) => NF.format(Math.round(Number(n) || 0));
export function fmtPct(n, digits = 0) {
  const v = Number(n) || 0;
  return `${(Math.abs(v) < 0.005 ? 0 : v).toFixed(digits)}%`;
}
export function fmtDur(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s <= 0) return "—";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}
export function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const toMs = (v) => toDate(v)?.getTime() || 0;
export function fmtDate(v) {
  const d = toDate(v);
  return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}
export function fmtDateTime(v) {
  const d = toDate(v);
  return d ? d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}
export function ago(v) {
  const d = toDate(v);
  if (!d) return "—";
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return fmtDate(d).replace(/ /g, "\u00A0"); // keep "04 Sep 2026" on one line
}
/** Timestamp | Date | ms → the "YYYY-MM-DDTHH:MM" string a <input type="datetime-local"> wants (viewer's local time). */
export function toLocalInput(v) {
  const d = toDate(v);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The reverse: "" → null, otherwise a Date in the viewer's local time. */
export function fromLocalInput(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const rid = (prefix = "") => prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 1) : parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}
const AVATAR_COLORS = ["#6C5CE7", "#1F9E8C", "#D0524A", "#C98A2B", "#3E7BD6", "#A8489A"];
export function avatar(name, size = 34) {
  let h = 0;
  for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="av" style="--av:${AVATAR_COLORS[h % AVATAR_COLORS.length]};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(initials(name))}</span>`;
}

/* ---------- Small building blocks ---------- */
export const chip = (text, tone = "", icon = "") =>
  `<span class="chip ${tone}">${icon ? `<i class="fa-solid ${icon}"></i>` : ""}${esc(text)}</span>`;
export const dotStatus = (text, tone = "") => `<span class="dot-status ${tone}"><i></i>${esc(text)}</span>`;

export function pageHead({ title, desc = "", actions = "" }) {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${desc ? `<p>${esc(desc)}</p>` : ""}</div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>`;
}

export function kpi({ label, value, sub = "", tone = "" }) {
  return `<div class="kpi ${tone}"><span class="kpi-label">${esc(label)}</span><span class="kpi-value">${value}</span>${sub ? `<span class="kpi-sub">${sub}</span>` : ""}</div>`;
}

export function segmented(items, active) {
  return `<div class="seg" role="tablist">${items.map((i) =>
    `<button type="button" role="tab" class="seg-btn${i.id === active ? " on" : ""}" data-seg="${esc(i.id)}">${esc(i.label)}${i.count !== undefined ? `<span class="seg-n">${esc(i.count)}</span>` : ""}</button>`).join("")}</div>`;
}
/** Wire a `segmented()` strip: marks the clicked button and calls cb(id). */
export function bindSegmented(root, cb) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-seg]");
    if (!btn || !root.contains(btn)) return;
    root.querySelectorAll("[data-seg]").forEach((b) => b.classList.toggle("on", b === btn));
    cb(btn.dataset.seg);
  });
}

/* ---------- States ---------- */
export function emptyState({ icon = "fa-inbox", title = "Nothing here yet", text = "", action = "" } = {}) {
  return `<div class="state"><div class="state-ico"><i class="fa-solid ${icon}"></i></div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}${action}</div>`;
}
export function errorState({ title = "লোড করা যায়নি", text = "", retry = true } = {}) {
  return `<div class="state err"><div class="state-ico"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}${retry ? `<button type="button" class="btn btn-outline btn-sm" data-retry><i class="fa-solid fa-arrow-rotate-right"></i> Try again</button>` : ""}</div>`;
}
export const rulesHint = (what) =>
  errorState({ title: `${what} — Firestore rules প্রয়োজন`, text: "firestore.rules ফাইলটি Firebase Console → Firestore → Rules-এ পেস্ট করে Publish করুন, তারপর আবার চেষ্টা করুন।" });
export function skeleton(rows = 6) {
  return `<div class="skel-list" aria-busy="true">${Array.from({ length: rows }, () => `<div class="skel"></div>`).join("")}</div>`;
}
export const isDenied = (err) => err?.code === "permission-denied";

/* ---------- Busy button ---------- */
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
}

/* ---------- Confirmation dialog (optionally: type a phrase to confirm) ---------- */
export function confirmDanger({ title = "নিশ্চিত করুন", message = "", confirmLabel = "Delete", phrase = "", tone = "coral" } = {}) {
  const needPhrase = !!phrase && getSettings().security.typeToConfirm;
  return new Promise((resolve) => {
    const overlay = openModal(`
      <div class="modal-head"><h3>${esc(title)}</h3></div>
      <p class="confirm-msg">${esc(message)}</p>
      ${needPhrase ? `<div class="field"><label>চালিয়ে যেতে <b>${esc(phrase)}</b> লিখুন</label><input type="text" id="cd-phrase" autocomplete="off" spellcheck="false"></div>` : ""}
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline btn-block" id="cd-cancel">বাতিল</button>
        <button type="button" class="btn btn-${tone} btn-block" id="cd-ok" ${needPhrase ? "disabled" : ""}>${esc(confirmLabel)}</button>
      </div>`);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    const ok = overlay.querySelector("#cd-ok");
    overlay.querySelector("#cd-cancel").addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
    if (needPhrase) {
      const input = overlay.querySelector("#cd-phrase");
      input.addEventListener("input", () => { ok.disabled = input.value.trim().toLowerCase() !== phrase.toLowerCase(); });
      input.focus();
    }
  });
}

/* ---------- Side drawer ---------- */
export function closeDrawer() {
  const w = document.getElementById("adm-drawer");
  if (!w) return;
  w._cleanup?.();
  w._onClose?.();
  w.remove();
  document.body.classList.remove("drawer-open");
}
export function openDrawer({ title, subtitle = "", html = "", width = 560, onClose } = {}) {
  closeDrawer();
  const wrap = document.createElement("div");
  wrap.className = "drawer-wrap";
  wrap.id = "adm-drawer";
  wrap.innerHTML = `
    <div class="drawer-backdrop"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="--dw:${width}px">
      <header class="drawer-head">
        <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div>
        <button type="button" class="icon-btn" data-drawer-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="drawer-body">${html}</div>
    </aside>`;
  document.body.appendChild(wrap);
  document.body.classList.add("drawer-open");
  const onKey = (e) => { if (e.key === "Escape" && !document.getElementById("active-modal-overlay")) closeDrawer(); };
  document.addEventListener("keydown", onKey);
  wrap._cleanup = () => document.removeEventListener("keydown", onKey);
  wrap._onClose = onClose;
  wrap.querySelector(".drawer-backdrop").addEventListener("click", closeDrawer);
  wrap.querySelector("[data-drawer-close]").addEventListener("click", closeDrawer);
  requestAnimationFrame(() => wrap.classList.add("in"));
  return { el: wrap, body: wrap.querySelector(".drawer-body"), close: closeDrawer };
}

/* ---------- Pager ---------- */
function pagerHtml(page, pages) {
  if (pages <= 1) return "";
  const nums = new Set([1, pages, page, page - 1, page + 1]);
  if (page <= 3) { nums.add(2); nums.add(3); }
  if (page >= pages - 2) { nums.add(pages - 1); nums.add(pages - 2); }
  const list = [...nums].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  let out = `<button type="button" class="pg" data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Previous page"><i class="fa-solid fa-chevron-left"></i></button>`;
  let prev = 0;
  for (const n of list) {
    if (n - prev > 1) out += `<span class="pg-gap">…</span>`;
    out += `<button type="button" class="pg${n === page ? " on" : ""}" data-page="${n}" ${n === page ? 'aria-current="page"' : ""}>${n}</button>`;
    prev = n;
  }
  return out + `<button type="button" class="pg" data-page="${page + 1}" ${page === pages ? "disabled" : ""} aria-label="Next page"><i class="fa-solid fa-chevron-right"></i></button>`;
}

/* ---------- Data table: sort + paginate + (optional) row selection ----------
   The page owns filtering; it hands the filtered rows to setRows(). Rows render into
   <tbody>, so listeners attached to `mount` by the page (e.g. [data-act] buttons) survive
   every re-render.
   columns: [{ key, label, sortable, sortValue(row), render(row) → html, cls }] */
export function createTable({ mount, columns, rowId = (r) => r.id, pageSize, selectable = false, onSelect = () => {}, empty = {}, defaultSort = null, rowClass = null, sizes = [10, 25, 50, 100] }) {
  const st = {
    rows: [], page: 1,
    size: pageSize || getSettings().general.pageSize || 25,
    sortKey: defaultSort?.key || null, sortDir: defaultSort?.dir || "desc",
    sel: new Set(), stateHtml: "",
  };
  mount.classList.add("tbl-host");
  mount.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead></thead><tbody></tbody></table></div><div class="tbl-state"></div><div class="tbl-foot"></div>`;
  const wrap = mount.querySelector(".tbl-wrap");
  const thead = mount.querySelector("thead");
  const tbody = mount.querySelector("tbody");
  const stateEl = mount.querySelector(".tbl-state");
  const foot = mount.querySelector(".tbl-foot");

  function sorted() {
    const col = columns.find((c) => c.key === st.sortKey);
    if (!col) return st.rows;
    const val = col.sortValue || ((r) => r[col.key]);
    const dir = st.sortDir === "asc" ? 1 : -1;
    const blank = (v) => v === null || v === undefined || v === "" || Number.isNaN(v);
    return st.rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (blank(x) && blank(y)) return 0;
      if (blank(x)) return 1;   // empty values always sink to the bottom
      if (blank(y)) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y), "bn", { numeric: true }) * dir;
    });
  }
  const pageRows = () => {
    const all = sorted();
    const start = (st.page - 1) * st.size;
    return all.slice(start, start + st.size);
  };
  const pages = () => Math.max(1, Math.ceil(st.rows.length / st.size));

  function render() {
    if (st.stateHtml) {
      wrap.hidden = true; foot.innerHTML = ""; stateEl.innerHTML = st.stateHtml; stateEl.hidden = false;
      return;
    }
    if (!st.rows.length) {
      wrap.hidden = true; foot.innerHTML = "";
      stateEl.innerHTML = emptyState({ icon: empty.icon || "fa-inbox", title: empty.title || "কিছু পাওয়া যায়নি", text: empty.text || "ফিল্টার বদলে দেখুন।", action: empty.action || "" });
      stateEl.hidden = false;
      return;
    }
    stateEl.hidden = true; stateEl.innerHTML = ""; wrap.hidden = false;
    st.page = Math.min(st.page, pages());
    const rows = pageRows();
    const allOnPage = rows.length > 0 && rows.every((r) => st.sel.has(String(rowId(r))));

    thead.innerHTML = `<tr>${selectable ? `<th class="c-sel"><input type="checkbox" data-all ${allOnPage ? "checked" : ""} aria-label="Select all rows on this page"></th>` : ""}${columns.map((c) => {
      const on = st.sortKey === c.key;
      const inner = c.sortable
        ? `<button type="button" class="th-sort${on ? " on" : ""}" data-sort="${esc(c.key)}">${esc(c.label)}<i class="fa-solid ${on ? (st.sortDir === "asc" ? "fa-arrow-up" : "fa-arrow-down") : "fa-sort"}"></i></button>`
        : esc(c.label);
      return `<th class="${c.cls || ""}" ${on ? `aria-sort="${st.sortDir === "asc" ? "ascending" : "descending"}"` : ""}>${inner}</th>`;
    }).join("")}</tr>`;

    tbody.innerHTML = rows.map((r) => {
      const id = String(rowId(r));
      const cls = [st.sel.has(id) ? "sel" : "", rowClass ? rowClass(r) : ""].filter(Boolean).join(" ");
      return `<tr data-id="${esc(id)}" class="${cls}">${selectable ? `<td class="c-sel"><input type="checkbox" data-row ${st.sel.has(id) ? "checked" : ""} aria-label="Select row"></td>` : ""}${columns.map((c) =>
        `<td data-label="${esc(c.label)}" class="${c.cls || ""}"><div class="cell-v">${c.render(r)}</div></td>`).join("")}</tr>`;
    }).join("");

    const from = (st.page - 1) * st.size + 1;
    const to = Math.min(st.rows.length, st.page * st.size);
    const canSelectAll = selectable && allOnPage && st.sel.size < st.rows.length;
    foot.innerHTML = `
      <span class="tbl-count">${fmtN(from)}–${fmtN(to)} of ${fmtN(st.rows.length)}${canSelectAll ? ` · <button type="button" class="link-btn" data-selall>Select all ${fmtN(st.rows.length)}</button>` : ""}</span>
      <div class="pager">${pagerHtml(st.page, pages())}</div>
      <label class="tbl-size">Rows <select data-size>${sizes.map((s) => `<option value="${s}" ${s === st.size ? "selected" : ""}>${s}</option>`).join("")}</select></label>`;
  }

  const emitSelect = () => onSelect(Array.from(st.sel));

  mount.addEventListener("click", (e) => {
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn && mount.contains(sortBtn)) {
      const key = sortBtn.dataset.sort;
      if (st.sortKey === key) st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
      else { st.sortKey = key; st.sortDir = "asc"; }
      st.page = 1; render(); return;
    }
    const pg = e.target.closest("[data-page]");
    if (pg && mount.contains(pg) && !pg.disabled) {
      st.page = Math.min(Math.max(1, Number(pg.dataset.page) || 1), pages());
      render(); wrap.scrollIntoView({ block: "nearest" }); return;
    }
    if (e.target.closest("[data-selall]")) {
      st.rows.forEach((r) => st.sel.add(String(rowId(r))));
      render(); emitSelect();
    }
  });
  mount.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-size]")) { st.size = Number(t.value) || 25; st.page = 1; render(); return; }
    if (t.matches("[data-all]")) {
      pageRows().forEach((r) => (t.checked ? st.sel.add(String(rowId(r))) : st.sel.delete(String(rowId(r)))));
      render(); emitSelect(); return;
    }
    if (t.matches("[data-row]")) {
      const id = t.closest("tr").dataset.id;
      if (t.checked) st.sel.add(id); else st.sel.delete(id);
      t.closest("tr").classList.toggle("sel", t.checked);
      const rows = pageRows();
      const head = thead.querySelector("[data-all]");
      if (head) head.checked = rows.length > 0 && rows.every((r) => st.sel.has(String(rowId(r))));
      emitSelect();
    }
  });

  return {
    setRows(rows, { keepPage = false } = {}) {
      st.rows = rows;
      st.stateHtml = "";
      if (!keepPage) st.page = 1;
      const live = new Set(rows.map((r) => String(rowId(r))));
      let pruned = false;
      for (const id of Array.from(st.sel)) if (!live.has(id)) { st.sel.delete(id); pruned = true; }
      render();
      if (pruned) emitSelect();
    },
    setState(html) { st.stateHtml = html; render(); },
    getSelected: () => Array.from(st.sel),
    clearSelection() { st.sel.clear(); render(); emitSelect(); },
    allRows: () => st.rows,
    render,
  };
}

/** Floating action bar shown while table rows are selected. `actions`: [{ id, label, icon, tone }] */
export function bulkBar(mount, actions, onAction) {
  mount.classList.add("bulkbar");
  mount.hidden = true;
  mount.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (b) onAction(b.dataset.bulk);
  });
  return (count) => {
    mount.hidden = count === 0;
    if (!count) { mount.innerHTML = ""; return; }
    mount.innerHTML = `<span class="bulk-n">${fmtN(count)} selected</span>${actions.map((a) =>
      `<button type="button" class="btn btn-sm ${a.tone ? `btn-${a.tone}` : "btn-outline"}" data-bulk="${esc(a.id)}"><i class="fa-solid ${a.icon}"></i> ${esc(a.label)}</button>`).join("")}<button type="button" class="link-btn" data-bulk="clear">Clear</button>`;
  };
}
