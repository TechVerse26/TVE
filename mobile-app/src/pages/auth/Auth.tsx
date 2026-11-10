import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { IonContent, IonPage, useIonRouter } from "@ionic/react";
import { Banner, Btn, Field, PasswordInput } from "../../ui/kit";
import { loginWithEmail, sendPasswordReset, signupWithEmail } from "../../core/auth";
import { Reset } from "../../core/shared";
import { SITE_URL } from "../../core/config";

function AuthShell({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="auth">
          <div className="auth-hero"><img src="/favicon.png" width={76} height={76} alt="" style={{ borderRadius: 22 }} /><h1>{title}</h1><p>{sub}</p></div>
          <div className="auth-card">{children}</div>
        </div>
      </IonContent>
    </IonPage>
  );
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function Login() {
  const router = useIonRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.");
    if (!password) return setError("Enter your password.");
    setBusy(true); setError("");
    try { await loginWithEmail(email, password); } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthShell title="Tech Verse Exam" sub="Sign in to take exams, see results and track your progress.">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Email" htmlFor="em"><input id="em" className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
        <Field label="Password" htmlFor="pw"><PasswordInput id="pw" value={password} onChange={setPassword} autoComplete="current-password" placeholder="Your password" /></Field>
        <button type="button" className="link" style={{ alignSelf: "flex-end" }} onClick={() => router.push("/forgot", "forward")}>Forgot password?</button>
        <Btn type="submit" block loading={busy}>Sign in</Btn>
      </form>
      <hr className="divider" />
      <p className="center muted">New here? <button className="link" onClick={() => router.push("/signup", "forward")}>Create an account</button></p>
    </AuthShell>
  );
}

export function Signup() {
  const router = useIonRouter();
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.name.trim().length < 2) return setError("Enter your full name.");
    if (!EMAIL_RE.test(f.email.trim())) return setError("Enter a valid email address.");
    if (f.password.length < 6) return setError("Password must be at least 6 characters.");
    if (f.password !== f.confirm) return setError("The two passwords do not match.");
    setBusy(true); setError("");
    try { await signupWithEmail(f.name.trim(), f.email, f.password); } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthShell title="Create your account" sub="One account works on the Tech Verse Exam website and in this app.">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Full name" htmlFor="n"><input id="n" className="input" autoComplete="name" value={f.name} onChange={(e) => set("name")(e.target.value)} /></Field>
        <Field label="Email" htmlFor="e"><input id="e" className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={f.email} onChange={(e) => set("email")(e.target.value)} /></Field>
        <Field label="Password" htmlFor="p" hint="At least 6 characters"><PasswordInput id="p" value={f.password} onChange={set("password")} autoComplete="new-password" /></Field>
        <Field label="Confirm password" htmlFor="c"><PasswordInput id="c" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" /></Field>
        <Btn type="submit" block loading={busy}>Create account</Btn>
        <p className="tiny muted center">By continuing you accept the <button type="button" className="link tiny" onClick={() => router.push("/info/terms", "forward")}>Terms</button> and <button type="button" className="link tiny" onClick={() => router.push("/info/privacy", "forward")}>Privacy Policy</button>.</p>
      </form>
      <hr className="divider" />
      <p className="center muted">Already registered? <button className="link" onClick={() => router.goBack()}>Sign in</button></p>
    </AuthShell>
  );
}

const COOL_KEY = "tve:resetCooldown";
export function Forgot() {
  const router = useIonRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const cooldown = () => { try { return JSON.parse(localStorage.getItem(COOL_KEY) || "null"); } catch { return null; } };
  useEffect(() => { const id = setInterval(() => setLeft(Reset.cooldownLeft(cooldown(), email, Date.now())), 500); return () => clearInterval(id); }, [email]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = Reset.validateResetEmail(email);
    if (!v.ok) return setError(v.error);
    setBusy(true); setError("");
    const res = await sendPasswordReset(v.email);
    const outcome = Reset.resetOutcome(res.ok ? "" : res.code);
    if (outcome.cooldownMs) localStorage.setItem(COOL_KEY, JSON.stringify(Reset.cooldownRecord(v.email, Date.now(), outcome.cooldownMs, outcome.kind === "error" ? "flood" : "sent")));
    if (outcome.kind === "sent") setSent(true); else setError(outcome.message);
    setBusy(false);
  }
  const v = Reset.validateResetEmail(email);
  return (
    <AuthShell title="Reset password" sub="We will email you a link to choose a new password.">
      {sent ? (
        <div className="stack">
          <Banner tone="ok">যদি এই ইমেইলে অ্যাকাউন্ট থাকে, রিসেট লিংক পাঠানো হয়েছে। Inbox এবং Spam ফোল্ডার দেখুন।</Banner>
          <p className="muted small">Joined with Google before? This same link lets you set a password for the <b>same account</b> — your exams, results and profile stay exactly as they are.</p>
          <Btn kind="ghost" block onClick={() => router.goBack()}>Back to sign in</Btn>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <Banner tone="bad">{error}</Banner>}
          <Field label="Your email" htmlFor="fe"><input id="fe" className="input" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
          {v.ok && v.suggestion && <button type="button" className="link small" style={{ textAlign: "left" }} onClick={() => setEmail(v.suggestion)}>Did you mean {v.suggestion}?</button>}
          <Btn type="submit" block loading={busy} disabled={left > 0}>{left > 0 ? `Send again in ${Reset.waitLabel(left)}` : "Send reset link"}</Btn>
          <p className="tiny muted center">Links open at {SITE_URL.replace("https://", "")} and return you to sign in.</p>
          <Btn kind="ghost" block type="button" onClick={() => router.goBack()}>Back to sign in</Btn>
        </form>
      )}
    </AuthShell>
  );
}
