import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheFor,
  checkFileResponse,
  checkHostileBaseline,
  checkLocalHttpBase,
  checkSecurity,
  parseResponse,
} from "../../scripts/lib/server-probes.ts";
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

test("every non-asset file, including favicon, must have no-cache", () => {
  const immutable = response().replace("Cache-Control: no-cache", "Cache-Control: public, max-age=31536000, immutable");
  for (const path of ["", "index.html", "favicon.svg", "manifest.webmanifest"]) {
    checkFileResponse(response(), path);
    assert.throws(() => checkFileResponse(immutable, path), /Cache-Control/);
  }
  checkFileResponse(immutable, "assets/app-12345678.js");
  assert.throws(() => checkFileResponse(response(), "assets/app-12345678.js"), /Cache-Control/);
});

test("local HTTP probing is limited to loopback hosts", () => {
  for (const url of ["http://127.0.0.1:8080/", "http://localhost:8080/", "http://[::1]:8080/"])
    checkLocalHttpBase(new URL(url));
  for (const url of ["https://127.0.0.1:8080/", "http://example.com/", "http://10.0.0.1:8080/"])
    assert.throws(() => checkLocalHttpBase(new URL(url)));
});

test("conditional and full responses share one cache policy per path", () => {
  assert.equal(cacheFor("assets/app-12345678.js"), "public, max-age=31536000, immutable");
  for (const path of ["", "index.html", "favicon.svg"]) assert.equal(cacheFor(path), "no-cache");
  checkSecurity(response().replace("200 Test", "304 Not Modified"), [304], cacheFor("index.html"));
});

test("hostile baseline control must prove conflicting headers and directory listing are active", () => {
  const control =
    "HTTP/1.1 200 OK\r\nX-Frame-Options: SAMEORIGIN\r\nReferrer-Policy: unsafe-url\r\n\r\n<title>Index of /listing/</title><a>baseline-marker.txt</a>";
  checkHostileBaseline(control);
  for (const broken of [
    control.replace("200 OK", "403 Forbidden"),
    control.replace("SAMEORIGIN", "DENY"),
    control.replace("unsafe-url", "no-referrer"),
    control.replace("Index of", "Contents"),
    control.replace("baseline-marker.txt", "nothing"),
  ])
    assert.throws(() => checkHostileBaseline(broken));
});
