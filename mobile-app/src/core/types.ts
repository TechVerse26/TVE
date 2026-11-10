// Shapes of the documents the website already stores in Firestore. The app never invents new ones.
export type Ts = { seconds?: number; nanoseconds?: number; toMillis?: () => number; toDate?: () => Date } | number | string | Date | null | undefined;

export interface Exam {
  id: string;
  title: string;
  description?: string;
  examType?: "live" | "practice";
  status?: "draft" | "published";
  courseId?: string;
  courseName?: string;
  duration?: number;
  questionCount?: number;
  questionsPerAttempt?: number;
  maxAttempts?: number;
  negativeMarking?: number;
  layout?: "one" | "all";
  shuffle?: boolean;
  subjectId?: string;
  categoryId?: string;
  difficulty?: "" | "easy" | "medium" | "hard";
  featured?: boolean;
  passPercent?: number;
  instructions?: string;
  publishAt?: Ts;
  closesAt?: Ts;
  availableHours?: number;
  cancelled?: boolean;
  registration?: "open" | "closed";
  visibility?: string;
  academicProgramId?: string;
  academicLevelId?: string;
  academicSubjectId?: string;
  lessonIds?: string[];
  lessonNames?: string[];
  qFormat?: number;
  qChunks?: number;
  createdAt?: Ts;
  [k: string]: unknown;
}

export interface Question {
  id: string;
  text: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
  order?: number;
}

export interface StatsEntry {
  n: number; s: number; t: number; p: number; at: number; ty: "live" | "practice"; ti: string;
  b?: number; c?: number; w?: number; u?: number; tt?: number;
  h?: { p: number; s: number; t: number }[];
}
export interface UserStats { exams: Record<string, StatsEntry> }

export interface Status {
  key: "live" | "soon" | "upcoming" | "open" | "completed" | "closed" | "unavailable";
  label: string; bn: string; tone: string; reason: string; canStart: boolean;
  cta: "start" | "retake" | "result" | "soon" | "none";
  startsAt: number | null; endsAt: number | null; msToStart: number | null; msToEnd: number | null; countdownTo: number | null;
}
export interface ExamItem { exam: Exam; status: Status; last: StatsEntry | null; attemptsUsed: number }

export interface Profile {
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
  isAdmin?: boolean;
  disabled?: boolean;
  phone?: string;
  roll?: string;
  institution?: string;
  enrolledCourses?: string[];
  createdAt?: Ts;
  [k: string]: unknown;
}

export interface ReviewItem { id?: string; n: number; text: string; options: string[]; correctIndex: number; explanation?: string; selected: number | null }
export interface AttemptRecord {
  id?: string | null; score: number; total: number; percent: number;
  correctCount: number; wrongCount: number; unansweredCount: number; timeTakenSeconds: number;
  submittedAt?: Ts; review?: ReviewItem[] | null;
}
export interface ResultDoc {
  id: string; uid: string; examId: string; examTitle?: string; examType?: "live" | "practice";
  score: number; total: number; percent: number; attemptNumber?: number; attempts?: AttemptRecord[];
  submittedAt?: Ts; [k: string]: unknown;
}

export interface Notice {
  id: string; title: string; body: string; category: string; priority: "normal" | "important" | "urgent";
  publishAt: number; expiresAt: number; audience: { type: string; ids: string[] }; examId: string; courseId: string; createdAt: number;
}
export interface TaxNode { id: string; name: string; parentId?: string }
export interface HomeFeed {
  content: any; notices: Notice[]; taxonomy: { subjects: TaxNode[]; categories: TaxNode[] };
  participants: Record<string, number>; participantsAt: number; passPercent: number; hasTaxonomy: boolean;
  ok: boolean; exists: boolean;
}
export interface Catalog {
  exams: Exam[]; courses: Record<string, { title: string; coverImage: string }>;
  statsReady: boolean; site: { maintenance: boolean; message: string }; source: "index" | "collection";
}
