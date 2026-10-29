# Email Center — EmailJS দিয়ে শিক্ষার্থীদের ব্যক্তিগতকৃত ইমেইল

Admin Panel → **Communication → Email Center** (`admin.html#/email-center`). এটি আলাদা কোনো সাইট নয় — বিদ্যমান অ্যাডমিন প্যানেলের
ভেতরেই চলে, একই শিক্ষার্থী-ডেটা, একই অ্যাডমিন লগইন ও রোল, একই ডিজাইন ব্যবহার করে। কোনো নতুন ফ্রেমওয়ার্ক, ব্যাকএন্ড বা বিল্ড-স্টেপ নেই।

**যা করতে পারে:** সাধারণ ঘোষণা · "এই এক্সাম এখনো জমা দেননি" রিমাইন্ডার · "শুরু করেছেন কিন্তু জমা নেই" রিমাইন্ডার ·
আসন্ন/চলমান এক্সামের রিমাইন্ডার · হাতে-বাছা শিক্ষার্থীদের ইমেইল · টেমপ্লেট · প্রিভিউ ও টেস্ট-সেন্ড · নিয়ন্ত্রিত বাল্ক সেন্ড
(প্রতিজনকে আলাদা ইমেইল) · retry · ক্যাম্পেইন হিস্ট্রি ও CSV · অডিট লগ।

**মূল নিয়ম:** প্রতিটি শিক্ষার্থী **শুধু নিজের তথ্যসহ নিজের ইমেইল** পায় (কখনো CC/BCC তালিকা নয়)। যে তথ্যের নির্ভরযোগ্য উৎস নেই তা
**বানিয়ে লেখা হয় না**। "Request accepted" মানে EmailJS অনুরোধ নিয়েছে — ইনবক্সে পৌঁছানোর নিশ্চয়তা নয়, এবং কোথাও তা দাবিও করা হয় না।

---

## ১. চালু করার ধাপ (এই ক্রমে)

1. **`firestore.rules` Publish করুন** (Console → Firestore → Rules → পুরো ফাইল পেস্ট → Publish)। নতুন কালেকশন: `emailSettings`,
   `emailTemplates`, `emailCampaigns` (+ `parts`)। Publish না করলে Email Center "Firestore rules প্রয়োজন" লিখে দেখাবে; কিছু পাঠানো যাবে না।
2. **ফাইল ডেপ্লয় করুন** — সাথে `assets/email-logo.png` (ইমেইলের হেডারের লোগো; Gmail SVG দেখায় না বলে PNG)।
3. **EmailJS Dashboard** সাজান — পরের অংশ।
4. Email Center → **Email Settings** → Service ID, Template ID, Public Key বসিয়ে **Save** (শুধু Super Admin)।
5. **Send test email** চাপুন → আপনার ইনবক্স (স্প্যাম ফোল্ডারসহ) দেখুন। **টেস্ট সফল না হওয়া পর্যন্ত বাল্ক সেন্ড বন্ধ থাকে**; কনফিগারেশন
   (Service/Template ID বা কী) বদলালে আগের টেস্ট বাতিল হয়ে যায়।
6. প্রথম ক্যাম্পেইন: **Exam Reminders** → এক্সাম বাছুন → গ্রুপ দেখুন → রিমাইন্ডারের ধরন বাছুন → **Compose** → Preview → Send test → Send।

---

## ২. EmailJS Dashboard — হুবহু কনফিগারেশন

> EmailJS-এর ইন্টারফেসের নাম মাঝে মাঝে বদলায়; কিছু মেনুর নাম একটু আলাদা হলে docs.emailjs.com দেখুন। নিচের মানগুলো (কোড-মডিউল ও
> প্যারামিটারের নাম) এই প্রজেক্টের নিজস্ব — এগুলো হুবহু বসাতে হবে।

**(ক) Email Service** — *Email Services → Add New Service* → আপনার ইমেইল প্রোভাইডার (যেমন Gmail) বেছে সংযুক্ত করুন →
**Service ID** কপি করুন (`service_…`)।
- ইমেইল **যে অ্যাকাউন্ট থেকে যায়, সেটি এই সংযুক্ত অ্যাকাউন্টের ঠিকানা**। কোড থেকে প্রেরকের ঠিকানা বদলানো যায় না (এবং বদলানোর
  ভান করাও হয় না) — আমরা শুধু প্রদর্শিত **নাম** (`from_name`) ও **Reply-To** (`reply_to`, ডিফল্টে সাপোর্ট ইমেইল) পাঠাই।

**(খ) Email Template** — *Email Templates → Create New Template* → Editor হিসেবে **Code Editor (HTML)** নিন। **Content**-এ শুধু এই একটি লাইন:

```
{{{html_body}}}
```

তিনটি `{` জরুরি — দুটি দিলে EmailJS HTML-টিকে লেখা (escaped) হিসেবে ছাপবে। (পুরো ইমেইল-ডিজাইনটি এই প্রজেক্টে তৈরি হয়, তাই
Dashboard-এ ডিজাইন করতে হয় না এবং প্রিভিউ = যা সত্যিই যাবে।) তারপর টেমপ্লেটের **Settings** ট্যাবে:

| EmailJS ফিল্ড | মান | কেন |
|---|---|---|
| **To Email** | `{{to_email}}` | প্রতিটি ইমেইল ঠিক একজন প্রাপকের কাছে |
| **From Name** | `{{from_name}}` | প্রেরকের নাম (Email Settings → Default sender name) |
| **From Email** | ডিফল্ট ("Use Default Email Address") রাখুন | অপ্রমাণিত ঠিকানা বসালে প্রোভাইডার আটকাবে |
| **Reply To** | `{{reply_to}}` | উত্তর যায় সাপোর্ট ইমেইলে |
| **Subject** | `{{subject}}` | প্রতিজনের জন্য তৈরি বিষয় |
| **Cc / Bcc** | **ফাঁকা** | সব শিক্ষার্থীকে কখনো CC/BCC করা হয় না |

Save করে **Template ID** কপি করুন (`template_…`)।

**(গ) Public Key** — *Account → General* থেকে **Public Key** কপি করুন। **Private Key কখনো এখানে বা কোডে বসাবেন না** (ওটা সার্ভারের জন্য;
Email Settings-এ তার কোনো ঘরই নেই)।

**(ঘ) Account → Security** — "non-browser API calls" **বন্ধ** রাখুন; আপনার প্ল্যানে থাকলে **Allowed domains/origins**-এ শুধু আপনার
অ্যাডমিন সাইটের ডোমেইন দিন এবং headless-ব্রাউজার ব্লক চালু করুন। (নিচের ৮ম অংশে কারণ।)

**(ঙ) প্রতিটি ইমেইলের সাথে যে প্যারামিটারগুলো যায়** (নিজের টেমপ্লেটে ব্যবহার করতে চাইলে):
`to_email` · `to_name` · `from_name` · `reply_to` · `subject` · `html_body` (সম্পূর্ণ HTML) · `message_text` (শুধু-টেক্সট সংস্করণ — প্লেইন-টেক্সট
টেমপ্লেট চাইলে Content-এ `{{message_text}}` দিন) · এবং নিচের ১৭টি ভেরিয়েবল তাদের নিজের নামে। EmailJS সাধারণত HTML-এর সাথে একটি টেক্সট অংশও
(multipart) পাঠায়।

**(চ) EmailJS-এর সীমা (কোডে ধরে নেওয়া হয়নি — আপনার প্ল্যান দেখে নিন):** (১) **প্রতি সেকেন্ডে ১টি রিকোয়েস্ট** — তাই সেন্ডার সবসময় একটি-একটি করে,
≥ ১.১ সেকেন্ড ব্যবধানে পাঠায়, ১০০ জনে ≈ ২ মিনিট; (২) প্রতি রিকোয়েস্টের আকার সীমিত (ফ্রি প্ল্যানে ≈ ৫০ KB) — প্রতিটি ইমেইল ৫০ KB-র নিচে কিনা
Compose-এ দেখায়, বড় হলে পাঠানো আটকায়; (৩) **মাসিক/দৈনিক কোটা প্ল্যান অনুযায়ী** — Dashboard-এ দেখুন; বড় ক্যাম্পেইনের আগে Email Settings →
**Safety cap** (এক ক্যাম্পেইনে সর্বোচ্চ প্রাপক) বসিয়ে রাখতে পারেন।

---

## ৩. ভেরিয়েবল → ডেটার উৎস

`{{variable}}` বসালে প্রতিটি প্রাপকের আসল ডেটা বসে। উৎস না থাকলে ভেরিয়েবল **খালি/অনুপস্থিত** — কখনো অনুমান নয়।

| ভেরিয়েবল | উৎস | তথ্য না থাকলে |
|---|---|---|
| `{{student_name}}` | `users/{uid}.displayName` | টেমপ্লেটে ফলব্যাক আছে: `{{student_name\|Student}}` |
| `{{student_email}}` | `users/{uid}.email` (বৈধ হতে হবে) | প্রাপক বাদ (invalid e-mail) |
| `{{student_roll}}` | `users/{uid}.roll` | অনুপস্থিত (নিচের নীতি) |
| `{{student_id}}` | `users/{uid}.studentId` — **এই প্রজেক্টে আলাদা স্টুডেন্ট-আইডি ফিল্ড নেই**, তাই ফিল্ডটি যোগ না করলে সবসময় খালি | অনুপস্থিত |
| `{{course_name}}` | এক্সামের কোর্স → ক্যাম্পেইনের বাছা কোর্স → শিক্ষার্থীর নিজের এনরোলমেন্ট (≤৩টি, বাকি `+N`) | অনুপস্থিত |
| `{{exam_title}}` | `exams/{id}.title` | — |
| `{{exam_date}}` / `{{exam_time}}` | `exams/{id}.publishAt` (তারিখ/সময় — Email Settings-এর time zone, ডিফল্ট Asia/Dhaka) | সময়সূচি না থাকলে **অনুপস্থিত** (তারিখ বানানো হয় না) |
| `{{exam_duration}}` | `exams/{id}.duration` (মিনিট) | অনুপস্থিত |
| `{{exam_status}}` | `schedule-core.js`-এর এক্সাম-অবস্থা (Open now / Opens on … / Closed …) | — |
| `{{exam_url}}` | `footer-config.js`-এর website + `#/exam?id={examId}` | অনুপস্থিত |
| `{{attempt_status}}` | `results` + `examSessions` (নিচের ৪র্থ অংশ) | এক্সাম না থাকলে অনুপস্থিত |
| `{{attempt_count}}` | `results/{uid}_{examId}`-এর জমা-দেওয়া অ্যাটেম্পট সংখ্যা | ফলাফল পড়া না গেলে অনুপস্থিত |
| `{{deadline}}` | Compose-এর "Deadline" ঘর → নইলে `exams/{id}.closesAt` (শুরু করার শেষ মুহূর্ত) | অনুপস্থিত |
| `{{website_url}}` | `js/footer-config.js → contact.website` | — |
| `{{support_email}}` | `js/footer-config.js → contact.email` | — |
| `{{personal_message}}` | Compose-এর "Personal message" ঘর | ঐচ্ছিক — খালি হলে ওই প্যারাগ্রাফ মুছে যায় |

**অনুপস্থিত তথ্যের নীতি (Compose → "If a student lacks data a {{variable}} needs"):**
- **Block** (ডিফল্ট): যে ভেরিয়েবলের মান কারও নেই তা পাঠানো আটকায় (নামসহ দেখায়)।
- **Skip**: ওই শিক্ষার্থীদের বাদ দিয়ে বাকিদের পাঠায়।
- **Fallback**: "Not available" বসিয়ে পাঠায়।
- ভেরিয়েবলে নিজের ফলব্যাক দিলে (`{{exam_date|এখনো জানানো হয়নি}}`) তা ব্লক করে না।
- যে মান **কোনো প্রাপকেরই নেই** (যেমন সময়সূচিহীন এক্সামে `{{exam_date}}`) তা সবসময় ব্লক করে; ভুল বানানের ভেরিয়েবল (`{{studnt_name}}`) সবসময় ব্লক করে।

ইমেইলের "Student information" ও "Examination details" প্যানেলে শুধু যে সারির তথ্য সত্যিই আছে সেটাই দেখায়; নেই এমন সারি বাদ যায়।
ইমেইলে **পাসওয়ার্ড, টোকেন, uid বা অন্য কারও কোনো তথ্য যায় না** (পাঠানো প্যারামিটারের তালিকা ওপরের (ঙ)-তে; uid নেই)।

---

## ৪. কাকে ইমেইল যাবে

**যোগ্যতা (সবসময়):** অ্যাডমিন ও Deactivated অ্যাকাউন্ট বাদ · বৈধ ইমেইল ঠিকানা থাকতে হবে · কোর্স-নির্দিষ্ট এক্সামের ক্ষেত্রে ওই কোর্সে এনরোল থাকতে হবে
(`isExamVisibleTo`, শিক্ষার্থীর সাইটের নিয়মই)।

**এক্সামের অবস্থা অনুযায়ী কোন ধরনের রিমাইন্ডার সৎ:**

| এক্সাম | "Exam not attempted" | "Started, not submitted" | "Upcoming / current reminder" |
|---|---|---|---|
| চালু / প্র্যাকটিস | ✔ | ✔ | ✔ (সময়সূচি থাকলে) |
| শুরু হয়নি (Upcoming) | ✘ (এখনো শুরুই হয়নি) | ✘ | ✔ |
| নতুন এন্ট্রি বন্ধ (Registration closed) | ✘ | ✔ (চলমান অ্যাটেম্পট শেষ করতে পারে) | ✘ |
| সময় শেষ / বাতিল / Draft | ✘ (বন্ধ এক্সামকে "এখনো দেননি" বলে বিভ্রান্ত করা হয় না) | ✘ | ✘ |

সাধারণ ঘোষণা (Announcement) সবসময় চলে।

**শ্রেণিবিন্যাস — শুধু প্রমাণ দেখে:**
`results/{uid}_{examId}` = জমার প্রমাণ (অন্য এক্সামের ফলাফল গণনায় আসে না) · `examSessions/{uid}_{examId}` = শুরুর প্রমাণ।

| অবস্থা | শর্ত |
|---|---|
| **Submitted** | এই এক্সামের `results` ডকুমেন্ট আছে |
| **Started, no submission** | ফলাফল নেই, কিন্তু `examSessions`-এ start-রেকর্ড আছে |
| **Not attempted** | ফলাফল নেই, start-রেকর্ডও নেই — **এবং** start-tracking সফলভাবে পড়া গেছে |
| **No result (start unverified)** | ফলাফল নেই, কিন্তু `examSessions` **পড়া যায়নি** → "কখনো শুরু করেননি" বলা হয় না; ইমেইলে শুধু "জমা দেওয়া ফলাফল রেকর্ড নেই" |
| **Could not be verified** | `results` নিজেই পড়া যায়নি → কিছুই যাচাই করা যায়নি; সব রিমাইন্ডার আটকে যায় |
| **Excluded** | অ্যাডমিন / Deactivated / কোর্সে এনরোল নেই |

> Start-রেকর্ড শুধু `examSessions` rules চালু হওয়ার পরের শুরুগুলোর জন্য থাকে — তাই "start-রেকর্ড নেই" মানে "কখনো খোলেননি" এমন প্রমাণ নয়;
> ইমেইলের ভাষাও সেটা দাবি করে না ("no submitted result has been recorded for this examination under your account")।

**প্রাপক নির্বাচনের মডেল (Student Recipients):** যা টিক করা আছে ঠিক তাদেরই পাঠানো হয়। "Select every eligible student", "By course", "By exam"
শুধু টিক বসায় — পরে যে কাউকে বাদ দেওয়া যায়। ফিল্টার/সার্চ বদলালেও টিক থাকে। **"Select all N in this list"** (শুধু ফিল্টার-করা তালিকা) আর
**"Select every eligible student"** (ডেটাবেসের সবাই, নিশ্চিতকরণসহ) আলাদা বাটন। যাঁদের কোনোভাবেই পাঠানো যাবে না (অ্যাডমিন, deactivated, অবৈধ ইমেইল,
এক্সামের কোর্সে নেই, ইতিমধ্যে জমা দিয়েছেন) তাঁদের টিক দেওয়াই যায় না।

**পাঠানোর মুহূর্তের পুনর্যাচাই:** Send চাপলে এক্সাম-ভিত্তিক ক্যাম্পেইনে ওই এক্সামের ফলাফল ও start-তথ্য **আবার পড়া** হয়; তালিকা তৈরির পর যিনি জমা দিয়েছেন
তাঁকে বাদ দিয়ে নিশ্চিতকরণ ডায়ালগে জানানো হয়। দীর্ঘ রানে প্রতি ~৩ মিনিটে আবার যাচাই হয়, এবং প্রতিজনের পালা আসার মুহূর্তেও।

---

## ৫. পাঠানোর ইঞ্জিন — নির্ভরযোগ্যতা

**অবস্থার অর্থ:**

| অবস্থা | মানে |
|---|---|
| `pending` | এখনো চেষ্টা হয়নি |
| `sending` | EmailJS-এ গেছে, উত্তর আসেনি (শুধু মুহূর্তের জন্য; পেজ মরলে `uncertain` হয়ে যায়) |
| `accepted` | EmailJS HTTP 200 "OK" দিয়েছে → **অনুরোধ গৃহীত** (ইনবক্স-ডেলিভারির নিশ্চয়তা নয়) |
| `failed` | EmailJS **ত্রুটি-উত্তর** দিয়েছে → ইমেইল প্রত্যাখ্যাত → আবার চেষ্টা নিরাপদ |
| `uncertain` | **কোনো উত্তরই আসেনি** (টাইমআউট/নেটওয়ার্ক/ট্যাব বন্ধ) → গিয়ে থাকতেও পারে → **অ্যাডমিন না চাইলে আবার পাঠানো হয় না** |
| `skipped` | ইচ্ছাকৃতভাবে পাঠানো হয়নি (অবৈধ ইমেইল, তথ্য নেই, ইতিমধ্যে জমা দিয়েছেন…) — কারণসহ |

**যে ছয়টি নিয়ম কোডে বাঁধা:**
1. **আগে রেকর্ড, পরে ইমেইল।** ক্যাম্পেইন ও সব প্রাপক-সারি Firestore-এ না লেখা পর্যন্ত কোনো ইমেইল যায় না; লেখা ব্যর্থ হলে কিছুই পাঠানো হয় না।
2. **একটি একটি করে**, ≥ ১.১ সেকেন্ড ব্যবধানে (সর্বনিম্ন ১ সেকেন্ডের নিচে নামানো যায় না)। HTTP 429 → ২.৫ সেকেন্ড × বার অপেক্ষা করে সর্বোচ্চ ৩ বার চেষ্টা
   (রিকোয়েস্ট প্রত্যাখ্যাত হয়েছিল, তাই ডুপ্লিকেট হয় না)।
3. **Write-ahead:** প্রতি ২০ জনের ব্যাচ শুরুর আগে তাদের `sending` হিসেবে সেভ হয়; প্রতি ৫টি ফলাফল পরপর আসল ফল সেভ হয়। ট্যাব মরলে ব্যাচের অনিশ্চিত সারিগুলো
   `uncertain` হিসেবে পড়া যায় — **কখনো `pending` বা `accepted` ভান নয়।** Progress সেভ করা না গেলে রান থেমে যায় (রেকর্ডহীন ইমেইল যায় না)।
4. **Retry কখনো `accepted`-কে ছোঁয় না।** Retry ডায়ালগে Pending ও Failed আগে থেকে টিক; Uncertain টিকহীন (ডুপ্লিকেট সতর্কতাসহ)।
5. **একই কনফিগারেশনে ৩টি অভিন্ন ব্যর্থতা** (বা 401/403/451) পরপর → রান থামে — এটা কনফিগারেশনের সমস্যা, কোটা পুড়িয়ে লাভ নেই।
6. **ডাবল-ক্লিক সুরক্ষা:** Send-বাটন সঙ্গে সঙ্গে লক হয়, একসাথে একটিই রান চলে। একই বিষয় + একই বার্তা + একই প্রাপক-তালিকার ক্যাম্পেইন ২৪ ঘণ্টায় আবার পাঠাতে চাইলে
   আলাদা স্বীকৃতি লাগে; এইমাত্র পাঠানোটি একই ড্রাফট থেকে আবার পাঠানো যায় না।

**ট্যাব বন্ধ/নেটওয়ার্ক গেলে:** Campaign History-তে ক্যাম্পেইনটি (৪ মিনিট heartbeat না থাকলে) **Interrupted** দেখায়, in-flight সারিগুলো `uncertain` হয়, আর
Details → **Resume / retry…** দিয়ে বাকিটা পাঠানো যায়। পাঠানো ইমেইল **ফেরত আনা যায় না**।

> **পাঠানোর সময় ট্যাব সামনে ও স্ক্রিন চালু রাখুন।** ইমেইল আপনার ব্রাউজার থেকেই যায় (ব্যাকএন্ড নেই)। অন্য ট্যাবে গেলে বা ফোনের স্ক্রিন বন্ধ হলে ব্রাউজার টাইমার ধীর/স্থগিত করে দিতে পারে
> — রান তখন ধীর হবে বা থেমে থাকবে (ডুপ্লিকেট হবে না)। সিস্টেম সম্ভব হলে Screen Wake Lock চায়, কিন্তু তার ওপর নির্ভর করবেন না।

**টেস্ট ইমেইল:** শুধু আপনার টাইপ করা **একটি ঠিকানায়** যায় (কখনো শিক্ষার্থীকে নয়); ডিফল্টে নমুনা তথ্য ("Sample Student") — আসল শিক্ষার্থীর তথ্য দিয়ে টেস্ট
করতে সরাসরি টিক তুলতে হয় ও সতর্কতা দেখায়।

---

## ৬. Firestore মডেল, rules ও খরচ

| কালেকশন | কী থাকে | পড়া | লেখা |
|---|---|---|---|
| `emailSettings/main` | `serviceId, templateId, publicKey, senderName, replyTo, intervalMs, safetyCap, timeZone, testEmail, showLogo, logoUrl, lastTest{ok,at,fp,to,status,text}, updatedAt, updatedBy` — **কোনো প্রাইভেট কী নয়** | Super Admin, Manager | Super Admin; Manager শুধু `lastTest` |
| `emailTemplates/{id}` | `name, desc, type, lang, content{…}, createdBy/At, updatedBy/At` | Super, Manager | Super, Manager |
| `emailCampaigns/{id}` | সারাংশ: `name, type, lang, examId/Title, subject, content{…{{placeholders}}…}, audience{mode,groups,summary}, status, totals{…}, parts, runs, createdBy{uid,name,email}, createdAt, startedAt, finishedAt, heartbeatAt, lastRun, fingerprint, configFp, source` — **শিক্ষার্থীর ব্যক্তিগত তথ্য নয়**; ড্রাফটে `selectedUids` | Super, Manager | Super, Manager; মোছা: Super (বা ড্রাফট) |
| `emailCampaigns/{id}/parts/{n}` | প্রাপক-সারি (≤১৫০/ডকুমেন্ট): `uid, name, email, roll, status, tries, at, note` | Super, Manager | Super, Manager |

শিক্ষার্থী এর কোনোটাই পড়তে/লিখতে পারে না; Content Editor ও Viewer-ও না। `status` একটি নির্দিষ্ট তালিকার মান হতে হয়; ক্যাম্পেইনের `createdBy.uid` অবশ্যই লগইন-করা
অ্যাডমিন এবং পরে বদলানো যায় না।

**খরচ (আনুমানিক):**
- পেজ খুললে: শিক্ষার্থী ও এক্সাম তালিকা (বিদ্যমান ৫-মিনিটের ক্যাশ — Students পেজের সাথে ভাগ করা) + সেটিংস ১ + টেমপ্লেট + হিস্ট্রি ≤ ৮০। **ট্যাব বদলালে কোনো নতুন read নেই।**
- এক্সাম বাছলে: শুধু ওই এক্সামের `results` ও `examSessions` (ফিল্টার-করা কোয়েরি; ক্যাশ ৫ মিনিট)।
- পাঠানোয়: ≈ **০.৫ write প্রতি প্রাপক** (১০০ জন ≈ ৫০–৬০, ২০০০ জন ≈ ১০০০) — প্রতি প্রাপকে একটি ডকুমেন্ট নয়, ১৫০-জনের "part" ডকুমেন্টে।
- হিস্ট্রির বিস্তারিত খুললে: প্রতি ১৫০ প্রাপকে ১ read।

---

## ৭. পারমিশন ও অডিট লগ

| রোল | Email Center | EmailJS সেটিংস বদলানো |
|---|---|---|
| Super Admin | ✔ (লেখা, পাঠানো, টেমপ্লেট, হিস্ট্রি, মোছা) | ✔ |
| Manager | ✔ (মোছা ছাড়া; সেটিংস শুধু দেখা + টেস্ট) | ✘ |
| Content Editor / Viewer | ✘ (নেভিগেশনে নেই, সরাসরি URL-এ ডাশবোর্ডে ফেরত, rules-এও বন্ধ) | ✘ |

পারমিশন: `email.manage` (Super, Manager) ও `email.settings` (শুধু Super — `"*"` দিয়ে)। UI লুকানোই একমাত্র সুরক্ষা নয় — `firestore.rules`-এ `canManageComms()` ও `isSuperAdmin()`।

**অডিট (Activity Logs → Area: Email Center):** `email.settings` · `email.test` · `email.template.create/update/delete` · `email.campaign.draft` ·
`email.campaign.start` · `email.campaign.complete` · `email.campaign.interrupt` · `email.campaign.fail` · `email.campaign.retry` · `email.campaign.export` ·
`email.campaign.delete`। বিবরণে শুধু সংখ্যা/অবস্থা থাকে — **ইমেইলের বডি বা প্রাপকের ঠিকানা নয়**; সেটিংস লগে শুধু বদলানো ফিল্ডের **নাম**, মান নয়।

---

## ৮. নিরাপত্তা — কী সুরক্ষিত, আর কোথায় সীমা আছে

**ইমেইল-কন্টেন্ট:** অ্যাডমিনের লেখা সব টেক্সট আগে HTML-escape হয়, তারপর নিরাপদ মার্কআপ (`**bold**`, `_italic_`, `[লিংক](https://…)`, `- বুলেট`) রূপান্তর হয় — কাঁচা HTML বসানো যায় না।
`{{ভেরিয়েবল}}`-এর মান **পরে** ও সবসময় escape হয়ে বসে — তাই শিক্ষার্থী নিজের নামে `<img onerror=…>` বা `[click](https://evil)` লিখলেও তা শুধু লেখা হিসেবে ছাপে।
লিংক শুধু `http(s)://…` বা তিনটি বিশ্বস্ত টোকেন (`{{website_url}}`, `{{exam_url}}`, `mailto:{{support_email}}`); `javascript:`/`data:` লেখা হয়ে যায়।
Subject/নাম একলাইনে সমতল (CR/LF মুছে) — মেইল-হেডার ইনজেকশন সম্ভব নয়। CSV এক্সপোর্টে `= + - @`-দিয়ে-শুরু-হওয়া ঘরের আগে `'` বসে (ফর্মুলা ইনজেকশন)। প্রিভিউ `sandbox=""` iframe-এ
(কোনো স্ক্রিপ্ট চলে না)।

**গোপনীয়তা:** প্রতিটি ইমেইল তৈরি হয় শুধু ওই শিক্ষার্থীর ডেটা থেকে; পাঠানো প্যারামিটার একটি নির্দিষ্ট তালিকা (uid, পাসওয়ার্ড, টোকেন নেই)। ইউনিট টেস্ট দুই শিক্ষার্থীর ইমেইল
মিলিয়ে দেখে কারও তথ্য অন্যের ইমেইলে নেই।

**ক্রেডেনশিয়াল:** ব্রাউজারে শুধু **Public Key** ব্যবহার হয় (`emailjs.send(serviceID, templateID, params, { publicKey })`)। Private Key/accessToken, Firebase service-account বা
কোনো সিক্রেট কোডে নেই (ইউনিট টেস্ট সোর্স স্ক্যান করে নিশ্চিত করে)। Service ID/Template ID/Public Key সোর্স-কোডে নয়, **Firestore-এ** — শুধু Super Admin/Manager পড়তে পারেন।

**⚠ সৎ সীমাবদ্ধতা:** ব্রাউজার থেকে সরাসরি EmailJS ডাকার পদ্ধতিতে Public Key + Service ID + Template ID জানা যে কেউ (Allowed-domains সেট না থাকলে) EmailJS API-তে
অনুরোধ পাঠাতে পারে — আর এই টেমপ্লেটে "To Email" একটি ভেরিয়েবল (না হলে প্রতিজনকে পাঠানোই যেত না)। ক্লায়েন্ট-সাইড চেক কোনো সম্পূর্ণ নিরাপত্তা-সীমানা নয়। তাই:
(১) Account → Security-তে **Allowed domains** সেট করুন (প্ল্যানে থাকলে) ও non-browser কল বন্ধ রাখুন; (২) শুধু-এই-কাজের আলাদা Service/Template রাখুন, এই টেমপ্লেটে অন্য কিছু যোগ করবেন না;
(৩) EmailJS Dashboard-এ ব্যবহার (usage) মাঝে মাঝে দেখুন; সন্দেহ হলে Public Key বদলে Email Settings-এ নতুনটি দিন; (৪) সম্পূর্ণ সার্ভার-সাইড নিয়ন্ত্রণ চাইলে একটি Cloud Function
(কী সার্ভারে রেখে, শুধু যাচাই-করা অ্যাডমিনের অনুরোধে পাঠানো) লাগবে — বর্তমান আর্কিটেকচারে (ব্যাকএন্ড নেই) এটাই সবচেয়ে নিরাপদ সম্ভব রূপ।
এই প্রজেক্টে এখন কোনো Content-Security-Policy নেই। ভবিষ্যতে CSP যোগ করলে অন্তত `script-src https://cdn.jsdelivr.net` ও `connect-src https://api.emailjs.com` অনুমোদন করতে হবে, নইলে ইমেইল পাঠানো ব্লক হবে।
SDK jsDelivr থেকে **নির্দিষ্ট ভার্সনে** (`@emailjs/browser@4.4.1`, `js/email-service.js → SDK_URL`) লোড হয়; আরও কড়া করতে ফাইলটি নিজের সাইটে হোস্ট করে `SDK_URL` বদলাতে পারেন।

---

## ৯. পরীক্ষা

```bash
node --test tests/unit/*.test.mjs                  # ২৩৮টি (এর মধ্যে Email Center: ৭৪টি — tests/unit/email.test.mjs)
node --experimental-vm-modules --no-warnings tests/check-syntax.mjs
python3 tests/e2e/run_email.py --shots             # Email Center: ২৩৫টি চেক (Playwright + নকল Firestore + নকল EmailJS SDK — আসল ইমেইল কখনো যায় না)
python3 tests/e2e/run_email.py --only G,H,I        # কিছু সেকশন
python3 tests/e2e/run_admin.py                     # বিদ্যমান অ্যাডমিন সুট (৮৫টি) — অক্ষত
```

**ইউনিট** (`email.test.mjs`): ইমেইল-ঠিকানা/URL/হেডার-নিরাপত্তা · এক্সামের অবস্থা × ক্যাম্পেইন-টাইপ · শ্রেণিবিন্যাস (অন্য এক্সামের ফলাফল গণনা হয় না, start-tracking/ফলাফল না-পড়া) ·
ভেরিয়েবল-উৎস ও ম্যাপিং · দুই শিক্ষার্থীর ইমেইলে তথ্য-ফাঁস নেই · হিংস্র নাম/লিংক/সাবজেক্ট escape · সব বিল্ট-ইন টেমপ্লেট × ৩ ভাষা · EmailJS প্যারামিটার ও আকার · কনফিগ যাচাই ও টেস্ট-ফিঙ্গারপ্রিন্ট ·
ত্রুটি-শ্রেণিবিন্যাস (failed বনাম uncertain) · **কিউ** (একটি-একটি, ≥১ সেকেন্ড, 429 backoff, ব্রেকার, Stop, retry শুধু failed) · পারমিশন · rules-এর আকার · ক্রেডেনশিয়াল-স্ক্যান।

**E2E** (`run_email.py`): পারমিশন/নেভিগেশন · ওভারভিউ সংখ্যা · রিমাইন্ডার-শ্রেণিবিন্যাস (বন্ধ/আসন্ন/সময়সূচিহীন/বাতিল এক্সাম) · `examSessions`/`results` পড়া-না-যাওয়া · প্রাপক-ফিল্টার ও টিক ·
Compose-ভ্যালিডেশন, প্রিভিউ, একক-ঠিকানায় টেস্ট · আসল সেন্ড (প্রতি কলে একজন, নিজের তথ্য, ≥১ সেকেন্ড ব্যবধান, রেকর্ড, অডিট) · সেন্ডের আগে পুনর্যাচাই · failed→retry শুধু failed ·
uncertain · 429 · ব্রেকার · ডাবল-ক্লিক · **ট্যাব-মরা ও resume** · চেকপয়েন্ট · হিস্ট্রি/CSV/duplicate/delete · ড্রাফট · নোটিশ→ইমেইল · সেটিংস (মাস্ক, টেস্ট-ছাড়া-সেন্ড-বন্ধ) ·
৩৯০px ফোন · কীবোর্ড/লেবেল/ফোকাস · ট্যাব-বদলে শূন্য read · Firestore-সমস্যা।

**আসল অ্যাকাউন্টে ম্যানুয়াল QA (ডেপ্লয়ের পর):** (১) Email Settings-এ তিনটি মান বসিয়ে Save → Send test → নিজের ইনবক্সে ইমেইল এল কিনা; (২) একটি পরীক্ষামূলক এক্সামে ২–৩ জন শিক্ষার্থী
(নিজের অন্য ঠিকানার অ্যাকাউন্ট) নিয়ে "Exam not attempted" পাঠান → প্রতিজন শুধু নিজের তথ্য পেল, Reply-To সাপোর্ট ঠিকানা; (৩) ইমেইল Gmail-এর মোবাইল অ্যাপে খুলে লেআউট দেখুন; (৪) ফোনে Email Center খুলে
কোনো আড়াআড়ি স্ক্রল নেই; (৫) EmailJS Dashboard → Email History-তে একই সংখ্যক রিকোয়েস্ট।

---

## ১০. আপনাকে যা করতে হবে (কোড থেকে হয় না)

- [ ] `firestore.rules` Publish।
- [ ] EmailJS অ্যাকাউন্ট + সার্ভিস + টেমপ্লেট (উপরের ২য় অংশ) এবং তিনটি মান Email Settings-এ।
- [ ] সফল একটি টেস্ট ইমেইল (ইনবক্সে দেখে নিন)।
- [ ] `assets/email-logo.png` সহ সাইট ডেপ্লয় (নইলে হেডারে লোগোর বদলে সাইটের নাম লেখা দেখায়) — অথবা Email Settings-এ নিজের লোগোর PNG/JPG লিংক / লোগো বন্ধ।
- [ ] EmailJS Security: Allowed domains (প্ল্যানে থাকলে), non-browser কল বন্ধ।
- [ ] `js/footer-config.js`-এ `contact.website` যেন **এক্সাম সাইটেরই** ঠিকানা হয় (ইমেইলের বাটন/লিংক এখান থেকে বানানো হয়) এবং `contact.email` সাপোর্ট ইমেইল।
- [ ] প্ল্যানের মাসিক কোটা দেখে বড় ক্যাম্পেইনের আগে Safety cap ঠিক করুন।

---

## ১১. সমস্যা হলে

| লক্ষণ | সম্ভাব্য কারণ → করণীয় |
|---|---|
| "EmailJS কনফিগার করা নেই" / Send বন্ধ | Email Settings-এ তিনটি মান ও Save (Super Admin) → তারপর টেস্ট |
| "এখনো কোনো টেস্ট ইমেইল সফল হয়নি" | কনফিগ বদলালে আগের টেস্ট বাতিল — আবার Send test |
| টেস্টে HTTP 400 "…Public Key is invalid" / "service ID not found" / "template ID not found" | মান ভুল কপি হয়েছে (ফাঁকা জায়গা?) — Dashboard থেকে আবার কপি |
| HTTP 401/403/451 | Allowed domains-এ আপনার সাইট নেই / non-browser কল / headless-ব্লক — Account → Security দেখুন। রান নিজে থেকে থামে |
| ব্যর্থ, "recipient…" ধরনের বার্তা | টেমপ্লেটের To Email ঘরে `{{to_email}}` বসেনি |
| ইমেইল এল, কিন্তু কাঁচা `<table …>` কোড দেখা যাচ্ছে | Content-এ `{{html_body}}` (দুই `{`) আছে — তিনটি `{{{html_body}}}` করুন |
| সংযুক্ত সার্ভিসের (Gmail ইত্যাদি) অনুমতির ত্রুটি | EmailJS-এ সার্ভিসটি আবার সংযুক্ত (reconnect) করুন; EmailJS-এর বার্তা Details-এ দেখায় |
| HTTP 429 | EmailJS ধীর হতে বলছে — সিস্টেম নিজে অপেক্ষা করে; গ্যাপ বাড়াতে চাইলে Email Settings → Gap |
| পাঠানো খুব ধীর বা থেমে আছে | ট্যাব ব্যাকগ্রাউন্ডে গেছে / ফোনের স্ক্রিন বন্ধ — ট্যাব সামনে এনে স্ক্রিন চালু রাখুন; থেমে গেলে Campaign History → Resume |
| Uncertain অনেক | নেটওয়ার্ক/টাইমআউট — আগে EmailJS Dashboard → Email History দেখুন, তারপর দরকার হলে Resume-এ Uncertain টিক |
| ইমেইল স্প্যামে যাচ্ছে | প্রোভাইডার/প্রেরক-ঠিকানার সুনাম; বিষয়/বার্তা সংক্ষিপ্ত রাখুন; সাপোর্ট ঠিকানা থেকে একবার উত্তর দিন; আলাদা ডোমেইন-ইমেইল সার্ভিস ভাবুন |
| "ফলাফল পড়া যায়নি" | `results` পড়ার অনুমতি/নেটওয়ার্ক — রিমাইন্ডার আটকে থাকে (ইচ্ছাকৃত) |
| "Start tracking পড়া যায়নি" | `examSessions` rules Publish করা নেই — "No result (start unverified)" দেখায়, "Started, not submitted" বন্ধ |
| লোগো দেখায় না | `assets/email-logo.png` ডেপ্লয় হয়নি / ইমেইল ক্লায়েন্ট ছবি ব্লক করেছে — alt-টেক্সট নাম দেখায়; Settings-এ লোগো বন্ধও করা যায় |
| তারিখ/সময় ভুল জোনে | Email Settings → Time zone (ডিফল্ট Asia/Dhaka) |

---

## ১২. ফাইল তালিকা

**নতুন:** `js/email-core.js` (বিশুদ্ধ লজিক) · `js/email-render.js` (মার্কআপ → HTML/টেক্সট, প্যারামিটার) · `js/email-templates-data.js` (৮টি টেমপ্লেট, ইংরেজি+বাংলা) ·
`js/email-service.js` (**EmailJS ইন্টিগ্রেশন**: SDK লোড, ত্রুটি-শ্রেণিবিন্যাস, কিউ) · `js/admin/email-center.js` (পেজ-শেল) · `js/admin/email/` (`state, model, store, send, editor, bits, view-overview, view-compose,
view-reminders, view-recipients, view-templates, view-history, view-settings`) · `css/admin-email-center.css` · `assets/email-logo.png` · `docs/EMAIL-CENTER.md` ·
`tests/unit/email.test.mjs` · `tests/e2e/run_email.py`, `email_helpers.py`।

**বদলানো (ছোট, বিদ্যমান আচরণ অক্ষত):** `admin.html` (সাইডবার-ভুক্তি আছে `js/admin/admin.js`-এ; এখানে CSS লিংক) · `js/admin/admin.js` (নেভ আইটেম) · `js/admin/core/permissions.js` (`email.manage`, `email.settings`, Manager-বর্ণনা) ·
`js/admin/core/audit.js` (অডিট-অ্যাকশন) · `js/admin/logs.js` ("Email Center" ফিল্টার) · `js/admin/admins.js` (রোল-লেবেল) · `js/admin/notices.js` ("Prepare email" অ্যাকশন — ড্রাফটই বানায়, পাঠায় না) · `firestore.rules` (নতুন অংশ) ·
`tests/e2e/mock/firebase-firestore.js` (শুধু যোগ: ব্যাচ-ব্যর্থতা `M.failBatch`, `doc()` রেফারেন্সে `id`) · `README.md`।
