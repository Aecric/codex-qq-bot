import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
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
  assert.throws(() => engine.runTurn({ ...options, imagePaths: ["photo.jpg"] }), /text input only/);
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
