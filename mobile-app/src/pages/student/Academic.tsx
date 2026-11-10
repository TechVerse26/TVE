import { useState } from "react";
import { chevronForward, lockClosedOutline, schoolOutline } from "ionicons/icons";
import { Card, Chip, Empty, ErrorBox, Head, Ico, Page, SkeletonCards } from "../../ui/kit";
import { ExamCard } from "../../ui/exam-ui";
import { useAuth } from "../../state/auth";
import { useStudent } from "../../state/student";
import { useAsync } from "../../state/hooks";
import { loadMyEntitlements, loadSectionTree, loadSections } from "../../core/repo/academic";
import { Academic as AC } from "../../core/shared";

export default function Academic() {
  const { user, isAdmin } = useAuth();
  const { model } = useStudent();
  const [sel, setSel] = useState("");
  const [openSubject, setOpenSubject] = useState("");
  const sections = useAsync(() => loadSections(), []);
  const tree = useAsync(() => (sel ? loadSectionTree(sel) : Promise.resolve(null)), [sel]);
  const ent = useAsync(() => loadMyEntitlements(user!.uid), [user?.uid]);

  if (!sel) {
    return (
      <Page title="Academic" back onRefresh={() => sections.reload()}>
        {sections.error && !sections.data ? <ErrorBox onRetry={() => sections.reload()} /> : sections.loading && !sections.data ? <SkeletonCards n={3} /> : !sections.data?.length ? <Empty icon={schoolOutline} title="No programs yet" text="Academic programs appear here when they are published." /> : (
          <div className="list-2 stack">{sections.data.map((s) => (
            <Card key={s.id} onClick={() => setSel(s.id)}><div className="row"><div className="listrow lead" style={{ padding: 0, width: 46, height: 46 }}><Ico n={schoolOutline} /></div><div className="grow"><h3>{s.name}</h3>{s.description && <p className="small muted">{s.description}</p>}</div>{s.accessMode === "paid" && <Chip tone="warn"><Ico n={lockClosedOutline} /> Premium</Chip>}<Ico n={chevronForward} className="chev" /></div></Card>
          ))}</div>
        )}
      </Page>
    );
  }
  const t = tree.data;
  return (
    <Page title={t?.section.name || "Program"} back={false} right={<button className="link" onClick={() => { setSel(""); setOpenSubject(""); }}>All programs</button>}>
      {tree.loading && !t ? <SkeletonCards n={2} /> : !t ? <Empty icon={schoolOutline} title="Program unavailable" text="This program isn't open right now." /> : t.levels.map((lv) => {
        const subs = t.subjects.filter((s) => s.levelId === lv.id);
        return (
          <div className="stack" key={lv.id}>
            <Head title={lv.name} />
            {subs.length === 0 ? <p className="muted small">No subjects yet.</p> : <Card className="flush"><div className="list">{subs.map((s) => {
              const verdict = AC.accessVerdict([s, lv, t.section], ent.data || new Set<string>());
              const allowed = isAdmin || verdict.allowed;
              const exams = (model?.items || []).filter((i) => i.exam.academicSubjectId === s.id);
              const isOpen = openSubject === s.id;
              return (
                <div key={s.id}>
                  <button className="listrow" onClick={() => setOpenSubject(isOpen ? "" : s.id)}>
                    <div className="grow"><p className="strong">{s.name}</p><p className="small muted">{exams.length} exam{exams.length === 1 ? "" : "s"}</p></div>
                    {allowed ? <Chip tone="ok">Open</Chip> : <Chip tone="warn"><Ico n={lockClosedOutline} /> Premium</Chip>}
                  </button>
                  {isOpen && <div className="stack" style={{ padding: "0 12px 12px" }}>{!allowed ? <p className="small muted">This subject is part of a paid program. Contact support with your registered email to get access.</p> : exams.length === 0 ? <p className="small muted">No exams in this subject yet.</p> : exams.map((i) => <ExamCard key={i.exam.id} item={i} taxonomy={model?.feed.taxonomy} />)}</div>}
                </div>
              );
            })}</div></Card>}
          </div>
        );
      })}
    </Page>
  );
}
