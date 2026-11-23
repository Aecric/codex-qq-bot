import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { baseAgentRuntimeEnvKeys, pickAgentChildEnv } from "../agent/agent-child-env.js";
import { DEFAULT_TURN_TIMEOUT_MS, normalizePositiveInteger, notifyObserver } from "../agent/agent-turn-process.js";

const runtimeKeys = new Set([...baseAgentRuntimeEnvKeys, "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);

export function runAgyTurn({
  agyPath = "agy", cwd, model, baseInstructions, developerInstructions, prompt, imagePaths,
  outputSchema, signal, timeoutMs, onSpawn, onExit, onReady
}) {
  if (imagePaths?.length) throw new Error("Antigravity CLI chat supports text input only");
  signal?.throwIfAborted();
  const args = [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--disable-slash-commands", "--sandbox", "--settings", JSON.stringify({ toolPermission: "strict", allowNonWorkspaceAccess: false })
  ];
  if (model) args.push("--model", model);
  if (outputSchema) args.push("--json-schema", JSON.stringify(outputSchema));
  const content = [baseInstructions, developerInstructions, prompt].filter(Boolean).join("\n\n");
  return new Promise((resolve, reject) => {
    const turnId = randomUUID();
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
