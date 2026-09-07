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
