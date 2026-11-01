import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/app/create-initial-state.js";
import { createSettingsSnapshot, SETTINGS_SCHEMA_VERSION } from "../src/app/settings-snapshot.js";
import { createEnvironmentConfig } from "../src/config/environment.js";

test("settings snapshot persists every native Codex runtime parameter", () => {
  const state = createInitialState({
    config: createEnvironmentConfig({}),
    codexWorkspaceDir: "/tmp/workspace",
    qqProactiveInterestPreset: {}
  });
  state.ai.reasoningSummary = "detailed";
  state.ai.personality = "pragmatic";
  state.ai.serviceTier = "priority";
  state.qq.adminUserIds = ["123456789"];
  const snapshot = createSettingsSnapshot({
    state,
    networkApiToken: "token",
    interestApiKeyConfigured: true,
    branding: { assistantName: "小星", ownerLabel: "主人", userAgent: "test", assistantMentions: ["@小星"] },
    updatedAt: "2026-08-01T00:00:00.000Z"
  });

  assert.equal(snapshot.version, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(snapshot.ai, {
    model: state.ai.model,
    reasoningEffort: state.ai.reasoningEffort,
    reasoningSummary: "detailed",
    personality: "pragmatic",
    serviceTier: "priority"
  });
  assert.equal(snapshot.qq.proactive.judge.apiKeyConfigured, true);
  assert.deepEqual(snapshot.qq.adminUserIds, ["123456789"]);
  assert.deepEqual(snapshot.branding.assistantMentions, ["@小星"]);
  assert.deepEqual(snapshot.qq.behavior, state.qq.behavior);

  state.ai.personality = "friendly";
  state.qq.allowedGroups.push("123");
  assert.equal(snapshot.ai.personality, "pragmatic");
  assert.deepEqual(snapshot.qq.allowedGroups, []);
});

test("behavior settings start from the environment", () => {
  const state = createInitialState({
    config: createEnvironmentConfig({
      CODEX_REMOTE_CONTACT_QQ_ENGAGED_WINDOW_MESSAGES: "12",
      CODEX_REMOTE_CONTACT_QQ_REPLY_SCRUB: "0",
      CODEX_REMOTE_CONTACT_QQ_PROACTIVE_GROUPS: "123456,234567",
      CODEX_REMOTE_CONTACT_QQ_QUOTA_SAVER_BELOW: "20",
      CODEX_REMOTE_CONTACT_QQ_PROACTIVE_JUDGE_IDLE_SWITCH: "1",
      CODEX_REMOTE_CONTACT_QQ_PROACTIVE_JUDGE_IDLE_AFTER_SECONDS: "600"
    }),
    codexWorkspaceDir: "/tmp/workspace",
    qqProactiveInterestPreset: {}
  });
  assert.equal(state.qq.behavior.engagedWindowMessages, 12);
  assert.equal(state.qq.behavior.replyScrubEnabled, false);
  assert.deepEqual(state.qq.behavior.proactiveGroupIds, ["123456", "234567"]);
  assert.equal(state.qq.behavior.quotaSaverBelow, 20);
  assert.equal(state.qq.behavior.judgeIdleSwitchEnabled, true);
  assert.equal(state.qq.behavior.judgeIdleAfterSeconds, 600);
});
