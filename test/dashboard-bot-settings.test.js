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
    judgeModelsByProvider: { openrouter: "vendor/new-model:free" },
    judgeProviders: [
      { id: "openrouter", label: "OpenRouter", defaultModel: "openrouter/free", model: "vendor/new-model:free" },
      { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-v4-flash", model: "deepseek-v4-flash" },
      { id: "custom", label: "自定义兼容服务", defaultModel: "gpt-4o-mini", model: "gpt-4o-mini" },
      { id: "codex", label: "本机 Codex", defaultModel: "gpt-6-luna", model: "gpt-6-luna" },
      { id: "ollama", label: "本机 Ollama", defaultModel: "gemma4:e4b-it-qat", model: "gemma4:e4b-it-qat" }
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
  assert.deepEqual(readDashboardBotSettings(state).judgeModelsByProvider, {});
  assert.equal(readDashboardBotSettings(state).judgeModel, "provider/model:free");
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

function createPerProviderState({ provider = "codex", model = "gpt-6-luna", modelsByProvider = {} } = {}) {
  const state = createState();
  state.qq.proactive.judge.provider = provider;
  state.qq.proactive.judge.model = model;
  state.qq.proactive.judge.baseUrl = "codex://local";
  state.qq.proactive.judge.modelsByProvider = modelsByProvider;
  return state;
}

test("readDashboardBotSettings exposes the normalized per-provider model map and the model each provider would use", () => {
  const state = createPerProviderState({
    modelsByProvider: { ollama: " qwen3.5:4b ", mystery: "dropped", deepseek: "bad model" }
  });
  const settings = readDashboardBotSettings(state);
  assert.deepEqual(settings.judgeModelsByProvider, { ollama: "qwen3.5:4b" });
  const modelOf = Object.fromEntries(settings.judgeProviders.map((entry) => [entry.id, entry.model]));
  assert.equal(modelOf.ollama, "qwen3.5:4b");
  assert.equal(modelOf.codex, "gpt-6-luna");
  assert.equal(modelOf.deepseek, "deepseek-v4-flash");
  assert.equal(settings.judgeProviders.find((entry) => entry.id === "ollama").defaultModel, "gemma4:e4b-it-qat");

  assert.deepEqual(readDashboardBotSettings(createState()).judgeModelsByProvider, {}, "older state without a map reads as empty");
});

test("switching judgeProvider picks the saved per-provider model instead of the provider default", () => {
  const state = createPerProviderState({ modelsByProvider: { ollama: "qwen3.5:4b" } });
  const change = applyDashboardBotSettings(state, { judgeProvider: "ollama" });
  assert.equal(change.settings.judgeProvider, "ollama");
  assert.equal(change.settings.judgeModel, "qwen3.5:4b");
  assert.equal(state.qq.proactive.judge.model, "qwen3.5:4b");
  assert.equal(state.qq.proactive.judge.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { ollama: "qwen3.5:4b" });

  const back = applyDashboardBotSettings(state, { judgeProvider: "codex" });
  assert.equal(back.settings.judgeModel, "gpt-6-luna", "a provider without an override uses its default");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { ollama: "qwen3.5:4b" }, "the Ollama choice survives the round trip");

  const again = applyDashboardBotSettings(state, { judgeProvider: "ollama" });
  assert.equal(again.settings.judgeModel, "qwen3.5:4b");

  const explicit = applyDashboardBotSettings(state, { judgeProvider: "deepseek", judgeModel: "deepseek-custom" });
  assert.equal(explicit.settings.judgeModel, "deepseek-custom", "an explicit judgeModel wins over the saved one");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { ollama: "qwen3.5:4b", deepseek: "deepseek-custom" });
});

test("setting judgeModel records it for the active provider only", () => {
  const state = createState();
  const change = applyDashboardBotSettings(state, { judgeModel: "vendor/other:free" });
  assert.equal(change.settings.judgeModel, "vendor/other:free");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { openrouter: "vendor/other:free" });
  assert.equal(change.settings.judgeProviders.find((entry) => entry.id === "openrouter").model, "vendor/other:free");
  assert.equal(change.settings.judgeProviders.find((entry) => entry.id === "ollama").model, "gemma4:e4b-it-qat");

  const reset = applyDashboardBotSettings(state, { judgeModel: "openrouter/free" });
  assert.equal(reset.settings.judgeModel, "openrouter/free");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, {}, "choosing the default drops the override");

  change.restore();
  assert.equal(state.qq.proactive.judge.model, "provider/model:free");
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, {});
});

test("a judgeModelsByProvider patch edits a backup provider without touching the active model", () => {
  const state = createPerProviderState();
  const change = applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "qwen3.5:4b" } });
  assert.equal(change.settings.judgeProvider, "codex");
  assert.equal(change.settings.judgeModel, "gpt-6-luna");
  assert.equal(state.qq.proactive.judge.model, "gpt-6-luna");
  assert.equal(state.qq.proactive.judge.baseUrl, "codex://local");
  assert.deepEqual(change.settings.judgeModelsByProvider, { ollama: "qwen3.5:4b" });
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { ollama: "qwen3.5:4b" });
  assert.equal(change.settings.judgeProviders.find((entry) => entry.id === "ollama").model, "qwen3.5:4b");

  const other = applyDashboardBotSettings(state, { judgeModelsByProvider: { deepseek: "deepseek-custom" } });
  assert.deepEqual(other.settings.judgeModelsByProvider, { ollama: "qwen3.5:4b", deepseek: "deepseek-custom" }, "a patch merges per provider");

  const cleared = applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "" } });
  assert.deepEqual(cleared.settings.judgeModelsByProvider, { deepseek: "deepseek-custom" }, "an empty string removes the override");
  assert.equal(cleared.settings.judgeModel, "gpt-6-luna");

  const defaulted = applyDashboardBotSettings(state, { judgeModelsByProvider: { deepseek: "deepseek-v4-flash" } });
  assert.deepEqual(defaulted.settings.judgeModelsByProvider, {}, "choosing the default also removes the override");
});

test("a judgeModelsByProvider patch for the active provider updates the live model", () => {
  const state = createPerProviderState({ provider: "ollama", model: "gemma4:e4b-it-qat" });
  const change = applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "qwen3.5:4b" } });
  assert.equal(change.settings.judgeModel, "qwen3.5:4b");
  assert.equal(state.qq.proactive.judge.model, "qwen3.5:4b");

  const reset = applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "" } });
  assert.equal(reset.settings.judgeModel, "gemma4:e4b-it-qat");
});

test("a malformed judgeModelsByProvider patch throws without mutating state", () => {
  const state = createPerProviderState({ modelsByProvider: { ollama: "qwen3.5:4b" } });
  const snapshot = structuredClone(state);

  assert.throws(
    () => applyDashboardBotSettings(state, { judgeEveryMessages: 30, judgeModelsByProvider: { ollama: "qwen3.5:9b", mystery: "x" } }),
    (error) => error instanceof RangeError && /unknown provider: mystery/.test(error.message)
  );
  assert.throws(
    () => applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "bad model id" } }),
    (error) => error instanceof RangeError && /valid provider model id/.test(error.message)
  );
  assert.throws(() => applyDashboardBotSettings(state, { judgeModelsByProvider: ["ollama"] }), RangeError);
  assert.throws(() => applyDashboardBotSettings(state, { judgeModelsByProvider: null }), RangeError);
  assert.throws(() => applyDashboardBotSettings(state, { judgeModelsByProvider: "ollama=qwen" }), RangeError);
  assert.deepEqual(state, snapshot);
});

test("restore puts the per-provider model map back", () => {
  const state = createPerProviderState({ modelsByProvider: { ollama: "qwen3.5:4b" } });
  const change = applyDashboardBotSettings(state, {
    judgeModelsByProvider: { ollama: "", deepseek: "deepseek-custom" },
    judgeProvider: "deepseek"
  });
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { deepseek: "deepseek-custom" });
  assert.equal(state.qq.proactive.judge.provider, "deepseek");

  change.restore();
  assert.deepEqual(state.qq.proactive.judge.modelsByProvider, { ollama: "qwen3.5:4b" });
  assert.equal(state.qq.proactive.judge.provider, "codex");
  assert.equal(state.qq.proactive.judge.model, "gpt-6-luna");
  assert.equal(state.qq.proactive.judge.baseUrl, "codex://local");
  assert.deepEqual(readDashboardBotSettings(state).judgeModelsByProvider, { ollama: "qwen3.5:4b" });
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

test("dashboard backup-provider model edits leave a live model that is not in the override map alone", () => {
  const state = createState();
  const change = applyDashboardBotSettings(state, { judgeModelsByProvider: { ollama: "qwen3.5:4b" } });
  assert.equal(state.qq.proactive.judge.model, "provider/model:free");
  assert.equal(change.settings.judgeModel, "provider/model:free");
  assert.equal(state.qq.proactive.judge.modelsByProvider.ollama, "qwen3.5:4b");
});

test("dashboard override for the active provider updates the live model", () => {
  const state = createState();
  applyDashboardBotSettings(state, { judgeModelsByProvider: { openrouter: "vendor/other:free" } });
  assert.equal(state.qq.proactive.judge.model, "vendor/other:free");
});
