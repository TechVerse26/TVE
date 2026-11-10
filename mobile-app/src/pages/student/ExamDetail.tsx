import { useState } from "react";
import { useParams } from "react-router-dom";
import { useIonRouter } from "@ionic/react";
import { alertCircleOutline, calendarOutline, checkmarkCircle, flashOutline, helpCircleOutline, ribbonOutline, repeatOutline, timeOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Empty, Head, Ico, Page, SkeletonCards } from "../../ui/kit";
import { CountdownText, StatusChip } from "../../ui/exam-ui";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useTick } from "../../state/hooks";
import { fetchExam, getExamCatalog } from "../../core/repo/exams";
import { checkAcademicExamAccess } from "../../core/repo/academic";
import { getAttemptsCount } from "../../core/repo/results";
import { verifyStart, type Block } from "../../core/exam-flow";
import { loadSession } from "../../core/session";
import { serverNow } from "../../core/clock";
import { syncServerTimeSoon } from "../../core/time";
import { formatDateTime } from "../../core/format";
import { getExamQuestionCount, guidelinesOf, passPercentFor, Session } from "../../core/shared";

function Fact({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="stat"><span className="row-s"><Ico n={icon} /> {label}</span><b style={{ fontSize: 18 }}>{value}</b></div>;
}

export default function ExamDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useIonRouter();
  const { user, profile, isAdmin } = useAuth();
  const { model, loading, refresh } = useStudent();
  useTick();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Block | null>(null);
  const item = model?.items.find((i) => i.exam.id === id);

  async function start() {
    if (!user) return;
    const saved = loadSession(user.uid, id);
    if (saved && Session.judge(saved, serverNow()).state !== "stale") return router.push(`/exams/${id}/play`, "forward");
    setBusy(true); setBlocked(null);
    await syncServerTimeSoon();
    const check = await verifyStart(id, { uid: user.uid, profile, isAdmin }, {
      fetchExam, getSite: async () => (await getExamCatalog()).site, attemptsUsed: getAttemptsCount, now: serverNow,
      academicGate: (exam) => checkAcademicExamAccess(exam, { uid: user.uid, isAdmin }),
    }).catch(() => ({ ok: false as const, title: "Couldn't check this exam", message: "Check your internet connection and try again." }));
    setBusy(false);
    if (!check.ok) return setBlocked({ title: check.title, message: check.message });
    router.push(`/exams/${id}/play`, "forward");
  }

  if (loading || !model) return <Page title="Exam" back><SkeletonCards n={2} h={150} /></Page>;
  if (!item) return <Page title="Exam" back><Empty icon={alertCircleOutline} title="Exam not found" text="It may have been removed or isn't available to your account." /></Page>;
  const { exam, status, last, attemptsUsed } = item;
  const pass = passPercentFor(exam, model.passPercent);
  const questions = getExamQuestionCount(exam);
  const practice = exam.examType === "practice";
  const guide = guidelinesOf(model.feed.content);
  const saved = user ? loadSession(user.uid, id) : null;
  const canResume = !!saved && Session.judge(saved, serverNow()).state !== "stale";
  const cta = canResume ? { label: "Resume exam", enabled: true } : status.cta === "start" ? { label: "Start exam", enabled: true } : status.cta === "retake" ? { label: "Retake exam", enabled: true } : { label: status.cta === "result" ? "Not available" : "Not open yet", enabled: false };

  return (
    <Page title="Exam details" back>
      <div className="cols">
        <div className="stack">
          <Card>
            <div className="stack-s">
              <div className="row wrap" style={{ gap: 8 }}><StatusChip status={status} /><Chip>{practice ? "Practice" : "Live exam"}</Chip>{exam.courseName && <Chip tone="teal">{exam.courseName}</Chip>}</div>
              <h1>{exam.title}</h1>
              {exam.description && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{exam.description}</p>}
              {(status.key === "upcoming" || status.key === "soon" || status.key === "live") && <p className="strong" style={{ color: status.key === "live" ? "var(--c-live)" : "var(--c-accent)" }}><CountdownText status={status} /></p>}
            </div>
          </Card>
          {blocked && <Banner tone="bad"><Ico n={alertCircleOutline} /><span><b>{blocked.title}</b><br />{blocked.message}</span></Banner>}
          {status.reason && !cta.enabled && !blocked && <Banner tone="warn">{reasonText(status.reason)}</Banner>}
          {last && (
            <Card tone="ok"><div className="row"><Ico n={checkmarkCircle} /><div className="grow"><p className="strong">You scored {last.p}% ({last.s}/{last.t})</p><p className="small">Attempt {last.n}{last.b !== undefined ? ` · best ${last.b}%` : ""}</p></div><Btn kind="ghost" className="small" onClick={() => router.push("/results", "forward")}>Results</Btn></div></Card>
          )}
        </div>
        <div className="stack">
          <div className="grid-2">
            <Fact icon={timeOutline} label="Duration" value={`${exam.duration || 10} min`} />
            <Fact icon={helpCircleOutline} label="Questions" value={questions ? String(questions) : "—"} />
            <Fact icon={flashOutline} label="Negative marks" value={practice || !Number(exam.negativeMarking) ? "None" : `−${exam.negativeMarking}`} />
            <Fact icon={ribbonOutline} label="Pass mark" value={`${pass}%`} />
            <Fact icon={repeatOutline} label="Attempts" value={Number(exam.maxAttempts) > 0 ? `${attemptsUsed} of ${exam.maxAttempts}` : attemptsUsed ? `${attemptsUsed} used` : "Unlimited"} />
            <Fact icon={calendarOutline} label={practice ? "Availability" : "Window"} value={practice && !status.startsAt ? "Always open" : status.startsAt ? formatDateTime(status.startsAt) : "—"} />
          </div>
          {status.endsAt && <p className="small muted">Closes {formatDateTime(status.endsAt)}</p>}
          {exam.instructions && <><Head title="Instructions" /><Card><p style={{ whiteSpace: "pre-wrap" }}>{String(exam.instructions)}</p></Card></>}
          {guide.length > 0 && <><Head title="Before you begin" /><Card><ul className="rich" style={{ margin: 0 }}>{guide.map((g, i) => <li key={i}>{g}</li>)}</ul></Card></>}
        </div>
      </div>
      <div className="stack-s" style={{ position: "sticky", bottom: 0, padding: "8px 0 4px", background: "var(--c-bg)" }}>
        <Btn block disabled={!cta.enabled} loading={busy} onClick={start}>{cta.label}</Btn>
      </div>
    </Page>
  );
}

function reasonText(reason: string) {
  return ({
    upcoming: "This exam hasn't started yet.", soon: "This exam starts very soon.", "window-closed": "The exam window has closed.", attempts: "You have used every attempt for this exam.",
    cancelled: "This exam has been cancelled.", "registration-closed": "Registration for this exam is closed.", maintenance: "New exams can't be started during maintenance.", disabled: "Your account is deactivated.",
  } as Record<string, string>)[reason] || "This exam can't be started right now.";
}
