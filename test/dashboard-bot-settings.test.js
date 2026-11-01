import assert from "node:assert/strict";
import test from "node:test";
import { applyDashboardBotSettings, normalizeQqBehaviorSettings, readDashboardBotSettings } from "../src/dashboard-bot-settings.js";

function createState() {
  return {
    qq: {
      enhancer: { enabled: true },
      webLookup: { enabled: true },
      proactive: {
        enabled: true,
        judgeEveryMessages: 20,
        judgeEveryMinutes: 5,
        judge: {
          enabled: true,
          provider: "openrouter",
          model: "provider/model:free",
          baseUrl: "https://openrouter.ai/api/v1",
          timeoutMs: 6500,
          maxRecentMessages: 8,
          apiKeyConfigured: true
        }
      }
    }
  };
}

test("dashboard Bot settings update bounded runtime controls and can roll back", () => {
  const state = createState();
  const change = applyDashboardBotSettings(state, {
    webLookupEnabled: false,
    proactiveEnabled: true,
    judgeEveryMessages: 12,
    judgeEveryMinutes: 3,
    judgeModel: "vendor/new-model:free",
    judgeTimeoutMs: 9000,
    judgeMaxRecentMessages: 10
  });

  assert.deepEqual(change.settings, {
    enhancerEnabled: true,
    webLookupEnabled: false,
    proactiveEnabled: true,
    judgeEnabled: true,
    judgeEveryMessages: 12,
    judgeEveryMinutes: 3,
    judgeModel: "vendor/new-model:free",
    judgeTimeoutMs: 9000,
    judgeMaxRecentMessages: 10,
    judgeProvider: "openrouter",
    judgeApiKeyConfigured: true,
    judgeProviders: [
      { id: "openrouter", label: "OpenRouter", defaultModel: "openrouter/free" },
      { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-v4-flash" },
      { id: "custom", label: "自定义兼容服务", defaultModel: "gpt-4o-mini" },
      { id: "codex", label: "本机 Codex", defaultModel: "gpt-6-luna" },
      { id: "ollama", label: "本机 Ollama", defaultModel: "gemma4:e4b-it-qat" }
    ],
    selfPersonaGenerationEnabled: true,
    replyScrubEnabled: true,
    proactiveGroupIds: [],
    engagedWindowMessages: 30,
    stickerMinChance: 0,
    taskPleadingAsks: 0,
    sessionRotateHours: 0,
    sessionRotateReplies: 0,
    quotaSaverBelow: 0,
    quotaSaverResumeAt: 50,
    judgeIdleAfterSeconds: 300,
    quotaSaverModel: "gpt-6-luna",
    judgeIdleSwitchEnabled: false,
    judgeActiveProvider: "codex",
    judgeIdleProvider: "ollama"
  });

  change.restore();
  assert.equal(readDashboardBotSettings(state).judgeEveryMessages, 20);
  assert.equal(readDashboardBotSettings(state).webLookupEnabled, true);
});

test("dashboard Bot settings preserve enhancer and proactive invariants", () => {
  const disabled = createState();
  applyDashboardBotSettings(disabled, { enhancerEnabled: false, proactiveEnabled: true });
  assert.equal(disabled.qq.enhancer.enabled, true, "enabling proactive also enables the enhancer");
  assert.equal(disabled.qq.proactive.enabled, true);

  const enhancerOff = createState();
  applyDashboardBotSettings(enhancerOff, { enhancerEnabled: false });
  assert.equal(enhancerOff.qq.proactive.enabled, false);
});

test("dashboard Bot settings switch interest providers with safe defaults", () => {
  const state = createState();
  const change = applyDashboardBotSettings(state, { judgeProvider: "deepseek" });
  assert.equal(change.settings.judgeProvider, "deepseek");
  assert.equal(change.settings.judgeModel, "deepseek-v4-flash");
  assert.equal(change.settings.judgeApiKeyConfigured, false);
  assert.equal(state.qq.proactive.judge.baseUrl, "https://api.deepseek.com");
  change.restore();
  assert.equal(state.qq.proactive.judge.provider, "openrouter");
  assert.equal(state.qq.proactive.judge.baseUrl, "https://openrouter.ai/api/v1");
});

test("dashboard Bot settings reject malformed values without mutation", () => {
  const state = createState();
  assert.throws(() => applyDashboardBotSettings(state, { judgeTimeoutMs: 500 }), /between 1500 and 20000/);
  assert.throws(() => applyDashboardBotSettings(state, { judgeModel: "bad model id" }), /valid provider model id/);
  assert.throws(() => applyDashboardBotSettings(state, { judgeProvider: "unknown" }), /must be one of/);
  assert.equal(readDashboardBotSettings(state).judgeTimeoutMs, 6500);
});

test("dashboard Bot settings edit the behavior controls and can roll them back", () => {
  const state = createState();
  state.qq.behavior = normalizeQqBehaviorSettings({ engagedWindowMessages: 30 });
  const change = applyDashboardBotSettings(state, {
    selfPersonaGenerationEnabled: false,
    replyScrubEnabled: false,
    proactiveGroupIds: "123456, 234567，123456",
    engagedWindowMessages: 12,
    stickerMinChance: 0.4,
    taskPleadingAsks: 3,
    sessionRotateHours: 1.5,
    sessionRotateReplies: 50,
    quotaSaverBelow: 20,
    quotaSaverResumeAt: 40,
    quotaSaverModel: "small-model",
    judgeIdleSwitchEnabled: true,
    judgeIdleAfterSeconds: 600,
    judgeActiveProvider: "deepseek",
    judgeIdleProvider: "codex"
  });
  assert.equal(state.qq.behavior.selfPersonaGenerationEnabled, false);
  assert.equal(state.qq.behavior.replyScrubEnabled, false);
  assert.deepEqual(state.qq.behavior.proactiveGroupIds, ["123456", "234567"]);
  assert.equal(state.qq.behavior.stickerMinChance, 0.4);
  assert.equal(state.qq.behavior.sessionRotateHours, 1.5);
  assert.equal(state.qq.behavior.judgeIdleProvider, "codex");
  assert.equal(change.settings.judgeIdleAfterSeconds, 600);
  assert.equal(change.settings.judgeProvider, "openrouter", "the idle switch settings leave the current provider alone");

  change.restore();
  assert.equal(state.qq.behavior.engagedWindowMessages, 30);
  assert.deepEqual(state.qq.behavior.proactiveGroupIds, []);
  assert.equal(state.qq.behavior.judgeIdleSwitchEnabled, false);
});

test("dashboard Bot settings reject malformed behavior values without mutation", () => {
  const state = createState();
  state.qq.behavior = normalizeQqBehaviorSettings({});
  assert.throws(() => applyDashboardBotSettings(state, { engagedWindowMessages: 201 }), /between 0 and 200/);
  assert.throws(() => applyDashboardBotSettings(state, { engagedWindowMessages: 1.5 }), /integer/);
  assert.throws(() => applyDashboardBotSettings(state, { stickerMinChance: 2 }), /between 0 and 1/);
  assert.throws(() => applyDashboardBotSettings(state, { stickerMinChance: "" }), /between 0 and 1/);
  assert.throws(() => applyDashboardBotSettings(state, { proactiveGroupIds: "123456, abc" }), /invalid group id: abc/);
  assert.throws(() => applyDashboardBotSettings(state, { quotaSaverModel: "bad model" }), /valid model id/);
  assert.throws(() => applyDashboardBotSettings(state, { judgeIdleProvider: "unknown" }), /must be one of/);
  assert.throws(() => applyDashboardBotSettings(state, { replyScrubEnabled: "no" }), /must be a boolean/);
  assert.throws(
    () => applyDashboardBotSettings(state, { quotaSaverBelow: 60, quotaSaverResumeAt: 50 }),
    /greater than quotaSaverBelow/,
    "an exit threshold below the entry threshold would flap"
  );
  assert.deepEqual(state.qq.behavior, normalizeQqBehaviorSettings({}));
});

test("saved behavior settings are clamped and keep environment values for missing keys", () => {
  const fallback = normalizeQqBehaviorSettings({ taskPleadingAsks: 3, quotaSaverBelow: 15 });
  const loaded = normalizeQqBehaviorSettings({
    engagedWindowMessages: 9999,
    stickerMinChance: "oops",
    proactiveGroupIds: ["123456", "bad"],
    quotaSaverModel: "bad model",
    judgeActiveProvider: "ollama"
  }, fallback);
  assert.equal(loaded.engagedWindowMessages, 200);
  assert.equal(loaded.stickerMinChance, 0);
  assert.deepEqual(loaded.proactiveGroupIds, ["123456"]);
  assert.equal(loaded.quotaSaverModel, "gpt-6-luna");
  assert.equal(loaded.judgeActiveProvider, "ollama");
  assert.equal(loaded.taskPleadingAsks, 3);
  assert.equal(loaded.quotaSaverBelow, 15);
});
