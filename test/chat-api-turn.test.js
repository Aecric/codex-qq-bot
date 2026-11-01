import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_API_PROVIDERS,
  describeChatApiHost,
  applyChatCompletionChunk,
  buildChatUserContent,
  parseStructuredOutput,
  resolveInsideRoots,
  runChatApiTurn
} from "../src/infrastructure/chat-api/chat-api-turn.js";
import { describeAgentEngine } from "../src/infrastructure/agent/agent-engines.js";
import { selectQqAgentEngine } from "../src/infrastructure/codex/qq-turn-runner.js";
import { createEnvironmentConfig } from "../src/config/environment.js";

const delta = (value, extra = {}) => ({ choices: [{ delta: value, ...extra }] });

function sseResponse(chunks) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function scriptedFetch(script) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error("unexpected extra request");
    return typeof next === "function" ? next(init) : next;
  };
  return { fetch, requests };
}

const connection = { apiKey: "test-key", baseUrl: "https://api.example.test/" };

test("a missing key fails with instructions instead of calling the API", async () => {
  await assert.rejects(
    runChatApiTurn({ provider: "gemini", connection: {}, prompt: "hi", fetch: () => assert.fail("no request") }),
    (error) => error.code === "CHAT_API_KEY_MISSING" && /GEMINI_API_KEY/.test(error.message)
  );
});

test("a turn streams text with auth, model and reasoning settings", async () => {
  const { fetch, requests } = scriptedFetch([sseResponse([delta({ content: "你" }), delta({ content: "好" }, { finish_reason: "stop" })])]);
  const exits = [];
  const result = await runChatApiTurn({
    provider: "deepseek",
    connection,
    model: "deepseek-v4-pro",
    reasoningEffort: "low",
    prompt: "hi",
    developerInstructions: "dev",
    fetch,
    onExit: (child) => exits.push(child)
  });
  assert.equal(result.finalResponse, "你好");
  assert.equal(result.threadId, null);
  assert.equal(exits.length, 1);
  assert.equal(requests[0].url, "https://api.example.test/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "deepseek-v4-pro");
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.match(requests[0].body.messages[0].content, /dev/);
  assert.equal(requests[0].body.tools, undefined);
});

test("tool rounds replay provider fields and dispatch QQ tools", async () => {
  const signature = { google: { thought_signature: "sig" } };
  const { fetch, requests } = scriptedFetch([
    sseResponse([delta({
      reasoning_content: "想一想",
      content: "我查一下",
      // Gemini sends whole calls without an index.
      tool_calls: [{ id: "c1", type: "function", function: { name: "qq_context__history", arguments: "{\"query\":\"最近 5\"}" }, extra_content: signature }]
    }, { finish_reason: "tool_calls" })]),
    sseResponse([delta({ content: "好了" }, { finish_reason: "stop" })])
  ]);
  const calls = [];
  const progress = [];
  const result = await runChatApiTurn({
    provider: "gemini",
    connection,
    model: "gemini-test",
    prompt: "hi",
    fetch,
    dynamicTools: [{
      type: "namespace",
      name: "qq_context",
      description: "ctx",
      tools: [{ type: "function", name: "history", description: "h", inputSchema: { type: "object", properties: {} } }]
    }],
    onDynamicToolCall: async (call) => {
      calls.push(call);
      return { ok: true, lines: 5 };
    },
    onProgress: (event) => progress.push(event.text)
  });
  assert.equal(result.finalResponse, "好了");
  assert.equal(calls[0].namespace, "qq_context");
  assert.equal(calls[0].tool, "history");
  assert.deepEqual(calls[0].arguments, { query: "最近 5" });
  assert.deepEqual(progress, ["我查一下"]);
  assert.equal(requests[0].body.tools[0].function.name, "qq_context__history");
  const [assistant, toolMessage] = requests[1].body.messages.slice(2);
  assert.equal(assistant.reasoning_content, "想一想");
  assert.deepEqual(assistant.tool_calls[0].extra_content, signature);
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.match(toolMessage.content, /"lines":5/);
});

test("streamed tool call fragments merge by index", () => {
  const reply = { content: "", reasoningContent: "", extraContent: null, toolCalls: [], finishReason: null, usage: null };
  applyChatCompletionChunk(reply, delta({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "x", arguments: "{\"q" } }] }));
  applyChatCompletionChunk(reply, delta({ tool_calls: [{ index: 0, id: null, function: { arguments: "\":1}" } }] }));
  applyChatCompletionChunk(reply, delta({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "y", arguments: "{}" } }] }));
  assert.equal(reply.toolCalls.length, 2);
  assert.equal(reply.toolCalls[0].function.arguments, "{\"q\":1}");
  assert.equal(reply.toolCalls[1].function.name, "y");
});

test("invalid structured output gets one repair round", async () => {
  const schema = { type: "object", required: ["status"], properties: { status: { type: "string" } } };
  const { fetch, requests } = scriptedFetch([
    sseResponse([delta({ content: "不是 JSON" }, { finish_reason: "stop" })]),
    sseResponse([delta({ content: "```json\n{\"status\":\"reply\"}\n```" }, { finish_reason: "stop" })])
  ]);
  const result = await runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", outputSchema: schema, fetch });
  assert.deepEqual(JSON.parse(result.finalResponse), { status: "reply" });
  assert.equal(requests[0].body.response_format.type, "json_object");
  assert.equal(parseStructuredOutput("{}", schema), null);
});

test("transient failures retry, permanent ones surface without the key", async () => {
  const retried = scriptedFetch([
    new Response("busy", { status: 503 }),
    sseResponse([delta({ content: "ok" }, { finish_reason: "stop" })])
  ]);
  const result = await runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", fetch: retried.fetch, retryDelaysMs: [1] });
  assert.equal(result.finalResponse, "ok");

  const failed = scriptedFetch([new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })]);
  await assert.rejects(
    runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", fetch: failed.fetch }),
    (error) => error.code === "CODEX_TURN_FAILED" && /bad key/.test(error.message) && !error.message.includes("test-key")
  );
});

test("a rejected reasoning level is dropped and retried", async () => {
  const { fetch, requests } = scriptedFetch([
    new Response(JSON.stringify({ error: { message: "Thinking level MEDIUM is not supported" } }), { status: 400 }),
    sseResponse([delta({ content: "ok" }, { finish_reason: "stop" })])
  ]);
  await runChatApiTurn({ provider: "gemini", connection, prompt: "hi", reasoningEffort: "medium", fetch });
  assert.equal(requests[0].body.reasoning_effort, "medium");
  assert.equal(requests[1].body.reasoning_effort, undefined);
});

test("reasoning levels map onto what each provider accepts", () => {
  assert.deepEqual(CHAT_API_PROVIDERS.deepseek.reasoningFields("minimal"), { thinking: { type: "disabled" } });
  assert.equal(CHAT_API_PROVIDERS.deepseek.reasoningFields("ultra").reasoning_effort, "max");
  assert.equal(CHAT_API_PROVIDERS.gemini.reasoningFields("minimal").reasoning_effort, "low");
  assert.equal(CHAT_API_PROVIDERS.gemini.reasoningFields("xhigh").reasoning_effort, "high");
  assert.deepEqual(CHAT_API_PROVIDERS.gemini.reasoningFields(null), {});
});

test("restart replaces the in-flight request and steer feeds the next one", async () => {
  let controls;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { fetch, requests } = scriptedFetch([
    (init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      release();
    }),
    sseResponse([delta({ content: "新的回答" }, { finish_reason: "stop" })])
  ]);
  const restarted = [];
  const turn = runChatApiTurn({
    provider: "deepseek",
    connection,
    prompt: "旧问题",
    fetch,
    onReady: (value) => { controls = value; },
    onRestarted: (value) => restarted.push(value)
  });
  await held;
  await controls.restart([{ type: "text", text: "新问题" }]);
  const result = await turn;
  assert.equal(result.finalResponse, "新的回答");
  assert.equal(result.deadlineRenewalCount, 1);
  assert.equal(restarted.length, 1);
  assert.deepEqual(requests[1].body.messages.at(-1), { role: "user", content: "新问题" });
  await assert.rejects(controls.steer("迟到"), (error) => error.code === "CODEX_TURN_NOT_ACTIVE");
});

test("killing the stand-in child stops the turn", async () => {
  let child;
  const { fetch } = scriptedFetch([(init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  })]);
  const turn = runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", fetch, onSpawn: (value) => { child = value; } });
  child.kill("SIGTERM");
  await assert.rejects(turn, (error) => error.code === "ABORT_ERR");
});

test("file tools stay inside the sandbox roots and are absent when read-only", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cqb-chat-api-")));
  try {
    const root = join(base, "root");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "secret");
    symlinkSync(join(base, "secret.txt"), join(root, "link.txt"));
    symlinkSync(base, join(root, "dirlink"));
    const options = { cwd: root, roots: [root] };
    await assert.rejects(resolveInsideRoots("../secret.txt", options), /不在本轮允许/);
    await assert.rejects(resolveInsideRoots("link.txt", options), /不在本轮允许/);
    await assert.rejects(resolveInsideRoots("dirlink/new.txt", { ...options, forWrite: true }), /不在本轮允许/);
    assert.equal(await resolveInsideRoots("sub/new.txt", { ...options, forWrite: true }), join(root, "sub", "new.txt"));

    const { fetch, requests } = scriptedFetch([
      sseResponse([delta({ tool_calls: [{ id: "w", type: "function", function: { name: "builtin__write_file", arguments: JSON.stringify({ path: "../escape.txt", content: "x" }) } }] })]),
      sseResponse([delta({ content: "done" }, { finish_reason: "stop" })])
    ]);
    await runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", cwd: root, sandbox: "workspace-write", fetch });
    assert.match(requests[1].body.messages.at(-1).content, /不在本轮允许/);

    const readOnly = scriptedFetch([sseResponse([delta({ content: "ok" }, { finish_reason: "stop" })])]);
    await runChatApiTurn({ provider: "deepseek", connection, prompt: "hi", cwd: root, sandbox: "read-only", fetch: readOnly.fetch });
    assert.equal(readOnly.requests[0].body.tools, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the displayed API host never carries credentials or paths", () => {
  assert.equal(describeChatApiHost("https://user:secret@relay.example.test:8443/v1?key=abc"), "relay.example.test:8443");
  assert.equal(describeChatApiHost("not a url"), null);
});

test("images are sent only to vision providers", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(12)]);
  const input = [{ type: "text", text: "看" }, { type: "localImage", path: "/a.png" }];
  const vision = buildChatUserContent(input, { vision: true, readFile: () => png });
  assert.match(vision[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(buildChatUserContent(input, { vision: false }), /看不了图片/);
});

test("engine table and configuration expose the API engines", () => {
  for (const id of ["deepseek", "gemini"]) {
    const engine = selectQqAgentEngine(id);
    assert.equal(engine.id, id);
    assert.equal(engine.canResume("claude:abc"), false);
    assert.equal(engine.buildEnv(), undefined);
    assert.equal(engine.reportsQuota, false);
  }
  assert.equal(describeAgentEngine("gemini", { geminiAgentModel: "g", ai: { reasoningEffort: "low" } }).model, "g");
  assert.equal(describeAgentEngine("deepseek", { deepseekModel: "d" }).model, "d");
  const config = createEnvironmentConfig({
    CODEX_REMOTE_CONTACT_AGENT_ENGINE: "Gemini",
    CODEX_REMOTE_CONTACT_GEMINI_AGENT_MODEL: "gemini-main",
    GEMINI_BASE_URL: "https://relay.example.test/v1"
  });
  assert.equal(config.agentEngine, "gemini");
  assert.equal(config.geminiAgentModel, "gemini-main");
  assert.equal(config.geminiBaseUrl, "https://relay.example.test/v1");
  assert.equal(createEnvironmentConfig({}).deepseekModel, "deepseek-v4-pro");
});
