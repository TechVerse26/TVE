import { useIonRouter } from "@ionic/react";
import { chevronForward, homeOutline, informationCircleOutline, pulseOutline, ribbonOutline, sendOutline, shieldCheckmarkOutline, settingsOutline } from "ionicons/icons";
import { Card, Ico, Page } from "../../ui/kit";
import { useAuth } from "../../state/auth";

export default function AdminMore() {
  const router = useIonRouter();
  const { can, role } = useAuth();
  const items = [
    { l: "Results by exam", i: ribbonOutline, p: "/admin/results", ok: can("results.view") },
    { l: "Push notifications", i: sendOutline, p: "/admin/push", ok: can("push.manage") },
    { l: "Admins and roles", i: shieldCheckmarkOutline, p: "/admin/admins", ok: can("admins.manage") },
    { l: "Activity log", i: pulseOutline, p: "/admin/logs", ok: can("logs.view") },
    { l: "App settings", i: settingsOutline, p: "/settings", ok: true },
    { l: "Back to the student app", i: homeOutline, p: "/home", ok: true },
  ].filter((x) => x.ok);
  return (
    <Page title="More">
      <Card className="flush"><div className="list">{items.map((x) => <button className="listrow" key={x.p} onClick={() => router.push(x.p, x.p === "/home" ? "root" : "forward", x.p === "/home" ? "replace" : undefined)}><div className="lead"><Ico n={x.i} /></div><span className="grow strong">{x.l}</span><Ico n={chevronForward} className="chev" /></button>)}</div></Card>
      <Card tone="soft"><div className="row" style={{ alignItems: "flex-start" }}><Ico n={informationCircleOutline} /><div className="stack-s"><p className="strong">Role: {role}</p><p className="small">Everything here reads and writes the same Firebase data as the website admin panel, under the same permissions. These website-admin tools are not in the app yet: bulk question import, email center, homepage content editor, academic program management, subject/category editor, leaderboard publishing, analytics exports and site settings.</p></div></div></Card>
    </Page>
  );
}
