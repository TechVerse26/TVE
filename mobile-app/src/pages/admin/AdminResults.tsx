import { useMemo, useState } from "react";
import { ribbonOutline } from "ionicons/icons";
import { Chip, Empty, ErrorBox, Page, SearchBox, SkeletonCards } from "../../ui/kit";
import { useAsync } from "../../state/hooks";
import { fetchAllUsers, fetchResultsOfExam } from "../../core/admin/data";
import { fetchAllExamsAdmin } from "../../core/repo/exams";
import { countAttempts } from "../../core/result-rules";
import { formatDateTime, scoreText } from "../../core/format";
import { passPercentFor, toMs } from "../../core/shared";

export default function AdminResults() {
  const exams = useAsync(() => fetchAllExamsAdmin(), []);
  const users = useAsync(() => fetchAllUsers(), []);
  const [examId, setExamId] = useState("");
  const [q, setQ] = useState("");
  const results = useAsync(() => (examId ? fetchResultsOfExam(examId) : Promise.resolve([])), [examId]);
  const exam = exams.data?.find((e) => e.id === examId);
  const byUid = useMemo(() => new Map((users.data || []).map((u) => [u.uid, u])), [users.data]);
  const rows = useMemo(() => (results.data || []).map((r: any) => ({ ...r, u: byUid.get(r.uid) })).filter((r) => !q.trim() || `${r.u?.displayName || ""} ${r.u?.email || ""} ${r.u?.roll || ""}`.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.percent - a.percent), [results.data, byUid, q]);
  const pass = exam ? passPercentFor(exam, 60) : 60;
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.percent, 0) / rows.length) : 0;

  return (
    <Page title="Results" back onRefresh={() => results.reload()}>
      <select className="select" value={examId} onChange={(e) => setExamId(e.target.value)} aria-label="Choose an exam"><option value="">Choose an exam…</option>{(exams.data || []).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select>
      {!examId ? <Empty icon={ribbonOutline} title="Pick an exam" text="See every student's latest score for that exam." /> : results.error ? <ErrorBox text="Couldn't load results. You may not have permission." onRetry={() => results.reload()} /> : results.loading ? <SkeletonCards n={4} h={70} /> : rows.length === 0 ? <Empty icon={ribbonOutline} title="No results yet" text="Nobody has submitted this exam yet." /> : (
        <>
          <div className="row-s wrap"><Chip tone="info">{rows.length} student{rows.length === 1 ? "" : "s"}</Chip><Chip>Average {avg}%</Chip><Chip tone="ok">Pass ≥ {pass}%</Chip></div>
          <SearchBox value={q} onChange={setQ} placeholder="Search a student" />
          <div className="card flush"><div className="list">{rows.map((r) => (
            <div className="listrow" key={r.id}><b style={{ width: 26, color: "var(--c-muted)" }}>{rows.indexOf(r) + 1}</b>
              <div className="grow"><p className="strong">{r.u?.displayName || r.u?.email || "Unknown student"}</p><p className="small muted">{r.u?.roll ? `Roll ${r.u.roll} · ` : ""}{scoreText(r.score)}/{r.total} · {countAttempts(r)} attempt{countAttempts(r) === 1 ? "" : "s"} · {formatDateTime(toMs(r.submittedAt))}</p></div>
              <Chip tone={r.percent >= pass ? "ok" : "bad"}>{r.percent}%</Chip></div>))}</div></div>
        </>
      )}
    </Page>
  );
}
