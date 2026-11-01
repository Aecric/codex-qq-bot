import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isLoopbackRequestHost } from "../http-utils.js";
import { AGENT_ENGINE_IDS, describeAgentEngine, getAgentEngine } from "../infrastructure/agent/agent-engines.js";
import { parseEnvFile } from "../infrastructure/agent/agent-child-env.js";
import { createEnvironmentConfig } from "../config/environment.js";

// Dashboard engine switching. The choice lives in config/local.env, the same
// file `ncc engine` edits, and applies when the Hub restarts. API keys can be
// written here but are never returned.

const ENGINE_KEY = "CODEX_REMOTE_CONTACT_AGENT_ENGINE";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

// Environment names per engine. Codex takes its model from the dashboard's
// saved settings, so it has nothing to edit here.
const ENGINE_ENV = Object.freeze({
  codex: Object.freeze({}),
  claude: Object.freeze({ model: "CODEX_REMOTE_CONTACT_CLAUDE_MODEL", configModel: "claudeModel" }),
  deepseek: Object.freeze({
    model: "CODEX_REMOTE_CONTACT_DEEPSEEK_MODEL",
    configModel: "deepseekModel",
    apiKey: "DEEPSEEK_API_KEY",
    configApiKey: "deepSeekApiKey",
    baseUrl: "DEEPSEEK_BASE_URL",
    configBaseUrl: "deepSeekBaseUrl"
  }),
  gemini: Object.freeze({
    model: "CODEX_REMOTE_CONTACT_GEMINI_AGENT_MODEL",
    configModel: "geminiAgentModel",
    apiKey: "GEMINI_API_KEY",
    configApiKey: "geminiApiKey",
    baseUrl: "GEMINI_BASE_URL",
    configBaseUrl: "geminiBaseUrl"
  })
});

export class AgentEngineSettingsError extends Error {}

// Turns a dashboard request into environment updates. An empty value returns a
// setting to its default: removing the line would not, because a restarted Hub
// inherits the old value from its parent's environment. An omitted field is kept.
export function buildAgentEngineEnvUpdates(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const engine = String(source.engine || "").trim().toLowerCase();
  if (!AGENT_ENGINE_IDS.includes(engine)) throw new AgentEngineSettingsError("Unknown agent engine");
  const names = ENGINE_ENV[engine];
  const updates = { [ENGINE_KEY]: engine };
  if (source.model !== undefined && names.model) {
    const model = String(source.model || "").trim();
    if (model && !MODEL_PATTERN.test(model)) throw new AgentEngineSettingsError("The model name contains unsupported characters");
    updates[names.model] = model;
  }
  if (source.apiKey !== undefined && String(source.apiKey || "").trim() && names.apiKey) {
    const apiKey = String(source.apiKey).trim();
    if (!API_KEY_PATTERN.test(apiKey)) throw new AgentEngineSettingsError("The API key contains unsupported characters");
    updates[names.apiKey] = apiKey;
  }
  if (source.baseUrl !== undefined && names.baseUrl) {
    const baseUrl = String(source.baseUrl || "").trim();
    if (baseUrl) assertSafeBaseUrl(baseUrl);
    updates[names.baseUrl] = baseUrl;
  }
  return updates;
}

// The key is sent to this address, so it must be encrypted unless it stays on
// this computer, and the address itself must not carry credentials.
function assertSafeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgentEngineSettingsError("The API address is not a valid URL");
  }
  const encrypted = url.protocol === "https:";
  const local = url.protocol === "http:" && isLoopbackRequestHost(url.host);
  if (!encrypted && !local) throw new AgentEngineSettingsError("The API address must use HTTPS unless it is on this computer");
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentEngineSettingsError("The API address must not contain credentials or query parameters");
  }
}

// Single quotes keep the value literal both when the launch scripts source
// this file and when parseEnvFile reads it.
export function quoteEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Replaces each key at its first existing line and appends new ones, leaving
// comments and every other line untouched.
export function applyEnvFileUpdates(body, updates) {
  const remaining = new Map(Object.entries(updates));
  const seen = new Set();
  const lines = [];
  for (const line of String(body || "").split("\n")) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    if (!key || !remaining.has(key)) {
      lines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`export ${key}=${quoteEnvValue(remaining.get(key))}`);
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of remaining) {
    if (!seen.has(key)) lines.push(`export ${key}=${quoteEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readEnvFileText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function effectiveConfig(fileText, env) {
  return createEnvironmentConfig({ ...env, ...parseEnvFile(fileText) });
}

function connectionFingerprint(config) {
  return JSON.stringify(AGENT_ENGINE_IDS.map((id) => {
    const names = ENGINE_ENV[id];
    return [id, config[names.configModel] ?? null, config[names.configApiKey] ?? null, config[names.configBaseUrl] ?? null];
  }).concat([[config.agentEngine]]));
}

// What the next start would use, against what is running now. Secrets are
// reduced to whether they are present.
export async function readAgentEngineSettings({ envFilePath, env = process.env, running, ai = {}, canEdit = false, read = readEnvFileText }) {
  const saved = effectiveConfig(await read(envFilePath), env);
  return {
    runningEngine: running.agentEngine,
    savedEngine: saved.agentEngine,
    restartPending: connectionFingerprint(saved) !== connectionFingerprint(running),
    canEdit,
    engines: AGENT_ENGINE_IDS.map((id) => {
      const names = ENGINE_ENV[id];
      const description = describeAgentEngine(id, { ai, claudeModel: saved.claudeModel, deepseekModel: saved.deepseekModel, geminiAgentModel: saved.geminiAgentModel });
      return {
        id,
        name: getAgentEngine(id).name,
        transport: description.transport,
        model: description.model,
        modelEditable: Boolean(names.model),
        keyName: description.keyName,
        keyConfigured: names.configApiKey ? Boolean(saved[names.configApiKey]) : null,
        baseUrl: names.configBaseUrl ? displayBaseUrl(saved[names.configBaseUrl]) : null
      };
    })
  };
}

// An address set by hand could embed credentials; only its location is shown.
function displayBaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export async function saveAgentEngineSettings({ envFilePath, body, read = readEnvFileText }) {
  const updates = buildAgentEngineEnvUpdates(body);
  const next = applyEnvFileUpdates(await read(envFilePath), updates);
  const temporaryPath = `${envFilePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, next, { mode: 0o600 });
    await rename(temporaryPath, envFilePath);
    await chmod(envFilePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return updates[ENGINE_KEY];
}

// The helper outlives this process: it waits for the Hub to exit, starts a new
// one with the saved configuration and restores the QQ channel.
export function launchHubRestartHelper({ scriptPath, cwd, pid = process.pid, qqEnabled = false, port, launchdLabel = "", spawnProcess = spawn }) {
  const child = spawnProcess("bash", [scriptPath, String(pid), qqEnabled ? "1" : "0", String(port), launchdLabel], {
    cwd,
    detached: true,
    stdio: "ignore"
  });
  child.on?.("error", () => undefined);
  child.unref?.();
  return child;
}
