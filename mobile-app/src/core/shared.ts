// A typed doorway to the website's own pure-logic modules (copied byte-for-byte into ../shared/web by
// scripts/sync-shared.mjs). Everything here is the WEBSITE's rule; the app only calls it.
import * as SC from "../shared/web/schedule-core.js";
import * as HC from "../shared/web/home-core.js";
import * as SS from "../shared/web/exam-session-core.js";
import * as EA from "../shared/web/exam-analytics.js";
import * as AC from "../shared/web/academic-core.js";
import * as AR from "../shared/web/auth-reset-core.js";
import * as PM from "../shared/web/permissions.js";
import type { Exam, ExamItem, Status, StatsEntry, UserStats, Notice, Question } from "./types";

type Fn<A extends unknown[], R> = (...a: A) => R;
const f = <T>(x: unknown) => x as T;

// ---- schedule-core.js
export const STATUS = SC.STATUS as Record<Status["key"], { key: Status["key"]; label: string; bn: string; tone: string }>;
export const DIFFICULTY = SC.DIFFICULTY as Record<string, { label: string; bn: string }>;
export const computeStatus = f<Fn<[Exam, number, { hasResult?: boolean; attemptsUsed?: number; maintenance?: boolean; disabled?: boolean }?], Status>>(SC.computeStatus);
export const decorateExam = f<Fn<[Exam, number, { stats?: UserStats | null; maintenance?: boolean; disabled?: boolean }?], ExamItem>>(SC.decorateExam);
export const examWindow = f<Fn<[Exam], { startsAt: number | null; endsAt: number | null; practice: boolean }>>(SC.examWindow);
export const toMs = f<Fn<[unknown], number | null>>(SC.toMs);
export const toBnDigits = f<Fn<[string | number], string>>(SC.toBnDigits);
export const countdownShort = f<Fn<[number], string>>(SC.countdownShort);
export const countdownParts = f<Fn<[number], { value: string; unit: string }[]>>(SC.countdownParts);
export const splitDuration = f<Fn<[number], { totalSeconds: number; days: number; hours: number; minutes: number; seconds: number }>>(SC.splitDuration);
export const humanizeBn = f<Fn<[number], string>>(SC.humanizeBn);
export const passPercentFor = f<Fn<[Exam | undefined, number?], number>>(SC.passPercentFor);
export const passMarksFor = f<Fn<[Exam, number?], number>>(SC.passMarksFor);
export const getExamQuestionCount = f<Fn<[Exam], number>>(SC.getExamQuestionCount);
export const isExamRandomPool = f<Fn<[Exam], boolean>>(SC.isExamRandomPool);
export const startOfDay = f<Fn<[number], number>>(SC.startOfDay);
export const isDraftExam = f<Fn<[Exam], boolean>>(SC.isDraftExam);

// ---- home-core.js
export const studentExams = f<Fn<[Exam[], unknown], Exam[]>>(HC.studentExams);
export const decorateAll = f<Fn<[Exam[], number, { stats?: UserStats | null; maintenance?: boolean; disabled?: boolean }?], ExamItem[]>>(HC.decorateAll);
export const statusGroup = f<Fn<[Status["key"]], "live" | "upcoming" | "available" | "completed" | "closed">>(HC.statusGroup);
export const filterExams = f<Fn<[ExamItem[], { q?: string; type?: string; status?: string; subject?: string; category?: string; difficulty?: string; date?: string; _names?: (e: Exam) => string }?, { categories?: unknown[]; now?: number }?], ExamItem[]>>(HC.filterExams);
export const sortExams = f<Fn<[ExamItem[], string?], ExamItem[]>>(HC.sortExams);
export const scheduleItems = f<Fn<[ExamItem[], number, { includePast?: boolean }?], ExamItem[]>>(HC.scheduleItems);
export const groupByDay = f<Fn<[ExamItem[], number], { key: string; dayStart: number; diff: number; rows: ExamItem[] }[]>>(HC.groupByDay);
export const nextExamItem = f<Fn<[ExamItem[]], ExamItem | null>>(HC.nextExamItem);
export const liveItems = f<Fn<[ExamItem[]], ExamItem[]>>(HC.liveItems);
export const heroNumbers = f<Fn<[ExamItem[], number], { live: number; upcoming: number; available: number; today: number }>>(HC.heroNumbers);
export const performanceFromStats = f<Fn<[UserStats | null, { examsById?: Record<string, Exam>; defaultPass?: number }?], { rows: (StatsEntry & { examId: string })[]; taken: number; liveTaken: number; attempts: number; basis: string; avg: number; best: number; passRate: number | null; ownLiveAvg: number | null }>>(HC.performanceFromStats);
export const recentResultRows = f<Fn<[UserStats | null, { examsById?: Record<string, Exam>; defaultPass?: number; limit?: number }?], { examId: string; title: string; score: number; total: number; percent: number; at: number; type: "live" | "practice"; attempts: number; pass: boolean }[]>>(HC.recentResultRows);
export const rankOf = f<Fn<[number[], number | null], { rank: number; total: number } | null>>(HC.rankOf);
export const topPerformers = f<Fn<[unknown, string?, number?], { rank: number; name: string; percent: number; exams: number; roll: string; photo: string }[]>>(HC.topPerformers);
export const examLeadersFrom = f<Fn<[unknown, string?, number?], { id: string; title: string; count: number; top: { rank: number; name: string; percent: number; score: number; total: number; roll: string; photo: string }[] }[]>>(HC.examLeadersFrom);
export const visibleNotices = f<Fn<[Notice[], { now: number; profile: unknown; exams: Exam[]; categories: unknown[] }], Notice[]>>(HC.visibleNotices);
export const noticeCategory = f<Fn<[string], { id: string; label: string }>>(HC.noticeCategory);
export const noticePriority = f<Fn<[string], { label: string; bn: string; rank: number }>>(HC.noticePriority);
export const noticeState = f<Fn<[unknown, number], "draft" | "scheduled" | "live" | "expired">>(HC.noticeState);
export const NOTICE_CATEGORIES = HC.NOTICE_CATEGORIES as unknown as { id: string; label: string }[];
export const NOTICE_PRIORITY = HC.NOTICE_PRIORITY as unknown as Record<string, { label: string; bn: string; rank: number }>;
export const normalizeContent = f<Fn<[unknown], any>>(HC.normalizeContent);
export const normalizeTaxonomy = f<Fn<[unknown], { subjects: { id: string; name: string }[]; categories: { id: string; name: string; parentId?: string }[] }>>(HC.normalizeTaxonomy);
export const normalizeAudience = f<Fn<[unknown], { type: string; ids: string[] }>>(HC.normalizeAudience);
export const toMirrorNotice = f<Fn<[string, unknown], Notice>>(HC.toMirrorNotice);
export const subjectRollup = f<Fn<[unknown, ExamItem[] | Exam[]], any[]>>(HC.subjectRollup);
export const categoryRollup = f<Fn<[unknown, ExamItem[] | Exam[]], any[]>>(HC.categoryRollup);
export const subjectNameOf = f<Fn<[unknown, string], string>>(HC.subjectNameOf);
export const categoryNameOf = f<Fn<[unknown, string], string>>(HC.categoryNameOf);
export const greetingBn = f<Fn<[number], string>>(HC.greetingBn);
export const firstName = f<Fn<[string], string>>(HC.firstName);
export const safePhotoUrl = f<Fn<[unknown], string>>(HC.safePhotoUrl);
export const guidelinesOf = f<Fn<[unknown], string[]>>(HC.guidelinesOf);
export const pickMotivation = f<Fn<[unknown, number], { text: string; pinned: boolean }>>(HC.pickMotivation);
export const buildTopList = f<Fn<[any[], number?, string?], any[]>>(HC.buildTopList);
export const buildExamLeaders = f<Fn<[any[], Record<string, any>?, Record<string, unknown>?], any[]>>(HC.buildExamLeaders);
export const bestOf = f<Fn<[unknown], number>>(HC.bestOf);

// ---- exam-session-core.js (the saved-attempt rules)
export const Session = SS as any;
// ---- exam-analytics.js (result analytics)
export const Analytics = EA as any;
// ---- academic-core.js
export const Academic = AC as any;
// ---- auth-reset-core.js
export const Reset = AR as any;
// ---- permissions.js (admin roles → permissions)
export const ROLES = PM.ROLES as Record<string, { label: string; tone: string; desc: string; perms: string[] }>;
export const ROLE_ORDER = PM.ROLE_ORDER as string[];
export const normalizeRole = f<Fn<[unknown], string>>(PM.normalizeRole);
export const roleCan = (role: string, perm: string) => { const r = ROLES[normalizeRole(role)]; return r.perms.includes("*") || r.perms.includes(perm); };

export type { Question };
