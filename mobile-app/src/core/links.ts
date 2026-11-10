// Turns a website link (as carried by a push notification: "https://…/#/results", "#/exam?id=abc") into an in-app route.
const MAP: Record<string, string> = {
  home: "/home", exams: "/exams", exam: "/exams", schedule: "/schedule", results: "/results", categories: "/categories",
  profile: "/profile", leaderboard: "/leaderboard", performance: "/performance", notifications: "/notifications",
  help: "/info/help", faq: "/info/faq", about: "/info/about", privacy: "/info/privacy", terms: "/info/terms", credits: "/info/credits",
  "whats-new": "/info/whats-new", academic: "/academic",
};

export function routeFromSiteUrl(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "/home";
  const hash = text.includes("#") ? text.slice(text.indexOf("#") + 1) : text;
  const [path, qs = ""] = hash.replace(/^\/+/, "").split("?");
  const name = path.split("/")[0].toLowerCase();
  const params = new URLSearchParams(qs);
  if ((name === "exam" || name === "exams") && /^[A-Za-z0-9_-]{1,128}$/.test(params.get("id") || params.get("examId") || "")) {
    return `/exams/${params.get("id") || params.get("examId")}`;
  }
  return MAP[name] ?? "/home";
}
