import assert from "node:assert/strict";
import test from "node:test";
import { formatQqSearchResultSource, rewriteQqReplyLinksAsSources } from "../src/qq-reply-links.js";

test("search results expose the source site rather than the URL", () => {
  assert.equal(formatQqSearchResultSource({ url: "https://www.Example.com/a/b?x=1" }), "来源：example.com");
  assert.equal(formatQqSearchResultSource({ url: "not a url" }), null);
  assert.equal(formatQqSearchResultSource({}), null);
});

test("rewrites bare, labelled and Markdown links as sources", () => {
  assert.equal(rewriteQqReplyLinksAsSources("发布了。链接：https://www.example.com/news/1?a=b"), "发布了。来源：example.com");
  assert.equal(rewriteQqReplyLinksAsSources("来源: https://example.com/x."), "来源：example.com.");
  assert.equal(rewriteQqReplyLinksAsSources("见[官方公告](https://news.example.com/p/1)。"), "见官方公告（来源：news.example.com）。");
  assert.equal(rewriteQqReplyLinksAsSources("[](https://example.com/p)"), "来源：example.com");
  assert.equal(rewriteQqReplyLinksAsSources("看 https://example.com/p，挺好"), "看 example.com，挺好");
});

test("keeps links the sender asked for or sent themselves", () => {
  const reply = "在这 https://example.com/p";
  assert.equal(rewriteQqReplyLinksAsSources(reply, { requestText: "给我个链接" }), reply);
  assert.equal(rewriteQqReplyLinksAsSources(reply, { requestText: "send the URL" }), reply);
  assert.equal(rewriteQqReplyLinksAsSources(reply, { allowedUrls: ["https://example.com/p"] }), reply);
  assert.equal(rewriteQqReplyLinksAsSources(reply, { requestText: "最近有啥新闻" }), "在这 example.com");
});

test("leaves code and QQ markers untouched", () => {
  const code = "```sh\ncurl https://example.com/p\n```";
  assert.equal(rewriteQqReplyLinksAsSources(code), code);
  const inline = "跑 `curl https://example.com/p` 就行";
  assert.equal(rewriteQqReplyLinksAsSources(inline), inline);
  const marker = "[[qq_image:https://example.com/a.png]]";
  assert.equal(rewriteQqReplyLinksAsSources(marker), marker);
  assert.equal(rewriteQqReplyLinksAsSources("没有网址"), "没有网址");
});
