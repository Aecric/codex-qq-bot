import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEngineSettingsError,
  applyEnvFileUpdates,
  buildAgentEngineEnvUpdates,
  launchHubRestartHelper,
  quoteEnvValue,
  readAgentEngineSettings,
  saveAgentEngineSettings
} from "../src/app/agent-engine-settings.js";
import { parseEnvFile } from "../src/infrastructure/agent/agent-child-env.js";
import { createEnvironmentConfig } from "../src/config/environment.js";

const rejected = (body) => assert.throws(() => buildAgentEngineEnvUpdates(body), AgentEngineSettingsError);

test("requests are validated before they become environment updates", () => {
  assert.deepEqual(buildAgentEngineEnvUpdates({ engine: "Gemini", model: "gemini-x", apiKey: " k-1 ", baseUrl: "https://relay.example.test/v1" }), {
    CODEX_REMOTE_CONTACT_AGENT_ENGINE: "gemini",
    CODEX_REMOTE_CONTACT_GEMINI_AGENT_MODEL: "gemini-x",
    GEMINI_API_KEY: "k-1",
    GEMINI_BASE_URL: "https://relay.example.test/v1"
  });
  assert.deepEqual(buildAgentEngineEnvUpdates({ engine: "codex", model: "ignored", apiKey: "ignored" }), {
    CODEX_REMOTE_CONTACT_AGENT_ENGINE: "codex"
  });
  // An empty key field keeps the saved key; an empty address restores the default.
  assert.deepEqual(buildAgentEngineEnvUpdates({ engine: "deepseek", apiKey: "", baseUrl: "" }), {
    CODEX_REMOTE_CONTACT_AGENT_ENGINE: "deepseek",
    DEEPSEEK_BASE_URL: ""
  });
  rejected({ engine: "llama" });
  rejected({ engine: "gemini", model: "bad model; rm -rf /" });
  rejected({ engine: "gemini", apiKey: "two\nlines" });
  rejected({ engine: "gemini", baseUrl: "http://relay.example.test/v1" });
  rejected({ engine: "gemini", baseUrl: "https://user:pw@relay.example.test" });
  rejected({ engine: "gemini", baseUrl: "file:///etc/passwd" });
  assert.equal(buildAgentEngineEnvUpdates({ engine: "gemini", baseUrl: "http://127.0.0.1:8080/v1" }).GEMINI_BASE_URL, "http://127.0.0.1:8080/v1");
});

test("env updates keep other lines and survive both shell and Hub parsing", () => {
  const body = "# comment\nexport KEEP=1\nexport GEMINI_API_KEY=old\nGEMINI_API_KEY=older\n";
  const next = applyEnvFileUpdates(body, { GEMINI_API_KEY: "a'b$(touch /tmp/x)", NEW_KEY: "v" });
  assert.equal(next, `# comment\nexport KEEP=1\nexport GEMINI_API_KEY=${quoteEnvValue("a'b$(touch /tmp/x)")}\nexport NEW_KEY='v'\n`);
  assert.equal(parseEnvFile(next).GEMINI_API_KEY, "a'b$(touch /tmp/x)");
  const shell = execFileSync("bash", ["-c", 'eval "$BODY"; printf %s "$GEMINI_API_KEY"'], { env: { BODY: next, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(shell, "a'b$(touch /tmp/x)");
});

test("saving keeps the file private and reading never returns the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cqb-engine-settings-"));
  try {
    const envFilePath = join(dir, "local.env");
    writeFileSync(envFilePath, "export OTHER=keep\n");
    chmodSync(envFilePath, 0o644);
    const running = createEnvironmentConfig({});
    const before = await readAgentEngineSettings({ envFilePath, env: {}, running, canEdit: true });
    assert.equal(before.restartPending, false);
    assert.equal(before.savedEngine, "codex");

    assert.equal(await saveAgentEngineSettings({ envFilePath, body: { engine: "deepseek", apiKey: "sk-secret-value" } }), "deepseek");
    assert.equal(statSync(envFilePath).mode & 0o777, 0o600);
    assert.match(readFileSync(envFilePath, "utf8"), /^export OTHER=keep$/m);

    const after = await readAgentEngineSettings({ envFilePath, env: {}, running, canEdit: true });
    assert.equal(after.savedEngine, "deepseek");
    assert.equal(after.runningEngine, "codex");
    assert.equal(after.restartPending, true);
    assert.equal(after.engines.find((entry) => entry.id === "deepseek").keyConfigured, true);
    assert.equal(after.engines.find((entry) => entry.id === "gemini").keyConfigured, false);
    assert.equal(JSON.stringify(after).includes("sk-secret-value"), false);

    // Changing only the key still needs a restart to take effect.
    const sameEngine = createEnvironmentConfig(parseEnvFile(readFileSync(envFilePath, "utf8")));
    assert.equal((await readAgentEngineSettings({ envFilePath, env: {}, running: sameEngine })).restartPending, false);
    await saveAgentEngineSettings({ envFilePath, body: { engine: "deepseek", apiKey: "sk-new" } });
    assert.equal((await readAgentEngineSettings({ envFilePath, env: {}, running: sameEngine })).restartPending, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing an address beats a value inherited from the old Hub's environment", async () => {
  const body = applyEnvFileUpdates("", buildAgentEngineEnvUpdates({ engine: "gemini", baseUrl: "" }));
  const settings = await readAgentEngineSettings({
    envFilePath: "/unused",
    env: { GEMINI_BASE_URL: "https://old-relay.example.test/v1" },
    running: createEnvironmentConfig({}),
    read: async () => body
  });
  assert.equal(settings.engines.find((entry) => entry.id === "gemini").baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
});

test("a displayed base URL drops embedded credentials", async () => {
  const settings = await readAgentEngineSettings({
    envFilePath: "/unused",
    env: { GEMINI_BASE_URL: "https://user:pw@relay.example.test/v1/?token=abc" },
    running: createEnvironmentConfig({}),
    read: async () => ""
  });
  assert.equal(settings.engines.find((entry) => entry.id === "gemini").baseUrl, "https://relay.example.test/v1");
});

test("the restart helper is detached and told the channel state", () => {
  const calls = [];
  launchHubRestartHelper({
    scriptPath: "/x/restart-hub.sh",
    cwd: "/x",
    pid: 42,
    qqEnabled: true,
    port: 3789,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => calls.push("unref") };
    }
  });
  assert.deepEqual(calls[0].args, ["/x/restart-hub.sh", "42", "1", "3789", ""]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[1], "unref");
});
