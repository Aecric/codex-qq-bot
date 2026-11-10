// Separates "who is this message addressed to" from "should the bot chime in".
//
// Protocol facts (a real OneBot @, a reply to one of the bot's messages, a
// private chat or a poke) address the bot by themselves. A configured nickname
// or alias appearing in the text is only a candidate: "小白你看看" calls the
// bot, "小白昨天也说过" talks about it. Candidates go through a small
// structured judge before they may take the direct reply route, and a judged
// call never grants more than a real @ would.

import { createQqCqCodePattern } from "./qq-message-content.js";

export const QQ_ADDRESS_SOURCES = Object.freeze({
  PRIVATE: "private",
  POKE: "poke",
  EXPLICIT_AT: "explicit_at",
  REPLY_TO_BOT: "reply_to_bot",
  ALIAS_CONFIRMED: "alias_confirmed",
  ALIAS_CANDIDATE: "alias_candidate",
  AMBIENT: "ambient"
});

export const QQ_ALIAS_ROUTING_MODES = Object.freeze(["judge", "shadow", "legacy"]);

export const QQ_ALIAS_ADDRESS_TARGETS = Object.freeze(["bot", "other", "unclear"]);

// Fixed reason codes per target. The application validates the pair, so a
// model cannot answer "bot" with a reason that says it was someone else.
export const QQ_ALIAS_ADDRESS_REASON_CODES = Object.freeze({
  bot: Object.freeze(["direct_call", "request_to_bot", "question_to_bot", "reply_to_bot_turn"]),
  other: Object.freeze(["talking_about_bot", "quoting_or_relaying", "addressing_other", "name_coincidence"]),
  unclear: Object.freeze(["ambiguous", "insufficient_context"])
});

const ALL_REASON_CODES = new Set(Object.values(QQ_ALIAS_ADDRESS_REASON_CODES).flat());

export function normalizeQqAliasRoutingMode(value, fallback = "judge") {
  const mode = String(value || "").trim().toLowerCase();
  return QQ_ALIAS_ROUTING_MODES.includes(mode) ? mode : fallback;
}

// Rollout control: with a group list, only those groups use the configured
// mode and every other group keeps the legacy substring route.
export function resolveQqAliasRoutingMode({ mode = "judge", groups = [], groupId = "" } = {}) {
  const normalized = normalizeQqAliasRoutingMode(mode);
  const list = (Array.isArray(groups) ? groups : []).map(String).filter(Boolean);
  if (list.length === 0) return normalized;
  return list.includes(String(groupId || "")) ? normalized : "legacy";
}

// Removes only protocol markers (CQ codes for at, reply, image, file, voice
// and face). Text aliases stay, because they are the evidence a judge needs.
export function stripQqProtocolMarkers(text) {
  return String(text || "")
    .replace(createQqCqCodePattern("file", "gi"), "")
    .replace(createQqCqCodePattern("image"), "")
    .replace(createQqCqCodePattern("record|voice|audio"), "")
    .replace(createQqCqCodePattern("face"), "")
    .replace(/\[CQ:reply,[^\]]+\]/g, "")
    .replace(/\[CQ:at,[^\]]+\]/g, "")
    .trim();
}

export function findQqAssistantAliasHits(text, aliases = []) {
  const value = stripQqProtocolMarkers(text);
  if (!value) return [];
  const hits = [];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const name = String(alias || "").trim();
    if (name && value.includes(name) && !hits.includes(name)) hits.push(name);
  }
  return hits;
}

export function hasQqProtocolSelfAt(event = {}) {
  return event?.type === "group_at" || Boolean(event?.hasSelfAtSegment);
}

export function hasQqProtocolReplyToSelf(event = {}) {
  return Boolean(event?.isReplyToSelf || event?.replyContext?.isSelf);
}

// The source a protocol fact alone establishes, or null for group text that
// carries no protocol address.
export function classifyQqProtocolAddress(event = {}) {
  if (event?.type === "private_message") return QQ_ADDRESS_SOURCES.PRIVATE;
  if (event?.type === "group_poke" || event?.type === "private_poke") return QQ_ADDRESS_SOURCES.POKE;
  if (hasQqProtocolSelfAt(event)) return QQ_ADDRESS_SOURCES.EXPLICIT_AT;
  if (hasQqProtocolReplyToSelf(event)) return QQ_ADDRESS_SOURCES.REPLY_TO_BOT;
  return null;
}

export function resolveQqAddressing(event = {}, { aliases = [] } = {}) {
  const protocolSource = classifyQqProtocolAddress(event);
  const aliasHits = findQqAssistantAliasHits(event?.text, aliases);
  if (protocolSource) return { source: protocolSource, protocol: true, aliasHits };
  if (event?.qqAddressing?.source === QQ_ADDRESS_SOURCES.ALIAS_CONFIRMED) {
    return { source: QQ_ADDRESS_SOURCES.ALIAS_CONFIRMED, protocol: false, aliasHits };
  }
  if (aliasHits.length > 0) return { source: QQ_ADDRESS_SOURCES.ALIAS_CANDIDATE, protocol: false, aliasHits };
  return { source: QQ_ADDRESS_SOURCES.AMBIENT, protocol: false, aliasHits };
}

// True when the bot was addressed by protocol or by a judged alias call.
export function isQqAddressedSource(source) {
  return [
    QQ_ADDRESS_SOURCES.PRIVATE,
    QQ_ADDRESS_SOURCES.POKE,
    QQ_ADDRESS_SOURCES.EXPLICIT_AT,
    QQ_ADDRESS_SOURCES.REPLY_TO_BOT,
    QQ_ADDRESS_SOURCES.ALIAS_CONFIRMED
  ].includes(source);
}

export function normalizeQqAliasAddressVerdict(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = String(value.target || "").trim().toLowerCase();
  const reasonCode = String(value.reasonCode || value.reason_code || "").trim().toLowerCase();
  if (!QQ_ALIAS_ADDRESS_TARGETS.includes(target)) return null;
  if (!ALL_REASON_CODES.has(reasonCode)) return null;
  if (!QQ_ALIAS_ADDRESS_REASON_CODES[target].includes(reasonCode)) return null;
  return { target, reasonCode };
}

export const QQ_ALIAS_ADDRESS_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["target", "reasonCode"],
  properties: {
    target: { type: "string", enum: [...QQ_ALIAS_ADDRESS_TARGETS] },
    reasonCode: { type: "string", enum: [...ALL_REASON_CODES] }
  }
});

export const QQ_ALIAS_ADDRESS_PROMPT_VERSION = "alias-address-v1";

export const QQ_ALIAS_ADDRESS_SYSTEM_PROMPT = [
  "判断 current.text 这条群消息是不是在叫 Bot、对 Bot 说话。Bot 的名字和别名见 bot.aliases，消息里出现别名不等于在叫 Bot。",
  "target=bot：说话人把 Bot 当听者，例如开头或结尾直呼别名、对 Bot 提要求或提问、紧接 Bot 上一轮发言的“你”。",
  "target=other：只是提到 Bot（“小白昨天也说过”）、转述或引用别人的话、话是对其他群友说的、别名只是普通词语。",
  "target=unclear：上下文不足以确定。",
  "“你”指谁要看 recent：前一条是 Bot 发言且话题连续时多半指 Bot；正在和别的群友对话时多半指对方。反问、调侃 Bot 但面向他人时选 other。",
  "current.mentions 是当前消息 @ 的其他人；@ 了别人又提到 Bot 名字，通常是对那个人说话。",
  "reasonCode 必须与 target 匹配：bot 用 direct_call/request_to_bot/question_to_bot/reply_to_bot_turn；other 用 talking_about_bot/quoting_or_relaying/addressing_other/name_coincidence；unclear 用 ambiguous/insufficient_context。",
  "输出 JSON：{\"target\":\"bot|other|unclear\",\"reasonCode\":\"...\"}"
].join("\n");

export function buildQqAliasAddressPayload({
  event = {},
  aliases = [],
  assistantName = "assistant",
  recentMessages = [],
  maxRecentMessages = 8
} = {}) {
  const currentId = event?.raw?.message_id == null ? "" : String(event.raw.message_id);
  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((entry) => !currentId || String(entry?.messageId || "") !== currentId)
    .slice(-Math.max(1, Math.min(12, Number(maxRecentMessages) || 8)))
    .map((entry) => ({
      speaker: entry?.isAssistant || entry?.senderId === "assistant" ? "bot" : String(entry?.senderLabel || entry?.senderName || "群友").slice(0, 40),
      text: String(entry?.text || "").slice(0, 200),
      ...(entry?.replyContext?.isSelf ? { replyToBot: true } : {})
    }))
    .filter((entry) => entry.text);
  const mentions = (Array.isArray(event?.atMentions) ? event.atMentions : [])
    .map((mention) => String(mention?.name || mention?.nickname || mention?.userId || "").slice(0, 40))
    .filter(Boolean);
  return {
    bot: {
      name: String(assistantName || "assistant").slice(0, 40),
      aliases: (Array.isArray(aliases) ? aliases : []).map((alias) => String(alias).slice(0, 40)).filter(Boolean).slice(0, 12)
    },
    current: {
      speaker: String(event?.senderLabel || event?.senderName || "群友").slice(0, 40),
      text: stripQqProtocolMarkers(event?.text).slice(0, 500),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(event?.replyContext && !event.replyContext.isSelf
        ? { replyTo: { speaker: String(event.replyContext.senderName || "群友").slice(0, 40), text: String(event.replyContext.text || "").slice(0, 200) } }
        : {})
    },
    recent
  };
}

// Deterministic fallback for deployments without a working judge: a name at
// the very start or end of the message, set off like a vocative, counts as a
// call; anything else stays unclear and silent.
export function heuristicQqAliasAddressVerdict(text, aliases = []) {
  const value = stripQqProtocolMarkers(text).replace(/^[@\s]+/, "");
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const name = String(alias || "").replace(/^@/, "").trim();
    if (!name) continue;
    if (value === name) return { target: "bot", reasonCode: "direct_call" };
    if (value.startsWith(name)) {
      // "小白昨天也说过" style narration is excluded by requiring punctuation
      // or a second-person / imperative cue right after the name.
      const rest = value.slice(name.length);
      if (/^\s*[，,、:：!！?？~～。.]/u.test(rest) || /^\s*(?:你|帮我|帮忙|快|在吗|在不在|来)/u.test(rest)) {
        return { target: "bot", reasonCode: "direct_call" };
      }
    }
    if (new RegExp(`[，,\\s]${escapeRegExp(name)}[!！?？~～。.]*$`, "u").test(value)) {
      return { target: "bot", reasonCode: "direct_call" };
    }
  }
  return { target: "unclear", reasonCode: "ambiguous" };
}

// Runs one alias-address judgment with its own total deadline. `runTask` is
// the shared structured interest-model executor; it receives an AbortSignal
// that fires at the deadline so a slow provider stops streaming.
export async function judgeQqAliasAddress({
  runTask,
  model = {},
  payload,
  timeoutMs = 5000,
  now = Date.now
} = {}) {
  const startedAt = now();
  const deadlineMs = Math.max(1000, Math.min(20_000, Number(timeoutMs) || 5000));
  if (typeof runTask !== "function") {
    return { ok: false, reason: "alias judge unavailable", durationMs: 0 };
  }
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "alias judge timed out", timedOut: true });
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      Promise.resolve(runTask({
        provider: model.provider,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        model: model.model,
        fetch: model.fetch,
        timeoutMs: deadlineMs,
        signal: controller.signal,
        temperature: 0,
        maxTokens: 256,
        taskName: "qq_alias_address",
        systemPrompt: QQ_ALIAS_ADDRESS_SYSTEM_PROMPT,
        payload,
        responseSchema: QQ_ALIAS_ADDRESS_RESPONSE_SCHEMA,
        normalizeValue: normalizeQqAliasAddressVerdict,
        validate: (value) => Boolean(value)
      })).catch((error) => ({ ok: false, reason: error?.message || "alias judge crashed" })),
      deadline
    ]);
    const durationMs = Math.max(0, now() - startedAt);
    const meta = {
      provider: result?.provider || model.provider || null,
      model: result?.model || model.model || null,
      durationMs,
      attemptCount: Number(result?.attemptCount || 0),
      formatRetryCount: Number(result?.formatRetryCount || 0),
      promptVersion: QQ_ALIAS_ADDRESS_PROMPT_VERSION
    };
    if (!result?.ok || !result.value) {
      return {
        ok: false,
        reason: result?.timedOut ? "alias judge timed out" : String(result?.reason || "alias judge failed").slice(0, 200),
        timedOut: Boolean(result?.timedOut),
        invalidOutput: /valid structured JSON/i.test(String(result?.reason || "")),
        ...meta
      };
    }
    return { ok: true, ...result.value, ...meta };
  } finally {
    clearTimeout(timer);
  }
}

// One judgment per group message: duplicate deliveries of the same OneBot
// message share the in-flight promise and the cached verdict.
export function createQqAliasAddressJudgeCache({ ttlMs = 10 * 60_000, maxEntries = 500, now = Date.now } = {}) {
  const entries = new Map();
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.at < cutoff || entries.size > maxEntries) entries.delete(key);
      else break;
    }
  };
  return {
    key(event = {}) {
      const groupId = String(event?.groupId || "");
      const messageId = event?.raw?.message_id == null ? "" : String(event.raw.message_id);
      return groupId && messageId ? `${groupId}:${messageId}` : "";
    },
    run(key, task) {
      prune();
      if (!key) return { promise: Promise.resolve(task()), duplicate: false };
      const existing = entries.get(key);
      if (existing) return { promise: existing.promise, duplicate: true };
      const promise = Promise.resolve().then(task);
      entries.set(key, { at: now(), promise });
      return { promise, duplicate: false };
    },
    get size() {
      return entries.size;
    }
  };
}

// Aggregated counters for audit logs and the state API. No message text or
// raw model output is kept, only modes, verdicts, reason codes and timings.
export function createQqAddressingStats({ now = Date.now, latencySamples = 200 } = {}) {
  let startedAt = now();
  let counts = {};
  let latencies = [];
  const bump = (key) => { counts[key] = (counts[key] || 0) + 1; };
  return {
    record({ mode = "judge", outcome = "unknown", target = null, reasonCode = null, durationMs = null, timedOut = false, invalidOutput = false, fallback = false } = {}) {
      bump(`${mode}.total`);
      bump(`${mode}.outcome.${outcome}`);
      if (target) bump(`${mode}.target.${target}`);
      if (reasonCode) bump(`${mode}.reason.${reasonCode}`);
      if (timedOut) bump(`${mode}.timeout`);
      if (invalidOutput) bump(`${mode}.invalid_output`);
      if (fallback) bump(`${mode}.heuristic_fallback`);
      if (Number.isFinite(Number(durationMs)) && durationMs !== null) {
        latencies.push(Number(durationMs));
        if (latencies.length > latencySamples) latencies = latencies.slice(-latencySamples);
      }
    },
    snapshot() {
      const sorted = [...latencies].sort((a, b) => a - b);
      const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
      return {
        since: new Date(startedAt).toISOString(),
        counts: { ...counts },
        latencyMs: { samples: sorted.length, p50: pick(0.5), p95: pick(0.95) }
      };
    },
    reset() {
      startedAt = now();
      counts = {};
      latencies = [];
    }
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
