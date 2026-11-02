import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildNapCatLoginResponse,
  createNapCatLoginClient,
  createQqSessionProbe,
  describeNapCatStatus,
  readEnvFileValue,
  readSessionProbeResponse,
  restartNapCatDockerContainer
} from "../src/napcat-login.js";

const hashOf = (token) => createHash("sha256").update(`${token}.napcat`).digest("hex");

function fakeNapCat({ login = {}, token = "secret" } = {}) {
  const calls = [];
  const server = {
    calls,
    login: { isLogin: false, isOffline: false, loginPhase: "qrcode", qrLoginAccepted: false, qrcodeurl: "", loginError: "", ...login },
    credential: "cred-1",
    refreshUrl: "https://txz.qq.com/p?k=new",
    refreshResponse: null,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(options.body);
      calls.push({ path, auth: options.headers.authorization || "" });
      const json = (status, payload) => new Response(JSON.stringify(payload), { status });
      if (path === "/api/auth/login") {
        return body.hash === hashOf(token)
          ? json(200, { code: 0, data: { Credential: server.credential } })
          : json(200, { code: -1, message: "bad token" });
      }
      if (options.headers.authorization !== `Bearer ${server.credential}`) return json(401, { code: -1 });
      if (path === "/api/QQLogin/CheckLoginStatus") return json(200, { code: 0, data: server.login });
      if (path === "/api/QQLogin/RefreshQRcode") {
        return json(200, server.refreshResponse || { code: 0, data: { qrcodeurl: server.refreshUrl } });
      }
      return json(404, {});
    }
  };
  return server;
}

const client = (server, overrides = {}) => createNapCatLoginClient({
  baseUrl: "http://127.0.0.1:6099/",
  loadToken: () => "secret",
  fetchImpl: server.fetchImpl,
  ...overrides
});

test("reads the login state and signs in only once", async () => {
  const server = fakeNapCat({ login: { qrcodeurl: "https://txz.qq.com/p?k=1", loginError: "过期" } });
  const napcat = client(server);
  const login = await napcat.readLogin();
  await napcat.readLogin();
  assert.equal(login.available, true);
  assert.equal(login.isLogin, false);
  assert.equal(login.qrcodeUrl, "https://txz.qq.com/p?k=1");
  assert.equal(login.loginError, "过期");
  assert.equal(server.calls.filter((call) => call.path === "/api/auth/login").length, 1);
});

test("an expired credential signs in again", async () => {
  const server = fakeNapCat();
  const napcat = client(server);
  await napcat.readLogin();
  server.credential = "cred-2";
  assert.equal((await napcat.readLogin()).available, true);
  assert.equal(server.calls.filter((call) => call.path === "/api/auth/login").length, 2);
});

test("a credential NapCat rejects with HTTP 200 after a restart signs in again", async () => {
  const server = fakeNapCat({ login: { qrcodeurl: "https://txz.qq.com/p?k=1" } });
  const fetchImpl = server.fetchImpl;
  server.fetchImpl = async (url, options) => {
    const response = await fetchImpl(url, options);
    return response.status === 401
      ? new Response(JSON.stringify({ code: -1, message: "Unauthorized" }), { status: 200 })
      : response;
  };
  const napcat = client(server);
  await napcat.readLogin();
  server.credential = "cred-2";
  const login = await napcat.readLogin();
  assert.equal(login.available, true);
  assert.equal(login.qrcodeUrl, "https://txz.qq.com/p?k=1");
});

test("a rejected token cools down instead of hammering the WebUI", async () => {
  let time = 1_000;
  const server = fakeNapCat({ token: "other" });
  const napcat = client(server, { now: () => time });
  assert.deepEqual(await napcat.readLogin(), { available: false, reason: "auth_failed" });
  assert.deepEqual(await napcat.readLogin(), { available: false, reason: "auth_failed" });
  assert.equal(server.calls.length, 1);
  time += 60_001;
  await napcat.readLogin();
  assert.equal(server.calls.length, 2);
});

test("a missing token or an unreachable WebUI is reported, not thrown", async () => {
  const server = fakeNapCat();
  assert.deepEqual(await client(server, { loadToken: () => "" }).readLogin(), { available: false, reason: "not_configured" });
  assert.equal(server.calls.length, 0);
  const down = client(server, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(await down.readLogin(), { available: false, reason: "unreachable" });
});

test("refreshing never asks NapCat for a QR code while the account is online", async () => {
  const server = fakeNapCat({ login: { isLogin: true } });
  const login = await client(server).refreshQrcode();
  assert.equal(login.isLogin, true);
  assert.equal(server.calls.some((call) => call.path === "/api/QQLogin/RefreshQRcode"), false);
});

test("refreshing returns a new QR code when logged out or kicked offline", async () => {
  for (const state of [{ isLogin: false }, { isLogin: false, isOffline: true }]) {
    const server = fakeNapCat({ login: state });
    const login = await client(server).refreshQrcode();
    assert.equal(login.qrcodeUrl, "https://txz.qq.com/p?k=new");
    assert.equal(server.calls.some((call) => call.path === "/api/QQLogin/RefreshQRcode"), true);
  }
});

test("a failed refresh keeps the state and carries NapCat's message", async () => {
  const server = fakeNapCat({ login: { qrcodeurl: "https://old" } });
  server.refreshResponse = { code: -1, message: "QRCode Refresh Error: x" };
  const login = await client(server).refreshQrcode();
  assert.equal(login.qrcodeUrl, "https://old");
  assert.equal(login.refreshError, "QRCode Refresh Error: x");
});

test("status prefers NapCat's login state over a passing OneBot check", () => {
  const online = { ok: true, selfId: "2485984698" };
  const base = { available: true, isLogin: false, isOffline: false, phase: "", accepted: false };
  assert.equal(describeNapCatStatus({ ...base, isLogin: true }, online).state, "ok");
  assert.equal(describeNapCatStatus({ ...base, isLogin: true }, { ok: false }).state, "down");
  // Kicked offline while get_login_info still answers.
  const kicked = describeNapCatStatus({ ...base, isOffline: true }, online);
  assert.equal(kicked.state, "needs_login");
  assert.equal(kicked.account, "2485984698");
  assert.equal(describeNapCatStatus({ ...base, accepted: true }, online).state, "logging_in");
  assert.equal(describeNapCatStatus({ ...base, phase: "reconnecting" }, online).state, "logging_in");
  assert.equal(describeNapCatStatus({ available: false, reason: "not_configured" }, online).state, "ok");
  assert.equal(describeNapCatStatus({ available: false, reason: "unreachable" }, { ok: false }).state, "down");
});

test("a refused login asks for a new scan instead of staying in logging_in", () => {
  const refused = { available: true, isLogin: false, phase: "qrcode_scanned", accepted: false, qrcodeUrl: "https://txz.qq.com/p?k=1", loginError: "登录失败" };
  const response = buildNapCatLoginResponse(refused, { ok: false });
  assert.equal(response.state, "needs_login");
  assert.equal(response.loginError, "登录失败");
  assert.match(response.qrImage, /^data:image\/svg/);
  assert.equal(describeNapCatStatus({ ...refused, loginError: "" }, { ok: false }).state, "logging_in");
});

test("the QR image is only offered when it can be scanned", () => {
  const login = { available: true, isLogin: false, phase: "", accepted: false, qrcodeUrl: "https://txz.qq.com/p?k=1" };
  const response = buildNapCatLoginResponse(login, { ok: true });
  assert.match(response.qrImage, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(response.qrImage.split(",")[1], "base64").toString(), /^<svg /);
  assert.equal(JSON.stringify(response).includes("txz.qq.com"), false);
  assert.equal(buildNapCatLoginResponse({ ...login, isLogin: true }, { ok: true }).qrImage, "");
  assert.equal(buildNapCatLoginResponse({ ...login, accepted: true }, { ok: true }).qrImage, "");
  assert.equal(buildNapCatLoginResponse({ ...login, qrcodeUrl: "" }, { ok: true }).qrImage, "");
});

test("reads a value from a dotenv file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "napcat-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, ".env");
  await writeFile(file, "# comment\nOTHER=1\nexport WEBUI_TOKEN=\"abc=def\"\n");
  assert.equal(await readEnvFileValue(file, "WEBUI_TOKEN"), "abc=def");
  assert.equal(await readEnvFileValue(file, "MISSING"), "");
  assert.equal(await readEnvFileValue(join(root, "absent"), "WEBUI_TOKEN"), "");
});

test("a session counts as lost only after repeated failed probes", async () => {
  let time = 0;
  const results = [false, true, false, false, null, true];
  let calls = 0;
  const probe = createQqSessionProbe({ probe: async () => results[calls++], now: () => time, intervalMs: 100 });
  const run = async () => {
    await probe.check();
    time += 100;
    return probe.isLost();
  };
  assert.equal(await run(), false, "one failure is not enough");
  assert.equal(await run(), false, "success clears it");
  assert.equal(await run(), false);
  assert.equal(await run(), true, "two in a row");
  assert.equal(await run(), true, "unknown does not clear it");
  assert.equal(await run(), false, "success recovers");
});

test("the session probe is rate limited, single-flight and survives a thrown probe", async () => {
  let time = 0;
  let calls = 0;
  let release;
  const probe = createQqSessionProbe({
    probe: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
    now: () => time,
    intervalMs: 100
  });
  const first = probe.check();
  await new Promise(setImmediate);
  time = 500;
  assert.equal(probe.check(), first, "a slow probe is not started twice");
  assert.equal(calls, 1);
  release(false);
  await first;
  const second = probe.check();
  await new Promise(setImmediate);
  assert.equal(calls, 2, "due again once the interval has passed");
  release(true);
  await second;
  time = 550;
  assert.equal(probe.check(), null, "rate limited");
  assert.equal(calls, 2);

  const throwing = createQqSessionProbe({ probe: async () => { throw new Error("boom"); }, now: () => 0, intervalMs: 1 });
  await throwing.check();
  assert.equal(throwing.isLost(), false);
  probe.reset();
  assert.equal(probe.isLost(), false);
});

test("a lost session overrides NapCat's own online report", () => {
  const login = { available: true, isLogin: true, isOffline: false, phase: "ready", accepted: false, qrcodeUrl: "" };
  assert.equal(describeNapCatStatus(login, { ok: true }, { sessionLost: true }).state, "session_lost");
  assert.equal(describeNapCatStatus(login, { ok: true }).state, "ok");
  assert.equal(describeNapCatStatus(login, { ok: false }, { sessionLost: true }).state, "down");
  assert.equal(buildNapCatLoginResponse(login, { ok: true }, { sessionLost: true }).state, "session_lost");
});

test("a failed probe response is recognized", () => {
  assert.equal(readSessionProbeResponse({ ok: true }, { status: "ok" }), true);
  assert.equal(readSessionProbeResponse({ ok: true }, { status: "failed", retcode: 200 }), false);
  assert.equal(readSessionProbeResponse({ ok: false }, {}), false);
});

test("restarting uses Compose in the deployment directory and falls back to the app's docker", async () => {
  const calls = [];
  const missing = Object.assign(new Error("spawn"), { code: "ENOENT" });
  const result = await restartNapCatDockerContainer({
    composeDir: "/napcat",
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (command === "docker") throw missing;
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[1], { command: "/Applications/Docker.app/Contents/Resources/bin/docker", args: ["compose", "restart"], cwd: "/napcat" });
  const failure = new Error("no such service");
  let attempts = 0;
  const failed = await restartNapCatDockerContainer({ composeDir: "/napcat", run: async () => { attempts += 1; throw failure; } });
  assert.deepEqual(failed, { ok: false, error: failure });
  assert.equal(attempts, 1, "only a missing binary tries the next one");
});
