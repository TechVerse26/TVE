import { useMemo, useState } from "react";
import { useIonRouter } from "@ionic/react";
import { calendarOutline } from "ionicons/icons";
import { Card, Chip, Empty, ErrorBox, Head, Page, Seg, SkeletonCards } from "../../ui/kit";
import { CountdownText, StatusChip } from "../../ui/exam-ui";
import { useStudent } from "../../state/student";
import { formatDate, formatTimeOfDay } from "../../core/format";
import { groupByDay, scheduleItems, statusGroup } from "../../core/shared";

export default function Schedule() {
  const router = useIonRouter();
  const { model, loading, error, refresh } = useStudent();
  const [tab, setTab] = useState<"upcoming" | "past">("upcoming");
  const groups = useMemo(() => {
    if (!model) return [];
    if (tab === "upcoming") return groupByDay(scheduleItems(model.items, model.now), model.now);
    const past = scheduleItems(model.items, model.now, { includePast: true }).filter((i) => ["completed", "closed"].includes(statusGroup(i.status.key)) && i.status.startsAt);
    return groupByDay(past.sort((a, b) => (b.status.startsAt || 0) - (a.status.startsAt || 0)), model.now);
  }, [model, tab]);
  const label = (g: { diff: number; dayStart: number }) => (g.diff === 0 ? "Today" : g.diff === 1 ? "Tomorrow" : g.diff === -1 ? "Yesterday" : formatDate(g.dayStart));

  return (
    <Page title="Schedule" onRefresh={() => refresh(true)}>
      <Seg options={[{ id: "upcoming", label: "Upcoming" }, { id: "past", label: "Past" }]} value={tab} onChange={setTab} />
      {error && !model ? <ErrorBox onRetry={() => refresh(true)} /> : loading || !model ? <SkeletonCards n={3} /> : groups.length === 0 ? (
        <Empty icon={calendarOutline} title={tab === "upcoming" ? "Nothing scheduled" : "No past exams yet"} text={tab === "upcoming" ? "Live exams with a set date and time will appear here." : "Exams you could join will be listed here after they close."} />
      ) : groups.map((g) => (
        <div className="stack" key={g.key}>
          <Head title={label(g)} />
          <Card className="flush"><div className="list">{g.rows.map((r) => (
            <button className="listrow" key={r.exam.id} onClick={() => router.push(`/exams/${r.exam.id}`, "forward")}>
              <div style={{ width: 64 }} className="num strong small">{formatTimeOfDay(r.status.startsAt)}</div>
              <div className="grow"><p className="strong">{r.exam.title}</p><p className="small muted">{r.exam.duration || 10} min{r.status.key !== "completed" && r.status.key !== "closed" ? <> · <CountdownText status={r.status} /></> : null}</p></div>
              <StatusChip status={r.status} />
            </button>))}</div></Card>
        </div>
      ))}
      {model && tab === "upcoming" && <p className="tiny muted center"><Chip>Times follow your phone's time zone</Chip></p>}
    </Page>
  );
}
