import { speedometerOutline } from "ionicons/icons";
import { useIonRouter } from "@ionic/react";
import { Btn, Card, Chip, Empty, ErrorBox, Head, Page, SkeletonCards, Stat } from "../../ui/kit";
import { useStudent } from "../../state/student";
import { performanceFromStats, subjectNameOf } from "../../core/shared";
import { formatDate } from "../../core/format";

export default function Performance() {
  const router = useIonRouter();
  const { model, loading, error, refresh } = useStudent();
  const body = () => {
    if (error && !model) return <ErrorBox onRetry={() => refresh(true)} />;
    if (loading || !model) return <SkeletonCards n={3} />;
    const perf = performanceFromStats(model.stats, { examsById: model.examsById, defaultPass: model.passPercent });
    if (!perf.taken) return <Empty icon={speedometerOutline} title="No progress to show yet" text="Finish an exam and your averages, pass rate and trend will build up here." action={<Btn onClick={() => router.push("/exams", "forward")}>Find an exam</Btn>} />;
    const rows = perf.rows.slice().sort((a, b) => b.at - a.at);
    const trend = rows.slice(0, 8).reverse();
    const bySubject = new Map<string, { sum: number; n: number }>();
    rows.forEach((r) => { const s = model.examsById[r.examId]?.subjectId; if (!s) return; const e = bySubject.get(s) || { sum: 0, n: 0 }; e.sum += r.p; e.n++; bySubject.set(s, e); });
    return (
      <>
        <div className="grid-4"><Stat label="Exams taken" value={perf.taken} /><Stat label="Average" value={`${perf.avg}%`} tone="info" /><Stat label="Best" value={`${perf.best}%`} tone="ok" /><Stat label="Pass rate" value={perf.passRate === null ? "—" : `${perf.passRate}%`} /></div>
        <div className="cols cols-eq">
          <div className="stack">
            <Head title="Recent trend" />
            <Card><svg viewBox="0 0 300 110" role="img" aria-label="Your last scores" style={{ width: "100%" }}>
              {[0, 50, 100].map((y) => <line key={y} x1="0" x2="300" y1={105 - y} y2={105 - y} stroke="var(--c-line)" />)}
              {trend.map((r, i) => { const x = trend.length === 1 ? 150 : 10 + (i * 280) / (trend.length - 1); const h = Math.max(3, r.p); return <g key={r.examId}><rect x={x - 10} y={105 - h} width="20" height={h} rx="5" fill={r.p >= model.passPercent ? "var(--c-ok)" : "var(--c-accent)"} opacity=".9" /><text x={x} y={104 - h - 3} textAnchor="middle" fontSize="9" fill="var(--c-muted)">{r.p}</text></g>; })}
            </svg><p className="tiny muted center">Latest {trend.length} exam{trend.length === 1 ? "" : "s"} (percent)</p></Card>
            {bySubject.size > 0 && <><Head title="By subject" /><Card><div className="stack">{[...bySubject.entries()].map(([id, e]) => { const avg = Math.round(e.sum / e.n); return <div key={id} className="stack-s"><div className="row between"><span className="strong">{subjectNameOf(model.feed.taxonomy, id) || "Subject"}</span><span>{avg}%</span></div><div className={`bar ${avg >= model.passPercent ? "ok" : "warn"}`}><i style={{ width: `${Math.max(3, avg)}%` }} /></div></div>; })}</div></Card></>}
          </div>
          <div className="stack">
            <Head title="Every exam" />
            <Card className="flush"><div className="list">{rows.map((r) => (
              <button className="listrow" key={r.examId} onClick={() => router.push(`/exams/${r.examId}`, "forward")}>
                <div className="grow"><p className="strong">{r.ti || model.examsById[r.examId]?.title || "Exam"}</p><p className="small muted">{formatDate(r.at)} · {r.n} attempt{r.n === 1 ? "" : "s"}{r.b !== undefined && r.b !== r.p ? ` · best ${r.b}%` : ""}</p></div>
                <Chip tone={r.p >= model.passPercent ? "ok" : "bad"}>{r.p}%</Chip>
              </button>))}</div></Card>
          </div>
        </div>
      </>
    );
  };
  return <Page title="My progress" back onRefresh={() => refresh(true)}>{body()}</Page>;
}
