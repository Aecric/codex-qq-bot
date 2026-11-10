import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeQqGeminiImageTool } from "../src/app/qq-gemini-image-tool.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function fixture(t, { data = png } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qq-gemini-image-"));
  const inputDir = join(root, "input");
  await mkdir(inputDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const asked = [];
  let written = 0;
  return {
    asked,
    context: {
      candidates: [{ selector: "image-a", image: { file: "a" } }, { selector: "image-b", image: { file: "b" } }],
      taskWorkspace: { root, inputDir },
      prepareImage: async (image, { outputDir }) => {
        const path = join(outputDir, `prepared-${written++}.png`);
        await writeFile(path, data);
        return path;
      },
      compressImage: async () => { throw new Error("no compressor"); },
      ask: async (request) => {
        asked.push(request);
        return { ok: true, answer: "是龙娘" };
      }
    }
  };
}

test("sends the selected conversation images to Gemini as base64", async (t) => {
  const { asked, context } = await fixture(t);
  const result = await executeQqGeminiImageTool({ question: "这是谁", image_selectors: ["image-a", "image-a", "image-b"] }, context);
  assert.equal(result.ok, true);
  assert.match(result.reply, /2 张图.*是龙娘/);
  assert.equal(asked[0].question, "这是谁\n（共 2 张图，请按第几张分别回答。）");
  assert.deepEqual(asked[0].images.map((image) => image.mimeType), ["image/png", "image/png"]);
  assert.deepEqual(Buffer.from(asked[0].images[0].data, "base64"), png);
});

test("never asks Gemini when a selector is not in the image directory or the limit is exceeded", async (t) => {
  const { asked, context } = await fixture(t);
  const unknown = await executeQqGeminiImageTool({ question: "x", image_selectors: ["image-a", "image-evil"] }, context);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有发给 Gemini/);
  const tooMany = await executeQqGeminiImageTool({ question: "x", image_selectors: ["1", "2", "3", "4", "5"] }, context);
  assert.equal(tooMany.ok, false);
  const empty = await executeQqGeminiImageTool({ question: " ", image_selectors: ["image-a"] }, context);
  assert.equal(empty.ok, false);
  assert.equal(asked.length, 0);
});

test("reports an unreadable image truthfully and falls back to compression first", async (t) => {
  const { asked, context } = await fixture(t);
  const compressedPath = join(context.taskWorkspace.inputDir, "compressed.png");
  await writeFile(compressedPath, png);
  const oversized = Buffer.alloc(png.length + 10, png);
  const prepareImage = async (image, { outputDir, maxBytes }) => {
    const path = join(outputDir, `big-${maxBytes}.png`);
    await writeFile(path, oversized);
    return path;
  };
  const failed = await executeQqGeminiImageTool({ question: "x", image_selectors: ["image-a"] }, {
    ...context, prepareImage, maxBytes: png.length
  });
  assert.equal(failed.ok, false);
  assert.equal(asked.length, 0);

  const recovered = await executeQqGeminiImageTool({ question: "x", image_selectors: ["image-a"] }, {
    ...context, prepareImage, maxBytes: png.length, compressImage: async () => compressedPath
  });
  assert.equal(recovered.ok, true);
  assert.equal(asked.length, 1);
});

test("sends cached avatars of conversation people without unlocking feature recording", async (t) => {
  const { asked, context } = await fixture(t);
  const exported = [];
  const inspected = new Map();
  const avatars = {
    candidates: [{ userId: "123", displayName: "破晓", avatar: { imageId: "avatar-a", features: {}, fetchedAt: new Date().toISOString() } }],
    imageStore: {
      exportToDirectory: async (imageId) => {
        exported.push(imageId);
        return { path: "/never/sent", mimeType: "image/jpeg", data: png };
      }
    },
    inspected
  };
  const result = await executeQqGeminiImageTool({
    question: "这是谁", image_selectors: ["image-a"], avatar_user_ids: ["123"]
  }, { ...context, avatars });
  assert.equal(result.ok, true);
  assert.deepEqual(exported, ["avatar-a"]);
  assert.deepEqual(asked[0].images.map((image) => image.mimeType), ["image/png", "image/jpeg"]);
  assert.match(asked[0].question, /共 2 张图/);
  assert.doesNotMatch(asked[0].question, /破晓|123/);
  assert.match(result.reply, /第 2 张是QQ 123 的头像/);
  assert.match(result.reply, /inspect/);
  assert.equal(inspected.size, 0);
});

test("refuses avatars outside the conversation and enforces the shared limit", async (t) => {
  const { asked, context } = await fixture(t);
  const avatars = { candidates: [], imageStore: { exportToDirectory: async () => assert.fail("must not read") } };
  const stranger = await executeQqGeminiImageTool({ question: "x", avatar_user_ids: ["999"] }, { ...context, avatars });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /没有发给 Gemini.*头像候选/);
  const over = await executeQqGeminiImageTool({
    question: "x", image_selectors: ["image-a", "image-b"], avatar_user_ids: ["1", "2", "3"]
  }, { ...context, avatars });
  assert.equal(over.ok, false);
  const none = await executeQqGeminiImageTool({ question: "x" }, { ...context, avatars });
  assert.equal(none.ok, false);
  assert.equal(asked.length, 0);
});

test("surfaces a Gemini failure as a failed tool result", async (t) => {
  const { context } = await fixture(t);
  const result = await executeQqGeminiImageTool({ question: "x", image_selectors: ["image-a"] }, {
    ...context, ask: async () => ({ ok: false, reason: "quota exceeded" })
  });
  assert.deepEqual(result, { ok: false, error: "问 Gemini 失败：quota exceeded" });
});
