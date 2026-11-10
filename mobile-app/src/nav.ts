import { analyticsOutline, calendarOutline, documentTextOutline, ellipsisHorizontal, homeOutline, megaphoneOutline, peopleOutline, personOutline, ribbonOutline, speedometerOutline } from "ionicons/icons";

export interface Tab { id: string; label: string; icon: string; path: string }
export const STUDENT_TABS: Tab[] = [
  { id: "home", label: "Home", icon: homeOutline, path: "/home" },
  { id: "exams", label: "Exams", icon: documentTextOutline, path: "/exams" },
  { id: "schedule", label: "Schedule", icon: calendarOutline, path: "/schedule" },
  { id: "results", label: "Results", icon: ribbonOutline, path: "/results" },
  { id: "profile", label: "Profile", icon: personOutline, path: "/profile" },
];
export const ADMIN_TABS: Tab[] = [
  { id: "dash", label: "Dashboard", icon: speedometerOutline, path: "/admin" },
  { id: "exams", label: "Exams", icon: documentTextOutline, path: "/admin/exams" },
  { id: "students", label: "Students", icon: peopleOutline, path: "/admin/students" },
  { id: "notices", label: "Notices", icon: megaphoneOutline, path: "/admin/notices" },
  { id: "more", label: "More", icon: ellipsisHorizontal, path: "/admin/more" },
];
export const isPrimaryPath = (p: string) => [...STUDENT_TABS, ...ADMIN_TABS].some((t) => t.path === p);
/** Screens that take the whole display (exam player, sign-in) — no navigation chrome at all. */
export const isImmersivePath = (p: string) => /\/play$/.test(p) || ["/login", "/signup", "/forgot"].includes(p);
export { analyticsOutline };
