import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodexInterestFetch,
  formatInterestMessagesAsPrompt
} from "../src/infrastructure/codex/codex-interest-fetch.js";
import { resolveInterestModelRuntimeConfig } from "../src/interest-model-provider.js";

test("the codex interest provider needs no API key and is served locally", () => {
  const runtime = resolveInterestModelRuntimeConfig("codex", {});
  assert.equal(runtime.provider, "codex");
  assert.equal(runtime.local, true);
  assert.equal(runtime.apiKeyConfigured, true);
  assert.equal(runtime.defaultModel, "gpt-6-luna");
});

test("chat messages become one prompt with images reduced to a placeholder", () => {
  const prompt = formatInterestMessagesAsPrompt([
    { role: "system", content: "只输出 JSON" },
    { role: "user", content: [{ type: "text", text: "这图好看吗" }, { type: "image_url", image_url: { url: "data:x" } }] }
  ]);
  assert.match(prompt, /【system】\n只输出 JSON/);
  assert.match(prompt, /【user】\n这图好看吗\n\[图片\]/);
});

test("answers like a non-streaming chat-completions endpoint", async () => {
  const calls = [];
  const fetch = createCodexInterestFetch({
    runTurn: async (request) => {
      calls.push(request);
      return '{"shouldReply":true,"interest":0.7,"reason":"接得上"}';
    }
  });
  const response = await fetch("codex://local/chat/completions", {
    body: JSON.stringify({ model: "gpt-6-luna", messages: [{ role: "user", content: "在吗" }] })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const payload = await response.json();
  assert.equal(JSON.parse(payload.choices[0].message.content).shouldReply, true);
  assert.equal(calls[0].model, "gpt-6-luna");
});

test("a failed turn becomes an HTTP error and an abort stops waiting", async () => {
  const failing = createCodexInterestFetch({ runTurn: async () => { throw new Error("quota"); } });
  const failed = await failing("codex://local", { body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error.message, /quota/);

  const controller = new AbortController();
  const hanging = createCodexInterestFetch({ runTurn: () => new Promise(() => {}) });
  const pending = hanging("codex://local", {
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
