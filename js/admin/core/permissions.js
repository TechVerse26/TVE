// ==========================================================================
// admin/core/permissions.js — role-based access control for the admin panel.
//
// Who is an admin at all is still decided by users/{uid}.isAdmin (unchanged — the same flag
// the course site uses). On top of that, adminRoles/{uid}.role narrows what an admin may do.
// An admin WITHOUT an adminRoles document is a Super Admin, so every existing admin keeps
// full access and nobody is locked out by this upgrade.
// ==========================================================================

export const ROLES = {
  super: {
    label: "Super Admin", tone: "accent", perms: ["*"],
    desc: "সবকিছু — সেটিংস, অ্যাডমিন ম্যানেজমেন্ট ও লগ মুছে ফেলা সহ।",
  },
  manager: {
    label: "Manager", tone: "teal",
    desc: "এক্সাম, প্রশ্ন, শিক্ষার্থী, রেজাল্ট ও নোটিফিকেশন পরিচালনা করতে পারে; সেটিংস ও অ্যাডমিন বদলাতে পারে না।",
    perms: ["exams.view", "exams.write", "exams.delete", "questions.view", "questions.write", "questions.delete",
      "taxonomy.view", "taxonomy.write", "students.view", "students.manage", "results.view", "results.export",
      "analytics.view", "notifications.manage", "logs.view"],
  },
  editor: {
    label: "Content Editor", tone: "amber",
    desc: "এক্সাম, প্রশ্ন ও বিষয়/ক্যাটাগরি তৈরি ও এডিট করতে পারে; মুছতে বা শিক্ষার্থী পরিচালনা করতে পারে না।",
    perms: ["exams.view", "exams.write", "questions.view", "questions.write", "taxonomy.view", "taxonomy.write",
      "results.view", "analytics.view"],
  },
  viewer: {
    label: "Viewer", tone: "",
    desc: "শুধু দেখতে পারে — কিছুই বদলাতে পারে না।",
    perms: ["exams.view", "questions.view", "taxonomy.view", "students.view", "results.view", "analytics.view"],
  },
};

export const ROLE_ORDER = ["super", "manager", "editor", "viewer"];

let current = { role: "super", perms: new Set(["*"]) };

export function normalizeRole(role) {
  return ROLES[role] ? role : "viewer"; // an unknown value gets the least privilege, never the most
}
export function setRole(role) {
  const r = normalizeRole(role);
  current = { role: r, perms: new Set(ROLES[r].perms) };
}
export const currentRole = () => current.role;
export const can = (perm) => current.perms.has("*") || current.perms.has(perm);
