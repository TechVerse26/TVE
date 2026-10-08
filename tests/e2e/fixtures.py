"""Seed data for the end-to-end run. Times are relative to NOW so every scenario is deterministic."""
M = 60 * 1000
H = 60 * M
D = 24 * H


def ts(ms):
    return {"__ts": int(ms)}


def build(now):
    def ex(id, title, **kw):
        base = dict(id=id, title=title, examType="live", duration=30, questionCount=10, qFormat=2, status="published",
                    createdAt=ts(now - 20 * D), courseId="", maxAttempts=0)
        base.update(kw)
        for k in ("publishAt", "closesAt", "scheduleUpdatedAt"):
            if isinstance(base.get(k), (int, float)):
                base[k] = ts(base[k])
        return base

    exams = [
        ex("live1", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫", questionCount=40, duration=30, subjectId="s-bn", categoryId="c-model-a",
           difficulty="medium", featured=True, publishAt=now - 30 * M, closesAt=now + 90 * M, negativeMarking=0.25, passPercent=50,
           createdAt=ts(now - 2 * D)),
        ex("soon1", "English Grammar Test 02", questionCount=25, duration=20, subjectId="s-en", categoryId="c-model", difficulty="easy",
           publishAt=now + 45 * M, closesAt=now + 3 * H, createdAt=ts(now - 6 * H), scheduleUpdatedAt=now - 2 * H),
        ex("up1", "Bangladesh Affairs Model Test 06", questionCount=50, duration=45, subjectId="s-ban", categoryId="c-model", difficulty="hard",
           featured=True, publishAt=now + 1 * D + 2 * H, closesAt=now + 3 * D),
        ex("up2", "Mathematics Speed Test", questionCount=30, duration=25, subjectId="s-math", publishAt=now + 30 * H, closesAt=now + 33 * H),
        ex("open1", "General Knowledge Open Exam", questionCount=20, duration=15, subjectId="s-gk", difficulty="medium"),
        ex("prac1", "IQ Practice Set", examType="practice", questionCount=15, duration=12, subjectId="s-iq", difficulty="easy"),
        ex("done1", "Previous Week Model Test", questionCount=10, publishAt=now - 3 * D, closesAt=now - 2 * D, subjectId="s-bn"),
        ex("cx1", "Science Test (Cancelled)", questionCount=20, publishAt=now + 5 * H, closesAt=now + 8 * H, cancelled=True, subjectId="s-sci"),
        ex("lock1", "Course-only Exam", courseId="c-other", courseName="Other Course", publishAt=now - H, closesAt=now + H),
        ex("unl1", "Unlisted Direct-link Exam", visibility="unlisted", publishAt=now - H, closesAt=now + H),
        ex("full1", "One-attempt Exam", questionCount=10, maxAttempts=1, publishAt=now - D, closesAt=now + D, subjectId="s-gk"),
    ]

    def res(n, s, t, at, ty="live", title="", best=None):
        p = round(s * 100 / t)
        e = {"n": n, "s": s, "t": t, "p": p, "at": int(at), "ty": ty, "ti": title}
        if best is not None:
            e["b"] = best
        return e

    seed = {
        "users/stu1": {"displayName": "Abdullah Rahman", "email": "stu@example.com", "enrolledCourses": ["c1"], "isAdmin": False, "createdAt": ts(now - 40 * D)},
        "users/adm1": {"displayName": "Admin One", "email": "admin@example.com", "enrolledCourses": [], "isAdmin": True, "createdAt": ts(now - 90 * D)},
        "examIndex/main": {"exams": exams, "courses": {"c1": {"title": "Main Course"}}, "site": {"maintenance": False, "message": ""},
                           "statsBackfilledAt": ts(now - 5 * D), "updatedAt": ts(now - D)},
        "homeFeed/main": {
            "content": {"heroTitle": "প্রস্তুত তো? আজকের পরীক্ষা শুরু করুন।", "info": "রেজিস্ট্রেশন ছাড়া পরীক্ষায় অংশ নেওয়া যাবে না।",
                        "banner": {"enabled": True, "title": "নতুন মডেল টেস্ট সিরিজ শুরু", "text": "প্রতি সপ্তাহে ২টি লাইভ পরীক্ষা।", "linkText": "সময়সূচি দেখুন", "link": "#/schedule"},
                        "guidelines": [], "sections": {}},
            "notices": [
                {"id": "n-urgent", "title": "আগামীকাল সকাল ১০টায় বাংলাদেশ বিমান বাহিনী মডেল পরীক্ষা অনুষ্ঠিত হবে।", "body": "সবাই সময়মতো উপস্থিত থাকুন। ইন্টারনেট সংযোগ আগে থেকেই পরীক্ষা করে নিন এবং পরীক্ষার মাঝখানে পেজ রিফ্রেশ করবেন না।",
                 "category": "exam", "priority": "urgent", "publishAt": now - H, "expiresAt": now + 2 * D, "audience": {"type": "all", "ids": []}, "examId": "live1", "courseId": "", "createdAt": now - H},
                {"id": "n-imp", "title": "ফলাফল প্রকাশের সময়সূচি", "body": "ফলাফল জমা দেওয়ার সাথে সাথেই দেখা যাবে।", "category": "result", "priority": "important",
                 "publishAt": now - 5 * H, "expiresAt": 0, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": now - 5 * H},
                {"id": "n-norm", "title": "নতুন প্র্যাকটিস সেট যোগ হয়েছে", "body": "", "category": "general", "priority": "normal",
                 "publishAt": now - 9 * H, "expiresAt": 0, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": now - 9 * H},
                {"id": "n-old", "title": "মেয়াদ শেষ নোটিশ", "body": "x", "category": "general", "priority": "normal", "publishAt": now - 5 * D, "expiresAt": now - D, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": now - 5 * D},
                {"id": "n-future", "title": "ভবিষ্যতের নোটিশ", "body": "x", "category": "general", "priority": "normal", "publishAt": now + 2 * H, "expiresAt": 0, "audience": {"type": "all", "ids": []}, "examId": "", "courseId": "", "createdAt": now},
                {"id": "n-other", "title": "অন্য কোর্সের নোটিশ", "body": "x", "category": "course", "priority": "normal", "publishAt": now - H, "expiresAt": 0, "audience": {"type": "course", "ids": ["c-other"]}, "examId": "", "courseId": "", "createdAt": now - H},
            ],
            "taxonomy": {"subjects": [{"id": "s-bn", "name": "বাংলা"}, {"id": "s-en", "name": "English"}, {"id": "s-ban", "name": "Bangladesh Affairs"},
                                      {"id": "s-math", "name": "Mathematics"}, {"id": "s-gk", "name": "General Knowledge"}, {"id": "s-iq", "name": "IQ"}, {"id": "s-sci", "name": "Science"}],
                         "categories": [{"id": "c-model", "name": "Model Test", "parentId": None}, {"id": "c-model-a", "name": "Set A", "parentId": "c-model"}]},
            "participants": {"live1": 128},
            "passPercent": 60,
        },
        "userStats/stu1": {"v": 1, "uid": "stu1", "exams": {
            "done1": res(2, 8, 10, now - 2 * D - H, "live", "Previous Week Model Test", best=80),
            "full1": res(1, 4, 10, now - 20 * H, "live", "One-attempt Exam"),
            "prac1": res(3, 12, 15, now - 6 * H, "practice", "IQ Practice Set"),
            "old1": res(1, 9, 10, now - 12 * D, "live", "Old Mock A", best=90),
            "old2": res(2, 5, 10, now - 15 * D, "live", "Old Mock B", best=60),
        }},
        "leaderboard/publicStats": {"percents": [96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52, 50, 48],
                                    "top": [{"n": "Rahim Uddin", "p": 96, "e": 5}, {"n": "Karim Hossain", "p": 94, "e": 4}, {"n": "Nusrat Jahan", "p": 92, "e": 6},
                                            {"n": "Tanvir Ahmed", "p": 90, "e": 3}, {"n": "Mitu Akter", "p": 88, "e": 4}], "updatedAt": ts(now - 3 * H)},
        # --- for the exam start flow (live1 is open right now) ---
        "exams/live1": ex("live1", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫", questionCount=3, duration=30, publishAt=now - 30 * M, closesAt=now + 90 * M,
                          negativeMarking=0.25, passPercent=50, shuffle=False, instructions="প্রতিটি প্রশ্নের একটি সঠিক উত্তর আছে।"),
        "examBundles/live1": {"chunks": 1, "questions": [
            {"id": "q1", "text": "বাংলাদেশের রাজধানী কোনটি?", "options": ["ঢাকা", "চট্টগ্রাম", "খুলনা", "রাজশাহী"], "correctIndex": 0, "explanation": "ঢাকা", "order": 0},
            {"id": "q2", "text": "2 + 2 = ?", "options": ["3", "4", "5", "6"], "correctIndex": 1, "explanation": "", "order": 1},
            {"id": "q3", "text": "Which is a fruit?", "options": ["Car", "Apple", "Chair", "Table"], "correctIndex": 1, "explanation": "", "order": 2},
        ]},
        "exams/soon1": ex("soon1", "English Grammar Test 02", questionCount=3, duration=20, publishAt=now + 45 * M, closesAt=now + 3 * H),
        "examBundles/soon1": {"chunks": 1, "questions": [{"id": "q1", "text": "Pick one", "options": ["a", "b"], "correctIndex": 0, "order": 0}]},
    }
    for e in exams:  # every exam also exists as a full document (the start flow reads exams/{id} fresh)
        seed.setdefault(f"exams/{e['id']}", dict(e))
    return seed


def build_admin(now):
    """The student seed plus what an admin session needs: taxonomy, other students, result documents, start counters."""
    seed = build(now)
    seed["examTaxonomy/main"] = {"v": 1,
        "subjects": [{"id": "s-bn", "name": "বাংলা", "note": ""}, {"id": "s-en", "name": "English", "note": ""}, {"id": "s-ban", "name": "Bangladesh Affairs", "note": ""},
                     {"id": "s-math", "name": "Mathematics", "note": ""}, {"id": "s-gk", "name": "General Knowledge", "note": ""}, {"id": "s-iq", "name": "IQ", "note": ""},
                     {"id": "s-sci", "name": "Science", "note": ""}, {"id": "s-new", "name": "ICT (new)", "note": ""}],
        "categories": [{"id": "c-model", "name": "Model Test", "parentId": None, "type": "exam"}, {"id": "c-model-a", "name": "Set A", "parentId": "c-model", "type": "exam"}]}
    for uid, name in (("stuA", "Rahim Uddin"), ("stuB", "Karim Hossain"), ("stuC", "Nusrat Jahan")):
        seed[f"users/{uid}"] = {"displayName": name, "email": f"{uid}@example.com", "enrolledCourses": [], "isAdmin": False, "createdAt": ts(now - 10 * D)}

    def result(uid, exam_id, title, percents, review=None, typ="live"):
        attempts = []
        for i, p in enumerate(percents):
            a = {"percent": p, "score": p // 10, "total": 10, "timeTakenSeconds": 300 + i * 20, "submittedAt": ts(now - (len(percents) - i) * H)}
            if review is not None and i == len(percents) - 1:
                a["review"] = review
            attempts.append(a)
        return {"uid": uid, "examId": exam_id, "examTitle": title, "examType": typ, "percent": percents[-1], "score": percents[-1] // 10, "total": 10,
                "attemptNumber": len(percents), "attempts": attempts, "timeTakenSeconds": 300, "submittedAt": ts(now - H)}

    rv = lambda text, sel: {"text": text, "options": ["a", "b", "c"], "correctIndex": 0, "selected": sel, "explanation": ""}
    seed["results/stuA_live1"] = result("stuA", "live1", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫", [55, 90], review=[rv("বাংলাদেশের রাজধানী কোনটি?", 1)])
    seed["results/stuB_live1"] = result("stuB", "live1", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫", [40], review=[rv("বাংলাদেশের রাজধানী কোনটি?", None), rv("2 + 2 = ?", 2)])
    seed["results/stuC_live1"] = result("stuC", "live1", "বাংলাদেশ বিমান বাহিনী মডেল টেস্ট ০৫", [70], review=[rv("2 + 2 = ?", 1)])
    seed["results/stuA_done1"] = result("stuA", "done1", "Previous Week Model Test", [80])
    seed["results/stuB_done1"] = result("stuB", "done1", "Previous Week Model Test", [60])
    seed["examSessions/stuA_live1"] = {"uid": "stuA", "examId": "live1", "starts": 3, "lastStartAt": ts(now - H)}   # 3 starts, 2 submitted → 1 abandoned
    seed["examSessions/stuB_live1"] = {"uid": "stuB", "examId": "live1", "starts": 1, "lastStartAt": ts(now - H)}
    seed["examSessions/stuD_live1"] = {"uid": "stuD", "examId": "live1", "starts": 2, "lastStartAt": ts(now - H)}   # started twice, never submitted → 2 abandoned
    return seed
