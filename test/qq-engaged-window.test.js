import assert from "node:assert/strict";
import test from "node:test";
import { createQqEngagedWindows } from "../src/qq-engaged-window.js";

test("an @ opens a window that counts down the watched messages", () => {
  const windows = createQqEngagedWindows({ size: 3 });
  assert.equal(windows.consume("100"), null);
  windows.open("100");
  assert.deepEqual(windows.consume("100"), { remaining: 2, size: 3 });
  assert.deepEqual(windows.consume("100"), { remaining: 1, size: 3 });
  assert.deepEqual(windows.consume("100"), { remaining: 0, size: 3 });
  assert.equal(windows.consume("100"), null);
});

test("a reply inside the window restarts it, but never opens a closed one", () => {
  const windows = createQqEngagedWindows({ size: 3 });
  assert.equal(windows.renewIfActive("100"), false);
  assert.equal(windows.remaining("100"), 0);
  windows.open("100");
  windows.consume("100");
  windows.consume("100");
  assert.equal(windows.renewIfActive("100"), true);
  assert.equal(windows.remaining("100"), 3);
  assert.equal(windows.remaining("200"), 0);
});

test("a zero size turns the window off", () => {
  const windows = createQqEngagedWindows({ size: 0 });
  windows.open("100");
  assert.equal(windows.consume("100"), null);
});

test("a window survives a snapshot and restore but lapses when idle", () => {
  let clock = 0;
  const before = createQqEngagedWindows({ size: 3, idleMs: 1000, now: () => clock });
  before.open("100");
  before.consume("100");
  const after = createQqEngagedWindows({ size: 3, idleMs: 1000, now: () => clock });
  after.restore(JSON.parse(JSON.stringify(before.snapshot())));
  assert.equal(after.remaining("100"), 2);
  clock = 5000;
  assert.equal(after.remaining("100"), 0);
  assert.equal(after.consume("100"), null);
});

test("resizing caps open windows and a zero size closes them", () => {
  let saves = 0;
  const windows = createQqEngagedWindows({ size: 10, onChange: () => { saves += 1; } });
  windows.open("100");
  const before = saves;
  windows.resize(20);
  assert.equal(windows.size, 20);
  assert.equal(windows.remaining("100"), 10);
  assert.equal(saves, before, "growing leaves open windows untouched");
  windows.resize(4);
  assert.equal(windows.remaining("100"), 4);
  windows.resize(0);
  assert.equal(windows.remaining("100"), 0);
  windows.open("100");
  assert.equal(windows.remaining("100"), 0);
});
