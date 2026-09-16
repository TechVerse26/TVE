# Tech Verse Exam

TVcourse-এর মতো একই Firebase প্রজেক্ট (`tv-course`) ব্যবহার করে চলা একটা আলাদা,
স্ট্যান্ডএলোন exam ওয়েবসাইট। একদম নতুন Firebase project লাগেনি, এবং
**Firestore rules-এ কোনো পরিবর্তন লাগেনি** — TVcourse-এর existing rules
(`users`, `courses`, `exams`, `results`) exam সাইটের সব read/write ইতিমধ্যেই
কভার করে।

## কীভাবে কাজ করে

- **অ্যাকাউন্ট**: TVcourse-এর একই Firebase Auth + `users/{uid}` ডকুমেন্ট।
  একই ইমেইল/পাসওয়ার্ড বা Google অ্যাকাউন্ট দিয়ে দুই সাইটেই লগইন করা যায়।
- **এনরোলমেন্ট চেক**: `exams/{id}.courseId` সেট করা থাকলে, শুধু
  `users/{uid}.enrolledCourses` অ্যারেতে সেই `courseId` থাকা ইউজারদের কাছেই
  এক্সামটা দেখা যাবে — বাকি সবার কাছে সেটা সম্পূর্ণ অদৃশ্য (লক দেখানো হয় না,
  একদমই তালিকায় থাকে না)। `courseId` খালি রাখলে এক্সামটা সবার জন্য খোলা।
- **এক্সাম নেওয়া**: verification checklist → নিয়মাবলী কনফার্ম → টাইমার সহ
  অ্যাটেম্পট → ফলাফল + রিভিউ + PDF/প্রিন্ট।
- **অ্যাডমিন প্যানেল** (`admin.html`): Overview, Exams (তৈরি/এডিট/বাল্ক ইমপোর্ট/
  scheduling/negative marking/random pool — তোমার আগের admin/exams.js প্রায়
  হুবহু), Results (সব অ্যাটেম্পট, ফিল্টার, CSV export), Students (এনরোলমেন্ট +
  অ্যাটেম্পট ওভারভিউ — এনরোলমেন্ট এডিট এখনো মূল কোর্স সাইট থেকেই হবে)।

## ডিপ্লয় করার আগে

`js/firebase-config.js`-এ TVcourse-এর মতোই `tv-course` প্রজেক্টের config
বসানো আছে (তোমার আপলোড করা কোড থেকে কপি করা) — যদি এটা আলাদা কোনো Firebase
প্রজেক্টে ডিপ্লয় করতে চাও, শুধু এই ফাইলটা বদলে দিলেই হবে। একই প্রজেক্টে ডিপ্লয়
করলে (ভিন্ন ডোমেইনে/Hosting site-এ) কিছুই বদলানোর দরকার নেই।

Firebase Hosting-এ একটা নতুন site হিসেবে ডিপ্লয় করলে (যেমন
`exam.techversecourse.com`):

```
firebase target:apply hosting tvexam <new-site-id>
firebase deploy --only hosting:tvexam
```

## রোল নম্বর (সিরিয়াল, রিড-ওনলি)

প্রোফাইল পেজের "সিঙ্ক করুন" বাটনে ক্লিক করলে প্রতিটা স্টুডেন্ট একটা সিরিয়াল
রোল নম্বর (0001, 0002, 0003, ...) পায় — `counters/students` নামের একটা
Firestore ডকুমেন্টের `next` ফিল্ড থেকে, একটা atomic transaction দিয়ে (দেখো
`js/roll.js`)। এতে দুইজন স্টুডেন্ট একই সাথে সিঙ্ক করলেও কখনো একই রোল পাবে
না। রোল একবার সিঙ্ক হয়ে গেলে প্রোফাইল ফর্মে সেটা ইমেইলের মতোই শুধু দেখা
যায় — এডিট করার কোনো উপায় নেই। অ্যাডমিন প্যানেলের Students ট্যাব থেকে রোল
অনুযায়ী সার্চ/সর্ট করা যায়, এখনো সিঙ্ক না করা স্টুডেন্টদের জন্য admin নিজে
রোল জেনারেট করে দিতে পারে, আর যেকোনো স্টুডেন্টের রোল ম্যানুয়ালি বদলেও দিতে
পারে (পেন্সিল আইকন — ইউনিকনেস চেক করেই সেভ হয়)।

**Firestore rules-এ একটা ছোট সংযোজন লাগবে** — `counters/students`
কালেকশনটা নতুন, তাই `users`/`courses`/`exams`/`results`-এর existing rules
এটা কভার করে না। এই rules যোগ করে দাও:

```
match /counters/{counterId} {
  allow read: if request.auth != null;
  // যেকোনো লগইন করা ইউজার নিজের সিঙ্ক ট্রিগার করতে পারবে বলে write খোলা —
  // চাইলে আরও কড়া করে শুধু increment-by-1 patternটা validate করে নিতে পারো
  allow write: if request.auth != null;
}
```

এবং `users/{uid}` এর update rule-এ, যদি স্টুডেন্টের সরাসরি নিজের ডকুমেন্ট
এডিট করার অনুমতি থাকে, `roll` ফিল্ডটা বাদ দিয়ে (immutable) রাখাই ভালো —
UI থেকে তো এমনিতেই এডিট করা যায় না, কিন্তু rules লেভেলেও আটকে দিলে সেটা
পুরোপুরি নিরাপদ হয়:

```
allow update: if request.auth != null && request.auth.uid == uid
  && request.resource.data.roll == resource.data.roll; // roll অপরিবর্তিত থাকবে
```

## প্রথম অ্যাডমিন বানানো

TVcourse-এ যেভাবে করো, একইভাবে Firebase Console থেকে গিয়ে নিজের
`users/{uid}` ডকুমেন্টে `isAdmin: true` সেট করে দাও — তাহলে exam সাইটের
`admin.html`-এও অ্যাক্সেস পেয়ে যাবে (যেহেতু একই ডকুমেন্ট)।

## Bulk question import ফরম্যাট

```
প্রশ্নের টেক্সট এখানে?
*সঠিক অপশন (তারকা চিহ্ন দিয়ে শুরু)
ভুল অপশন ১
ভুল অপশন ২
ভুল অপশন ৩
Explanation: ঐচ্ছিক ব্যাখ্যা এখানে
```
প্রতিটা প্রশ্নের মাঝে একটা খালি লাইন দিতে হবে।
