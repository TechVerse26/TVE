// ==========================================================================
// exam-session.js — an exam attempt that survives a refresh, a closed app or a dead battery.
//
// The rules (what is saved, when time is up, what is stale …) are PURE and live in
// exam-session-core.js. This file is the thin browser layer around them:
//
//   • storage        localStorage only — 0 Firestore reads, 0 Firestore writes. Falls back to memory when the
//                    browser blocks storage (the attempt then simply can't outlive the page, as before).
//   • autosave       the question screen calls notifyStateChange() after every answer / move (exam-engine.js);
//                    one small synchronous write follows. Also flushed when the tab is hidden or closing.
//   • one tab        a heartbeat lock, so the same attempt opened in two tabs can never overwrite itself.
//   • resume screen  shown instead of the rules page when this device holds an unfinished attempt of the exam.
//   • banner         a slim bar under the top bar, on every page, while an attempt is waiting.
//
// exam.js decides what to DO with the answer of the resume screen (carry on / submit / start over).
// ==========================================================================
import { toast, confirmAction, escapeHtml, toBnDigits } from "./utils.js";
import { state, setStateChangeListener, snapshotQuestionTimes } from "./exam-engine.js";
import { serverNow, syncServerTimeSoon } from "./server-time.js";
import { parseHash } from "./router.js";
import {
  KEY_PREFIX, LOCK_BEAT_MS, sessionKey, lockKey, parseLock, makeLock, lockStatus,
  createSession, updateProgress, markSubmitted, parseSession, serializeSession, toRestorePlan,
  judge, describe, pickUrgent, clockLabel,
} from "./exam-session-core.js";

const CHANGED_EVENT = "tvexam:session-changed";
/** Identifies THIS page load (not the browser tab): a duplicated tab or a refresh gets a new one. */
const PAGE_ID = window.crypto?.randomUUID ? window.crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* ==========================================================================
   Storage
   ========================================================================== */
const memory = new Map();
const disk = () => { try { return window.localStorage; } catch { return null; } };
const store = {
  get(key) {
    try { const v = disk()?.getItem(key); if (v !== null && v !== undefined) return v; } catch { /* blocked */ }
    return memory.has(key) ? memory.get(key) : null;
  },
  set(key, value) {
    try { disk().setItem(key, value); memory.delete(key); return true; } catch { memory.set(key, value); return false; } // full / blocked → memory only
  },
  remove(key) {
    try { disk()?.removeItem(key); } catch { /* blocked */ }
    memory.delete(key);
  },
  keys(prefix) {
    const out = new Set();
    try { const l = disk(); for (let i = 0; l && i < l.length; i++) { const k = l.key(i); if (k && k.startsWith(prefix)) out.add(k); } } catch { /* blocked */ }
    for (const k of memory.keys()) if (k.startsWith(prefix)) out.add(k);
    return [...out];
  },
};

const announce = () => { try { document.dispatchEvent(new CustomEvent(CHANGED_EVENT)); } catch { /* old browser */ } };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The saved attempt of this student for this exam → { ok, session }. Corrupt / foreign / outdated data is deleted on the spot. */
export function loadSession(uid, examId) {
  const key = sessionKey(uid, examId);
  const result = parseSession(store.get(key), { uid, examId });
  if (!result.ok && result.reason !== "empty") store.remove(key);
  return result;
}

function writeSession(session) {
  const json = serializeSession(session);
  return json ? store.set(sessionKey(session.uid, session.examId), json) : false;
}

/** Every saved attempt of this student that is still worth something: [{ session, verdict }]. Stale / broken ones are removed. */
export function listSessions(uid) {
  const out = [];
  const now = serverNow();
  for (const key of store.keys(`${KEY_PREFIX}${uid}:`)) {
    const raw = store.get(key);
    const parsed = parseSession(raw, { uid });
    if (!parsed.ok) { store.remove(key); continue; }
    const verdict = judge(parsed.session, now);
    if (verdict.state === "stale") { store.remove(key); store.remove(lockKey(uid, parsed.session.examId)); continue; }
    out.push({ session: parsed.session, verdict });
  }
  return out;
}

/**
 * The attempt is over (stored, or thrown away): nothing is kept.
 * With an `attemptId`, only THAT attempt is removed — a late "saved!" for an old attempt (a slow save that finished after the
 * student had already started a retake) must never wipe the retake's saved copy.
 */
export function finishSession(uid, examId, attemptId = null) {
  if (!uid || !examId) return;
  if (attemptId) {
    const stored = parseSession(store.get(sessionKey(uid, examId)), { uid, examId });
    if (stored.ok && stored.session.attemptId !== attemptId) return; // a different (newer) attempt lives there now
    if (ctl && ctl.uid === uid && ctl.examId === examId && ctl.session.attemptId !== attemptId) return;
  }
  if (ctl && ctl.uid === uid && ctl.examId === examId) stopAutosave();
  store.remove(sessionKey(uid, examId));
  store.remove(lockKey(uid, examId));
  announce();
}

/* ==========================================================================
   One tab at a time
   ========================================================================== */
const readLock = (uid, examId) => parseLock(store.get(lockKey(uid, examId)));
const writeLock = (c) => store.set(lockKey(c.uid, c.examId), JSON.stringify(makeLock(PAGE_ID, serverNow())));
function releaseLock(c) {
  if (readLock(c.uid, c.examId)?.tab === PAGE_ID) store.remove(lockKey(c.uid, c.examId));
}

/* ==========================================================================
   Autosave
   ========================================================================== */
let ctl = null; // the attempt that is being saved right now: { uid, examId, session, lost, … }

function liveProgress() {
  return { answers: state.answers, locked: state.lockedQuestions, index: state.currentIndex, times: snapshotQuestionTimes() };
}

function loseTo(c) {
  if (c.lost) return;
  c.lost = true;
  toast("এই পরীক্ষা এখন আরেকটি ট্যাবে চলছে — এই ট্যাবের অগ্রগতি আর সেভ হবে না।", "error");
}

function saveNow(c) {
  if (ctl !== c || c.lost) return false;
  const now = serverNow();
  if (lockStatus(readLock(c.uid, c.examId), PAGE_ID, now) === "other") { loseTo(c); return false; } // never overwrite a live tab's newer answers
  c.session = updateProgress(c.session, { ...liveProgress(), now });
  return writeSession(c.session);
}

function startAutosave(session) {
  stopAutosave();
  const c = { uid: session.uid, examId: session.examId, session, lost: false };
  ctl = c;
  writeLock(c);
  setStateChangeListener(() => saveNow(c));
  c.beat = setInterval(() => {
    if (lockStatus(readLock(c.uid, c.examId), PAGE_ID, serverNow()) === "other") loseTo(c);
    else writeLock(c);
  }, LOCK_BEAT_MS);
  c.onHide = () => { if (document.visibilityState === "hidden") saveNow(c); };
  c.onPageHide = () => { saveNow(c); releaseLock(c); }; // a refresh frees the lock at once — the next load must not wait for it to expire
  document.addEventListener("visibilitychange", c.onHide);
  window.addEventListener("pagehide", c.onPageHide);
  saveNow(c);
}

/** Stops saving (leaving the exam page, submitting, starting another attempt). The saved attempt itself stays. */
export function stopAutosave() {
  const c = ctl;
  if (!c) return;
  ctl = null;
  clearInterval(c.beat);
  document.removeEventListener("visibilitychange", c.onHide);
  window.removeEventListener("pagehide", c.onPageHide);
  setStateChangeListener(null);
  releaseLock(c);
}

/** A brand-new attempt starts: save it from the very first moment. */
export function beginSession({ uid, examId, attemptId, durationSec, attemptsSoFar, layout, exam, questions }) {
  if (!uid) return null;
  const session = createSession({ uid, examId, attemptId, now: serverNow(), durationSec, attemptsSoFar, layout, exam, questions });
  startAutosave(session);
  announce();
  return session;
}

/** A saved attempt was resumed: keep saving it. */
export function attachSession(session) {
  startAutosave(session);
  announce();
}

/**
 * The student submitted (or the timer did). The attempt is kept — flagged "submitted" — until the result is really stored;
 * exam.js calls finishSession() then. Works for a running attempt and for a recovered one (expired / unsaved).
 */
export function markSessionSubmitted({ uid, examId, attemptId, leftSec, auto }) {
  if (!uid || !examId) return false;
  let session = null;
  if (ctl && ctl.uid === uid && ctl.examId === examId && (!attemptId || ctl.session.attemptId === attemptId)) {
    if (ctl.lost) { stopAutosave(); return false; } // another tab owns this attempt: its copy is the truth
    saveNow(ctl); // the very last answer
    session = ctl.session;
    stopAutosave();
  } else {
    const loaded = loadSession(uid, examId);
    session = loaded.ok && (!attemptId || loaded.session.attemptId === attemptId) ? loaded.session : null;
  }
  if (!session) return false;
  if (session.phase === "submitted") return true;
  writeSession(markSubmitted(session, { now: serverNow(), leftSec, auto }));
  announce();
  return true;
}

/* ==========================================================================
   Styles — injected once, flat, built from the design tokens in base.css (no glow / blur / gradient / heavy shadow)
   ========================================================================== */
const STYLE_ID = "rs-styles";
const CSS = `
#resume-banner-root:empty { display: none; }
.rsb { background: var(--tint-accent); border-bottom: 1px solid var(--border); }
.rsb--warn { background: var(--tint-amber); }
.rsb-in { display: flex; align-items: center; gap: var(--sp-3); padding-block: var(--sp-3); }
.rsb-ico { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-sm); background: var(--accent); color: #fff; font-size: 0.95rem; }
.rsb--warn .rsb-ico { background: var(--accent-amber); }
.rsb-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rsb-txt b { font-size: var(--fs-md); color: var(--text-primary); line-height: 1.3; }
.rsb-sub { font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rsb-clock { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--accent); }
.rsb-go { flex: none; }
.rsb-x { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); font-size: 1.5rem; line-height: 1; cursor: pointer; }
.rsb-x:hover { background: var(--bg-elevated-2); color: var(--text-primary); }
.rs-stats { grid-template-columns: repeat(3, 1fr); }
.rs-stats .exs-rules-stat { padding-inline: var(--sp-2); }
.rs-note { margin: 0 0 var(--sp-5); font-size: var(--fs-md); line-height: 1.65; color: var(--text-muted); }
.rs-clock { font-variant-numeric: tabular-nums; }
@media (max-width: 480px) {
  .rsb-in { flex-wrap: wrap; }
  .rsb-txt { flex-basis: calc(100% - 36px - var(--sp-3) - 36px - var(--sp-3)); }
  .rsb-go { order: 3; flex: 1 1 100%; justify-content: center; }
}
@media (max-width: 360px) { .rs-stats .exs-rules-stat b { font-size: 1rem; } .rs-stats .exs-rules-stat span { font-size: 0.72rem; } }
`;
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ==========================================================================
   Texts (one place — change the wording here)
   ========================================================================== */
const TEXT = {
  resume: {
    icon: "fa-rotate-left", title: "আপনার পরীক্ষা চলছে",
    note: "এই ডিভাইসে আপনার উত্তরগুলো সংরক্ষিত আছে। টাইমার থামেনি — যে সময় বাকি আছে তা থেকেই চালিয়ে যেতে পারবেন।",
    primary: "চালিয়ে যান", discard: "নতুন করে শুরু",
    statLabel: "বাকি সময়",
    confirm: { title: "নতুন করে শুরু করবেন?", message: "সংরক্ষিত উত্তরগুলো মুছে যাবে এবং পরীক্ষা পুরো সময় থেকে নতুন করে শুরু হবে।", confirmLabel: "হ্যাঁ, নতুন করে শুরু", cancelLabel: "ফিরে যাই" },
  },
  expired: {
    icon: "fa-hourglass-end", title: "পরীক্ষার সময় শেষ হয়ে গেছে",
    note: "সময় থাকতে আপনি যে উত্তরগুলো দিয়েছিলেন সেগুলো সংরক্ষিত আছে। এখন জমা দিন — বাকি প্রশ্নগুলো \"উত্তর দেওয়া হয়নি\" ধরা হবে।",
    primary: "উত্তর জমা দিন", discard: "বাদ দিন",
    statLabel: "সময়",
    confirm: { title: "বাদ দিতে চান?", message: "সংরক্ষিত উত্তরগুলো মুছে যাবে এবং এই অ্যাটেম্পটের কোনো ফলাফল থাকবে না।", confirmLabel: "হ্যাঁ, বাদ দিন", cancelLabel: "ফিরে যাই" },
  },
  unsaved: {
    icon: "fa-cloud-arrow-up", title: "ফলাফল সেভ হয়নি",
    note: "আপনার পরীক্ষা জমা হয়েছিল, কিন্তু ফলাফল সার্ভারে সেভ হতে পারেনি — সম্ভবত তখন ইন্টারনেট ছিল না। ইন্টারনেট চালু থাকলে এখনই আবার সেভ করুন।",
    primary: "ফলাফল সেভ করুন", discard: "বাদ দিন",
    statLabel: "অবস্থা",
    confirm: { title: "বাদ দিতে চান?", message: "সংরক্ষিত উত্তরগুলো মুছে যাবে এবং এই অ্যাটেম্পটের কোনো ফলাফল থাকবে না।", confirmLabel: "হ্যাঁ, বাদ দিন", cancelLabel: "ফিরে যাই" },
  },
};

const statValue = (v) => (v.state === "resume" ? clockLabel(v.left) : v.state === "expired" ? "শেষ" : "সেভ বাকি");

/* ==========================================================================
   The resume screen (shown on the exam's own page, in place of the rules page)
   ========================================================================== */
function gateHtml(v) {
  const t = TEXT[v.state];
  return `
    <div class="exs-verify-card rs-card" data-rs-state="${v.state}">
      <div class="exs-verify-head exs-verify-head--ok">
        <i class="fa-solid ${t.icon}" aria-hidden="true"></i>
        <div><h2>${t.title}</h2><p>${escapeHtml(v.title)}</p></div>
      </div>
      <div class="exs-rules-stats rs-stats">
        <div class="exs-rules-stat"><span>${t.statLabel}</span><b class="rs-clock" data-rs-clock>${statValue(v)}</b></div>
        <div class="exs-rules-stat"><span>উত্তর দেওয়া</span><b>${toBnDigits(v.answered)}/${toBnDigits(v.total)}</b></div>
        <div class="exs-rules-stat"><span>মোট প্রশ্ন</span><b>${toBnDigits(v.total)}</b></div>
      </div>
      <p class="rs-note">${t.note}</p>
      <div class="exs-rules-actions">
        <button type="button" class="btn btn-outline btn-block" data-rs="discard">${t.discard}</button>
        <button type="button" class="btn btn-primary btn-block" data-rs="primary">${t.primary}</button>
      </div>
    </div>`;
}

/** Resolves "primary" | "discard" | "away" | "stale". Keeps the clock on the card ticking, and redraws it if the time runs out meanwhile. */
function renderGate(container, session, isCurrent) {
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    let shown = "";
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      window.removeEventListener("hashchange", onAway);
      resolve(value);
    };
    const onAway = () => finish("away");
    window.addEventListener("hashchange", onAway);

    const paint = () => {
      const v = describe(session, serverNow());
      if (v.state === "stale") { finish("stale"); return; }
      shown = v.state;
      container.innerHTML = gateHtml(v);
      container.querySelector('[data-rs="primary"]').addEventListener("click", () => finish("primary"));
      container.querySelector('[data-rs="discard"]').addEventListener("click", async () => {
        if (await confirmAction(TEXT[shown].confirm.message, TEXT[shown].confirm)) finish("discard");
      });
      container.querySelector('[data-rs="primary"]').focus({ preventScroll: true });
    };
    paint();

    timer = setInterval(() => {
      if (!isCurrent()) { finish("away"); return; }
      const v = describe(session, serverNow());
      if (v.state !== shown) { paint(); return; } // the time ran out while the card was open
      const clock = container.querySelector("[data-rs-clock]");
      if (clock && v.state === "resume") clock.textContent = clockLabel(v.left);
    }, 1000);
  });
}

/** "This exam is open in another tab" — waits (and re-checks by itself) until that tab is gone. Resolves "free" | "away". */
function renderBusy(container, uid, examId, isCurrent) {
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      window.removeEventListener("hashchange", onAway);
      resolve(value);
    };
    const onAway = () => finish("away");
    window.addEventListener("hashchange", onAway);
    container.innerHTML = `
      <div class="exs-verify-card rs-card" data-rs-state="busy">
        <div class="exs-verify-head">
          <i class="fa-solid fa-clone" aria-hidden="true"></i>
          <div><h2>পরীক্ষাটি আরেকটি ট্যাবে চলছে</h2><p>একই পরীক্ষা দুই জায়গায় চালানো যায় না</p></div>
        </div>
        <p class="rs-note">এই ব্রাউজারের আরেকটি ট্যাব বা উইন্ডোতে পরীক্ষাটি চালু আছে — সেখানেই চালিয়ে যান। সেটি বন্ধ করলে এখানে নিজে থেকেই চালু হবে।</p>
        <div class="exs-rules-actions">
          <a href="#/exam" class="btn btn-outline btn-block">সব এক্সাম দেখুন</a>
          <button type="button" class="btn btn-primary btn-block" data-rs="retry">আবার দেখুন</button>
        </div>
      </div>`;
    const check = () => {
      if (!isCurrent()) { finish("away"); return; }
      if (lockStatus(readLock(uid, examId), PAGE_ID, serverNow()) !== "other") finish("free");
    };
    container.querySelector('[data-rs="retry"]').addEventListener("click", check);
    timer = setInterval(check, 1500);
  });
}

/** A result that was submitted a moment ago is being stored right now and removes itself within seconds — give it a moment instead of asking the student about it. */
async function settleJustSubmitted(uid, examId, loaded) {
  const fresh = (l) => l.ok && l.session.phase === "submitted" && serverNow() - (l.session.submittedAt || 0) < 20000;
  let current = loaded;
  for (let i = 0; i < 12 && fresh(current); i++) {
    await wait(250);
    current = loadSession(uid, examId);
  }
  return current;
}

/**
 * Called when the student opens an exam. If this device holds an unfinished attempt of it:
 *   { action: "resume", plan, session }  carry on          { action: "submit", plan, session }  submit / store what was saved
 *   { action: "away" }                   they left the page { action: "fresh" }                  nothing saved (or they chose to start over)
 */
export async function checkSavedAttempt(container, examId, { uid, isCurrent = () => true } = {}) {
  if (!uid || !examId) return { action: "fresh" };
  await syncServerTimeSoon(1200); // judge the clock by the server's time, not by a phone whose clock may be wrong
  if (!isCurrent()) return { action: "away" };

  let loaded = await settleJustSubmitted(uid, examId, loadSession(uid, examId));
  if (!isCurrent()) return { action: "away" };
  if (!loaded.ok) return { action: "fresh" };

  if (judge(loaded.session, serverNow()).state === "stale") { finishSession(uid, examId); return { action: "fresh" }; }

  // Running in another tab right now? Wait for it instead of fighting over the same attempt.
  while (lockStatus(readLock(uid, examId), PAGE_ID, serverNow()) === "other") {
    const outcome = await renderBusy(container, uid, examId, isCurrent);
    if (outcome === "away" || !isCurrent()) return { action: "away" };
  }
  loaded = loadSession(uid, examId); // the other tab may have finished meanwhile
  if (!loaded.ok) return { action: "fresh" };

  const choice = await renderGate(container, loaded.session, isCurrent);
  if (choice === "away" || !isCurrent()) return { action: "away" };
  if (choice === "discard" || choice === "stale") { finishSession(uid, examId); return { action: "fresh" }; }

  const now = serverNow();
  const state0 = judge(loaded.session, now).state;
  return { action: state0 === "resume" ? "resume" : "submit", plan: toRestorePlan(loaded.session, now), session: loaded.session };
}

/* ==========================================================================
   The banner (every page while an attempt is waiting)
   ========================================================================== */
const BANNER = {
  resume: (v) => ({ icon: "fa-stopwatch", warn: false, head: "চলমান পরীক্ষা", sub: `${escapeHtml(v.title)} — বাকি <span class="rsb-clock" data-rsb-clock>${clockLabel(v.left)}</span>`, go: "চালিয়ে যান" }),
  expired: (v) => ({ icon: "fa-hourglass-end", warn: true, head: "পরীক্ষার সময় শেষ হয়েছে", sub: `${escapeHtml(v.title)} — ${toBnDigits(v.answered)}টি উত্তর সংরক্ষিত আছে`, go: "উত্তর জমা দিন" }),
  unsaved: (v) => ({ icon: "fa-cloud-arrow-up", warn: true, head: "ফলাফল সেভ হয়নি", sub: escapeHtml(v.title), go: "ফলাফল সেভ করুন" }),
};

/**
 * Keeps a slim "your exam is waiting" bar under the top bar on every page. `getUid` says whose attempts to look for.
 * Returns { refresh } — call it when the signed-in user changes. Hidden on login / sign-up and on an exam's own page
 * (the resume screen / the exam itself takes over there).
 */
export function mountResumeBanner({ getUid }) {
  injectStyles();
  let root = document.getElementById("resume-banner-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "resume-banner-root";
    const nav = document.getElementById("topnav-root");
    if (nav) nav.insertAdjacentElement("afterend", root);
    else document.body.prepend(root);
  }
  let tick = null;

  const hide = () => { clearInterval(tick); tick = null; root.innerHTML = ""; };

  function refresh() {
    const uid = getUid();
    const { route, params } = parseHash();
    const quiet = !uid || route === "login" || route === "signup" || (route === "exam" && params.get("id"));
    const urgent = quiet ? null : pickUrgent(listSessions(uid));
    if (!urgent) { hide(); return; }

    const v = describe(urgent.session, serverNow());
    const b = BANNER[v.state](v);
    root.innerHTML = `
      <div class="rsb${b.warn ? " rsb--warn" : ""}" role="status">
        <div class="container rsb-in">
          <span class="rsb-ico" aria-hidden="true"><i class="fa-solid ${b.icon}"></i></span>
          <div class="rsb-txt"><b>${b.head}</b><span class="rsb-sub">${b.sub}</span></div>
          <a class="btn btn-primary btn-sm rsb-go" href="#/exam?id=${encodeURIComponent(v.examId)}">${b.go}</a>
          <button type="button" class="rsb-x" aria-label="বাদ দিন" title="বাদ দিন"><span aria-hidden="true">&times;</span></button>
        </div>
      </div>`;
    root.querySelector(".rsb-x").addEventListener("click", async () => {
      if (await confirmAction(TEXT[v.state].confirm.message, TEXT[v.state].confirm)) finishSession(uid, v.examId);
    });

    clearInterval(tick);
    tick = null;
    if (v.state === "resume") {
      tick = setInterval(() => {
        const now = describe(urgent.session, serverNow());
        if (now.state !== "resume") { refresh(); return; } // time ran out → the bar changes to "submit your answers"
        const el = root.querySelector("[data-rsb-clock]");
        if (el) el.textContent = clockLabel(now.left);
      }, 1000);
    }
  }

  window.addEventListener("hashchange", refresh);
  document.addEventListener(CHANGED_EVENT, refresh);
  window.addEventListener("storage", (e) => { if (!e.key || e.key.startsWith(KEY_PREFIX)) refresh(); }); // another tab started / finished an attempt
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
  return { refresh };
}
