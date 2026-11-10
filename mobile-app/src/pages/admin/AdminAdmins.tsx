import { useMemo, useState } from "react";
import { useIonActionSheet } from "@ionic/react";
import { addOutline, shieldCheckmarkOutline } from "ionicons/icons";
import { Avatar, Btn, Chip, Empty, ErrorBox, Ico, Page, SearchBox, Sheet, SkeletonCards, useConfirm, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useAsync } from "../../state/hooks";
import { addAdmin, fetchAdminRoles, fetchAllUsers, invalidateUsers, logAction, removeAdmin, setAdminRole } from "../../core/admin/data";
import { normalizeRole, ROLES, ROLE_ORDER, safePhotoUrl } from "../../core/shared";
import type { Profile } from "../../core/types";

export default function AdminAdmins() {
  const { user, refreshProfile } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [present] = useIonActionSheet();
  const users = useAsync(() => fetchAllUsers(), []);
  const roles = useAsync(() => fetchAdminRoles(), []);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const admins = useMemo(() => (users.data || []).filter((u) => u.isAdmin), [users.data]);
  const candidates = useMemo(() => { const n = q.trim().toLowerCase(); return n.length < 2 ? [] : (users.data || []).filter((u) => !u.isAdmin && `${u.displayName || ""} ${u.email || ""}`.toLowerCase().includes(n)).slice(0, 8); }, [users.data, q]);
  const roleOf = (u: Profile) => (roles.data?.[u.uid] ? normalizeRole(roles.data[u.uid].role) : "super"); // no role document = Super Admin, like the website
  async function reload() { invalidateUsers(); await Promise.all([users.reload(), roles.reload()]); }

  async function grant(u: Profile, role: string) {
    if (!(await confirm({ title: `Make ${u.displayName || u.email} a ${ROLES[role].label}?`, message: ROLES[role].desc, ok: "Make admin" }))) return;
    try { await addAdmin(u, role, user!.uid); void logAction("admin.add", { type: "user", id: u.uid, label: u.displayName || u.email, detail: role }); setAdding(false); setQ(""); await reload(); notify("Admin added.", "ok"); } catch { notify("Only a Super Admin can do this.", "bad"); }
  }
  function manage(u: Profile) {
    const self = u.uid === user?.uid;
    void present({ header: u.displayName || u.email || "Admin", buttons: [
      ...ROLE_ORDER.filter((r) => r !== roleOf(u)).map((r) => ({ text: `Change role to ${ROLES[r].label}`, handler: async () => { if (self && r !== "super" && !(await confirm({ title: "Lower your own role?", message: "You may lose access to this screen.", ok: "Change" }))) return; try { await setAdminRole(u, r, user!.uid); void logAction("admin.role", { type: "user", id: u.uid, label: u.displayName || u.email, detail: r }); await reload(); if (self) await refreshProfile(); notify("Role updated.", "ok"); } catch { notify("Couldn't change the role.", "bad"); } } })),
      ...(self ? [] : [{ text: "Remove admin access", role: "destructive" as const, handler: async () => { if (await confirm({ title: "Remove admin access?", message: `${u.displayName || u.email} will become an ordinary student.`, ok: "Remove" })) { try { await removeAdmin(u.uid); void logAction("admin.remove", { type: "user", id: u.uid, label: u.displayName || u.email }); await reload(); notify("Admin removed.", "ok"); } catch { notify("Couldn't remove the admin.", "bad"); } } } }]),
      { text: "Close", role: "cancel" as const },
    ] });
  }

  return (
    <Page title="Admins" back onRefresh={reload} right={<button className="iconbtn" aria-label="Add admin" onClick={() => setAdding(true)}><Ico n={addOutline} /></button>}>
      {users.error && !users.data ? <ErrorBox onRetry={() => users.reload()} /> : users.loading && !users.data ? <SkeletonCards n={3} h={70} /> : admins.length === 0 ? <Empty icon={shieldCheckmarkOutline} title="No admins" /> : (
        <div className="card flush"><div className="list">{admins.map((u) => (
          <button className="listrow" key={u.uid} onClick={() => manage(u)}><Avatar name={String(u.displayName || u.email || "?")} photo={safePhotoUrl(u.photoURL)} size={42} /><div className="grow"><p className="strong">{u.displayName || "(no name)"}{u.uid === user?.uid ? " (you)" : ""}</p><p className="small muted">{u.email}</p></div><Chip tone="teal">{ROLES[roleOf(u)].label}</Chip></button>))}</div></div>
      )}
      <div className="card soft"><p className="small"><b>Roles:</b> {ROLE_ORDER.map((r) => `${ROLES[r].label} — ${ROLES[r].desc}`).join(" · ")}</p></div>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add an admin">
        <SearchBox value={q} onChange={setQ} placeholder="Search a student by name or email" />
        {q.trim().length < 2 ? <p className="muted small">Type at least 2 letters. Only existing student accounts can be promoted.</p> : candidates.length === 0 ? <p className="muted small">No matching student.</p> : candidates.map((u) => (
          <div className="card" key={u.uid}><div className="stack-s"><p className="strong">{u.displayName || u.email}</p><p className="small muted">{u.email}</p><div className="row-s wrap">{ROLE_ORDER.map((r) => <Btn key={r} kind="soft" className="small" onClick={() => grant(u, r)}>{ROLES[r].label}</Btn>)}</div></div></div>))}
      </Sheet>
    </Page>
  );
}
