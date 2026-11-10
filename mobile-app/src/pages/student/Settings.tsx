import { useState, type FormEvent } from "react";
import { checkmarkCircle, alertCircleOutline } from "ionicons/icons";
import { Banner, Btn, Card, Chip, Field, Head, Ico, Page, PasswordInput, Seg, useConfirm, useNotify } from "../../ui/kit";
import { PushCard } from "./Notifications";
import { useAuth } from "../../state/auth";
import { useTheme, type ThemeMode } from "../../state/theme";
import { changePassword, logout, resendVerification, authMessage } from "../../core/auth";
import { sendPasswordReset } from "../../core/auth";
import { APP_VERSION, SITE_URL } from "../../core/config";
import { clockOffsetMs, isClockSynced, isDeviceClockOff } from "../../core/clock";

export default function Settings() {
  const { user } = useAuth();
  const { mode, setMode } = useTheme();
  const confirm = useConfirm();
  const notify = useNotify();
  const hasPassword = !!user?.providerData.some((p) => p.providerId === "password");
  const [pw, setPw] = useState({ cur: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submitPw(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (pw.next.length < 6) return setErr("The new password must be at least 6 characters.");
    if (pw.next !== pw.again) return setErr("The two new passwords do not match.");
    setBusy(true); setErr("");
    try { await changePassword(user, pw.cur, pw.next); setPw({ cur: "", next: "", again: "" }); notify("Password changed.", "ok"); } catch (x: any) { setErr(x.message || authMessage("")); }
    setBusy(false);
  }
  async function setUpPassword() {
    if (!user?.email) return;
    const r = await sendPasswordReset(user.email);
    notify(r.ok ? "We emailed you a link to set a password for this account." : "Couldn't send the email. Try again later.", r.ok ? "ok" : "bad");
  }
  async function verify() { try { await resendVerification(user!); notify("Verification email sent.", "ok"); } catch (x: any) { notify(x.message, "bad"); } }
  async function out() { if (await confirm({ title: "Sign out?", ok: "Sign out" })) await logout(); }

  return (
    <Page title="Settings" back>
      <div className="cols cols-eq"><div className="stack">
        <Head title="Appearance" />
        <Seg<ThemeMode> options={[{ id: "system", label: "Automatic" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} value={mode} onChange={setMode} />
        <Head title="Notifications" />
        <PushCard />
        <Head title="Account" />
        <Card><div className="stack">
          <div className="row between"><span>{user?.email}</span>{user?.emailVerified ? <Chip tone="ok"><Ico n={checkmarkCircle} /> Verified</Chip> : <Chip tone="warn">Not verified</Chip>}</div>
          {!user?.emailVerified && <Btn kind="soft" className="small" onClick={verify}>Send verification email</Btn>}
        </div></Card>
      </div><div className="stack">
        <Head title="Password" />
        {hasPassword ? (
          <Card><form className="stack" onSubmit={submitPw} noValidate>
            {err && <Banner tone="bad">{err}</Banner>}
            <Field label="Current password"><PasswordInput value={pw.cur} onChange={(v) => setPw({ ...pw, cur: v })} autoComplete="current-password" /></Field>
            <Field label="New password" hint="At least 6 characters"><PasswordInput value={pw.next} onChange={(v) => setPw({ ...pw, next: v })} autoComplete="new-password" /></Field>
            <Field label="Repeat new password"><PasswordInput value={pw.again} onChange={(v) => setPw({ ...pw, again: v })} autoComplete="new-password" /></Field>
            <Btn type="submit" loading={busy}>Change password</Btn>
          </form></Card>
        ) : (
          <Card><div className="stack"><p>This account signs in with Google on the website. Set a password to sign in here too — it's added to the <b>same account</b>, nothing is duplicated.</p><Btn onClick={setUpPassword}>Email me a link to set a password</Btn></div></Card>
        )}
        <Head title="About this app" />
        <Card><div className="stack-s small">
          <div className="row between"><span className="muted">Version</span><b>{APP_VERSION}</b></div>
          <div className="row between"><span className="muted">Website</span><b>{SITE_URL.replace("https://", "")}</b></div>
          <div className="row between"><span className="muted">Server clock</span>{!isClockSynced() ? <Chip>Not checked</Chip> : isDeviceClockOff() ? <Chip tone="warn"><Ico n={alertCircleOutline} /> Phone clock is off by {Math.round(Math.abs(clockOffsetMs()) / 60000)} min — exams still use the correct time</Chip> : <Chip tone="ok">In sync</Chip>}</div>
        </div></Card>
        <Btn kind="dangerghost" block onClick={out}>Sign out</Btn>
      </div></div>
    </Page>
  );
}
