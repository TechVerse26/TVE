import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useNow } from "./hooks";
import { getExamCatalog } from "../core/repo/exams";
import { getHomeFeed } from "../core/repo/home";
import { fetchUserStats } from "../core/repo/results";
import { decorateAll, studentExams } from "../core/shared";
import type { Catalog, Exam, ExamItem, HomeFeed, UserStats } from "../core/types";

export interface Model {
  items: ExamItem[]; examsById: Record<string, Exam>; maintenance: boolean; siteMessage: string; passPercent: number;
  feed: HomeFeed; stats: UserStats | null; catalog: Catalog; now: number;
}
interface StudentState { loading: boolean; error: boolean; model: Model | null; refresh: (force?: boolean) => Promise<void> }
const Ctx = createContext<StudentState>({ loading: true, error: false, model: null, refresh: async () => {} });
export const useStudent = () => useContext(Ctx);

export function StudentProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const [raw, setRaw] = useState<{ catalog: Catalog; feed: HomeFeed; stats: UserStats | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const now = useNow(15_000);

  const refresh = useCallback(async (force = false) => {
    if (!user) return;
    if (!raw) setLoading(true);
    setError(false);
    try {
      const [catalog, feed, stats] = await Promise.all([getExamCatalog({ force }), getHomeFeed({ force }), fetchUserStats(user.uid, { force })]);
      setRaw({ catalog, feed, stats });
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [user, raw]);

  useEffect(() => { if (user) void refresh(); else { setRaw(null); setLoading(true); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.uid]);

  const model = useMemo<Model | null>(() => {
    if (!raw) return null;
    const exams = studentExams(raw.catalog.exams, profile);
    const items = decorateAll(exams, now, { stats: raw.stats, maintenance: raw.catalog.site.maintenance, disabled: !!profile?.disabled });
    return { items, examsById: Object.fromEntries(exams.map((e) => [e.id, e])), maintenance: raw.catalog.site.maintenance, siteMessage: raw.catalog.site.message, passPercent: raw.feed.passPercent, feed: raw.feed, stats: raw.stats, catalog: raw.catalog, now };
  }, [raw, profile, now]);

  return <Ctx.Provider value={{ loading, error, model, refresh }}>{children}</Ctx.Provider>;
}
