import { useMemo, useState } from "react";
import { useIonActionSheet, useIonRouter } from "@ionic/react";
import { addOutline, documentTextOutline, ellipsisVertical } from "ionicons/icons";
import { Chip, Chips, Empty, ErrorBox, Ico, Page, SearchBox, SkeletonCards, useConfirm, useNotify } from "../../ui/kit";
import { StatusChip } from "../../ui/exam-ui";
import { useAuth } from "../../state/auth";
import { useAsync } from "../../state/hooks";
import { fetchAllExamsAdmin } from "../../core/repo/exams";
import { patchExam, removeExam } from "../../core/admin/exams";
import { computeStatus, getExamQuestionCount } from "../../core/shared";
import { serverNow } from "../../core/clock";
import { formatDateTime } from "../../core/format";
import type { Exam } from "../../core/types";

const FILTERS = [{ id: "all", label: "All" }, { id: "published", label: "Published" }, { id: "draft", label: "Drafts" }, { id: "live", label: "Live now" }, { id: "cancelled", label: "Cancelled" }] as const;

export default function AdminExams() {
  const router = useIonRouter();
  const { can } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [present] = useIonActionSheet();
  const exams = useAsync(() => fetchAllExamsAdmin(), []);
  const [q, setQ] = useState("");
  const [f, setF] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [busy, setBusy] = useState("");
  const now = serverNow();

  const rows = useMemo(() => (exams.data || []).slice().sort((a, b) => ((b.createdAt as any)?.seconds || 0) - ((a.createdAt as any)?.seconds || 0)).filter((e) => {
    const st = computeStatus(e, now);
    if (f === "published" && e.status === "draft") return false;
    if (f === "draft" && e.status !== "draft") return false;
    if (f === "live" && st.key !== "live") return false;
    if (f === "cancelled" && !e.cancelled) return false;
    return !q.trim() || `${e.title} ${e.courseName || ""}`.toLowerCase().includes(q.trim().toLowerCase());
  }), [exams.data, q, f, now]);

  async function run(label: string, job: () => Promise<{ indexed: boolean }>, ok: string) {
    setBusy(label);
    try { const r = await job(); notify(r.indexed ? ok : `${ok} (students' list will refresh on the next sync)`, "ok"); await exams.reload(); }
    catch (e: any) { notify(e?.code === "permission-denied" ? "You don't have permission for this action." : "Couldn't complete that. Check your connection.", "bad"); }
    setBusy("");
  }
  function actions(e: Exam) {
    const write = can("exams.write"), del = can("exams.delete");
    const buttons: any[] = [{ text: "Open details", handler: () => router.push(`/exams/${e.id}`, "forward") }];
    if (write) {
      buttons.push({ text: "Edit exam & questions", handler: () => router.push(`/admin/exams/${e.id}`, "forward") });
      buttons.push({ text: e.status === "draft" ? "Publish to students" : "Move back to draft", handler: () => run("pub", () => patchExam(e, { status: e.status === "draft" ? "published" : "draft" }, e.status === "draft" ? "exam.publish" : "exam.unpublish"), e.status === "draft" ? "Published" : "Moved to draft") });
      buttons.push({ text: e.cancelled ? "Restore schedule" : "Cancel schedule", handler: async () => { if (e.cancelled) { void run("c", () => patchExam(e, { cancelled: false }, "exam.restore"), "Schedule restored"); } else if (await confirm({ title: "Cancel this exam?", message: "Students will see it as cancelled and can't start it.", ok: "Cancel exam", cancel: "Keep" })) void run("c", () => patchExam(e, { cancelled: true }, "exam.cancel"), "Exam cancelled"); } });
      buttons.push({ text: e.registration === "closed" ? "Reopen registration" : "Close registration", handler: () => run("r", () => patchExam(e, { registration: e.registration === "closed" ? "open" : "closed" }, "exam.registration"), "Registration updated") });
    }
    if (del) buttons.push({ text: "Delete exam", role: "destructive", handler: async () => { if (await confirm({ title: "Delete this exam?", message: `“${e.title}” and all its questions will be removed permanently. Students' past results stay.`, ok: "Delete", cancel: "Keep" })) void run("d", () => removeExam(e), "Exam deleted"); } });
    buttons.push({ text: "Close", role: "cancel" });
    void present({ header: e.title, buttons });
  }

  return (
    <Page title="Exams" onRefresh={() => exams.reload()} right={can("exams.write") ? <button className="iconbtn" aria-label="New exam" onClick={() => router.push("/admin/exams/new", "forward")}><Ico n={addOutline} /></button> : undefined}>
      <SearchBox value={q} onChange={setQ} placeholder="Search exams" />
      <Chips options={FILTERS as any} value={f} onChange={setF} />
      {exams.error && !exams.data ? <ErrorBox onRetry={() => exams.reload()} /> : exams.loading && !exams.data ? <SkeletonCards n={4} /> : rows.length === 0 ? <Empty icon={documentTextOutline} title="No exams" text={exams.data?.length ? "Nothing matches this filter." : "Create your first exam with the + button."} /> : (
        <div className="list-2 stack">{rows.map((e) => {
          const st = computeStatus(e, now);
          return (
            <div className="card tap" key={e.id} onClick={() => actions(e)} role="button" style={busy ? { opacity: 0.6 } : undefined}>
              <div className="stack-s">
                <div className="row-s wrap">{e.status === "draft" ? <Chip tone="warn">Draft</Chip> : <StatusChip status={st} />}<Chip>{e.examType === "practice" ? "Practice" : "Live"}</Chip>{e.cancelled && <Chip tone="bad">Cancelled</Chip>}</div>
                <div className="row"><h3 className="grow">{e.title}</h3><Ico n={ellipsisVertical} className="muted" /></div>
                <p className="small muted">{getExamQuestionCount(e) || "No"} questions · {e.duration || 10} min{st.startsAt ? ` · ${formatDateTime(st.startsAt)}` : ""}</p>
              </div>
            </div>
          );
        })}</div>
      )}
    </Page>
  );
}
