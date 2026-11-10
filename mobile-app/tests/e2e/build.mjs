// Browser smoke-test bundle: the REAL app code, with Firebase swapped for the website's in-memory test doubles
// (../../../tests/e2e/mock) and Ionic / the router replaced by tiny stand-ins. Optional; needs esbuild + global react.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..", "..");
const site = resolve(app, "..");
const out = join(here, ".out");
const sh = join(out, "shims");
mkdirSync(sh, { recursive: true });
const G = process.env.GLOBAL_NODE_MODULES || execFileSync("npm", ["root", "-g"]).toString().trim();
const ESBUILD = process.env.ESBUILD || "esbuild";
const w = (n, s) => { writeFileSync(join(sh, n), s); return join(sh, n); };
const mock = (n) => join(site, "tests", "e2e", "mock", n);

// every icon name the app imports from ionicons becomes a harmless string
const icons = new Set();
(function scan(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "shared") scan(p); } else if (/\.tsx?$/.test(f)) for (const m of readFileSync(p, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"ionicons\/icons"/g)) m[1].split(",").map((x) => x.trim()).filter(Boolean).forEach((x) => icons.add(x)); } })(join(app, "src"));
const iconsShim = w("icons.js", [...icons].map((n) => `export const ${n} = "${n}";`).join("\n"));

const ionic = w("ionic.jsx", `
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
const R = createContext(null); const P = createContext({});
const match = (pat, path, exact) => { if (pat === undefined) return {}; const a = pat.split("/").filter(Boolean), b = path.split("/").filter(Boolean); if (exact && a.length !== b.length) return null; const params = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith(":")) params[a[i].slice(1)] = b[i]; else if (a[i] !== b[i]) return null; } return b.length >= a.length ? params : null; };
export function IonReactRouter({ children }) {
  const [loc, setLoc] = useState({ pathname: location.pathname, search: location.search, hash: "" });
  useEffect(() => { const f = () => setLoc({ pathname: location.pathname, search: location.search, hash: "" }); addEventListener("popstate", f); return () => removeEventListener("popstate", f); }, []);
  const api = useMemo(() => ({ loc, push(path, dir, action) { const [p, s = ""] = path.split("?"); (action === "replace" ? history.replaceState : history.pushState).call(history, {}, "", path); window.__NAV__ = (window.__NAV__ || []).concat(path); setLoc({ pathname: p, search: s ? "?" + s : "", hash: "" }); }, goBack() { history.back(); }, canGoBack() { return history.length > 1; } }), [loc]);
  return <R.Provider value={api}>{children}</R.Provider>;
}
export const useIonRouter = () => useContext(R);
export const useLocation = () => useContext(R).loc;
export const useParams = () => useContext(P);
export const Route = () => null;
export function Redirect({ to }) { const r = useContext(R); useEffect(() => { r.push(to, "root", "replace"); }, [to]); return null; }
export function IonRouterOutlet({ children }) { const { loc } = useContext(R); let hit = null, params = {}; React.Children.forEach(children, (c) => { if (hit || !c || !c.props) return; const m = match(c.props.path, loc.pathname, c.props.exact); if (m) { hit = c; params = m; } }); return <P.Provider value={params}>{hit ? hit.props.children : null}</P.Provider>; }
export const IonApp = ({ children }) => <div id="ionapp">{children}</div>;
export const IonPage = ({ children }) => <div className="ion-page">{children}</div>;
export const IonContent = ({ children }) => <div className="ion-content">{children}</div>;
export const IonRefresher = () => null; export const IonRefresherContent = () => null;
export const IonIcon = ({ icon, className }) => <i data-icon={icon} className={className} />;
export const IonModal = ({ isOpen, children }) => (isOpen ? <div role="dialog">{children}</div> : null);
export const IonToggle = ({ checked, onIonChange }) => <input type="checkbox" checked={!!checked} onChange={(e) => onIonChange({ detail: { checked: e.target.checked } })} />;
export const setupIonicReact = () => {};
export const useIonAlert = () => [(o) => { window.__ALERTS__ = (window.__ALERTS__ || []).concat(o.header || ""); if (window.__ALERT_ACCEPT__ === false) { const c = (o.buttons || []).find((b) => b.role === "cancel"); c?.handler?.(); return; } const ok = [...(o.buttons || [])].reverse().find((b) => b.role !== "cancel"); const vals = {}; (o.inputs || []).forEach((i) => (vals[i.name] = window.__ALERT_INPUT__ ?? i.value)); ok?.handler?.(vals); }];
export const useIonToast = () => [(o) => { window.__TOASTS__ = (window.__TOASTS__ || []).concat(o.message); }];
export const useIonActionSheet = () => [(o) => { window.__SHEET__ = o; }];
`);
const rr = w("rr.jsx", `export { useLocation, useParams, Route, Redirect } from "./ionic.jsx";`);
const rrIonic = w("ionrr.jsx", `export { IonReactRouter } from "./ionic.jsx";`);
const cap = (n, s) => w(n, s);
const capCore = cap("cap-core.js", `export const Capacitor = { isNativePlatform: () => false }; export const CapacitorHttp = { request: async () => ({ status: 200, headers: { date: new Date().toUTCString() }, data: "" }), post: async (o) => { (window.__POSTS__ = window.__POSTS__ || []).push(o); return { status: 200, headers: {}, data: { ok: true, job: { id: "j1" } } }; } };`);
const noop = w("cap-noop.js", `const h = { remove() {} }; const any = new Proxy({}, { get: (_, k) => (k === "then" ? undefined : async () => ({ connected: true, ...h })) });
export const App = any, Network = any, Haptics = any, Keyboard = any, PushNotifications = any, SplashScreen = any, StatusBar = any; export const ImpactStyle = {}, NotificationType = {}, Style = {};`);
const fAuth = w("f-auth.js", `export * from ${JSON.stringify(mock("firebase-auth.js"))}; import { getAuth } from ${JSON.stringify(mock("firebase-auth.js"))};
export const initializeAuth = (a) => getAuth(a); export const indexedDBLocalPersistence = 1, browserLocalPersistence = 2; export const sendEmailVerification = async () => {};`);
const fStore = w("f-store.js", `export * from ${JSON.stringify(mock("firebase-firestore.js"))}; import { getFirestore } from ${JSON.stringify(mock("firebase-firestore.js"))};
export const initializeFirestore = (a) => getFirestore(a); export const persistentLocalCache = () => ({}); export const persistentSingleTabManager = () => ({});`);
const empty = w("empty.css", "");

const args = [
  join(app, "src", "main.tsx"), "--bundle", "--format=iife", `--outfile=${join(out, "app.js")}`, "--jsx=automatic", "--loader:.js=jsx", "--log-level=warning",
  "--define:process.env.NODE_ENV=\"development\"", "--define:import.meta.env={}",
  `--alias:react=${join(G, "react")}`, `--alias:react-dom=${join(G, "react-dom")}`,
  `--alias:react-router-dom=${rr}`, `--alias:@ionic/react-router=${rrIonic}`, `--alias:@ionic/react=${ionic}`, `--alias:ionicons/icons=${iconsShim}`,
  `--alias:firebase/app=${mock("firebase-app.js")}`, `--alias:firebase/auth=${fAuth}`, `--alias:firebase/firestore=${fStore}`,
  `--alias:@capacitor/core=${capCore}`, ...["app", "haptics", "keyboard", "network", "push-notifications", "splash-screen", "status-bar"].map((n) => `--alias:@capacitor/${n}=${noop}`),
  "--loader:.png=dataurl",
];
for (const css of ["core", "normalize", "structure", "typography", "palettes/dark.class"]) args.push(`--alias:@ionic/react/css/${css}.css=${empty}`);
execFileSync(ESBUILD, args, { stdio: "inherit" });
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>`);
console.log("e2e bundle ready:", join(out, "app.js"));
