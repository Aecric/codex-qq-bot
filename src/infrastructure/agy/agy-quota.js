import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { baseAgentRuntimeEnvKeys, pickAgentChildEnv } from "../agent/agent-child-env.js";

const run = promisify(execFile);
const quotaRuntimeKeys = new Set([
  ...baseAgentRuntimeEnvKeys, "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"
]);

export function normalizeAgyQuotaReport(report, now = Date.now()) {
  const command = report?.command;
  const inputGroups = command?.data?.groups;
  if (report?.status !== "SUCCESS" || report.num_turns !== 0
    || command?.name !== "usage" || !Array.isArray(inputGroups)) return null;

  const groups = [];
  for (const group of inputGroups) {
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!name || !Array.isArray(group.buckets)) continue;
    const primary = normalizeWindow(group.buckets.find((bucket) => bucket?.window === "5h"), 300);
    const secondary = normalizeWindow(group.buckets.find((bucket) => bucket?.window === "weekly"), 10_080);
    if (primary || secondary) groups.push({ name, primary, secondary });
  }
  return groups.length ? { available: true, updatedAt: new Date(now).toISOString(), groups } : null;
}

function normalizeWindow(bucket, windowMinutes) {
  const remaining = bucket?.remaining_fraction;
  if (bucket?.disabled || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) return null;
  const resetTime = Date.parse(bucket.reset_time);
  return {
    remainingPercent: remaining * 100,
    windowMinutes,
    resetsAt: Number.isFinite(resetTime) ? Math.floor(resetTime / 1_000) : null
  };
}

export function createAgyQuotaProbe(options, { ttlMs = 60_000, read = readAgyQuotaSnapshot } = {}) {
  let snapshot = null;
  let refreshedAt = -Infinity;
  let refresh = null;
  return {
    peek() {
      if (!refresh && Date.now() - refreshedAt >= ttlMs) {
        refresh = Promise.resolve().then(() => read(options))
          .then((result) => { snapshot = result; }, () => { snapshot = null; })
          .finally(() => {
            refreshedAt = Date.now();
            refresh = null;
          });
      }
      return snapshot;
    }
  };
}

export async function readAgyQuotaSnapshot({ agyPath = "agy" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-quota-"));
  try {
    // This built-in command refreshes account limits without a model turn.
    const settings = { disableSlashCommands: false, toolPermission: "strict", allowNonWorkspaceAccess: false };
    const pending = run(agyPath, [
      "--output-format", "json", "--sandbox", "--mode", "plan",
      "--settings", JSON.stringify(settings), "--print", "/usage"
    ], {
      cwd,
      env: pickAgentChildEnv(process.env, quotaRuntimeKeys),
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024
    });
    pending.child.stdin.end();
    const { stdout } = await pending;
    return normalizeAgyQuotaReport(JSON.parse(stdout));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
