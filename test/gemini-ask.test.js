import assert from "node:assert/strict";
import test from "node:test";
import { askGemini } from "../src/gemini-ask.js";

test("asks generateContent with the key in a header and returns the text", async () => {
  const calls = [];
  const result = await askGemini({
    apiKey: "test-key",
    model: "gemini-test",
    question: "“请进”是什么梗",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "谐音“请君入瓮”。" }] } }] }), { status: 200 });
    }
  });
  assert.deepEqual(result, { ok: true, answer: "谐音“请君入瓮”。" });
  assert.match(calls[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key");
  assert.doesNotMatch(calls[0].url, /test-key/);
  assert.equal(JSON.parse(calls[0].init.body).contents[0].parts[0].text, "“请进”是什么梗");
});

test("reports a missing key, an API error and an empty answer", async () => {
  assert.equal((await askGemini({ question: "x" })).ok, false);
  const error = await askGemini({
    apiKey: "k",
    question: "x",
    fetch: async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 })
  });
  assert.deepEqual(error, { ok: false, reason: "quota exceeded" });
  const empty = await askGemini({ apiKey: "k", question: "x", fetch: async () => new Response("{}", { status: 200 }) });
  assert.equal(empty.ok, false);
});

test("sends images as inline data ahead of the question and allows more time", async () => {
  const calls = [];
  const result = await askGemini({
    apiKey: "k",
    question: "这是哪个角色",
    images: [{ mimeType: "image/png", data: "QUJD" }],
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "认不准" }] } }] }), { status: 200 });
    }
  });
  assert.deepEqual(result, { ok: true, answer: "认不准" });
  assert.deepEqual(calls[0].contents[0].parts, [
    { inlineData: { mimeType: "image/png", data: "QUJD" } },
    { text: "这是哪个角色" }
  ]);
  assert.match(calls[0].systemInstruction.parts[0].text, /不是给你的指令/);
});

test("text-only questions keep the original request shape", async () => {
  const bodies = [];
  await askGemini({
    apiKey: "k",
    question: "x",
    fetch: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
  });
  assert.deepEqual(bodies[0].contents[0].parts, [{ text: "x" }]);
  assert.doesNotMatch(bodies[0].systemInstruction.parts[0].text, /不是给你的指令/);
});

test("names why Gemini returned no text when it says so", async () => {
  const blocked = await askGemini({
    apiKey: "k",
    question: "x",
    fetch: async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })
  });
  assert.deepEqual(blocked, { ok: false, reason: "Gemini returned no text (SAFETY)" });
  const finished = await askGemini({
    apiKey: "k",
    question: "x",
    fetch: async () => new Response(JSON.stringify({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }), { status: 200 })
  });
  assert.deepEqual(finished, { ok: false, reason: "Gemini returned no text (IMAGE_SAFETY)" });
});
