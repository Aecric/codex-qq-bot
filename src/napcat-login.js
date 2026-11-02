import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderQrSvg } from "./qr-code.js";

const authFailureCooldownMs = 60_000;
const sessionProbeIntervalMs = 60_000;
const sessionProbeFailuresToAlert = 2;
const dockerCommands = ["docker", "/Applications/Docker.app/Contents/Resources/bin/docker"];
const loggingInPhases = new Set(["qrcode_scanned", "initializing", "reconnecting"]);

// Reads one value from a dotenv-style file such as NapCat's Docker .env.
export async function readEnvFileValue(filePath, name, { loadFile = readFile } = {}) {
  const content = await loadFile(filePath, "utf8").catch(() => "");
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] === name) return match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return "";
}

class NapCatAuthError extends Error {}

// A restarted NapCat rejects old credentials with HTTP 200 and code -1, not a 401.
function isUnauthorizedResult({ status, payload }) {
  return status === 401 || status === 403 || /unauthorized/i.test(String(payload?.message || ""));
}

// A small client for the NapCat WebUI login API. It only reads the login state
// and asks for a QR code; NapCat itself refuses a refresh while the account is
// online, and refreshQrcode never asks in that state either.
export function createNapCatLoginClient({
  baseUrl,
  loadToken,
  fetchImpl = fetch,
  timeoutMs = 2_500,
  now = () => Date.now()
} = {}) {
  if (!baseUrl || !loadToken) throw new TypeError("baseUrl and loadToken are required");
  const apiBase = `${String(baseUrl).replace(/\/+$/, "")}/api`;
  let credential = "";
  let authFailedAt = -Infinity;

  async function post(path, body, headers = {}) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload };
  }

  async function signIn(token) {
    // Repeated bad tokens can lock the WebUI, and the dashboard polls this.
    if (now() - authFailedAt < authFailureCooldownMs) throw new NapCatAuthError("NapCat WebUI token was rejected");
    const hash = createHash("sha256").update(`${token}.napcat`).digest("hex");
    const { status, payload } = await post("/auth/login", { hash });
    if (status !== 200 || payload.code !== 0 || !payload.data?.Credential) {
      authFailedAt = now();
      throw new NapCatAuthError("NapCat WebUI token was rejected");
    }
    credential = payload.data.Credential;
  }

  async function call(path) {
    const token = String(await loadToken() || "").trim();
    if (!token) return { reason: "not_configured" };
    if (!credential) await signIn(token);
    let result = await post(path, {}, { authorization: `Bearer ${credential}` });
    if (isUnauthorizedResult(result)) {
      credential = "";
      await signIn(token);
      result = await post(path, {}, { authorization: `Bearer ${credential}` });
    }
    return { result };
  }

  async function readLogin() {
    try {
      const { reason, result } = await call("/QQLogin/CheckLoginStatus");
      if (reason) return { available: false, reason };
      if (result.status !== 200 || result.payload.code !== 0) return { available: false, reason: "unreachable" };
      const data = result.payload.data || {};
      return {
        available: true,
        isLogin: data.isLogin === true,
        isOffline: data.isOffline === true,
        phase: String(data.loginPhase || ""),
        accepted: data.qrLoginAccepted === true,
        qrcodeUrl: String(data.qrcodeurl || ""),
        loginError: String(data.loginError || "")
      };
    } catch (error) {
      return { available: false, reason: error instanceof NapCatAuthError ? "auth_failed" : "unreachable" };
    }
  }

  return {
    readLogin,
    async refreshQrcode() {
      const login = await readLogin();
      if (!login.available || login.isLogin) return login;
      const { result } = await call("/QQLogin/RefreshQRcode");
      if (result?.status === 200 && result.payload.code === 0 && result.payload.data?.qrcodeurl) {
        return { ...login, qrcodeUrl: String(result.payload.data.qrcodeurl) };
      }
      return { ...login, refreshError: String(result?.payload?.message || "") };
    }
  };
}

// NapCat can keep reporting online: true after QQ has invalidated the session,
// so only a request that must reach QQ's servers proves the session is alive.
// probe() resolves true (alive), false (failed) or null (could not tell). It runs
// in the background so a dead session, which answers slowly, never delays a status.
export function createQqSessionProbe({ probe, now = () => Date.now(), intervalMs = sessionProbeIntervalMs } = {}) {
  if (!probe) throw new TypeError("probe is required");
  let failures = 0;
  let lastRunAt = -Infinity;
  let running = null;
  return {
    check() {
      if (running || now() - lastRunAt < intervalMs) return running;
      lastRunAt = now();
      running = Promise.resolve()
        .then(probe)
        .catch(() => null)
        .then((alive) => {
          if (alive === true) failures = 0;
          else if (alive === false) failures += 1;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    reset() {
      failures = 0;
    },
    isLost() {
      return failures >= sessionProbeFailuresToAlert;
    }
  };
}

// A get_stranger_info result for the bot's own account, as a probe verdict.
export function readSessionProbeResponse(response, body) {
  return response.ok && (body?.status == null || body.status === "ok");
}

// NapCat's own /Process/Restart needs a parent process that the Docker image does
// not have, so a dead session is restarted through Compose. Volumes are untouched.
export async function restartNapCatDockerContainer({ composeDir, run }) {
  let lastError = null;
  for (const command of dockerCommands) {
    try {
      await run(command, ["compose", "restart"], { cwd: composeDir, timeoutMs: 60_000 });
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") break;
    }
  }
  return { ok: false, error: lastError };
}

// "ok" | "needs_login" | "logging_in" | "session_lost" | "down". get_login_info
// alone cannot tell: it can keep succeeding after QQ has kicked the account.
export function describeNapCatStatus(login, oneBot, { sessionLost = false } = {}) {
  const oneBotOk = Boolean(oneBot?.ok);
  const selfId = oneBot?.selfId ? String(oneBot.selfId) : "";
  if (!login?.available) {
    return { state: oneBotOk ? "ok" : "down", reason: login?.reason || "unreachable", account: selfId, loginError: "" };
  }
  let state = "needs_login";
  if (login.isLogin) state = !oneBotOk ? "down" : sessionLost ? "session_lost" : "ok";
  // A refused login stays in its phase, so an error means the next step is a new scan.
  else if (!login.loginError && (login.accepted || loggingInPhases.has(login.phase))) state = "logging_in";
  return { state, reason: "", account: selfId, loginError: login.loginError || "" };
}

// The dashboard's view of a login. The QR code only leaves when it can be used.
export function buildNapCatLoginResponse(login, oneBot, options = {}) {
  const status = describeNapCatStatus(login, oneBot, options);
  const canScan = status.state === "needs_login" && login?.qrcodeUrl;
  return {
    ...status,
    refreshError: login?.refreshError || "",
    qrImage: canScan
      ? `data:image/svg+xml;base64,${Buffer.from(renderQrSvg(login.qrcodeUrl)).toString("base64")}`
      : ""
  };
}
