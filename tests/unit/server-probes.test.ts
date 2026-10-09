import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSecurity, parseResponse } from "../../scripts/lib/server-probes.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

function response(extra = "", status = 200, body = "") {
  return `HTTP/1.1 ${status} Test\r\n${SECURITY_HEADERS.map(({ name, value }) => `${name}: ${value}\r\n`).join("")}Cache-Control: no-cache\r\n${extra}\r\n${body}`;
}

test("curl parser preserves repeated headers, case-insensitive names and exact values", () => {
  const parsed = parseResponse(response("rEfErReR-pOlIcY: no-referrer\r\n"));
  assert.deepEqual(parsed.headers.get("referrer-policy"), ["no-referrer", "no-referrer"]);
  assert.throws(() => checkSecurity(response("Referrer-Policy: no-referrer\r\n"), [200]), /exactly once/);
  checkSecurity(response(), [200], "no-cache");
});

test("curl parser handles HTTP/2, interim status and HEAD's empty body", () => {
  checkSecurity(`HTTP/1.1 100 Continue\r\n\r\n${response().replace("HTTP/1.1", "HTTP/2")}`, [200]);
  assert.equal(parseResponse(response()).body, "");
});

test("probes reject missing, changed and whitespace-altered canonical headers", () => {
  for (const { name, value } of SECURITY_HEADERS) {
    const line = `${name}: ${value}\r\n`;
    for (const replacement of ["", `${name}: wrong\r\n`, `${name}: ${value} \r\n`]) {
      assert.throws(() => checkSecurity(response().replace(line, replacement), [200]), /exactly once/);
    }
  }
});

test("probes reject wrong status, caching, duplicate cache headers and listings", () => {
  assert.throws(() => checkSecurity(response("", 404), [200]), /Unexpected status/);
  assert.throws(() => checkSecurity(response(), [200], "public, max-age=31536000, immutable"), /Cache-Control/);
  assert.throws(() => checkSecurity(response("Cache-Control: no-cache\r\n"), [200], "no-cache"), /Cache-Control/);
  assert.throws(() => checkSecurity(response("", 403, "<title>Index of /assets</title>"), [403]));
  assert.throws(() => parseResponse("invalid"), /Missing HTTP status/);
});
