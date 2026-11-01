import { createHmac } from "node:crypto";
import { HttpError, readBody } from "../../http-utils.js";
import { requestHasValidToken, safeTokenEqual } from "../../request-auth.js";

// NapCat signs the exact request bytes, rather than sending a bearer token.
export async function authenticateOneBotWebhook(req, expectedToken) {
  if (!expectedToken) return { trusted: false };
  if (requestHasValidToken(req, expectedToken, {
    alternativeHeaders: ["x-onebot-access-token"]
  })) return { trusted: true };
  const signature = String(req.headers?.["x-signature"] || "");
  if (!/^sha1=[a-f0-9]{40}$/i.test(signature)) return { trusted: false };
  const payload = await readBody(req, {
    requireJson: true,
    maxBytes: 256 * 1024,
    verifyRawBody(rawBody) {
      const expected = "sha1=" + createHmac("sha1", expectedToken).update(rawBody).digest("hex");
      if (!safeTokenEqual(signature.toLowerCase(), expected)) {
        throw new HttpError(401, "OneBot authentication required");
      }
    }
  });
  return { trusted: true, payload };
}
