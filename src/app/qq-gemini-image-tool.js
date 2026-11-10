import { executeQqAvatarMemoryTool } from "./qq-avatar-memory-tool.js";
import { executeQqImageMemoryTool } from "./qq-image-memory-tool.js";

// Gemini's inline request limit is 20 MB after base64, which adds a third.
const totalImageMaxBytes = 14 * 1024 * 1024;
const maxImages = 4;

export async function executeQqGeminiImageTool(args = {}, { ask, maxBytes = totalImageMaxBytes, avatars = {}, ...imageContext } = {}) {
  const question = String(args.question || "").trim();
  if (!question) return { ok: false, error: "要问 Gemini 的内容为空。" };
  const selectors = uniqueStrings(args.image_selectors);
  const avatarUserIds = uniqueStrings(args.avatar_user_ids);
  const count = selectors.length + avatarUserIds.length;
  if (count === 0) return { ok: false, error: "没有指定要发给 Gemini 的图片或头像。" };
  if (count > maxImages) return { ok: false, error: `一次最多给 Gemini 发 ${maxImages} 张图片或头像。` };

  const images = [];
  const labels = [];
  for (const selector of selectors) {
    const loaded = await loadImage(selector, { ...imageContext, maxBytes: Math.min(maxBytes, totalImageMaxBytes) });
    if (!loaded.ok) return { ok: false, error: `没有发给 Gemini：${loaded.error}` };
    images.push(loaded.image);
    labels.push(selector);
  }
  for (const userId of avatarUserIds) {
    const loaded = await loadAvatar(userId, { ...avatars, taskWorkspace: imageContext.taskWorkspace, assertActive: imageContext.assertActive });
    if (!loaded.ok) return { ok: false, error: `没有发给 Gemini：${loaded.error}` };
    images.push(loaded.image);
    labels.push(`QQ ${userId} 的头像`);
  }
  const totalBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
  if (totalBytes > totalImageMaxBytes) return { ok: false, error: "没有发给 Gemini：这些图片加起来太大，少选几张再试。" };

  // Gemini only gets numbered pictures; who each one belongs to stays here.
  const result = await ask({ question: images.length > 1 ? `${question}\n（共 ${images.length} 张图，请按第几张分别回答。）` : question, images });
  imageContext.assertActive?.();
  if (!result.ok) return { ok: false, error: `问 Gemini 失败：${result.reason}` };
  const order = labels.length > 1 ? `图片顺序：${labels.map((label, index) => `第 ${index + 1} 张是${label}`).join("，")}。` : "";
  const avatarNote = avatarUserIds.length > 0 ? "这只是 Gemini 的看法，你本人还没看过头像；要记录头像特征，先用 qq_memory.avatar 的 inspect 亲自看过再 record。" : "";
  return { ok: true, reply: `Gemini 看了 ${images.length} 张图后的解读（仅供参考，用自己的话转述）：${result.answer}\n${order}${avatarNote}`.trim() };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}

// A throwaway inspected map: sending an avatar to Gemini must not satisfy the
// rule that the Bot itself has seen an avatar before recording its features.
async function loadAvatar(userId, context) {
  const result = await executeQqAvatarMemoryTool({ action: "inspect", userId }, { ...context, inspected: new Map() });
  return result.ok ? readInlineImage(result) : { ok: false, error: result.error };
}

async function loadImage(selector, context) {
  let result = await executeQqImageMemoryTool({ action: "inspect", selector }, context);
  // An image over budget can still fit once compressed, when a compressor exists.
  if (!result.ok && context.candidates?.some((item) => item.selector === selector)) {
    const compressed = await executeQqImageMemoryTool({ action: "inspect", selector, mode: "compressed" }, context);
    if (compressed.ok) result = compressed;
  }
  if (!result.ok) return { ok: false, error: result.error };
  return readInlineImage(result);
}

function readInlineImage(result) {
  const url = result.contentItems?.find((item) => item.type === "inputImage")?.imageUrl || "";
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) return { ok: false, error: "图片校验未通过。" };
  return { ok: true, image: { mimeType: match[1], data: match[2] } };
}
