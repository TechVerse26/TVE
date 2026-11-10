# Mobile Admin Panel — usage guide

Open **Profile → Open Admin Panel** (or the speedometer icon on Home). Only accounts with `isAdmin = true` see it. The panel edits the **same Firestore data** as the website admin; changes show up in both immediately (after a pull-to-refresh).

## Roles and what they can do (same model as the website)
| Role | Can |
| --- | --- |
| Super Admin (also: an admin with no role document) | everything, including adding/removing admins and changing roles |
| Manager | exams, questions, students, notices, push, results, analytics |
| Editor | create/edit exams and questions, notices; no deleting, no admin management |
| Viewer | look only |

The app hides what your role cannot do, **and** Firestore rules refuse it if someone tries anyway.

## Screens
* **Dashboard** — student / attempt counts and average score (server-side aggregation: a handful of reads), live and draft exam counts, shortcuts, latest activity.
* **Exams** — search and filter; tap an exam for: open, **edit exam & questions**, publish / move to draft, cancel / restore schedule, close / reopen registration, delete. Every change also refreshes the students' exam index and is written to the activity log.
* **Exam editor** — Details (title, type, window, duration, attempts, negative marking, pass mark, layout, shuffle, random pool size, subject, difficulty, instructions) and Questions (add / edit / reorder / delete; 2–6 options, one correct answer, optional explanation). Saved atomically in the website's question-bundle format.
* **Students** — search by name / email / roll / phone, filters, details, set roll number, deactivate / reactivate (a deactivated student can browse but not start exams).
* **Notices** — create, schedule, expire, draft / publish, target all students or one exam. Saving also refreshes the copy students read on Home.
* **Push notifications** — title (65), message (240), type, destination screen, audience: all students, or one exam's students (everyone / not submitted / submitted). "Send a test to me only" first. Uses the website's push system, so browsers and the app both receive it.
* **Results** — pick an exam to see every student's latest score, pass / fail and attempts.
* **Admins & roles** (Super Admin) — promote a student, change a role, remove access.
* **Activity log** — what every admin did, from the website and the app.

## Still on the website admin
Bulk question import, Email Center, homepage content editor, academic program management, subject / category editor, leaderboard publishing, analytics exports, site settings and the maintenance switch.
