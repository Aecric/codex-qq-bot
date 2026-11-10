import assert from "node:assert/strict";
import test from "node:test";
import { QQ_PENDING_IMAGE_REQUEST_TTL_MS, createQqPendingImageRequests } from "../src/qq-pending-image-request.js";

function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an approved request is consumed by the first picture from the same sender", async () => {
  const clock = createClock();
  const requests = createQqPendingImageRequests({ now: clock.now });
  const request = requests.open("100", { senderId: "u1", messageId: "m1", text: "帮我看看这张图" });
  request.settle(true);

  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "帮我看看这张图");
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "", "a request answers one picture");
  assert.equal(requests.size, 0);
});

test("a declined request never matches", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  const request = requests.open("100", { senderId: "u1", text: "看看" });
  request.settle(false);
  assert.equal(requests.size, 0);
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "");
});

test("only the original sender can answer the request, and it stays open for them", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  requests.open("100", { senderId: "u1", text: "看图" }).settle(true);

  assert.equal(await requests.match("100", { senderId: "u2", hasImages: true }), "");
  assert.equal(requests.size, 1, "another sender does not consume the request");
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "看图");
});

test("a request without a sender can be answered by anyone in the group", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  requests.open("100", { text: "看图" }).settle(true);
  assert.equal(await requests.match("100", { senderId: "u9", hasImages: true }), "看图");
});

test("messages without pictures, in other groups or without a group do not match", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  requests.open("100", { senderId: "u1", text: "看图" }).settle(true);

  assert.equal(await requests.match("100", { senderId: "u1", hasImages: false }), "");
  assert.equal(await requests.match("100", { senderId: "u1" }), "");
  assert.equal(await requests.match("200", { senderId: "u1", hasImages: true }), "");
  assert.equal(await requests.match("", { senderId: "u1", hasImages: true }), "");
  assert.equal(await requests.match(undefined, { senderId: "u1", hasImages: true }), "");
  assert.equal(requests.size, 1, "none of those consumed the request");
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "看图");
});

test("open ignores a missing group id and defaults the request text", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  assert.equal(requests.open("", { senderId: "u1" }), null);
  assert.equal(requests.open(undefined), null);
  assert.equal(requests.size, 0);

  requests.open(100, { senderId: 7 }).settle(true);
  assert.equal(await requests.match("100", { senderId: "7", hasImages: true }), "看图", "ids are compared as strings");
});

test("a picture that arrives before the routing decision waits for it", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  const approved = requests.open("100", { senderId: "u1", text: "看看" });
  let result = null;
  const pending = requests.match("100", { senderId: "u1", hasImages: true }).then((value) => {
    result = value;
    return value;
  });
  await flush();
  assert.equal(result, null, "still waiting for the decision");
  approved.settle(true);
  assert.equal(await pending, "看看");
  assert.equal(requests.size, 0);

  const declined = requests.open("200", { senderId: "u1", text: "看看" });
  const waiting = requests.match("200", { senderId: "u1", hasImages: true });
  await flush();
  declined.settle(false);
  assert.equal(await waiting, "");
  assert.equal(requests.size, 0);
});

test("a picture stops waiting after maxWaitMs when the decision is still open", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  const request = requests.open("100", { senderId: "u1", text: "看看" });
  const startedAt = Date.now();
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true, maxWaitMs: 20 }), "");
  assert.ok(Date.now() - startedAt >= 15, "it waited for the window");
  request.settle(false);
  assert.equal(requests.size, 0);
});

test("a wrong sender does not wait for or disturb an undecided request", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  const request = requests.open("100", { senderId: "u1", text: "看看" });
  const startedAt = Date.now();
  assert.equal(await requests.match("100", { senderId: "u2", hasImages: true, maxWaitMs: 5_000 }), "");
  assert.ok(Date.now() - startedAt < 1_000, "returns immediately for the wrong sender");
  request.settle(true);
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "看看");
});

test("a request expires after the ttl, measured from approval", async () => {
  const clock = createClock();
  const requests = createQqPendingImageRequests({ ttlMs: 1_000, now: clock.now });
  const request = requests.open("100", { senderId: "u1", text: "看看" });
  clock.advance(600);
  request.settle(true);
  clock.advance(1_000);
  assert.equal(requests.size, 1, "exactly ttlMs after approval is still valid");
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "看看");

  const late = requests.open("200", { senderId: "u1", text: "看看" });
  late.settle(true);
  clock.advance(1_001);
  assert.equal(await requests.match("200", { senderId: "u1", hasImages: true }), "");
  assert.equal(requests.size, 0);
});

test("an undecided request also expires", async () => {
  const clock = createClock();
  const requests = createQqPendingImageRequests({ ttlMs: 1_000, now: clock.now });
  requests.open("100", { senderId: "u1", text: "看看" });
  clock.advance(1_001);
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true, maxWaitMs: 5_000 }), "");
  assert.equal(requests.size, 0);
});

test("the default ttl is one minute", async () => {
  assert.equal(QQ_PENDING_IMAGE_REQUEST_TTL_MS, 60_000);
  const clock = createClock();
  const requests = createQqPendingImageRequests({ now: clock.now });
  requests.open("100", { senderId: "u1", text: "看看" }).settle(true);
  clock.advance(59_000);
  assert.equal(requests.size, 1);
  clock.advance(2_000);
  assert.equal(requests.size, 0);
});

test("settling is final and a newer request in the group replaces the older one", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  const first = requests.open("100", { senderId: "u1", text: "第一个" });
  first.settle(true);
  first.settle(false);
  assert.equal(requests.size, 1, "a second settle call changes nothing");

  const older = requests.open("200", { senderId: "u1", text: "旧请求" });
  const newer = requests.open("200", { senderId: "u1", text: "新请求" });
  older.settle(false);
  assert.equal(requests.size, 2, "settling the replaced request does not remove the new one");
  newer.settle(true);
  assert.equal(await requests.match("200", { senderId: "u1", hasImages: true }), "新请求");
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "第一个");
});

test("clear removes one group or every group, even while a picture is waiting", async () => {
  const requests = createQqPendingImageRequests({ now: createClock().now });
  requests.open("100", { senderId: "u1", text: "a" }).settle(true);
  requests.open("200", { senderId: "u1", text: "b" }).settle(true);
  requests.open("300", { senderId: "u1", text: "c" }).settle(true);
  assert.equal(requests.size, 3);

  requests.clear("100");
  assert.equal(requests.size, 2);
  assert.equal(await requests.match("100", { senderId: "u1", hasImages: true }), "");
  requests.clear(200);
  assert.equal(requests.size, 1);
  requests.clear();
  assert.equal(requests.size, 0);
  assert.equal(await requests.match("300", { senderId: "u1", hasImages: true }), "");

  const request = requests.open("400", { senderId: "u1", text: "d" });
  const waiting = requests.match("400", { senderId: "u1", hasImages: true });
  await flush();
  requests.clear("400");
  request.settle(true);
  assert.equal(await waiting, "", "a cleared request cannot be matched after it settles");
});
