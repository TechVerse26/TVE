import { useState } from "react";
import { useIonRouter } from "@ionic/react";
import { megaphoneOutline, notificationsOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Empty, ErrorBox, Ico, Page, SkeletonCards, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { disablePushOnThisDevice, enablePush, isPushSupported, pushState, type PushState } from "../../core/push";
import { noticeCategory, noticePriority, visibleNotices } from "../../core/shared";
import { formatDateTime } from "../../core/format";

export function PushCard() {
  const notify = useNotify();
  const [state, setState] = useState<PushState>(pushState());
  const [busy, setBusy] = useState(false);
  if (!isPushSupported()) return null;
  async function turnOn() {
    setBusy(true);
    const s = await enablePush();
    setState(s); setBusy(false);
    if (s === "denied") notify("Notifications are blocked. Allow them for Tech Verse Exam in your phone's Settings.", "bad");
    else if (s === "unconfigured") notify("Push isn't set up in this build yet (see ANDROID-FIREBASE.md).", "bad");
    else if (s === "on") notify("Notifications are on for this phone.", "ok");
  }
  async function turnOff() { setBusy(true); await disablePushOnThisDevice(); setState("off"); setBusy(false); }
  return (
    <Card tone={state === "on" ? "ok" : "soft"}>
      <div className="row">
        <Ico n={notificationsOutline} />
        <div className="grow"><p className="strong">{state === "on" ? "Notifications are on" : "Get exam alerts"}</p><p className="small">{state === "on" ? "You'll hear about exams, results and notices on this phone." : "Never miss a live exam or a result — allow notifications."}</p></div>
        {state === "on" ? <Btn kind="ghost" className="small" loading={busy} onClick={turnOff}>Turn off</Btn> : <Btn className="small" loading={busy} onClick={turnOn}>Turn on</Btn>}
      </div>
    </Card>
  );
}

export default function Notifications() {
  const router = useIonRouter();
  const { profile } = useAuth();
  const { model, loading, error, refresh } = useStudent();
  const [open, setOpen] = useState("");
  const list = model ? visibleNotices(model.feed.notices, { now: model.now, profile, exams: Object.values(model.examsById), categories: model.feed.taxonomy.categories }) : [];
  return (
    <Page title="Notices" back onRefresh={() => refresh(true)}>
      <PushCard />
      {error && !model ? <ErrorBox onRetry={() => refresh(true)} /> : loading || !model ? <SkeletonCards n={3} /> : list.length === 0 ? <Empty icon={megaphoneOutline} title="No notices right now" text="Announcements from your teachers and the Tech Verse team will appear here." /> : (
        <div className="list-2 stack">{list.map((n) => {
          const isOpen = open === n.id;
          return (
            <Card key={n.id} onClick={() => setOpen(isOpen ? "" : n.id)}>
              <div className="stack-s">
                <div className="row-s wrap"><Chip tone={n.priority === "urgent" ? "bad" : n.priority === "important" ? "warn" : "info"}>{noticePriority(n.priority).label}</Chip><Chip>{noticeCategory(n.category).label}</Chip></div>
                <h3>{n.title}</h3>
                <p className="small muted">{formatDateTime(n.publishAt || n.createdAt)}</p>
                <p style={{ whiteSpace: "pre-wrap", ...(isOpen ? {} : { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }) }}>{n.body}</p>
                {isOpen && n.examId && model.examsById[n.examId] && <Btn kind="soft" className="small" onClick={(e) => { e.stopPropagation(); router.push(`/exams/${n.examId}`, "forward"); }}>Open exam</Btn>}
              </div>
            </Card>
          );
        })}</div>
      )}
      {list.length > 0 && <Banner tone="info">Tap a notice to read it in full.</Banner>}
    </Page>
  );
}
