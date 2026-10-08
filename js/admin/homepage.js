// ==========================================================================
// admin/homepage.js — everything an admin controls on the STUDENT HOME PAGE, in one place.
//
//   Hero text · CTA label · important information · promotional banner · today's motivation ·
//   exam guidelines · show/hide for every section · leaderboard name privacy · featured exams · category names
//
// All text is stored in homeFeed/main.content (one small document students read once per 5 minutes together
// with the exam list). Featured is a flag on the exam itself. Nothing here can break the student site:
// whatever is stored is normalised on read (home-core.normalizeContent) and falls back to sensible defaults.
// ==========================================================================
import { toast } from "../utils.js";
import { fetchAllExamsAdmin } from "../exam-data.js";
import { esc, $, pageHead, chip, withBusy, errorState, skeleton, confirmDanger, isDenied, rulesHint } from "./core/ui.js";
import { can } from "./core/permissions.js";
import { logAction } from "./core/audit.js";
import { onChange } from "./core/bus.js";
import { loadTaxonomy, getTaxonomy, publishTaxonomyMirror } from "./core/taxonomy.js";
import { getSettings } from "./core/settings.js";
import { patchExamFields } from "./core/exam-ops.js";
import { getHomeFeed, writeFeedFields } from "../home-data.js";
import { SECTION_KEYS, SECTION_LABELS, DEFAULT_GUIDELINES, DEFAULT_MOTIVATIONS, normalizeContent, normalizeTaxonomy, safeHref } from "../home-core.js";

let root = null, feed = null, exams = [], loadFailed = false;

const lines = (v) => String(v || "").split("\n").map((x) => x.trim()).filter(Boolean);
const taxSig = (t) => JSON.stringify(normalizeTaxonomy(t));

export async function mount(el) {
  root = el;
  root.innerHTML = `${pageHead({ title: "Homepage", desc: "শিক্ষার্থীদের হোমপেজে কী কী দেখাবে — লেখা, সেকশন, ফিচার্ড এক্সাম ও নিয়মাবলি এখান থেকেই বদলান।" })}<div id="hp-body">${skeleton(5)}</div>`;
  root.addEventListener("click", onClick);
  onChange((kind) => { if (kind === "exams" && feed) renderFeatured(); });
  await load();
}
export async function activate() { if (loadFailed) load(); }

async function load() {
  try {
    const [f, all] = await Promise.all([getHomeFeed({ force: true }), fetchAllExamsAdmin().catch(() => []), loadTaxonomy().catch(() => {})]);
    if (f.ok === false && f.error && isDenied(f.error)) { $("#hp-body", root).innerHTML = rulesHint("Homepage (homeFeed)"); loadFailed = true; return; }
    feed = f; exams = all; loadFailed = false;
    render();
    autoSyncTaxonomy();
  } catch (err) {
    loadFailed = true;
    $("#hp-body", root).innerHTML = errorState({ title: "হোমপেজ সেটিংস লোড করা যায়নি", text: err?.message || "" });
    root.querySelector("[data-retry]")?.addEventListener("click", load);
  }
}

function render() {
  const c = feed.content;
  const canEdit = can("homepage.manage");
  const dis = canEdit ? "" : "disabled";
  const sw = (id, label, on) => `<label class="switch-row"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${dis}> ${esc(label)}</label>`;
  $("#hp-body", root).innerHTML = `
    <div class="note">${canEdit ? "বদলগুলো “Save changes” চাপলেই শিক্ষার্থীদের কাছে যাবে (সর্বোচ্চ ৫ মিনিটের মধ্যে — ক্যাশ)।" : "আপনার শুধু দেখার অনুমতি আছে।"}
      <a href="index.html#/home" target="_blank" rel="noopener">Open the student home page <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
    <div class="grid-2 mt-16">
      <div class="panel pad"><h3 class="panel-title">Hero</h3>
        <div class="field"><label for="hp-title">Hero title</label><input type="text" id="hp-title" maxlength="120" value="${esc(c.heroTitle)}" ${dis}></div>
        <div class="field"><label for="hp-sub">Hero subtitle <span class="muted">(optional)</span></label><input type="text" id="hp-sub" maxlength="220" value="${esc(c.heroSubtitle)}" ${dis}></div>
        <div class="field"><label for="hp-cta">Main button text</label><input type="text" id="hp-cta" maxlength="30" value="${esc(c.ctaText)}" ${dis}><span class="form-hint">Shown when there is an exam students can start (default “Start Exam”).</span></div>
      </div>
      <div class="panel pad"><h3 class="panel-title">Important information</h3>
        <div class="field"><label for="hp-info">Message <span class="muted">(empty = hidden)</span></label><textarea id="hp-info" rows="3" maxlength="400" ${dis}>${esc(c.info)}</textarea></div>
        <h3 class="panel-title mt-16">Promotional banner</h3>
        ${sw("hp-ban-on", "Show the banner", c.banner.enabled)}
        <div class="admin-grid">
          <div class="field"><label for="hp-ban-t">Title</label><input type="text" id="hp-ban-t" maxlength="90" value="${esc(c.banner.title)}" ${dis}></div>
          <div class="field"><label for="hp-ban-l">Button text</label><input type="text" id="hp-ban-l" maxlength="30" value="${esc(c.banner.linkText)}" ${dis}></div>
        </div>
        <div class="field"><label for="hp-ban-x">Text</label><input type="text" id="hp-ban-x" maxlength="240" value="${esc(c.banner.text)}" ${dis}></div>
        <div class="field"><label for="hp-ban-k">Link</label><input type="text" id="hp-ban-k" maxlength="300" placeholder="#/schedule  or  https://…" value="${esc(c.banner.link)}" ${dis}><span class="form-hint" id="hp-ban-hint">Only in-app links (<code>#/exams</code>, <code>#/schedule</code> …) and http(s) links are allowed.</span></div>
      </div>
      <div class="panel pad"><h3 class="panel-title">Today's motivation</h3>
        <div class="field"><label for="hp-mot-pin">Pinned message <span class="muted">(optional)</span></label><input type="text" id="hp-mot-pin" maxlength="200" value="${esc(c.motivation.pinned)}" ${dis}><span class="form-hint">If filled, this is shown every day. Leave empty to rotate the list below.</span></div>
        <div class="field"><label for="hp-mot-rot">Daily rotation <span class="muted">(one per line)</span></label><textarea id="hp-mot-rot" rows="5" ${dis} placeholder="${esc(DEFAULT_MOTIVATIONS.slice(0, 2).join("\n"))}">${esc(c.motivation.rotation.join("\n"))}</textarea><span class="form-hint">Empty = the built-in messages. One message per day, in order.</span></div>
      </div>
      <div class="panel pad"><h3 class="panel-title">Exam guidelines</h3>
        <div class="field"><label for="hp-guide">Guidelines <span class="muted">(one per line)</span></label><textarea id="hp-guide" rows="8" ${dis} placeholder="${esc(DEFAULT_GUIDELINES.join("\n"))}">${esc(c.guidelines.join("\n"))}</textarea><span class="form-hint">Empty = the standard six guidelines.</span></div>
        ${canEdit ? '<button type="button" class="btn btn-outline btn-sm" data-act="fill-guidelines"><i class="fa-solid fa-wand-magic-sparkles"></i> Fill with the standard guidelines to edit</button>' : ""}
      </div>
      <div class="panel pad"><h3 class="panel-title">Sections on the home page</h3>
        <p class="muted" style="font-size:.84rem;margin-bottom:8px">Turn a section off to hide it for everyone. Sections with no data hide themselves anyway.</p>
        <div class="check-grid">${SECTION_KEYS.map((k) => sw(`hp-sec-${k}`, SECTION_LABELS[k], c.sections[k] !== false)).join("")}</div>
      </div>
      <div class="panel pad"><h3 class="panel-title">Leaderboard privacy</h3>
        <p class="muted" style="font-size:.84rem;margin-bottom:8px">How student names appear in “Top Performers”. Applied when the list is published (whenever you open <b>Leaderboard</b>).</p>
        ${[["full", "Full names"], ["first", "First name + initial (Rahim U.)"], ["hidden", "Hide names — only each student's own rank"]].map(([v, t]) => `<label class="switch-row"><input type="radio" name="hp-names" value="${v}" ${c.leaderboardNames === v ? "checked" : ""} ${dis}> ${t}</label>`).join("")}
      </div>
      <div class="panel pad"><h3 class="panel-title">Category names for students</h3>
        <div id="hp-tax"></div>
      </div>
    </div>
    <div class="panel pad mt-16"><h3 class="panel-title">Featured exams</h3>
      <p class="muted" style="font-size:.84rem;margin-bottom:8px">Featured exams get a prominent card on the home page. Each switch saves immediately.</p>
      <div id="hp-featured"></div>
    </div>
    ${canEdit ? `<div class="savebar"><button type="button" class="btn btn-outline" data-act="restore"><i class="fa-solid fa-rotate-left"></i> Restore defaults</button><button type="button" class="btn btn-primary" id="hp-save" data-act="save"><i class="fa-solid fa-floppy-disk"></i> Save changes</button></div>` : ""}`;
  renderFeatured();
  renderTaxStatus();
  const link = $("#hp-ban-k", root), hint = $("#hp-ban-hint", root);
  link?.addEventListener("input", () => { const bad = link.value.trim() && !safeHref(link.value); hint.classList.toggle("bad-text", !!bad); hint.textContent = bad ? "এই লিংকটি অনুমোদিত নয় — #/… বা https://… ব্যবহার করুন।" : "Only in-app links (#/exams, #/schedule …) and http(s) links are allowed."; });
}

function readForm() {
  const v = (id) => $(`#${id}`, root)?.value ?? "";
  const sections = {};
  SECTION_KEYS.forEach((k) => { sections[k] = !!$(`#hp-sec-${k}`, root)?.checked; });
  return normalizeContent({
    heroTitle: v("hp-title"), heroSubtitle: v("hp-sub"), ctaText: v("hp-cta"), info: v("hp-info"),
    banner: { enabled: !!$("#hp-ban-on", root)?.checked, title: v("hp-ban-t"), text: v("hp-ban-x"), linkText: v("hp-ban-l"), link: safeHref(v("hp-ban-k")) },
    motivation: { pinned: v("hp-mot-pin"), rotation: lines(v("hp-mot-rot")) },
    guidelines: lines(v("hp-guide")),
    sections,
    leaderboardNames: root.querySelector('input[name="hp-names"]:checked')?.value || "full",
  });
}

async function save(btn) {
  const link = $("#hp-ban-k", root)?.value.trim();
  if (link && !safeHref(link)) { toast("ব্যানারের লিংকটি অনুমোদিত নয়", "error"); return; }
  const content = readForm();
  await withBusy(btn, async () => {
    try {
      await writeFeedFields({ content });
      feed = await getHomeFeed({ force: true });
      logAction("homepage.update", { type: "homepage", id: "content", label: "Homepage content", detail: `${SECTION_KEYS.filter((k) => content.sections[k] === false).length} section(s) hidden` });
      toast("হোমপেজ আপডেট হয়েছে", "success");
    } catch (err) { toast(isDenied(err) ? "অনুমতি নেই — firestore.rules (homeFeed) পাবলিশ করুন" : "সেভ করা যায়নি", "error"); }
  });
}

async function onClick(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "save") return save(b);
  if (act === "fill-guidelines") { const t = $("#hp-guide", root); if (!t.value.trim()) t.value = DEFAULT_GUIDELINES.join("\n"); t.focus(); return; }
  if (act === "restore") {
    if (!(await confirmDanger({ title: "ডিফল্টে ফিরবেন?", message: "হোমপেজের সব লেখা ও সেকশন সেটিং ডিফল্ট অবস্থায় ফিরে যাবে (ফিচার্ড এক্সাম ও নোটিশ অপরিবর্তিত থাকবে)।", confirmLabel: "Restore defaults", tone: "amber" }))) return;
    try { await writeFeedFields({ content: normalizeContent({}) }); feed = await getHomeFeed({ force: true }); render(); logAction("homepage.update", { type: "homepage", id: "content", label: "Homepage content", detail: "restored defaults" }); toast("ডিফল্টে ফিরেছে", "success"); }
    catch { toast("ফেরানো যায়নি", "error"); }
    return;
  }
  if (act === "sync-tax") return withBusy(b, async () => { await syncTaxonomy(true); });
  if (act === "feature") {
    const id = b.dataset.id, ex = exams.find((x) => x.id === id);
    if (!ex) return;
    const on = b.checked === true;
    try {
      await patchExamFields([{ id, patch: { featured: on } }]);
      ex.featured = on;
      logAction("exam.feature", { type: "exam", id, label: ex.title, detail: on ? "marked Featured · Homepage" : "removed from Featured · Homepage" });
    } catch { b.checked = !on; toast("বদলানো যায়নি", "error"); }
  }
}

/* ---------- featured exams ---------- */
function renderFeatured() {
  const box = $("#hp-featured", root);
  if (!box) return;
  const canEdit = can("exams.write");
  const list = exams.filter((e) => e.examType !== "practice" || e.featured).sort((a, b) => (b.featured === true) - (a.featured === true) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  box.innerHTML = list.length
    ? `<div class="feat-list">${list.slice(0, 60).map((e) => `<label class="switch-row feat-row"><input type="checkbox" data-act="feature" data-id="${esc(e.id)}" ${e.featured ? "checked" : ""} ${canEdit ? "" : "disabled"}> <span class="feat-t">${esc(e.title)}</span>${e.status === "draft" ? chip("Draft", "") : ""}${e.cancelled ? chip("Cancelled", "coral") : ""}</label>`).join("")}</div>`
    : '<p class="muted">কোনো এক্সাম নেই।</p>';
}

/* ---------- category names (students can't read the admin-only taxonomy) ---------- */
function renderTaxStatus() {
  const box = $("#hp-tax", root);
  if (!box) return;
  const t = getTaxonomy();
  const inSync = taxSig(t) === JSON.stringify(normalizeTaxonomy(feed.taxonomy));
  box.innerHTML = `<p style="font-size:.9rem">${t.subjects.length} subjects · ${t.categories.length} categories ${inSync ? chip("Up to date", "teal", "fa-check") : chip("Out of date", "amber", "fa-triangle-exclamation")}</p>
    <p class="muted" style="font-size:.84rem;margin:6px 0 10px">Students see subject and category names on the home page. They update automatically whenever you save <b>Subjects & Categories</b>.</p>
    ${can("homepage.manage") ? '<button type="button" class="btn btn-outline btn-sm" data-act="sync-tax"><i class="fa-solid fa-cloud-arrow-up"></i> Sync now</button>' : ""}`;
}
async function syncTaxonomy(manual = false) {
  try {
    await publishTaxonomyMirror(getTaxonomy().subjects, getTaxonomy().categories);
    feed = await getHomeFeed({ force: true });
    renderTaxStatus();
    if (manual) toast("ক্যাটাগরির নাম আপডেট হয়েছে", "success");
  } catch (err) { if (manual) toast(isDenied(err) ? "অনুমতি নেই — firestore.rules পাবলিশ করুন" : "সিঙ্ক করা যায়নি", "error"); }
}
/** First visit after the upgrade (or after a taxonomy edit made elsewhere): bring the student copy up to date. */
function autoSyncTaxonomy() {
  if (!can("homepage.manage")) return;
  if (getTaxonomy().ok && taxSig(getTaxonomy()) !== JSON.stringify(normalizeTaxonomy(feed.taxonomy))) syncTaxonomy(false);
  // The default pass mark students' result cards use lives in Settings → Results; keep the student copy in step.
  const pass = getSettings().result.passPercent;
  if (pass > 0 && feed.passPercent !== pass) writeFeedFields({ passPercent: pass }).then(() => getHomeFeed({ force: true })).then((f) => { feed = f; }).catch(() => {});
}
