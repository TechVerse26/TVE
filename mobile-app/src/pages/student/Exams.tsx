import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { documentTextOutline } from "ionicons/icons";
import { Chips, Empty, ErrorBox, Page, Seg, SearchBox, SkeletonCards } from "../../ui/kit";
import { ExamCard } from "../../ui/exam-ui";
import { useStudent } from "../../state/student";
import { filterExams, sortExams } from "../../core/shared";

const STATUS = [{ id: "all", label: "All" }, { id: "live", label: "Live now" }, { id: "upcoming", label: "Upcoming" }, { id: "available", label: "Open" }, { id: "completed", label: "Completed" }] as const;
const TYPE = [{ id: "all", label: "All" }, { id: "live", label: "Live" }, { id: "practice", label: "Practice" }] as const;

export default function Exams() {
  const { model, loading, error, refresh } = useStudent();
  const params = new URLSearchParams(useLocation().search);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof STATUS)[number]["id"]>("all");
  const [type, setType] = useState<(typeof TYPE)[number]["id"]>("all");
  const subject = params.get("subject") || "";
  const category = params.get("category") || "";

  const items = useMemo(() => {
    if (!model) return [];
    const f = { q, status: status === "all" ? "" : status, type: type === "all" ? "" : type, subject, category };
    return sortExams(filterExams(model.items, f, { categories: model.feed.taxonomy.categories, now: model.now }), "smart");
  }, [model, q, status, type, subject, category]);

  return (
    <Page title="Exams" onRefresh={() => refresh(true)}>
      <SearchBox value={q} onChange={setQ} placeholder="Search exams" />
      <Chips options={STATUS as any} value={status} onChange={setStatus} />
      <Seg options={TYPE as any} value={type} onChange={setType} />
      {error && !model ? <ErrorBox onRetry={() => refresh(true)} /> : loading || !model ? <SkeletonCards n={4} /> : items.length === 0 ? (
        <Empty icon={documentTextOutline} title="No exams match" text={q || status !== "all" || type !== "all" ? "Try a different search or clear the filters." : "Published exams will show up here."} />
      ) : <div className="list-2 stack">{items.map((i) => <ExamCard key={i.exam.id} item={i} taxonomy={model.feed.taxonomy} />)}</div>}
    </Page>
  );
}
