// ==========================================================================
// admin/notices.js — Notice / Announcement management for the STUDENT EXAM SITE.
//
// Separate from admin → Notifications on purpose: that page feeds the course site's `notifications`
// collection (untouched). Notices live in their own admin-only collection `notices/{id}` and are
// mirrored — as a small compact list — into homeFeed/main.notices, which students already read for free
// together with the home page. Publishing, scheduling (publishAt) and expiry (expiresAt) are evaluated on the
// student's device against the server clock, so nothing here needs a timer or a Cloud Function.
//
//   title · description · category · priority (normal / important / urgent) · publish state · publish-at · expires-at
//   audience: all students · a course · an exam · a category          optional link: exam / course
// ==========================================================================
import { db } from "../firebase-config.js";
import { collection, getDocs, doc, setDoc, addDoc, deleteDoc, query, orderBy, limit, Timestamp, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { toast, openModal, closeModal } from "../utils.js";
import { fetchAllExamsAdmin } from "../exam-data.js";
import * as cache from "../cache.js";
import { courses } from "./admin.js";
import {
  esc, $, fmtDateTime, pageHead, chip, segmented, bindSegmented, createTable, confirmDanger, withBusy, debounce,
  errorState, skeleton, toLocalInput, fromLocalInput, toMs, isDenied, rulesHint,
} from "./core/ui.js";
import { can, currentRole } from "./core/permissions.js";
import { takePending } from "./core/bus.js";
import { logAction } from "./core/audit.js";
import { loadTaxonomy, getTaxonomy, categoryPath } from "./core/taxonomy.js";
import { writeFeedFields } from "../home-data.js";
import {
  NOTICE_CATEGORIES, NOTICE_PRIORITY, AUDIENCE_TYPES, noticeCategory, noticePriority, noticeState, normalizeAudience, toMirrorNotice,
} from "../home-core.js";
import { serverNow } from "../server-time.js";

const COL = "notices";
const KEY = "admin:notices";
const MIRROR_MAX = 40;
const STATE_TONE = { draft: "", scheduled: "amber", live: "teal", expired: "coral" };
const STATE_LABEL = { draft: "Draft", scheduled: "Scheduled", live: "Live", expired: "Expired" };

let root = null, table = null, notices = [], examList = [], loadFailed = false, denied = false;
const filters = { q: "", status: "all", priority: "", range: "" };

export async function mount(el) {
  root = el;
  const canWrite = can("notices.manage");
  root.innerHTML = `
    ${pageHead({
      title: "Notices",
      desc: "পরীক্ষার ঘোষণা ও গুরুত্বপূর্ণ নোটিশ — শিক্ষার্থীদের হোমপেজের Notice Board ও নোটিফিকেশন বেলে দেখানো হয়।",
      actions: `<button type="button" class="btn btn-outline btn-sm" id="nt-refresh" title="Re-read the notices"><i class="fa-solid fa-arrow-rotate-right"></i></button>
        ${canWrite ? `<button type="button" class="btn btn-outline btn-sm" id="nt-sync" title="Re-publish the student copy of all notices"><i class="fa-solid fa-cloud-arrow-up"></i> Sync</button>
        <button type="button" class="btn btn-primary btn-sm" id="nt-new"><i class="fa-solid fa-plus"></i> New notice</button>` : ""}`,
    })}
    <div class="panel">
      <div class="toolbar">
        <div class="search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="nt-q" placeholder="Search notices…" autocomplete="off"></div>
        <select id="nt-priority" aria-label="Priority"><option value="">All priorities</option>${Object.entries(NOTICE_PRIORITY).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select>
        <select id="nt-range" aria-label="Date"><option value="">Any date</option><option value="7">Created in the last 7 days</option><option value="30">Created in the last 30 days</option><option value="soon">Expiring within 3 days</option></select>
      </div>
      <div class="toolbar" id="nt-seg"></div>
      <div id="nt-table"></div>
    </div>`;

  table = createTable({
    mount: $("#nt-table", root),
    defaultSort: { key: "created", dir: "desc" },
    empty: { icon: "fa-bullhorn", title: "কোনো নোটিশ নেই", text: "“New notice” চেপে প্রথম নোটিশ তৈরি করুন।" },
    columns: columns(canWrite),
  });
  bindSegmented($("#nt-seg", root), (v) => { filters.status = v; paint(); });
  $("#nt-q", root).addEventListener("input", debounce((e) => { filters.q = e.target.value; paint(); }, 150));
  $("#nt-priority", root).addEventListener("change", (e) => { filters.priority = e.target.value; paint(); });
  $("#nt-range", root).addEventListener("change", (e) => { filters.range = e.target.value; paint(); });
  $("#nt-refresh", root).addEventListener("click", () => load({ force: true }));
  $("#nt-new", root)?.addEventListener("click", () => openEditor(null));
  $("#nt-sync", root)?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => { if (await syncMirror()) toast("শিক্ষার্থীদের কপি আপডেট হয়েছে", "success"); }));
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]")) return load({ force: true });
    const b = e.target.closest("[data-act]");
    if (!b) return;
    ({ edit: openEditor, toggle: togglePublish, dup: duplicate, delete: remove })[b.dataset.act]?.(b.dataset.id);
  });
  await Promise.all([loadTaxonomy().catch(() => {}), load()]);
  if (takePending("new-notice") && canWrite) openEditor(null);
}

export async function activate() {
  if (!table) return;
  if (loadFailed) load();
  if (takePending("new-notice") && can("notices.manage")) openEditor(null);
}

async function load({ force = false } = {}) {
  table.setState(skeleton(5));
  try {
    notices = await cache.remember(KEY, 5 * 60 * 1000, async () => {
      const snap = await getDocs(query(collection(db, COL), orderBy("createdAt", "desc"), limit(200)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }, { force });
    examList = await fetchAllExamsAdmin().catch(() => []);
    loadFailed = false; denied = false;
    paint();
  } catch (err) {
    loadFailed = true; denied = isDenied(err);
    table.setState(denied ? rulesHint("Notices") : errorState({ title: "নোটিশ লোড করা যায়নি", text: err?.message || "" }));
  }
}

const stateOf = (n) => noticeState(n, serverNow());

function filtered() {
  const q = filters.q.trim().toLowerCase();
  const now = serverNow();
  return notices.filter((n) => {
    const st = stateOf(n);
    if (filters.status !== "all" && st !== filters.status) return false;
    if (filters.priority && n.priority !== filters.priority) return false;
    if (filters.range === "7" || filters.range === "30") { if (now - toMs(n.createdAt) > Number(filters.range) * 86400000) return false; }
    if (filters.range === "soon") { const x = toMs(n.expiresAt); if (!x || x < now || x - now > 3 * 86400000) return false; }
    return !q || `${n.title} ${n.body}`.toLowerCase().includes(q);
  });
}

function paint() {
  const counts = { all: notices.length, draft: 0, scheduled: 0, live: 0, expired: 0 };
  notices.forEach((n) => { counts[stateOf(n)]++; });
  $("#nt-seg", root).innerHTML = segmented(["all", "live", "scheduled", "draft", "expired"].map((k) => ({ id: k, label: k === "all" ? "All" : STATE_LABEL[k], count: counts[k] })), filters.status);
  table.setRows(filtered(), { keepPage: true });
}

function audienceLabel(n) {
  const a = normalizeAudience(n.audience);
  if (a.type === "all") return "All students";
  const names = a.ids.map((id) => (a.type === "course" ? courses.find((c) => c.id === id)?.title : a.type === "exam" ? examList.find((e) => e.id === id)?.title : categoryPath(id)) || id);
  return `${AUDIENCE_TYPES[a.type]}: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
}

function columns(canWrite) {
  return [
    { key: "title", label: "Notice", sortable: true, sortValue: (n) => n.title || "", render: (n) => `<div class="cell-main"><div class="t"><i class="fa-solid ${esc(noticeCategory(n.category).icon)}" style="color:var(--text-muted)"></i> ${esc(n.title)}</div>${n.body ? `<div class="s">${esc(String(n.body).slice(0, 90))}${String(n.body).length > 90 ? "…" : ""}</div>` : ""}</div>` },
    { key: "priority", label: "Priority", sortable: true, sortValue: (n) => noticePriority(n.priority).rank, render: (n) => chip(noticePriority(n.priority).label, n.priority === "urgent" ? "coral" : n.priority === "important" ? "amber" : "") },
    { key: "state", label: "Status", sortable: true, sortValue: (n) => stateOf(n), render: (n) => chip(STATE_LABEL[stateOf(n)], STATE_TONE[stateOf(n)]) },
    { key: "audience", label: "Audience", render: (n) => `<span class="muted">${esc(audienceLabel(n))}</span>` },
    { key: "publish", label: "Publishes", sortable: true, sortValue: (n) => toMs(n.publishAt) || toMs(n.createdAt), render: (n) => `<span class="nowrap">${esc(toMs(n.publishAt) ? fmtDateTime(n.publishAt) : "On publish")}</span>` },
    { key: "expires", label: "Expires", sortable: true, sortValue: (n) => toMs(n.expiresAt) || null, render: (n) => (toMs(n.expiresAt) ? `<span class="nowrap">${esc(fmtDateTime(n.expiresAt))}</span>` : '<span class="muted">Never</span>') },
    { key: "created", label: "Created", sortable: true, sortValue: (n) => toMs(n.createdAt), render: (n) => `<span class="muted nowrap">${esc(fmtDateTime(n.createdAt))}</span>` },
    { key: "act", label: "", cls: "c-act", render: (n) => (canWrite ? `<div class="row-actions">
      <button type="button" class="icon-btn" data-act="edit" data-id="${n.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="icon-btn" data-act="toggle" data-id="${n.id}" title="${n.status === "draft" ? "Publish" : "Unpublish (back to draft)"}"><i class="fa-solid ${n.status === "draft" ? "fa-eye" : "fa-eye-slash"}"></i></button>
      <button type="button" class="icon-btn" data-act="dup" data-id="${n.id}" title="Duplicate (as a draft)"><i class="fa-solid fa-clone"></i></button>
      <button type="button" class="icon-btn danger" data-act="delete" data-id="${n.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
    </div>` : "") },
  ];
}

/* ---------- the student copy ---------- */
/** Published, not-yet-long-expired notices → homeFeed/main.notices (one small write). */
async function syncMirror() {
  const keep = notices
    .filter((n) => n.status === "published" && !(toMs(n.expiresAt) && toMs(n.expiresAt) < serverNow() - 86400000))
    .sort((a, b) => (toMs(b.publishAt) || toMs(b.createdAt)) - (toMs(a.publishAt) || toMs(a.createdAt)))
    .slice(0, MIRROR_MAX)
    .map((n) => toMirrorNotice(n.id, n));
  try {
    await writeFeedFields({ notices: keep });
    return true;
  } catch (err) {
    toast(isDenied(err) ? "শিক্ষার্থীদের কপি আপডেট হয়নি — Firestore rules (homeFeed) পাবলিশ করুন" : "শিক্ষার্থীদের কপি আপডেট করা যায়নি — Sync চেপে আবার চেষ্টা করুন", "error");
    return false;
  }
}

const touch = () => { cache.set(KEY, notices, 5 * 60 * 1000); paint(); };

/* ---------- actions ---------- */
async function togglePublish(id) {
  const n = notices.find((x) => x.id === id);
  if (!n) return;
  const next = n.status === "draft" ? "published" : "draft";
  try {
    await setDoc(doc(db, COL, id), { status: next, updatedAt: serverTimestamp() }, { merge: true });
    n.status = next; n.updatedAt = Timestamp.now();
    logAction(next === "published" ? "notice.publish" : "notice.unpublish", { type: "notice", id, label: n.title });
    touch();
    if (await syncMirror()) toast(next === "published" ? "নোটিশ পাবলিশ হয়েছে" : "নোটিশ আনপাবলিশ হয়েছে", "success");
  } catch { toast("বদলানো যায়নি", "error"); }
}

async function duplicate(id) {
  const n = notices.find((x) => x.id === id);
  if (!n) return;
  try {
    const { id: _id, createdAt, updatedAt, ...rest } = n;
    const data = { ...rest, title: `${n.title} (Copy)`, status: "draft", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: actorName() };
    const ref = await addDoc(collection(db, COL), data);
    notices.unshift({ id: ref.id, ...rest, title: data.title, status: "draft", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    logAction("notice.create", { type: "notice", id: ref.id, label: data.title, detail: "duplicate · draft" });
    touch(); toast("কপি তৈরি হয়েছে (Draft)", "success");
  } catch { toast("কপি করা যায়নি", "error"); }
}

async function remove(id) {
  const n = notices.find((x) => x.id === id);
  if (!n) return;
  if (!(await confirmDanger({ title: "নোটিশ মুছবেন?", message: `"${n.title}" স্থায়ীভাবে মুছে যাবে এবং শিক্ষার্থীদের হোমপেজ থেকেও সরে যাবে।`, confirmLabel: "Delete" }))) return;
  try {
    await deleteDoc(doc(db, COL, id));
    notices = notices.filter((x) => x.id !== id);
    logAction("notice.delete", { type: "notice", id, label: n.title });
    touch();
    if (await syncMirror()) toast("নোটিশ মুছে ফেলা হয়েছে", "success");
  } catch { toast("মোছা যায়নি", "error"); }
}

const actorName = () => document.getElementById("admin-user-name")?.textContent || currentRole();

/* ==========================================================================
   Editor
   ========================================================================== */
function openEditor(id) {
  const n = id ? notices.find((x) => x.id === id) : null;
  if (id && !n) return;
  const aud = normalizeAudience(n?.audience);
  const cats = getTaxonomy().categories;
  const checks = (name, list, selected) => `<div class="pick-list" data-pick="${name}">${list.length ? list.map((o) => `<label class="check-row"><input type="checkbox" value="${esc(o.id)}" ${selected.includes(o.id) ? "checked" : ""}> <span>${esc(o.label)}</span></label>`).join("") : '<span class="muted">Nothing to choose from yet.</span>'}</div>`;
  const lists = {
    course: courses.map((c) => ({ id: c.id, label: c.title })),
    exam: examList.slice().sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt)).map((e) => ({ id: e.id, label: e.title })),
    category: cats.map((c) => ({ id: c.id, label: categoryPath(c.id) || c.name })),
  };

  const overlay = openModal(`
    <div class="modal-head"><h3>${n ? "Edit notice" : "New notice"}</h3><button type="button" class="modal-close-btn" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
    <form id="nt-form" novalidate>
      <div class="field"><label for="nt-title">Title <span class="muted" id="nt-title-n"></span></label><input type="text" id="nt-title" maxlength="100" required value="${esc(n?.title || "")}" placeholder="আগামীকাল সকাল ১০টায় মডেল পরীক্ষা"></div>
      <div class="field"><label for="nt-body">Description</label><textarea id="nt-body" rows="4" maxlength="1200" placeholder="বিস্তারিত লিখুন (ঐচ্ছিক)">${esc(n?.body || "")}</textarea></div>
      <div class="admin-grid">
        <div class="field"><label for="nt-cat">Category</label><select id="nt-cat">${NOTICE_CATEGORIES.map((c) => `<option value="${c.id}" ${(n?.category || "general") === c.id ? "selected" : ""}>${c.label}</option>`).join("")}</select></div>
        <div class="field"><label for="nt-pri">Priority</label><select id="nt-pri">${Object.entries(NOTICE_PRIORITY).map(([k, v]) => `<option value="${k}" ${(n?.priority || "normal") === k ? "selected" : ""}>${v.label} — ${v.bn}</option>`).join("")}</select>
          <span class="form-hint">Urgent notices are shown prominently at the top of the student home page.</span></div>
      </div>
      <div class="admin-grid">
        <div class="field"><label for="nt-status">Publish state</label><select id="nt-status"><option value="published" ${n?.status !== "draft" ? "selected" : ""}>Published</option><option value="draft" ${n?.status === "draft" ? "selected" : ""}>Draft — hidden</option></select></div>
        <div class="field"><label for="nt-pub">Publish at</label><input type="datetime-local" id="nt-pub" value="${toLocalInput(n?.publishAt)}"><span class="form-hint">Empty = visible as soon as it is published.</span></div>
        <div class="field"><label for="nt-exp">Expires at</label><input type="datetime-local" id="nt-exp" value="${toLocalInput(n?.expiresAt)}"><span class="form-hint">Empty = never. Expired notices disappear automatically.</span></div>
      </div>
      <div class="field"><label for="nt-aud">Target audience</label>
        <select id="nt-aud">${Object.entries(AUDIENCE_TYPES).map(([k, v]) => `<option value="${k}" ${aud.type === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <div id="nt-aud-pick"></div>
        <span class="form-hint">Audience decides who <b>sees</b> the notice — it is not a privacy boundary, so don't put private information in a notice.</span></div>
      <div class="admin-grid">
        <div class="field"><label for="nt-exam">Link to exam (optional)</label><select id="nt-exam"><option value="">— None —</option>${lists.exam.map((o) => `<option value="${esc(o.id)}" ${n?.examId === o.id ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></div>
        <div class="field"><label for="nt-course">Link to course (optional)</label><select id="nt-course"><option value="">— None —</option>${lists.course.map((o) => `<option value="${esc(o.id)}" ${n?.courseId === o.id ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></div>
      </div>
      <p class="note bad" id="nt-errors" hidden></p>
      <div class="confirm-actions">
        <button type="button" class="btn btn-outline btn-block" data-modal-close>Cancel</button>
        <button type="submit" class="btn btn-primary btn-block" id="nt-save">${n ? "Save changes" : "Create notice"}</button>
      </div>
    </form>`);

  const el = (i) => overlay.querySelector(`#${i}`);
  const picked = { course: [], exam: [], category: [] };
  if (aud.type !== "all") picked[aud.type] = aud.ids.slice();
  const drawPick = () => {
    const t = el("nt-aud").value;
    el("nt-aud-pick").innerHTML = t === "all" ? "" : checks(t, lists[t], picked[t]);
  };
  drawPick();
  el("nt-aud").addEventListener("change", drawPick);
  overlay.addEventListener("change", (e) => {
    const box = e.target.closest(".pick-list input");
    if (!box) return;
    const t = box.closest("[data-pick]").dataset.pick;
    picked[t] = [...overlay.querySelectorAll(`[data-pick="${t}"] input:checked`)].map((i) => i.value);
  });
  const count = () => { el("nt-title-n").textContent = `${el("nt-title").value.length}/100`; };
  el("nt-title").addEventListener("input", count); count();

  el("nt-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const title = el("nt-title").value.trim();
    const pub = fromLocalInput(el("nt-pub").value), exp = fromLocalInput(el("nt-exp").value);
    const type = el("nt-aud").value;
    const errors = [];
    if (!title) errors.push("Title দিন।");
    if (pub && exp && exp <= pub) errors.push("Expiry সময় অবশ্যই Publish সময়ের পরে হতে হবে।");
    if (type !== "all" && !picked[type].length) errors.push("এই Audience-এর জন্য অন্তত একটি আইটেম বাছুন।");
    const box = el("nt-errors"); box.hidden = !errors.length; box.innerHTML = errors.map(esc).join("<br>");
    if (errors.length) return;

    const data = {
      title, body: el("nt-body").value.trim(), category: el("nt-cat").value, priority: el("nt-pri").value,
      status: el("nt-status").value === "draft" ? "draft" : "published",
      publishAt: pub ? Timestamp.fromDate(pub) : null, expiresAt: exp ? Timestamp.fromDate(exp) : null,
      audience: normalizeAudience({ type, ids: picked[type] }), examId: el("nt-exam").value, courseId: el("nt-course").value,
    };
    await withBusy(el("nt-save"), async () => {
      try {
        if (n) {
          await setDoc(doc(db, COL, n.id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
          Object.assign(n, data, { updatedAt: Timestamp.now() });
          logAction("notice.update", { type: "notice", id: n.id, label: title, detail: `${data.priority} · ${data.status}` });
        } else {
          const ref = await addDoc(collection(db, COL), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: actorName() });
          notices.unshift({ id: ref.id, ...data, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
          logAction(data.status === "published" ? "notice.publish" : "notice.create", { type: "notice", id: ref.id, label: title, detail: `${data.priority} · ${data.status}` });
        }
        closeModal();
        touch();
        if (await syncMirror()) toast(n ? "নোটিশ আপডেট হয়েছে" : "নোটিশ তৈরি হয়েছে", "success");
      } catch (err) {
        box.hidden = false;
        box.textContent = isDenied(err) ? "অনুমতি নেই — firestore.rules পাবলিশ করুন (notices)।" : "সেভ করা যায়নি — আবার চেষ্টা করুন।";
      }
    });
  });
}
