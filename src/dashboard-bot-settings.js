import {
  getDefaultInterestModel,
  getDefaultInterestModelBaseUrl,
  INTEREST_MODEL_PROVIDER_IDS,
  listInterestModelProviders,
  normalizeInterestModelProvider
} from "./interest-model-provider.js";
import {
  isValidQqJudgeModelId,
  normalizeQqJudgeModelsByProvider,
  resolveQqJudgeModelForProvider
} from "./qq-interest-model-selection.js";

const BOT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const QQ_GROUP_ID_PATTERN = /^[1-9]\d{4,12}$/;
const MAX_PROACTIVE_GROUPS = 200;
const DEFAULT_QUOTA_SAVER_MODEL = "gpt-6-luna";

// Bounds match the environment parsing in src/config/environment.js.
const BEHAVIOR_NUMBERS = Object.freeze({
  engagedWindowMessages: { min: 0, max: 200, fallback: 30, integer: true },
  stickerMinChance: { min: 0, max: 1, fallback: 0 },
  taskPleadingAsks: { min: 0, max: 10, fallback: 0, integer: true },
  sessionRotateHours: { min: 0, max: 168, fallback: 0 },
  sessionRotateReplies: { min: 0, max: 1000, fallback: 0, integer: true },
  quotaSaverBelow: { min: 0, max: 90, fallback: 0 },
  quotaSaverResumeAt: { min: 1, max: 100, fallback: 50 },
  judgeIdleAfterSeconds: { min: 60, max: 86_400, fallback: 300, integer: true }
});

// Tolerant reader for the persisted or environment-provided values; malformed
// entries fall back instead of stopping the Hub from starting.
export function normalizeQqBehaviorSettings(value, fallback = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const pick = (key) => (source[key] === undefined ? fallback[key] : source[key]);
  const numbers = Object.fromEntries(Object.entries(BEHAVIOR_NUMBERS).map(([key, { min, max, fallback: base, integer }]) => {
    const raw = pick(key);
    const number = raw === null || raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(number)) return [key, base];
    const clamped = Math.max(min, Math.min(max, number));
    return [key, integer ? Math.floor(clamped) : clamped];
  }));
  const groups = pick("proactiveGroupIds");
  const model = String(pick("quotaSaverModel") || "").trim();
  return {
    selfPersonaGenerationEnabled: pick("selfPersonaGenerationEnabled") !== false,
    replyScrubEnabled: pick("replyScrubEnabled") !== false,
    proactiveGroupIds: splitGroupIds(groups).filter((id) => QQ_GROUP_ID_PATTERN.test(id)).slice(0, MAX_PROACTIVE_GROUPS),
    ...numbers,
    quotaSaverModel: BOT_MODEL_PATTERN.test(model) ? model : DEFAULT_QUOTA_SAVER_MODEL,
    judgeIdleSwitchEnabled: pick("judgeIdleSwitchEnabled") === true,
    judgeActiveProvider: normalizeInterestModelProvider(pick("judgeActiveProvider") || "codex"),
    judgeIdleProvider: normalizeInterestModelProvider(pick("judgeIdleProvider") || "ollama")
  };
}

export function readDashboardBotSettings(state) {
  const qq = state?.qq || {};
  const proactive = qq.proactive || {};
  const judge = proactive.judge || {};
  return {
    enhancerEnabled: qq.enhancer?.enabled !== false,
    webLookupEnabled: qq.webLookup?.enabled !== false,
    proactiveEnabled: proactive.enabled === true,
    judgeEnabled: judge.enabled !== false,
    judgeEveryMessages: boundedInteger(proactive.judgeEveryMessages, 1, 1000, 20),
    judgeEveryMinutes: boundedInteger(proactive.judgeEveryMinutes, 0, 1440, 5),
    judgeModel: String(judge.model || ""),
    judgeTimeoutMs: boundedInteger(judge.timeoutMs, 1500, 20000, 6500),
    judgeMaxRecentMessages: boundedInteger(judge.maxRecentMessages, 1, 12, 8),
    judgeProvider: normalizeInterestModelProvider(judge.provider),
    judgeApiKeyConfigured: Boolean(judge.apiKeyConfigured),
    // One saved model per provider, so a backup provider (for example Ollama
    // while Codex is active) can be edited before the switch happens.
    judgeModelsByProvider: normalizeQqJudgeModelsByProvider(judge.modelsByProvider),
    judgeProviders: listInterestModelProviders().map(({ id, label, defaultModel }) => ({
      id,
      label,
      defaultModel,
      model: resolveQqJudgeModelForProvider(judge, id)
    })),
    ...normalizeQqBehaviorSettings(qq.behavior)
  };
}

export function applyDashboardBotSettings(state, input) {
  if (!state?.qq || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Bot settings must be a JSON object");
  }
  const previous = readDashboardBotSettings(state);
  const previousBehavior = state.qq.behavior;
  const previousJudgeBaseUrl = String(state.qq.proactive.judge.baseUrl || "");
  const next = normalizePatch(input, { ...previous, judgeBaseUrl: previousJudgeBaseUrl });

  state.qq.enhancer.enabled = next.enhancerEnabled;
  state.qq.webLookup.enabled = next.webLookupEnabled;
  state.qq.proactive.enabled = next.proactiveEnabled;
  state.qq.proactive.judge.enabled = next.judgeEnabled;
  state.qq.proactive.judgeEveryMessages = next.judgeEveryMessages;
  state.qq.proactive.judgeEveryMinutes = next.judgeEveryMinutes;
  state.qq.proactive.judge.provider = next.judgeProvider;
  state.qq.proactive.judge.model = next.judgeModel;
  state.qq.proactive.judge.modelsByProvider = next.judgeModelsByProvider;
  state.qq.proactive.judge.baseUrl = next.judgeBaseUrl;
  state.qq.proactive.judge.apiKeyConfigured = next.judgeApiKeyConfigured;
  state.qq.proactive.judge.timeoutMs = next.judgeTimeoutMs;
  state.qq.proactive.judge.maxRecentMessages = next.judgeMaxRecentMessages;
  state.qq.behavior = normalizeQqBehaviorSettings(next);

  return {
    settings: readDashboardBotSettings(state),
    restore() {
      state.qq.enhancer.enabled = previous.enhancerEnabled;
      state.qq.webLookup.enabled = previous.webLookupEnabled;
      state.qq.proactive.enabled = previous.proactiveEnabled;
      state.qq.proactive.judge.enabled = previous.judgeEnabled;
      state.qq.proactive.judgeEveryMessages = previous.judgeEveryMessages;
      state.qq.proactive.judgeEveryMinutes = previous.judgeEveryMinutes;
      state.qq.proactive.judge.provider = previous.judgeProvider;
      state.qq.proactive.judge.model = previous.judgeModel;
      state.qq.proactive.judge.modelsByProvider = previous.judgeModelsByProvider;
      state.qq.proactive.judge.baseUrl = previousJudgeBaseUrl;
      state.qq.proactive.judge.apiKeyConfigured = previous.judgeApiKeyConfigured;
      state.qq.proactive.judge.timeoutMs = previous.judgeTimeoutMs;
      state.qq.proactive.judge.maxRecentMessages = previous.judgeMaxRecentMessages;
      state.qq.behavior = previousBehavior;
    }
  };
}

function normalizePatch(input, current) {
  const next = {
    ...current,
    judgeBaseUrl: String(current.judgeBaseUrl || ""),
    judgeApiKeyConfigured: Boolean(current.judgeApiKeyConfigured)
  };
  assignBoolean(input, "enhancerEnabled", next);
  assignBoolean(input, "webLookupEnabled", next);
  assignBoolean(input, "proactiveEnabled", next);
  assignBoolean(input, "judgeEnabled", next);
  assignBoolean(input, "selfPersonaGenerationEnabled", next);
  assignBoolean(input, "replyScrubEnabled", next);
  assignBoolean(input, "judgeIdleSwitchEnabled", next);

  next.judgeEveryMessages = optionalInteger(input, "judgeEveryMessages", 1, 1000, next.judgeEveryMessages);
  next.judgeEveryMinutes = optionalInteger(input, "judgeEveryMinutes", 0, 1440, next.judgeEveryMinutes);
  next.judgeTimeoutMs = optionalInteger(input, "judgeTimeoutMs", 1500, 20000, next.judgeTimeoutMs);
  next.judgeMaxRecentMessages = optionalInteger(input, "judgeMaxRecentMessages", 1, 12, next.judgeMaxRecentMessages);

  next.judgeModelsByProvider = { ...normalizeQqJudgeModelsByProvider(current.judgeModelsByProvider) };
  if (Object.hasOwn(input, "judgeModelsByProvider")) {
    const patch = input.judgeModelsByProvider;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new RangeError("judgeModelsByProvider must be an object of provider to model id");
    }
    for (const [rawProvider, rawModel] of Object.entries(patch)) {
      const provider = String(rawProvider || "").trim().toLowerCase();
      if (!INTEREST_MODEL_PROVIDER_IDS.includes(provider)) {
        throw new RangeError(`judgeModelsByProvider has an unknown provider: ${rawProvider}`);
      }
      const model = String(rawModel ?? "").trim();
      // An empty value goes back to the provider default.
      if (!model || model === getDefaultInterestModel(provider)) delete next.judgeModelsByProvider[provider];
      else if (isValidQqJudgeModelId(model) && BOT_MODEL_PATTERN.test(model)) next.judgeModelsByProvider[provider] = model;
      else throw new RangeError(`judgeModelsByProvider.${provider} must be a valid provider model id`);
    }
    // Only an entry for the active provider changes the live model; editing a
    // backup provider's model leaves the running one alone.
    if (!Object.hasOwn(input, "judgeModel") && !Object.hasOwn(input, "judgeProvider")
      && Object.keys(patch).some((key) => String(key).trim().toLowerCase() === next.judgeProvider)) {
      next.judgeModel = resolveQqJudgeModelForProvider({ modelsByProvider: next.judgeModelsByProvider }, next.judgeProvider);
    }
  }

  if (Object.hasOwn(input, "judgeProvider")) {
    const requested = String(input.judgeProvider || "").trim().toLowerCase();
    if (!INTEREST_MODEL_PROVIDER_IDS.includes(requested)) {
      throw new RangeError(`judgeProvider must be one of: ${INTEREST_MODEL_PROVIDER_IDS.join(", ")}`);
    }
    if (requested !== next.judgeProvider) {
      next.judgeProvider = requested;
      next.judgeModel = resolveQqJudgeModelForProvider({ modelsByProvider: next.judgeModelsByProvider }, requested);
      next.judgeBaseUrl = getDefaultInterestModelBaseUrl(requested);
      next.judgeApiKeyConfigured = false;
    }
  }

  if (Object.hasOwn(input, "judgeModel")) {
    const model = String(input.judgeModel || "").trim();
    if (!model || model.length > 160 || !BOT_MODEL_PATTERN.test(model)) {
      throw new RangeError("judgeModel must be a valid provider model id");
    }
    next.judgeModel = model;
    if (model === getDefaultInterestModel(next.judgeProvider)) delete next.judgeModelsByProvider[next.judgeProvider];
    else next.judgeModelsByProvider[next.judgeProvider] = model;
  }

  for (const [key, { min, max, integer }] of Object.entries(BEHAVIOR_NUMBERS)) {
    next[key] = integer
      ? optionalInteger(input, key, min, max, next[key])
      : optionalNumber(input, key, min, max, next[key]);
  }
  if (next.quotaSaverBelow > 0 && next.quotaSaverResumeAt <= next.quotaSaverBelow) {
    // Without this gap saver mode would enter and leave on every quota reading,
    // and each change retires every chat thread.
    throw new RangeError("quotaSaverResumeAt must be greater than quotaSaverBelow");
  }

  if (Object.hasOwn(input, "proactiveGroupIds")) {
    const groups = [...new Set(splitGroupIds(input.proactiveGroupIds))];
    const invalid = groups.find((id) => !QQ_GROUP_ID_PATTERN.test(id));
    if (invalid !== undefined) throw new RangeError(`proactiveGroupIds contains an invalid group id: ${invalid}`);
    if (groups.length > MAX_PROACTIVE_GROUPS) {
      throw new RangeError(`proactiveGroupIds must list at most ${MAX_PROACTIVE_GROUPS} groups`);
    }
    next.proactiveGroupIds = groups;
  }

  if (Object.hasOwn(input, "quotaSaverModel")) {
    const model = String(input.quotaSaverModel || "").trim();
    if (!model || model.length > 160 || !BOT_MODEL_PATTERN.test(model)) {
      throw new RangeError("quotaSaverModel must be a valid model id");
    }
    next.quotaSaverModel = model;
  }

  for (const key of ["judgeActiveProvider", "judgeIdleProvider"]) {
    if (!Object.hasOwn(input, key)) continue;
    const requested = String(input[key] || "").trim().toLowerCase();
    if (!INTEREST_MODEL_PROVIDER_IDS.includes(requested)) {
      throw new RangeError(`${key} must be one of: ${INTEREST_MODEL_PROVIDER_IDS.join(", ")}`);
    }
    next[key] = requested;
  }

  if (Object.hasOwn(input, "proactiveEnabled") && next.proactiveEnabled) next.enhancerEnabled = true;
  else if (!next.enhancerEnabled) next.proactiveEnabled = false;
  return next;
}

function assignBoolean(input, key, output) {
  if (!Object.hasOwn(input, key)) return;
  if (typeof input[key] !== "boolean") throw new TypeError(`${key} must be a boolean`);
  output[key] = input[key];
}

function optionalInteger(input, key, min, max, fallback) {
  if (!Object.hasOwn(input, key)) return fallback;
  const number = Number(input[key]);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${key} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function optionalNumber(input, key, min, max, fallback) {
  if (!Object.hasOwn(input, key)) return fallback;
  const number = input[key] === null || input[key] === "" ? Number.NaN : Number(input[key]);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${key} must be a number between ${min} and ${max}`);
  }
  return number;
}

function splitGroupIds(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[\s,，]+/);
  return parts.map((id) => String(id).trim()).filter(Boolean);
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
