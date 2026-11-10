import { useMemo, useState } from "react";
import { pulseOutline } from "ionicons/icons";
import { Chip, Empty, ErrorBox, Page, SearchBox, SkeletonCards } from "../../ui/kit";
import { useAsync } from "../../state/hooks";
import { fetchLogs } from "../../core/admin/data";
import { formatDateTime } from "../../core/format";
import { toMs } from "../../core/shared";

export default function AdminLogs() {
  const logs = useAsync(() => fetchLogs(150), []);
  const [q, setQ] = useState("");
  const rows = useMemo(() => (logs.data || []).filter((l: any) => !q.trim() || `${l.action} ${l.label} ${l.name} ${l.email} ${l.detail}`.toLowerCase().includes(q.trim().toLowerCase())), [logs.data, q]);
  return (
    <Page title="Activity log" back onRefresh={() => logs.reload()}>
      <SearchBox value={q} onChange={setQ} placeholder="Search activity" />
      {logs.error && !logs.data ? <ErrorBox text="Couldn't load the log. You may not have permission." onRetry={() => logs.reload()} /> : logs.loading && !logs.data ? <SkeletonCards n={5} h={70} /> : rows.length === 0 ? <Empty icon={pulseOutline} title="No activity" text="Admin actions from the website and the app are recorded here." /> : (
        <div className="card flush"><div className="list">{rows.map((l: any) => (
          <div className="listrow" key={l.id} style={{ alignItems: "flex-start" }}><div className="grow"><div className="row-s wrap"><Chip tone="info">{l.action}</Chip>{l.role && <Chip>{l.role}</Chip>}</div><p className="strong small" style={{ marginTop: 4 }}>{l.label || l.targetId || "—"}</p>{l.detail && <p className="small muted">{l.detail}</p>}<p className="tiny muted">{l.name || l.email} · {formatDateTime(toMs(l.at))}</p></div></div>))}</div></div>
      )}
    </Page>
  );
}
