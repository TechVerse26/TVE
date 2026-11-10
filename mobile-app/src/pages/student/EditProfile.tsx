import { useState, type FormEvent } from "react";
import { useIonRouter } from "@ionic/react";
import { Banner, Btn, Field, Page, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { updateUserProfile } from "../../core/repo/users";

export default function EditProfile() {
  const router = useIonRouter();
  const notify = useNotify();
  const { user, profile, refreshProfile } = useAuth();
  const [f, setF] = useState({ name: profile?.displayName || user?.displayName || "", phone: String(profile?.phone || ""), institution: String(profile?.institution || "") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    const name = f.name.trim(), phone = f.phone.trim(), institution = f.institution.trim();
    if (name.length < 2) return setError("Enter your full name.");
    if (phone && !/^[+0-9][0-9 \-]{6,18}$/.test(phone)) return setError("Enter a valid phone number, or leave it empty.");
    setBusy(true); setError("");
    try { await updateUserProfile(user, { displayName: name, phone, institution }); await refreshProfile(); notify("Profile updated. The website shows the same details.", "ok"); router.goBack(); }
    catch { setError("Couldn't save your profile. Check your connection and try again."); setBusy(false); }
  }
  return (
    <Page title="Edit profile" back>
      <form className="stack" onSubmit={save} noValidate>
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Full name" htmlFor="pn"><input id="pn" className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" hint="Your email is your sign-in and can't be changed here."><input className="input" value={user?.email || ""} disabled /></Field>
        <Field label="Phone" htmlFor="pp" hint="Optional"><input id="pp" className="input" inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="School / college / institution" htmlFor="pi" hint="Optional"><input id="pi" className="input" value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></Field>
        {profile?.roll ? <Field label="Roll number" hint="Assigned automatically and unique to you."><input className="input" value={String(profile.roll)} disabled /></Field> : null}
        <Btn type="submit" block loading={busy}>Save changes</Btn>
      </form>
    </Page>
  );
}
