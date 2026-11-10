import { useIonRouter } from "@ionic/react";
import { chevronForward, flashOutline, timeOutline, helpCircleOutline, checkmarkCircle, lockClosedOutline } from "ionicons/icons";
import { Card, Chip, Ico } from "./kit";
import { useTick } from "../state/hooks";
import { countdownShort, getExamQuestionCount, subjectNameOf } from "../core/shared";
import { formatDateTime } from "../core/format";
import type { ExamItem, Status } from "../core/types";

export const statusTone = (k: Status["key"]): "" | "ok" | "warn" | "bad" | "info" | "live" | "teal" =>
  ({ live: "live", soon: "warn", upcoming: "info", open: "teal", completed: "ok", closed: "", unavailable: "bad" } as const)[k] ?? "";

export const StatusChip = ({ status }: { status: Status }) => <Chip tone={statusTone(status.key)}>{status.label}</Chip>;

/** "Starts in 2d 4h" / "Ends in 12:30" — ticks every second from the server-corrected clock. */
export function CountdownText({ status }: { status: Status }) {
  const now = useTick();
  if (status.key === "live" && status.endsAt) return <>Ends in {countdownShort(Math.max(0, status.endsAt - now))}</>;
  if ((status.key === "upcoming" || status.key === "soon") && status.startsAt) return <>Starts in {countdownShort(Math.max(0, status.startsAt - now))}</>;
  return null;
}

export function ExamCard({ item, taxonomy }: { item: ExamItem; taxonomy?: unknown }) {
  const router = useIonRouter();
  const { exam, status } = item;
  const subject = taxonomy && exam.subjectId ? subjectNameOf(taxonomy, exam.subjectId) : "";
  const questions = getExamQuestionCount(exam);
  return (
    <Card onClick={() => router.push(`/exams/${exam.id}`, "forward")}>
      <div className="stack-s">
        <div className="row wrap" style={{ gap: 8 }}>
          <StatusChip status={status} />
          <Chip>{exam.examType === "practice" ? "Practice" : "Live exam"}</Chip>
          {subject && <Chip tone="teal">{subject}</Chip>}
          {item.last && <Chip tone="ok"><Ico n={checkmarkCircle} /> {item.last.p}%</Chip>}
        </div>
        <div className="row">
          <h3 className="grow">{exam.title}</h3>
          <Ico n={chevronForward} className="muted" />
        </div>
        <div className="row-s wrap muted small" style={{ gap: 14 }}>
          {exam.duration ? <span className="row-s"><Ico n={timeOutline} /> {exam.duration} min</span> : null}
          {questions ? <span className="row-s"><Ico n={helpCircleOutline} /> {questions} questions</span> : null}
          {Number(exam.negativeMarking) > 0 && exam.examType !== "practice" ? <span className="row-s"><Ico n={flashOutline} /> −{exam.negativeMarking} per wrong</span> : null}
          {status.reason === "registration-closed" || status.reason === "maintenance" ? <span className="row-s"><Ico n={lockClosedOutline} /> Not open</span> : null}
        </div>
        {(status.key === "upcoming" || status.key === "soon" || status.key === "live") && (
          <p className="small strong" style={{ color: status.key === "live" ? "var(--c-live)" : "var(--c-accent)" }}>
            <CountdownText status={status} />{status.startsAt && status.key !== "live" ? <span className="muted"> · {formatDateTime(status.startsAt)}</span> : null}
          </p>
        )}
      </div>
    </Card>
  );
}
