import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createAgyQuotaProbe, normalizeAgyQuotaReport } from "../src/infrastructure/agy/agy-quota.js";

const now = Date.parse("2026-11-24T00:00:00Z");

function usageReport(groups) {
  return { status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups } } };
}

test("agy quota keeps shared 5-hour and weekly windows within their reported model groups", () => {
  const input = usageReport([
    { name: "Gemini Models", buckets: [
      { window: "weekly", remaining_fraction: 0.8 },
      { window: "5h", remaining_fraction: 0.35, reset_time: "2026-11-24T02:00:00Z" }
    ] },
    { name: "Claude and GPT models", buckets: [
      { window: "weekly", remaining_fraction: 0.6 },
      { window: "5h", remaining_fraction: 0 }
    ] },
    { name: "Gemini 4 Argon", buckets: [{ window: "weekly", remaining_fraction: 1 }] }
  ]);
  assert.deepEqual(normalizeAgyQuotaReport(input, now), {
    available: true,
    updatedAt: new Date(now).toISOString(),
    groups: [
      {
        name: "Gemini Models",
        primary: { remainingPercent: 35, windowMinutes: 300, resetsAt: 1795485600 },
        secondary: { remainingPercent: 80, windowMinutes: 10080, resetsAt: null }
      },
      {
        name: "Claude and GPT models",
        primary: { remainingPercent: 0, windowMinutes: 300, resetsAt: null },
        secondary: { remainingPercent: 60, windowMinutes: 10080, resetsAt: null }
      },
      {
        name: "Gemini 4 Argon",
        primary: null,
        secondary: { remainingPercent: 100, windowMinutes: 10080, resetsAt: null }
      }
    ]
  });
});

test("agy quota ignores unavailable buckets and output from ordinary model turns", () => {
  const input = usageReport([{ name: "Gemini Models", buckets: [
    { window: "5h", remaining_fraction: 0.5, disabled: true },
    { window: "weekly", remaining_amount: 1 }
  ] }]);
  assert.equal(normalizeAgyQuotaReport(input, now), null);
  assert.equal(normalizeAgyQuotaReport({ status: "SUCCESS", num_turns: 1, response: "Quota OK" }, now), null);
});

test("agy quota refreshes in the background, coalesces requests and caches a result", async () => {
  let calls = 0;
  let finishRead;
  const result = { available: true };
  const probe = createAgyQuotaProbe({}, {
    read: () => {
      calls += 1;
      return new Promise((resolve) => { finishRead = resolve; });
    }
  });

  assert.equal(probe.peek(), null);
  assert.equal(probe.peek(), null);
  await setImmediate();
  assert.equal(calls, 1);
  finishRead(result);
  await setImmediate();
  assert.equal(probe.peek(), result);
  assert.equal(calls, 1);
});
