import { useCallback, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { IonContent, IonIcon, IonModal, IonPage, IonRefresher, IonRefresherContent, useIonAlert, useIonRouter, useIonToast } from "@ionic/react";
import { arrowBack, alertCircleOutline, closeOutline, eyeOffOutline, eyeOutline, searchOutline } from "ionicons/icons";
import { useOnline } from "../state/hooks";
import { initialsOf } from "../core/format";
import { routeFromSiteUrl } from "../core/links";

export const Ico = ({ n, className }: { n: string; className?: string }) => <IonIcon icon={n} className={className} aria-hidden="true" />;

/** A full screen: sticky title bar, pull-to-refresh, offline notice, safe-area aware content column. */
export function Page({ title, back, right, children, onRefresh }: { title: string; back?: boolean | string; right?: ReactNode; children: ReactNode; onRefresh?: () => Promise<unknown> | void }) {
  const router = useIonRouter();
  const online = useOnline();
  return (
    <IonPage>
      <IonContent fullscreen>
        {onRefresh && (
          <IonRefresher slot="fixed" onIonRefresh={async (e) => { try { await onRefresh(); } finally { e.detail.complete(); } }}>
            <IonRefresherContent />
          </IonRefresher>
        )}
        {!online && <div className="offline">You are offline — showing saved data</div>}
        <header className="topbar">
          {back && <button className="iconbtn" aria-label="Back" onClick={() => (typeof back === "string" ? router.push(back, "back") : router.goBack())}><Ico n={arrowBack} /></button>}
          <h1>{title}</h1>
          {right}
        </header>
        <main className="screen">{children}</main>
      </IonContent>
    </IonPage>
  );
}

export function Card({ children, className = "", onClick, tone }: { children: ReactNode; className?: string; onClick?: () => void; tone?: "soft" | "ok" | "warn" | "bad" }) {
  return <div className={`card ${onClick ? "tap" : ""} ${tone || ""} ${className}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>{children}</div>;
}
export const Chip = ({ tone = "", children }: { tone?: "" | "ok" | "warn" | "bad" | "info" | "live" | "teal"; children: ReactNode }) => <span className={`chip ${tone}`}>{children}</span>;

export function Btn({ kind = "primary", block, loading, icon, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "soft" | "ghost" | "danger" | "dangerghost"; block?: boolean; loading?: boolean; icon?: string }) {
  const cls = `btn ${kind === "primary" ? "" : kind} ${block ? "block" : ""} ${rest.className || ""}`;
  return <button {...rest} className={cls} disabled={rest.disabled || loading}>{loading ? <span className="spinner" /> : icon ? <Ico n={icon} /> : null}{children}</button>;
}

export const Skeleton = ({ h = 16, w = "100%" }: { h?: number; w?: string | number }) => <div className="skeleton" style={{ height: h, width: w }} />;
export function SkeletonCards({ n = 3, h = 92 }: { n?: number; h?: number }) {
  return <div className="stack">{Array.from({ length: n }, (_, i) => <div key={i} className="card"><div className="stack-s"><Skeleton h={14} w="38%" /><Skeleton h={20} /><Skeleton h={14} w="62%" /></div><div style={{ height: h - 90 > 0 ? h - 90 : 0 }} /></div>)}</div>;
}

export function Empty({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><div className="badge"><Ico n={icon} /></div><h3>{title}</h3>{text && <p className="muted" style={{ maxWidth: 320 }}>{text}</p>}{action}</div>;
}
export function ErrorBox({ text = "Couldn't load this. Check your connection and try again.", onRetry }: { text?: string; onRetry?: () => void }) {
  return <Card tone="bad"><div className="row"><Ico n={alertCircleOutline} className="strong" /><p className="grow">{text}</p>{onRetry && <Btn kind="ghost" className="small" onClick={onRetry}>Retry</Btn>}</div></Card>;
}
export const Banner = ({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) => <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;
export const Head = ({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) => <div className="head"><h2>{title}</h2>{action && <button onClick={onAction}>{action}</button>}</div>;
export const Stat = ({ label, value, tone = "" }: { label: string; value: ReactNode; tone?: "" | "ok" | "bad" | "info" }) => <div className={`stat ${tone}`}><b>{value}</b><span>{label}</span></div>;
export const Avatar = ({ name, photo, size = 44 }: { name: string; photo?: string; size?: number }) => <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>{photo ? <img src={photo} alt="" referrerPolicy="no-referrer" /> : initialsOf(name)}</div>;

export function Ring({ percent, size = 124, stroke = 12, tone = "info", children }: { percent: number; size?: number; stroke?: number; tone?: "ok" | "bad" | "warn" | "info"; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, Number(percent) || 0));
  const color = { ok: "var(--c-ok)", bad: "var(--c-bad)", warn: "var(--c-warn)", info: "var(--c-accent)" }[tone];
  return (
    <div style={{ width: size, height: size, position: "relative", flex: "none" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-surface-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return <div className="seg" role="tablist">{options.map((o) => <button key={o.id} role="tab" aria-selected={o.id === value} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}
export function Chips<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return <div className="chips">{options.map((o) => <button key={o.id} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}
export const SearchBox = ({ value, onChange, placeholder = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
  <div className="search"><Ico n={searchOutline} /><input className="input" type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} /></div>
);

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{error ? <span className="errtext">{error}</span> : hint ? <span className="hint">{hint}</span> : null}</div>;
}
export function PasswordInput({ id, value, onChange, autoComplete, placeholder, invalid }: { id?: string; value: string; onChange: (v: string) => void; autoComplete?: string; placeholder?: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pwwrap">
      <input id={id} className={`input ${invalid ? "err" : ""}`} type={show ? "text" : "password"} value={value} placeholder={placeholder} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />
      <button type="button" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow((s) => !s)}><Ico n={show ? eyeOffOutline : eyeOutline} /></button>
    </div>
  );
}

/** A bottom-sheet on phones / centred dialog on tablets. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <IonModal isOpen={open} onDidDismiss={onClose} className="sheet-modal">
      <IonContent>
        <header className="topbar"><h1>{title}</h1><button className="iconbtn plain" aria-label="Close" onClick={onClose}><Ico n={closeOutline} /></button></header>
        <div className="sheet">{children}</div>
      </IonContent>
    </IonModal>
  );
}

/** Website mark-up already turned into safe HTML by core/content.ts; links to website pages open the matching app screen. */
export function Rich({ html, className = "" }: { html: string; className?: string }) {
  const router = useIonRouter();
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") || "";
    if (a && href.startsWith("#/")) { e.preventDefault(); router.push(routeFromSiteUrl(href), "forward"); }
  };
  return <div className={`rich ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function useConfirm() {
  const [present] = useIonAlert();
  return useCallback((o: { title: string; message?: string; ok?: string; cancel?: string }) => new Promise<boolean>((resolve) => {
    void present({ header: o.title, message: o.message, backdropDismiss: false, buttons: [{ text: o.cancel || "Cancel", role: "cancel", handler: () => resolve(false) }, { text: o.ok || "OK", handler: () => resolve(true) }] });
  }), [present]);
}
export function useNotify() {
  const [present] = useIonToast();
  return useCallback((message: string, tone: "ok" | "bad" | "info" = "info") => { void present({ message, duration: 2600, position: "top", color: tone === "ok" ? "success" : tone === "bad" ? "danger" : "dark" }); }, [present]);
}
