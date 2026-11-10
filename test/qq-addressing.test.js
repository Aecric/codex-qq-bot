import assert from "node:assert/strict";
import test from "node:test";
import {
  QQ_ADDRESS_SOURCES,
  QQ_ALIAS_ADDRESS_PROMPT_VERSION,
  buildQqAliasAddressPayload,
  classifyQqProtocolAddress,
  createQqAddressingStats,
  createQqAliasAddressJudgeCache,
  findQqAssistantAliasHits,
  hasQqProtocolReplyToSelf,
  hasQqProtocolSelfAt,
  heuristicQqAliasAddressVerdict,
  isQqAddressedSource,
  judgeQqAliasAddress,
  normalizeQqAliasAddressVerdict,
  normalizeQqAliasRoutingMode,
  resolveQqAddressing,
  resolveQqAliasRoutingMode,
  stripQqProtocolMarkers
} from "../src/qq-addressing.js";

test("stripQqProtocolMarkers removes protocol CQ codes but keeps plain-text aliases", () => {
  assert.equal(stripQqProtocolMarkers("[CQ:at,qq=10001]小白你好"), "小白你好");
  assert.equal(stripQqProtocolMarkers("[CQ:reply,id=42]小白在吗"), "小白在吗");
  assert.equal(stripQqProtocolMarkers("小白[CQ:image,file=a.jpg,url=https://example.test/a.jpg]看图"), "小白看图");
  assert.equal(stripQqProtocolMarkers("[CQ:face,id=178]小白"), "小白");
  assert.equal(
    stripQqProtocolMarkers("[CQ:reply,id=1][CQ:at,qq=2,name=小白] 小白[CQ:face,id=1][CQ:image,file=x.png] 在吗"),
    "小白 在吗"
  );
  assert.equal(stripQqProtocolMarkers("[CQ:at,qq=10001]"), "");
  assert.equal(stripQqProtocolMarkers(null), "");
  assert.equal(stripQqProtocolMarkers(undefined), "");
});

test("findQqAssistantAliasHits de-duplicates hits and ignores aliases that only live inside CQ codes", () => {
  assert.deepEqual(findQqAssistantAliasHits("小白你看看，小白", ["小白", "小白", "阿白"]), ["小白"]);
  assert.deepEqual(findQqAssistantAliasHits("阿白和小白都在", ["小白", "阿白"]), ["小白", "阿白"]);
  assert.deepEqual(findQqAssistantAliasHits("[CQ:at,qq=1,name=小白]大家好", ["小白"]), []);
  assert.deepEqual(findQqAssistantAliasHits("[CQ:reply,id=9]今天天气不错", ["小白"]), []);
  assert.deepEqual(findQqAssistantAliasHits("[CQ:at,qq=1,name=小白]小白你好", ["小白"]), ["小白"]);
  assert.deepEqual(findQqAssistantAliasHits("", ["小白"]), []);
  assert.deepEqual(findQqAssistantAliasHits("小白", ["", "  ", null]), []);
  assert.deepEqual(findQqAssistantAliasHits("小白", undefined), []);
});

test("classifyQqProtocolAddress reads only protocol facts", () => {
  assert.equal(classifyQqProtocolAddress({ type: "private_message", text: "hi" }), "private");
  assert.equal(classifyQqProtocolAddress({ type: "group_poke" }), "poke");
  assert.equal(classifyQqProtocolAddress({ type: "private_poke" }), "poke");
  assert.equal(classifyQqProtocolAddress({ type: "group_at", text: "hi" }), "explicit_at");
  assert.equal(classifyQqProtocolAddress({ type: "group_message", hasSelfAtSegment: true }), "explicit_at");
  assert.equal(classifyQqProtocolAddress({ type: "group_message", isReplyToSelf: true }), "reply_to_bot");
  assert.equal(classifyQqProtocolAddress({ type: "group_message", text: "小白你好" }), null);
  assert.equal(classifyQqProtocolAddress({}), null);
  assert.equal(classifyQqProtocolAddress(), null);
  assert.equal(classifyQqProtocolAddress(null), null);
});

test("classifyQqProtocolAddress ranks a real @ above a reply to the bot", () => {
  assert.equal(classifyQqProtocolAddress({ type: "group_at", isReplyToSelf: true }), "explicit_at");
  assert.equal(classifyQqProtocolAddress({ type: "private_message", hasSelfAtSegment: true }), "private");
});

test("protocol self-at and reply helpers", () => {
  assert.equal(hasQqProtocolSelfAt({ type: "group_at" }), true);
  assert.equal(hasQqProtocolSelfAt({ hasSelfAtSegment: true }), true);
  assert.equal(hasQqProtocolSelfAt({ type: "group_message" }), false);
  assert.equal(hasQqProtocolSelfAt(), false);
  assert.equal(hasQqProtocolReplyToSelf({ isReplyToSelf: true }), true);
  assert.equal(hasQqProtocolReplyToSelf({ replyContext: { isSelf: true } }), true);
  assert.equal(hasQqProtocolReplyToSelf({ replyContext: { isSelf: false } }), false);
  assert.equal(hasQqProtocolReplyToSelf(), false);
});

test("resolveQqAddressing distinguishes alias candidates, confirmed aliases and ambient text", () => {
  const aliases = ["小白"];
  const candidate = resolveQqAddressing({ type: "group_message", text: "小白你看看" }, { aliases });
  assert.deepEqual(candidate, { source: "alias_candidate", protocol: false, aliasHits: ["小白"] });

  const confirmed = resolveQqAddressing(
    { type: "group_message", text: "小白你看看", qqAddressing: { source: "alias_confirmed" } },
    { aliases }
  );
  assert.deepEqual(confirmed, { source: "alias_confirmed", protocol: false, aliasHits: ["小白"] });

  const ambient = resolveQqAddressing({ type: "group_message", text: "今天吃什么" }, { aliases });
  assert.deepEqual(ambient, { source: "ambient", protocol: false, aliasHits: [] });

  assert.equal(resolveQqAddressing({ type: "group_message", text: "小白你看看" }).source, "ambient", "no aliases configured");
  assert.equal(resolveQqAddressing().source, "ambient");
});

test("resolveQqAddressing lets a real @ win over an alias or a prior alias verdict", () => {
  const atEvent = { type: "group_at", text: "[CQ:at,qq=1]小白你看看", qqAddressing: { source: "alias_confirmed" } };
  assert.deepEqual(resolveQqAddressing(atEvent, { aliases: ["小白"] }), {
    source: "explicit_at",
    protocol: true,
    aliasHits: ["小白"]
  });
  assert.equal(
    resolveQqAddressing({ type: "group_message", isReplyToSelf: true, text: "小白" }, { aliases: ["小白"] }).source,
    "reply_to_bot"
  );
  assert.equal(resolveQqAddressing({ type: "private_message", text: "hi" }).source, "private");
});

test("isQqAddressedSource only accepts protocol sources and judged alias calls", () => {
  for (const source of ["private", "poke", "explicit_at", "reply_to_bot", "alias_confirmed"]) {
    assert.equal(isQqAddressedSource(source), true, source);
  }
  for (const source of ["alias_candidate", "ambient", "", undefined, "bogus"]) {
    assert.equal(isQqAddressedSource(source), false, String(source));
  }
  assert.equal(Object.isFrozen(QQ_ADDRESS_SOURCES), true);
});

test("alias routing mode defaults to judge and falls back on garbage", () => {
  assert.equal(normalizeQqAliasRoutingMode(undefined), "judge");
  assert.equal(normalizeQqAliasRoutingMode("  SHADOW "), "shadow");
  assert.equal(normalizeQqAliasRoutingMode("legacy"), "legacy");
  assert.equal(normalizeQqAliasRoutingMode("garbage"), "judge");
  assert.equal(normalizeQqAliasRoutingMode("garbage", "legacy"), "legacy");

  assert.equal(resolveQqAliasRoutingMode(), "judge");
  assert.equal(resolveQqAliasRoutingMode({ mode: "bogus" }), "judge");
  assert.equal(resolveQqAliasRoutingMode({ mode: "shadow", groupId: "123" }), "shadow");
});

test("a rollout group list keeps the mode for listed groups and sends other groups to legacy", () => {
  const options = { mode: "judge", groups: ["123", 456] };
  assert.equal(resolveQqAliasRoutingMode({ ...options, groupId: "123" }), "judge");
  assert.equal(resolveQqAliasRoutingMode({ ...options, groupId: 456 }), "judge");
  assert.equal(resolveQqAliasRoutingMode({ ...options, groupId: "789" }), "legacy");
  assert.equal(resolveQqAliasRoutingMode({ ...options, groupId: "" }), "legacy");
  assert.equal(resolveQqAliasRoutingMode({ mode: "shadow", groups: ["123"], groupId: "123" }), "shadow");
  assert.equal(resolveQqAliasRoutingMode({ mode: "shadow", groups: ["123"], groupId: "999" }), "legacy");
  assert.equal(resolveQqAliasRoutingMode({ mode: "judge", groups: [], groupId: "999" }), "judge", "an empty list means every group");
  assert.equal(resolveQqAliasRoutingMode({ mode: "judge", groups: "not a list", groupId: "999" }), "judge");
});

test("normalizeQqAliasAddressVerdict accepts only matching target and reason pairs", () => {
  assert.deepEqual(normalizeQqAliasAddressVerdict({ target: "bot", reasonCode: "direct_call" }), {
    target: "bot",
    reasonCode: "direct_call"
  });
  assert.deepEqual(normalizeQqAliasAddressVerdict({ target: " Other ", reason_code: "Talking_About_Bot" }), {
    target: "other",
    reasonCode: "talking_about_bot"
  });
  assert.deepEqual(normalizeQqAliasAddressVerdict({ target: "unclear", reasonCode: "ambiguous", extra: "dropped" }), {
    target: "unclear",
    reasonCode: "ambiguous"
  });

  assert.equal(normalizeQqAliasAddressVerdict({ target: "bot", reasonCode: "talking_about_bot" }), null, "mismatched pair");
  assert.equal(normalizeQqAliasAddressVerdict({ target: "other", reasonCode: "direct_call" }), null);
  assert.equal(normalizeQqAliasAddressVerdict({ target: "unclear", reasonCode: "direct_call" }), null);
  assert.equal(normalizeQqAliasAddressVerdict({ target: "everyone", reasonCode: "direct_call" }), null);
  assert.equal(normalizeQqAliasAddressVerdict({ target: "bot", reasonCode: "because" }), null);
  assert.equal(normalizeQqAliasAddressVerdict({ target: "bot" }), null);
  assert.equal(normalizeQqAliasAddressVerdict({}), null);
  assert.equal(normalizeQqAliasAddressVerdict([{ target: "bot", reasonCode: "direct_call" }]), null);
  assert.equal(normalizeQqAliasAddressVerdict(null), null);
  assert.equal(normalizeQqAliasAddressVerdict(undefined), null);
  assert.equal(normalizeQqAliasAddressVerdict("bot"), null);
});

test("heuristicQqAliasAddressVerdict treats vocative names as calls and narration as unclear", () => {
  const aliases = ["小白"];
  const bot = { target: "bot", reasonCode: "direct_call" };
  const unclear = { target: "unclear", reasonCode: "ambiguous" };
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白你看看", aliases), bot);
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白，帮我", aliases), bot);
  assert.deepEqual(heuristicQqAliasAddressVerdict("帮我看看，小白", aliases), bot);
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白", aliases), bot);
  assert.deepEqual(heuristicQqAliasAddressVerdict("[CQ:at,qq=2]小白 在吗", aliases), bot);
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白昨天也说过", aliases), unclear);
  assert.deepEqual(heuristicQqAliasAddressVerdict("我觉得小白说得对", aliases), unclear);
  assert.deepEqual(heuristicQqAliasAddressVerdict("今天吃什么", aliases), unclear);
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白你看看", []), unclear);
  assert.deepEqual(heuristicQqAliasAddressVerdict("", aliases), unclear);
});

test("heuristicQqAliasAddressVerdict handles aliases with regex characters and a leading @", () => {
  assert.deepEqual(heuristicQqAliasAddressVerdict("帮我看看, a.b?", ["a.b?"]), { target: "bot", reasonCode: "direct_call" });
  assert.deepEqual(heuristicQqAliasAddressVerdict("帮我看看, axb", ["a.b"]), { target: "unclear", reasonCode: "ambiguous" });
  assert.deepEqual(heuristicQqAliasAddressVerdict("小白，在吗", ["@小白"]), { target: "bot", reasonCode: "direct_call" });
});

test("buildQqAliasAddressPayload builds a bounded judge payload without the current message in recent", () => {
  const event = {
    senderLabel: "Alice",
    text: "[CQ:at,qq=2,name=Bob]小白你怎么看",
    raw: { message_id: 1003 },
    atMentions: [{ name: "Bob" }, { nickname: "Carol" }, { userId: "5555" }, {}],
    replyContext: { isSelf: false, senderName: "Bob", text: "我觉得不行" }
  };
  const recentMessages = [
    { messageId: "1001", senderLabel: "Bob", text: "今天去哪" },
    { messageId: "1002", senderId: "assistant", senderLabel: "小白", text: "去公园吧" },
    { messageId: "1003", senderLabel: "Alice", text: "小白你怎么看" },
    { messageId: "1004", isAssistant: true, text: "我觉得可以" },
    { messageId: "1005", senderLabel: "Bob", text: "" },
    { messageId: "1006", senderLabel: "Carol", text: "ok", replyContext: { isSelf: true } }
  ];
  const payload = buildQqAliasAddressPayload({
    event,
    aliases: ["小白", "", "阿白"],
    assistantName: "小白bot",
    recentMessages
  });

  assert.deepEqual(payload.bot, { name: "小白bot", aliases: ["小白", "阿白"] });
  assert.equal(payload.current.speaker, "Alice");
  assert.equal(payload.current.text, "小白你怎么看", "alias text stays, protocol markers go");
  assert.deepEqual(payload.current.mentions, ["Bob", "Carol", "5555"]);
  assert.deepEqual(payload.current.replyTo, { speaker: "Bob", text: "我觉得不行" });
  assert.deepEqual(payload.recent, [
    { speaker: "Bob", text: "今天去哪" },
    { speaker: "bot", text: "去公园吧" },
    { speaker: "bot", text: "我觉得可以" },
    { speaker: "Carol", text: "ok", replyToBot: true }
  ]);
  assert.equal(JSON.stringify(payload).includes("1003"), false);
});

test("buildQqAliasAddressPayload omits mentions and replyTo when absent or when replying to the bot", () => {
  const plain = buildQqAliasAddressPayload({ event: { text: "小白在吗" }, aliases: ["小白"] });
  assert.equal(plain.bot.name, "assistant");
  assert.equal(plain.current.speaker, "群友");
  assert.equal("mentions" in plain.current, false);
  assert.equal("replyTo" in plain.current, false);
  assert.deepEqual(plain.recent, []);

  const replyToSelf = buildQqAliasAddressPayload({
    event: { text: "小白在吗", replyContext: { isSelf: true, text: "hi" } },
    aliases: ["小白"]
  });
  assert.equal("replyTo" in replyToSelf.current, false);
});

test("buildQqAliasAddressPayload keeps the newest recent messages and caps text length", () => {
  const recentMessages = Array.from({ length: 20 }, (_, index) => ({
    messageId: String(index),
    senderLabel: "A",
    text: `m${index}`
  }));
  recentMessages.push({ messageId: "long", senderLabel: "B", text: "x".repeat(500) });
  const payload = buildQqAliasAddressPayload({ event: { text: "小白" }, aliases: ["小白"], recentMessages, maxRecentMessages: 3 });
  assert.equal(payload.recent.length, 3);
  assert.deepEqual(payload.recent.map((entry) => entry.text.length), [3, 3, 200]);
  assert.equal(payload.recent[0].text, "m18");

  const clamped = buildQqAliasAddressPayload({ event: { text: "小白" }, aliases: ["小白"], recentMessages, maxRecentMessages: 99 });
  assert.equal(clamped.recent.length, 12, "never more than twelve recent messages");
});

test("judgeQqAliasAddress returns the structured verdict with provider metadata", async () => {
  let received;
  const result = await judgeQqAliasAddress({
    runTask: async (options) => {
      received = options;
      return { ok: true, value: { target: "bot", reasonCode: "direct_call" }, provider: "ollama", model: "m", attemptCount: 1 };
    },
    model: { provider: "codex", model: "other", baseUrl: "http://x" },
    payload: { current: { text: "小白你看看" } },
    timeoutMs: 3000
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "bot");
  assert.equal(result.reasonCode, "direct_call");
  assert.equal(result.provider, "ollama", "the executor's reported provider wins");
  assert.equal(result.model, "m");
  assert.equal(result.promptVersion, QQ_ALIAS_ADDRESS_PROMPT_VERSION);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.formatRetryCount, 0);
  assert.equal(typeof result.durationMs, "number");

  assert.equal(received.taskName, "qq_alias_address");
  assert.equal(received.baseUrl, "http://x");
  assert.equal(received.timeoutMs, 3000);
  assert.equal(received.temperature, 0);
  assert.deepEqual(received.payload, { current: { text: "小白你看看" } });
  assert.deepEqual(received.responseSchema.required, ["target", "reasonCode"]);
  assert.equal(received.signal.aborted, false, "a finished judgment is never aborted");
});

test("judgeQqAliasAddress falls back to the requested model when the executor reports none", async () => {
  const result = await judgeQqAliasAddress({
    runTask: async () => ({ ok: true, value: { target: "other", reasonCode: "talking_about_bot" } }),
    model: { provider: "codex", model: "gpt-6-luna" },
    payload: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "other");
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-6-luna");
});

test("judgeQqAliasAddress aborts the provider call when its own deadline passes", async () => {
  let signal;
  const startedAt = Date.now();
  const result = await judgeQqAliasAddress({
    runTask: (options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
    model: { provider: "ollama", model: "m" },
    payload: {},
    timeoutMs: 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, "alias judge timed out");
  assert.equal(signal.aborted, true);
  assert.equal(result.promptVersion, QQ_ALIAS_ADDRESS_PROMPT_VERSION);
  assert.ok(Date.now() - startedAt >= 900, "waited for the deadline");
});

test("judgeQqAliasAddress clamps the deadline to its bounds", async () => {
  let received;
  await judgeQqAliasAddress({
    runTask: async (options) => {
      received = options.timeoutMs;
      return { ok: true, value: { target: "bot", reasonCode: "direct_call" } };
    },
    timeoutMs: 50
  });
  assert.equal(received, 1000);
  await judgeQqAliasAddress({
    runTask: async (options) => {
      received = options.timeoutMs;
      return { ok: true, value: { target: "bot", reasonCode: "direct_call" } };
    },
    timeoutMs: 999_999
  });
  assert.equal(received, 20_000);
});

test("judgeQqAliasAddress reports a rejected executor as a failed judgment", async () => {
  const result = await judgeQqAliasAddress({
    runTask: async () => {
      throw new Error("connection refused");
    },
    payload: {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "connection refused");
  assert.equal(result.timedOut, false);
  assert.equal(result.invalidOutput, false);
});

test("judgeQqAliasAddress reports unusable or invalid executor output", async () => {
  const noValue = await judgeQqAliasAddress({ runTask: async () => ({ ok: true, value: null }), payload: {} });
  assert.equal(noValue.ok, false);

  const invalid = await judgeQqAliasAddress({
    runTask: async () => ({ ok: false, reason: "model did not return valid structured JSON", attemptCount: 2, formatRetryCount: 1 }),
    payload: {}
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.invalidOutput, true);
  assert.equal(invalid.attemptCount, 2);
  assert.equal(invalid.formatRetryCount, 1);

  const missing = await judgeQqAliasAddress({ payload: {} });
  assert.deepEqual(missing, { ok: false, reason: "alias judge unavailable", durationMs: 0 });
});

test("judgeQqAliasAddress hands the executor a normalizer that rejects mismatched verdicts", async () => {
  let normalizeValue;
  let validate;
  await judgeQqAliasAddress({
    runTask: async (options) => {
      normalizeValue = options.normalizeValue;
      validate = options.validate;
      return { ok: true, value: { target: "bot", reasonCode: "direct_call" } };
    },
    payload: {}
  });
  assert.equal(normalizeValue({ target: "bot", reasonCode: "talking_about_bot" }), null);
  assert.deepEqual(normalizeValue({ target: "bot", reasonCode: "request_to_bot" }), { target: "bot", reasonCode: "request_to_bot" });
  assert.equal(normalizeValue([]), null);
  assert.equal(validate(null), false);
  assert.equal(validate({ target: "bot", reasonCode: "direct_call" }), true);
});

test("the alias judge cache runs a task once per message and shares the verdict", async () => {
  const cache = createQqAliasAddressJudgeCache();
  const event = { groupId: "123", raw: { message_id: 77 } };
  const key = cache.key(event);
  assert.equal(key, "123:77");

  let runs = 0;
  const task = async () => {
    runs += 1;
    return { ok: true, target: "bot" };
  };
  const first = cache.run(key, task);
  const second = cache.run(key, task);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.promise, second.promise, "an in-flight duplicate shares the promise");
  assert.deepEqual(await first.promise, { ok: true, target: "bot" });
  assert.deepEqual(await second.promise, { ok: true, target: "bot" });

  const third = cache.run(key, task);
  assert.equal(third.duplicate, true);
  assert.deepEqual(await third.promise, { ok: true, target: "bot" });
  assert.equal(runs, 1);
  assert.equal(cache.size, 1);

  const other = cache.run(cache.key({ groupId: "123", raw: { message_id: 78 } }), task);
  assert.equal(other.duplicate, false);
  await other.promise;
  assert.equal(runs, 2);
});

test("the alias judge cache cannot key messages without a group or message id", async () => {
  const cache = createQqAliasAddressJudgeCache();
  assert.equal(cache.key({ groupId: "123", raw: {} }), "");
  assert.equal(cache.key({ groupId: "123" }), "");
  assert.equal(cache.key({ raw: { message_id: 1 } }), "");
  assert.equal(cache.key(), "");
  assert.equal(cache.key({ groupId: "123", raw: { message_id: 0 } }), "123:0");

  let runs = 0;
  const task = async () => ++runs;
  const first = cache.run("", task);
  const second = cache.run("", task);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.deepEqual([await first.promise, await second.promise], [1, 2]);
  assert.equal(runs, 2);
  assert.equal(cache.size, 0, "unkeyed runs are not cached");
});

test("the alias judge cache expires entries after the ttl and bounds its size", async () => {
  let clock = 1_000;
  const cache = createQqAliasAddressJudgeCache({ ttlMs: 500, now: () => clock });
  let runs = 0;
  const task = async () => ++runs;
  await cache.run("g:1", task).promise;
  assert.equal(cache.run("g:1", task).duplicate, true);
  clock += 501;
  const again = cache.run("g:1", task);
  assert.equal(again.duplicate, false);
  await again.promise;
  assert.equal(runs, 2);

  const bounded = createQqAliasAddressJudgeCache({ maxEntries: 2 });
  for (const key of ["g:a", "g:b", "g:c"]) await bounded.run(key, async () => key).promise;
  const evicted = bounded.run("g:a", async () => "again");
  assert.equal(evicted.duplicate, false, "the oldest entry was evicted");
  assert.equal(await evicted.promise, "again");
});

test("createQqAddressingStats counts outcomes and reports latency percentiles", () => {
  const stats = createQqAddressingStats({ now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
  assert.deepEqual(stats.snapshot().counts, {});
  assert.deepEqual(stats.snapshot().latencyMs, { samples: 0, p50: null, p95: null });
  assert.equal(stats.snapshot().since, "2026-01-02T03:04:05.000Z");

  stats.record({ mode: "judge", outcome: "bot", target: "bot", reasonCode: "direct_call", durationMs: 10 });
  stats.record({ mode: "judge", outcome: "bot", target: "bot", reasonCode: "request_to_bot", durationMs: 20 });
  stats.record({ mode: "judge", outcome: "other", target: "other", reasonCode: "talking_about_bot", durationMs: 30 });
  stats.record({ mode: "judge", outcome: "failed", durationMs: 40, timedOut: true, fallback: true });
  stats.record({ mode: "shadow", outcome: "failed", durationMs: 50, invalidOutput: true });
  stats.record({});

  const snapshot = stats.snapshot();
  assert.equal(snapshot.counts["judge.total"], 5, "four judged messages plus the bare record");
  assert.equal(snapshot.counts["judge.outcome.bot"], 2);
  assert.equal(snapshot.counts["judge.outcome.other"], 1);
  assert.equal(snapshot.counts["judge.outcome.failed"], 1);
  assert.equal(snapshot.counts["judge.target.bot"], 2);
  assert.equal(snapshot.counts["judge.reason.direct_call"], 1);
  assert.equal(snapshot.counts["judge.timeout"], 1);
  assert.equal(snapshot.counts["judge.heuristic_fallback"], 1);
  assert.equal(snapshot.counts["shadow.total"], 1);
  assert.equal(snapshot.counts["shadow.invalid_output"], 1);
  assert.equal(snapshot.counts["judge.outcome.unknown"], 1, "a bare record counts as an unknown judge outcome");
  assert.deepEqual(snapshot.latencyMs, { samples: 5, p50: 30, p95: 50 });

  snapshot.counts["judge.total"] = 999;
  assert.equal(stats.snapshot().counts["judge.total"], 5, "snapshots are copies");
});

test("createQqAddressingStats keeps a bounded latency window and can be reset", () => {
  let clock = 1_000;
  const stats = createQqAddressingStats({ now: () => clock, latencySamples: 3 });
  for (const durationMs of [100, 1, 2, 3]) stats.record({ outcome: "bot", durationMs });
  assert.deepEqual(stats.snapshot().latencyMs, { samples: 3, p50: 2, p95: 3 }, "the oldest sample dropped out");

  stats.record({ outcome: "bot", durationMs: "not a number" });
  stats.record({ outcome: "bot", durationMs: null });
  assert.equal(stats.snapshot().latencyMs.samples, 3, "non-numeric durations are ignored");

  clock = 5_000;
  stats.reset();
  const snapshot = stats.snapshot();
  assert.deepEqual(snapshot.counts, {});
  assert.deepEqual(snapshot.latencyMs, { samples: 0, p50: null, p95: null });
  assert.equal(snapshot.since, new Date(5_000).toISOString());
});

test("a confirmed quote of the bot (replyContext.isSelf) is a protocol reply, not an alias candidate", () => {
  const event = { type: "group_message", groupId: "100001", text: "小白昨天也说过", replyContext: { isSelf: true } };
  assert.equal(classifyQqProtocolAddress(event), QQ_ADDRESS_SOURCES.REPLY_TO_BOT);
  assert.equal(resolveQqAddressing(event, { aliases: ["小白"] }).source, QQ_ADDRESS_SOURCES.REPLY_TO_BOT);
});
