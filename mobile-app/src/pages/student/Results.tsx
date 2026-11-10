import { useState } from "react";
import { useIonRouter } from "@ionic/react";
import { chevronForward, ribbonOutline, timeOutline } from "ionicons/icons";
import { Btn, Card, Chip, Empty, ErrorBox, Ico, Page, Sheet, SkeletonCards } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useAsync } from "../../state/hooks";
import { fetchMyResults } from "../../core/repo/results";
import { countAttempts, reviewMsLeft } from "../../core/result-rules";
import { formatDateTime, durationLabel, scoreText } from "../../core/format";
import { passPercentFor, toMs } from "../../core/shared";
import type { AttemptRecord, ResultDoc } from "../../core/types";

export default function Results() {
  const router = useIonRouter();
  const { user } = useAuth();
  const { model } = useStudent();
  const res = useAsync(() => fetchMyResults(user!.uid), [user?.uid]);
  const [open, setOpen] = useState<ResultDoc | null>(null);
  const passOf = (r: ResultDoc) => passPercentFor(model?.examsById[r.examId], model?.passPercent ?? 60);
  const refresh = async () => { await fetchMyResults(user!.uid, { force: true }); await res.reload(); };

  return (
    <Page title="Results" onRefresh={refresh}>
      {res.error && !res.data ? <ErrorBox onRetry={() => res.reload()} /> : res.loading && !res.data ? <SkeletonCards n={3} /> : !res.data?.length ? (
        <Empty icon={ribbonOutline} title="No results yet" text="After you finish an exam, your score and a review of your mistakes will show up here." action={<Btn onClick={() => router.push("/exams", "forward")}>Find an exam</Btn>} />
      ) : (
        <div className="list-2 stack">{res.data.map((r) => {
          const n = countAttempts(r);
          const pass = r.percent >= passOf(r);
          return (
            <Card key={r.id} onClick={() => setOpen(r)}>
              <div className="stack-s">
                <div className="row-s wrap"><Chip tone={pass ? "ok" : "bad"}>{pass ? "Passed" : "Below pass mark"}</Chip><Chip>{r.examType === "practice" ? "Practice" : "Live"}</Chip></div>
                <div className="row"><h3 className="grow">{r.examTitle || "Exam"}</h3><b style={{ fontSize: 24, color: pass ? "var(--c-ok)" : "var(--c-bad)" }}>{r.percent}%</b></div>
                <div className="bar" style={{ ...(pass ? {} : {}) }}><i style={{ width: `${Math.max(2, r.percent)}%`, background: pass ? "var(--c-ok)" : "var(--c-bad)" }} /></div>
                <p className="small muted">{scoreText(r.score)}/{r.total} · {n} attempt{n === 1 ? "" : "s"} · {formatDateTime(toMs(r.submittedAt))}</p>
              </div>
            </Card>
          );
        })}</div>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.examTitle || "Attempts"}>
        {open && <Attempts r={open} onReview={(n) => { setOpen(null); router.push(`/exams/${open.examId}/result?attempt=${n}`, "forward"); }} />}
      </Sheet>
    </Page>
  );
}

function Attempts({ r, onReview }: { r: ResultDoc; onReview: (n: number) => void }) {
  const list: AttemptRecord[] = Array.isArray(r.attempts) ? r.attempts : [];
  const base = countAttempts(r) - list.length; // attempts older than the stored history
  return (
    <div className="stack">
      <p className="muted small">Your latest attempts. A detailed review of mistakes is kept for 48 hours after you submit.</p>
      <div className="card flush"><div className="list">{list.slice().reverse().map((a, idx) => {
        const num = base + list.length - idx;
        const left = a.review ? reviewMsLeft(a.submittedAt) : null;
        return (
          <div className="listrow" key={a.id || num}>
            <div className="grow">
              <p className="strong">Attempt {num} · {a.percent}%</p>
              <p className="small muted">{scoreText(a.score)}/{a.total} · ✓{a.correctCount} ✗{a.wrongCount} · <Ico n={timeOutline} /> {durationLabel(a.timeTakenSeconds)}</p>
              <p className="tiny muted">{formatDateTime(toMs(a.submittedAt))}{left ? ` · review ${Math.max(1, Math.round(left / 3600000))}h left` : a.review === null ? " · review expired" : ""}</p>
            </div>
            {a.review && a.review.length > 0 ? <Btn kind="soft" className="small" onClick={() => onReview(num)}>Review <Ico n={chevronForward} /></Btn> : <Chip>{a.wrongCount + a.unansweredCount === 0 ? "Perfect" : "No review"}</Chip>}
          </div>
        );
      })}</div></div>
    </div>
  );
}
