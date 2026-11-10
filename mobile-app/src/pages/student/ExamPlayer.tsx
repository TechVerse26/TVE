import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { IonContent, IonPage, useIonRouter } from "@ionic/react";
import { App as CapApp } from "@capacitor/app";
import { alertCircleOutline, chevronBack, chevronForward, closeOutline, gridOutline, lockClosedOutline, timeOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Ico, Sheet, Skeleton, useConfirm } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useBackGuard, useTick } from "../../state/hooks";
import { buildQuestionPool, QuestionClock } from "../../core/engine";
import { snapshotFromSession, startSession, verifyStart, type Block } from "../../core/exam-flow";
import { persistAttempt } from "../../core/finish";
import { fetchExam, fetchQuestions, getExamCatalog } from "../../core/repo/exams";
import { checkAcademicExamAccess } from "../../core/repo/academic";
import { getAttemptsCount, recordExamStart } from "../../core/repo/results";
import { loadSession, removeSession, saveSession } from "../../core/session";
import { serverNow } from "../../core/clock";
import { syncServerTime, syncServerTimeSoon } from "../../core/time";
import { clockLabel } from "../../core/format";
import { haptic } from "../../core/native";
import { guidelinesOf, passPercentFor, Session } from "../../core/shared";
import type { Exam, Question } from "../../core/types";

type Phase = "boot" | "blocked" | "rules" | "running" | "finishing";
const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export default function ExamPlayer() {
  const { id } = useParams<{ id: string }>();
  const router = useIonRouter();
  const confirm = useConfirm();
  const { user, profile, isAdmin } = useAuth();
  const { model, refresh } = useStudent();
  const now = useTick();

  const [phase, setPhase] = useState<Phase>("boot");
  const [block, setBlock] = useState<Block | null>(null);
  const [prep, setPrep] = useState<{ exam: Exam; bank: Question[]; attemptsSoFar: number } | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<"one" | "all">("one");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const session = useRef<any>(null);
  const clock = useRef(new QuestionClock());
  const finishing = useRef(false);
  const warned = useRef({ one: false, ten: false });

  const student = useCallback(() => ({ name: profile?.displayName || user?.displayName || "", email: user?.email || "", roll: String(profile?.roll || "") }), [profile, user]);
  const goExam = () => router.push(`/exams/${id}`, "root", "replace");

  // ---------------------------------------------------------------- 1. prepare: resume a saved attempt, or check eligibility and load the questions
  const boot = useCallback(async () => {
    if (!user) return;
    setPhase("boot"); setLoadError(false); setBlock(null);
    await syncServerTimeSoon();
    const saved = loadSession(user.uid, id);
    if (saved) {
      const verdict = Session.judge(saved, serverNow());
      if (verdict.state === "resume") {
        const plan = Session.toRestorePlan(saved, serverNow());
        session.current = saved; setQuestions(plan.questions); setAnswers(plan.answers); setIndex(plan.index); setLayout(plan.layout);
        clock.current.restore(plan.times); setPhase("running"); return;
      }
      if (verdict.state === "expired" || verdict.state === "unsaved") {
        // Time ran out while the app was closed, or the last attempt was never stored: finish it now with what was answered.
        const snap = snapshotFromSession(saved, { student: student(), auto: verdict.state === "expired", defaultPass: model?.passPercent });
        void persistAttempt(snap).then(() => refresh(true));
        router.push(`/exams/${id}/result`, "root", "replace");
        return;
      }
      removeSession(user.uid, id);
    }
    const check = await verifyStart(id, { uid: user.uid, profile, isAdmin }, {
      fetchExam, getSite: async () => (await getExamCatalog()).site, attemptsUsed: getAttemptsCount, now: serverNow,
      academicGate: (exam) => checkAcademicExamAccess(exam, { uid: user.uid, isAdmin }),
    }).catch(() => null);
    if (!check) { setLoadError(true); return; }
    if (!check.ok) { setBlock({ title: check.title, message: check.message }); setPhase("blocked"); return; }
    try {
      const bank = await fetchQuestions(id, check.exam);
      if (!bank.length) { setBlock({ title: "No questions yet", message: "This exam doesn't have any questions yet. Please try again later." }); setPhase("blocked"); return; }
      setPrep({ exam: check.exam, bank, attemptsSoFar: check.attemptsSoFar });
      setPhase("rules");
    } catch (e: any) {
      if (e?.code === "permission-denied") { setBlock({ title: "Exam not open", message: "You can't open this exam's questions right now. The exam may not have started, or it may have closed." }); setPhase("blocked"); }
      else setLoadError(true);
    }
  }, [user, id, profile, isAdmin, model?.passPercent, refresh, router, student]);
  useEffect(() => { void boot(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.uid, id]);

  // ---------------------------------------------------------------- 2. begin: the pool is drawn and the deadline is fixed by the server clock
  function begin() {
    if (!user || !prep) return;
    const pool = buildQuestionPool(prep.exam, prep.bank);
    if (!pool.length) { setBlock({ title: "No questions", message: "This exam has no questions to show." }); setPhase("blocked"); return; }
    const s = startSession({ uid: user.uid, exam: prep.exam, questions: pool, attemptsSoFar: prep.attemptsSoFar });
    session.current = s; saveSession(s);
    recordExamStart(user.uid, id);
    setQuestions(pool); setAnswers({}); setIndex(0); setLayout(s.layout); clock.current.reset();
    void haptic("tap");
    setPhase("running");
  }

  // ---------------------------------------------------------------- 3. while running
  const left = phase === "running" && session.current ? Math.max(0, Session.secondsLeft(session.current, now)) : 0;
  const answered = Object.keys(answers).length;

  const persist = useCallback((nextAnswers: Record<string, number>, nextIndex: number) => {
    if (!session.current) return;
    const next = Session.updateProgress(session.current, { answers: nextAnswers, locked: Object.keys(nextAnswers), index: nextIndex, times: clock.current.snapshot(), now: serverNow() });
    session.current = next; saveSession(next);
  }, []);

  useEffect(() => { if (phase === "running" && layout === "one" && questions[index]) clock.current.show(questions[index].id); }, [phase, index, layout, questions]);

  function pick(q: Question, option: number) {
    if (phase !== "running" || answers[q.id] !== undefined || left <= 0) return; // an answer locks the moment it is chosen (same rule as the website)
    const next = { ...answers, [q.id]: option };
    setAnswers(next); persist(next, index); void haptic("tap");
  }
  function go(n: number) {
    const to = Math.max(0, Math.min(questions.length - 1, n));
    setIndex(to); persist(answers, to);
  }

  const submit = useCallback(async (auto: boolean) => {
    if (finishing.current || !session.current || !user) return;
    finishing.current = true; setPhase("finishing");
    const at = serverNow();
    const leftSec = Math.max(0, Session.secondsLeft(session.current, at));
    const times = clock.current.stop();
    const progressed = Session.updateProgress(session.current, { answers, locked: Object.keys(answers), index, times, now: at });
    const submitted = Session.markSubmitted(progressed, { now: at, leftSec });
    session.current = submitted; saveSession(submitted);
    const snap = snapshotFromSession(submitted, { student: student(), auto, now: at, defaultPass: model?.passPercent });
    void persistAttempt(snap).then(() => refresh(true));
    void haptic("success");
    router.push(`/exams/${id}/result`, "root", "replace");
  }, [answers, index, user, student, model?.passPercent, refresh, router, id]);

  // time is up → submit what was answered
  useEffect(() => { if (phase === "running" && left <= 0) void submit(true); }, [phase, left, submit]);
  useEffect(() => {
    if (phase !== "running") return;
    if (left > 0 && left <= 60 && !warned.current.one) { warned.current.one = true; void haptic("warning"); }
    if (left > 0 && left <= 600 && !warned.current.ten) { warned.current.ten = true; void haptic("warning"); }
  }, [phase, left]);

  // the app goes to the background and returns: pause the per-question clock, re-sync the server time; the deadline itself never pauses
  useEffect(() => {
    if (phase !== "running") return;
    const onVis = () => {
      if (document.visibilityState === "hidden") { clock.current.pause(); persist(answers, index); }
      else { clock.current.resume(); void syncServerTime(); }
    };
    document.addEventListener("visibilitychange", onVis);
    let handle: { remove: () => void } | null = null;
    CapApp.addListener("appStateChange", (s) => { if (!s.isActive) { clock.current.pause(); persist(answers, index); } else { clock.current.resume(); void syncServerTime(); } }).then((h) => { handle = h; }).catch(() => {});
    return () => { document.removeEventListener("visibilitychange", onVis); handle?.remove(); };
  }, [phase, answers, index, persist]);

  async function askSubmit() {
    const unanswered = questions.length - answered;
    const ok = await confirm({ title: "Submit your exam?", message: `${answered} of ${questions.length} answered.${unanswered ? ` ${unanswered} unanswered question${unanswered === 1 ? "" : "s"} will score zero.` : ""} You can't change your answers after submitting.`, ok: "Submit", cancel: "Keep going" });
    if (ok) void submit(false);
  }
  async function askLeave() {
    if (phase === "running") {
      const ok = await confirm({ title: "Leave the exam screen?", message: "Your answers are saved, but the clock keeps running. You can resume from the Home screen until time is up.", ok: "Leave", cancel: "Stay" });
      if (ok) { persist(answers, index); goExam(); }
    } else goExam();
  }
  useBackGuard(phase === "running" || phase === "rules" || phase === "blocked", () => { void askLeave(); });

  // ---------------------------------------------------------------- views
  if (loadError) return <Shell0><Banner tone="bad"><Ico n={alertCircleOutline} /> Couldn't prepare the exam. Check your connection.</Banner><Btn block onClick={boot}>Try again</Btn><Btn kind="ghost" block onClick={goExam}>Back</Btn></Shell0>;
  if (phase === "boot" || phase === "finishing") return <Shell0><div className="stack"><Skeleton h={22} w="50%" /><Skeleton h={120} /><Skeleton h={56} /><Skeleton h={56} /></div><p className="center muted">{phase === "finishing" ? "Submitting your answers…" : "Preparing your exam…"}</p></Shell0>;
  if (phase === "blocked") return <Shell0><Card tone="warn"><div className="stack-s"><h2>{block?.title}</h2><p>{block?.message}</p></div></Card><Btn block onClick={goExam}>Back to exam</Btn></Shell0>;
  if (phase === "rules" && prep) {
    const { exam, bank } = prep;
    const total = Number(exam.questionsPerAttempt) > 0 && Number(exam.questionsPerAttempt) < bank.length ? Number(exam.questionsPerAttempt) : bank.length;
    const practice = exam.examType === "practice";
    const guide = guidelinesOf(model?.feed.content);
    return (
      <Shell0 title={exam.title}>
        <Card><div className="stack">
          <div className="grid-2"><div className="stat"><b>{exam.duration || 10} min</b><span>Time</span></div><div className="stat"><b>{total}</b><span>Questions</span></div></div>
          <ul className="rich" style={{ margin: 0 }}>
            <li>The timer starts when you press <b>Start</b> and <b>keeps running</b> even if you leave the screen or close the app.</li>
            <li>An answer is <b>locked</b> as soon as you choose it — it can't be changed.</li>
            <li>{practice || !Number(exam.negativeMarking) ? "There is no negative marking." : <>Each wrong answer costs <b>{exam.negativeMarking}</b> mark.</>}</li>
            <li>When time is up, your answers are submitted automatically.</li>
            {guide.map((g, i) => <li key={i}>{g}</li>)}
          </ul>
          {exam.instructions ? <p className="muted small" style={{ whiteSpace: "pre-wrap" }}>{String(exam.instructions)}</p> : null}
        </div></Card>
        <Btn block onClick={begin}>Start exam</Btn>
        <Btn kind="ghost" block onClick={goExam}>Not now</Btn>
      </Shell0>
    );
  }

  // running
  const total = questions.length;
  const q = questions[index];
  const timerCls = left <= 60 ? "critical" : left <= 300 ? "low" : "";
  const palette = (
    <div className="stack">
      <div className="palette">{questions.map((x, i) => <button key={x.id} className={`${answers[x.id] !== undefined ? "done" : ""} ${layout === "one" && i === index ? "cur" : ""}`} onClick={() => { setPaletteOpen(false); if (layout === "one") go(i); else document.getElementById(`q-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} aria-label={`Question ${i + 1}${answers[x.id] !== undefined ? ", answered" : ""}`}>{i + 1}</button>)}</div>
      <div className="row-s wrap small muted"><Chip tone="info">Answered {answered}</Chip><Chip>Left {total - answered}</Chip></div>
    </div>
  );
  const optionsOf = (qq: Question) => (
    <div className="stack-s" role="radiogroup" aria-label="Answer options">{qq.options.map((o, i) => {
      const picked = answers[qq.id] === i;
      const lockedQ = answers[qq.id] !== undefined;
      return <button key={i} role="radio" aria-checked={picked} className={`option ${picked ? "picked" : ""}`} disabled={lockedQ && !picked} onClick={() => pick(qq, i)}><span className="letter">{LETTERS[i] || i + 1}</span><span className="grow" style={{ whiteSpace: "pre-wrap" }}>{o}</span>{picked && <Ico n={lockClosedOutline} />}</button>;
    })}</div>
  );

  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="xbar">
          <div className="row">
            <button className="iconbtn" aria-label="Leave exam" onClick={() => void askLeave()}><Ico n={closeOutline} /></button>
            <div className="grow center"><p className="strong">{layout === "one" ? `Question ${index + 1} of ${total}` : `${total} questions`}</p><p className="tiny muted">{answered} answered</p></div>
            <div className={`timer ${timerCls}`} role="timer" aria-live="off"><Ico n={timeOutline} />{clockLabel(left)}</div>
          </div>
          <div className="progress" aria-hidden="true"><i style={{ width: `${(answered / Math.max(1, total)) * 100}%` }} /></div>
        </div>
        <div className="screen" style={{ paddingTop: 4 }}>
          <div className="cols">
            <div className="stack">
              {layout === "one" && q ? (
                <Card className="qcard"><div className="stack"><p className="qtext">{q.text}</p>{optionsOf(q)}{answers[q.id] !== undefined && <p className="tiny muted center"><Ico n={lockClosedOutline} /> Answer locked</p>}</div></Card>
              ) : questions.map((qq, i) => <Card className="qcard" key={qq.id}><div className="stack" id={`q-${i}`}><p className="small muted strong">Question {i + 1}</p><p className="qtext">{qq.text}</p>{optionsOf(qq)}</div></Card>)}
            </div>
            <div className="tablet-only"><Card><div className="stack"><h3>Questions</h3>{palette}<Btn kind="soft" block onClick={askSubmit}>Submit exam</Btn></div></Card></div>
          </div>
        </div>
        <div className="xfoot">
          {layout === "one" ? (
            <>
              <Btn kind="ghost" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous question"><Ico n={chevronBack} /></Btn>
              <Btn kind="soft" className="grow" onClick={() => setPaletteOpen(true)}><Ico n={gridOutline} /> {answered}/{total}</Btn>
              {index < total - 1 ? <Btn onClick={() => go(index + 1)} aria-label="Next question">Next <Ico n={chevronForward} /></Btn> : <Btn onClick={askSubmit}>Submit</Btn>}
            </>
          ) : (<><Btn kind="soft" className="grow" onClick={() => setPaletteOpen(true)}><Ico n={gridOutline} /> {answered}/{total}</Btn><Btn onClick={askSubmit}>Submit</Btn></>)}
        </div>
        <Sheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Questions">{palette}<Btn block onClick={() => { setPaletteOpen(false); void askSubmit(); }}>Submit exam</Btn></Sheet>
      </IonContent>
    </IonPage>
  );
}

/** A simple full-height page for the steps before and after the questions. */
function Shell0({ title, children }: { title?: string; children: React.ReactNode }) {
  return <IonPage><IonContent fullscreen><div className="screen" style={{ paddingTop: "calc(var(--ion-safe-area-top) + 20px)" }}>{title && <h1>{title}</h1>}{children}</div></IonContent></IonPage>;
}
