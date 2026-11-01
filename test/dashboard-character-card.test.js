import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantProfileStore, fitAssistantProfile } from "../src/dashboard-character-card.js";

async function withStore(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "character-card-"));
  try {
    await run(createAssistantProfileStore({ filePath: join(directory, "cards", "card.md"), ...options }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a missing card reads as empty and the first save creates it", () => withStore(async (store) => {
  assert.equal((await store.readSummary()).content, "");
  const saved = await store.save("  # 角色卡\r\n说话短  ");
  assert.equal(saved.content, "# 角色卡\n说话短");
  assert.equal(saved.chars, 9);
  assert.equal(await readFile(store.filePath, "utf8"), "# 角色卡\n说话短\n");
}));

test("saving keeps the previous card as a backup", () => withStore(async (store) => {
  await store.save("旧卡");
  await store.save("新卡");
  assert.equal(await readFile(`${store.filePath}.bak`, "utf8"), "旧卡\n");
  assert.equal(await store.read(), "新卡\n");
}));

test("a card over the limit is refused and leaves the file alone", () => withStore(async (store) => {
  await store.save("原文");
  await assert.rejects(store.save("超长内容"), /at most 3 characters/);
  await assert.rejects(store.save(42), /must be a string/);
  assert.equal(await store.read(), "原文\n");
}, { maxChars: 3 }));

test("a hand-edited file over the limit is cut and reported", () => withStore(async (store, directory) => {
  const path = join(directory, "long.md");
  await writeFile(path, "abcdef");
  const { content, truncated } = fitAssistantProfile(await readFile(path, "utf8"), 4);
  assert.equal(content, "abcd");
  assert.equal(truncated, true);
  assert.equal(fitAssistantProfile("abc", 4).truncated, false);
}));
