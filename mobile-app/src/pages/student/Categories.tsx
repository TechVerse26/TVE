import { useIonRouter } from "@ionic/react";
import { folderOpenOutline } from "ionicons/icons";
import { Chip, Card, Empty, ErrorBox, Head, Page, SkeletonCards, Ico } from "../../ui/kit";
import { useStudent } from "../../state/student";
import { categoryRollup, subjectRollup } from "../../core/shared";
import { chevronForward } from "ionicons/icons";

export default function Categories() {
  const router = useIonRouter();
  const { model, loading, error, refresh } = useStudent();
  const body = () => {
    if (error && !model) return <ErrorBox onRetry={() => refresh(true)} />;
    if (loading || !model) return <SkeletonCards n={3} />;
    const exams = Object.values(model.examsById);
    const subjects = subjectRollup(model.feed.taxonomy, exams);
    const cats = categoryRollup(model.feed.taxonomy, exams).filter((c: any) => c.count > 0);
    if (!subjects.length && !cats.length) return <Empty icon={folderOpenOutline} title="Nothing to browse yet" text="Subjects and categories appear when exams are tagged with them." />;
    const rows = (list: any[], key: "subject" | "category") => <Card className="flush"><div className="list">{list.map((x) => (
      <button className="listrow" key={x.id} onClick={() => router.push(`/exams?${key}=${encodeURIComponent(x.id)}`, "forward")}>
        <div className="lead"><Ico n={folderOpenOutline} /></div><div className="grow"><p className="strong">{x.name}</p></div><Chip tone="info">{x.count} exam{x.count === 1 ? "" : "s"}</Chip><Ico n={chevronForward} className="chev" />
      </button>))}</div></Card>;
    return <>{subjects.length > 0 && <><Head title="Subjects" />{rows(subjects, "subject")}</>}{cats.length > 0 && <><Head title="Categories" />{rows(cats, "category")}</>}</>;
  };
  return <Page title="Subjects" back onRefresh={() => refresh(true)}>{body()}</Page>;
}
