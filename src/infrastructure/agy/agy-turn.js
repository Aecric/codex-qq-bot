import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentRuntimeEnvKeys, pickAgentChildEnv } from "../agent/agent-child-env.js";
import { DEFAULT_TURN_TIMEOUT_MS, normalizePositiveInteger, notifyObserver } from "../agent/agent-turn-process.js";
import { buildStdioQqMcpConfig, flattenQqDynamicTools, QQ_MCP_SERVER_NAME, startQqMcpToolServer } from "../agent/qq-mcp-tools.js";

const contextQueries = new Set(["history", "lookup"]);
const runtimeKeys = new Set([...baseAgentRuntimeEnvKeys, "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);

export function runAgyTurn(options = {}) {
  if (options.imagePaths?.length) throw new Error("Antigravity CLI chat supports text input only");
  options.signal?.throwIfAborted();
  const tools = flattenQqDynamicTools(options.dynamicTools)
    .filter(({ namespace, tool }) => namespace === "qq_context" && contextQueries.has(tool));
  const turnId = randomUUID();
  if (!tools.length || typeof options.onDynamicToolCall !== "function") {
    return runAgyProcess(options, turnId);
  }
  return runWithContextTools(options, turnId, tools);
}

async function runWithContextTools(options, turnId, tools) {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-"));
  let server;
  try {
    server = await startQqMcpToolServer({
      workDir: cwd,
      tools,
      onCall: options.onDynamicToolCall,
      getTurn: () => ({ turnId, threadId: null }),
      callIdPrefix: "agy-mcp"
    });
    const agentsDir = join(cwd, ".agents");
    await mkdir(agentsDir, { mode: 0o700 });
    await writeFile(join(agentsDir, "mcp_config.json"), JSON.stringify(buildStdioQqMcpConfig(server.launch)), { mode: 0o600 });
    // Strict mode asks even for allowlisted tools. Default execution mode
    // with request-review lets these two queries run in headless turns.
    const settings = {
      agentMode: "",
      toolPermission: "request-review",
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: server.toolNames.map((name) => `mcp(${QQ_MCP_SERVER_NAME}/${name})`),
        deny: ["command(*)", "write_file(*)", "read_url(*)"]
      }
    };
    return await runAgyProcess({ ...options, cwd }, turnId, settings);
  } finally {
    server?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

function runAgyProcess({
  agyPath = "agy", cwd, model, baseInstructions, developerInstructions, prompt,
  outputSchema, signal, timeoutMs, onSpawn, onExit, onReady
}, turnId, settings = { toolPermission: "strict", allowNonWorkspaceAccess: false }) {
  signal?.throwIfAborted();
  const args = [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--disable-slash-commands", "--sandbox", "--settings", JSON.stringify(settings)
  ];
  if (model) args.push("--model", model);
  if (outputSchema) args.push("--json-schema", JSON.stringify(outputSchema));
  const content = [baseInstructions, developerInstructions, prompt].filter(Boolean).join("\n\n");
  return new Promise((resolve, reject) => {
    const child = execFile(agyPath, args, {
      cwd, env: pickAgentChildEnv(process.env, runtimeKeys), signal,
      timeout: normalizePositiveInteger(timeoutMs, DEFAULT_TURN_TIMEOUT_MS),
      killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      notifyObserver(onExit, child);
      if (error) {
        // execFile errors include the command and captured stderr, which can contain private content.
        reject(new Error(`Antigravity CLI failed (${error.code ?? error.signal ?? "unknown"})`));
        return;
      }
      try {
        const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
        const result = events.findLast((event) => event.event === "result")?.result;
        if (result?.is_error || typeof result?.response !== "string" || !result.response.trim()) {
          throw new Error("Antigravity CLI returned no successful chat response");
        }
        const finalResponse = result.response.trim();
        resolve({ threadId: null, turnId, resumed: false, status: "completed", finalResponse,
          items: [{ type: "agentMessage", phase: "final_answer", text: finalResponse }] });
      } catch (error) {
        reject(error instanceof SyntaxError ? new Error("Invalid Antigravity CLI output") : error);
      }
    });
    notifyObserver(onSpawn, child);
    notifyObserver(onReady, { child, turnId, interrupt: () => child.kill("SIGKILL") });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") child.kill("SIGKILL");
    });
    child.stdin.end(JSON.stringify({ event: "user", message: { content } }) + "\n");
  });
}
