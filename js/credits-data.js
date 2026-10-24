// ==========================================================================
// credits-data.js — everything on the Credits page (#/credits). Edit THIS file; the layout lives in page-credits.js.
//
// WHO IS LISTED
//   Nobody is credited by guesswork. The project holds no confirmed team information (no names, roles, photos or profile
//   links), so `members` ships with three PLACEHOLDER cards: dashed, marked "To be confirmed", with an icon where the photo
//   will go. They stand for people to be added — they are not real people.
//
// TO ADD A PERSON  — fill in one entry of `members` (a card with a `name` becomes a real card; one without stays a placeholder):
//
//   {
//     name:  "Full name",                                  // required
//     role:  "What they do for Tech Verse Exam",           // their real role or contribution
//     bio:   "One or two sentences about them.",           // optional — keep it short (max about 600 characters)
//     photo: "assets/team/full-name.jpg",                  // optional — a file inside assets/ (drop the picture there) or an https address.
//                                                          //   Without a photo, or if it cannot load, the person's initials are drawn instead.
//     links: [                                             // optional — only profiles the person has agreed to share
//       { type: "linkedin", url: "https://www.linkedin.com/in/…" },
//       { type: "github",   url: "https://github.com/…" },
//       { type: "website",  url: "https://…" },
//       { type: "email",    url: "name@example.com" },
//     ],                                                   // types: website · linkedin · github · facebook · youtube · telegram · email
//   },
//
// TO REORDER, move an entry up or down. TO REMOVE a person, delete the entry (a placeholder disappears the same way).
// A photo or link that is not valid (wrong kind of address, wrong website for its type) is left out rather than shown broken,
// and the browser console says why. `node --test tests/unit/info.test.mjs` fails on the same mistakes.
//
// Never add a person, a role, a photo or a link that you have not confirmed with that person.
//
// Text may use  **bold**  ·  [label](#/route)  ·  {email}  (see info-core.js).
// ==========================================================================
export const CREDITS = {
  hero: {
    kicker: "Credits",
    title: "The people behind Tech Verse Exam",
    lead: "A thank-you to the people and the tools behind the platform.",
  },

  intro: {
    title: "Who makes Tech Verse Exam",
    paragraphs: [
      "Tech Verse Exam is made and looked after by the Tech Verse team. This page names the people who contribute to it, what each of them does and, where they have chosen to share it, where to find them online.",
      "A person is listed only once their name, role and links have been confirmed with them. Until then a card is shown as a placeholder, so that nobody is credited by guesswork.",
    ],
  },

  team: {
    title: "Our Team",
    sub: "Each card shows a name, a role and, when the person has shared them, a short biography and links.",
    // Shown above the cards for as long as at least one card is still a placeholder (it disappears by itself afterwards).
    placeholderNote: "**Team details are still being confirmed.** The dashed cards are placeholders, not real people. Names, roles and photos will appear here once each person has confirmed them.",
    // What a placeholder card says. Not people, not facts.
    placeholder: {
      name: "Team member name",
      role: "Role or contribution",
      bio: "A short biography will appear here once this person’s details are confirmed.",
      badge: "member details",
    },
    members: [
      { name: "Imran Ahmed", 
       role: "CEO & Founder", 
       bio: "Building technology-driven solutions for smarter learning, digital growth & future opportunities.Focused on innovation, leadership, and creating meaningful digital experiences.", 
       photo: "https://tvgallery.vercel.app/TVExam/Credits_member/imran_ahmed_ceo_&_founder_manager_and_director.webp", 
       links: [
         { type: "website",  url: "https://myprojectinfo.vercel.app/" },
         { type: "github",  url: "https://github.com/Imran-s-Project" },
       ] 
      },   // placeholder — replace with a real person (see the top of this file)
      { name: "", role: "", bio: "", photo: "", links: [] },   // placeholder
      { name: "", role: "", bio: "", photo: "", links: [] },   // placeholder
    ],
  },

  // The third-party tools the site really uses (checked against index.html, css/base.css and js/firebase-config.js).
  // Plain text on purpose: no logos, no links, nothing promotional.
  acknowledgements: {
    title: "Tools and services",
    sub: "Tech Verse Exam is built on the work of others. These are the outside tools the site actually uses.",
    items: [
      { name: "Firebase", text: "Google’s Firebase provides sign-in (Authentication) and the database (Cloud Firestore) that hold accounts, exams and results." },
      { name: "Font Awesome Free", text: "The icons used across the site. Font Awesome Free icons are licensed under CC BY 4.0." },
      { name: "Google Fonts", text: "The Inter, Hind Siliguri and Noto Sans Bengali typefaces. All three are open-source fonts under the SIL Open Font License." },
    ],
  },

  closing: {
    title: "Thank you",
    text: "To every student who sits an exam here, and to everyone who reports a problem so that it can be put right — thank you. If something on this page is wrong, or you would like your own entry corrected or removed, please write to {email}.",
  },
};
