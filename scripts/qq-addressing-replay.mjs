#!/usr/bin/env node
// Offline replay / shadow evaluation for the QQ alias-address judge.
//
// Replays de-identified, hand-labelled samples (JSONL) through the same
// building blocks the Hub uses (protocol facts, alias hits, payload builder,
// structured judge) and compares the predicted target with the expected one.
// It lets an operator compare routing modes (legacy substring, deterministic
// heuristic, model judge) and models (for example a Gemma and a Qwen model on
// a local Ollama) on identical samples before changing production routing.
//
// Privacy: sample text, recent messages and raw model output are never
// printed. Reports contain ids, strata, expected/predicted targets, reason
// codes, counters and latencies only.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  QQ_ALIAS_ADDRESS_PROMPT_VERSION,
  QQ_ALIAS_ADDRESS_TARGETS,
  buildQqAliasAddressPayload,
  classifyQqProtocolAddress,
  findQqAssistantAliasHits,
  heuristicQqAliasAddressVerdict,
  judgeQqAliasAddress,
  normalizeQqAliasAddressVerdict
} from "../src/qq-addressing.js";
import { runQqInterestModelStructuredTask } from "../src/qq-enhancer/proactive-interest.js";
import {
  INTEREST_MODEL_PROVIDER_IDS,
  resolveInterestModelRuntimeConfig
} from "../src/interest-model-provider.js";

export const REPLAY_MODES = Object.freeze(["judge", "heuristic", "legacy"]);

const DEFAULT_STRATUM = "unspecified";
const MAX_RECENT_MESSAGES = 8;

export const USAGE = [
  "Usage: node scripts/qq-addressing-replay.mjs --input <file.jsonl> [options]",
  "",
  "Options:",
  "  --input <file>        JSONL samples, one object per line (required)",
  "  --mode <mode>         judge (default) | heuristic | legacy",
  "  --provider <id>       interest model provider for judge mode (default ollama)",
  `                        one of: ${INTEREST_MODEL_PROVIDER_IDS.join(", ")} (codex needs the Hub and is not supported here)`,
  "  --model <name>        model name (default: the provider's default model)",
  "  --base-url <url>      OpenAI-compatible base URL (default: provider default or OLLAMA_BASE_URL)",
  "  --timeout-ms <ms>     per-judgment deadline, 1000-20000 (default 5000)",
  "  --concurrency <n>     samples in flight at once, 1-32 (default 1)",
  "  --json                print a JSON report instead of a table",
  "  --help                show this help",
  "",
  "Modes:",
  "  legacy     bot when an alias substring appears or a protocol address exists, else other",
  "  heuristic  protocol address -> bot, else the deterministic vocative check (no model)",
  "  judge      protocol address -> bot, no alias hit -> other, else the structured model judge",
  "",
  "API keys come from the environment (OPENROUTER_API_KEY, DEEPSEEK_API_KEY,",
  "CODEX_REMOTE_CONTACT_QQ_PROACTIVE_JUDGE_API_KEY for custom); Ollama needs none.",
  "Failures and timeouts count as unclear (silent), exactly as in the Hub.",
  "Only ids, strata, targets, reason codes, counters and latencies are printed.",
  ""
].join("\n");

// ---------------------------------------------------------------------------
// Arguments

export function parseArgs(argv = []) {
  const options = {
    input: null,
    mode: "judge",
    provider: "ollama",
    model: null,
    baseUrl: null,
    timeoutMs: 5000,
    concurrency: 1,
    json: false,
    help: false
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = args[index + 1];
      if (next === undefined || String(next).startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return String(next);
    };
    switch (flag) {
      case "--input":
        options.input = nonEmpty(takeValue(), flag);
        break;
      case "--mode": {
        const mode = takeValue().trim().toLowerCase();
        if (!REPLAY_MODES.includes(mode)) throw new Error(`--mode must be one of ${REPLAY_MODES.join(", ")}`);
        options.mode = mode;
        break;
      }
      case "--provider": {
        const provider = takeValue().trim().toLowerCase();
        if (!INTEREST_MODEL_PROVIDER_IDS.includes(provider)) {
          throw new Error(`--provider must be one of ${INTEREST_MODEL_PROVIDER_IDS.join(", ")}`);
        }
        options.provider = provider;
        break;
      }
      case "--model":
        options.model = nonEmpty(takeValue(), flag);
        break;
      case "--base-url":
        options.baseUrl = nonEmpty(takeValue(), flag);
        break;
      case "--timeout-ms":
        options.timeoutMs = boundedInteger(takeValue(), flag, 1000, 20_000);
        break;
      case "--concurrency":
        options.concurrency = boundedInteger(takeValue(), flag, 1, 32);
        break;
      case "--json":
        if (inlineValue !== null) throw new Error("--json does not take a value");
        options.json = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return options;
}

function nonEmpty(value, flag) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${flag} needs a non-empty value`);
  return text;
}

function boundedInteger(value, flag, min, max) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return number;
}

// ---------------------------------------------------------------------------
// Samples

// Parses JSONL. Errors name the line number and the problem only: neither the
// line content nor the JSON parser message (which quotes input) is echoed.
export function loadSamples(text) {
  const samples = [];
  const seenIds = new Set();
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${lineNumber}: invalid JSON`);
    }
    const sample = normalizeSample(value, lineNumber);
    if (seenIds.has(sample.id)) throw new Error(`line ${lineNumber}: duplicate sample id "${sample.id}"`);
    seenIds.add(sample.id);
    samples.push(sample);
  }
  return samples;
}

function normalizeSample(value, lineNumber) {
  const fail = (problem) => new Error(`line ${lineNumber}: ${problem}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("sample must be a JSON object");
  const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id).trim() : "";
  if (!id) throw fail("missing id");
  const expected = String(value.expected || "").trim().toLowerCase();
  if (!QQ_ALIAS_ADDRESS_TARGETS.includes(expected)) {
    throw fail(`expected must be one of ${QQ_ALIAS_ADDRESS_TARGETS.join(", ")}`);
  }
  if (!value.event || typeof value.event !== "object" || Array.isArray(value.event)) throw fail("event must be an object");
  if (typeof value.event.text !== "string") throw fail("event.text must be a string");
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string"))) {
    throw fail("aliases must be an array of strings");
  }
  if (value.recent !== undefined && !Array.isArray(value.recent)) throw fail("recent must be an array");
  const aliases = (value.aliases || []).map((alias) => alias.trim()).filter(Boolean);
  const stratum = typeof value.stratum === "string" && value.stratum.trim() ? value.stratum.trim() : DEFAULT_STRATUM;
  return {
    id,
    stratum,
    aliases,
    assistantName: typeof value.assistantName === "string" && value.assistantName.trim() ? value.assistantName.trim() : aliases[0] || "assistant",
    event: { type: "group_message", ...value.event },
    recent: value.recent || [],
    expected
  };
}

// ---------------------------------------------------------------------------
// Prediction

function baseResult(sample) {
  return {
    id: sample.id,
    stratum: sample.stratum,
    expected: sample.expected,
    predicted: "unclear",
    reasonCode: null,
    source: null,
    modelCalled: false,
    failed: false,
    timedOut: false,
    invalidOutput: false,
    durationMs: null,
    formatRetryCount: 0
  };
}

// Returns one result row for a sample. Only the judge mode talks to a model;
// `options.runTask` replaces the network executor in tests.
export async function predictSample(sample, options = {}) {
  const mode = options.mode || "judge";
  if (!REPLAY_MODES.includes(mode)) throw new Error(`unknown replay mode: ${mode}`);
  const result = baseResult(sample);
  const protocolSource = classifyQqProtocolAddress(sample.event);
  const aliasHits = findQqAssistantAliasHits(sample.event.text, sample.aliases);

  if (mode === "legacy") {
    if (protocolSource) return { ...result, predicted: "bot", reasonCode: `protocol_${protocolSource}`, source: "protocol" };
    if (aliasHits.length > 0) return { ...result, predicted: "bot", reasonCode: "alias_substring", source: "legacy" };
    return { ...result, predicted: "other", reasonCode: "no_alias_hit", source: "legacy" };
  }

  if (protocolSource) {
    return { ...result, predicted: "bot", reasonCode: `protocol_${protocolSource}`, source: "protocol" };
  }

  if (mode === "heuristic") {
    const verdict = heuristicQqAliasAddressVerdict(sample.event.text, sample.aliases);
    return { ...result, predicted: verdict.target, reasonCode: verdict.reasonCode, source: "heuristic" };
  }

  // judge mode: no alias hit means the message is not a candidate at all.
  if (aliasHits.length === 0) {
    return { ...result, predicted: "other", reasonCode: "no_alias_hit", source: "no_candidate" };
  }
  const payload = buildQqAliasAddressPayload({
    event: sample.event,
    aliases: sample.aliases,
    assistantName: sample.assistantName,
    recentMessages: sample.recent,
    maxRecentMessages: MAX_RECENT_MESSAGES
  });
  const judged = await judgeQqAliasAddress({
    runTask: options.runTask || runQqInterestModelStructuredTask,
    model: options.model || {},
    payload,
    timeoutMs: options.timeoutMs,
    ...(typeof options.now === "function" ? { now: options.now } : {})
  });
  const modelResult = {
    ...result,
    source: "judge",
    modelCalled: true,
    durationMs: Number.isFinite(Number(judged.durationMs)) ? Number(judged.durationMs) : null,
    formatRetryCount: Number(judged.formatRetryCount) || 0
  };
  const verdict = judged.ok ? normalizeQqAliasAddressVerdict(judged) : null;
  if (verdict) return { ...modelResult, predicted: verdict.target, reasonCode: verdict.reasonCode };

  // Anything else is a silent "unclear", as in the Hub. Reasons are reduced to
  // fixed codes so no provider or model text reaches the report.
  const reason = String(judged.reason || "");
  const timedOut = Boolean(judged.timedOut) || /timed out|no new token/i.test(reason);
  const invalidOutput = Boolean(judged.invalidOutput) || (judged.ok === true && !verdict);
  return {
    ...modelResult,
    predicted: "unclear",
    failed: true,
    timedOut,
    invalidOutput,
    reasonCode: timedOut ? "judge_timeout" : invalidOutput ? "judge_invalid_output" : "judge_error"
  };
}

// Runs every sample, at most `concurrency` at a time, keeping input order.
export async function runReplay(samples, options = {}) {
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 1));
  const results = new Array(samples.length);
  let next = 0;
  async function worker() {
    while (next < samples.length) {
      const index = next;
      next += 1;
      const sample = samples[index];
      try {
        results[index] = await predictSample(sample, options);
      } catch {
        results[index] = {
          ...baseResult(sample),
          source: "error",
          failed: true,
          reasonCode: "replay_error"
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Metrics

function rate(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

// Nearest-rank percentile over an ascending array.
function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(quantile * sorted.length)));
  return sorted[rank - 1];
}

function computeMetrics(results) {
  let expectedBot = 0;
  let expectedNotBot = 0;
  let misses = 0;
  let falseCalls = 0;
  let correct = 0;
  let routeCorrect = 0;
  let modelCalls = 0;
  let failures = 0;
  let timeouts = 0;
  let invalidOutputs = 0;
  let formatRetries = 0;
  const latencies = [];
  for (const result of results) {
    const expectedIsBot = result.expected === "bot";
    const predictedIsBot = result.predicted === "bot";
    if (expectedIsBot) {
      expectedBot += 1;
      if (!predictedIsBot) misses += 1;
    } else {
      expectedNotBot += 1;
      if (predictedIsBot) falseCalls += 1;
    }
    if (result.expected === result.predicted) correct += 1;
    if (expectedIsBot === predictedIsBot) routeCorrect += 1;
    if (result.failed) failures += 1;
    if (result.timedOut) timeouts += 1;
    if (result.invalidOutput) invalidOutputs += 1;
    if (result.modelCalled) {
      modelCalls += 1;
      formatRetries += Number(result.formatRetryCount) || 0;
      if (Number.isFinite(Number(result.durationMs)) && result.durationMs !== null) latencies.push(Number(result.durationMs));
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    samples: results.length,
    expectedBot,
    expectedNotBot,
    misses,
    falseCalls,
    missRate: rate(misses, expectedBot),
    falseCallRate: rate(falseCalls, expectedNotBot),
    accuracy: rate(correct, results.length),
    routeAccuracy: rate(routeCorrect, results.length),
    modelCalls,
    failures,
    timeouts,
    invalidOutputs,
    formatRetries,
    latencyMs: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }
  };
}

// Metrics overall and per stratum. missRate = expected bot but predicted not
// bot; falseCallRate = expected not bot (other or unclear) but predicted bot;
// accuracy is exact target match, routeAccuracy only compares bot vs not bot.
export function summarize(results, meta = {}) {
  const rows = Array.isArray(results) ? results : [];
  const grouped = new Map();
  for (const result of rows) {
    const key = result.stratum || DEFAULT_STRATUM;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(result);
  }
  const strata = {};
  for (const [stratum, group] of grouped) strata[stratum] = computeMetrics(group);
  return {
    mode: meta.mode ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    promptVersion: meta.promptVersion ?? null,
    overall: computeMetrics(rows),
    strata
  };
}

// ---------------------------------------------------------------------------
// Model configuration

export function resolveReplayModelConfig(options = {}, env = process.env) {
  const provider = options.provider || "ollama";
  if (provider === "codex") {
    throw new Error("the codex provider runs inside the Hub and cannot be replayed offline; use ollama, openrouter, deepseek or custom");
  }
  const runtime = resolveInterestModelRuntimeConfig(provider, {
    openRouterApiKey: env.OPENROUTER_API_KEY || env.CODEX_REMOTE_CONTACT_OPENROUTER_API_KEY || "",
    openRouterBaseUrl: env.OPENROUTER_BASE_URL || env.CODEX_REMOTE_CONTACT_OPENROUTER_BASE_URL || "",
    deepSeekApiKey: env.DEEPSEEK_API_KEY || env.CODEX_REMOTE_CONTACT_DEEPSEEK_API_KEY || "",
    deepSeekBaseUrl: env.DEEPSEEK_BASE_URL || env.CODEX_REMOTE_CONTACT_DEEPSEEK_BASE_URL || "",
    customInterestModelApiKey: env.CODEX_REMOTE_CONTACT_QQ_PROACTIVE_JUDGE_API_KEY || "",
    customInterestModelBaseUrl: env.CODEX_REMOTE_CONTACT_QQ_PROACTIVE_JUDGE_BASE_URL || "",
    ollamaBaseUrl: env.OLLAMA_BASE_URL || env.CODEX_REMOTE_CONTACT_OLLAMA_BASE_URL || ""
  });
  const baseUrl = String(options.baseUrl || runtime.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(options.model || runtime.defaultModel || "").trim();
  if (!runtime.apiKeyConfigured) {
    throw new Error(`no API key configured for provider ${provider}; set it in the environment (see --help)`);
  }
  if (!baseUrl) throw new Error(`no base URL configured for provider ${provider}; pass --base-url`);
  return { provider, apiKey: runtime.apiKey, baseUrl, model };
}

// ---------------------------------------------------------------------------
// Output

function formatPercent(value) {
  return value === null || value === undefined ? "-" : (value * 100).toFixed(1);
}

function formatMs(value) {
  return value === null || value === undefined ? "-" : String(Math.round(value));
}

function renderTable(headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) => cells.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join("  ");
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

function metricsRow(name, metrics) {
  return [
    name,
    metrics.samples,
    metrics.expectedBot,
    formatPercent(metrics.missRate),
    formatPercent(metrics.falseCallRate),
    formatPercent(metrics.accuracy),
    formatPercent(metrics.routeAccuracy),
    metrics.modelCalls,
    metrics.timeouts,
    metrics.invalidOutputs,
    formatMs(metrics.latencyMs.p50),
    formatMs(metrics.latencyMs.p95)
  ];
}

export function formatReport(report) {
  const lines = [
    `mode: ${report.mode}`,
    `provider: ${report.provider ?? "-"}`,
    `model: ${report.model ?? "-"}`,
    `prompt version: ${report.promptVersion ?? "-"}`,
    ""
  ];
  const headers = ["stratum", "n", "bot", "miss%", "false%", "acc%", "route%", "calls", "timeout", "invalid", "p50ms", "p95ms"];
  const rows = Object.entries(report.strata).map(([name, metrics]) => metricsRow(name, metrics));
  rows.push(metricsRow("ALL", report.overall));
  lines.push(renderTable(headers, rows));
  lines.push("");
  lines.push("miss% = expected bot but not predicted bot; false% = expected not bot but predicted bot;");
  lines.push("acc% = exact target match; route% = bot-vs-not-bot match; latency covers model calls only.");
  const flagged = (report.results || []).filter((result) => result.failed || (result.expected === "bot") !== (result.predicted === "bot"));
  lines.push("");
  lines.push("Routing mismatches and failures:");
  if (flagged.length === 0) {
    lines.push("  none");
  } else {
    lines.push(renderTable(
      ["id", "stratum", "expected", "predicted", "reason", "ms"],
      flagged.map((result) => [result.id, result.stratum, result.expected, result.predicted, result.reasonCode ?? "-", formatMs(result.durationMs)])
    ).split("\n").map((line) => `  ${line}`).join("\n"));
  }
  return `${lines.join("\n")}\n`;
}

export function buildReport(results, meta = {}) {
  return {
    ...summarize(results, meta),
    results: results.map((result) => ({
      id: result.id,
      stratum: result.stratum,
      expected: result.expected,
      predicted: result.predicted,
      reasonCode: result.reasonCode,
      source: result.source,
      modelCalled: result.modelCalled,
      failed: result.failed,
      timedOut: result.timedOut,
      invalidOutput: result.invalidOutput,
      durationMs: result.durationMs
    }))
  };
}

// ---------------------------------------------------------------------------
// Entry point

// Returns the process exit code: 0 on success, 2 on usage or input errors.
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const readText = io.readFile || ((path) => readFile(path, "utf8"));
  const fail = (message) => {
    stderr.write(`error: ${message}\n`);
    return 2;
  };

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`error: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!options.input) {
    stderr.write(`error: --input is required\n\n${USAGE}`);
    return 2;
  }

  let samples;
  try {
    samples = loadSamples(await readText(resolve(options.input)));
  } catch (error) {
    return fail(error?.code ? `cannot read input file (${error.code})` : error.message);
  }
  if (samples.length === 0) return fail("input contains no samples");

  let model = null;
  if (options.mode === "judge") {
    try {
      model = resolveReplayModelConfig(options, env);
    } catch (error) {
      return fail(error.message);
    }
    if (typeof io.fetch === "function") model = { ...model, fetch: io.fetch };
  }

  const results = await runReplay(samples, {
    mode: options.mode,
    model,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    runTask: io.runTask,
    now: io.now
  });
  const report = buildReport(results, {
    mode: options.mode,
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    promptVersion: options.mode === "judge" ? QQ_ALIAS_ADDRESS_PROMPT_VERSION : null
  });
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`error: ${error?.message || "replay failed"}\n`);
    process.exitCode = 1;
  });
}
