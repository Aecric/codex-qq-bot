import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  loadSamples,
  main,
  parseArgs,
  predictSample,
  resolveReplayModelConfig,
  runReplay,
  summarize
} from "../scripts/qq-addressing-replay.mjs";
import { QQ_ALIAS_ADDRESS_PROMPT_VERSION } from "../src/qq-addressing.js";

const fixtureUrl = new URL("./fixtures/qq-addressing-replay-sample.jsonl", import.meta.url);

function makeSample(overrides = {}) {
  return {
    id: "t1",
    stratum: "nickname_call",
    aliases: ["小白"],
    assistantName: "小白",
    event: { type: "group_message", groupId: "10001", senderLabel: "群友A", text: "小白你看看这个", raw: { message_id: "m1" } },
    recent: [{ messageId: "m0", senderLabel: "群友B", text: "合成的上一条消息" }],
    expected: "bot",
    ...overrides
  };
}

function judgedOk(target, reasonCode) {
  return async () => ({ ok: true, provider: "ollama", model: "fake", value: { target, reasonCode }, attemptCount: 1, formatRetryCount: 0 });
}

function captureIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    io: { stdout: { write: (chunk) => out.push(String(chunk)) }, stderr: { write: (chunk) => err.push(String(chunk)) }, env: {}, ...extra }
  };
}

test("parseArgs returns defaults", () => {
  assert.deepEqual(parseArgs([]), {
    input: null,
    mode: "judge",
    provider: "ollama",
    model: null,
    baseUrl: null,
    timeoutMs: 5000,
    concurrency: 1,
    json: false,
    help: false
  });
});

test("parseArgs reads overrides in both flag forms", () => {
  const options = parseArgs([
    "--input", "samples.jsonl",
    "--provider", "Ollama",
    "--model=qwen3.5:4b",
    "--base-url", "http://127.0.0.1:11434/v1",
    "--timeout-ms", "8000",
    "--mode=heuristic",
    "--concurrency", "3",
    "--json"
  ]);
  assert.equal(options.input, "samples.jsonl");
  assert.equal(options.provider, "ollama");
  assert.equal(options.model, "qwen3.5:4b");
  assert.equal(options.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(options.timeoutMs, 8000);
  assert.equal(options.mode, "heuristic");
  assert.equal(options.concurrency, 3);
  assert.equal(options.json, true);
});

test("parseArgs rejects bad values and unknown flags", () => {
  assert.throws(() => parseArgs(["--mode", "shadow"]), /--mode must be one of/);
  assert.throws(() => parseArgs(["--provider", "nope"]), /--provider must be one of/);
  assert.throws(() => parseArgs(["--timeout-ms", "10"]), /--timeout-ms/);
  assert.throws(() => parseArgs(["--concurrency", "0"]), /--concurrency/);
  assert.throws(() => parseArgs(["--concurrency", "2.5"]), /--concurrency/);
  assert.throws(() => parseArgs(["--model"]), /--model needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  assert.throws(() => parseArgs(["stray"]), /unexpected argument/);
});

test("loadSamples skips blank lines and normalizes samples", () => {
  const line = JSON.stringify({ id: "a", expected: "Bot", aliases: [" 小白 "], event: { text: "hi" } });
  const samples = loadSamples(`\n${line}\n\r\n   \n`);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].id, "a");
  assert.equal(samples[0].expected, "bot");
  assert.equal(samples[0].stratum, "unspecified");
  assert.deepEqual(samples[0].aliases, ["小白"]);
  assert.equal(samples[0].assistantName, "小白");
  assert.equal(samples[0].event.type, "group_message");
  assert.deepEqual(samples[0].recent, []);
});

test("loadSamples reports the line number without echoing the line", () => {
  const good = JSON.stringify({ id: "a", expected: "bot", event: { text: "x" } });
  const text = `${good}\n\n{"id":"secret-text-here", oops\n`;
  assert.throws(() => loadSamples(text), (error) => {
    assert.match(error.message, /^line 3: invalid JSON$/);
    assert.doesNotMatch(error.message, /secret-text-here/);
    return true;
  });
});

test("loadSamples validates fields and rejects duplicate ids", () => {
  const sample = (patch) => JSON.stringify({ id: "a", expected: "bot", event: { text: "x" }, ...patch });
  assert.throws(() => loadSamples(sample({ id: "" })), /line 1: missing id/);
  assert.throws(() => loadSamples(sample({ expected: "maybe" })), /line 1: expected must be one of/);
  assert.throws(() => loadSamples(sample({ event: "text" })), /line 1: event must be an object/);
  assert.throws(() => loadSamples(sample({ event: {} })), /line 1: event.text must be a string/);
  assert.throws(() => loadSamples(sample({ aliases: "小白" })), /line 1: aliases must be an array/);
  assert.throws(() => loadSamples("[1]"), /line 1: sample must be a JSON object/);
  assert.throws(() => loadSamples(`${sample({})}\n${sample({})}`), /line 2: duplicate sample id "a"/);
});

test("the synthetic fixture loads and covers every stratum", async () => {
  const samples = loadSamples(await readFile(fixtureUrl, "utf8"));
  assert.ok(samples.length >= 12);
  const strata = new Set(samples.map((sample) => sample.stratum));
  for (const stratum of ["nickname_call", "third_person_mention", "explicit_at", "reply_to_bot", "follow_up", "asking_other", "public_help", "image_split"]) {
    assert.ok(strata.has(stratum), `missing stratum ${stratum}`);
  }
  assert.ok(samples.every((sample) => ["bot", "other", "unclear"].includes(sample.expected)));
});

test("legacy mode calls the bot on any alias substring or protocol address", async () => {
  const [mention] = loadSamples(JSON.stringify({ id: "m", expected: "other", aliases: ["小白"], event: { text: "小白昨天也说过" } }));
  const [none] = loadSamples(JSON.stringify({ id: "n", expected: "other", aliases: ["小白"], event: { text: "今天吃什么" } }));
  const [reply] = loadSamples(JSON.stringify({ id: "r", expected: "bot", aliases: ["小白"], event: { text: "好的", isReplyToSelf: true } }));
  const [at] = loadSamples(JSON.stringify({ id: "a", expected: "bot", aliases: ["小白"], event: { text: "[CQ:at,qq=10000] 在吗", hasSelfAtSegment: true } }));
  assert.equal((await predictSample(mention, { mode: "legacy" })).predicted, "bot");
  assert.equal((await predictSample(none, { mode: "legacy" })).predicted, "other");
  const replyResult = await predictSample(reply, { mode: "legacy" });
  assert.equal(replyResult.predicted, "bot");
  assert.equal(replyResult.reasonCode, "protocol_reply_to_bot");
  assert.equal((await predictSample(at, { mode: "legacy" })).reasonCode, "protocol_explicit_at");
  assert.equal(replyResult.modelCalled, false);
});

test("heuristic mode uses protocol facts and the vocative check", async () => {
  const sample = (text, extra = {}) => loadSamples(JSON.stringify({ id: "h", expected: "bot", aliases: ["小白"], event: { text, ...extra } }))[0];
  const vocative = await predictSample(sample("小白你看看这个"), { mode: "heuristic" });
  assert.equal(vocative.predicted, "bot");
  assert.equal(vocative.reasonCode, "direct_call");
  assert.equal(vocative.source, "heuristic");
  const narration = await predictSample(sample("小白昨天也说过这个问题"), { mode: "heuristic" });
  assert.equal(narration.predicted, "unclear");
  assert.equal(narration.reasonCode, "ambiguous");
  const protocol = await predictSample(sample("好的", { isReplyToSelf: true }), { mode: "heuristic" });
  assert.equal(protocol.predicted, "bot");
  assert.equal(protocol.source, "protocol");
});

test("judge mode skips the model for protocol addresses and non-candidates", async () => {
  let calls = 0;
  const runTask = async () => {
    calls += 1;
    return { ok: true, value: { target: "bot", reasonCode: "direct_call" } };
  };
  const make = (event) => loadSamples(JSON.stringify({ id: "j", expected: "bot", aliases: ["小白"], event }))[0];
  const protocol = await predictSample(make({ text: "好的", isReplyToSelf: true }), { mode: "judge", runTask });
  const none = await predictSample(make({ text: "今天吃什么" }), { mode: "judge", runTask });
  assert.equal(calls, 0);
  assert.equal(protocol.predicted, "bot");
  assert.equal(protocol.modelCalled, false);
  assert.equal(none.predicted, "other");
  assert.equal(none.reasonCode, "no_alias_hit");
  assert.equal(none.modelCalled, false);
});

test("judge mode sends the alias payload and returns the model verdict", async () => {
  const seen = [];
  const runTask = async (request) => {
    seen.push(request);
    return { ok: true, provider: "ollama", model: "fake-model", value: { target: "other", reasonCode: "talking_about_bot" }, attemptCount: 1, formatRetryCount: 1 };
  };
  let tick = 0;
  const now = () => {
    tick += 40;
    return tick;
  };
  const model = { provider: "ollama", apiKey: "ollama-local", baseUrl: "http://127.0.0.1:11434/v1", model: "fake-model" };
  const sample = makeSample({ expected: "other", event: { type: "group_message", groupId: "10001", senderLabel: "群友A", text: "小白昨天也说过", raw: { message_id: "m1" } } });
  const result = await predictSample(sample, { mode: "judge", runTask, model, timeoutMs: 4000, now });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskName, "qq_alias_address");
  assert.equal(seen[0].model, "fake-model");
  assert.equal(seen[0].baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(seen[0].timeoutMs, 4000);
  assert.equal(seen[0].payload.bot.name, "小白");
  assert.equal(seen[0].payload.current.text, "小白昨天也说过");
  assert.equal(seen[0].payload.recent.length, 1);
  assert.equal(result.predicted, "other");
  assert.equal(result.reasonCode, "talking_about_bot");
  assert.equal(result.source, "judge");
  assert.equal(result.modelCalled, true);
  assert.equal(result.failed, false);
  assert.equal(result.durationMs, 40);
  assert.equal(result.formatRetryCount, 1);
});

test("judge mode maps failures, timeouts and invalid output to silent unclear", async () => {
  const sample = makeSample();
  const failing = await predictSample(sample, { mode: "judge", runTask: async () => ({ ok: false, reason: "provider said something private" }) });
  assert.equal(failing.predicted, "unclear");
  assert.equal(failing.failed, true);
  assert.equal(failing.timedOut, false);
  assert.equal(failing.invalidOutput, false);
  assert.equal(failing.reasonCode, "judge_error");
  assert.equal(failing.modelCalled, true);

  const idle = await predictSample(sample, { mode: "judge", runTask: async () => ({ ok: false, reason: "Local Ollama interest task produced no new token for 5000ms" }) });
  assert.equal(idle.timedOut, true);
  assert.equal(idle.reasonCode, "judge_timeout");

  const invalid = await predictSample(sample, { mode: "judge", runTask: async () => ({ ok: false, reason: "interest model did not return valid structured JSON", raw: "model text" }) });
  assert.equal(invalid.invalidOutput, true);
  assert.equal(invalid.timedOut, false);
  assert.equal(invalid.reasonCode, "judge_invalid_output");

  const mismatched = await predictSample(sample, { mode: "judge", runTask: judgedOk("bot", "talking_about_bot") });
  assert.equal(mismatched.predicted, "unclear");
  assert.equal(mismatched.invalidOutput, true);

  const thrown = await predictSample(sample, { mode: "judge", runTask: async () => { throw new Error("boom"); } });
  assert.equal(thrown.predicted, "unclear");
  assert.equal(thrown.failed, true);
  for (const result of [failing, idle, invalid, mismatched, thrown]) {
    assert.doesNotMatch(JSON.stringify(result), /private|model text|boom/);
  }
});

test("judge mode reports a deadline timeout from a hanging model", async () => {
  const runTask = ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" })));
  const result = await predictSample(makeSample(), { mode: "judge", runTask, timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.predicted, "unclear");
  assert.equal(result.reasonCode, "judge_timeout");
});

test("runReplay keeps input order and respects the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const runTask = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { ok: true, value: { target: "bot", reasonCode: "direct_call" } };
  };
  const samples = Array.from({ length: 6 }, (_, index) => makeSample({ id: `c${index}` }));
  const results = await runReplay(samples, { mode: "judge", runTask, concurrency: 2 });
  assert.deepEqual(results.map((result) => result.id), samples.map((sample) => sample.id));
  assert.equal(peak, 2);
  peak = 0;
  await runReplay(samples, { mode: "judge", runTask, concurrency: 1 });
  assert.equal(peak, 1);
});

test("summarize computes miss and false-call rates overall and per stratum", () => {
  const row = (id, stratum, expected, predicted, extra = {}) => ({
    id, stratum, expected, predicted, reasonCode: null, source: "judge", modelCalled: false, failed: false, timedOut: false, invalidOutput: false, durationMs: null, formatRetryCount: 0, ...extra
  });
  const results = [
    row("1", "nickname_call", "bot", "bot", { modelCalled: true, durationMs: 100 }),
    row("2", "nickname_call", "bot", "unclear", { modelCalled: true, durationMs: 300, failed: true, timedOut: true }),
    row("3", "nickname_call", "bot", "bot"),
    row("4", "third_person_mention", "other", "bot", { modelCalled: true, durationMs: 200 }),
    row("5", "third_person_mention", "other", "other", { modelCalled: true, durationMs: 400 }),
    row("6", "third_person_mention", "unclear", "unclear", { modelCalled: true, durationMs: 500, failed: true, invalidOutput: true }),
    row("7", "third_person_mention", "other", "unclear")
  ];
  const report = summarize(results, { mode: "judge", provider: "ollama", model: "qwen3.5:4b", promptVersion: QQ_ALIAS_ADDRESS_PROMPT_VERSION });
  assert.equal(report.mode, "judge");
  assert.equal(report.provider, "ollama");
  assert.equal(report.model, "qwen3.5:4b");
  assert.equal(report.promptVersion, QQ_ALIAS_ADDRESS_PROMPT_VERSION);

  const overall = report.overall;
  assert.equal(overall.samples, 7);
  assert.equal(overall.expectedBot, 3);
  assert.equal(overall.expectedNotBot, 4);
  assert.equal(overall.misses, 1);
  assert.equal(overall.falseCalls, 1);
  assert.equal(overall.missRate, 0.3333);
  assert.equal(overall.falseCallRate, 0.25);
  assert.equal(overall.accuracy, 0.5714);
  assert.equal(overall.routeAccuracy, 0.7143);
  assert.equal(overall.modelCalls, 5);
  assert.equal(overall.failures, 2);
  assert.equal(overall.timeouts, 1);
  assert.equal(overall.invalidOutputs, 1);
  assert.deepEqual(overall.latencyMs, { samples: 5, p50: 300, p95: 500 });

  assert.deepEqual(Object.keys(report.strata), ["nickname_call", "third_person_mention"]);
  const nickname = report.strata.nickname_call;
  assert.equal(nickname.samples, 3);
  assert.equal(nickname.expectedBot, 3);
  assert.equal(nickname.missRate, 0.3333);
  assert.equal(nickname.falseCallRate, null);
  assert.equal(nickname.accuracy, 0.6667);
  assert.equal(nickname.timeouts, 1);
  assert.deepEqual(nickname.latencyMs, { samples: 2, p50: 100, p95: 300 });

  const third = report.strata.third_person_mention;
  assert.equal(third.samples, 4);
  assert.equal(third.expectedBot, 0);
  assert.equal(third.missRate, null);
  assert.equal(third.falseCallRate, 0.25);
  assert.equal(third.accuracy, 0.5);
  assert.equal(third.routeAccuracy, 0.75);
  assert.equal(third.invalidOutputs, 1);
  assert.deepEqual(third.latencyMs, { samples: 3, p50: 400, p95: 500 });
});

test("summarize handles an empty result set", () => {
  const report = summarize([]);
  assert.equal(report.overall.samples, 0);
  assert.equal(report.overall.missRate, null);
  assert.equal(report.overall.falseCallRate, null);
  assert.equal(report.overall.accuracy, null);
  assert.deepEqual(report.overall.latencyMs, { samples: 0, p50: null, p95: null });
  assert.deepEqual(report.strata, {});
});

test("resolveReplayModelConfig applies overrides and guards unusable providers", () => {
  const ollama = resolveReplayModelConfig({ provider: "ollama", model: "qwen3.5:4b", baseUrl: "http://127.0.0.1:11434/v1/" }, {});
  assert.equal(ollama.provider, "ollama");
  assert.equal(ollama.model, "qwen3.5:4b");
  assert.equal(ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.ok(ollama.apiKey);
  const defaults = resolveReplayModelConfig({ provider: "ollama" }, { OLLAMA_BASE_URL: "http://127.0.0.1:9999/v1" });
  assert.equal(defaults.model, "gemma4:e4b-it-qat");
  assert.equal(defaults.baseUrl, "http://127.0.0.1:9999/v1");
  assert.equal(resolveReplayModelConfig({ provider: "ollama" }, {}).baseUrl, "http://127.0.0.1:11434/v1");
  assert.throws(() => resolveReplayModelConfig({ provider: "openrouter" }, {}), /no API key/);
  assert.equal(resolveReplayModelConfig({ provider: "openrouter" }, { OPENROUTER_API_KEY: "k" }).apiKey, "k");
  assert.throws(() => resolveReplayModelConfig({ provider: "codex" }, {}), /inside the Hub/);
});

test("main replays the fixture offline without printing sample text", async () => {
  const fixturePath = fileURLToPath(fixtureUrl);
  const fixtureText = await readFile(fixtureUrl, "utf8");
  const samples = loadSamples(fixtureText);
  for (const mode of ["legacy", "heuristic"]) {
    const { out, err, io } = captureIo();
    const code = await main(["--input", fixturePath, "--mode", mode], io);
    assert.equal(code, 0);
    assert.equal(err.length, 0);
    const text = out.join("");
    assert.match(text, new RegExp(`mode: ${mode}`));
    assert.match(text, /ALL/);
    for (const sample of samples) {
      assert.ok(!text.includes(sample.event.text), `output leaked text of ${sample.id}`);
    }
  }
  const { out, io } = captureIo();
  assert.equal(await main(["--input", fixturePath, "--mode", "legacy", "--json"], io), 0);
  const report = JSON.parse(out.join(""));
  assert.equal(report.mode, "legacy");
  assert.equal(report.overall.samples, samples.length);
  assert.equal(report.results.length, samples.length);
  assert.ok(!out.join("").includes(samples[0].event.text));
});

test("main judge mode runs against an injected executor and prints a JSON report", async () => {
  const fixturePath = fileURLToPath(fixtureUrl);
  const calls = [];
  const runTask = async (request) => {
    calls.push(request);
    return { ok: true, provider: request.provider, model: request.model, value: { target: "other", reasonCode: "talking_about_bot" } };
  };
  const { out, err, io } = captureIo({ runTask });
  const code = await main(["--input", fixturePath, "--model", "qwen3.5:4b", "--json", "--concurrency", "2"], io);
  assert.equal(code, 0, err.join(""));
  const report = JSON.parse(out.join(""));
  assert.equal(report.mode, "judge");
  assert.equal(report.provider, "ollama");
  assert.equal(report.model, "qwen3.5:4b");
  assert.equal(report.promptVersion, QQ_ALIAS_ADDRESS_PROMPT_VERSION);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.model === "qwen3.5:4b" && call.provider === "ollama"));
  assert.equal(report.overall.modelCalls, calls.length);
  assert.equal(report.results.filter((result) => result.modelCalled).length, calls.length);
});

test("main reports usage and input errors with exit code 2", async () => {
  let capture = captureIo();
  assert.equal(await main([], capture.io), 2);
  assert.match(capture.err.join(""), /--input is required/);

  capture = captureIo();
  assert.equal(await main(["--mode", "shadow"], capture.io), 2);
  assert.match(capture.err.join(""), /--mode must be one of/);

  capture = captureIo({ readFile: async () => "{not json" });
  assert.equal(await main(["--input", "x.jsonl", "--mode", "legacy"], capture.io), 2);
  assert.match(capture.err.join(""), /line 1: invalid JSON/);

  capture = captureIo({ readFile: async () => "\n\n" });
  assert.equal(await main(["--input", "x.jsonl", "--mode", "legacy"], capture.io), 2);
  assert.match(capture.err.join(""), /no samples/);

  capture = captureIo();
  assert.equal(await main(["--input", "/nonexistent/qq-addressing-replay.jsonl", "--mode", "legacy"], capture.io), 2);
  assert.match(capture.err.join(""), /cannot read input file \(ENOENT\)/);

  capture = captureIo({ readFile: async () => JSON.stringify({ id: "a", expected: "bot", event: { text: "x" } }) });
  assert.equal(await main(["--input", "x.jsonl", "--provider", "openrouter"], capture.io), 2);
  assert.match(capture.err.join(""), /no API key/);

  capture = captureIo();
  assert.equal(await main(["--help"], capture.io), 0);
  assert.match(capture.out.join(""), /Usage:/);
});

test("buildReport exposes only ids, targets, reason codes and timings per sample", () => {
  const report = buildReport([
    { id: "x", stratum: "s", expected: "bot", predicted: "bot", reasonCode: "direct_call", source: "judge", modelCalled: true, failed: false, timedOut: false, invalidOutput: false, durationMs: 12, formatRetryCount: 0, extra: "ignored", raw: "ignored" }
  ], { mode: "judge" });
  assert.deepEqual(Object.keys(report.results[0]).sort(), [
    "durationMs", "expected", "failed", "id", "invalidOutput", "modelCalled", "predicted", "reasonCode", "source", "stratum", "timedOut"
  ]);
});
