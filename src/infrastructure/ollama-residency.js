// Loads an Ollama model and keeps it resident, or unloads it at once, through
// the daemon's native generate endpoint (an empty prompt only changes
// residency). `baseUrl` is the OpenAI-compatible URL the judge uses.
export async function setOllamaModelResidency({ baseUrl, model, resident, fetch = globalThis.fetch, timeoutMs = 120_000 }) {
  const origin = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetch(`${origin}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: resident ? -1 : 0 }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  await response.text();
}
