import { useIonRouter } from "@ionic/react";
import { documentTextOutline, homeOutline, megaphoneOutline, peopleOutline, pulseOutline, ribbonOutline, shieldCheckmarkOutline, sendOutline, timeOutline } from "ionicons/icons";
import { Card, ErrorBox, Head, Ico, Page, SkeletonCards, Stat, Btn } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useAsync } from "../../state/hooks";
import { fetchLogs, fetchOverview } from "../../core/admin/data";
import { fetchAllExamsAdmin } from "../../core/repo/exams";
import { toMs, computeStatus } from "../../core/shared";
import { serverNow } from "../../core/clock";
import { formatDateTime } from "../../core/format";

export default function AdminHome() {
  const router = useIonRouter();
  const { profile, role, can } = useAuth();
  const overview = useAsync(() => fetchOverview(), []);
  const exams = useAsync(() => fetchAllExamsAdmin(), []);
  const logs = useAsync(() => (can("logs.view") ? fetchLogs(6) : Promise.resolve([])), [role]);
  const now = serverNow();
  const list = exams.data || [];
  const published = list.filter((e) => e.status !== "draft");
  const live = published.filter((e) => computeStatus(e, now).key === "live").length;
  const drafts = list.length - published.length;
  const o = overview.data;
  const go = (p: string) => router.push(p, "forward");
  const refresh = async () => { await Promise.all([overview.reload(), exams.reload(), logs.reload()]); };

  return (
    <Page title="Admin" onRefresh={refresh} right={<button className="iconbtn" aria-label="Student app" onClick={() => router.push("/home", "root", "replace")}><Ico n={homeOutline} /></button>}>
      <Card tone="soft"><div className="row"><Ico n={shieldCheckmarkOutline} /><div className="grow"><p className="strong">Welcome, {profile?.displayName?.split(" ")[0] || "admin"}</p><p className="small">Role: {role}. You see the same data as on the website admin panel.</p></div></div></Card>
      {overview.error && !o ? <ErrorBox text="Couldn't load the numbers. You may not have permission, or you're offline." onRetry={() => overview.reload()} /> : overview.loading && !o ? <SkeletonCards n={1} h={160} /> : (
        <div className="grid-2">
          <Stat label="Students" value={o ? o.users : "—"} tone="info" />
          <Stat label="Active students" value={o?.activeStudents ?? "—"} />
          <Stat label="Attempts submitted" value={o ? o.attempts : "—"} />
          <Stat label="Average score" value={o ? `${o.avgPercent}%` : "—"} tone="ok" />
        </div>
      )}
      <div className="grid-3"><Stat label="Exams" value={exams.data ? list.length : "—"} /><Stat label="Live now" value={exams.data ? live : "—"} tone="bad" /><Stat label="Drafts" value={exams.data ? drafts : "—"} /></div>
      <Head title="Quick actions" />
      <div className="tiles">
        {[
          { l: "Exams", i: documentTextOutline, p: "/admin/exams", ok: can("exams.view") }, { l: "Students", i: peopleOutline, p: "/admin/students", ok: can("students.view") },
          { l: "Notices", i: megaphoneOutline, p: "/admin/notices", ok: can("notices.manage") }, { l: "Push", i: sendOutline, p: "/admin/push", ok: can("push.manage") },
          { l: "Results", i: ribbonOutline, p: "/admin/results", ok: can("results.view") }, { l: "Activity", i: pulseOutline, p: "/admin/logs", ok: can("logs.view") },
        ].filter((t) => t.ok).map((t) => <button key={t.p} className="tile" onClick={() => go(t.p)}><Ico n={t.i} />{t.l}</button>)}
      </div>
      {can("logs.view") && (
        <>
          <Head title="Recent activity" action="See all" onAction={() => go("/admin/logs")} />
          <Card className="flush"><div className="list">{(logs.data || []).length === 0 ? <p className="muted small" style={{ padding: 16 }}>No activity yet.</p> : (logs.data || []).map((l: any) => (
            <div className="listrow" key={l.id}><div className="lead"><Ico n={timeOutline} /></div><div className="grow"><p className="strong small">{l.action}{l.label ? ` · ${l.label}` : ""}</p><p className="tiny muted">{l.name || l.email} · {formatDateTime(toMs(l.at))}</p></div></div>))}</div></Card>
        </>
      )}
      <Btn kind="ghost" block onClick={() => router.push("/home", "root", "replace")}>Back to student app</Btn>
    </Page>
  );
}
