// Unit tests for js/auth-reset-core.js (the pure side of "Forgot password?"). Run:  node --test tests/unit
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../../js/auth-reset-core.js";

test("normalizeEmail: trims, lower-cases, strips invisible characters and <angle brackets>", () => {
  assert.equal(R.normalizeEmail("  Rahim@Gmail.COM \n"), "rahim@gmail.com");
  assert.equal(R.normalizeEmail("ra\u200Bhim@gmail.com\u00A0"), "rahim@gmail.com");
  assert.equal(R.normalizeEmail("<rahim@gmail.com>"), "rahim@gmail.com");
  assert.equal(R.normalizeEmail(null), "");
  assert.equal(R.normalizeEmail(undefined), "");
});

test("validateResetEmail: accepts real addresses, explains the rest in Bengali", () => {
  for (const good of ["a@b.co", "rahim.uddin+exam@gmail.com", "x_y-z@mail.example.com.bd", "  STU@Example.com "]) {
    assert.equal(R.validateResetEmail(good).ok, true, good);
  }
  for (const bad of ["", "   ", "rahim", "rahim@", "@gmail.com", "rahim@gmail", "rahim@gmail.", "ra him@gmail.com", "a@b@c.com", "a,b@c.com", "a@b.c"]) {
    const v = R.validateResetEmail(bad);
    assert.equal(v.ok, false, `"${bad}"`);
    assert.ok(v.error.length > 5);
  }
  assert.equal(R.validateResetEmail("").error, "ইমেইল ঠিকানা লিখুন।");
  assert.equal(R.validateResetEmail("x".repeat(260) + "@gmail.com").ok, false);
});

test("validateResetEmail returns the cleaned address", () => {
  assert.equal(R.validateResetEmail("  Stu@Example.COM ").email, "stu@example.com");
});

test("suggestEmailFix catches the usual phone-keyboard slips and leaves good domains alone", () => {
  assert.equal(R.suggestEmailFix("rahim@gmial.com"), "rahim@gmail.com");
  assert.equal(R.suggestEmailFix("Rahim@Gmail.Con"), "rahim@gmail.com");
  assert.equal(R.suggestEmailFix("a@yaho.com"), "a@yahoo.com");
  assert.equal(R.suggestEmailFix("a@hotmial.com"), "a@hotmail.com");
  assert.equal(R.suggestEmailFix("a@gmail.com"), "");
  assert.equal(R.suggestEmailFix("a@school.edu.bd"), "");
  assert.equal(R.suggestEmailFix("nonsense"), "");
  assert.equal(R.suggestEmailFix(""), "");
  assert.equal(R.validateResetEmail("rahim@gmial.com").suggestion, "rahim@gmail.com");
  assert.equal(R.validateResetEmail("rahim@gmail.com").suggestion, "");
});

test("resetOutcome: success and 'no such user' are indistinguishable (no account probing)", () => {
  assert.deepEqual(R.resetOutcome(""), R.resetOutcome("auth/user-not-found"));
  assert.equal(R.resetOutcome("").kind, "sent");
  assert.equal(R.resetOutcome(undefined).kind, "sent");
  assert.equal(R.resetOutcome("").cooldownMs, R.RESET_COOLDOWN_MS);
});

test("resetOutcome: every known failure has its own Bengali message; unknown codes get the generic one", () => {
  const codes = ["auth/invalid-email", "auth/too-many-requests", "auth/network-request-failed", "auth/operation-not-allowed", "auth/user-disabled", "auth/something-new"];
  const messages = codes.map((c) => R.resetOutcome(c));
  messages.forEach((m) => { assert.equal(m.kind, "error"); assert.ok(/[\u0980-\u09FF]/.test(m.message), "Bengali text"); });
  assert.equal(new Set(messages.map((m) => m.message)).size, codes.length, "all different");
  assert.equal(R.resetOutcome("auth/too-many-requests").cooldownMs, R.RESET_FLOOD_COOLDOWN_MS);
  assert.equal(R.resetOutcome("auth/network-request-failed").cooldownMs, 0, "a dead connection never locks the button");
  assert.equal(R.resetOutcome("auth/invalid-email").cooldownMs, 0);
  assert.equal(R.resetOutcome("auth/missing-email").message, R.resetOutcome("auth/invalid-email").message);
});

test("isContinueUrlProblem: only the three continue-URL codes", () => {
  for (const c of ["auth/unauthorized-continue-uri", "auth/invalid-continue-uri", "auth/missing-continue-uri"]) assert.equal(R.isContinueUrlProblem(c), true, c);
  for (const c of ["auth/invalid-email", "", undefined, null]) assert.equal(R.isContinueUrlProblem(c), false, String(c));
});

test("buildContinueUrl: this site's login screen, but never for file:// or an opaque origin", () => {
  assert.equal(R.buildContinueUrl({ protocol: "https:", origin: "https://tvexam.vercel.app", pathname: "/" }), "https://tvexam.vercel.app/#/login");
  assert.equal(R.buildContinueUrl({ protocol: "http:", origin: "http://127.0.0.1:8765", pathname: "/index.html" }), "http://127.0.0.1:8765/index.html#/login");
  assert.equal(R.buildContinueUrl({ protocol: "file:", origin: "null", pathname: "/x/index.html" }), "");
  assert.equal(R.buildContinueUrl({ protocol: "https:", origin: "null", pathname: "/" }), "");
  assert.equal(R.buildContinueUrl({}), "");
  assert.equal(R.buildContinueUrl(), "");
});

test("cooldown: per address, expires, and a far-future record is not trusted", () => {
  const T = 1_000_000;
  const rec = R.cooldownRecord(" Stu@Example.com ", T, R.RESET_COOLDOWN_MS);
  assert.equal(rec.email, "stu@example.com");
  assert.equal(R.cooldownLeft(rec, "stu@example.com", T), 60000);
  assert.equal(R.cooldownLeft(rec, "STU@example.com", T + 15000), 45000);
  assert.equal(R.cooldownLeft(rec, "stu@example.com", T + 60000), 0);
  assert.equal(R.cooldownLeft(rec, "other@example.com", T), 0, "another address is not held back");
  assert.equal(R.cooldownLeft(null, "stu@example.com", T), 0);
  assert.equal(R.cooldownLeft({ email: "stu@example.com", until: "x" }, "stu@example.com", T), 0);
  const faked = R.cooldownRecord("stu@example.com", T, 9e9);
  assert.equal(R.cooldownLeft(faked, "stu@example.com", T), 0);
  assert.equal(R.cooldownRecord("a@b.co", T, -5).until, T);
  assert.equal(R.cooldownRecord("a@b.co", T, 5).kind, "sent");
  assert.equal(R.cooldownRecord("a@b.co", T, 5, "flood").kind, "flood");
  assert.equal(R.cooldownRecord("a@b.co", T, 5, "whatever").kind, "sent");
});

test("waitLabel", () => {
  assert.equal(R.waitLabel(45000), "0:45");
  assert.equal(R.waitLabel(45001), "0:46");
  assert.equal(R.waitLabel(125000), "2:05");
  assert.equal(R.waitLabel(0), "0:00");
  assert.equal(R.waitLabel(-3), "0:00");
  assert.equal(R.waitLabel("x"), "0:00");
});
