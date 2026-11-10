import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useIonRouter } from "@ionic/react";
import { alertCircleOutline, checkmarkCircle, closeCircle, refreshOutline, timeOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Empty, Head, Ico, Page, Ring, SkeletonCards, Stat } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useAsync } from "../../state/hooks";
import { getLastAttempt, subscribeAttempts } from "../../core/exam-flow";
import { persistAttempt } from "../../core/finish";
import { fetchMyResults } from "../../core/repo/results";
import { countAttempts, reviewMsLeft } from "../../core/result-rules";
import { durationLabel, scoreText } from "../../core/format";
import { Analytics, passPercentFor } from "../../core/shared";
import type { ReviewItem } from "../../core/types";

interface View {
  title: string; type: "live" | "practice"; percent: number; score: number; total: number; correct: number; wrong: number; unanswered: number;
  seconds: number; attemptNumber: number; auto: boolean; review: ReviewItem[] | null; reviewLeftMs: number | null; durationSeconds: number;
  passPercent: number; negativeMarking: number; qStats: { n: number; sec: number; status: string }[]; subjectId: string;
}
const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export default function ExamResult() {
  const { id } = useParams<{ id: string }>();
  const wanted = Number(new URLSearchParams(useLocation().search).get("attempt")) || 0;
  const router = useIonRouter();
  const { user } = useAuth();
  const { model } = useStudent();
  const [, bump] = useState(0);
  useEffect(() => subscribeAttempts(() => bump((x) => x + 1)), []);
  const live = wanted ? undefined : getLastAttempt(id);
  const saved = useAsync(() => (live ? Promise.resolve([]) : fetchMyResults(user!.uid)), [user?.uid, id, wanted, !!live]);
  const exam = model?.examsById[id];
  const defaultPass = model?.passPercent ?? 60;

  const view = useMemo<View | null>(() => {
    if (live) {
      return { title: live.examTitle, type: live.examType, percent: live.percent, score: live.score, total: live.total, correct: live.correctCount, wrong: live.wrongCount, unanswered: live.unansweredCount, seconds: live.timeTakenSeconds, attemptNumber: live.attemptNumber, auto: live.auto, review: live.review, reviewLeftMs: null, durationSeconds: live.durationSeconds, passPercent: live.passPercent, negativeMarking: live.negativeMarking, qStats: live.qStats, subjectId: live.subjectId };
    }
    const r = saved.data?.find((x) => x.examId === id);
    if (!r) return null;
    const list = Array.isArray(r.attempts) ? r.attempts : [];
    const base = countAttempts(r) - list.length;
    const a = wanted ? list[wanted - base - 1] : list[list.length - 1];
    if (!a) return null;
    return { title: r.examTitle || "Exam", type: r.examType === "practice" ? "practice" : "live", percent: a.percent, score: a.score, total: a.total, correct: a.correctCount, wrong: a.wrongCount, unanswered: a.unansweredCount, seconds: a.timeTakenSeconds, attemptNumber: wanted || countAttempts(r), auto: false, review: a.review || null, reviewLeftMs: a.review ? reviewMsLeft(a.submittedAt) : null, durationSeconds: (exam?.duration || 10) * 60, passPercent: passPercentFor(exam, defaultPass), negativeMarking: Number((r as any).negativeMarking) || 0, qStats: [], subjectId: exam?.subjectId || "" };
  }, [live, saved.data, id, wanted, exam, defaultPass]);

  if (!live && saved.loading) return <Page title="Result" back="/results"><SkeletonCards n={2} h={160} /></Page>;
  if (!view) return <Page title="Result" back="/results"><Empty icon={alertCircleOutline} title="Result not found" text="We couldn't find a saved result for this exam yet." action={<Btn onClick={() => router.push("/results", "root", "replace")}>All results</Btn>} /></Page>;

  const pass = view.percent >= view.passPercent;
  const A: any = Analytics.buildCoreAnalytics({ examId: id, examTitle: view.title, examType: view.type, score: view.score, total: view.total, percent: view.percent, correctCount: view.correct, wrongCount: view.wrong, unansweredCount: view.unanswered, timeTakenSeconds: view.seconds, durationSeconds: view.durationSeconds, passPercent: view.passPercent, negativeMarking: view.negativeMarking, qStats: view.qStats, attemptNumber: view.attemptNumber, auto: view.auto, subjectId: view.subjectId });
  const m = A?.m, tier = A?.tier, timing = A?.timing;
  const item = model?.items.find((i) => i.exam.id === id);
  const retry = () => { if (live) void persistAttempt(live); };

  return (
    <Page title="Result" back={live ? undefined : "/results"} right={live ? <button className="iconbtn" aria-label="Close" onClick={() => router.push("/exams", "root", "replace")}>✕</button> : undefined}>
      {live && live.saveState === "saving" && <Banner tone="info"><span className="spinner" /> Saving your result…</Banner>}
      {live && live.saveState === "saved" && <Banner tone="ok"><Ico n={checkmarkCircle} /> Result saved. It also appears on the website.</Banner>}
      {live && live.saveState === "failed" && <Banner tone="warn"><Ico n={alertCircleOutline} /><span className="grow">Not saved yet — no connection. Your answers are safe on this phone.</span><Btn className="small" kind="ghost" onClick={retry}><Ico n={refreshOutline} /> Retry</Btn></Banner>}
      {live && live.saveState === "blocked" && <Banner tone="bad"><Ico n={alertCircleOutline} /> This attempt couldn't be saved because the exam's attempt limit was already reached.</Banner>}
      {view.auto && <Banner tone="warn"><Ico n={timeOutline} /> Time was up — your answers were submitted automatically.</Banner>}
      <div className="cols">
        <div className="stack">
          <Card>
            <div className="row" style={{ gap: 18 }}>
              <Ring percent={view.percent} tone={pass ? "ok" : "bad"}><div><b style={{ fontSize: 30 }}>{view.percent}%</b><p className="tiny muted">{scoreText(view.score)}/{view.total}</p></div></Ring>
              <div className="stack-s grow">
                <div className="row-s wrap"><Chip tone={pass ? "ok" : "bad"}>{pass ? "Passed" : "Below pass mark"}</Chip><Chip>Pass {view.passPercent}%</Chip></div>
                <h2>{tier?.title || (pass ? "Well done" : "Keep practising")}</h2>
              </div>
            </div>
            {tier?.message && <p className="muted" style={{ marginTop: 12 }}>{tier.message}</p>}
          </Card>
          <div className="grid-2">
            <Stat label="Correct" value={view.correct} tone="ok" />
            <Stat label="Wrong" value={view.wrong} tone="bad" />
            <Stat label="Skipped" value={view.unanswered} />
            <Stat label="Time taken" value={durationLabel(view.seconds)} />
          </div>
          {view.negativeMarking > 0 && view.type !== "practice" && m && <p className="small muted">Negative marking: −{view.negativeMarking} per wrong answer{m.penalty ? ` (−${scoreText(m.penalty)} in total)` : ""}.</p>}
        </div>
        <div className="stack">
          {m?.allowedSeconds > 0 && (
            <Card><div className="stack">
              <h3>How you used your time</h3>
              <div className="bar"><i style={{ width: `${Math.min(100, m.timeUsedPercent)}%` }} /></div>
              <p className="small muted">{m.timeUsedPercent}% of {durationLabel(m.allowedSeconds)} · about {Math.round(m.avgSecondsPerQuestion)} sec per question (allowed {Math.round(m.allowedSecondsPerQuestion)} sec).</p>
              {timing?.tracked && timing.slowest?.length > 0 && <p className="small">Slowest: {timing.slowest.map((s: any) => `Q${s.n} (${s.sec}s)`).join(", ")}</p>}
            </div></Card>
          )}
          {item && (item.status.cta === "retake" || item.status.cta === "start") && <Btn kind="soft" block onClick={() => router.push(`/exams/${id}`, "forward")}>{item.status.cta === "retake" ? "Retake this exam" : "Open exam"}</Btn>}
          <Btn kind="ghost" block onClick={() => router.push("/results", "root", "replace")}>All results</Btn>
        </div>
      </div>
      <Head title="Review your mistakes" />
      {view.review === null ? <Card><p className="muted">The detailed review is kept for 48 hours after you submit, so it's no longer available for this attempt.</p></Card>
        : view.review.length === 0 ? <Card tone="ok"><p className="strong"><Ico n={checkmarkCircle} /> Perfect — every answer was correct.</p></Card>
        : <div className="stack">
          {view.reviewLeftMs !== null && <p className="tiny muted">Review available for about {Math.max(1, Math.round(view.reviewLeftMs / 3_600_000))} more hour(s).</p>}
          {view.review.map((r) => (
            <Card key={r.n}><div className="stack">
              <div className="row-s"><Chip tone={r.selected === null ? "" : "bad"}>{r.selected === null ? "Skipped" : "Wrong"}</Chip><span className="small muted">Question {r.n}</span></div>
              <p className="qtext" style={{ fontSize: 16 }}>{r.text}</p>
              <div className="stack-s">{r.options.map((o, i) => {
                const right = i === r.correctIndex, mine = i === r.selected;
                return <div key={i} className={`option ${right ? "right" : mine ? "wrong" : ""}`} aria-label={`${right ? "Correct answer" : mine ? "Your answer" : "Option"} ${LETTERS[i]}`}><span className="letter">{LETTERS[i] || i + 1}</span><span className="grow" style={{ whiteSpace: "pre-wrap" }}>{o}</span>{right ? <Ico n={checkmarkCircle} /> : mine ? <Ico n={closeCircle} /> : null}</div>;
              })}</div>
              {r.explanation && <div className="banner info" style={{ display: "block", whiteSpace: "pre-wrap" }}><b>Explanation</b><br />{r.explanation}</div>}
            </div></Card>
          ))}
        </div>}
    </Page>
  );
}
