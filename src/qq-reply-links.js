// Web lookups cite their source by site name instead of pasting URLs into QQ.
// The prompt asks the model for this; the last-pass rewrite below catches what
// it still writes, unless the sender asked for a link or the URL is their own.

const LINK_REQUEST_PATTERN = /链接|网址|下载地址|官网|传送门|原文|\burl\b|\blink\b/iu;
const URL_SOURCE = String.raw`https?:\/\/[^\s<>"'“”‘’（）()\[\]【】《》，。；！？、㐀-鿿]+`;
const PROTECTED_INLINE = /```[\s\S]*?```|`[^`\n]+`|\[\[[^\]\n]+\]\]/gu;
const MARKDOWN_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\((${URL_SOURCE})\)`, "giu");
const LABELLED_URL = new RegExp(String.raw`(?:链接|网址|来源|出处|source|link|url)\s*[:：]\s*(${URL_SOURCE})`, "giu");
const BARE_URL = new RegExp(URL_SOURCE, "giu");

export function formatQqLinkSource(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function formatQqSearchResultSource(result = {}) {
  const source = formatQqLinkSource(result.url);
  return source ? `来源：${source}` : null;
}

export function rewriteQqReplyLinksAsSources(value, { requestText = "", allowedUrls = [] } = {}) {
  const original = String(value ?? "");
  if (!/https?:\/\//i.test(original) || LINK_REQUEST_PATTERN.test(String(requestText || ""))) return original;
  const allowed = new Set(allowedUrls);
  const saved = [];
  const masked = original.replace(PROTECTED_INLINE, (match) => {
    saved.push(match);
    return `\u0000${saved.length - 1}\u0000`;
  });
  // Trailing punctuation belongs to the sentence, not the URL.
  const splitUrl = (match) => {
    const url = match.replace(/[.,;:!?]+$/u, "");
    return { url, tail: match.slice(url.length) };
  };
  const text = masked
    .replace(MARKDOWN_LINK, (match, label, rawUrl) => {
      const { url } = splitUrl(rawUrl);
      const source = formatQqLinkSource(url);
      if (allowed.has(url) || !source) return match;
      return label.trim() ? `${label.trim()}（来源：${source}）` : `来源：${source}`;
    })
    .replace(LABELLED_URL, (match, rawUrl) => {
      const { url, tail } = splitUrl(rawUrl);
      const source = formatQqLinkSource(url);
      return allowed.has(url) || !source ? match : `来源：${source}${tail}`;
    })
    .replace(BARE_URL, (match) => {
      const { url, tail } = splitUrl(match);
      const source = formatQqLinkSource(url);
      return allowed.has(url) || !source ? match : `${source}${tail}`;
    });
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => saved[Number(index)]);
}
