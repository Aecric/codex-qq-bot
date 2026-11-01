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
