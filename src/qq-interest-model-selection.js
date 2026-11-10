// Keeps one interest-judge model per provider, so switching Codex -> Ollama ->
// Codex -> Ollama comes back to the Ollama model the operator chose instead of
// the provider default. `judge.provider` / `judge.model` remain the live
// runtime pair for older readers; `judge.modelsByProvider` is the persisted
// per-provider override map.

import {
  INTEREST_MODEL_PROVIDER_IDS,
  getDefaultInterestModel,
  normalizeInterestModelProvider
} from "./interest-model-provider.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,160}$/;

export function isValidQqJudgeModelId(value) {
  return MODEL_ID_PATTERN.test(String(value || "").trim());
}

export function normalizeQqJudgeModelsByProvider(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawProvider, rawModel] of Object.entries(value)) {
    const provider = String(rawProvider || "").trim().toLowerCase();
    if (!INTEREST_MODEL_PROVIDER_IDS.includes(provider)) continue;
    const model = String(rawModel || "").trim();
    if (isValidQqJudgeModelId(model)) result[provider] = model;
  }
  return result;
}

// "ollama=qwen3.5:4b,codex=gpt-6-luna" from the deployment environment.
export function parseQqJudgeModelsEnv(value) {
  const pairs = {};
  for (const part of String(value || "").split(/[,;\n]/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    pairs[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  return normalizeQqJudgeModelsByProvider(pairs);
}

export function resolveQqJudgeModelForProvider(judge = {}, provider) {
  const id = normalizeInterestModelProvider(provider);
  const overrides = normalizeQqJudgeModelsByProvider(judge?.modelsByProvider);
  return overrides[id] || getDefaultInterestModel(id);
}

// Records `model` as the choice for `provider`. Choosing the default removes
// the override, so a later change of the built-in default still applies.
export function rememberQqJudgeModelForProvider(judge = {}, provider, model) {
  const id = normalizeInterestModelProvider(provider);
  const overrides = normalizeQqJudgeModelsByProvider(judge?.modelsByProvider);
  const value = String(model || "").trim();
  if (!value || value === getDefaultInterestModel(id)) delete overrides[id];
  else if (isValidQqJudgeModelId(value)) overrides[id] = value;
  judge.modelsByProvider = overrides;
  return overrides;
}

// First load of older settings: a saved model belongs to the provider it was
// saved with. Providers without one keep their defaults.
export function migrateQqJudgeModelSettings(judge = {}, { savedProvider, savedModel, savedModelsByProvider, envModelsByProvider } = {}) {
  const overrides = {
    ...normalizeQqJudgeModelsByProvider(envModelsByProvider),
    ...normalizeQqJudgeModelsByProvider(savedModelsByProvider)
  };
  const provider = normalizeInterestModelProvider(savedProvider || judge?.provider);
  const model = String(savedModel || "").trim();
  const hasSavedMap = savedModelsByProvider && typeof savedModelsByProvider === "object";
  if (!hasSavedMap && model && isValidQqJudgeModelId(model) && model !== getDefaultInterestModel(provider)) {
    overrides[provider] = model;
  }
  judge.modelsByProvider = overrides;
  return overrides;
}

// The full target an interest-model change will run on: one snapshot shared
// by the preload, the commit and the logs.
export function buildQqJudgeModelTarget(judge = {}, provider, { baseUrl = "" } = {}) {
  const id = normalizeInterestModelProvider(provider);
  return {
    provider: id,
    model: resolveQqJudgeModelForProvider(judge, id),
    baseUrl: String(baseUrl || "").trim().replace(/\/+$/, "")
  };
}

// Serializes interest-model target changes. A change that was superseded while
// its preload ran is dropped, so the newest request always wins; a failed
// preload leaves the previous working configuration in place. The previous
// Ollama model is unloaded only after requests still holding its snapshot had
// time to finish.
export function createQqInterestModelSwitcher({
  preload = async () => {},
  unload = async () => {},
  commit,
  getActive,
  unloadDelayMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onStatus = () => {}
} = {}) {
  let generation = 0;
  let chain = Promise.resolve();
  const pendingUnloads = new Map();

  const cancelUnload = (key) => {
    const timer = pendingUnloads.get(key);
    if (timer) {
      clearTimer(timer);
      pendingUnloads.delete(key);
    }
  };

  const scheduleUnload = (previous) => {
    if (previous?.provider !== "ollama" || !previous.model) return;
    const key = `${previous.baseUrl}|${previous.model}`;
    cancelUnload(key);
    const timer = setTimer(() => {
      pendingUnloads.delete(key);
      const active = getActive();
      if (active?.provider === "ollama" && active.model === previous.model && active.baseUrl === previous.baseUrl) return;
      Promise.resolve(unload(previous)).catch(() => {});
    }, unloadDelayMs);
    timer?.unref?.();
    pendingUnloads.set(key, timer);
  };

  function request(target, { reason = "manual" } = {}) {
    const ticket = ++generation;
    const run = async () => {
      if (ticket !== generation) return { ok: false, superseded: true, target };
      const previous = getActive();
      onStatus({ phase: "loading", target, previous, reason });
      if (target.provider === "ollama") {
        cancelUnload(`${target.baseUrl}|${target.model}`);
        try {
          await preload(target);
        } catch (error) {
          onStatus({ phase: "failed", target, previous, reason, error });
          return { ok: false, error, target, previous };
        }
      }
      if (ticket !== generation) {
        onStatus({ phase: "superseded", target, previous, reason });
        return { ok: false, superseded: true, target };
      }
      const active = await commit(target, { reason });
      onStatus({ phase: "ready", target, previous, active, reason });
      const changed = previous && (previous.provider !== target.provider || previous.model !== target.model || previous.baseUrl !== target.baseUrl);
      if (changed) scheduleUnload(previous);
      return { ok: true, target, previous, active };
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  return {
    request,
    get generation() {
      return generation;
    },
    // A settings change from elsewhere invalidates any preload still running.
    invalidate() {
      generation += 1;
    }
  };
}
