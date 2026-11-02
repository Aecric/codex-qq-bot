import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createQqCreatedFilesStore, createQqFileUploader, stageQqReplyImages } from "../src/qq-created-files.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qq-created-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootDir = join(root, "tmp_create_files");
  const outputDir = join(root, "task", "output");
  await mkdir(outputDir, { recursive: true });
  const calls = [];
  const store = createQqCreatedFilesStore({ rootDir, now: () => new Date("2026-11-01T13:05:09Z"), uniqueId: () => "ab12cd34" });
  const uploader = createQqFileUploader({
    store,
    callOneBot: async (endpoint, payload, options) => {
      calls.push({ endpoint, payload, options });
      return { ok: true, endpoint };
    }
  });
  return { root, rootDir, outputDir, store, uploader, calls };
}

test("files are stored under the group id and uploaded to that group from the stored copy", async (t) => {
  const f = await fixture(t);
  const source = join(f.outputDir, "intro.html");
  await writeFile(source, "<title>介绍</title>");
  const signal = new AbortController().signal;
  const result = await f.uploader.uploadFile({ groupId: "1081821145", userId: "42" }, { path: source, name: "自我介绍.html" }, { signal });
  assert.equal(result.ok, true);
  const [call] = f.calls;
  assert.equal(call.endpoint, "upload_group_file");
  assert.equal(call.payload.group_id, 1081821145);
  assert.equal(call.payload.name, "自我介绍.html");
  assert.equal(call.options.signal, signal);
  assert.equal(call.payload.file, join(f.rootDir, "1081821145", "20261101-130509-ab12cd34-自我介绍.html"));
  assert.equal(await readFile(call.payload.file, "utf8"), "<title>介绍</title>");
  // The stored copy must survive the task workspace being removed after sending.
  await rm(join(f.root, "task"), { recursive: true });
  assert.equal(await readFile(call.payload.file, "utf8"), "<title>介绍</title>");
});

test("private files and images use the QQ id directory and private endpoints", async (t) => {
  const f = await fixture(t);
  const file = join(f.outputDir, "a.txt");
  const image = join(f.outputDir, "a.png");
  await Promise.all([writeFile(file, "a"), writeFile(image, "png")]);
  await f.uploader.uploadFile({ userId: 2294929752 }, { path: file });
  await f.uploader.sendImage({ userId: 2294929752 }, image);
  const [upload, send] = f.calls;
  assert.equal(upload.endpoint, "upload_private_file");
  assert.equal(upload.payload.user_id, 2294929752);
  assert.equal(upload.payload.name, "a.txt");
  assert.equal(dirname(upload.payload.file), join(f.rootDir, "2294929752"));
  assert.equal(send.endpoint, "send_private_msg");
  assert.equal(send.payload.user_id, 2294929752);
  const [segment] = send.payload.message;
  assert.equal(segment.type, "image");
  assert.equal(segment.data.file, `file://${join(f.rootDir, "2294929752", "20261101-130509-ab12cd34-a.png")}`);
});

test("group images go through send_group_msg", async (t) => {
  const f = await fixture(t);
  const image = join(f.outputDir, "a.png");
  await writeFile(image, "png");
  await f.uploader.sendImage({ groupId: "123" }, image);
  assert.equal(f.calls[0].endpoint, "send_group_msg");
  assert.equal(f.calls[0].payload.group_id, 123);
});

test("a non-numeric id can never escape the storage root", async (t) => {
  const f = await fixture(t);
  const source = join(f.outputDir, "a.txt");
  await writeFile(source, "a");
  for (const target of [{ groupId: "../../etc" }, { userId: "12/34" }, { userId: "" }, {}, null]) {
    const result = await f.uploader.uploadFile(target, { path: source });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "QQ_CREATED_FILE_STORE_FAILED");
    assert.throws(() => f.store.directoryFor(target), TypeError);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(readdir(f.rootDir), { code: "ENOENT" });
});

test("unsafe or very long names stay inside the directory and within filesystem limits", async (t) => {
  const f = await fixture(t);
  const source = join(f.outputDir, "a.txt");
  await writeFile(source, "a");
  const traversal = await f.store.stage({ userId: "1" }, source, "../../evil.txt");
  assert.equal(dirname(traversal), join(f.rootDir, "1"));
  assert.match(basename(traversal), /evil\.txt$/);
  const long = await f.store.stage({ userId: "1" }, source, `${"很长的名字".repeat(40)}.html`);
  assert.equal(dirname(long), join(f.rootDir, "1"));
  assert.match(long, /\.html$/);
  assert.ok(Buffer.byteLength(basename(long)) <= 200);
  assert.equal(await readFile(long, "utf8"), "a");
});

test("a directory or symlink is refused and nothing is uploaded", async (t) => {
  const f = await fixture(t);
  const secret = join(f.root, "secret.txt");
  const link = join(f.outputDir, "link.txt");
  await writeFile(secret, "secret");
  await symlink(secret, link);
  for (const path of [link, f.outputDir, join(f.outputDir, "missing.txt")]) {
    const result = await f.uploader.uploadFile({ userId: "1" }, { path });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    const image = await f.uploader.sendImage({ userId: "1" }, path);
    assert.equal(image.ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test("reply images are stored only when generated for this reply", async (t) => {
  const f = await fixture(t);
  const generated = join(f.outputDir, "a.png");
  const sticker = join(f.root, "sticker.png");
  const remote = "https://example.com/a.png";
  await Promise.all([writeFile(generated, "png"), writeFile(sticker, "sticker")]);
  const refs = await stageQqReplyImages(f.store, { groupId: "123" }, [generated, sticker, remote], {
    generatedDirs: [f.outputDir, "", join(f.root, "missing")]
  });
  assert.equal(refs[0], join(f.rootDir, "123", "20261101-130509-ab12cd34-a.png"));
  assert.equal(await readFile(refs[0], "utf8"), "png");
  assert.deepEqual(refs.slice(1), [sticker, remote]);
  assert.deepEqual(await readdir(join(f.rootDir, "123")), [basename(refs[0])]);
});

test("a failed store keeps the original image so the reply can still be sent", async (t) => {
  const f = await fixture(t);
  const generated = join(f.outputDir, "a.png");
  await writeFile(generated, "png");
  const errors = [];
  const refs = await stageQqReplyImages(f.store, { groupId: "not-a-group" }, [generated], {
    generatedDirs: [f.outputDir],
    onError: (error) => errors.push(error)
  });
  assert.deepEqual(refs, [generated]);
  assert.equal(errors.length, 1);
});
