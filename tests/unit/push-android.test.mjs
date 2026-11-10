// The native Android app registers FCM tokens with platform "android". buildMessage must add an Android block for them
// (so the system tray shows the notification while the app is closed) WITHOUT changing what web-push devices receive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMessage } = require("../../server/push/engine.js");

const ctx = { cfg: { ttlSeconds: 86400 } };
const job = (o = {}) => ({ id: "job_0123456789abcdef", title: "Physics exam", body: "Starts at 8 PM", url: "#/exam?id=abc", category: "exam", createdAt: 1700000000000, ...o });

test("web-push part of the message is unchanged (data-only + webpush headers)", () => {
  const m = buildMessage(ctx, job(), ["t1", "t2"]);
  assert.deepEqual(m.tokens, ["t1", "t2"]);
  assert.equal(m.notification, undefined, "a top-level notification would make web devices show every message twice");
  assert.deepEqual(Object.keys(m.data).sort(), ["body", "cat", "nid", "tag", "title", "ts", "url"]);
  assert.equal(m.webpush.headers.TTL, "86400");
  assert.equal(m.webpush.headers.Urgency, "high");
  assert.match(m.webpush.headers.Topic, /^[A-Za-z0-9_-]{22}$/);
});

test("Android block carries the visible notification, priority and lifetime", () => {
  const m = buildMessage(ctx, job(), ["t"]);
  assert.equal(m.android.priority, "high");
  assert.equal(m.android.ttl, 86400 * 1000);
  assert.deepEqual(m.android.notification, { title: "Physics exam", body: "Starts at 8 PM", tag: m.data.tag, channelId: "tvexam_default" });
  assert.equal(buildMessage(ctx, job({ category: "announcement" }), ["t"]).android.priority, "normal");
});

test("an image reaches Android as imageUrl, and a missing TTL config never produces an invalid message", () => {
  const withImage = buildMessage(ctx, job({ image: "https://example.com/a.png" }), ["t"]);
  assert.equal(withImage.android.notification.imageUrl, "https://example.com/a.png");
  assert.equal(withImage.data.image, "https://example.com/a.png");
  const noTtl = buildMessage({ cfg: {} }, job(), ["t"]);
  assert.equal("ttl" in noTtl.android, false);
});
