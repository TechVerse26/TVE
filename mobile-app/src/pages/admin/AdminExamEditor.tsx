import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { IonToggle, useIonRouter } from "@ionic/react";
import { Timestamp } from "firebase/firestore";
import { addOutline, arrowDown, arrowUp, createOutline, trashOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Empty, Field, Ico, Page, Seg, Sheet, SkeletonCards, useConfirm, useNotify } from "../../ui/kit";
import { useAsync } from "../../state/hooks";
import { afterExamsChanged, fetchAllExamsAdmin, fetchExam, fetchQuestionsAdmin, saveExamDoc } from "../../core/repo/exams";
import { fetchTaxonomy, logAction } from "../../core/admin/data";
import { fromLocalInput, toLocalInput } from "../../core/format";
import { toMs } from "../../core/shared";
import { helpCircleOutline } from "ionicons/icons";

interface Form { title: string; description: string; examType: "live" | "practice"; status: "draft" | "published"; duration: string; maxAttempts: string; negativeMarking: string; passPercent: string; layout: "one" | "all"; shuffle: boolean; questionsPerAttempt: string; subjectId: string; difficulty: string; featured: boolean; instructions: string; publishAt: string; closesAt: string }
interface QDraft { key: string; text: string; options: string[]; correctIndex: number; explanation: string }
const blank: Form = { title: "", description: "", examType: "live", status: "draft", duration: "30", maxAttempts: "1", negativeMarking: "0", passPercent: "", layout: "one", shuffle: true, questionsPerAttempt: "", subjectId: "", difficulty: "", featured: false, instructions: "", publishAt: "", closesAt: "" };
const newKey = () => Math.random().toString(36).slice(2, 10);
const emptyQ = (): QDraft => ({ key: newKey(), text: "", options: ["", "", "", ""], correctIndex: 0, explanation: "" });
const LETTERS = ["A", "B", "C", "D", "E", "F"];

export default function AdminExamEditor() {
  const { id } = useParams<{ id?: string }>();
  const router = useIonRouter();
  const notify = useNotify();
  const confirm = useConfirm();
  const [tab, setTab] = useState<"details" | "questions">("details");
  const [f, setF] = useState<Form>(blank);
  const [qs, setQs] = useState<QDraft[]>([]);
  const [prevChunks, setPrevChunks] = useState(1);
  const [editing, setEditing] = useState<QDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const tax = useAsync(() => fetchTaxonomy(), []);
  const loaded = useAsync(async () => {
    if (!id) return null;
    const exam = await fetchExam(id);
    if (!exam) throw new Error("missing");
    const bank = await fetchQuestionsAdmin(id, exam);
    return { exam, bank };
  }, [id]);

  useEffect(() => {
    const d = loaded.data;
    if (!d) return;
    const e = d.exam;
    setF({ title: e.title || "", description: e.description || "", examType: e.examType === "practice" ? "practice" : "live", status: e.status === "draft" ? "draft" : "published", duration: String(e.duration || 30), maxAttempts: String(e.maxAttempts ?? 0), negativeMarking: String(e.negativeMarking ?? 0), passPercent: e.passPercent ? String(e.passPercent) : "", layout: e.layout === "all" ? "all" : "one", shuffle: e.shuffle !== false, questionsPerAttempt: e.questionsPerAttempt ? String(e.questionsPerAttempt) : "", subjectId: e.subjectId || "", difficulty: e.difficulty || "", featured: !!e.featured, instructions: String(e.instructions || ""), publishAt: toLocalInput(toMs(e.publishAt)), closesAt: toLocalInput(toMs(e.closesAt)) });
    setQs(d.bank.map((q) => ({ key: newKey(), text: q.text, options: q.options.slice(), correctIndex: q.correctIndex, explanation: q.explanation || "" })));
    setPrevChunks(Number(e.qChunks) || 1);
  }, [loaded.data]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));

  function validate(): string[] {
    const errs: string[] = [];
    const dur = Number(f.duration), att = Number(f.maxAttempts || 0), neg = Number(f.negativeMarking || 0), pass = Number(f.passPercent || 0), per = Number(f.questionsPerAttempt || 0);
    if (f.title.trim().length < 3) errs.push("Give the exam a title (at least 3 characters).");
    if (!Number.isInteger(dur) || dur < 1 || dur > 600) errs.push("Duration must be a whole number of minutes between 1 and 600.");
    if (!Number.isInteger(att) || att < 0) errs.push("Attempts must be 0 (unlimited) or a positive whole number.");
    if (!(neg >= 0 && neg <= 5)) errs.push("Negative marking must be between 0 and 5.");
    if (f.passPercent && !(pass > 0 && pass <= 100)) errs.push("Pass mark must be between 1 and 100 (or leave it empty for the default).");
    const start = fromLocalInput(f.publishAt), end = fromLocalInput(f.closesAt);
    if (f.examType === "live" && (!start || !end)) errs.push("A live exam needs a start and an end time.");
    if (start && end && end <= start) errs.push("The end time must be after the start time.");
    if (f.status === "published" && qs.length === 0) errs.push("Add at least one question before publishing.");
    if (per && per > qs.length) errs.push(`“Questions per attempt” (${per}) is larger than the number of questions (${qs.length}).`);
    qs.forEach((q, i) => { if (!q.text.trim() || q.options.filter((o) => o.trim()).length < 2 || !q.options[q.correctIndex]?.trim()) errs.push(`Question ${i + 1} is incomplete.`); });
    return errs;
  }

  async function save() {
    const errs = validate();
    setErrors(errs);
    if (errs.length) { notify(errs[0], "bad"); return; }
    setBusy(true);
    try {
      const start = fromLocalInput(f.publishAt), end = fromLocalInput(f.closesAt);
      const data = {
        title: f.title.trim(), description: f.description.trim(), examType: f.examType, status: f.status, duration: Number(f.duration), maxAttempts: Number(f.maxAttempts || 0), negativeMarking: Number(f.negativeMarking || 0),
        passPercent: Number(f.passPercent || 0), layout: f.layout, shuffle: f.shuffle, questionsPerAttempt: Number(f.questionsPerAttempt || 0), subjectId: f.subjectId, difficulty: f.difficulty, featured: f.featured,
        instructions: f.instructions.trim(), publishAt: start ? Timestamp.fromMillis(start) : null, closesAt: end ? Timestamp.fromMillis(end) : null, questionCount: qs.length,
      };
      const clean = qs.map((q) => { const opts = q.options.map((o) => o.trim()); const keep = opts.map((o, i) => (o ? i : -1)).filter((i) => i >= 0); return { text: q.text.trim(), options: keep.map((i) => opts[i]), correctIndex: keep.indexOf(q.correctIndex), explanation: q.explanation.trim() }; });
      const saved = await saveExamDoc({ examId: id || null, data, questions: clean, prevChunks });
      const list = await fetchAllExamsAdmin();
      const fresh = await fetchExam(saved.id);
      const next = fresh ? [fresh, ...list.filter((e) => e.id !== saved.id)] : list;
      const indexed = await afterExamsChanged(next);
      void logAction(id ? "exam.update" : "exam.create", { type: "exam", id: saved.id, label: data.title, detail: `${qs.length} questions` });
      notify(indexed ? "Exam saved. It's now live on the website too." : "Exam saved. The students' list will refresh on the next sync.", "ok");
      router.push("/admin/exams", "root", "replace");
    } catch (e: any) {
      notify(e?.code === "permission-denied" ? "You don't have permission to save exams." : "Couldn't save. Check your connection and try again.", "bad");
    }
    setBusy(false);
  }

  function saveQuestion(q: QDraft) {
    setQs((list) => (list.some((x) => x.key === q.key) ? list.map((x) => (x.key === q.key ? q : x)) : [...list, q]));
    setEditing(null);
  }
  const move = (i: number, d: number) => setQs((l) => { const n = l.slice(); const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  async function drop(i: number) { if (await confirm({ title: `Delete question ${i + 1}?`, ok: "Delete" })) setQs((l) => l.filter((_, k) => k !== i)); }
  async function back() { if (await confirm({ title: "Discard changes?", message: "Anything you changed on this screen won't be saved.", ok: "Discard", cancel: "Keep editing" })) router.goBack(); }

  if (id && loaded.loading) return <Page title="Edit exam" back><SkeletonCards n={3} /></Page>;
  if (id && loaded.error) return <Page title="Edit exam" back><Banner tone="bad">This exam couldn't be loaded. It may have been deleted.</Banner></Page>;

  return (
    <Page title={id ? "Edit exam" : "New exam"} right={<button className="iconbtn" aria-label="Cancel" onClick={back}>✕</button>}>
      <Seg options={[{ id: "details", label: "Details" }, { id: "questions", label: `Questions (${qs.length})` }]} value={tab} onChange={setTab} />
      {errors.length > 0 && <Banner tone="bad"><ul style={{ margin: 0, paddingLeft: 18 }}>{errors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}</ul></Banner>}
      {tab === "details" ? (
        <div className="cols cols-eq">
          <div className="stack">
            <Field label="Title" htmlFor="t"><input id="t" className="input" value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="Description" htmlFor="d" hint="Shown on the exam page"><textarea id="d" className="textarea" value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="Type"><Seg options={[{ id: "live", label: "Live exam" }, { id: "practice", label: "Practice" }]} value={f.examType} onChange={(v) => set("examType", v)} /></Field>
            <Field label="Visibility" hint="Drafts are hidden from students."><Seg options={[{ id: "draft", label: "Draft" }, { id: "published", label: "Published" }]} value={f.status} onChange={(v) => set("status", v)} /></Field>
            <div className="grid-2">
              <Field label={f.examType === "live" ? "Starts" : "Opens (optional)"} htmlFor="s"><input id="s" type="datetime-local" className="input" value={f.publishAt} onChange={(e) => set("publishAt", e.target.value)} /></Field>
              <Field label={f.examType === "live" ? "Ends" : "Closes (optional)"} htmlFor="e"><input id="e" type="datetime-local" className="input" value={f.closesAt} onChange={(e) => set("closesAt", e.target.value)} /></Field>
            </div>
          </div>
          <div className="stack">
            <div className="grid-2">
              <Field label="Duration (min)" htmlFor="du"><input id="du" className="input" inputMode="numeric" value={f.duration} onChange={(e) => set("duration", e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Attempts" htmlFor="at" hint="0 = unlimited"><input id="at" className="input" inputMode="numeric" value={f.maxAttempts} onChange={(e) => set("maxAttempts", e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Negative marking" htmlFor="nm" hint="Per wrong answer"><input id="nm" className="input" inputMode="decimal" value={f.negativeMarking} onChange={(e) => set("negativeMarking", e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
              <Field label="Pass mark (%)" htmlFor="pm" hint="Empty = default"><input id="pm" className="input" inputMode="numeric" value={f.passPercent} onChange={(e) => set("passPercent", e.target.value.replace(/\D/g, ""))} /></Field>
            </div>
            <Field label="Question layout"><Seg options={[{ id: "one", label: "One at a time" }, { id: "all", label: "All on one page" }]} value={f.layout} onChange={(v) => set("layout", v)} /></Field>
            <Field label="Questions per attempt" htmlFor="qp" hint="Empty = every question. A smaller number draws a random set for each student."><input id="qp" className="input" inputMode="numeric" value={f.questionsPerAttempt} onChange={(e) => set("questionsPerAttempt", e.target.value.replace(/\D/g, ""))} /></Field>
            <Card><div className="stack">
              <label className="row between"><span>Shuffle questions and options</span><IonToggle checked={f.shuffle} onIonChange={(e) => set("shuffle", e.detail.checked)} /></label>
              <label className="row between"><span>Feature on the home page</span><IonToggle checked={f.featured} onIonChange={(e) => set("featured", e.detail.checked)} /></label>
            </div></Card>
            <Field label="Subject" htmlFor="sj"><select id="sj" className="select" value={f.subjectId} onChange={(e) => set("subjectId", e.target.value)}><option value="">No subject</option>{(tax.data?.subjects || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Difficulty" htmlFor="df"><select id="df" className="select" value={f.difficulty} onChange={(e) => set("difficulty", e.target.value)}><option value="">Not set</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></Field>
            <Field label="Instructions" htmlFor="in" hint="Shown before the exam starts"><textarea id="in" className="textarea" value={f.instructions} onChange={(e) => set("instructions", e.target.value)} /></Field>
          </div>
        </div>
      ) : (
        <div className="stack">
          {qs.length === 0 ? <Empty icon={helpCircleOutline} title="No questions yet" text="Add multiple-choice questions. Each needs at least two options and one correct answer." /> : qs.map((q, i) => (
            <Card key={q.key}><div className="stack-s">
              <div className="row"><Chip tone="info">Q{i + 1}</Chip><p className="grow strong" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{q.text || "(empty question)"}</p></div>
              <p className="small muted">Correct: {LETTERS[q.correctIndex]} — {q.options[q.correctIndex] || "—"}</p>
              <div className="row-s"><Btn kind="soft" className="small" onClick={() => setEditing(q)}><Ico n={createOutline} /> Edit</Btn><button className="iconbtn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Ico n={arrowUp} /></button><button className="iconbtn" aria-label="Move down" disabled={i === qs.length - 1} onClick={() => move(i, 1)}><Ico n={arrowDown} /></button><button className="iconbtn end" aria-label="Delete question" onClick={() => drop(i)}><Ico n={trashOutline} /></button></div>
            </div></Card>
          ))}
          <Btn kind="soft" block onClick={() => setEditing(emptyQ())}><Ico n={addOutline} /> Add question</Btn>
        </div>
      )}
      <div className="stack-s" style={{ position: "sticky", bottom: 0, padding: "8px 0 4px", background: "var(--c-bg)" }}><Btn block loading={busy} onClick={save}>{id ? "Save changes" : "Create exam"}</Btn></div>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title="Question">{editing && <QuestionForm q={editing} onSave={saveQuestion} />}</Sheet>
    </Page>
  );
}

function QuestionForm({ q, onSave }: { q: QDraft; onSave: (q: QDraft) => void }) {
  const [d, setD] = useState<QDraft>(q);
  const [err, setErr] = useState("");
  const setOpt = (i: number, v: string) => setD((s) => ({ ...s, options: s.options.map((o, k) => (k === i ? v : o)) }));
  function done() {
    const filled = d.options.filter((o) => o.trim()).length;
    if (!d.text.trim()) return setErr("Write the question.");
    if (filled < 2) return setErr("Add at least two options.");
    if (!d.options[d.correctIndex]?.trim()) return setErr("Mark one of the filled options as correct.");
    onSave({ ...d, text: d.text.trim() });
  }
  return (
    <div className="stack">
      {err && <Banner tone="bad">{err}</Banner>}
      <Field label="Question" htmlFor="qt"><textarea id="qt" className="textarea" value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} /></Field>
      <div className="stack-s"><p className="small strong">Options — tap the letter to mark the correct one</p>{d.options.map((o, i) => (
        <div className="row" key={i}>
          <button type="button" className={`option ${d.correctIndex === i ? "right" : ""}`} style={{ width: 52, minHeight: 50, padding: 0, justifyContent: "center", flex: "none" }} aria-label={`Option ${LETTERS[i]}${d.correctIndex === i ? ", correct" : ""}`} onClick={() => setD({ ...d, correctIndex: i })}><span className="letter">{LETTERS[i]}</span></button>
          <input className="input" value={o} placeholder={`Option ${LETTERS[i]}`} onChange={(e) => setOpt(i, e.target.value)} />
          {d.options.length > 2 && <button type="button" className="iconbtn plain" aria-label="Remove option" onClick={() => setD((s) => { const options = s.options.filter((_, k) => k !== i); return { ...s, options, correctIndex: Math.min(s.correctIndex > i ? s.correctIndex - 1 : s.correctIndex, options.length - 1) }; })}>✕</button>}
        </div>))}
        {d.options.length < 6 && <Btn kind="ghost" className="small" type="button" onClick={() => setD({ ...d, options: [...d.options, ""] })}>Add option</Btn>}
      </div>
      <Field label="Explanation" htmlFor="qe" hint="Optional — shown in the student's review of a wrong answer"><textarea id="qe" className="textarea" value={d.explanation} onChange={(e) => setD({ ...d, explanation: e.target.value })} /></Field>
      <Btn block onClick={done}>Done</Btn>
    </div>
  );
}
