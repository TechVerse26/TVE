import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { styleStatusBar } from "../core/native";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "tve:theme";
const Ctx = createContext<{ mode: ThemeMode; dark: boolean; setMode: (m: ThemeMode) => void }>({ mode: "system", dark: false, setMode: () => {} });
export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => (localStorage.getItem(KEY) as ThemeMode) || "system");
  const [sys, setSys] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => { const m = window.matchMedia("(prefers-color-scheme: dark)"); const f = () => setSys(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  const dark = mode === "system" ? sys : mode === "dark";
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", dark ? "dark" : "light");
    el.classList.toggle("ion-palette-dark", dark);
    void styleStatusBar(dark);
  }, [dark]);
  const setMode = (m: ThemeMode) => { localStorage.setItem(KEY, m); setModeState(m); };
  return <Ctx.Provider value={{ mode, dark, setMode }}>{children}</Ctx.Provider>;
}
