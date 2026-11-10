import { useState } from "react";
import { sendOutline } from "ionicons/icons";
import { Banner, Btn, Card, Field, Ico, Page, Seg, useConfirm, useNotify } from "../../ui/kit";
import { useAsync } from "../../state/hooks";
import { apiPost, ApiError } from "../../core/api";
import { fetchAllExamsAdmin } from "../../core/repo/exams";
import { logAction } from "../../core/admin/data";

const DEST = [{ v: "#/home", l: "Home" }, { v: "#/exams", l: "Exams" }, { v: "#/results", l: "Results" }, { v: "#/schedule", l: "Schedule" }, { v: "#/notifications", l: "Notices" }, { v: "#/leaderboard", l: "Leaderboard" }];
const CATS = [{ id: "announcement", label: "Announcement" }, { id: "exam", label: "Exam" }, { id: "result", label: "Result" }] as const;
const rid = () => { const a = new Uint8Array(20); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32); };
const explain = (e: unknown) => (e instanceof ApiError ? ({ forbidden: "Your role can't send notifications.", unauthenticated: "Please sign in again.", network: "No connection to the notification server.", rate_limited: "You're sending too fast — wait a moment." } as Record<string, string>)[e.code] || e.message || "The server refused the request." : "Something went wrong.");

export default function AdminPush() {
  const notify = useNotify();
  const confirm = useConfirm();
  const exams = useAsync(() => fetchAllExamsAdmin(), []);
  const [f, setF] = useState({ title: "", body: "", category: "announcement" as (typeof CATS)[number]["id"], url: "#/home", audience: "all" as "all" | "exam", examId: "", filter: "all" as "all" | "not_submitted" | "submitted" });
  const [busy, setBusy] = useState<"" | "send" | "test">("");
  const [result, setResult] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const body = () => ({ requestId: rid(), title: f.title.trim(), body: f.body.trim(), category: f.category, url: f.url });

  function problem() { if (!f.title.trim()) return "Add a title."; if (!f.body.trim()) return "Write the message."; if (f.audience === "exam" && !f.examId) return "Choose an exam."; return ""; }
  async function test() {
    const p = problem(); if (p && !(p.startsWith("Choose"))) return setResult({ tone: "bad", text: p });
    setBusy("test"); setResult(null);
    try { await apiPost("test", body()); setResult({ tone: "ok", text: "Test sent to your own devices." }); } catch (e) { setResult({ tone: "bad", text: explain(e) }); }
    setBusy("");
  }
  async function send() {
    const p = problem(); if (p) return setResult({ tone: "bad", text: p });
    const who = f.audience === "all" ? "ALL students" : `students of the chosen exam (${f.filter === "all" ? "everyone" : f.filter === "submitted" ? "who submitted" : "who haven't submitted"})`;
    if (!(await confirm({ title: "Send this notification?", message: `It goes to ${who}. You can't recall it.`, ok: "Send now" }))) return;
    setBusy("send"); setResult(null);
    try {
      const audience = f.audience === "all" ? { type: "all" } : { type: "exam", examId: f.examId, filter: f.filter };
      const r: any = await apiPost("send", { ...body(), audience });
      void logAction("push.send", { type: "push", id: r?.job?.id || "", label: f.title.trim(), detail: f.audience });
      setResult({ tone: "ok", text: r?.duplicate ? "That notification was already sent." : "Notification sent." }); notify("Notification sent.", "ok");
      setF({ ...f, title: "", body: "" });
    } catch (e) { setResult({ tone: "bad", text: explain(e) }); }
    setBusy("");
  }

  return (
    <Page title="Push notifications" back>
      <Card tone="soft"><p className="small">Sends through the same push system as the website — students get it in the browser <b>and</b> in the Android app.</p></Card>
      {result && <Banner tone={result.tone}>{result.text}</Banner>}
      <Field label="Title" htmlFor="pt" hint={`${f.title.length}/65`}><input id="pt" className="input" maxLength={65} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Message" htmlFor="pb" hint={`${f.body.length}/240`}><textarea id="pb" className="textarea" maxLength={240} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <Field label="Type"><Seg options={CATS as any} value={f.category} onChange={(v) => setF({ ...f, category: v })} /></Field>
      <Field label="Opens" htmlFor="pd"><select id="pd" className="select" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })}>{DEST.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}</select></Field>
      <Field label="Send to"><Seg options={[{ id: "all", label: "All students" }, { id: "exam", label: "One exam" }]} value={f.audience} onChange={(v) => setF({ ...f, audience: v })} /></Field>
      {f.audience === "exam" && (
        <>
          <Field label="Exam" htmlFor="pe"><select id="pe" className="select" value={f.examId} onChange={(e) => setF({ ...f, examId: e.target.value })}><option value="">Choose an exam</option>{(exams.data || []).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select></Field>
          <Field label="Who"><Seg options={[{ id: "all", label: "Everyone" }, { id: "not_submitted", label: "Not submitted" }, { id: "submitted", label: "Submitted" }]} value={f.filter} onChange={(v) => setF({ ...f, filter: v })} /></Field>
        </>
      )}
      <div className="stack-s"><Btn block loading={busy === "send"} onClick={send}><Ico n={sendOutline} /> Send notification</Btn><Btn kind="ghost" block loading={busy === "test"} onClick={test}>Send a test to me only</Btn></div>
    </Page>
  );
}
