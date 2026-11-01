import { applyDashboardKnowledgeMutation } from "./dashboard-knowledge-base.js";
import { applyQqKnowledgeImageChange, normalizeQqKnowledgeBase, qqKnowledgeMaxEntries } from "./qq-knowledge-base.js";
import { createZipArchive, isZipArchive, readZipArchive } from "./infrastructure/zip-archive.js";

// Knowledge packages: a ZIP with notes.md and slang.md for hand-written
// knowledge, and knowledge.json plus images/ in backups, which also keep each
// entry's scope. Plain .md and .txt files import through the same parser.

export const knowledgeImportMaxBytes = 32 * 1024 * 1024;
export const knowledgeExportImageBudgetBytes = 24 * 1024 * 1024;

const BACKUP_FORMAT = "codex-qq-bot-knowledge";
const BACKUP_VERSION = 1;
const BACKUP_FILE = "knowledge.json";
const MAX_TITLE_CHARS = 80;
const MAX_CONTENT_CHARS = 800;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
// One entry keeps at most this many scope variants.
const MAX_IMPORT_GROUPS = 32;
const QQ_ID_PATTERN = /^\d{4,20}$/;
const extensionByMimeType = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const README = `# 知识库导入包 / Knowledge package

在仪表盘“知识”页点“导入”，选择这个 ZIP，预览后勾选要导入的条目，再选择应用到全局还是指定的群。

## 文件

- \`notes.md\`：知识，比如世界观、人物、地点和设定。Bot 按相关性检索，聊到时才会用上。
- \`slang.md\`：黑话。消息里出现词语或别名时，Bot 会读到它的含义。
- \`knowledge.json\`、\`images/\`：只有备份包才有，保存每条的适用范围和配图。有 \`knowledge.json\` 时只读取它，\`notes.md\` 和 \`slang.md\` 不再读取。

## 写法

每个标题是一条。标题下第一行可以写别名，之后是内容：

\`\`\`markdown
## 星港
别名：港口, 第七星港
大陆最大的贸易港，由商会共同管理。
\`\`\`

- 多级标题会连成路径，比如“地点 / 星港”。黑话只用最后一级标题作为词语。
- \`slang.md\` 也可以不写标题，每行一条：\`词语：含义\`。
- 标题最多 ${MAX_TITLE_CHARS} 字符，内容每条最多 ${MAX_CONTENT_CHARS} 字符。知识超长时会拆成“标题（2）”，黑话超长时会被截断，预览里都会提示。
- \`<!-- -->\` 里的内容会被忽略。模板里的示例都在注释里，不会被导入。

## 重复和备份

- 导入只会新增或更新，不会删除已有条目。相同标题在相同范围内会被新内容覆盖。
- 知识库总共最多 ${qqKnowledgeMaxEntries} 条，超出时整次导入都不会生效。
- 备份包可能含有从聊天中学到的内容、群号和 QQ 号，请像聊天记录一样保管。

---

On the dashboard's Knowledge page choose Import, pick this ZIP, review the entries, then apply them globally or to chosen groups.

\`notes.md\` holds knowledge such as lore, people and places, retrieved by relevance. \`slang.md\` holds slang, read when a message uses the term or an alias. Backups also have \`knowledge.json\` and \`images/\`, which keep scopes and pictures; when \`knowledge.json\` is present the Markdown files are not read.

Each heading is one entry. The first line under it may be \`别名：a, b\` or \`Aliases: a, b\`; the rest is the content. Without headings, \`slang.md\` also takes one \`term: meaning\` per line. Titles hold ${MAX_TITLE_CHARS} characters and content ${MAX_CONTENT_CHARS}; longer knowledge is split and longer slang is cut, and the preview says so. Text inside \`<!-- -->\` is ignored.

Importing adds or updates and never deletes; the same title in the same scope is overwritten. The knowledge base holds ${qqKnowledgeMaxEntries} entries, and an import that goes past that changes nothing. Backups can contain things learned from chats, plus group and QQ numbers, so keep them as private as chat logs.
`;

const NOTES_TEMPLATE = `# 知识

<!--
删掉这个注释的首尾两行，或照着下面的格式写。

# 地点

## 星港
别名：港口, 第七星港
大陆最大的贸易港，由商会共同管理。

# 人物

## 莉娅
别名：会长
星港商会的会长，和 Bot 是多年老友。
-->
`;

const SLANG_TEMPLATE = `# 黑话

<!--
删掉这个注释的首尾两行，或照着下面的格式写。

## 上大分
别名：冲分
指一口气赢很多局，也用来调侃运气好。

也可以不写标题，每行一条：

摸鱼：上班时间做别的事
水群：在群里闲聊
-->
`;

export function buildKnowledgeTemplateArchive({ at = new Date() } = {}) {
  return createZipArchive([
    { name: "README.md", data: README },
    { name: "notes.md", data: NOTES_TEMPLATE },
    { name: "slang.md", data: SLANG_TEMPLATE }
  ], { at });
}

// Pictures that would make the backup too large to import again are left out
// and counted, never silently dropped.
export async function buildKnowledgeBackupArchive(store, {
  readImage,
  at = new Date(),
  imageBudgetBytes = knowledgeExportImageBudgetBytes
} = {}) {
  const normalized = normalizeQqKnowledgeBase(store);
  const imageFiles = new Map();
  let imageBytes = 0;
  let omittedImages = 0;

  async function resolveImageFile(id) {
    if (imageFiles.has(id)) return imageFiles.get(id).name;
    const image = await readImage(id).catch(() => null);
    if (!image || imageBytes + image.data.length > imageBudgetBytes) {
      omittedImages += 1;
      return "";
    }
    const name = `images/${id}.${extensionByMimeType[image.mimeType] || "bin"}`;
    imageBytes += image.data.length;
    imageFiles.set(id, { name, data: image.data });
    return name;
  }

  const entries = [];
  for (const entry of normalized.entries) {
    const variants = [];
    for (const variant of entry.variants) {
      const images = [];
      for (const image of variant.images || []) {
        const file = await resolveImageFile(image.id);
        if (file) images.push({ file, caption: image.caption || "" });
      }
      variants.push({ scope: variant.scope, content: variant.content, images });
    }
    entries.push({ kind: entry.kind, title: entry.title, aliases: entry.aliases, variants });
  }

  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: at.toISOString(),
    entries
  };
  const archive = createZipArchive([
    { name: "README.md", data: README },
    { name: BACKUP_FILE, data: `${JSON.stringify(backup, null, 2)}\n` },
    ...imageFiles.values()
  ], { at });
  return { archive, entries: entries.length, images: imageFiles.size, omittedImages };
}

export function parseKnowledgeUpload({ fileName = "", data, defaultKind = "note" } = {}) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new TypeError("import file is empty");
  const kind = defaultKind === "slang" ? "slang" : "note";
  const parsed = isZipArchive(data)
    ? parseArchive(readZipArchive(data))
    : parseTextFile({ fileName, data, kind });
  if (parsed.items.length === 0) throw new RangeError("no knowledge entries were found in this file");
  return parsed;
}

function parseArchive(files) {
  const readable = files.filter(({ name }) => !isIgnoredArchivePath(name));
  const backup = readable.find(({ name }) => baseName(name).toLowerCase() === BACKUP_FILE);
  if (backup) return parseBackup(backup, readable);

  const items = [];
  const warnings = [];
  for (const file of readable) {
    if (!/\.(?:md|markdown|txt)$/i.test(file.name) || /^readme\b/i.test(baseName(file.name))) continue;
    const parsed = parseKnowledgeText(decodeText(file.data), {
      kind: /slang|黑话/i.test(file.name) ? "slang" : "note",
      fallbackTitle: stripExtension(baseName(file.name))
    });
    items.push(...parsed.items);
    warnings.push(...parsed.warnings);
  }
  return { format: "package", items, warnings };
}

function parseBackup(file, files) {
  let backup;
  try {
    backup = JSON.parse(decodeText(file.data));
  } catch {
    throw new TypeError("knowledge.json is not valid JSON");
  }
  if (backup?.format !== BACKUP_FORMAT || !Array.isArray(backup.entries)) {
    throw new TypeError("knowledge.json is not a knowledge backup");
  }
  if (Number(backup.version) > BACKUP_VERSION) throw new RangeError("this knowledge backup is from a newer version");

  const imagesByPath = new Map(files.filter(({ name }) => /(^|\/)images\//.test(name))
    .map((image) => [image.name.slice(image.name.indexOf("images/")), image.data]));
  const items = [];
  const warnings = [];
  for (const entry of backup.entries) {
    for (const variant of Array.isArray(entry?.variants) ? entry.variants : []) {
      const title = cleanLine(entry.title).slice(0, MAX_TITLE_CHARS);
      const content = cleanLine(variant?.content).slice(0, MAX_CONTENT_CHARS);
      if (!title || !content) {
        warnings.push({ code: "skipped", title: title || "" });
        continue;
      }
      items.push({
        kind: entry.kind === "slang" ? "slang" : "note",
        title,
        content,
        aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
        scope: variant.scope && typeof variant.scope === "object" ? variant.scope : null,
        images: (Array.isArray(variant.images) ? variant.images : []).flatMap((image) => {
          const imageData = imagesByPath.get(String(image?.file || ""));
          if (imageData) return [{ data: imageData, caption: String(image.caption || "") }];
          warnings.push({ code: "image_missing", title });
          return [];
        })
      });
    }
  }
  return { format: "backup", items, warnings };
}

function parseTextFile({ fileName, data, kind }) {
  if (data.length > MAX_TEXT_BYTES) throw new RangeError("text file is too large");
  if (data.includes(0)) throw new TypeError("import file must be a ZIP, Markdown or text file");
  const parsed = parseKnowledgeText(decodeText(data), {
    kind,
    fallbackTitle: stripExtension(baseName(fileName)) || "导入"
  });
  return { format: "text", ...parsed };
}

export function parseKnowledgeText(text, { kind = "note", fallbackTitle = "导入" } = {}) {
  const sections = splitSections(String(text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n?/g, "\n"));
  const items = [];
  const warnings = [];
  const hasHeadings = sections.some((section) => section.path.length > 0);
  if (!hasHeadings && kind === "slang") {
    const lines = sections.flatMap((section) => section.body.split("\n")).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(.{1,80}?)\s*[:：]\s*(.+)$/);
      if (match) pushItems(items, warnings, { kind, title: match[1], body: match[2], aliases: [] });
      else warnings.push({ code: "skipped", title: line.slice(0, 40) });
    }
    return { items, warnings };
  }
  const topLevelTitles = sections.filter((section) => section.level === 1).length;
  for (const section of sections) {
    const { aliases, body } = extractAliases(section.body);
    if (!body.trim()) continue;
    const title = kind === "slang"
      ? section.path.at(-1) || fallbackTitle
      : buildNoteTitle(section.path, { dropRoot: topLevelTitles === 1 }) || fallbackTitle;
    pushItems(items, warnings, { kind, title, body, aliases });
  }
  return { items, warnings };
}

function splitSections(text) {
  const sections = [];
  const path = [];
  let current = { path: [], level: 0, lines: [] };
  let inFence = false;
  const flush = () => sections.push({ path: current.path, level: current.level, body: current.lines.join("\n").trim() });
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    path.length = Math.min(path.length, level - 1);
    path[level - 1] = cleanLine(heading[2]);
    const titles = path.filter(Boolean);
    current = { path: titles, level, lines: [] };
  }
  flush();
  return sections.filter((section) => section.path.length > 0 || section.body);
}

function buildNoteTitle(path, { dropRoot }) {
  const parts = dropRoot && path.length > 1 ? path.slice(1) : path;
  return parts.join(" / ");
}

function extractAliases(body) {
  const [first = "", ...rest] = body.split("\n");
  const match = first.trim().match(/^(?:别名|aliases?)\s*[:：]\s*(.*)$/i);
  if (!match) return { aliases: [], body };
  return {
    aliases: match[1].split(/[,，、]/).map((alias) => cleanLine(alias)).filter(Boolean),
    body: rest.join("\n").trim()
  };
}

function pushItems(items, warnings, { kind, title, body, aliases }) {
  const cleanTitle = cleanLine(title);
  const clippedTitle = cleanTitle.slice(0, MAX_TITLE_CHARS);
  if (cleanTitle.length > MAX_TITLE_CHARS) warnings.push({ code: "title_cut", title: clippedTitle });
  if (kind === "slang") {
    const content = cleanLine(body);
    if (content.length > MAX_CONTENT_CHARS) warnings.push({ code: "content_cut", title: clippedTitle });
    items.push({ kind, title: clippedTitle, content: content.slice(0, MAX_CONTENT_CHARS), aliases, scope: null, images: [] });
    return;
  }
  const chunks = splitContent(body);
  if (chunks.length > 1) warnings.push({ code: "split", title: clippedTitle, parts: chunks.length });
  chunks.forEach((content, index) => {
    const suffix = index === 0 ? "" : `（${index + 1}）`;
    items.push({
      kind,
      title: `${clippedTitle.slice(0, MAX_TITLE_CHARS - suffix.length)}${suffix}`,
      content,
      aliases: index === 0 ? aliases : [],
      scope: null,
      images: []
    });
  });
}

// Breaks at paragraphs, then sentences, and only cuts mid-text when a single
// sentence is longer than an entry.
function splitContent(body) {
  const pieces = String(body || "").split(/\n\s*\n/)
    .flatMap((paragraph) => {
      const clean = cleanLine(paragraph);
      return clean.length <= MAX_CONTENT_CHARS ? [clean] : clean.match(/[^。！？!?；;.]+[。！？!?；;.]*/g) || [clean];
    })
    .flatMap((piece) => {
      const parts = [];
      for (let start = 0; start < piece.length; start += MAX_CONTENT_CHARS) parts.push(piece.slice(start, start + MAX_CONTENT_CHARS));
      return parts;
    })
    .filter((piece) => piece.trim());
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current} ${piece}` : piece;
    if (joined.length <= MAX_CONTENT_CHARS) {
      current = joined;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function summarizeKnowledgeImportItems(store, items) {
  const normalized = normalizeQqKnowledgeBase(store);
  const titleKey = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const existing = new Set(normalized.entries.flatMap((entry) => [entry.title, ...entry.aliases]
    .map((title) => `${entry.kind}:${titleKey(title)}`)));
  return items.map((item, index) => ({
    index,
    kind: item.kind,
    title: item.title,
    content: item.content,
    aliases: item.aliases,
    scope: item.scope,
    imageCount: item.images?.length || 0,
    exists: existing.has(`${item.kind}:${titleKey(item.title)}`)
  }));
}

export function normalizeKnowledgeImportScope(value) {
  const mode = String(value?.mode || "");
  if (mode === "keep" || mode === "global") return { mode };
  if (mode !== "groups") throw new TypeError("import scope must be keep, global or groups");
  const groupIds = [...new Set((Array.isArray(value.groupIds) ? value.groupIds : []).map((id) => String(id).trim()))];
  if (groupIds.length === 0) throw new RangeError("choose at least one group for this import");
  if (groupIds.length > MAX_IMPORT_GROUPS) throw new RangeError(`choose at most ${MAX_IMPORT_GROUPS} groups for this import`);
  const invalid = groupIds.find((id) => !QQ_ID_PATTERN.test(id));
  if (invalid !== undefined) throw new RangeError(`invalid group id: ${invalid}`);
  return { mode, groupIds };
}

function resolveItemScopes(item, scope) {
  if (scope.mode === "groups") return scope.groupIds.map((groupId) => ({ scopeType: "group", groupId }));
  if (scope.mode === "keep" && item.scope?.type) return [{ ...item.scope, scopeType: item.scope.type }];
  return [{ scopeType: "global" }];
}

// Stores the pictures before the knowledge changes, because that wait must not
// sit between reading and replacing the live store. An unreadable picture is
// counted and skipped rather than failing the import.
export async function prepareKnowledgeImportImages(items, importImage) {
  const stored = new Map();
  let failed = 0;
  for (const item of items) {
    for (const image of item.images || []) {
      try {
        stored.set(image, await importImage(image.data));
      } catch {
        failed += 1;
      }
    }
  }
  return { stored, failed };
}

// All-or-nothing: the caller keeps the returned store only if every item
// applied, so a bad entry or a full knowledge base changes nothing.
export function applyKnowledgeImport(store, items, scope, { storedImages = new Map(), at = Date.now() } = {}) {
  let next = normalizeQqKnowledgeBase(store);
  const counts = { created: 0, updated: 0, unchanged: 0, images: 0 };
  let lastMutation = null;
  for (const item of items) {
    for (const itemScope of resolveItemScopes(item, scope)) {
      const oldestId = next.entries[0]?.id;
      const change = applyDashboardKnowledgeMutation(next, {
        action: "upsert",
        kind: item.kind,
        title: item.title,
        content: item.content,
        aliases: item.aliases,
        ...itemScope
      }, { at });
      // The store quietly drops its oldest entry once full, so look for that.
      if (next.entries.length >= qqKnowledgeMaxEntries && !change.store.entries.some((entry) => entry.id === oldestId)) {
        throw new RangeError(`the knowledge base holds at most ${qqKnowledgeMaxEntries} entries; this import goes past that and was not applied`);
      }
      next = change.store;
      if (change.action === "added") counts.created += 1;
      else if (change.action === "updated") counts.updated += 1;
      else counts.unchanged += 1;
      lastMutation = { entryId: change.entry.id, variantId: change.variant.id };
      for (const image of item.images || []) {
        if (!storedImages.has(image)) continue;
        const attached = applyQqKnowledgeImageChange(next, {
          entryId: change.entry.id,
          variantId: change.variant.id,
          action: "attach",
          image: storedImages.get(image),
          caption: image.caption,
          source: "dashboard",
          at
        });
        next = attached.store;
        if (attached.changed) counts.images += 1;
      }
    }
  }
  return { store: next, counts, mutation: lastMutation };
}

function decodeText(data) {
  const body = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("gb18030").decode(body);
  }
}

function isIgnoredArchivePath(name) {
  return /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.[^/]*$/.test(name);
}

function baseName(name) {
  return String(name || "").replaceAll("\\", "/").split("/").pop() || "";
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

function cleanLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
