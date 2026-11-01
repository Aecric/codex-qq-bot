// Deterministic last-pass eraser for chat bubbles: drops sentences that break
// character (card/persona talk, "I am playing a role") or end with service
// boilerplate, after the model has already been told not to write them.
// It never touches AI-identity answers, code, links or quoted text, and keeps
// the original text when erasing would leave the whole reply empty.

const META_SENTENCE_PATTERNS = [
  /(?:根据|按照|依照|遵循)(?:我的|这份|当前的?)?(?:角色卡|人设卡?|角色设定|系统提示词?|提示词)/u,
  /我(?:正在|会继续|继续|在)扮演/u,
  /(?:作为|我是)(?:一个)?虚构(?:的)?角色/u,
  /(?:跳出|脱离)(?:一下)?(?:角色|人设)/u
];

const SERVICE_SENTENCE_PATTERNS = [
  /希望(?:这些?|以上|我的回答)?(?:内容|回答|信息)?(?:能|可以)?(?:对你|对您)?有(?:所)?帮助/u,
  /如果(?:你|您)?还有(?:其他|别的|任何|什么)(?:问题|疑问|需要|需求)/u,
  /有什么(?:其他|别的)?(?:我)?(?:可以|能)帮(?:你|您|到你|到您)/u,
  /(?:很|非常)?高兴(?:能)?为(?:你|您)服务/u,
  /为您服务|处理您的需求/u,
  /(?:欢迎)?随时(?:来)?(?:找我|问我|告诉我|联系我)/u
];

const LEADING_PHRASE_PATTERNS = [
  /^(?:这是一个)?好问题[！!，,。.~～]*\s*/u,
  /^让我们(?:一起)?来看看[：:，,。]*\s*/u
];

const PROTECTED_INLINE = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|“[^”\n]{1,300}”|「[^」\n]{1,300}」|\[\[[^\]\n]+\]\]/gu;
const SENTENCE = /[^。！？!?…~～\n]+(?:[。！？!?…~～]+|\n|$)|[。！？!?…~～]+|\n/gu;

export function scrubQqReplyBubble(value, { allowEmpty = false } = {}) {
  const original = String(value || "");
  if (!original.trim() || original.includes("```")) return original;
  const saved = [];
  const masked = original.replace(PROTECTED_INLINE, (match) => {
    saved.push(match);
    return `\u0000${saved.length - 1}\u0000`;
  });
  const kept = (masked.match(SENTENCE) || []).filter((sentence) => {
    const plain = sentence.replace(/\u0000\d+\u0000/g, "");
    return !META_SENTENCE_PATTERNS.some((pattern) => pattern.test(plain))
      && !SERVICE_SENTENCE_PATTERNS.some((pattern) => pattern.test(plain));
  });
  let text = kept.join("");
  for (const pattern of LEADING_PHRASE_PATTERNS) text = text.replace(pattern, "");
  text = text
    .replace(/\u0000(\d+)\u0000/g, (_, index) => saved[Number(index)])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || (allowEmpty ? "" : original.trim());
}

// A bubble that was only boilerplate disappears, unless every bubble would.
export function scrubQqReplyBubbles(bubbles = []) {
  const scrubbed = bubbles.map((bubble) => scrubQqReplyBubble(bubble, { allowEmpty: true })).filter(Boolean);
  return scrubbed.length ? scrubbed : bubbles.map((bubble) => String(bubble || "").trim()).filter(Boolean);
}
