import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../core/firebase";
import { ensureUserDoc, getUserProfile } from "../core/repo/users";
import { setActor } from "../core/admin/data";
import { normalizeRole, roleCan } from "../core/shared";
import { syncServerTime } from "../core/time";
import { resumePush } from "../core/push";
import type { Profile } from "../core/types";

interface AuthState { ready: boolean; user: User | null; profile: Profile | null; isAdmin: boolean; role: string; can: (perm: string) => boolean; refreshProfile: () => Promise<void> }
const Ctx = createContext<AuthState>({ ready: false, user: null, profile: null, isAdmin: false, role: "viewer", can: () => false, refreshProfile: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState("viewer");

  const loadProfile = useCallback(async (u: User, force = true) => {
    let p = await getUserProfile(u.uid, { force }).catch(() => null);
    if (!p) { try { await ensureUserDoc(u); p = await getUserProfile(u.uid, { force: true }); } catch { /* offline: try again next time */ } }
    setProfile(p);
    let r = "viewer";
    if (p?.isAdmin) {
      // Same rule as the website: an admin with no adminRoles document is a Super Admin.
      try { const s = await getDoc(doc(db, "adminRoles", u.uid)); r = s.exists() ? normalizeRole((s.data() as any).role) : "super"; } catch { r = "viewer"; }
      setActor({ uid: u.uid, name: p.displayName || u.displayName || "", email: u.email || "", role: r });
    } else setActor(null);
    setRole(r);
  }, []);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (!u) { setProfile(null); setRole("viewer"); setActor(null); setReady(true); return; }
    await loadProfile(u);
    setReady(true);
    void syncServerTime();
    void resumePush();
  }), [loadProfile]);

  const value = useMemo<AuthState>(() => ({
    ready, user, profile, role, isAdmin: !!profile?.isAdmin,
    can: (perm) => !!profile?.isAdmin && roleCan(role, perm),
    refreshProfile: async () => { if (auth.currentUser) await loadProfile(auth.currentUser); },
  }), [ready, user, profile, role, loadProfile]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
