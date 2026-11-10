import { useEffect, useRef, useState } from "react";
import { Network } from "@capacitor/network";
import { serverNow } from "../core/clock";

const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(fn: () => void) {
  subs.add(fn);
  if (!timer) timer = setInterval(() => subs.forEach((f) => f()), 1000);
  return () => { subs.delete(fn); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
}
/** Re-renders the component every second (one shared timer) and returns the server-corrected time. */
export function useTick(): number { const [, set] = useState(0); useEffect(() => subscribe(() => set((x) => x + 1)), []); return serverNow(); }

/** Server-corrected "now" that refreshes every `ms` and whenever the app comes back to the foreground. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), ms);
    const vis = () => { if (document.visibilityState === "visible") setNow(serverNow()); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", vis); };
  }, [ms]);
  return now;
}

export function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    let handle: { remove: () => void } | null = null;
    let dead = false;
    Network.getStatus().then((s) => { if (!dead) setOn(s.connected); }).catch(() => {});
    Network.addListener("networkStatusChange", (s) => setOn(s.connected)).then((h) => { if (dead) h.remove(); else handle = h; }).catch(() => {});
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { dead = true; handle?.remove(); window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return on;
}

export function useIsTablet(): boolean {
  const q = "(min-width: 768px)";
  const [t, setT] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setT(m.matches); m.addEventListener("change", f); f(); return () => m.removeEventListener("change", f); }, []);
  return t;
}

/** While `active`, the Android back button runs `handler` instead of leaving the screen (Ionic's priority-based back-button chain). */
export function useBackGuard(active: boolean, handler: () => void, priority = 100) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const listener = (ev: Event) => (ev as CustomEvent).detail.register(priority, () => { ref.current(); });
    document.addEventListener("ionBackButton", listener);
    return () => document.removeEventListener("ionBackButton", listener);
  }, [active, priority]);
}

/** Runs an async loader on mount / when deps change; exposes loading, error and a reload function. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: boolean }>({ data: null, loading: true, error: false });
  const seq = useRef(0);
  const run = async (silent = false) => {
    const my = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: false }));
    try { const data = await load(); if (my === seq.current) setState({ data, loading: false, error: false }); }
    catch { if (my === seq.current) setState((s) => ({ ...s, loading: false, error: true })); }
  };
  useEffect(() => { void run(); return () => { seq.current++; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);
  return { ...state, reload: () => run(true) };
}
