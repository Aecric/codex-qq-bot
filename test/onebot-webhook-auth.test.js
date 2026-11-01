import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { authenticateOneBotWebhook } from "../src/channels/qq/onebot-webhook-auth.js";
const secret = "test-secret";
const sign = (body, key = secret) => "sha1=" + createHmac("sha1", key).update(body).digest("hex");
function request(body, signature, headers = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = { "content-type": "application/json", "x-signature": signature, ...headers };
  return req;
}
test("authenticates NapCat signatures over exact chunked UTF-8 bytes", async () => {
  const body = ' { "message": "你好", "user_id": 123 } \n';
  const req = Readable.from([Buffer.from(body).subarray(0, 18), Buffer.from(body).subarray(18)]);
  req.headers = { "content-type": "application/json", "x-signature": sign(body) };
  const result = await authenticateOneBotWebhook(req, secret);
  assert.equal(result.trusted, true);
  assert.deepEqual(result.payload, { message: "你好", user_id: 123 });
});
test("rejects forged signatures, changed payloads and reserialized JSON", async () => {
  for (const [body, signature] of [['{}', sign('{}', 'wrong')], ['{"admin":true}', sign('{}')], [' {}', sign('{}')]]) {
    await assert.rejects(authenticateOneBotWebhook(request(body, signature), secret), { statusCode: 401 });
  }
  for (const signature of ['', 'sha256=abc', 'sha1=bad']) {
    assert.equal((await authenticateOneBotWebhook(request('{}', signature), secret)).trusted, false);
  }
  assert.equal((await authenticateOneBotWebhook(request('{}', sign('{}')), '')).trusted, false);
});
test("signed requests retain JSON type and byte limits", async () => {
  const body = '"' + 'x'.repeat(256 * 1024) + '"';
  await assert.rejects(authenticateOneBotWebhook(request(body, sign(body)), secret), { statusCode: 413 });
  await assert.rejects(authenticateOneBotWebhook(request('{}', sign('{}'), { 'content-type': 'text/plain' }), secret), { statusCode: 415 });
  await assert.rejects(authenticateOneBotWebhook(request('not-json', sign('not-json')), secret), { statusCode: 400 });
});
test("preserves bearer authentication without consuming the request body", async () => {
  const req = request('{}', '', { authorization: 'Bearer ' + secret });
  assert.deepEqual(await authenticateOneBotWebhook(req, secret), { trusted: true });
  assert.equal(req.readableEnded, false);
});
