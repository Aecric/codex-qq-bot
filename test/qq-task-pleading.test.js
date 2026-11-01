import assert from "node:assert/strict";
import test from "node:test";
import { createQqTaskPleadingTracker, formatQqTaskPleadingContext, formatQqTaskRecord } from "../src/qq-task-pleading.js";

const tracker = (roll, extra = {}) => createQqTaskPleadingTracker({ required: 3, windowMs: 1000, now: () => 0, random: () => roll, ...extra });

test("a good-mood roll does the task on the first ask", () => {
  const result = tracker(0.1).note("g:1");
  assert.equal(result.allowed, true);
  assert.equal(result.mood, "good_mood");
  assert.match(formatQqTaskPleadingContext(result), /心情好/);
});

test("a soft roll gives in on the second ask", () => {
  const pleading = tracker(0.3);
  assert.equal(pleading.note("g:1").allowed, false);
  const second = pleading.note("g:1");
  assert.equal(second.allowed, true);
  assert.equal(second.mood, "softened");
});

test("the usual roll needs three sincere asks, then a new round starts", () => {
  const pleading = tracker(0.9);
  assert.equal(pleading.note("g:1").allowed, false);
  assert.equal(pleading.note("g:1").allowed, false);
  const third = pleading.note("g:1");
  assert.deepEqual([third.allowed, third.mood, third.count], [true, "sincere", 3]);
  assert.match(formatQqTaskPleadingContext(third), /诚恳/);
  assert.equal(pleading.note("g:1").count, 1);
});

test("asks spread past the window start a new round", () => {
  let clock = 0;
  const pleading = createQqTaskPleadingTracker({ required: 3, windowMs: 1000, now: () => clock, random: () => 0.9 });
  pleading.note("g:1");
  clock = 5000;
  assert.equal(pleading.note("g:1").count, 1);
});

test("a refusal turn forbids doing the task and hides the remaining count", () => {
  const refusal = formatQqTaskPleadingContext({ count: 1, required: 3, needed: 3, allowed: false, mood: "refuse" });
  assert.match(refusal, /不执行任务/);
  assert.match(refusal, /不要透露还要求几次/);
});

test("a requirement of one or less never refuses", () => {
  const pleading = createQqTaskPleadingTracker({ required: 1 });
  assert.equal(pleading.note("g:1").allowed, true);
  assert.equal(formatQqTaskPleadingContext(pleading.note("g:1")), "");
});

test("a task record keeps one short line of request and result", () => {
  const record = formatQqTaskRecord("帮我写个斐波那契函数", `好吧好吧\n\`\`\`js\n${"x".repeat(300)}\n\`\`\``);
  assert.match(record, /^【任务记录】请求：帮我写个斐波那契函数；已交付：好吧好吧/);
  assert.ok(record.length < 220);
});

test("a refused round stays pending until it is granted or expires", () => {
  let clock = 0;
  const pleading = createQqTaskPleadingTracker({ required: 3, windowMs: 1000, now: () => clock, random: () => 0.9 });
  assert.equal(pleading.pending("g:1"), false);
  pleading.note("g:1");
  assert.equal(pleading.pending("g:1"), true);
  pleading.note("g:1");
  pleading.note("g:1");
  assert.equal(pleading.pending("g:1"), false);
  pleading.note("g:1");
  clock = 5000;
  assert.equal(pleading.pending("g:1"), false);
});

test("an unfinished round survives a snapshot and restore", () => {
  let clock = 0;
  const before = createQqTaskPleadingTracker({ required: 3, windowMs: 1000, now: () => clock, random: () => 0.9 });
  before.note("g:1");
  const after = createQqTaskPleadingTracker({ required: 3, windowMs: 1000, now: () => clock, random: () => 0.1 });
  after.restore(JSON.parse(JSON.stringify(before.snapshot())));
  assert.equal(after.pending("g:1"), true);
  assert.deepEqual([after.note("g:1").count, after.note("g:1").allowed], [2, true]);
});
