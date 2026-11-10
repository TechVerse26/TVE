import { useMemo, useState } from "react";
import { IonToggle, useIonActionSheet } from "@ionic/react";
import { addOutline, megaphoneOutline } from "ionicons/icons";
import { Banner, Btn, Chip, Chips, Card, Empty, ErrorBox, Field, Ico, Page, Seg, Sheet, SkeletonCards, useConfirm, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useAsync } from "../../state/hooks";
import { deleteNotice, fetchNotices, logAction, saveNotice, setNoticeStatus, syncNoticeMirror, type NoticeDoc } from "../../core/admin/data";
import { fetchAllExamsAdmin } from "../../core/repo/exams";
import { fromLocalInput, toLocalInput, formatDateTime } from "../../core/format";
import { NOTICE_CATEGORIES, noticeCategory, noticePriority, noticeState, toMs } from "../../core/shared";
import { serverNow } from "../../core/clock";

const FILTERS = [{ id: "all", label: "All" }, { id: "live", label: "Live" }, { id: "scheduled", label: "Scheduled" }, { id: "draft", label: "Drafts" }, { id: "expired", label: "Expired" }] as const;
const mirrorShape = (n: NoticeDoc) => ({ ...n, publishAt: toMs(n.publishAt), expiresAt: toMs(n.expiresAt), createdAt: toMs(n.createdAt) });
const blank = (): NoticeDoc => ({ id: "", title: "", body: "", category: "general", priority: "normal", status: "published", publishAt: null, expiresAt: null, audience: { type: "all", ids: [] }, examId: "", courseId: "" });

export default function AdminNotices() {
  const { can } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [present] = useIonActionSheet();
  const list = useAsync(() => fetchNotices(), []);
  const exams = useAsync(() => fetchAllExamsAdmin(), []);
  const [f, setF] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [edit, setEdit] = useState<NoticeDoc | null>(null);
  const now = serverNow();
  const stateOf = (n: NoticeDoc) => noticeState(mirrorShape(n) as any, now);
  const rows = useMemo(() => (list.data || []).filter((n) => f === "all" || stateOf(n) === f), [list.data, f, now]);

  async function afterChange(next: NoticeDoc[]) { try { await syncNoticeMirror(next); } catch { notify("Saved, but the students' copy couldn't be refreshed. Open the website admin once to sync.", "bad"); } await list.reload(); }
  async function saveForm(n: NoticeDoc) {
    try {
      const id = await saveNotice(n.id || null, { title: n.title.trim(), body: n.body.trim(), category: n.category, priority: n.priority, status: n.status, publishAt: n.publishAt, expiresAt: n.expiresAt, audience: n.audience, examId: n.examId || "", courseId: n.courseId || "" });
      void logAction(n.id ? "notice.update" : "notice.create", { type: "notice", id, label: n.title });
      const fresh = await fetchNotices();
      await afterChange(fresh); setEdit(null); notify("Notice saved.", "ok");
    } catch { notify("Couldn't save the notice. You may not have permission.", "bad"); }
  }
  function actions(n: NoticeDoc) {
    void present({ header: n.title, buttons: [
      { text: "Edit", handler: () => setEdit({ ...n, publishAt: toMs(n.publishAt), expiresAt: toMs(n.expiresAt) }) },
      { text: n.status === "published" ? "Move to drafts" : "Publish", handler: async () => { await setNoticeStatus(n.id, n.status === "published" ? "draft" : "published"); void logAction("notice.status", { type: "notice", id: n.id, label: n.title }); const fresh = await fetchNotices(); await afterChange(fresh); } },
      { text: "Delete", role: "destructive", handler: async () => { if (await confirm({ title: "Delete this notice?", ok: "Delete" })) { await deleteNotice(n.id); void logAction("notice.delete", { type: "notice", id: n.id, label: n.title }); const fresh = await fetchNotices(); await afterChange(fresh); } } },
      { text: "Close", role: "cancel" },
    ] });
  }

  return (
    <Page title="Notices" onRefresh={() => list.reload()} right={can("notices.manage") ? <button className="iconbtn" aria-label="New notice" onClick={() => setEdit(blank())}><Ico n={addOutline} /></button> : undefined}>
      <Chips options={FILTERS as any} value={f} onChange={setF} />
      {list.error && !list.data ? <ErrorBox text="Couldn't load notices. You may not have permission." onRetry={() => list.reload()} /> : list.loading && !list.data ? <SkeletonCards n={3} /> : rows.length === 0 ? <Empty icon={megaphoneOutline} title="No notices" text="Create one with the + button — students see it on Home and in Notices." /> : (
        <div className="list-2 stack">{rows.map((n) => (
          <Card key={n.id} onClick={() => actions(n)}><div className="stack-s">
            <div className="row-s wrap"><Chip tone={stateOf(n) === "live" ? "ok" : stateOf(n) === "scheduled" ? "info" : stateOf(n) === "draft" ? "warn" : ""}>{stateOf(n)}</Chip><Chip tone={n.priority === "urgent" ? "bad" : n.priority === "important" ? "warn" : ""}>{noticePriority(n.priority).label}</Chip><Chip>{noticeCategory(n.category).label}</Chip></div>
            <h3>{n.title}</h3><p className="small muted" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{n.body}</p>
            <p className="tiny muted">{n.audience?.type === "exam" ? "Students of one exam" : "All students"}{toMs(n.publishAt) ? ` · from ${formatDateTime(toMs(n.publishAt))}` : ""}</p>
          </div></Card>))}</div>
      )}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit notice" : "New notice"}>{edit && <NoticeForm initial={edit} exams={exams.data || []} onSave={saveForm} />}</Sheet>
    </Page>
  );
}

function NoticeForm({ initial, exams, onSave }: { initial: NoticeDoc; exams: { id: string; title: string }[]; onSave: (n: NoticeDoc) => Promise<void> }) {
  const [n, setN] = useState<NoticeDoc>(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (n.title.trim().length < 3) return setErr("Add a title (at least 3 characters).");
    if (n.body.trim().length < 3) return setErr("Write the message.");
    if (n.audience.type === "exam" && !n.examId) return setErr("Choose which exam's students should see this.");
    const a = toMs(n.publishAt), b = toMs(n.expiresAt);
    if (a && b && b <= a) return setErr("The expiry must be after the publish time.");
    setBusy(true); setErr("");
    await onSave({ ...n, audience: n.audience.type === "exam" ? { type: "exam", ids: [n.examId] } : { type: "all", ids: [] } });
    setBusy(false);
  }
  return (
    <div className="stack">
      {err && <Banner tone="bad">{err}</Banner>}
      <Field label="Title" htmlFor="nt"><input id="nt" className="input" maxLength={100} value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></Field>
      <Field label="Message" htmlFor="nb" hint={`${n.body.length}/1200`}><textarea id="nb" className="textarea" maxLength={1200} value={n.body} onChange={(e) => setN({ ...n, body: e.target.value })} /></Field>
      <div className="grid-2">
        <Field label="Category" htmlFor="nc"><select id="nc" className="select" value={n.category} onChange={(e) => setN({ ...n, category: e.target.value })}>{NOTICE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
        <Field label="Priority" htmlFor="np"><select id="np" className="select" value={n.priority} onChange={(e) => setN({ ...n, priority: e.target.value })}><option value="normal">Normal</option><option value="important">Important</option><option value="urgent">Urgent</option></select></Field>
      </div>
      <Field label="Who sees it"><Seg options={[{ id: "all", label: "All students" }, { id: "exam", label: "One exam" }]} value={n.audience.type === "exam" ? "exam" : "all"} onChange={(v) => setN({ ...n, audience: { type: v, ids: [] } })} /></Field>
      {n.audience.type === "exam" && <Field label="Exam" htmlFor="ne"><select id="ne" className="select" value={n.examId} onChange={(e) => setN({ ...n, examId: e.target.value })}><option value="">Choose an exam</option>{exams.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></Field>}
      <div className="grid-2">
        <Field label="Show from" htmlFor="na" hint="Empty = now"><input id="na" type="datetime-local" className="input" value={toLocalInput(toMs(n.publishAt))} onChange={(e) => setN({ ...n, publishAt: fromLocalInput(e.target.value) })} /></Field>
        <Field label="Hide after" htmlFor="nx" hint="Empty = never"><input id="nx" type="datetime-local" className="input" value={toLocalInput(toMs(n.expiresAt))} onChange={(e) => setN({ ...n, expiresAt: fromLocalInput(e.target.value) })} /></Field>
      </div>
      <label className="row between"><span>Published (visible to students)</span><IonToggle checked={n.status === "published"} onIonChange={(e) => setN({ ...n, status: e.detail.checked ? "published" : "draft" })} /></label>
      <Btn block loading={busy} onClick={submit}>Save notice</Btn>
    </div>
  );
}
