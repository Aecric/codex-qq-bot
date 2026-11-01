// Second opinion from Google's Gemini for chat riddles, puns and memes the
// main model cannot decode. One short, tool-free generateContent call; the key
// comes from the environment only.

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const SYSTEM_INSTRUCTION = [
  "你在帮另一个聊天机器人解释中文网络聊天里的梗、谜语、双关、谐音或暗号。",
  "直接说出最可能的含义和笑点在哪里，必要时给出处或常见用法；不确定就说不确定并给出几种可能。",
  "用中文回答，150 字以内，不要客套。"
].join("");

export async function askGemini({
  apiKey,
  model = "gemini-3.8-flash",
  question,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 20_000
} = {}) {
  const key = String(apiKey || "").trim();
  const prompt = String(question || "").trim();
  if (!key) return { ok: false, reason: "Gemini API key is not configured" };
  if (!prompt) return { ok: false, reason: "question is empty" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt.slice(0, 2000) }] }]
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, reason: String(payload?.error?.message || `Gemini returned HTTP ${response.status}`).slice(0, 300) };
    }
    const answer = (payload?.candidates?.[0]?.content?.parts || [])
      .map((part) => String(part?.text || ""))
      .join("")
      .trim();
    return answer ? { ok: true, answer: answer.slice(0, 1200) } : { ok: false, reason: "Gemini returned no text" };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "Gemini timed out" : String(error?.message || error).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
