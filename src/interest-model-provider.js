export const INTEREST_MODEL_PROVIDER_IDS = Object.freeze(["openrouter", "deepseek", "custom", "codex", "ollama"]);

const definitions = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    structuredOutput: "json_schema"
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    structuredOutput: "json_object"
  }),
  custom: Object.freeze({
    id: "custom",
    label: "自定义兼容服务",
    defaultBaseUrl: "",
    defaultModel: "gpt-4o-mini",
    structuredOutput: "json_object"
  }),
  // Runs the judge as a tool-free turn on the local Codex login, so it needs
  // no API key; the Hub answers its chat-completions calls in process.
  codex: Object.freeze({
    id: "codex",
    label: "本机 Codex",
    defaultBaseUrl: "codex://local",
    defaultModel: "gpt-6-luna",
    structuredOutput: "json_object",
    local: true
  }),
  // A model served by the local Ollama daemon through its OpenAI-compatible
  // endpoint; it needs no API key.
  ollama: Object.freeze({
    id: "ollama",
    label: "本机 Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "gemma4:e4b-it-qat",
    structuredOutput: "json_object"
  })
});

export function normalizeInterestModelProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return INTEREST_MODEL_PROVIDER_IDS.includes(provider) ? provider : "openrouter";
}

export function getInterestModelProviderDefinition(value) {
  return definitions[normalizeInterestModelProvider(value)];
}

export function listInterestModelProviders() {
  return INTEREST_MODEL_PROVIDER_IDS.map((id) => ({ ...definitions[id] }));
}

export function getDefaultInterestModel(value) {
  return getInterestModelProviderDefinition(value).defaultModel;
}

export function getDefaultInterestModelBaseUrl(value) {
  return getInterestModelProviderDefinition(value).defaultBaseUrl;
}

export function resolveInterestModelRuntimeConfig(value, config = {}) {
  const provider = normalizeInterestModelProvider(value);
  const definition = getInterestModelProviderDefinition(provider);
  const credentials = {
    openrouter: {
      apiKey: config.openRouterApiKey,
      baseUrl: config.openRouterBaseUrl
    },
    deepseek: {
      apiKey: config.deepSeekApiKey,
      baseUrl: config.deepSeekBaseUrl
    },
    custom: {
      apiKey: config.customInterestModelApiKey,
      baseUrl: config.customInterestModelBaseUrl
    },
    // The placeholder only satisfies the shared "key configured" gate; it is
    // never sent anywhere but the in-process Codex adapter.
    codex: {
      apiKey: "codex-local",
      baseUrl: definition.defaultBaseUrl
    },
    // Ollama ignores the bearer token; the placeholder only satisfies the
    // shared "key configured" gate.
    ollama: {
      apiKey: "ollama-local",
      baseUrl: config.ollamaBaseUrl
    }
  }[provider];
  return {
    ...definition,
    provider,
    apiKey: String(credentials.apiKey || "").trim(),
    baseUrl: String(credentials.baseUrl || definition.defaultBaseUrl || "").trim().replace(/\/+$/, ""),
    apiKeyConfigured: Boolean(String(credentials.apiKey || "").trim())
  };
}

export function buildInterestModelChatCompletion({
  provider: providerValue,
  apiKey,
  model,
  temperature,
  maxTokens,
  stream = true,
  messages,
  responseSchema,
  taskName
}) {
  const provider = normalizeInterestModelProvider(providerValue);
  const definition = getInterestModelProviderDefinition(provider);
  const headers = {
    authorization: `Bearer ${String(apiKey || "").trim()}`,
    "content-type": "application/json"
  };
  const body = {
    model: String(model || definition.defaultModel),
    temperature,
    max_tokens: maxTokens,
    stream: Boolean(stream),
    messages
  };
  if (provider === "openrouter") {
    headers["http-referer"] = "http://localhost:3789";
    headers["x-title"] = `Codex QQ Bot ${String(taskName || "interest model")}`;
    body.reasoning = { effort: "none" };
    body.provider = { require_parameters: true };
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: String(taskName || "qq_interest_model_task"),
        strict: true,
        schema: responseSchema
      }
    };
  } else {
    body.response_format = { type: "json_object" };
  }
  if (provider === "ollama") {
    // Thinking models such as Gemma 4 otherwise reason for seconds before the
    // JSON, and an unloaded model would miss the judge's token deadline. With
    // pictures attached a small model misreads the conversation unless it
    // thinks first, so only those requests pay for a short reasoning pass.
    body.reasoning_effort = hasImageContent(messages) ? "low" : "none";
    body.keep_alive = -1;
  }
  return { provider, headers, body };
}

function hasImageContent(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === "image_url"));
}
