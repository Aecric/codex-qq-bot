import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectQqAgentEngine } from "../src/infrastructure/codex/qq-turn-runner.js";
import { buildQqNativeToolSpecs } from "../src/infrastructure/codex/qq-native-tools.js";

test("agy sends one text turn over stdin and returns only the final response", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agyPath = join(cwd, "agy");
  await writeFile(agyPath, `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.equal(args[args.indexOf("--model") + 1], "model-id");
assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).toolPermission, "strict");
const message = JSON.parse(fs.readFileSync(0, "utf8"));
assert.equal(message.message.content, "persona\\n\\nhistory\\n\\nhello");
console.log(JSON.stringify({event:"result",result:{response:"你好"}}));
`, { mode: 0o700 });
  const engine = selectQqAgentEngine("agy");
  assert.equal(engine.canResume("old-session"), false);
  assert.equal(engine.resolveToolTransport(), "mcp");
  const options = { cwd, agyPath, model: "model-id", baseInstructions: "persona", developerInstructions: "history", prompt: "hello" };
  assert.equal((await engine.runTurn(options)).finalResponse, "你好");
});

test("agy stages validated QQ images in a private workspace with scoped read permission", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const inputDir = join(cwd, "input");
  await mkdir(inputDir);
  const image = join(inputDir, "upload.bin");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=";
  await writeFile(image, Buffer.from(png, "base64"));
  const outside = join(cwd, "outside.png");
  await writeFile(outside, Buffer.from(png, "base64"));
  const link = join(inputDir, "link.png");
  await symlink(outside, link);
  const agyPath = join(cwd, "agy");
  await writeFile(agyPath, `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
assert.equal(settings.toolPermission, "request-review");
assert.equal(settings.allowNonWorkspaceAccess, false);
assert.deepEqual(settings.permissions.allow, ["read_file(qq-image-1.png)"]);
assert(settings.permissions.deny.includes("mcp(*)"));
assert(settings.permissions.deny.includes("command(*)"));
assert.deepEqual(fs.readdirSync("."), ["qq-image-1.png"]);
assert.equal(fs.readFileSync("qq-image-1.png").toString("base64"), "${png}");
const { message } = JSON.parse(fs.readFileSync(0, "utf8"));
assert.match(message.content, /qq-image-1\\.png/);
assert.match(message.content, /看一下/);
console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:process.cwd()}}));
`, { mode: 0o700 });
  const runTurn = selectQqAgentEngine("agy").runTurn;
  const options = { cwd, agyPath, prompt: "看一下", imageInputDir: inputDir, imagePaths: [image] };
  const { finalResponse } = await runTurn(options);
  assert.notEqual(finalResponse, cwd);
  await assert.rejects(access(finalResponse), { code: "ENOENT" });
  await assert.rejects(runTurn({ ...options, imagePaths: [link] }), /image outside allowed directory/);
  await assert.rejects(runTurn({ ...options, maxImageBytes: 10 }), /invalid image size or type/);
});

test("agy retries a model lookup once with the same pinned model", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agyPath = join(cwd, "agy");
  await writeFile(agyPath, `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.equal(process.argv[process.argv.indexOf("--model") + 1], "model-id");
fs.readFileSync(0);
if (!fs.existsSync("attempted")) {
  fs.writeFileSync("attempted", "");
  console.log(JSON.stringify({event:"result",result:{status:"ERROR",error:"invalid model selection"}}));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"你好"}}));
}
`, { mode: 0o700 });
  const result = await selectQqAgentEngine("agy").runTurn({ cwd, agyPath, model: "model-id", prompt: "hello" });
  assert.equal(result.finalResponse, "你好");
});

test("agy retries a cancelled tool turn in a fresh workspace without MCP tools", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "qq-agy-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agyPath = join(cwd, "agy");
  await writeFile(agyPath, `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { message } = JSON.parse(fs.readFileSync(0, "utf8"));
if (fs.existsSync(".agents/mcp_config.json")) {
  console.log(JSON.stringify({event:"result",result:{status:"CANCELED",response:""}}));
} else {
  const settings = JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]);
  assert.equal(settings.toolPermission, "strict");
  assert(settings.permissions.deny.includes("mcp(*)"));
  assert.match(message.content, /QQ 查询工具本轮不可用/);
  console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"你好"}}));
}
`, { mode: 0o700 });
  const attempts = [];
  const result = await selectQqAgentEngine("agy").runTurn({
    cwd, agyPath, prompt: "hello",
    dynamicTools: buildQqNativeToolSpecs({ isOwner: true }),
    onDynamicToolCall: () => assert.fail("no tool should execute"),
    onSpawn: (child) => attempts.push(child)
  });
  assert.equal(attempts.length, 2);
  assert.equal(result.finalResponse, "你好");
});

test("agy exposes only QQ context queries and dispatches them through the turn's bridge", async (t) => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "qq-agy-test-"));
  t.after(() => rm(fixtureDir, { recursive: true, force: true }));
  const agyPath = join(fixtureDir, "agy");
  await writeFile(agyPath, `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
assert.equal(settings.toolPermission, "request-review");
assert.deepEqual(settings.permissions.allow, ["mcp(qq/qq_context__history)", "mcp(qq/qq_context__lookup)"]);
const { mcpServers: { qq } } = JSON.parse(readFileSync(".agents/mcp_config.json", "utf8"));
const bridge = spawn(qq.command, qq.args, { env: { ...process.env, ...qq.env } });
const responses = readline.createInterface({ input: bridge.stdout });
function send(request) {
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\\n");
}
responses.on("line", (line) => {
  const { id, result } = JSON.parse(line);
  if (id === 1) {
    assert.deepEqual(result.tools.map(({ name }) => name), ["qq_context__history", "qq_context__lookup"]);
    send({ id: 2, method: "tools/call", params: { name: "qq_context__download_file" } });
  } else if (id === 2) {
    assert.equal(result.isError, true);
    send({ id: 3, method: "tools/call", params: { name: "qq_context__history", arguments: { query: "keyword" } } });
  } else {
    console.log(JSON.stringify({ event: "result", result: { response: JSON.stringify({ text: result.content[0].text, cwd: process.cwd() }) } }));
    bridge.stdin.end();
  }
});
readFileSync(0, "utf8");
send({ id: 1, method: "tools/list" });
`, { mode: 0o700 });
  const calls = [];
  const result = await selectQqAgentEngine("agy").runTurn({
    agyPath,
    cwd: fixtureDir,
    prompt: "Look up keyword",
    dynamicTools: buildQqNativeToolSpecs({ isOwner: true }),
    timeoutMs: 5_000,
    onDynamicToolCall(call) {
      calls.push(call);
      return "A message from the Hub";
    }
  });
  const reply = JSON.parse(result.finalResponse);
  assert.equal(reply.text, "A message from the Hub");
  assert.notEqual(reply.cwd, fixtureDir);
  await assert.rejects(access(reply.cwd), { code: "ENOENT" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, "qq_context");
  assert.equal(calls[0].tool, "history");
  assert.deepEqual(calls[0].arguments, { query: "keyword" });
  assert.equal(calls[0].turnId, result.turnId);
});
