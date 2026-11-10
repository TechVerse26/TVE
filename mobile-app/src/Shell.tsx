import { useEffect, type ReactNode } from "react";
import { useIonRouter } from "@ionic/react";
import { useLocation } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { Ico, useNotify } from "./ui/kit";
import { useAuth } from "./state/auth";
import { useIsTablet } from "./state/hooks";
import { ADMIN_TABS, STUDENT_TABS, isImmersivePath, isPrimaryPath } from "./nav";
import { onForegroundPush, onNotificationOpen } from "./core/push";
import { routeFromSiteUrl } from "./core/links";

/** Phones: bottom bar on the main screens. Tablets: a navigation rail beside every screen (except the exam and sign-in). */
export default function Shell({ children }: { children: ReactNode }) {
  const { user, isAdmin } = useAuth();
  const { pathname } = useLocation();
  const tablet = useIsTablet();
  const router = useIonRouter();
  const notify = useNotify();
  const inAdmin = pathname.startsWith("/admin");
  const tabs = inAdmin ? ADMIN_TABS : STUDENT_TABS;
  const immersive = isImmersivePath(pathname);
  const showBar = !!user && !immersive && !tablet && isPrimaryPath(pathname);
  const showRail = !!user && !immersive && tablet;
  const go = (path: string) => { if (path !== pathname) router.push(path, "root", "replace"); };
  const isOn = (path: string) => (path === "/admin" ? pathname === "/admin" : pathname === path || pathname.startsWith(path + "/"));

  // Android back button: leave the app only from a main screen; everything else goes back one step.
  useEffect(() => {
    const listener = (ev: Event) => (ev as CustomEvent).detail.register(-1, () => { if (!router.canGoBack()) void CapApp.exitApp(); });
    document.addEventListener("ionBackButton", listener);
    return () => document.removeEventListener("ionBackButton", listener);
  }, [router]);

  // Notification taps and tvexam:// links open the matching screen.
  useEffect(() => {
    onNotificationOpen((route) => router.push(route, "forward"));
    onForegroundPush((n) => notify(n.body ? `${n.title} — ${n.body}` : n.title, "info"));
    let handle: { remove: () => void } | null = null;
    CapApp.addListener("appUrlOpen", (e) => { try { const u = new URL(e.url); router.push(routeFromSiteUrl(`#/${u.host}${u.pathname}${u.search}`), "forward"); } catch { /* ignore malformed links */ } }).then((h) => { handle = h; }).catch(() => {});
    return () => handle?.remove();
  }, [router, notify]);

  const items = (
    <>
      {tabs.map((t) => (
        <button key={t.id} className={isOn(t.path) ? "on" : ""} onClick={() => go(t.path)} aria-label={t.label} aria-current={isOn(t.path) ? "page" : undefined}>
          <Ico n={t.icon} />
          <span>{t.label}</span>
        </button>
      ))}
    </>
  );
  return (
    <div className={`shell ${tablet ? "tablet" : ""}`}>
      {showRail && (
        <nav className="rail" aria-label="Main">
          <img className="brand" src="/favicon.png" alt="Tech Verse Exam" />
          {items}
          {isAdmin && <button style={{ marginTop: "auto" }} onClick={() => go(inAdmin ? "/home" : "/admin")}><Ico n={inAdmin ? STUDENT_TABS[0].icon : ADMIN_TABS[0].icon} /><span>{inAdmin ? "Student" : "Admin"}</span></button>}
        </nav>
      )}
      <div className="shell-main">{children}</div>
      {showBar && <nav className="bottombar" aria-label="Main">{items}</nav>}
    </div>
  );
}
