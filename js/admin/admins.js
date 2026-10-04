// ==========================================================================
// admin/admins.js — who can use this panel, and what each person may do (Super Admin only).
//
// "Admin" is still users/{uid}.isAdmin (the flag the whole Firebase project uses). The ROLE
// (adminRoles/{uid}.role) narrows what that admin may do in THIS panel. No role document = Super Admin,
// so every existing admin keeps full access. Because the flag is shared with the course site, adding or
// removing an admin here changes it there too — the role limits apply to this panel only.
// ==========================================================================
import { db } from "../firebase-config.js";
import { collection, getDocs, query, where, doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, openModal, closeModal } from "../utils.js";
import * as cache from "../cache.js";
import { fetchAllUsersAdmin } from "../exam-data.js";
import { esc, $, ago, avatar, pageHead, chip, createTable, confirmDanger, withBusy, errorState, skeleton, isDenied, debounce } from "./core/ui.js";
import { ROLES, ROLE_ORDER, normalizeRole } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { emitChange } from "./core/bus.js";
import { me } from "./admin.js";

let root, table, admins = [];

const PERM_LABELS = {
  "exams.view": "Exams: view", "exams.write": "Exams: create & edit", "exams.delete": "Exams: delete",
  "questions.view": "Question Bank: view", "questions.write": "Question Bank: add & edit", "questions.delete": "Question Bank: delete",
  "taxonomy.view": "Subjects/Categories: view", "taxonomy.write": "Subjects/Categories: edit",
  "students.view": "Students: view", "students.manage": "Students: manage accounts",
  "results.view": "Results: view", "results.export": "Results: export",
  "analytics.view": "Analytics", "notifications.manage": "Notifications", "logs.view": "Activity Logs",
};

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({ title: "Admin Management", desc: "কে এই প্যানেল ব্যবহার করতে পারবে এবং কী করতে পারবে — রোল ও পারমিশন।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="ad-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button type="button" class="btn btn-primary btn-sm" id="ad-add"><i class="fa-solid fa-user-plus"></i> Add admin</button>` })}
    <div class="stack">
      <div class="note warn"><b>মনে রাখবেন:</b> অ্যাডমিন ফ্ল্যাগ কোর্স সাইটেও কার্যকর (একই Firebase প্রজেক্ট)। এখানে অ্যাডমিন যোগ বা বাদ দিলে সেখানেও বদলাবে। নিচের রোল শুধু <b>এই প্যানেলে</b> সীমা টানে।</div>
      <div class="panel"><div class="panel-head"><h2>Admins</h2></div><div id="ad-table"></div></div>
      <div class="panel"><div class="panel-head"><div><h2>Roles & permissions</h2><small>কোন রোল কী করতে পারে</small></div></div>
        <div class="panel-body"><div class="perm-grid">${ROLE_ORDER.map((id) => `
          <div class="perm-card"><h3>${chip(ROLES[id].label, ROLES[id].tone)}</h3><p>${esc(ROLES[id].desc)}</p>
            <ul class="feed" style="margin-top:8px">${ROLES[id].perms.includes("*") ? `<li style="padding:4px 0"><span class="feed-t">সব পারমিশন (Settings, Admin Management সহ)</span></li>` : ROLES[id].perms.map((p) => `<li style="padding:3px 0;border:0"><span class="feed-t" style="font-size:.8rem">✓ ${esc(PERM_LABELS[p] || p)}</span></li>`).join("")}</ul></div>`).join("")}</div></div></div>
    </div>`;
  table = createTable({
    mount: $("#ad-table", root), pageSize: 25, defaultSort: { key: "name", dir: "asc" },
    empty: { icon: "fa-user-shield", title: "কোনো অ্যাডমিন পাওয়া যায়নি" },
    columns: [
      { key: "name", label: "Admin", sortable: true, sortValue: (a) => a.name.toLowerCase(), render: (a) => `<div class="row" style="flex-wrap:nowrap;gap:10px">${avatar(a.name, 34)}<div class="cell-main"><div class="t">${esc(a.name)}${a.id === me.user.uid ? ` <span class="muted">(you)</span>` : ""}</div><div class="s">${esc(a.email)}</div></div></div>` },
      { key: "role", label: "Role", sortable: true, sortValue: (a) => ROLE_ORDER.indexOf(a.role), render: (a) =>
        `<select class="inp" data-role="${esc(a.id)}" aria-label="Role" ${a.id === me.user.uid ? "disabled title=\"নিজের রোল বদলানো যায় না\"" : ""}>${ROLE_ORDER.map((r) => `<option value="${r}" ${r === a.role ? "selected" : ""}>${esc(ROLES[r].label)}</option>`).join("")}</select>` },
      { key: "by", label: "Added", render: (a) => (a.addedBy ? `<span class="muted">${esc(a.addedBy)} · ${ago(a.createdAt)}</span>` : `<span class="muted">Original admin</span>`) },
      { key: "act", label: "", cls: "c-act", render: (a) => a.id === me.user.uid ? "" : `<div class="row-actions"><button type="button" class="icon-btn danger" data-rm="${esc(a.id)}" title="Remove admin access"><i class="fa-solid fa-user-xmark"></i></button></div>` },
    ],
  });
  $("#ad-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#ad-add", root).addEventListener("click", addModal);
  root.addEventListener("change", (e) => { const s = e.target.closest("[data-role]"); if (s) changeRole(s.dataset.role, s.value, s); });
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const r = e.target.closest("[data-rm]");
    if (r) removeAdmin(r.dataset.rm);
  });
  await load();
}

export function activate() { /* edited only here */ }

async function load(opts) {
  table.setState(skeleton(4));
  try {
    admins = await cache.remember("admin:admins", 5 * 60 * 1000, async () => {
      const [users, roles] = await Promise.all([
        getDocs(query(collection(db, "users"), where("isAdmin", "==", true))),
        getDocs(collection(db, "adminRoles")).catch(() => ({ docs: [] })),
      ]);
      const byId = Object.fromEntries(roles.docs.map((d) => [d.id, d.data()]));
      return users.docs.map((d) => {
        const u = d.data(), r = byId[d.id];
        return { id: d.id, name: u.displayName || u.email || "Admin", email: u.email || "", role: r ? normalizeRole(r.role) : "super", hasRoleDoc: !!r, addedBy: r?.addedBy || "", createdAt: r?.createdAt || null };
      });
    }, { force: cache.wantsFresh(opts) });
    table.setRows(admins);
  } catch (err) { table.setState(errorState({ title: "অ্যাডমিন তালিকা লোড করা যায়নি", text: err?.message || "" })); }
}
const touch = () => { cache.set("admin:admins", admins, 5 * 60 * 1000); table.setRows(admins, { keepPage: true }); };
const supers = () => admins.filter((a) => a.role === "super").length;
const who = () => me.profile?.displayName || me.user.email || "";

async function writeRole(a, role) {
  await setDoc(doc(db, "adminRoles", a.id), { role, name: a.name, email: a.email, addedBy: a.addedBy || who(), createdAt: a.createdAt || serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
  a.role = role; a.hasRoleDoc = true;
}

async function changeRole(id, role, selectEl) {
  const a = admins.find((x) => x.id === id);
  if (!a || a.role === role) return;
  if (a.role === "super" && supers() <= 1) { toast("শেষ Super Admin-এর রোল বদলানো যাবে না", "error"); selectEl.value = a.role; return; }
  const prev = a.role;
  try {
    await writeRole(a, role);
    logAction("admin.role", { type: "admin", id, label: a.name, detail: `${ROLES[prev].label} → ${ROLES[role].label}` });
    emitChange("admins");
    toast(`${a.name} এখন ${ROLES[role].label}`, "success");
    touch();
  } catch (err) { selectEl.value = prev; toast(isDenied(err) ? "অনুমতি নেই — শুধু Super Admin, এবং firestore.rules Publish করা থাকতে হবে" : "রোল বদলানো যায়নি", "error"); }
}

async function removeAdmin(id) {
  const a = admins.find((x) => x.id === id);
  if (!a) return;
  if (a.role === "super" && supers() <= 1) { toast("শেষ Super Admin-কে সরানো যাবে না", "error"); return; }
  if (!(await confirmDanger({ title: "অ্যাডমিন অ্যাক্সেস সরাবেন?", message: `${a.name} আর অ্যাডমিন থাকবেন না — এই প্যানেলে এবং কোর্স সাইটে, দুই জায়গাতেই। তাঁর অ্যাকাউন্ট ও ডেটা মুছবে না।`, confirmLabel: "Remove admin", phrase: "remove" }))) return;
  try {
    await updateDoc(doc(db, "users", id), { isAdmin: false });
    await deleteDoc(doc(db, "adminRoles", id)).catch(() => {});
    admins = admins.filter((x) => x.id !== id);
    cache.del("admin:users");
    logAction("admin.remove", { type: "admin", id, label: a.name });
    emitChange("admins");
    toast("অ্যাডমিন অ্যাক্সেস সরানো হয়েছে", "success");
    touch();
  } catch (err) { toast(isDenied(err) ? "অনুমতি নেই — শুধু Super Admin" : "সরানো যায়নি", "error"); }
}

/* ---------- Add: pick an existing user, choose a role ---------- */
async function addModal() {
  const overlay = openModal(`
    <div class="modal-head"><h3>Add admin</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <p class="confirm-msg">যে ব্যবহারকারী আগে থেকেই সাইন আপ করেছেন, তাঁকে খুঁজে অ্যাডমিন বানান।</p>
    <div class="field"><label>Find user</label><input type="search" id="aa-q" placeholder="Name or email…" autocomplete="off"></div>
    <div class="lesson-picker" id="aa-list" style="max-height:220px"><div class="loading-screen" style="padding:18px"><span class="spinner"></span></div></div>
    <div class="field mt-12"><label>Role</label><select id="aa-role">${ROLE_ORDER.filter((r) => r !== "super").concat("super").map((r) => `<option value="${r}" ${r === "manager" ? "selected" : ""}>${esc(ROLES[r].label)} — ${esc(ROLES[r].desc)}</option>`).join("")}</select></div>
    <div class="confirm-actions"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="button" class="btn btn-primary btn-block" id="aa-ok" disabled>Make admin</button></div>`);
  let users = [], pick = null;
  try { users = (await fetchAllUsersAdmin()).filter((u) => !u.isAdmin); }
  catch { $("#aa-list", overlay).innerHTML = `<div class="muted" style="padding:14px">ব্যবহারকারী লোড করা যায়নি।</div>`; return; }
  const draw = () => {
    const needle = $("#aa-q", overlay).value.trim().toLowerCase();
    const list = users.filter((u) => !needle || `${u.displayName || ""} ${u.email || ""}`.toLowerCase().includes(needle)).slice(0, 30);
    $("#aa-list", overlay).innerHTML = list.length ? list.map((u) => `<label class="lesson-picker-item"><input type="radio" name="aa" value="${esc(u.id)}" ${pick === u.id ? "checked" : ""}><span>${esc(u.displayName || "নাম নেই")} <span class="muted">${esc(u.email || "")}</span></span></label>`).join("") : `<div class="muted" style="padding:14px">কাউকে পাওয়া যায়নি।</div>`;
  };
  draw();
  $("#aa-q", overlay).addEventListener("input", debounce(draw, 150));
  $("#aa-list", overlay).addEventListener("change", (e) => { pick = e.target.value; $("#aa-ok", overlay).disabled = !pick; });
  $("#aa-ok", overlay).addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    const u = users.find((x) => x.id === pick);
    if (!u) return;
    const role = $("#aa-role", overlay).value;
    try {
      // Role first, flag second: the new admin never exists for a moment with more access than intended.
      const entry = { id: u.id, name: u.displayName || u.email || "Admin", email: u.email || "", role, addedBy: who(), createdAt: null };
      await writeRole(entry, role);
      await updateDoc(doc(db, "users", u.id), { isAdmin: true });
      u.isAdmin = true;
      admins.push({ ...entry, createdAt: { seconds: Math.floor(Date.now() / 1000) } });
      logAction("admin.add", { type: "admin", id: u.id, label: entry.name, detail: ROLES[role].label });
      emitChange("admins");
      toast(`${entry.name} এখন ${ROLES[role].label}`, "success");
      touch(); closeModal();
    } catch (err) { toast(isDenied(err) ? "অনুমতি নেই — শুধু Super Admin, এবং firestore.rules Publish করা থাকতে হবে" : "অ্যাডমিন যোগ করা যায়নি", "error"); }
  }));
}
