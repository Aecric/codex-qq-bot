// Bilibili video shares in a group get a short, unprompted roast of the video
// title. Only the card text is known; the Bot never claims to have watched it.

const BILIBILI_PATTERN = /哔哩哔哩|bilibili|b23\.tv/i;
const APP_NAME_PATTERN = /^(?:哔哩哔哩|bilibili|b站)$/i;

export function findQqBilibiliShareTitle(event = {}) {
  const cards = Array.isArray(event?.contentContext?.cards) ? event.contentContext.cards : [];
  for (const card of cards) {
    const fields = [card?.title, card?.description, card?.url].map((value) => String(value || "").trim());
    if (!BILIBILI_PATTERN.test(fields.join(" "))) continue;
    const title = fields.slice(0, 2).find((value) => value && !APP_NAME_PATTERN.test(value) && !/^https?:\/\//i.test(value));
    if (title) return title.slice(0, 120);
  }
  return "";
}

export function formatQqShareCardRoastContext(title) {
  if (!title) return "";
  return [
    `【B站分享锐评】群友刚分享了一个B站视频，标题是“${title}”。`,
    "用角色口吻锐评一下这个标题，一两句就够，可以吐槽、接梗或调侃分享的人；你只看到了标题，别说自己看过视频，也不要去联网搜索。标题涉及政治或时事新闻时，按时政规则一句带过。"
  ].join("\n");
}
