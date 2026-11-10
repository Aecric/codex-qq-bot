import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultInterestModel } from "../src/interest-model-provider.js";
import {
  buildQqJudgeModelTarget,
  createQqInterestModelSwitcher,
  isValidQqJudgeModelId,
  migrateQqJudgeModelSettings,
  normalizeQqJudgeModelsByProvider,
  parseQqJudgeModelsEnv,
  rememberQqJudgeModelForProvider,
  resolveQqJudgeModelForProvider
} from "../src/qq-interest-model-selection.js";

const OLLAMA_URL = "http://127.0.0.1:11434/v1";

test("isValidQqJudgeModelId accepts provider model ids and rejects unsafe ones", () => {
  for (const id of ["qwen3.5:4b", "vendor/new-model:free", "gpt-6-luna", "a@b+c_d.e", "x".repeat(160)]) {
    assert.equal(isValidQqJudgeModelId(id), true, id);
  }
  for (const id of ["", "  ", "bad model", "x".repeat(161), "a;b", "a\nb", undefined, null]) {
    assert.equal(isValidQqJudgeModelId(id), false, JSON.stringify(id));
  }
});

test("normalizeQqJudgeModelsByProvider drops unknown providers and invalid ids", () => {
  assert.deepEqual(
    normalizeQqJudgeModelsByProvider({
      ollama: " qwen3.5:4b ",
      CODEX: "gpt-6-luna",
      mystery: "some-model",
      deepseek: "bad model",
      custom: "",
      openrouter: "x".repeat(161)
    }),
    { ollama: "qwen3.5:4b", codex: "gpt-6-luna" }
  );
  assert.deepEqual(normalizeQqJudgeModelsByProvider(null), {});
  assert.deepEqual(normalizeQqJudgeModelsByProvider(undefined), {});
  assert.deepEqual(normalizeQqJudgeModelsByProvider("ollama=qwen3.5:4b"), {});
  assert.deepEqual(normalizeQqJudgeModelsByProvider([["ollama", "qwen3.5:4b"]]), {});
});

test("parseQqJudgeModelsEnv reads provider=model pairs", () => {
  assert.deepEqual(parseQqJudgeModelsEnv("ollama=qwen3.5:4b, codex=gpt-6-luna"), {
    ollama: "qwen3.5:4b",
    codex: "gpt-6-luna"
  });
  assert.deepEqual(parseQqJudgeModelsEnv("Ollama = qwen3.5:4b ; deepseek=deepseek-v4-flash\ncustom=my/model"), {
    ollama: "qwen3.5:4b",
    deepseek: "deepseek-v4-flash",
    custom: "my/model"
  });
  assert.deepEqual(parseQqJudgeModelsEnv("ollama=qwen3.5:4b, nonsense, =orphan, mystery=m, codex=bad model, deepseek="), {
    ollama: "qwen3.5:4b"
  });
  assert.deepEqual(parseQqJudgeModelsEnv("ollama=first,ollama=second"), { ollama: "second" });
  assert.deepEqual(parseQqJudgeModelsEnv(""), {});
  assert.deepEqual(parseQqJudgeModelsEnv(undefined), {});
});

test("resolveQqJudgeModelForProvider uses the override or the provider default", () => {
  assert.equal(resolveQqJudgeModelForProvider({}, "ollama"), getDefaultInterestModel("ollama"));
  assert.equal(resolveQqJudgeModelForProvider({ modelsByProvider: {} }, "codex"), getDefaultInterestModel("codex"));
  assert.equal(resolveQqJudgeModelForProvider(undefined, "deepseek"), getDefaultInterestModel("deepseek"));
  assert.equal(resolveQqJudgeModelForProvider(null, "deepseek"), getDefaultInterestModel("deepseek"));

  const judge = { modelsByProvider: { ollama: "qwen3.5:4b", bogus: "x" } };
  assert.equal(resolveQqJudgeModelForProvider(judge, "ollama"), "qwen3.5:4b");
  assert.equal(resolveQqJudgeModelForProvider(judge, "codex"), getDefaultInterestModel("codex"), "other providers keep their default");
  assert.equal(resolveQqJudgeModelForProvider(judge, "OLLAMA"), "qwen3.5:4b");
  assert.equal(
    resolveQqJudgeModelForProvider(judge, "not-a-provider"),
    getDefaultInterestModel("openrouter"),
    "unknown providers normalize to the OpenRouter default"
  );
});

test("rememberQqJudgeModelForProvider stores overrides and drops them when the default is chosen", () => {
  const judge = { provider: "codex", model: "gpt-6-luna" };
  const stored = rememberQqJudgeModelForProvider(judge, "ollama", "qwen3.5:4b");
  assert.deepEqual(stored, { ollama: "qwen3.5:4b" });
  assert.deepEqual(judge.modelsByProvider, { ollama: "qwen3.5:4b" });

  rememberQqJudgeModelForProvider(judge, "codex", "gpt-6-other");
  assert.deepEqual(judge.modelsByProvider, { ollama: "qwen3.5:4b", codex: "gpt-6-other" });

  rememberQqJudgeModelForProvider(judge, "ollama", getDefaultInterestModel("ollama"));
  assert.deepEqual(judge.modelsByProvider, { codex: "gpt-6-other" }, "choosing the default removes the override");

  rememberQqJudgeModelForProvider(judge, "codex", "");
  assert.deepEqual(judge.modelsByProvider, {}, "an empty choice also goes back to the default");
});

test("rememberQqJudgeModelForProvider ignores invalid model ids and keeps the previous choice", () => {
  const judge = { modelsByProvider: { ollama: "qwen3.5:4b" } };
  rememberQqJudgeModelForProvider(judge, "ollama", "bad model id");
  assert.deepEqual(judge.modelsByProvider, { ollama: "qwen3.5:4b" });
  rememberQqJudgeModelForProvider(judge, "ollama", "x".repeat(161));
  assert.deepEqual(judge.modelsByProvider, { ollama: "qwen3.5:4b" });
});

test("migrateQqJudgeModelSettings gives a legacy saved model to the provider it was saved with", () => {
  const judge = { provider: "codex", model: "gpt-6-luna" };
  const overrides = migrateQqJudgeModelSettings(judge, { savedProvider: "ollama", savedModel: "qwen3.5:4b" });
  assert.deepEqual(overrides, { ollama: "qwen3.5:4b" });
  assert.deepEqual(judge.modelsByProvider, { ollama: "qwen3.5:4b" });
  assert.equal("codex" in judge.modelsByProvider, false, "other providers keep their defaults");
  assert.equal(resolveQqJudgeModelForProvider(judge, "codex"), getDefaultInterestModel("codex"));
});

test("migrateQqJudgeModelSettings falls back to the live provider and skips default models", () => {
  const live = { provider: "ollama" };
  migrateQqJudgeModelSettings(live, { savedModel: "qwen3.5:4b" });
  assert.deepEqual(live.modelsByProvider, { ollama: "qwen3.5:4b" });

  const defaultModel = { provider: "ollama" };
  migrateQqJudgeModelSettings(defaultModel, { savedProvider: "ollama", savedModel: getDefaultInterestModel("ollama") });
  assert.deepEqual(defaultModel.modelsByProvider, {});

  const invalid = {};
  migrateQqJudgeModelSettings(invalid, { savedProvider: "ollama", savedModel: "bad model" });
  assert.deepEqual(invalid.modelsByProvider, {});

  const empty = {};
  migrateQqJudgeModelSettings(empty);
  assert.deepEqual(empty.modelsByProvider, {});
});

test("migrateQqJudgeModelSettings lets a saved per-provider map win over the legacy pair", () => {
  const judge = { provider: "codex" };
  migrateQqJudgeModelSettings(judge, {
    savedProvider: "ollama",
    savedModel: "qwen3.5:4b",
    savedModelsByProvider: { codex: "gpt-6-saved" }
  });
  assert.deepEqual(judge.modelsByProvider, { codex: "gpt-6-saved" }, "the legacy pair is not added again");

  const emptyMap = {};
  migrateQqJudgeModelSettings(emptyMap, { savedProvider: "ollama", savedModel: "qwen3.5:4b", savedModelsByProvider: {} });
  assert.deepEqual(emptyMap.modelsByProvider, {}, "an operator who reset every override stays reset");
});

test("migrateQqJudgeModelSettings merges the environment map underneath the saved map", () => {
  const judge = {};
  migrateQqJudgeModelSettings(judge, {
    envModelsByProvider: { ollama: "env-model", codex: "gpt-6-env" },
    savedModelsByProvider: { ollama: "saved-model" }
  });
  assert.deepEqual(judge.modelsByProvider, { ollama: "saved-model", codex: "gpt-6-env" });

  const envOnly = {};
  migrateQqJudgeModelSettings(envOnly, { envModelsByProvider: { ollama: "env-model", mystery: "x", codex: "bad model" } });
  assert.deepEqual(envOnly.modelsByProvider, { ollama: "env-model" });

  const legacy = {};
  migrateQqJudgeModelSettings(legacy, {
    envModelsByProvider: { ollama: "env-model", codex: "gpt-6-env" },
    savedProvider: "ollama",
    savedModel: "qwen3.5:4b"
  });
  assert.deepEqual(legacy.modelsByProvider, { ollama: "qwen3.5:4b", codex: "gpt-6-env" });
});

test("buildQqJudgeModelTarget snapshots the provider, model and trimmed base url", () => {
  const judge = { modelsByProvider: { ollama: "qwen3.5:4b" } };
  assert.deepEqual(buildQqJudgeModelTarget(judge, "ollama", { baseUrl: ` ${OLLAMA_URL}/// ` }), {
    provider: "ollama",
    model: "qwen3.5:4b",
    baseUrl: OLLAMA_URL
  });
  assert.deepEqual(buildQqJudgeModelTarget(judge, "codex"), {
    provider: "codex",
    model: getDefaultInterestModel("codex"),
    baseUrl: ""
  });
  assert.equal(buildQqJudgeModelTarget({}, "mystery").provider, "openrouter");
});

// A switcher wired to a fake judge object, a deferred-capable preload and
// manually fired unload timers.
function createHarness({ preload, unload, commit, unloadDelayMs = 30_000, modelsByProvider = { ollama: "qwen3.5:4b" } } = {}) {
  const judge = { provider: "codex", model: getDefaultInterestModel("codex"), baseUrl: "codex://local", modelsByProvider };
  const calls = { preload: [], unload: [], commit: [], status: [], timers: [], cleared: [] };
  const switcher = createQqInterestModelSwitcher({
    preload: async (target) => {
      calls.preload.push(target);
      if (preload) await preload(target);
    },
    unload: async (target) => {
      calls.unload.push(target);
      if (unload) await unload(target);
    },
    commit: async (target, options) => {
      calls.commit.push({ target, options });
      if (commit) await commit(target, options);
      judge.provider = target.provider;
      judge.model = target.model;
      judge.baseUrl = target.baseUrl;
      return { ...target };
    },
    getActive: () => ({ provider: judge.provider, model: judge.model, baseUrl: judge.baseUrl }),
    unloadDelayMs,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      calls.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      calls.cleared.push(timer);
    },
    onStatus: (status) => calls.status.push(status)
  });
  const toOllama = () => buildQqJudgeModelTarget(judge, "ollama", { baseUrl: OLLAMA_URL });
  const toCodex = () => buildQqJudgeModelTarget(judge, "codex", { baseUrl: "codex://local" });
  return { judge, calls, switcher, toOllama, toCodex };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a Codex to Ollama to Codex to Ollama sequence loads the chosen Ollama model every time", async () => {
  const { judge, calls, switcher, toOllama, toCodex } = createHarness();

  const first = await switcher.request(toOllama(), { reason: "idle" });
  assert.equal(first.ok, true);
  assert.deepEqual(first.target, { provider: "ollama", model: "qwen3.5:4b", baseUrl: OLLAMA_URL });
  assert.equal(first.previous.provider, "codex");
  assert.equal(judge.provider, "ollama");

  const back = await switcher.request(toCodex(), { reason: "active" });
  assert.equal(back.ok, true);
  assert.equal(judge.provider, "codex");
  assert.equal(judge.model, getDefaultInterestModel("codex"));

  const second = await switcher.request(toOllama(), { reason: "idle" });
  assert.equal(second.ok, true);
  assert.equal(judge.provider, "ollama");
  assert.equal(judge.model, "qwen3.5:4b");

  const third = await switcher.request(toCodex());
  assert.equal(third.ok, true);
  const fourth = await switcher.request(toOllama());
  assert.equal(fourth.ok, true);

  assert.deepEqual(
    calls.preload.map((target) => `${target.provider}/${target.model}`),
    ["ollama/qwen3.5:4b", "ollama/qwen3.5:4b", "ollama/qwen3.5:4b"],
    "Ollama is preloaded with the saved model each time and Codex needs no preload"
  );
  assert.deepEqual(
    calls.commit.map((entry) => entry.options.reason),
    ["idle", "active", "idle", "manual", "manual"]
  );
  assert.equal(judge.model, "qwen3.5:4b");
});

test("the switcher reports loading and ready statuses with the snapshot", async () => {
  const { calls, switcher, toOllama } = createHarness();
  await switcher.request(toOllama(), { reason: "manual" });
  assert.deepEqual(calls.status.map((status) => status.phase), ["loading", "ready"]);
  assert.equal(calls.status[0].previous.provider, "codex");
  assert.equal(calls.status[1].active.model, "qwen3.5:4b");
  assert.equal(calls.status[1].reason, "manual");
});

test("a failed preload reports the error and leaves the active model untouched", async () => {
  const failure = new Error("model not found");
  let failing = true;
  const { judge, calls, switcher, toOllama } = createHarness({
    preload: async () => {
      if (failing) throw failure;
    }
  });
  const before = { ...judge };
  const result = await switcher.request(toOllama());
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.equal(result.superseded, undefined);
  assert.equal(result.target.model, "qwen3.5:4b");
  assert.equal(result.previous.provider, "codex");
  assert.equal(calls.commit.length, 0);
  assert.equal(judge.provider, before.provider);
  assert.equal(judge.model, before.model);
  assert.equal(calls.timers.length, 0, "nothing to unload after a failed switch");
  assert.deepEqual(calls.status.map((status) => status.phase), ["loading", "failed"]);
  assert.equal(calls.status[1].error, failure);

  // A later request still works after a failure.
  failing = false;
  assert.equal((await switcher.request(toOllama())).ok, true);
  assert.equal(judge.provider, "ollama");
});

test("a switch to a non-Ollama provider skips the preload", async () => {
  const { calls, switcher, toCodex } = createHarness();
  const result = await switcher.request(toCodex());
  assert.equal(result.ok, true);
  assert.equal(calls.preload.length, 0);
  assert.equal(calls.commit.length, 1);
});

test("a throwing commit rejects that request but not the following ones", async () => {
  let fail = true;
  const { judge, switcher, toOllama, toCodex } = createHarness({
    commit: async () => {
      if (fail) throw new Error("commit failed");
    }
  });
  await assert.rejects(() => switcher.request(toOllama()), /commit failed/);
  assert.equal(judge.provider, "codex");
  fail = false;
  const result = await switcher.request(toCodex());
  assert.equal(result.ok, true);
});

test("a newer request supersedes an older one whose preload is still running", async () => {
  const gate = createDeferred();
  let preloads = 0;
  const { judge, calls, switcher } = createHarness({
    preload: async () => {
      preloads += 1;
      if (preloads === 1) await gate.promise;
    }
  });
  const targetA = { provider: "ollama", model: "qwen3.5:4b", baseUrl: OLLAMA_URL };
  const targetB = { provider: "ollama", model: "gemma4:e4b-it-qat", baseUrl: OLLAMA_URL };

  const a = switcher.request(targetA, { reason: "a" });
  await flush();
  assert.equal(calls.preload.length, 1, "A is preloading");
  const b = switcher.request(targetB, { reason: "b" });
  await flush();
  assert.equal(calls.preload.length, 1, "B waits for A, requests are serialized");

  gate.resolve();
  const [resultA, resultB] = await Promise.all([a, b]);
  assert.equal(resultA.ok, false);
  assert.equal(resultA.superseded, true);
  assert.equal(resultA.target, targetA);
  assert.equal(resultB.ok, true);
  assert.equal(resultB.target, targetB);
  assert.deepEqual(calls.commit.map((entry) => entry.target.model), ["gemma4:e4b-it-qat"], "A was never committed");
  assert.equal(judge.model, "gemma4:e4b-it-qat");
  assert.equal(resultB.previous.provider, "codex", "B saw the configuration that was active, not A's");
  assert.ok(calls.status.some((status) => status.phase === "superseded" && status.target === targetA));
});

test("a request replaced before its turn starts never preloads", async () => {
  const { judge, calls, switcher, toOllama } = createHarness();
  const stale = switcher.request({ provider: "ollama", model: "stale:1b", baseUrl: OLLAMA_URL });
  const fresh = switcher.request(toOllama());
  const [staleResult, freshResult] = await Promise.all([stale, fresh]);
  assert.equal(staleResult.superseded, true);
  assert.equal(freshResult.ok, true);
  assert.deepEqual(calls.preload.map((target) => target.model), ["qwen3.5:4b"]);
  assert.equal(judge.model, "qwen3.5:4b");
});

test("invalidate supersedes a preload that is still running", async () => {
  const gate = createDeferred();
  const { judge, calls, switcher, toOllama } = createHarness({ preload: () => gate.promise });
  const request = switcher.request(toOllama());
  await flush();
  assert.equal(calls.preload.length, 1);
  const before = switcher.generation;
  switcher.invalidate();
  assert.equal(switcher.generation, before + 1);
  gate.resolve();
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.superseded, true);
  assert.equal(calls.commit.length, 0);
  assert.equal(judge.provider, "codex");
  assert.deepEqual(calls.status.map((status) => status.phase), ["loading", "superseded"]);

  // The switcher keeps working after an invalidation.
  assert.equal((await switcher.request(toOllama())).ok, true);
  assert.equal(judge.provider, "ollama");
});

test("the previous Ollama model is unloaded only when its delayed timer fires", async () => {
  const { judge, calls, switcher, toOllama, toCodex } = createHarness({ unloadDelayMs: 4_321 });
  await switcher.request(toOllama());
  assert.equal(calls.timers.length, 0, "leaving Codex has nothing to unload");

  await switcher.request(toCodex());
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delay, 4_321);
  assert.equal(calls.unload.length, 0, "not unloaded before the timer fires");

  calls.timers[0].callback();
  assert.deepEqual(calls.unload, [{ provider: "ollama", model: "qwen3.5:4b", baseUrl: OLLAMA_URL }]);
  assert.equal(judge.provider, "codex");
});

test("a model that became active again is not unloaded when its stale timer fires", async () => {
  const { judge, calls, switcher, toOllama, toCodex } = createHarness();
  await switcher.request(toOllama());
  await switcher.request(toCodex());
  assert.equal(calls.timers.length, 1);

  // Something other than the switcher put the same model back before the timer ran.
  judge.provider = "ollama";
  judge.model = "qwen3.5:4b";
  judge.baseUrl = OLLAMA_URL;
  calls.timers[0].callback();
  assert.equal(calls.unload.length, 0);

  // A different Ollama model being active does not protect the stale one.
  const other = createHarness();
  await other.switcher.request(other.toOllama());
  await other.switcher.request(other.toCodex());
  other.judge.provider = "ollama";
  other.judge.model = "another:1b";
  other.judge.baseUrl = OLLAMA_URL;
  other.calls.timers[0].callback();
  assert.equal(other.calls.unload.length, 1);
});

test("switching back to the model cancels its pending unload", async () => {
  const { judge, calls, switcher, toOllama, toCodex } = createHarness();
  await switcher.request(toOllama());
  await switcher.request(toCodex());
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.cleared.length, 0);

  const result = await switcher.request(toOllama());
  assert.equal(result.ok, true);
  assert.deepEqual(calls.cleared, [calls.timers[0]], "the scheduled unload was cancelled before the preload");
  assert.equal(judge.provider, "ollama");
  assert.equal(calls.timers.length, 1, "leaving Codex schedules nothing new");
  assert.equal(calls.unload.length, 0);
});

test("moving between two Ollama models retires the old one but re-selecting the same model does not", async () => {
  const { calls, switcher } = createHarness();
  const qwen = { provider: "ollama", model: "qwen3.5:4b", baseUrl: OLLAMA_URL };
  const gemma = { provider: "ollama", model: "gemma4:e4b-it-qat", baseUrl: OLLAMA_URL };
  await switcher.request(qwen);
  await switcher.request(qwen);
  assert.equal(calls.timers.length, 0, "an unchanged target schedules no unload");

  await switcher.request(gemma);
  assert.equal(calls.timers.length, 1);
  calls.timers[0].callback();
  assert.deepEqual(calls.unload.map((target) => target.model), ["qwen3.5:4b"]);
});

test("a failing unload does not escape the timer callback", async () => {
  const { calls, switcher, toOllama, toCodex } = createHarness({
    unload: async () => {
      throw new Error("daemon gone");
    }
  });
  await switcher.request(toOllama());
  await switcher.request(toCodex());
  calls.timers[0].callback();
  await flush();
  assert.equal(calls.unload.length, 1);
});
