import assert from "node:assert/strict";
import test from "node:test";
import { scrubQqReplyBubble, scrubQqReplyBubbles } from "../src/qq-reply-scrub.js";
import { parseQqAgentOutput } from "../src/infrastructure/codex/qq-agent-output.js";

test("drops character-breaking and service sentences but keeps the rest", () => {
  assert.equal(
    scrubQqReplyBubble("哼，茶凉了才想起我。根据角色卡，我应该先嫌弃你一下。这次就原谅你"),
    "哼，茶凉了才想起我。这次就原谅你"
  );
  assert.equal(scrubQqReplyBubble("好问题！龙鳞每百年才换一次。希望对你有帮助！"), "龙鳞每百年才换一次。");
  assert.equal(scrubQqReplyBubble("我正在扮演 Astra 呢~ 别打岔"), "别打岔");
});

test("keeps honest AI answers, code, links and quoted text", () => {
  const honest = "技术上我确实是 AI 模型驱动的。不过现在先把茶喝完";
  assert.equal(scrubQqReplyBubble(honest), honest);
  const quoted = "你刚才说“如果还有其他问题随时找我”，这句太客服了";
  assert.equal(scrubQqReplyBubble(quoted), quoted);
  const code = "```js\n// 希望对你有帮助\n```";
  assert.equal(scrubQqReplyBubble(code), code);
  assert.equal(scrubQqReplyBubble("看这个 https://example.com/根据角色卡"), "看这个 https://example.com/根据角色卡");
});

test("a boilerplate-only bubble disappears unless it is the whole reply", () => {
  assert.deepEqual(scrubQqReplyBubbles(["东西整理好了", "有什么可以帮你的随时找我"]), ["东西整理好了"]);
  assert.deepEqual(scrubQqReplyBubbles(["希望对你有帮助"]), ["希望对你有帮助"]);
});

test("structured output applies the scrubber only when it is provided", () => {
  const raw = JSON.stringify({ status: "reply", bubbles: ["给你泡了茶", "很高兴为你服务"] });
  assert.equal(parseQqAgentOutput(raw, { scrubBubbles: scrubQqReplyBubbles }).output, "给你泡了茶");
  assert.match(parseQqAgentOutput(raw).output, /很高兴为你服务/);
});
