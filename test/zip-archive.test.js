import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { createZipArchive, isZipArchive, readZipArchive } from "../src/infrastructure/zip-archive.js";

test("a written archive reads back byte for byte", () => {
  const binary = Buffer.from([0, 1, 2, 3, 255]);
  const archive = createZipArchive([
    { name: "README.md", data: "说明\n".repeat(100) },
    { name: "images/a.png", data: binary }
  ]);
  assert.equal(isZipArchive(archive), true);
  const files = readZipArchive(archive);
  assert.deepEqual(files.map((file) => file.name), ["README.md", "images/a.png"]);
  assert.equal(files[0].data.toString("utf8"), "说明\n".repeat(100));
  assert.deepEqual(files[1].data, binary);
});

test("corrupted, oversized and non-ZIP input is rejected", () => {
  const archive = createZipArchive([{ name: "a.md", data: "hello hello hello" }]);
  const damaged = Buffer.from(archive);
  damaged[35] ^= 0xff;
  assert.throws(() => readZipArchive(damaged), /damaged/);
  assert.throws(() => readZipArchive(archive, { maxEntryBytes: 3 }), /too large/);
  assert.throws(() => readZipArchive(archive, { maxEntries: 0 }), /more than 0/);
  assert.throws(() => readZipArchive(Buffer.from("not a zip file, just some text here")), /not a ZIP/);
});

test("an entry cannot inflate past the size its directory declares", () => {
  const archive = createZipArchive([{ name: "bomb.md", data: Buffer.alloc(4096, 97) }]);
  const lied = Buffer.from(archive);
  const central = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lied.writeUInt32LE(10, central + 24);
  assert.throws(() => readZipArchive(lied), /damaged/);
  assert.ok(deflateRawSync(Buffer.alloc(4096, 97)).length < 4096);
});
