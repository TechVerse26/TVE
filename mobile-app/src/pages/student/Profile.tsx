import { useState, type ReactNode } from "react";
import { useIonRouter } from "@ionic/react";
import { bookOutline, chevronForward, documentLockOutline, documentTextOutline, folderOpenOutline, helpCircleOutline, informationCircleOutline, logOutOutline, megaphoneOutline, peopleOutline, personOutline, schoolOutline, settingsOutline, sparklesOutline, speedometerOutline, trophyOutline } from "ionicons/icons";
import { Avatar, Btn, Card, Chip, Ico, Page, Stat, useConfirm, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { logout } from "../../core/auth";
import { claimNextRoll, updateUserProfile } from "../../core/repo/users";
import { performanceFromStats, safePhotoUrl } from "../../core/shared";

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="stack-s">{title && <p className="small muted strong" style={{ padding: "0 4px" }}>{title}</p>}<Card className="flush"><div className="list">{children}</div></Card></div>;
}
const Item = ({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) => (
  <button className="listrow" onClick={onClick}><div className="lead" style={danger ? { background: "var(--c-bad-soft)", color: "var(--c-bad)" } : undefined}><Ico n={icon} /></div><span className="grow strong" style={danger ? { color: "var(--c-bad)" } : undefined}>{label}</span>{!danger && <Ico n={chevronForward} className="chev" />}</button>
);

export default function Profile() {
  const router = useIonRouter();
  const confirm = useConfirm();
  const notify = useNotify();
  const { user, profile, isAdmin, role, refreshProfile } = useAuth();
  const { model } = useStudent();
  const [busy, setBusy] = useState(false);
  const go = (p: string) => router.push(p, "forward");
  const name = profile?.displayName || user?.displayName || "Student";
  const perf = model ? performanceFromStats(model.stats, { examsById: model.examsById, defaultPass: model.passPercent }) : null;

  async function getRoll() {
    if (!user || !profile) return;
    setBusy(true);
    try { const roll = await claimNextRoll(); await updateUserProfile(user, { displayName: name, phone: String(profile.phone || ""), institution: String(profile.institution || ""), roll }); await refreshProfile(); notify(`Your roll number is ${roll}.`, "ok"); }
    catch { notify("Couldn't get a roll number right now. Try again.", "bad"); }
    setBusy(false);
  }
  async function signOut() { if (await confirm({ title: "Sign out?", message: "You can sign back in any time with your email and password.", ok: "Sign out" })) await logout(); }

  return (
    <Page title="Profile">
      <Card><div className="stack">
        <div className="row"><Avatar name={name} photo={safePhotoUrl(profile?.photoURL || user?.photoURL)} size={64} />
          <div className="grow"><h2>{name}</h2><p className="muted small">{user?.email}</p><div className="row-s wrap" style={{ marginTop: 6 }}>{profile?.roll ? <Chip tone="info">Roll {String(profile.roll)}</Chip> : null}{isAdmin && <Chip tone="teal">Admin · {role}</Chip>}{profile?.disabled && <Chip tone="bad">Deactivated</Chip>}</div></div>
        </div>
        {(profile?.institution || profile?.phone) && <p className="small muted">{[profile?.institution, profile?.phone].filter(Boolean).join(" · ")}</p>}
        <Btn kind="ghost" block onClick={() => go("/profile/edit")}><Ico n={personOutline} /> Edit profile</Btn>
      </div></Card>
      {perf && <div className="grid-3"><Stat label="Exams" value={perf.taken} /><Stat label="Average" value={perf.taken ? `${perf.avg}%` : "—"} tone="info" /><Stat label="Best" value={perf.taken ? `${perf.best}%` : "—"} tone="ok" /></div>}
      {profile && !profile.roll && !isAdmin && <Card tone="soft"><div className="row"><div className="grow"><p className="strong">Get your roll number</p><p className="small">Your roll number identifies you on leaderboards and result lists.</p></div><Btn className="small" loading={busy} onClick={getRoll}>Get it</Btn></div></Card>}
      {isAdmin && <Group><Item icon={speedometerOutline} label="Open Admin Panel" onClick={() => go("/admin")} /></Group>}
      <div className="cols cols-eq"><div className="stack">
        <Group title="My learning"><Item icon={trophyOutline} label="Leaderboard" onClick={() => go("/leaderboard")} /><Item icon={speedometerOutline} label="My progress" onClick={() => go("/performance")} /><Item icon={folderOpenOutline} label="Subjects" onClick={() => go("/categories")} /><Item icon={schoolOutline} label="Academic programs" onClick={() => go("/academic")} /><Item icon={megaphoneOutline} label="Notices" onClick={() => go("/notifications")} /></Group>
        <Group title="Account"><Item icon={settingsOutline} label="Settings" onClick={() => go("/settings")} /><Item icon={logOutOutline} label="Sign out" danger onClick={signOut} /></Group>
      </div><div className="stack">
        <Group title="Help and information"><Item icon={helpCircleOutline} label="Help Center" onClick={() => go("/info/help")} /><Item icon={bookOutline} label="FAQ" onClick={() => go("/info/faq")} /><Item icon={informationCircleOutline} label="About" onClick={() => go("/info/about")} /><Item icon={sparklesOutline} label="What's new" onClick={() => go("/info/whats-new")} /><Item icon={documentLockOutline} label="Privacy Policy" onClick={() => go("/info/privacy")} /><Item icon={documentTextOutline} label="Terms & Conditions" onClick={() => go("/info/terms")} /><Item icon={peopleOutline} label="Credits" onClick={() => go("/info/credits")} /></Group>
      </div></div>
    </Page>
  );
}
