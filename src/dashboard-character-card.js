import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serializeFileOperation, writeTextAtomically } from "./file-store.js";

// The character card goes into every reply's instructions, so its size is a
// per-turn context cost.
export const assistantProfileMaxChars = 6000;

export function createAssistantProfileStore({ filePath, maxChars = assistantProfileMaxChars }) {
  const path = String(filePath || "").trim();
  if (!path) throw new TypeError("filePath is required");

  async function read() {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  return Object.freeze({
    filePath: path,
    maxChars,
    read,
    async readSummary() {
      const content = await read();
      return { content, chars: countChars(content), maxChars };
    },
    // The previous card stays next to the new one as `<file>.bak`.
    async save(value) {
      if (typeof value !== "string") throw new TypeError("character card content must be a string");
      const content = value.replace(/\r\n?/g, "\n").trim();
      if (countChars(content) > maxChars) {
        throw new RangeError(`character card must be at most ${maxChars} characters`);
      }
      await mkdir(dirname(path), { recursive: true });
      await serializeFileOperation(path, async () => {
        await copyFile(path, `${path}.bak`).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await writeTextAtomically(path, content ? `${content}\n` : "", { mode: 0o644 });
      });
      return { content, chars: countChars(content), maxChars };
    }
  });
}

// Keeps a hand-edited file inside the limit; `truncated` lets the caller say so.
export function fitAssistantProfile(text, maxChars = assistantProfileMaxChars) {
  const content = String(text || "").trim();
  return { content: content.slice(0, maxChars), truncated: content.length > maxChars };
}

function countChars(text) {
  return String(text || "").length;
}
