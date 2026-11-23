import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectQqAgentEngine } from "../src/infrastructure/codex/qq-turn-runner.js";

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
  assert.equal(engine.resolveToolTransport(), "none");
  const options = { cwd, agyPath, model: "model-id", baseInstructions: "persona", developerInstructions: "history", prompt: "hello" };
  assert.equal((await engine.runTurn(options)).finalResponse, "你好");
  assert.throws(() => engine.runTurn({ ...options, imagePaths: ["photo.jpg"] }), /text input only/);
});
