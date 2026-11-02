"""Seed data for the Academic Management end-to-end runs (shared by run_academic.py and run_academic_admin.py).

Everything here is DATA — the code under test has no SSC / HSC / Masters / Mathematics anywhere:

  Academic (free)                       P1   active
   ├─ SSC            (inherit → free)   L-ssc      ├─ Mathematics        S-ssc-math   ← 3 exams: live, upcoming, practice
   │                                               ├─ পদার্থবিজ্ঞান        S-ssc-phy    ← 1 live exam
   │                                               └─ (archived subject)  S-ssc-arch   ← hidden
   ├─ HSC            (PAID)             L-hsc      └─ Mathematics        S-hsc-math   ← same NAME as SSC's, a different subject; 1 live exam
   └─ Masters        (inactive)         L-ms       └─ Finance            S-ms-fin     ← hidden with its level; 1 live exam
  Admission (inactive section)          P2
"""
import fixtures
from fixtures import ts, D, H, M


def node(**kw):
    base = dict(description="", coverImage="", status="active", order=10, accessMode="inherit", linkedCourseId="")
    base.update(kw)
    return base


def academic_nodes(now):
    created = dict(createdAt=ts(now - 30 * D), updatedAt=ts(now - 2 * D))
    return {
        "academicSections/P1": node(name="Academic", description="School & college programs — pick a level, then a subject.", coverImage="https://img.example.com/academic.webp", accessMode="free", order=10, **created),
        "academicSections/P2": node(name="Admission", description="Not published yet", status="inactive", order=20, **created),
        "academicLevels/L-ssc": node(sectionId="P1", name="SSC", description="Secondary School Certificate", coverImage="https://img.example.com/ssc.webp", order=10, **created),
        "academicLevels/L-hsc": node(sectionId="P1", name="HSC", description="Higher Secondary Certificate", coverImage="https://img.example.com/hsc.webp", accessMode="paid", order=20, **created),
        "academicLevels/L-ms": node(sectionId="P1", name="Masters", status="inactive", order=30, **created),
        "academicSubjects/S-ssc-math": node(sectionId="P1", levelId="L-ssc", name="Mathematics", description="Algebra, geometry, trigonometry", coverImage="https://img.example.com/math.webp", order=10, **created),
        "academicSubjects/S-ssc-phy": node(sectionId="P1", levelId="L-ssc", name="পদার্থবিজ্ঞান", description="বল, গতি ও শক্তি", order=20, **created),
        "academicSubjects/S-ssc-arch": node(sectionId="P1", levelId="L-ssc", name="Old Subject", status="archived", order=30, **created),
        "academicSubjects/S-hsc-math": node(sectionId="P1", levelId="L-hsc", name="Mathematics", description="Higher mathematics", order=10, **created),
        "academicSubjects/S-ms-fin": node(sectionId="P1", levelId="L-ms", name="Finance", order=10, **created),
    }


def academic_exams(now):
    def ex(id, title, level, subject, **kw):
        base = dict(id=id, title=title, examType="live", duration=20, questionCount=3, qFormat=2, status="published",
                    createdAt=ts(now - D), courseId="", maxAttempts=0, shuffle=False,
                    academicProgramId="P1", academicLevelId=level, academicSubjectId=subject)
        base.update(kw)
        for k in ("publishAt", "closesAt"):
            if isinstance(base.get(k), (int, float)):
                base[k] = ts(base[k])
        return base
    return [
        ex("ac-math-live", "SSC Mathematics Model Test 01", "L-ssc", "S-ssc-math", publishAt=now - 30 * M, closesAt=now + 90 * M),
        ex("ac-math-soon", "SSC Mathematics Model Test 02", "L-ssc", "S-ssc-math", publishAt=now + 2 * H, closesAt=now + 5 * H),
        ex("ac-math-prac", "SSC Mathematics Practice Set", "L-ssc", "S-ssc-math", examType="practice"),
        ex("ac-phy-live", "SSC Physics Chapter Test", "L-ssc", "S-ssc-phy", publishAt=now - 20 * M, closesAt=now + 60 * M),
        ex("ac-hsc-live", "HSC Mathematics Test", "L-hsc", "S-hsc-math", publishAt=now - 10 * M, closesAt=now + 80 * M),
        ex("ac-ms-live", "Masters Finance Test", "L-ms", "S-ms-fin", publishAt=now - 10 * M, closesAt=now + 80 * M),
    ]


BUNDLE = {"chunks": 1, "questions": [
    {"id": "q1", "text": "2 + 2 = ?", "options": ["3", "4", "5", "6"], "correctIndex": 1, "explanation": "", "order": 0},
    {"id": "q2", "text": "10 − 3 = ?", "options": ["6", "7", "8", "9"], "correctIndex": 1, "explanation": "", "order": 1},
    {"id": "q3", "text": "3 × 3 = ?", "options": ["6", "9", "12", "3"], "correctIndex": 1, "explanation": "", "order": 2},
]}


def add_academic(seed, now, *, hidden=True, entitled=()):
    """Adds the academic tree + exams to a fixtures.build()/build_admin() seed. `entitled` = node ids stu1 has been granted."""
    seed.update(academic_nodes(now))
    exams = academic_exams(now)
    idx = seed["examIndex/main"]
    idx["exams"] = list(idx["exams"]) + [dict(e) for e in exams]
    for e in exams:
        seed[f"exams/{e['id']}"] = dict(e)
        seed[f"examBundles/{e['id']}"] = dict(BUNDLE)
    if hidden:   # what the admin panel publishes (examIndex/main.academicHidden) for the non-active nodes
        idx["academicHidden"] = ["L-ms", "P2", "S-ssc-arch"]
    for nid in entitled:
        kind = "section" if nid.startswith("P") else "level" if nid.startswith("L-") else "subject"
        seed[f"academicEntitlements/stu1_{nid}"] = {"uid": "stu1", "nodeId": nid, "nodeKind": kind, "studentName": "Abdullah Rahman",
                                                    "studentEmail": "stu@example.com", "source": "admin", "grantedAt": ts(now - D)}
    return seed
