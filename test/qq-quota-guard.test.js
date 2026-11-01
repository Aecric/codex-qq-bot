import assert from "node:assert/strict";
import test from "node:test";
import { decideQqQuotaGuard, qqQuotaSaverKeepsInterestJudge } from "../src/qq-quota-guard.js";

const quota = (remainingPercent, resetsAt = 2000) => ({ available: true, primary: { remainingPercent, resetsAt } });

test("enters saver mode below the threshold and only then", () => {
  assert.equal(decideQqQuotaGuard(quota(24)), "enter");
  assert.equal(decideQqQuotaGuard(quota(25)), null);
  assert.equal(decideQqQuotaGuard({ available: false }), null);
  assert.equal(decideQqQuotaGuard(quota(10), { enterBelowPercent: 0 }), null);
});

test("leaves saver mode once the window recovers or resets", () => {
  assert.equal(decideQqQuotaGuard(quota(30), { active: true, now: 1000 }), null);
  assert.equal(decideQqQuotaGuard(quota(50), { active: true, now: 1000 }), "exit");
  assert.equal(decideQqQuotaGuard(quota(5, 2000), { active: true, now: 2_000_000 }), "exit");
});

test("saver mode keeps an interest judge that does not spend Codex quota", () => {
  assert.equal(qqQuotaSaverKeepsInterestJudge("codex"), false);
  assert.equal(qqQuotaSaverKeepsInterestJudge(" Codex "), false);
  for (const provider of ["ollama", "openrouter", "deepseek", "custom"]) {
    assert.equal(qqQuotaSaverKeepsInterestJudge(provider), true);
  }
});
