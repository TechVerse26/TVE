// ==========================================================================
// admin/notifications.js — announcements to students.
// Uses the platform's existing `notifications` collection (same fields and rules the course site
// already reads: title, message, audience "all" | "enrolled", courseIds, courseTitles), so a message
// sent here shows up wherever the platform displays notifications. The exam site itself has no
// notification bell; its own site-wide notice is Maintenance mode (Settings).
// ==========================================================================
import { db } from "../firebase-config.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, openModal, closeModal } from "../utils.js";
import * as cache from "../cache.js";
import {
  esc, $, $$, ago, fmtDateTime, debounce, pageHead, chip, createTable, confirmDanger, withBusy, errorState, skeleton, isDenied,
} from "./core/ui.js";
import { logAction } from "./core/audit.js";
import { getSettings } from "./core/settings.js";
import { courses, me } from "./admin.js";

const MAX_TITLE = 100, MAX_MSG = 600;
let root, table, rows = [], q = "";

export async function mount(el) {
  root = el;
  root.innerHTML = `
    ${pageHead({ title: "Notifications", desc: "শিক্ষার্থীদের জন্য ঘোষণা — সবাইকে, অথবা নির্দিষ্ট কোর্সে এনরোল করা শিক্ষার্থীদের।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="nt-refresh" title="Re-read from the database"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        <button type="button" class="btn btn-primary btn-sm" id="nt-new"><i class="fa-solid fa-paper-plane"></i> New notification</button>` })}
    <div class="stack">
      <div class="note"><b>কীভাবে কাজ করে:</b> বার্তাটি প্ল্যাটফর্মের <code>notifications</code> কালেকশনে জমা হয়, যা কোর্স সাইটের নোটিফিকেশন তালিকা পড়ে। এক্সাম সাইটের হোমপেজ ও নোটিফিকেশন বেলে ঘোষণা দেখানোর জন্য <b>Notices</b> পেজ ব্যবহার করুন; মেইনটেন্যান্স বার্তা Settings → Site status-এ।</div>
      <div class="panel">
        <div class="toolbar"><div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="nt-q" placeholder="Search title or message…" autocomplete="off"></div></div>
        <div id="nt-table"></div>
      </div>
    </div>`;
  table = createTable({
    mount: $("#nt-table", root), defaultSort: { key: "sent", dir: "desc" },
    empty: { icon: "fa-bell", title: "এখনো কোনো নোটিফিকেশন পাঠানো হয়নি", text: "“New notification” চেপে প্রথম বার্তাটি পাঠান।" },
    columns: [
      { key: "title", label: "Message", sortable: true, sortValue: (n) => n.title || "", render: (n) => `<div class="cell-main"><div class="t">${esc(n.title)}</div><div class="s clamp2">${esc(n.message)}</div></div>` },
      { key: "audience", label: "Audience", render: (n) => n.audience === "enrolled"
        ? (n.courseTitles || []).slice(0, 2).map((t) => chip(t, "teal")).join(" ") + ((n.courseTitles || []).length > 2 ? ` <span class="muted">+${n.courseTitles.length - 2}</span>` : "")
        : chip("All students", "accent", "fa-users") },
      { key: "sent", label: "Sent", sortable: true, sortValue: (n) => n.createdAt?.seconds || 0, render: (n) => `<span class="muted" title="${esc(fmtDateTime(n.createdAt))}">${ago(n.createdAt)}</span>` },
      { key: "act", label: "", cls: "c-act", render: (n) => `<div class="row-actions"><button type="button" class="icon-btn" data-act="edit" data-id="${esc(n.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="icon-btn danger" data-act="del" data-id="${esc(n.id)}" title="Delete"><i class="fa-solid fa-trash"></i></button></div>` },
    ],
  });
  $("#nt-q", root).addEventListener("input", debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 150));
  $("#nt-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#nt-new", root).addEventListener("click", () => composer(null));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const n = rows.find((x) => x.id === b.dataset.id);
    if (!n) return;
    if (b.dataset.act === "edit") composer(n); else remove(n);
  });
  await load();
}

export function activate() { /* only this page edits notifications */ }

async function load(opts) {
  table.setState(skeleton(5));
  try {
    rows = await cache.remember("admin:notifs", 5 * 60 * 1000, async () => {
      const snap = await getDocs(query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(100)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }, { force: cache.wantsFresh(opts) });
    paint();
  } catch (err) {
    table.setState(isDenied(err) ? errorState({ title: "Notifications পড়ার অনুমতি নেই", text: "Firestore rules চেক করুন।" }) : errorState({ title: "লোড করা যায়নি", text: err?.message || "" }));
  }
}
const paint = () => table.setRows(rows.filter((n) => !q || `${n.title} ${n.message}`.toLowerCase().includes(q)), { keepPage: true });
const touch = () => cache.set("admin:notifs", rows, 5 * 60 * 1000);

/* ---------- Compose / edit ---------- */
function composer(n) {
  const audience = n?.audience || getSettings().notification.defaultAudience || "all";
  const chosen = new Set(n?.courseIds || []);
  const overlay = openModal(`
    <div class="modal-head"><h3>${n ? "Edit notification" : "New notification"}</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <form id="nt-form" novalidate>
      <div class="field"><label>Title <span class="muted" id="nt-tc"></span></label><input type="text" id="nt-title" maxlength="${MAX_TITLE}" value="${esc(n?.title || "")}" autocomplete="off" required></div>
      <div class="field"><label>Message <span class="muted" id="nt-mc"></span></label><textarea id="nt-msg" rows="4" maxlength="${MAX_MSG}" required>${esc(n?.message || "")}</textarea></div>
      <div class="field"><label>Audience</label><select id="nt-aud"><option value="all" ${audience === "all" ? "selected" : ""}>All students</option><option value="enrolled" ${audience === "enrolled" ? "selected" : ""}>Students enrolled in selected courses</option></select></div>
      <div class="field" id="nt-courses" ${audience === "enrolled" ? "" : "hidden"}><label>Courses</label>
        <div class="lesson-picker">${courses.length ? courses.map((c) => `<label class="lesson-picker-item"><input type="checkbox" value="${esc(c.id)}" ${chosen.has(c.id) ? "checked" : ""}><span>${esc(c.title)}</span></label>`).join("") : `<div class="muted" style="padding:12px">কোনো কোর্স পাওয়া যায়নি।</div>`}</div></div>
      <div class="note" id="nt-prev"></div>
      <div class="confirm-actions mt-16"><button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button><button type="submit" class="btn btn-primary btn-block" id="nt-send">${n ? "Save changes" : "Send"}</button></div>
    </form>`);
  const title = $("#nt-title", overlay), msg = $("#nt-msg", overlay), aud = $("#nt-aud", overlay);
  const preview = () => {
    $("#nt-tc", overlay).textContent = `${title.value.length}/${MAX_TITLE}`;
    $("#nt-mc", overlay).textContent = `${msg.value.length}/${MAX_MSG}`;
    $("#nt-courses", overlay).hidden = aud.value !== "enrolled";
    const sel = $$("#nt-courses input:checked", overlay).length;
    $("#nt-prev", overlay).innerHTML = `<b>${esc(title.value || "Title")}</b><br>${esc(msg.value || "Message…")}<br><span class="muted">→ ${aud.value === "all" ? "সব শিক্ষার্থী" : `${sel}টি কোর্সের শিক্ষার্থী`}</span>`;
  };
  [title, msg].forEach((x) => x.addEventListener("input", preview));
  aud.addEventListener("change", preview);
  $("#nt-courses", overlay).addEventListener("change", preview);
  preview();
  title.focus();

  $("#nt-form", overlay).addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = title.value.trim(), m = msg.value.trim();
    const ids = $$("#nt-courses input:checked", overlay).map((i) => i.value);
    if (!t || !m) { toast("শিরোনাম ও বার্তা দুটোই লিখুন", "error"); return; }
    if (aud.value === "enrolled" && !ids.length) { toast("কমপক্ষে একটি কোর্স বেছে নিন", "error"); return; }
    const body = {
      title: t, message: m, audience: aud.value,
      courseIds: aud.value === "enrolled" ? ids : [], courseTitles: aud.value === "enrolled" ? ids.map((id) => courses.find((c) => c.id === id)?.title || id) : [],
    };
    await withBusy($("#nt-send", overlay), async () => {
      try {
        if (n) {
          await updateDoc(doc(db, "notifications", n.id), { ...body, updatedAt: serverTimestamp() });
          Object.assign(n, body);
          logAction("notification.update", { type: "notification", id: n.id, label: t });
        } else {
          const ref = await addDoc(collection(db, "notifications"), { ...body, createdAt: serverTimestamp(), createdBy: me?.user?.uid || "", source: "exam-admin" });
          rows.unshift({ id: ref.id, ...body, createdAt: { seconds: Math.floor(Date.now() / 1000) } });
          logAction("notification.send", { type: "notification", id: ref.id, label: t, detail: body.audience === "all" ? "all students" : body.courseTitles.join(", ") });
        }
        touch(); paint();
        toast(n ? "নোটিফিকেশন আপডেট হয়েছে" : "নোটিফিকেশন পাঠানো হয়েছে", "success");
        closeModal();
      } catch (err) { toast(isDenied(err) ? "অনুমতি নেই — Firestore rules চেক করুন" : "সংরক্ষণ করা যায়নি", "error"); }
    });
  });
}

async function remove(n) {
  if (!(await confirmDanger({ title: "নোটিফিকেশন মুছবেন?", message: `"${n.title}" সবার তালিকা থেকে মুছে যাবে।`, confirmLabel: "Delete" }))) return;
  try {
    await deleteDoc(doc(db, "notifications", n.id));
    rows = rows.filter((x) => x.id !== n.id);
    touch(); paint();
    logAction("notification.delete", { type: "notification", id: n.id, label: n.title });
    toast("মুছে ফেলা হয়েছে", "success");
  } catch { toast("মুছে ফেলা যায়নি", "error"); }
}
