// ==========================================================================
// admin/core/audit.js — activity log (adminLogs collection).
// Every important admin action is written as one small, append-only document.
// Logging never blocks or breaks the action it describes: a failed write is ignored.
// ==========================================================================
import { db } from "../../firebase-config.js";
import {
  collection, addDoc, getDocs, query, orderBy, limit, startAfter, where, writeBatch, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const COL = "adminLogs";
let actor = null;

export function setActor(a) { actor = a; }

/** Action catalogue: label + icon + tone for the Activity Logs page and the dashboard feed. */
export const ACTIONS = {
  "exam.create": ["Exam created", "fa-file-circle-plus", "teal"],
  "exam.update": ["Exam updated", "fa-file-pen", ""],
  "exam.delete": ["Exam deleted", "fa-trash", "coral"],
  "exam.publish": ["Exam published", "fa-eye", "teal"],
  "exam.unpublish": ["Exam unpublished", "fa-eye-slash", "amber"],
  "exam.duplicate": ["Exam duplicated", "fa-clone", ""],
  "exam.optimize": ["Optimize run", "fa-bolt", ""],
  "question.create": ["Question added", "fa-circle-plus", "teal"],
  "question.update": ["Question updated", "fa-pen", ""],
  "question.delete": ["Question deleted", "fa-trash", "coral"],
  "question.import": ["Questions imported", "fa-file-import", "teal"],
  "question.bulk": ["Bulk question update", "fa-layer-group", ""],
  "question.assign": ["Questions added to exam", "fa-link", ""],
  "exam.feature": ["Exam featured / unfeatured", "fa-star", "amber"],
  "schedule.create": ["Schedule created", "fa-calendar-plus", "teal"],
  "schedule.update": ["Schedule changed", "fa-calendar-check", "amber"],
  "schedule.cancel": ["Schedule cancelled", "fa-calendar-xmark", "coral"],
  "schedule.restore": ["Schedule restored", "fa-calendar-check", "teal"],
  "schedule.delete": ["Schedule removed", "fa-calendar-minus", "coral"],
  "notice.create": ["Notice created", "fa-bullhorn", "teal"],
  "notice.update": ["Notice edited", "fa-bullhorn", ""],
  "notice.publish": ["Notice published", "fa-bullhorn", "teal"],
  "notice.unpublish": ["Notice unpublished", "fa-bullhorn", "amber"],
  "notice.delete": ["Notice deleted", "fa-bullhorn", "coral"],
  "homepage.update": ["Homepage content changed", "fa-house", "amber"],
  "subject.create": ["Subject created", "fa-book", "teal"],
  "subject.update": ["Subject updated", "fa-book", ""],
  "subject.delete": ["Subject deleted", "fa-book", "coral"],
  "category.create": ["Category created", "fa-folder-plus", "teal"],
  "category.update": ["Category updated", "fa-folder", ""],
  "category.delete": ["Category deleted", "fa-folder-minus", "coral"],
  "user.activate": ["Account activated", "fa-user-check", "teal"],
  "user.deactivate": ["Account deactivated", "fa-user-slash", "coral"],
  "user.roll": ["Roll number changed", "fa-id-badge", ""],
  "notification.send": ["Notification sent", "fa-bell", "teal"],
  "notification.update": ["Notification edited", "fa-bell", ""],
  "notification.delete": ["Notification deleted", "fa-bell-slash", "coral"],
  "settings.update": ["Settings updated", "fa-gear", "amber"],
  "admin.add": ["Admin added", "fa-user-shield", "teal"],
  "admin.role": ["Admin role changed", "fa-user-gear", "amber"],
  "admin.remove": ["Admin removed", "fa-user-xmark", "coral"],
  "logs.purge": ["Old logs deleted", "fa-broom", "coral"],
};
export const actionMeta = (a) => ACTIONS[a] || [a, "fa-circle-info", ""];

/** Fire-and-forget. type/id/label describe the thing acted on; detail is a short free-text note. */
export function logAction(action, { type = "", id = "", label = "", detail = "" } = {}) {
  if (!actor) return Promise.resolve(false);
  return addDoc(collection(db, COL), {
    at: serverTimestamp(),
    uid: actor.uid, name: actor.name || "", email: actor.email || "", role: actor.role || "super",
    action, targetType: type, targetId: String(id || ""),
    label: String(label || "").slice(0, 160), detail: String(detail || "").slice(0, 400),
  }).then(() => true).catch(() => false);
}

/** One page of logs, newest first. Pass the previous page's `last` as `after` for the next one. */
export async function fetchLogs({ pageSize = 25, after = null } = {}) {
  const q = query(collection(db, COL), orderBy("at", "desc"), ...(after ? [startAfter(after)] : []), limit(pageSize));
  const snap = await getDocs(q);
  return {
    rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    last: snap.docs[snap.docs.length - 1] || null,
    done: snap.docs.length < pageSize,
  };
}

/** Super-admin housekeeping: delete logs older than `days` (batches of 400). Returns how many were removed. */
export async function purgeLogsOlderThan(days) {
  const cutoff = Timestamp.fromMillis(Date.now() - days * 86400000);
  let removed = 0;
  for (;;) {
    const snap = await getDocs(query(collection(db, COL), where("at", "<", cutoff), limit(400)));
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    if (snap.size < 400) break;
  }
  return removed;
}
