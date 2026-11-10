import { useMemo } from "react";
import { useIonRouter } from "@ionic/react";
import { calendarOutline, chevronForward, documentTextOutline, libraryOutline, megaphoneOutline, playCircleOutline, ribbonOutline, schoolOutline, speedometerOutline, trophyOutline, alertCircleOutline, folderOpenOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Empty, ErrorBox, Head, Ico, Page, SkeletonCards, Stat } from "../../ui/kit";
import { CountdownText, ExamCard } from "../../ui/exam-ui";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useTick } from "../../state/hooks";
import { listSessions } from "../../core/session";
import { serverNow } from "../../core/clock";
import { clockLabel } from "../../core/format";
import { countdownParts, firstName, greetingBn, liveItems, nextExamItem, noticeCategory, noticePriority, performanceFromStats, pickMotivation, recentResultRows, statusGroup, visibleNotices } from "../../core/shared";
import { Session } from "../../core/shared";

function ExamHero({ onOpen }: { onOpen: (id: string) => void }) {
  const { model } = useStudent();
  const now = useTick();
  if (!model) return null;
  const live = liveItems(model.items)[0];
  const next = live || nextExamItem(model.items);
  if (!next) {
    return (
      <div className="hero stack">
        <h2>No exam is scheduled right now</h2>
        <p className="muted">Keep your streak alive with a practice exam — it is risk-free.</p>
        <Btn block onClick={() => onOpen("")}>Browse exams</Btn>
      </div>
    );
  }
  const { exam, status } = next;
  const target = live ? status.endsAt : status.startsAt;
  const parts = target ? countdownParts(Math.max(0, target - now)) : [];
  return (
    <div className="hero stack">
      <div className="row between"><Chip tone={live ? "live" : "info"}>{live ? "Live now" : "Up next"}</Chip>{target ? <span className="small muted"><CountdownText status={status} /></span> : null}</div>
      <h2 style={{ fontSize: 22 }}>{exam.title}</h2>
      {parts.length > 0 && <div className="units" aria-hidden="true">{parts.slice(0, 4).map((p, i) => <div className="unit" key={i}><b>{p.value}</b><span>{p.unit}</span></div>)}</div>}
      <Btn block onClick={() => onOpen(exam.id)}>{status.cta === "start" || status.cta === "retake" ? "Start exam" : "View details"}</Btn>
    </div>
  );
}

export default function Home() {
  const router = useIonRouter();
  const { user, profile, isAdmin } = useAuth();
  const { model, loading, error, refresh } = useStudent();
  const now = useTick();
  const open = (id: string) => router.push(id ? `/exams/${id}` : "/exams", "forward");
  const sessions = useMemo(() => (user ? listSessions(user.uid, serverNow()) : []), [user, Math.floor(now / 5000)]);
  const name = firstName(profile?.displayName || user?.displayName || "") || "Student";

  const body = () => {
    if (error && !model) return <ErrorBox onRetry={() => refresh(true)} />;
    if (loading || !model) return <SkeletonCards n={3} />;
    const perf = performanceFromStats(model.stats, { examsById: model.examsById, defaultPass: model.passPercent });
    const recent = recentResultRows(model.stats, { examsById: model.examsById, defaultPass: model.passPercent, limit: 3 });
    const notices = visibleNotices(model.feed.notices, { now: model.now, profile, exams: Object.values(model.examsById), categories: model.feed.taxonomy.categories }).slice(0, 3);
    const available = model.items.filter((i) => statusGroup(i.status.key) === "available").slice(0, 3);
    const motivation = pickMotivation(model.feed.content, model.now);
    return (
      <>
        {model.maintenance && <Banner tone="warn"><Ico n={alertCircleOutline} /> {model.siteMessage || "New exams can't be started right now. Please check back soon."}</Banner>}
        {profile?.disabled && <Banner tone="bad"><Ico n={alertCircleOutline} /> Your account is deactivated — you can look around but can't start exams.</Banner>}
        {sessions.map(({ session, verdict }) => (
          <Card key={session.examId} tone="warn">
            <div className="row">
              <Ico n={playCircleOutline} />
              <div className="grow">
                <p className="strong">{verdict.state === "resume" ? "Exam in progress" : verdict.state === "expired" ? "Time ran out — finish & save" : "Result not saved yet"}</p>
                <p className="small">{session.exam?.title || "Exam"}{verdict.state === "resume" ? ` · ${clockLabel(verdict.left)} left` : ""}</p>
              </div>
              <Btn className="small" onClick={() => router.push(`/exams/${session.examId}/play`, "forward")}>{verdict.state === "resume" ? "Resume" : "Save"}</Btn>
            </div>
          </Card>
        ))}
        <div className="cols">
          <div className="stack"><ExamHero onOpen={open} /></div>
          <div className="stack">
            <div className="tiles">
              {[
                { l: "Exams", i: documentTextOutline, p: "/exams" }, { l: "Schedule", i: calendarOutline, p: "/schedule" }, { l: "Results", i: ribbonOutline, p: "/results" }, { l: "Leaderboard", i: trophyOutline, p: "/leaderboard" },
                { l: "Progress", i: speedometerOutline, p: "/performance" }, { l: "Subjects", i: folderOpenOutline, p: "/categories" }, { l: "Academic", i: schoolOutline, p: "/academic" }, { l: "Notices", i: megaphoneOutline, p: "/notifications" },
              ].map((t) => <button key={t.p} className="tile" onClick={() => router.push(t.p, "forward")}><Ico n={t.i} />{t.l}</button>)}
            </div>
            <div className="grid-3">
              <Stat label="Exams taken" value={perf.taken} />
              <Stat label="Average" value={perf.taken ? `${perf.avg}%` : "—"} tone="info" />
              <Stat label="Best" value={perf.taken ? `${perf.best}%` : "—"} tone="ok" />
            </div>
          </div>
        </div>
        {available.length > 0 && <><Head title="Open for you" action="See all" onAction={() => router.push("/exams", "forward")} /><div className="list-2 stack">{available.map((i) => <ExamCard key={i.exam.id} item={i} taxonomy={model.feed.taxonomy} />)}</div></>}
        {recent.length > 0 && (
          <>
            <Head title="Recent results" action="All results" onAction={() => router.push("/results", "forward")} />
            <Card className="flush"><div className="list">{recent.map((r) => (
              <button className="listrow" key={r.examId} onClick={() => router.push("/results", "forward")}>
                <div className="grow"><p className="strong">{r.title}</p><p className="small muted">{r.score}/{r.total} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}</p></div>
                <Chip tone={r.pass ? "ok" : "bad"}>{r.percent}%</Chip><Ico n={chevronForward} className="chev" />
              </button>))}</div></Card>
          </>
        )}
        {notices.length > 0 && (
          <>
            <Head title="Notices" action="See all" onAction={() => router.push("/notifications", "forward")} />
            <div className="stack">{notices.map((n) => (
              <Card key={n.id} onClick={() => router.push("/notifications", "forward")}>
                <div className="row-s wrap"><Chip tone={n.priority === "urgent" ? "bad" : n.priority === "important" ? "warn" : "info"}>{noticePriority(n.priority).label}</Chip><Chip>{noticeCategory(n.category).label}</Chip></div>
                <h3 style={{ marginTop: 8 }}>{n.title}</h3>
                <p className="muted small" style={{ marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{n.body}</p>
              </Card>))}</div>
          </>
        )}
        {model.items.length === 0 && <Empty icon={libraryOutline} title="No exams yet" text="When exams are published for you they will appear here." />}
        {motivation.text && <p className="center muted small" style={{ padding: "4px 16px" }}>“{motivation.text}”</p>}
      </>
    );
  };

  return (
    <Page title={`${greetingBn(serverNow())}, ${name}`} onRefresh={() => refresh(true)} right={isAdmin ? <button className="iconbtn" aria-label="Admin panel" onClick={() => router.push("/admin", "forward")}><Ico n={speedometerOutline} /></button> : undefined}>
      {body()}
    </Page>
  );
}
void Session;
