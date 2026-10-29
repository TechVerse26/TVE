// ==========================================================================
// admin/email/view-overview.js — "Overview": the six numbers, the state of the EmailJS connection, the campaign in preparation
// and the latest campaigns. Every number is computed from live data (students, exam results, start tracking, campaign history).
// ==========================================================================
import { esc, kpi, fmtN, fmtDateTime, emptyState } from "../core/ui.js";
import { CAMPAIGN_TYPES } from "../../email-core.js";
import { S, on } from "./state.js";
import { kpiNumbers, resetDraft, setType } from "./model.js";
import { campaignChip, configBanner, bindTabLinks, goTab, examStateChip } from "./bits.js";
import { describeAudience } from "./send.js";

const dash = '<span class="muted">—</span>';

function kpiGrid() {
  const k = kpiNumbers();
  const exam = S.derived.exam;
  const noExam = !exam;
  const examName = exam ? esc(exam.title || exam.id) : "";
  const notSub = noExam ? dash : S.derived.examLoading ? '<span class="spinner sm"></span>' : k.resultsOk === false ? "?" : fmtN(k.notSubmitted ?? 0);
  const notSubSub = noExam ? "Exam Reminders ট্যাবে একটি এক্সাম বাছুন" : S.derived.examLoading ? "ফলাফল লোড হচ্ছে…" : k.resultsOk === false ? "ফলাফল পড়া যায়নি — যাচাই করা যায়নি" : `${examName} · জমা দিয়েছেন ${fmtN(S.derived.counts?.submitted || 0)} জন`;
  const started = noExam ? dash : S.derived.examLoading ? '<span class="spinner sm"></span>' : k.sessionsOk ? fmtN(k.startedNoSubmission ?? 0) : "?";
  const startedSub = noExam ? "—" : S.derived.examLoading ? "লোড হচ্ছে…" : k.sessionsOk ? "start-রেকর্ড আছে, জমা নেই" : "Start-tracking পড়া যায়নি — যাচাই করা যায়নি";
  return `<div class="kpis em-kpis" role="group" aria-label="Email Center numbers">
    ${kpi({ label: "Registered students", value: fmtN(k.students), sub: `${fmtN(k.deactivated)} deactivated · ${fmtN(k.admins)} admin বাদ`, tone: "" })}
    ${kpi({ label: "Eligible recipients", value: fmtN(k.eligible), sub: `বর্তমান ক্যাম্পেইন · ${fmtN(k.selected)} বাছাই · ${fmtN(k.skipped)} বাদ`, tone: "accent" })}
    ${kpi({ label: "Not submitted (selected exam)", value: notSub, sub: notSubSub, tone: "coral" })}
    ${kpi({ label: "Started, no submission", value: started, sub: startedSub, tone: "amber" })}
    ${kpi({ label: "Requests accepted", value: fmtN(k.accepted), sub: `${fmtN(k.campaigns)}টি ক্যাম্পেইন (সর্বশেষ ৮০) · ইনবক্স-নিশ্চয়তা নয়`, tone: "teal" })}
    ${kpi({ label: "Failed / pending / uncertain", value: fmtN(k.failed + k.pending + k.uncertain), sub: `${fmtN(k.failed)} failed · ${fmtN(k.uncertain)} uncertain · ${fmtN(k.pending)} pending`, tone: k.failed + k.pending + k.uncertain ? "coral" : "" })}
  </div>`;
}

function context() {
  const d = S.draft;
  const exam = S.derived.exam;
  const t = CAMPAIGN_TYPES[d.type];
  return `<div class="panel"><div class="panel-head"><div><h2>Current campaign</h2><small>নিচের সংখ্যাগুলো এই ক্যাম্পেইনের নির্বাচন অনুযায়ী বদলায়</small></div>
      <div class="panel-actions"><button type="button" class="btn btn-primary btn-sm" data-go-tab="compose"><i class="fa-solid fa-pen-to-square"></i> Continue</button></div></div>
    <div class="panel-body"><dl class="em-kv">
      <div><dt>Type</dt><dd><i class="fa-solid ${t.icon}"></i> ${esc(t.label)}</dd></div>
      <div><dt>Exam</dt><dd>${exam ? `${esc(exam.title || exam.id)} ${examStateChip(S.derived.examState?.key)}` : '<span class="muted">কোনো এক্সাম বাছা হয়নি</span>'}</dd></div>
      <div><dt>Audience</dt><dd>${esc(describeAudience(d))}</dd></div>
      <div><dt>Recipients</dt><dd><b>${fmtN(S.derived.sendable.length)}</b> will receive · ${fmtN(S.derived.skipped.length)} skipped</dd></div>
      <div><dt>Subject</dt><dd>${d.content.subject ? esc(d.content.subject) : '<span class="muted">এখনো লেখা হয়নি</span>'}</dd></div>
    </dl></div></div>`;
}

function recent() {
  const list = S.campaigns.slice(0, 5);
  if (S.campaignsError) return `<div class="note bad">ক্যাম্পেইন হিস্ট্রি লোড হয়নি${S.campaignsError?.code === "permission-denied" ? " — firestore.rules Publish করুন" : ""}।</div>`;
  if (!list.length) return emptyState({ icon: "fa-envelope-open", title: "এখনো কোনো ক্যাম্পেইন নেই", text: "প্রথম ইমেইল ক্যাম্পেইন তৈরি করলে এখানে দেখা যাবে।" });
  return `<ul class="em-recent">${list.map((c) => {
    const t = c.totals || {};
    return `<li><button type="button" class="em-recent-row" data-open="${esc(c.id)}"><span class="em-recent-main"><b>${esc(c.name || "Campaign")}</b><small>${esc(CAMPAIGN_TYPES[c.type]?.label || c.type)} · ${fmtDateTime(c.createdAt)}</small></span>
      <span class="em-recent-n"><b>${fmtN(t.accepted || 0)}</b>/${fmtN(t.total || 0)}</span>${campaignChip(c.status)}</button></li>`;
  }).join("")}</ul>`;
}

export const overview = {
  mount(el) {
    el.innerHTML = `<div id="ov-banner"></div><div id="ov-kpis"></div>
      <div class="em-two"><div id="ov-ctx"></div>
        <div class="panel"><div class="panel-head"><div><h2>Quick start</h2></div></div><div class="panel-body em-quick">
          <button type="button" class="btn btn-outline" data-quick="announcement"><i class="fa-solid fa-bullhorn"></i> New announcement</button>
          <button type="button" class="btn btn-outline" data-quick="reminder"><i class="fa-solid fa-user-clock"></i> Remind students who have not taken an exam</button>
          <button type="button" class="btn btn-outline" data-quick="manual"><i class="fa-solid fa-user-check"></i> Email hand-picked students</button>
        </div></div></div>
      <div class="panel"><div class="panel-head"><div><h2>Recent campaigns</h2></div><div class="panel-actions"><button type="button" class="btn btn-outline btn-sm" data-go-tab="history">View all</button></div></div><div class="panel-body" id="ov-recent"></div></div>`;
    bindTabLinks(el);
    el.addEventListener("click", async (e) => {
      const q = e.target.closest("[data-quick]");
      if (q) {
        if (q.dataset.quick === "announcement") { resetDraft(); goTab("compose"); }
        else if (q.dataset.quick === "reminder") goTab("reminders");
        else { resetDraft(); await setType("custom"); goTab("recipients"); }
        return;
      }
      const o = e.target.closest("[data-open]");
      if (o) { S.openCampaign = o.dataset.open; goTab("history"); }
    });
    on("change", () => S.tab === "overview" && this.refresh(el));
    on("campaigns", () => S.tab === "overview" && this.refresh(el));
    on("settings", () => S.tab === "overview" && this.refresh(el));
    this.refresh(el);
  },
  refresh(el) {
    el.querySelector("#ov-banner").innerHTML = configBanner();
    el.querySelector("#ov-kpis").innerHTML = kpiGrid();
    el.querySelector("#ov-ctx").innerHTML = context();
    el.querySelector("#ov-recent").innerHTML = recent();
  },
};
