import { useMemo, useState } from "react";
import { useIonAlert } from "@ionic/react";
import { doc, getDoc } from "firebase/firestore";
import { peopleOutline } from "ionicons/icons";
import { Avatar, Btn, Chip, Chips, Empty, ErrorBox, Page, SearchBox, Sheet, SkeletonCards, useConfirm, useNotify } from "../../ui/kit";
import { useAuth } from "../../state/auth";
import { useAsync } from "../../state/hooks";
import { fetchAllUsers, logAction, setUserDisabled, setUserRoll } from "../../core/admin/data";
import { db } from "../../core/firebase";
import { formatDate } from "../../core/format";
import { safePhotoUrl, toMs } from "../../core/shared";
import type { Profile } from "../../core/types";

const FILTERS = [{ id: "all", label: "All" }, { id: "students", label: "Students" }, { id: "admins", label: "Admins" }, { id: "off", label: "Deactivated" }, { id: "noroll", label: "No roll" }] as const;
const PAGE = 40;

export default function AdminStudents() {
  const { user, can } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const [ask] = useIonAlert();
  const users = useAsync(() => fetchAllUsers(), []);
  const [q, setQ] = useState("");
  const [f, setF] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [shown, setShown] = useState(PAGE);
  const [sel, setSel] = useState<Profile | null>(null);
  const [stat, setStat] = useState<{ taken: number } | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users.data || []).filter((u) => {
      if (f === "students" && u.isAdmin) return false;
      if (f === "admins" && !u.isAdmin) return false;
      if (f === "off" && !u.disabled) return false;
      if (f === "noroll" && (u.roll || u.isAdmin)) return false;
      return !needle || `${u.displayName || ""} ${u.email || ""} ${u.roll || ""} ${u.phone || ""}`.toLowerCase().includes(needle);
    }).sort((a, b) => String(a.displayName || a.email).localeCompare(String(b.displayName || b.email)));
  }, [users.data, q, f]);

  async function open(u: Profile) {
    setSel(u); setStat(null);
    try { const s = await getDoc(doc(db, "userStats", u.uid)); setStat({ taken: s.exists() ? Number((s.data() as any).examsTaken) || 0 : 0 }); } catch { setStat(null); }
  }
  async function toggle(u: Profile) {
    if (u.uid === user?.uid) return notify("You can't deactivate your own account.", "bad");
    const off = !u.disabled;
    if (!(await confirm({ title: off ? "Deactivate this student?" : "Reactivate this student?", message: off ? "They can still sign in, but won't be able to start exams." : "They will be able to take exams again.", ok: off ? "Deactivate" : "Reactivate" }))) return;
    try { await setUserDisabled(u.uid, off, user!.uid); void logAction(off ? "student.deactivate" : "student.activate", { type: "user", id: u.uid, label: u.displayName || u.email }); setSel({ ...u, disabled: off }); await users.reload(); notify(off ? "Student deactivated." : "Student reactivated.", "ok"); }
    catch { notify("You don't have permission, or you're offline.", "bad"); }
  }
  function editRoll(u: Profile) {
    void ask({ header: "Roll number", message: "Use a 4-digit number such as 0042.", inputs: [{ name: "roll", type: "text", value: String(u.roll || ""), attributes: { inputmode: "numeric", maxlength: 12 } }], buttons: [{ text: "Cancel", role: "cancel" }, { text: "Save", handler: async (v: { roll: string }) => {
      const roll = String(v.roll || "").trim();
      if (!/^[0-9]{1,12}$/.test(roll)) { notify("A roll number contains digits only.", "bad"); return false; }
      try { await setUserRoll(u.uid, roll); void logAction("student.roll", { type: "user", id: u.uid, label: u.displayName || u.email, detail: roll }); setSel({ ...u, roll }); await users.reload(); notify("Roll number saved.", "ok"); } catch { notify("Couldn't save the roll number.", "bad"); }
      return true;
    } }] });
  }

  return (
    <Page title="Students" onRefresh={async () => { await fetchAllUsers({ force: true }); await users.reload(); }}>
      <SearchBox value={q} onChange={(v) => { setQ(v); setShown(PAGE); }} placeholder="Search name, email, roll or phone" />
      <Chips options={FILTERS as any} value={f} onChange={(v) => { setF(v); setShown(PAGE); }} />
      {users.error && !users.data ? <ErrorBox text="Couldn't load students. You may not have permission, or you're offline." onRetry={() => users.reload()} /> : users.loading && !users.data ? <SkeletonCards n={5} h={70} /> : rows.length === 0 ? <Empty icon={peopleOutline} title="No students found" text="Try a different search or filter." /> : (
        <>
          <p className="small muted">{rows.length} of {users.data?.length} people</p>
          <div className="card flush"><div className="list">{rows.slice(0, shown).map((u) => (
            <button className="listrow" key={u.uid} onClick={() => open(u)}>
              <Avatar name={String(u.displayName || u.email || "?")} photo={safePhotoUrl(u.photoURL)} size={42} />
              <div className="grow"><p className="strong">{u.displayName || "(no name)"}</p><p className="small muted">{u.email}{u.roll ? ` · ${u.roll}` : ""}</p></div>
              {u.isAdmin && <Chip tone="teal">Admin</Chip>}{u.disabled && <Chip tone="bad">Off</Chip>}
            </button>))}</div></div>
          {rows.length > shown && <Btn kind="ghost" block onClick={() => setShown((s) => s + PAGE)}>Show more</Btn>}
        </>
      )}
      <Sheet open={!!sel} onClose={() => setSel(null)} title="Student">
        {sel && (
          <div className="stack">
            <div className="row"><Avatar name={String(sel.displayName || sel.email || "?")} photo={safePhotoUrl(sel.photoURL)} size={60} /><div className="grow"><h2>{sel.displayName || "(no name)"}</h2><p className="muted small">{sel.email}</p></div></div>
            <div className="row-s wrap">{sel.isAdmin && <Chip tone="teal">Admin</Chip>}{sel.disabled && <Chip tone="bad">Deactivated</Chip>}{sel.roll ? <Chip tone="info">Roll {String(sel.roll)}</Chip> : <Chip>No roll yet</Chip>}</div>
            <div className="card"><div className="stack-s small">
              <div className="row between"><span className="muted">Phone</span><b>{String(sel.phone || "—")}</b></div>
              <div className="row between"><span className="muted">Institution</span><b>{String(sel.institution || "—")}</b></div>
              <div className="row between"><span className="muted">Joined</span><b>{formatDate(toMs(sel.createdAt))}</b></div>
              <div className="row between"><span className="muted">Exams taken</span><b>{stat ? stat.taken : "…"}</b></div>
            </div></div>
            {can("students.manage") ? <div className="stack-s"><Btn kind="soft" block onClick={() => editRoll(sel)}>{sel.roll ? "Change roll number" : "Set roll number"}</Btn><Btn kind={sel.disabled ? "primary" : "dangerghost"} block onClick={() => toggle(sel)}>{sel.disabled ? "Reactivate student" : "Deactivate student"}</Btn></div> : <p className="small muted">Your role can view students but not change them.</p>}
          </div>
        )}
      </Sheet>
    </Page>
  );
}
