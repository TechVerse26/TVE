'use strict';
// ==========================================================================
// server/push/audience.js — "who exactly gets this?"  Turns the admin's choice into a list of DEVICE ids.
//
//   all      every active device (minus the ones that switched this notification type off)
//   user     one student's devices
//   exam     students of an exam = enrolled in the exam's course (no course = every student); admin & deactivated accounts skipped
//            filter: all · not_submitted (no result document yet) · submitted
//   section / level   students who hold access to the section/level (or anything below it) + students who took an exam placed in it
//
// Only devices with status "active" whose owner has not switched that notification type off are ever returned.
// ==========================================================================
const { COL } = require('./store');
const { bad, notFound } = require('./errors');

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const eligible = (d, category, ignorePrefs) => !!d && d.status === 'active' && !!d.token && (ignorePrefs || !d.prefs || d.prefs[category] !== false);

async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function getData(ctx, col, id) {
  const snap = await ctx.db.collection(col).doc(id).get();
  return snap.exists ? snap.data() : null;
}

/** One cheap read to confirm the thing exists and to get a readable name for the history. */
async function describeAudience(ctx, a) {
  switch (a.type) {
    case 'all': return { label: 'All subscribed students' };
    case 'user': {
      const u = await getData(ctx, 'users', a.uid);
      if (!u) throw notFound('student_not_found', 'That student does not exist.');
      return { label: `Student: ${u.displayName || u.email || a.uid}` };
    }
    case 'exam': {
      const e = await getData(ctx, 'exams', a.examId);
      if (!e) throw notFound('exam_not_found', 'That exam does not exist.');
      const f = { all: '', not_submitted: ' · not yet submitted', submitted: ' · already submitted' }[a.filter || 'all'];
      return { label: `Exam: ${e.title || a.examId}${f}` };
    }
    case 'section': {
      const s = await getData(ctx, 'academicSections', a.sectionId);
      if (!s) throw notFound('node_not_found', 'That section does not exist.');
      return { label: `Section: ${s.name || a.sectionId}` };
    }
    case 'level': {
      const l = await getData(ctx, 'academicLevels', a.levelId);
      if (!l) throw notFound('node_not_found', 'That level does not exist.');
      return { label: `Level: ${l.name || a.levelId}` };
    }
    default: throw bad('invalid_audience', 'Unknown audience.');
  }
}

/* ---------- students → devices ---------- */
async function devicesOfUids(ctx, uids, category, ignorePrefs) {
  const ids = [];
  await mapLimit(chunk([...new Set(uids)], ctx.cfg.uidBatch), 6, async (batch) => {
    const snap = await ctx.db.collection(COL.devices).where('uid', 'in', batch).get();
    snap.docs.forEach((d) => { if (eligible(d.data(), category, ignorePrefs)) ids.push(d.id); });
  });
  return ids;
}

async function allActiveDevices(ctx, category, ignorePrefs, excludeUids) {
  const snap = await ctx.db.collection(COL.devices).where('status', '==', 'active').get();
  const skip = excludeUids || null;
  return snap.docs.filter((d) => eligible(d.data(), category, ignorePrefs) && !(skip && skip.has(d.data().uid))).map((d) => d.id);
}

/* ---------- students of an exam / section / level ---------- */
async function examStudents(ctx, a) {
  const exam = await getData(ctx, 'exams', a.examId);
  if (!exam) throw notFound('exam_not_found', 'That exam does not exist.');
  const courseId = exam.courseId || '';
  let enrolled = null; // null = open to every student
  if (courseId) {
    const snap = await ctx.db.collection('users').where('enrolledCourses', 'array-contains', courseId).get();
    enrolled = new Set(snap.docs.filter((d) => d.data().isAdmin !== true && d.data().disabled !== true).map((d) => d.id));
  }
  const filter = a.filter || 'all';
  if (filter === 'all') return enrolled ? { uids: [...enrolled] } : { all: true };
  const res = await ctx.db.collection('results').where('examId', '==', a.examId).get();
  const submitted = new Set(res.docs.map((d) => d.data().uid).filter(Boolean));
  if (filter === 'submitted') return { uids: enrolled ? [...enrolled].filter((u) => submitted.has(u)) : [...submitted] };
  return enrolled ? { uids: [...enrolled].filter((u) => !submitted.has(u)) } : { all: true, exclude: submitted };
}

async function nodeStudents(ctx, a) {
  const isLevel = a.type === 'level';
  const id = isLevel ? a.levelId : a.sectionId;
  const node = await getData(ctx, isLevel ? 'academicLevels' : 'academicSections', id);
  if (!node) throw notFound('node_not_found', 'That section / level does not exist.');
  const db = ctx.db;
  const nodeIds = new Set([id]);
  if (isLevel && node.sectionId) nodeIds.add(node.sectionId); // an entitlement on the section covers its levels
  if (isLevel) {
    (await db.collection('academicSubjects').where('levelId', '==', id).get()).docs.forEach((d) => nodeIds.add(d.id));
  } else {
    (await db.collection('academicLevels').where('sectionId', '==', id).get()).docs.forEach((d) => nodeIds.add(d.id));
    (await db.collection('academicSubjects').where('sectionId', '==', id).get()).docs.forEach((d) => nodeIds.add(d.id));
  }
  const uids = new Set();
  await mapLimit(chunk([...nodeIds], ctx.cfg.uidBatch), 4, async (batch) => {
    (await db.collection('academicEntitlements').where('nodeId', 'in', batch).get()).docs.forEach((d) => { if (d.data().uid) uids.add(d.data().uid); });
  });
  const exams = await db.collection('exams').where(isLevel ? 'academicLevelId' : 'academicProgramId', '==', id).select().get();
  await mapLimit(chunk(exams.docs.map((d) => d.id), ctx.cfg.uidBatch), 4, async (batch) => {
    (await db.collection('results').where('examId', 'in', batch).get()).docs.forEach((d) => { if (d.data().uid) uids.add(d.data().uid); });
  });
  return { uids: [...uids] };
}

/**
 * → { deviceIds, students }   students = number of students behind the devices when known (null for "everybody")
 * Throws audience_too_large when the list would pass the safety cap.
 */
async function resolveAudience(ctx, a, { category, ignorePrefs = false }) {
  let deviceIds;
  let students = null;
  if (a.type === 'all') {
    deviceIds = await allActiveDevices(ctx, category, ignorePrefs, null);
  } else if (a.type === 'user') {
    deviceIds = await devicesOfUids(ctx, [a.uid], category, ignorePrefs);
    students = 1;
  } else {
    const r = a.type === 'exam' ? await examStudents(ctx, a) : await nodeStudents(ctx, a);
    if (r.all) {
      deviceIds = await allActiveDevices(ctx, category, ignorePrefs, r.exclude || null);
    } else {
      students = r.uids.length;
      deviceIds = r.uids.length ? await devicesOfUids(ctx, r.uids, category, ignorePrefs) : [];
    }
  }
  if (deviceIds.length > ctx.cfg.limits.maxRecipients) {
    throw bad('audience_too_large', `This audience has ${deviceIds.length} devices; the safety limit is ${ctx.cfg.limits.maxRecipients}. Narrow it down.`);
  }
  return { deviceIds, students };
}

/** Numbers for the composer ("this will reach …"). "All" uses cheap count queries instead of reading every device. */
async function previewAudience(ctx, a, category) {
  const described = await describeAudience(ctx, a);
  if (a.type === 'all' && ctx.db.collection(COL.devices).where('status', '==', 'active').count) {
    try {
      const col = ctx.db.collection(COL.devices);
      const active = (await col.where('status', '==', 'active').count().get()).data().count;
      const off = (await col.where('status', '==', 'active').where(`prefs.${category}`, '==', false).count().get()).data().count;
      return { label: described.label, devices: Math.max(0, active - off), students: null, optedOut: off };
    } catch (e) { ctx.log('warn', 'count() unavailable — falling back to a full read', { error: String(e && e.message).slice(0, 160) }); }
  }
  const r = await resolveAudience(ctx, a, { category });
  return { label: described.label, devices: r.deviceIds.length, students: r.students, optedOut: null };
}

module.exports = { describeAudience, resolveAudience, previewAudience, eligible, chunk, mapLimit };
