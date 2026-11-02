import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { isPathInside } from "./qq-output-policy.js";
import { sanitizeQqUploadFileName } from "./qq-reply-files.js";

// Most filesystems cap a file name at 255 bytes; the stored name also carries a
// timestamp prefix, so long Chinese names must be cut by bytes, not characters.
const maxStoredNameBytes = 200;

// A target is a group ({ groupId }) or a private chat ({ userId }); a group wins
// when both are present. The id becomes a directory name, so only digits pass.
function resolveTarget(target) {
  const groupId = String(target?.groupId ?? "").trim();
  const userId = String(target?.userId ?? "").trim();
  const id = groupId || userId;
  if (!/^\d+$/.test(id)) throw new TypeError("A numeric QQ group id or QQ id is required");
  return { id, isGroup: Boolean(groupId) };
}

function truncateUtf8(text, maxBytes) {
  let output = "";
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    output += char;
  }
  return output;
}

function buildStoredName(name, stamp, unique) {
  const rawName = basename(String(name || ""));
  // Split before sanitizing, which would cut the extension off a long name.
  const extension = truncateUtf8(sanitizeQqUploadFileName(extname(rawName)), 20);
  const stem = sanitizeQqUploadFileName(rawName.slice(0, rawName.length - extname(rawName).length)) || "file";
  const prefix = `${stamp}-${unique}-`;
  const room = maxStoredNameBytes - Buffer.byteLength(prefix) - Buffer.byteLength(extension);
  return `${prefix}${truncateUtf8(stem, room)}${extension}`;
}

function formatStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

// Generated files are kept per conversation at <rootDir>/<QQ_ID>/, outliving the
// task workspace that is deleted once a reply has been sent. Callers validate
// the source path; this store only refuses anything that is not a regular file.
export function createQqCreatedFilesStore({ rootDir, now = () => new Date(), uniqueId = () => randomUUID().slice(0, 8) } = {}) {
  if (!rootDir) throw new TypeError("rootDir is required");
  return {
    directoryFor(target) {
      return join(rootDir, resolveTarget(target).id);
    },
    async stage(target, sourcePath, name = "") {
      const directory = join(rootDir, resolveTarget(target).id);
      const info = await lstat(sourcePath);
      if (!info.isFile()) throw new TypeError("Only a regular file can be stored");
      await mkdir(directory, { recursive: true });
      const storedPath = join(directory, buildStoredName(name || sourcePath, formatStamp(now()), uniqueId()));
      await copyFile(sourcePath, storedPath);
      return storedPath;
    }
  };
}

// callOneBot(endpoint, payload, { signal }) returns the OneBot send result.
// A file that cannot be stored is a failed delivery result, not an exception, so
// text already sent in the same reply is reported accurately. Its message stays
// free of local paths because delivery receipts can reach the model.
export function createQqFileUploader({
  store,
  callOneBot,
  buildImageSegment = (path) => ({ type: "image", data: { file: `file://${path}` } }),
  onError
} = {}) {
  if (!store || !callOneBot) throw new TypeError("store and callOneBot are required");
  const stageOrFail = async (target, path, name) => {
    try {
      const { id, isGroup } = resolveTarget(target);
      return { id, isGroup, storedPath: await store.stage(target, path, name) };
    } catch (error) {
      onError?.(error);
      return { failure: { ok: false, errorCode: "QQ_CREATED_FILE_STORE_FAILED", error: "文件暂存失败，未发送。" } };
    }
  };
  return {
    async uploadFile(target, { path, name = "" }, { signal } = {}) {
      const displayName = sanitizeQqUploadFileName(name) || basename(path);
      const { failure, id, isGroup, storedPath } = await stageOrFail(target, path, displayName);
      if (failure) return failure;
      return callOneBot(isGroup ? "upload_group_file" : "upload_private_file", {
        [isGroup ? "group_id" : "user_id"]: Number(id),
        file: storedPath,
        name: displayName
      }, { signal });
    },
    async sendImage(target, path, { signal } = {}) {
      const { failure, id, isGroup, storedPath } = await stageOrFail(target, path);
      if (failure) return failure;
      return callOneBot(isGroup ? "send_group_msg" : "send_private_msg", {
        [isGroup ? "group_id" : "user_id"]: Number(id),
        message: [buildImageSegment(storedPath)]
      }, { signal });
    }
  };
}

// Reply images are sent inside a mixed text message, so the Hub only needs them
// swapped for stored copies. Only images generated for this reply are stored:
// stickers and remote URLs stay as they are, and an unwritable store must not
// cost the user an image that can still be sent from its original path.
export async function stageQqReplyImages(store, target, mediaRefs, { generatedDirs = [], onError } = {}) {
  const roots = (await Promise.all(generatedDirs.filter(Boolean).map((dir) => realpath(dir).catch(() => "")))).filter(Boolean);
  const stored = [];
  for (const ref of mediaRefs) {
    if (!roots.some((root) => isPathInside(ref, root))) {
      stored.push(ref);
      continue;
    }
    try {
      stored.push(await store.stage(target, ref));
    } catch (error) {
      onError?.(error);
      stored.push(ref);
    }
  }
  return stored;
}
