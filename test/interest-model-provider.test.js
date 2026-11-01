import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInterestModelChatCompletion,
  getDefaultInterestModel,
  resolveInterestModelRuntimeConfig
} from "../src/interest-model-provider.js";

const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false
};

test("resolves provider-specific credentials and current defaults", () => {
  assert.equal(getDefaultInterestModel("openrouter"), "openrouter/free");
  assert.equal(getDefaultInterestModel("deepseek"), "deepseek-v4-flash");
  assert.deepEqual(resolveInterestModelRuntimeConfig("deepseek", {
    deepSeekApiKey: "deep-key",
    deepSeekBaseUrl: "https://deepseek.example/v1/"
  }), {
    id: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    structuredOutput: "json_object",
    provider: "deepseek",
    apiKey: "deep-key",
    baseUrl: "https://deepseek.example/v1",
    apiKeyConfigured: true
  });
});

test("builds OpenRouter strict-schema requests with provider-only fields", () => {
  const request = buildInterestModelChatCompletion({
    provider: "openrouter",
    apiKey: "key",
    model: "openrouter/free",
    temperature: 0.2,
    maxTokens: 500,
    messages: [],
    responseSchema: schema,
    taskName: "test_task"
  });
  assert.equal(request.body.response_format.type, "json_schema");
  assert.deepEqual(request.body.response_format.json_schema.schema, schema);
  assert.deepEqual(request.body.reasoning, { effort: "none" });
  assert.deepEqual(request.body.provider, { require_parameters: true });
  assert.equal(request.headers["x-title"], "Codex QQ Bot test_task");
});

test("builds DeepSeek and custom JSON-object requests without OpenRouter-only fields", () => {
  for (const provider of ["deepseek", "custom"]) {
    const request = buildInterestModelChatCompletion({
      provider,
      apiKey: "key",
      model: "compatible-model",
      temperature: 0.2,
      maxTokens: 500,
      messages: [],
      responseSchema: schema,
      taskName: "test_task"
    });
    assert.deepEqual(request.body.response_format, { type: "json_object" });
    assert.equal("reasoning" in request.body, false);
    assert.equal("provider" in request.body, false);
    assert.equal("http-referer" in request.headers, false);
  }
});

test("routes the ollama provider to the local daemon without a key and with thinking off", () => {
  assert.equal(getDefaultInterestModel("ollama"), "gemma4:e4b-it-qat");
  const runtime = resolveInterestModelRuntimeConfig("ollama", { ollamaBaseUrl: "http://127.0.0.1:11434/v1/" });
  assert.equal(runtime.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(runtime.apiKeyConfigured, true);
  assert.equal(resolveInterestModelRuntimeConfig("ollama").baseUrl, "http://127.0.0.1:11434/v1");

  const request = buildInterestModelChatCompletion({
    provider: "ollama",
    apiKey: runtime.apiKey,
    model: "gemma4:e4b",
    temperature: 0.2,
    maxTokens: 500,
    messages: [],
    responseSchema: schema,
    taskName: "test_task"
  });
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.reasoning_effort, "none");
  assert.equal(request.body.keep_alive, -1);
  assert.equal("reasoning" in request.body, false);

  const withImage = buildInterestModelChatCompletion({
    provider: "ollama",
    apiKey: runtime.apiKey,
    model: "gemma4:e4b",
    messages: [{ role: "user", content: [{ type: "text", text: "{}" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }],
    responseSchema: schema
  });
  assert.equal(withImage.body.reasoning_effort, "low");
});
