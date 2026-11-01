// In-process stand-in for an OpenAI-compatible chat-completions endpoint, so
// the interest judges can run on the local Codex login ("codex" provider)
// without their HTTP request code knowing the difference. Images are reduced
// to a text placeholder; the judge's JSON instructions stay in the prompt.

export function formatInterestMessagesAsPrompt(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = String(message?.role || "user");
      const content = Array.isArray(message?.content)
        ? message.content
          .map((part) => (part?.type === "text" ? String(part.text || "") : part?.type === "image_url" ? "[图片]" : ""))
          .filter(Boolean)
          .join("\n")
        : String(message?.content || "");
      return content.trim() ? `【${role}】\n${content.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function createCodexInterestFetch({ runTurn, defaultModel = "gpt-6-luna" } = {}) {
  if (typeof runTurn !== "function") throw new TypeError("runTurn is required");
  return async function codexInterestFetch(_url, init = {}) {
    let body = {};
    try {
      body = JSON.parse(String(init.body || "{}"));
    } catch {
      return jsonResponse(400, { error: { message: "Local Codex judge received an invalid request body" } });
    }
    const prompt = formatInterestMessagesAsPrompt(body.messages);
    if (!prompt) return jsonResponse(400, { error: { message: "Local Codex judge received no messages" } });
    try {
      const content = await abortable(
        runTurn({ prompt, model: String(body.model || defaultModel) }),
        init.signal
      );
      return jsonResponse(200, {
        choices: [{ message: { role: "assistant", content: String(content || "") }, finish_reason: "stop" }]
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return jsonResponse(502, { error: { message: `Local Codex judge failed: ${String(error?.message || error).slice(0, 300)}` } });
    }
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// The judge aborts on its own idle timeout; the Codex turn may still finish in
// the background, but the judge stops waiting for it.
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function abortError() {
  const error = new Error("The local Codex judge was aborted");
  error.name = "AbortError";
  return error;
}
