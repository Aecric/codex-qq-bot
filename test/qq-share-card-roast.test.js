import assert from "node:assert/strict";
import test from "node:test";
import { findQqBilibiliShareTitle, formatQqShareCardRoastContext } from "../src/qq-share-card-roast.js";

test("finds the video title of a Bilibili share card", () => {
  const event = {
    contentContext: {
      cards: [{ title: "哔哩哔哩", description: "【逆天中配】鼬是宇智波唯一专升本成功的男人", url: "https://b23.tv/2u4EdBR" }]
    }
  };
  assert.equal(findQqBilibiliShareTitle(event), "【逆天中配】鼬是宇智波唯一专升本成功的男人");
});

test("ignores other cards and plain messages", () => {
  assert.equal(findQqBilibiliShareTitle({ contentContext: { cards: [{ title: "知乎", description: "如何评价", url: "https://zhihu.com/q/1" }] } }), "");
  assert.equal(findQqBilibiliShareTitle({ text: "b23.tv 看这个" }), "");
});

test("the roast context names the title and forbids claiming to have watched", () => {
  assert.equal(formatQqShareCardRoastContext(""), "");
  assert.match(formatQqShareCardRoastContext("鼬"), /“鼬”[\s\S]*别说自己看过视频/);
});
