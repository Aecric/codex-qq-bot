import assert from "node:assert/strict";
import test from "node:test";
import { createZipArchive, readZipArchive } from "../src/infrastructure/zip-archive.js";
import {
  applyKnowledgeImport,
  buildKnowledgeBackupArchive,
  buildKnowledgeTemplateArchive,
  normalizeKnowledgeImportScope,
  parseKnowledgeText,
  parseKnowledgeUpload,
  prepareKnowledgeImportImages,
  summarizeKnowledgeImportItems
} from "../src/knowledge-package.js";
import { createEmptyQqKnowledgeBase } from "../src/qq-knowledge-base.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const empty = () => createEmptyQqKnowledgeBase();
const variantsOf = (store, title) => store.entries.find((entry) => entry.title === title)?.variants || [];

test("headings become titled entries with aliases and a parent path", () => {
  const { items } = parseKnowledgeText("# 地点\n\n## 星港\n别名：港口, 第七星港\n贸易港。\n\n## 雾岛\n无人岛。\n\n# 人物\n\n## 莉娅\n会长。", { kind: "note" });
  assert.deepEqual(items.map((item) => item.title), ["地点 / 星港", "地点 / 雾岛", "人物 / 莉娅"]);
  assert.deepEqual(items[0].aliases, ["港口", "第七星港"]);
  assert.equal(items[0].content, "贸易港。");
});

test("one document title is left out of the entry titles", () => {
  const { items } = parseKnowledgeText("# 我的设定集\n\n## 星港\n贸易港。", { kind: "note" });
  assert.deepEqual(items.map((item) => item.title), ["星港"]);
});

test("slang uses the last heading as its term, or one term per line", () => {
  assert.equal(parseKnowledgeText("# 黑话\n## 上大分\n赢很多局", { kind: "slang" }).items[0].title, "上大分");
  const { items, warnings } = parseKnowledgeText("摸鱼：上班做别的事\n水群: 闲聊\n没有分隔的一行", { kind: "slang" });
  assert.deepEqual(items.map((item) => [item.title, item.content]), [["摸鱼", "上班做别的事"], ["水群", "闲聊"]]);
  assert.equal(warnings[0].code, "skipped");
});

test("long knowledge splits at sentences and long slang is cut, both with a warning", () => {
  const long = "这是一句设定。".repeat(300);
  const notes = parseKnowledgeText(`## 长文\n${long}`, { kind: "note" });
  assert.ok(notes.items.length > 1);
  assert.equal(notes.items[1].title, "长文（2）");
  assert.ok(notes.items.every((item) => item.content.length <= 800));
  assert.ok(notes.items[0].content.endsWith("。"), "splits between sentences");
  assert.equal(notes.warnings[0].code, "split");
  assert.equal(notes.items.map((item) => item.content).join("").replaceAll(" ", ""), long);

  const slang = parseKnowledgeText(`## 长词\n${long}`, { kind: "slang" });
  assert.equal(slang.items.length, 1);
  assert.equal(slang.items[0].content.length, 800);
  assert.equal(slang.warnings[0].code, "content_cut");
});

test("plain text without headings uses the file name as its title", () => {
  const { items } = parseKnowledgeText("第一段。\n\n第二段。", { kind: "note", fallbackTitle: "世界观" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "世界观");
  assert.equal(items[0].content, "第一段。 第二段。");
});

test("the untouched template has a README and imports nothing", () => {
  const archive = buildKnowledgeTemplateArchive();
  assert.deepEqual(readZipArchive(archive).map((file) => file.name), ["README.md", "notes.md", "slang.md"]);
  assert.throws(() => parseKnowledgeUpload({ fileName: "t.zip", data: archive }), /no knowledge entries/);
});

test("a filled-in package sorts by file and ignores Finder leftovers", () => {
  const archive = createZipArchive([
    { name: "包/README.md", data: "## 不导入\n说明" },
    { name: "包/notes.md", data: "## 星港\n贸易港。" },
    { name: "包/slang.md", data: "摸鱼：上班做别的事" },
    { name: "__MACOSX/包/._notes.md", data: "## 垃圾\n垃圾" },
    { name: "包/.DS_Store", data: "x" }
  ]);
  const parsed = parseKnowledgeUpload({ fileName: "包.zip", data: archive });
  assert.equal(parsed.format, "package");
  assert.deepEqual(parsed.items.map((item) => [item.kind, item.title]), [["note", "星港"], ["slang", "摸鱼"]]);
});

test("a text file takes the chosen type and GBK text still decodes", () => {
  const parsed = parseKnowledgeUpload({ fileName: "词.txt", data: Buffer.from("摸鱼：上班做别的事"), defaultKind: "slang" });
  assert.equal(parsed.format, "text");
  assert.equal(parsed.items[0].kind, "slang");
  const gbk = Buffer.from("c4e3bac3", "hex");
  assert.equal(parseKnowledgeUpload({ fileName: "设定.txt", data: gbk }).items[0].content, "你好");
  assert.throws(() => parseKnowledgeUpload({ fileName: "a.bin", data: Buffer.from([1, 0, 2]) }), /ZIP, Markdown or text/);
});

test("imports apply globally or to each chosen group, and a choice overrides any scope", () => {
  const items = parseKnowledgeText("## 星港\n贸易港。", { kind: "note" }).items;
  const global = applyKnowledgeImport(empty(), items, { mode: "global" });
  assert.deepEqual(variantsOf(global.store, "星港").map((variant) => variant.scope.type), ["global"]);
  assert.equal(global.counts.created, 1);

  const groups = applyKnowledgeImport(empty(), items, normalizeKnowledgeImportScope({ mode: "groups", groupIds: ["123456", "234567", "123456"] }));
  assert.deepEqual(variantsOf(groups.store, "星港").map((variant) => variant.scope.groupId), ["123456", "234567"]);
  assert.equal(groups.counts.created, 2);

  const kept = applyKnowledgeImport(empty(), [{ ...items[0], scope: { type: "group", groupId: "123456" } }], { mode: "keep" });
  assert.equal(variantsOf(kept.store, "星港")[0].scope.groupId, "123456");
  const overridden = applyKnowledgeImport(empty(), [{ ...items[0], scope: { type: "group", groupId: "123456" } }], { mode: "global" });
  assert.equal(variantsOf(overridden.store, "星港")[0].scope.type, "global");
});

test("importing again updates the same scope instead of duplicating", () => {
  const first = applyKnowledgeImport(empty(), parseKnowledgeText("## 星港\n旧。", { kind: "note" }).items, { mode: "global" });
  const again = applyKnowledgeImport(first.store, parseKnowledgeText("## 星港\n新。", { kind: "note" }).items, { mode: "global" });
  assert.equal(again.counts.updated, 1);
  assert.equal(again.store.entries.length, 1);
  assert.equal(variantsOf(again.store, "星港")[0].content, "新。");
  const same = applyKnowledgeImport(again.store, parseKnowledgeText("## 星港\n新。", { kind: "note" }).items, { mode: "global" });
  assert.equal(same.counts.unchanged, 1);
  const preview = summarizeKnowledgeImportItems(again.store, parseKnowledgeText("## 星港\n新。\n## 雾岛\n岛。", { kind: "note" }).items);
  assert.deepEqual(preview.map((item) => item.exists), [true, false]);
});

test("an import past the entry limit fails and drops nothing", () => {
  const fill = Array.from({ length: 499 }, (_, index) => ({ kind: "note", title: `条目${index}`, content: `内容${index}`, aliases: [], scope: null, images: [] }));
  let store = empty();
  for (let start = 0; start < fill.length; start += 50) {
    store = applyKnowledgeImport(store, fill.slice(start, start + 50), { mode: "global" }).store;
  }
  const extra = (title) => ({ kind: "note", title, content: `${title}的内容`, aliases: [], scope: null, images: [] });
  const full = applyKnowledgeImport(store, [extra("第五百条")], { mode: "global" }).store;
  assert.equal(full.entries.length, 500);
  assert.throws(() => applyKnowledgeImport(full, [extra("第五百零一条")], { mode: "global" }), /at most 500 entries/);
  assert.equal(full.entries.length, 500);
  assert.ok(full.entries.some((entry) => entry.title === "条目0"));
});

test("import scopes are validated", () => {
  assert.throws(() => normalizeKnowledgeImportScope({ mode: "everywhere" }), /keep, global or groups/);
  assert.throws(() => normalizeKnowledgeImportScope({ mode: "groups", groupIds: [] }), /at least one group/);
  assert.throws(() => normalizeKnowledgeImportScope({ mode: "groups", groupIds: ["abc"] }), /invalid group id/);
  assert.throws(
    () => normalizeKnowledgeImportScope({ mode: "groups", groupIds: Array.from({ length: 33 }, (_, index) => String(100000 + index)) }),
    /at most 32 groups/
  );
});

test("a backup restores kinds, scopes, aliases and pictures", async () => {
  const stored = { id: "a".repeat(64), mimeType: "image/png", bytes: PNG.length };
  const source = applyKnowledgeImport(empty(), [
    { kind: "note", title: "星港", content: "贸易港。", aliases: ["港口"], scope: { type: "group", groupId: "123456", groupName: "星港群" }, images: [{ data: PNG, caption: "地图" }] },
    { kind: "slang", title: "摸鱼", content: "上班做别的事", aliases: [], scope: null, images: [] }
  ], { mode: "keep" }, { storedImages: new Map() });
  const withPicture = applyKnowledgeImport(source.store, [
    { kind: "note", title: "星港", content: "贸易港。", aliases: [], scope: { type: "group", groupId: "123456" }, images: [] }
  ], { mode: "keep" });
  const image = { data: PNG, caption: "地图" };
  const pictured = applyKnowledgeImport(withPicture.store, [
    { kind: "note", title: "星港", content: "贸易港。", aliases: [], scope: { type: "group", groupId: "123456" }, images: [image] }
  ], { mode: "keep" }, { storedImages: new Map([[image, stored]]) });

  const backup = await buildKnowledgeBackupArchive(pictured.store, {
    readImage: async () => ({ data: PNG, mimeType: "image/png" })
  });
  assert.equal(backup.images, 1);
  assert.equal(backup.omittedImages, 0);

  const parsed = parseKnowledgeUpload({ fileName: "backup.zip", data: backup.archive });
  assert.equal(parsed.format, "backup");
  const imported = [];
  const { stored: storedImages, failed } = await prepareKnowledgeImportImages(parsed.items, async (data) => {
    imported.push(data);
    return stored;
  });
  assert.equal(failed, 0);
  assert.deepEqual(imported, [PNG]);
  const restored = applyKnowledgeImport(empty(), parsed.items, { mode: "keep" }, { storedImages });
  const port = variantsOf(restored.store, "星港")[0];
  assert.equal(port.scope.groupId, "123456");
  assert.equal(port.scope.groupName, "星港群");
  assert.equal(port.images[0].id, stored.id);
  assert.equal(port.images[0].caption, "地图");
  assert.deepEqual(restored.store.entries.find((entry) => entry.title === "星港").aliases, ["港口"]);
  assert.equal(restored.store.entries.find((entry) => entry.title === "摸鱼").kind, "slang");
  assert.equal(variantsOf(restored.store, "摸鱼")[0].scope.type, "global");
});

test("pictures over the budget or unreadable are left out and counted", async () => {
  const image = { data: PNG, caption: "" };
  const store = applyKnowledgeImport(empty(), [
    { kind: "note", title: "星港", content: "贸易港。", aliases: [], scope: null, images: [image] }
  ], { mode: "global" }, { storedImages: new Map([[image, { id: "b".repeat(64), mimeType: "image/png", bytes: 16 }]]) }).store;
  const over = await buildKnowledgeBackupArchive(store, { readImage: async () => ({ data: PNG, mimeType: "image/png" }), imageBudgetBytes: 1 });
  assert.equal(over.omittedImages, 1);
  const gone = await buildKnowledgeBackupArchive(store, { readImage: async () => { throw new Error("gone"); } });
  assert.equal(gone.omittedImages, 1);
  assert.equal(gone.entries, 1);
});

test("a picture the store refuses is counted and the rest still imports", async () => {
  const good = { data: PNG, caption: "" };
  const bad = { data: Buffer.from("nope"), caption: "" };
  const { stored, failed } = await prepareKnowledgeImportImages([{ images: [good, bad] }], async (data) => {
    if (data === bad.data) throw new Error("unsupported image signature");
    return { id: "c".repeat(64), mimeType: "image/png", bytes: 16 };
  });
  assert.equal(failed, 1);
  assert.equal(stored.size, 1);
});

test("a damaged or foreign backup is refused", () => {
  const notJson = createZipArchive([{ name: "knowledge.json", data: "{oops" }]);
  assert.throws(() => parseKnowledgeUpload({ fileName: "a.zip", data: notJson }), /not valid JSON/);
  const foreign = createZipArchive([{ name: "knowledge.json", data: "{\"format\":\"other\"}" }]);
  assert.throws(() => parseKnowledgeUpload({ fileName: "a.zip", data: foreign }), /not a knowledge backup/);
  const newer = createZipArchive([{ name: "knowledge.json", data: JSON.stringify({ format: "codex-qq-bot-knowledge", version: 99, entries: [] }) }]);
  assert.throws(() => parseKnowledgeUpload({ fileName: "a.zip", data: newer }), /newer version/);
});
