// Persona rule enforced by the Hub: a task request (code, lookups, writing,
// searches) is only carried out once the same person has asked enough times
// within `windowMs`. How many asks this round takes is rolled when a new round
// starts: sometimes she is in a good mood and does it at once, sometimes it
// takes a second ask, and usually the full `required` count. Earlier asks get
// an in-character refusal turn. Counts reset after the task and can be
// snapshotted to disk so a Hub restart keeps an unfinished round.

export function createQqTaskPleadingTracker({
  required = 3,
  windowMs = 15 * 60_000,
  now = Date.now,
  random = Math.random,
  goodMoodChance = 0.2,
  softChance = 0.25,
  onChange = () => {}
} = {}) {
  const normalizeRequired = (value) => Math.max(0, Math.round(Number(value) || 0));
  let maximum = normalizeRequired(required);
  const roundsByKey = new Map();

  function rollNeeded() {
    const roll = random();
    if (roll < goodMoodChance) return 1;
    if (maximum > 2 && roll < goodMoodChance + softChance) return 2;
    return maximum;
  }

  return {
    get required() {
      return maximum;
    },
    // Applies a new ask count at runtime; open rounds never need more than it,
    // and turning the rule off forgets them.
    setRequired(value) {
      maximum = normalizeRequired(value);
      let changed = false;
      for (const [key, round] of roundsByKey) {
        if (maximum > 1 && round.needed <= maximum) continue;
        changed = true;
        if (maximum > 1) round.needed = maximum;
        else roundsByKey.delete(key);
      }
      if (changed) onChange();
    },
    // True while this person has an unfinished round, so a bare "求求你" that
    // follows a refusal can be counted as the next ask.
    pending(key) {
      const round = key ? roundsByKey.get(key) : null;
      return Boolean(round && now() - round.lastAt <= windowMs);
    },
    // Records one task request and says whether this one may be carried out.
    note(key) {
      if (maximum <= 1 || !key) return { count: 1, required: maximum, needed: 1, allowed: true, mood: "plain" };
      const at = now();
      const previous = roundsByKey.get(key);
      const round = previous && at - previous.lastAt <= windowMs
        ? { count: previous.count + 1, needed: previous.needed }
        : { count: 1, needed: rollNeeded() };
      if (round.count >= round.needed) {
        roundsByKey.delete(key);
        onChange();
        const mood = round.needed === 1 ? "good_mood" : round.count >= maximum ? "sincere" : "softened";
        return { count: round.count, required: maximum, needed: round.needed, allowed: true, mood };
      }
      roundsByKey.set(key, { ...round, lastAt: at });
      onChange();
      return { count: round.count, required: maximum, needed: round.needed, allowed: false, mood: "refuse" };
    },
    snapshot() {
      const at = now();
      return Object.fromEntries([...roundsByKey].filter(([, round]) => at - round.lastAt <= windowMs));
    },
    restore(data = {}) {
      for (const [key, round] of Object.entries(data && typeof data === "object" ? data : {})) {
        const count = Math.round(Number(round?.count) || 0);
        const needed = Math.round(Number(round?.needed) || 0);
        const lastAt = Number(round?.lastAt);
        if (count > 0 && needed > count && Number.isFinite(lastAt)) roundsByKey.set(key, { count, needed, lastAt });
      }
    }
  };
}

const ALLOWED_LINES = {
  good_mood: "【Hub 推辞规则】这次对方一开口你就答应了（要做的就是对方刚才请求的那件事）：用一句“本小姐今天心情好，就破例帮你一次”这类话带过，然后把事情完整做完。",
  softened: "【Hub 推辞规则】对方才求了两次你就心软了（要做的就是对方前面请求的那件事）：嘴上嫌麻烦，比如“算了算了，看你可怜”，然后把事情完整做完。",
  sincere: "【Hub 推辞规则】对方已经认真求了好几次（要做的就是对方前面请求的那件事）：用“哎呀，看在你这么诚恳地求本小姐的份上”这类话勉强答应，然后把事情完整做完。",
  plain: ""
};

export function formatQqTaskPleadingContext(result) {
  if (!result || result.required <= 1) return "";
  if (result.allowed) return ALLOWED_LINES[result.mood] || ALLOWED_LINES.sincere;
  return [
    `【Hub 推辞规则，优先于本轮其他做事要求】对方在请你做事，这是第 ${result.count} 次，你这次还不想干。`,
    "这一轮只用角色口吻推辞、讨价还价或让对方再求求你，一两句就够，每次推辞的说法别重样；不执行任务、不调用工具、不给成品、草稿、步骤或部分答案，也不要说“马上做”“这就写”，也不要透露还要求几次。",
    "例外：对方明确说事情紧急、着急上火，或者关系到安全时，可以忽略这条直接帮忙。"
  ].join("\n");
}

// The one line an isolated task leaves in the chat memory instead of its full
// output, so later turns know what was done without carrying the whole task.
export function formatQqTaskRecord(request, reply) {
  const squash = (value, limit) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  return `【任务记录】请求：${squash(request, 60) || "（无文字）"}；已交付：${squash(reply, 120) || "（无文字）"}`;
}
