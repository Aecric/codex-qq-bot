import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  attachErrorFields,
  createAgentTurnErrors,
  createTurnDeadlines,
  normalizeDynamicToolResult,
  normalizeImagePaths,
  notifyObserver
} from "../agent/agent-turn-process.js";
import { flattenQqDynamicTools } from "../agent/qq-mcp-tools.js";

// Adapter for engines reached over an OpenAI-compatible Chat Completions API
// rather than a local CLI, with the same contract as runCodexAppServerTurn.
// The Hub itself runs the tool loop, so one "turn" is a series of streamed
// requests. These engines keep no server-side session: results carry a null
// threadId and every turn starts from the full prompt.

const MAX_TOOL_ROUNDS = 40;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_TEXT_CHARS = 100_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_MAX_IMAGE_BYTES = 3_750_000;
const RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const errorDetailChars = 500;

const ADAPTER_INSTRUCTIONS = [
  "运行环境说明：你通过 Chat Completions API 为 QQ Bot 执行本轮任务。",
  "Hub 提供的工具已全部列出，工具名里的双下划线分隔命名空间和工具；没有 shell，文件只能用 builtin__ 文件工具访问，且限于本轮工作目录。",
  "在工具调用之前写出的可见文字会作为任务进度发给 QQ 用户；不要写过渡性旁白，只在长任务取得阶段性结果时写一句自然中文进度。"
].join("\n");

export const CHAT_API_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    label: "DeepSeek",
    keyName: "DEEPSEEK_API_KEY",
    vision: false,
    // DeepSeek only accepts its high/max levels; the lowest settings turn
    // thinking off, which is the only faster option it has.
    reasoningFields(effort) {
      const value = String(effort || "").trim().toLowerCase();
      if (!value) return {};
      if (value === "none" || value === "minimal") return { thinking: { type: "disabled" } };
      return { thinking: { type: "enabled" }, reasoning_effort: ["xhigh", "max", "ultra"].includes(value) ? "max" : "high" };
    }
  }),
  gemini: Object.freeze({
    label: "Gemini",
    keyName: "GEMINI_API_KEY",
    vision: true,
    // Accepted levels differ by Gemini model. low and high are universal, and
    // a rejected level is dropped by the retry in requestWithRetry.
    reasoningFields(effort) {
      const value = String(effort || "").trim().toLowerCase();
      if (!value) return {};
      if (value === "medium") return { reasoning_effort: "medium" };
      return { reasoning_effort: ["high", "xhigh", "max", "ultra"].includes(value) ? "high" : "low" };
    }
  })
});

// The endpoint's host alone is safe to show; a base URL may embed credentials.
export function describeChatApiHost(baseUrl) {
  try {
    return new URL(String(baseUrl || "")).host || null;
  } catch {
    return null;
  }
}

export function runChatApiTurn({
  provider,
  connection = {},
  model = null,
  reasoningEffort = null,
  cwd,
  prompt,
  imagePaths = [],
  developerInstructions = null,
  baseInstructions = null,
  dynamicTools = [],
  outputSchema = null,
  webSearchMode = null,
  webSearch = null,
  sandbox = "read-only",
  sandboxPolicy = null,
  runtimeWorkspaceRoots = [],
  timeoutMs,
  replacementIdleTimeoutMs,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  signal,
  fetch: fetchImpl = globalThis.fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
  onSpawn,
  onReady,
  onRestarted,
  onDynamicToolCall,
  onItem,
  onProgress,
  onExit
} = {}) {
  const definition = CHAT_API_PROVIDERS[provider];
  if (!definition) return Promise.reject(new TypeError(`Unknown chat API provider: ${provider}`));
  const errors = createAgentTurnErrors(definition.label);
  return new Promise((promiseResolve, promiseReject) => {
    if (signal?.aborted) {
      promiseReject(errors.abort(signal.reason));
      return;
    }
    const apiKey = String(connection.apiKey || "").trim();
    if (!apiKey) {
      const error = new Error(`${definition.label} 引擎缺少 API Key：请在 config/local.env 里设置 ${definition.keyName}`);
      error.code = "CHAT_API_KEY_MISSING";
      promiseReject(error);
      return;
    }

    const threadId = `chat-api:${randomUUID()}`;
    const imageOptions = { vision: definition.vision, maxImageBytes };
    const fileRoots = [...new Set([
      cwd,
      ...(Array.isArray(sandboxPolicy?.writableRoots) ? sandboxPolicy.writableRoots : []),
      ...(Array.isArray(runtimeWorkspaceRoots) ? runtimeWorkspaceRoots : [])
    ].map((path) => String(path || "").trim()).filter((path) => path.startsWith("/")))];
    const qqTools = flattenQqDynamicTools(dynamicTools);
    const builtinTools = buildBuiltinTools({
      fileRoots: sandbox === "read-only" ? [] : fileRoots,
      cwd,
      webSearch: webSearchMode && webSearchMode !== "disabled" ? webSearch : null,
      vision: definition.vision,
      maxImageBytes
    });
    const toolsByName = new Map([...qqTools, ...builtinTools].map((tool) => [tool.name, tool]));
    const requestTools = [...toolsByName.values()].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }));

    const messages = [];
    const systemPrompt = [
      baseInstructions ? String(baseInstructions) : null,
      developerInstructions ? String(developerInstructions) : null,
      ADAPTER_INSTRUCTIONS,
      outputSchema ? formatOutputSchemaInstructions(outputSchema) : null
    ].filter(Boolean).join("\n\n");
    messages.push({ role: "system", content: systemPrompt });
    messages.push({
      role: "user",
      content: buildChatUserContent([{ type: "text", text: String(prompt || "") }, ...normalizeImagePaths(imagePaths)], imageOptions)
    });

    const pendingInputs = [];
    const completedItems = [];
    let settled = false;
    let turnActive = true;
    let turnSequence = 1;
    let turnId = `chat-api-turn-${turnSequence}`;
    let restartCount = 0;
    let requestController = null;
    let sendReasoning = true;
    let repairAttempted = false;

    const deadlines = createTurnDeadlines({
      errors,
      timeoutMs,
      replacementIdleTimeoutMs,
      isSettled: () => settled,
      isTurnActive: () => turnActive,
      onExpire: (error) => finish(error)
    });

    // Stands in for the CLI child the Hub tracks: /stop and shutdown call kill.
    const child = {
      pid: null,
      kill() {
        finish(errors.abort("Chat API turn stopped"));
        return true;
      }
    };

    function finish(error, result = null) {
      if (settled) return;
      settled = true;
      turnActive = false;
      deadlines.clear();
      signal?.removeEventListener("abort", abortTurn);
      requestController?.abort();
      notifyObserver(onExit, child);
      if (error) {
        attachErrorFields(error, { deadlineRenewalCount: deadlines.renewalCount, stderr: "" });
        promiseReject(error);
      } else {
        promiseResolve({ ...result, stderr: "", deadlineRenewalCount: deadlines.renewalCount });
      }
    }

    function abortTurn() {
      finish(errors.abort(signal?.reason));
    }

    const steer = async (input) => {
      if (!turnActive) throw errors.inactive();
      pendingInputs.push(buildChatUserContent(input, imageOptions));
      deadlines.arm({ renewal: true });
      return { threadId, turnId, deadlineRenewalCount: deadlines.renewalCount };
    };

    const restart = async (input) => {
      if (!turnActive) throw errors.inactive();
      const interruptedTurnId = turnId;
      deadlines.arm({ renewal: true });
      // The replacement input already carries every fused follow-up.
      pendingInputs.length = 0;
      pendingInputs.push(buildChatUserContent(input, imageOptions));
      restartCount += 1;
      turnSequence += 1;
      turnId = `chat-api-turn-${turnSequence}`;
      repairAttempted = false;
      requestController?.abort();
      const deadlineRenewalCount = deadlines.renewalCount;
      deadlines.armReplacementIdle();
      notifyObserver(onRestarted, { threadId, turnId, interruptedTurnId, deadlineRenewalCount, input });
      return { threadId, turnId, interruptedTurnId, deadlineRenewalCount };
    };

    const interrupt = async () => {
      if (!turnActive) return false;
      const error = new Error(`${definition.label} turn interrupted`);
      error.code = "CODEX_TURN_INTERRUPTED";
      finish(error);
      return true;
    };

    const requestOnce = async (body, abortSignal) => {
      const response = await fetchImpl(`${String(connection.baseUrl || "").replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: abortSignal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new Error(`${definition.label} API returned HTTP ${response.status}: ${summarizeApiError(detail)}`);
        error.code = "CODEX_TURN_FAILED";
        error.httpStatus = response.status;
        throw error;
      }
      return readChatCompletionStream(response, { errors, onActivity: () => deadlines.noteActivity() });
    };

    const requestWithRetry = async (toolsDisabled) => {
      const startedRestartCount = restartCount;
      for (let attempt = 0; ; attempt += 1) {
        requestController = new AbortController();
        const body = {
          model,
          messages,
          stream: true,
          ...(sendReasoning ? definition.reasoningFields(reasoningEffort) : {}),
          ...(requestTools.length ? { tools: requestTools, ...(toolsDisabled ? { tool_choice: "none" } : {}) } : {}),
          // JSON mode may not be combined with tools on every model; with
          // tools the schema instructions and repair round enforce the shape.
          ...(outputSchema && !requestTools.length ? { response_format: { type: "json_object" } } : {})
        };
        try {
          return await requestOnce(body, requestController.signal);
        } catch (error) {
          if (settled || restartCount !== startedRestartCount) throw error;
          if (error.httpStatus === 400 && sendReasoning && /reasoning|thinking/i.test(error.message)) {
            sendReasoning = false;
            continue;
          }
          const retryable = error.httpStatus ? RETRYABLE_STATUS.has(error.httpStatus) : error.code !== "CODEX_APP_SERVER_OUTPUT_LIMIT";
          if (!retryable || attempt >= retryDelaysMs.length) throw error;
          await new Promise((wake) => setTimeout(wake, retryDelaysMs[attempt]));
          if (settled || restartCount !== startedRestartCount) throw error;
        }
      }
    };

    const runToolCall = async (call, startedRestartCount) => {
      if (restartCount !== startedRestartCount) return { text: "已取消：用户发来了新的消息。", images: [] };
      const tool = toolsByName.get(call.function.name);
      let args;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        return { text: `工具参数不是合法 JSON：${call.function.name}`, images: [] };
      }
      const item = { type: "chatApiToolCall", tool: call.function.name, arguments: args };
      completedItems.push(item);
      notifyObserver(onItem, { method: "item/completed", threadId, turnId, item });
      if (!tool) return { text: `未知工具：${call.function.name}`, images: [] };
      try {
        const result = tool.run
          ? await tool.run(args)
          : await requireToolHandler(onDynamicToolCall, tool)({
            namespace: tool.namespace,
            tool: tool.tool,
            arguments: args && typeof args === "object" ? args : {},
            callId: `chat-api-call-${call.id}`,
            threadId,
            turnId
          });
        return formatToolResult(result, imageOptions);
      } catch (error) {
        return { text: `工具调用失败：${String(error?.message || error)}`, images: [] };
      }
    };

    const runLoop = async () => {
      for (let round = 0; !settled; round += 1) {
        if (round > MAX_TOOL_ROUNDS + 2) {
          const error = new Error(`${definition.label} turn exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
          error.code = "CODEX_TURN_FAILED";
          throw error;
        }
        for (const content of pendingInputs.splice(0)) messages.push({ role: "user", content });
        const startedRestartCount = restartCount;
        let reply;
        try {
          reply = await requestWithRetry(round >= MAX_TOOL_ROUNDS);
        } catch (error) {
          if (settled) return;
          if (restartCount !== startedRestartCount) continue;
          throw error;
        }
        if (settled) return;
        // A reply overtaken by a restart answers input that was replaced.
        if (restartCount !== startedRestartCount) continue;
        messages.push(toAssistantHistoryMessage(reply));

        if (reply.toolCalls.length) {
          const commentary = reply.content.trim();
          if (commentary) {
            const item = { type: "agentMessage", phase: "commentary", text: commentary };
            completedItems.push(item);
            notifyObserver(onProgress, { type: "commentary", text: commentary, item });
          }
          const images = [];
          for (const call of reply.toolCalls) {
            const outcome = await runToolCall(call, startedRestartCount);
            if (settled) return;
            messages.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
            images.push(...outcome.images);
          }
          // Tool messages are text-only on this API, so images follow as user input.
          if (images.length) messages.push({ role: "user", content: [{ type: "text", text: "以上工具返回的图片：" }, ...images] });
          deadlines.noteActivity();
          continue;
        }

        if (pendingInputs.length) continue;
        if (reply.finishReason === "length" || reply.finishReason === "content_filter") {
          const error = new Error(`${definition.label} turn ended with ${reply.finishReason}`);
          error.code = "CODEX_TURN_FAILED";
          error.turnStatus = reply.finishReason;
          throw error;
        }
        let finalResponse = reply.content.trim();
        if (outputSchema) {
          const structured = parseStructuredOutput(finalResponse, outputSchema);
          if (structured) {
            finalResponse = JSON.stringify(structured);
          } else if (!repairAttempted) {
            repairAttempted = true;
            messages.push({ role: "user", content: "上一条回复不是符合要求的 JSON 对象。请只输出符合 schema 的 JSON 对象，不要输出其他内容。" });
            continue;
          }
        }
        if (!finalResponse) {
          const error = new Error(`${definition.label} returned an empty response`);
          error.code = "CODEX_TURN_FAILED";
          throw error;
        }
        completedItems.push({ type: "agentMessage", phase: "final_answer", text: finalResponse });
        finish(null, {
          finalResponse,
          threadId: null,
          turnId,
          status: "completed",
          resumed: false,
          items: completedItems,
          usage: reply.usage
        });
        return;
      }
    };

    deadlines.arm();
    signal?.addEventListener("abort", abortTurn, { once: true });
    notifyObserver(onSpawn, child);
    notifyObserver(onReady, { child, threadId, turnId, steer, restart, interrupt, resumed: false });
    runLoop().catch((error) => finish(error));
  });
}

function requireToolHandler(handler, tool) {
  if (typeof handler !== "function") throw new Error(`No handler registered for dynamic tool ${tool.name}`);
  return handler;
}

// Replays the assistant message with every provider-specific field intact:
// DeepSeek rejects tool rounds without reasoning_content, and Gemini rejects
// tool calls without their extra_content thought signature.
export function toAssistantHistoryMessage(reply) {
  const message = { role: "assistant", content: reply.content || null };
  if (reply.reasoningContent) message.reasoning_content = reply.reasoningContent;
  if (reply.extraContent) message.extra_content = reply.extraContent;
  if (reply.toolCalls.length) {
    message.tool_calls = reply.toolCalls.map(({ id, type, function: fn, extra_content: extraContent }) => ({
      id,
      type,
      function: fn,
      ...(extraContent ? { extra_content: extraContent } : {})
    }));
  }
  return message;
}

export async function readChatCompletionStream(response, { errors, onActivity = () => undefined, maxBytes = MAX_STREAM_BYTES } = {}) {
  const reply = { content: "", reasoningContent: "", extraContent: null, toolCalls: [], finishReason: null, usage: null };
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch (error) {
      throw errors.invalidJson(error);
    }
    if (chunk.error) {
      const error = new Error(`Chat API stream error: ${summarizeApiError(JSON.stringify(chunk.error))}`);
      error.code = "CODEX_TURN_FAILED";
      throw error;
    }
    applyChatCompletionChunk(reply, chunk);
  };
  for await (const part of response.body) {
    onActivity();
    bytes += part.byteLength;
    if (bytes > maxBytes) throw errors.outputLimit();
    buffer += decoder.decode(part, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      handleLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  handleLine(buffer + decoder.decode());
  for (const call of reply.toolCalls) delete call.index;
  return reply;
}

// Merges one streamed delta. Gemini may omit tool_calls[].index and send each
// call whole, so a call is matched by id first and by index or position after.
export function applyChatCompletionChunk(reply, chunk) {
  if (chunk.usage) reply.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) reply.finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  if (typeof delta.content === "string") reply.content += delta.content;
  if (typeof delta.reasoning_content === "string") reply.reasoningContent += delta.reasoning_content;
  if (delta.extra_content) reply.extraContent = delta.extra_content;
  for (const entry of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const hasIndex = Number.isInteger(entry.index);
    let call = entry.id
      ? reply.toolCalls.find((candidate) => candidate.id === entry.id)
      : hasIndex
        ? reply.toolCalls.find((candidate) => candidate.index === entry.index)
        : entry.function?.name ? null : reply.toolCalls.at(-1);
    if (!call) {
      call = {
        id: entry.id || `call_${randomUUID()}`,
        index: hasIndex ? entry.index : null,
        type: "function",
        function: { name: "", arguments: "" }
      };
      reply.toolCalls.push(call);
    }
    if (entry.function?.name) call.function.name += entry.function.name;
    if (typeof entry.function?.arguments === "string") call.function.arguments += entry.function.arguments;
    if (entry.extra_content) call.extra_content = entry.extra_content;
  }
}

export function formatOutputSchemaInstructions(schema) {
  return [
    "最终答案必须是一个 JSON 对象，符合下面的 JSON Schema；只输出这个 JSON 对象，不要加代码块或其他文字。工具调用不受此限制。",
    JSON.stringify(schema)
  ].join("\n");
}

// Returns the object when the text is one JSON object holding the schema's
// required top-level fields; deeper validation stays with the Hub's parsers.
export function parseStructuredOutput(text, schema = null) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.every((key) => Object.hasOwn(parsed, key)) ? parsed : null;
}

export function buildChatUserContent(input, { vision = false, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES, readFile: read = readFileSync } = {}) {
  const entries = Array.isArray(input) ? input : [{ type: "text", text: String(input || "") }];
  const parts = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "localImage" && entry.path) {
      parts.push(localImagePart(String(entry.path), { vision, maxImageBytes, read }));
      continue;
    }
    const text = String(entry.text || "");
    if (text) parts.push({ type: "text", text });
  }
  if (!parts.length) return "";
  return parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts;
}

function localImagePart(path, { vision, maxImageBytes, read }) {
  if (!vision) return { type: "text", text: `[当前模型看不了图片，未附带：${path}]` };
  let data;
  try {
    data = read(path);
  } catch {
    return { type: "text", text: `[图片无法读取：${path}]` };
  }
  const mediaType = sniffImageMediaType(data);
  if (!mediaType) return { type: "text", text: `[不支持的图片格式：${path}]` };
  if (data.length > maxImageBytes) return { type: "text", text: `[图片过大未附带：${path}]` };
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${data.toString("base64")}` } };
}

function sniffImageMediaType(data) {
  if (!data || data.length < 12) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function formatToolResult(result, { vision = false } = {}) {
  const { contentItems, success } = normalizeDynamicToolResult(result);
  const texts = [];
  const images = [];
  for (const item of contentItems) {
    if (item?.type === "inputImage" && String(item.imageUrl || "").startsWith("data:")) {
      if (vision) images.push({ type: "image_url", image_url: { url: item.imageUrl } });
      else texts.push("[工具返回了图片，但当前模型看不了图片]");
      continue;
    }
    texts.push(String(item?.text ?? JSON.stringify(item)));
  }
  const text = texts.join("\n").slice(0, MAX_TOOL_TEXT_CHARS);
  return { text: success ? text : `[工具报告失败] ${text}`, images };
}

function summarizeApiError(detail) {
  const text = String(detail || "").trim();
  try {
    const parsed = JSON.parse(text);
    const value = Array.isArray(parsed) ? parsed[0] : parsed;
    return String(value?.error?.message || value?.message || text).slice(0, errorDetailChars);
  } catch {
    return text.slice(0, errorDetailChars);
  }
}

// The CLI engines bring file and search tools; here the Hub supplies a minimal
// set. File access is confined to the turn's sandbox roots after resolving
// symlinks, and there is deliberately no shell.
function buildBuiltinTools({ fileRoots, cwd, webSearch, vision, maxImageBytes }) {
  const tools = [];
  const add = (name, description, properties, run) => tools.push({
    name: `builtin__${name}`,
    namespace: "builtin",
    tool: name,
    description,
    inputSchema: { type: "object", properties, required: Object.keys(properties) },
    run
  });
  const pathProperty = { path: { type: "string", description: "Absolute path, or a path relative to the working directory." } };
  if (fileRoots.length) {
    add("list_files", "List one directory inside the turn's working directories.", pathProperty, async ({ path }) => {
      const target = await resolveInsideRoots(path, { cwd, roots: fileRoots });
      const entries = await readdir(target, { withFileTypes: true });
      return entries.slice(0, MAX_LIST_ENTRIES).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n") || "(empty)";
    });
    add("read_file", "Read a UTF-8 text file (up to 256 KB) or an image inside the turn's working directories.", pathProperty, async ({ path }) => {
      const target = await resolveInsideRoots(path, { cwd, roots: fileRoots });
      const info = await stat(target);
      const head = info.size <= Math.max(MAX_READ_BYTES, maxImageBytes) ? await readFile(target) : null;
      const mediaType = head ? sniffImageMediaType(head) : null;
      if (mediaType) {
        if (!vision) return "这是一张图片，当前模型看不了图片。";
        if (head.length > maxImageBytes) return "图片过大，未读取。";
        return { contentItems: [{ type: "inputImage", imageUrl: `data:${mediaType};base64,${head.toString("base64")}` }] };
      }
      if (info.size > MAX_READ_BYTES || !head) return `文件过大（${info.size} 字节），未读取。`;
      if (head.includes(0)) return "这是二进制文件，未读取。";
      return head.toString("utf8");
    });
    add("write_file", "Create or replace a UTF-8 text file (up to 8 MB) inside the turn's working directories.", {
      ...pathProperty,
      content: { type: "string", description: "Full new file content." }
    }, async ({ path, content }) => {
      const text = String(content ?? "");
      if (Buffer.byteLength(text) > MAX_WRITE_BYTES) throw new Error("内容超过 8 MB 上限");
      const target = await resolveInsideRoots(path, { cwd, roots: fileRoots, forWrite: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      return `已写入：${target}`;
    });
  }
  if (webSearch) {
    add("web_search", "Search the web and return titles, snippets and links.", {
      query: { type: "string", description: "Search keywords." }
    }, async ({ query }) => {
      const results = await webSearch(String(query || ""));
      if (!results?.length) return "没有找到稳定结果。";
      return results.slice(0, 6).map((entry, index) => [
        `${index + 1}. ${entry.title}`,
        entry.snippet ? `摘要：${entry.snippet}` : null,
        entry.url ? `链接：${entry.url}` : null
      ].filter(Boolean).join("\n")).join("\n");
    });
  }
  return tools;
}

// Resolves symlinks in the path's longest existing prefix so a link inside a
// root cannot reach a file outside it.
export async function resolveInsideRoots(path, { cwd, roots, forWrite = false }) {
  const requested = String(path || "").trim();
  if (!requested) throw new Error("路径为空");
  const target = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const realRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter(Boolean);
  let existing = target;
  let remainder = "";
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || !forWrite) throw new Error(`路径不存在或无法访问：${requested}`);
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`路径无法访问：${requested}`);
      remainder = remainder ? join(existing.slice(parent.length + 1), remainder) : existing.slice(parent.length + 1);
      existing = parent;
    }
  }
  const real = remainder ? join(existing, remainder) : existing;
  const inside = realRoots.some((root) => {
    const offset = relative(root, real);
    return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
  });
  if (!inside) throw new Error(`路径不在本轮允许的目录内：${requested}`);
  return real;
}
