import { useMemo, useState } from "react";
import { trophyOutline } from "ionicons/icons";
import { Avatar, Card, Chips, Empty, ErrorBox, Head, Ico, Page, SkeletonCards } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useAsync } from "../../state/hooks";
import { fetchPublicStats } from "../../core/repo/home";
import { examLeadersFrom, performanceFromStats, rankOf, topPerformers, toMs } from "../../core/shared";
import { formatDateTime } from "../../core/format";

export default function Leaderboard() {
  const { profile } = useAuth();
  const { model, refresh } = useStudent();
  const pct = useAsync(() => fetchPublicStats(), []);
  const [sel, setSel] = useState("");
  const names = model?.feed.content?.leaderboardNames;
  const data = useMemo(() => {
    if (!model) return null;
    const perf = model.stats ? performanceFromStats(model.stats, { examsById: model.examsById, defaultPass: model.passPercent }) : null;
    const top = topPerformers(pct.data, names, 10);
    const boards = examLeadersFrom(pct.data, names, 10);
    return { perf, rk: rankOf(pct.data?.percents, perf?.ownLiveAvg ?? null), top, boards };
  }, [model, pct.data, names]);
  const myRoll = String(profile?.roll || "");
  const board = data?.boards.find((b) => b.id === sel) || data?.boards[0];

  const row = (rank: number, name: string, sub: string, value: string, photo: string, mine: boolean) => (
    <div className="listrow" key={`${rank}-${name}`} style={mine ? { background: "var(--c-accent-soft)" } : undefined}>
      <b style={{ width: 28, textAlign: "center", color: rank <= 3 ? "var(--c-warn)" : "var(--c-muted)" }}>{rank}</b>
      <Avatar name={name} photo={photo} size={38} />
      <div className="grow"><p className="strong">{name}{mine ? " (you)" : ""}</p><p className="small muted">{sub}</p></div>
      <b>{value}</b>
    </div>
  );

  return (
    <Page title="Leaderboard" back onRefresh={async () => { await refresh(true); await pct.reload(); }}>
      {pct.error && !pct.data ? <ErrorBox onRetry={() => pct.reload()} /> : !data || (pct.loading && !pct.data) ? <SkeletonCards n={2} /> : (
        <>
          {data.perf && data.perf.ownLiveAvg !== null ? (
            <Card tone="soft"><div className="row"><div className="grow"><p className="small muted">Your rank</p><p style={{ fontSize: 30, fontWeight: 800 }}>{data.rk ? `#${data.rk.rank}` : "—"}{data.rk && <span className="small muted"> of {data.rk.total}</span>}</p></div><div><p className="small muted">Your average</p><b style={{ fontSize: 22 }}>{data.perf.ownLiveAvg}%</b></div><div><p className="small muted">Live exams</p><b style={{ fontSize: 22 }}>{data.perf.liveTaken}</b></div></div></Card>
          ) : <Card><p className="strong">You don't have a rank yet</p><p className="muted small">Take at least one live exam to get ranked.</p></Card>}
          <Head title="Top performers" />
          {data.top.length ? <Card className="flush"><div className="list">{data.top.map((t) => row(t.rank, t.name, [t.roll && `Roll ${t.roll}`, `${t.exams} live exam${t.exams === 1 ? "" : "s"}`].filter(Boolean).join(" · "), `${t.percent}%`, t.photo, !!myRoll && t.roll === myRoll))}</div></Card>
            : <Empty icon={trophyOutline} title="Not published yet" text="The top performers list will appear here once the admin publishes it." />}
          {data.boards.length > 0 && board && (
            <>
              <Head title="Exam-wise leaders" />
              <Chips options={data.boards.map((b) => ({ id: b.id, label: b.title }))} value={board.id} onChange={setSel} />
              <Card className="flush"><div className="list">{board.top.map((t) => row(t.rank, t.name, [t.roll && `Roll ${t.roll}`, t.total ? `${t.score}/${t.total}` : ""].filter(Boolean).join(" · "), `${t.percent}%`, t.photo, !!myRoll && t.roll === myRoll))}</div></Card>
              <p className="tiny muted">{board.count} student{board.count === 1 ? "" : "s"} took part. Each student's best attempt counts.</p>
            </>
          )}
          {toMs(pct.data?.updatedAt) ? <p className="tiny muted center"><Ico n={trophyOutline} /> Last updated {formatDateTime(toMs(pct.data?.updatedAt))}</p> : null}
        </>
      )}
    </Page>
  );
}
