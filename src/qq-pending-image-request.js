// "帮我看看图" followed by a picture from the same sender. The request only
// counts once the text message itself was routed to the bot (a real @, a
// judged alias call or an approved interest decision). Routing can be async,
// so a candidate is opened before the decision and settled after it; a picture
// that arrives in between waits for the settlement instead of guessing.

export const QQ_PENDING_IMAGE_REQUEST_TTL_MS = 60_000;

export function createQqPendingImageRequests({ ttlMs = QQ_PENDING_IMAGE_REQUEST_TTL_MS, now = Date.now } = {}) {
  const byGroup = new Map();

  const isExpired = (entry) => now() - entry.at > ttlMs;

  function open(groupId, { senderId = "", messageId = "", text = "" } = {}) {
    const key = String(groupId || "");
    if (!key) return null;
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const entry = {
      at: now(),
      senderId: String(senderId || ""),
      messageId: String(messageId || ""),
      text: String(text || "看图"),
      status: "awaiting",
      settled
    };
    byGroup.set(key, entry);
    return {
      settle(approved) {
        if (entry.status !== "awaiting") return;
        if (approved) {
          entry.status = "active";
          // The validity window starts when the request was accepted.
          entry.at = now();
        } else {
          entry.status = "declined";
          if (byGroup.get(key) === entry) byGroup.delete(key);
        }
        settle(entry.status);
      }
    };
  }

  // Resolves to the original request text when this picture answers a request
  // from the same sender, or "" otherwise. Consumes a matched request.
  async function match(groupId, { senderId = "", hasImages = false, maxWaitMs = ttlMs } = {}) {
    const key = String(groupId || "");
    if (!key || !hasImages) return "";
    const entry = byGroup.get(key);
    if (!entry) return "";
    if (isExpired(entry)) {
      byGroup.delete(key);
      return "";
    }
    if (entry.senderId && String(senderId || "") && entry.senderId !== String(senderId)) return "";
    if (entry.status === "awaiting") {
      let timer;
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, maxWaitMs)); timer.unref?.(); });
      await Promise.race([entry.settled, timeout]);
      clearTimeout(timer);
    }
    if (byGroup.get(key) !== entry || entry.status !== "active" || isExpired(entry)) return "";
    byGroup.delete(key);
    return entry.text || "看图";
  }

  function clear(groupId) {
    if (groupId == null) byGroup.clear();
    else byGroup.delete(String(groupId));
  }

  return {
    open,
    match,
    clear,
    get size() {
      for (const [key, entry] of byGroup) if (isExpired(entry)) byGroup.delete(key);
      return byGroup.size;
    }
  };
}
