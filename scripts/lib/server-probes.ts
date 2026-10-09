import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { SECURITY_HEADERS } from "../../security/headers.ts";
import { parseManifest } from "./live-checks.ts";

export function parseResponse(raw: string) {
  const blocks = raw.split(/\r?\n\r?\n/);
  let block = blocks.shift() ?? "";
  // curl can receive interim responses before the final response.
  while (/^HTTP\/\S+ 1\d\d\b/.test(block)) block = blocks.shift() ?? "";
  const lines = block.split(/\r?\n/);
  const status = Number(lines.shift()?.match(/^HTTP\/\S+ (\d{3})\b/)?.[1]);
  assert.ok(status, "Missing HTTP status");
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const match = /^([^:]+):[ \t]?(.*)$/.exec(line);
    assert.ok(match, `Invalid header: ${line}`);
    const name = (match[1] ?? "").toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), match[2] ?? ""]);
  }
  return { status, headers, body: blocks.join("\n\n") };
}

export function checkSecurity(raw: string, statuses: number[], cache?: string) {
  const response = parseResponse(raw);
  assert.ok(statuses.includes(response.status), `Unexpected status ${response.status}; wanted ${statuses}`);
  for (const { name, value } of SECURITY_HEADERS) {
    assert.deepEqual(response.headers.get(name.toLowerCase()), [value], `${name}: must occur exactly once and match`);
  }
  if (cache) assert.deepEqual(response.headers.get("cache-control"), [cache], "Cache-Control mismatch");
  assert.doesNotMatch(response.body, /<(?:title|h1)[^>]*>\s*(?:Index of|Directory listing)/i);
}

export async function probeServer(options: {
  url: string;
  manifest: string;
  caFile?: string;
  address?: string;
  redirect?: boolean;
}) {
  const base = new URL(options.url);
  assert.equal(base.protocol, "https:");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const run = promisify(execFile);
  async function request(path: string, method = "GET", http = false) {
    const url = new URL(path, base);
    if (http) {
      url.protocol = "http:";
      url.port = "80";
    }
    const args = ["--silent", "--show-error", "--noproxy", "*", "--max-time", "15", "--include"];
    if (method === "HEAD") args.push("--head");
    else args.push("--request", method);
    if (options.caFile) args.push("--cacert", options.caFile);
    if (options.address)
      args.push("--resolve", `${url.hostname}:${url.port || (http ? "80" : "443")}:${options.address}`);
    args.push(url.href);
    return (await run("curl", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
  }
  const files = parseManifest(await readFile(options.manifest, "utf8"));
  assert.ok(
    [...files.keys()].some((file) => /favicon/i.test(file)),
    "Manifest must cover favicon",
  );
  for (const path of ["", ...files.keys()]) {
    const cache = path.startsWith("assets/")
      ? "public, max-age=31536000, immutable"
      : path === "" || path === "index.html"
        ? "no-cache"
        : undefined;
    for (const method of ["GET", "HEAD"]) checkSecurity(await request(path, method), [200], cache);
    console.log(`PASS GET/HEAD headers and cache: ${path || "/"}`);
  }
  checkSecurity(await request("passgen-ci-missing"), [404], "no-cache");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND"]) {
    checkSecurity(await request("", method), [403, 405]);
    console.log(`PASS refused ${method}`);
  }
  for (const path of ["assets/", ".hidden", "assets/.hidden", "test.map", "assets/test.map"]) {
    checkSecurity(await request(path), path === "assets/" ? [403, 404] : [403], "no-cache");
    console.log(`PASS refused ${path}`);
  }
  if (options.redirect) {
    const response = parseResponse(await request("index.html?probe=1", "GET", true));
    assert.ok([301, 308].includes(response.status), "HTTP must permanently redirect");
    assert.deepEqual(response.headers.get("location"), [new URL("index.html?probe=1", base).href]);
    console.log("PASS HTTP redirects to HTTPS");
  } else console.log("NOT TESTED: HTTP redirect (Apache/nginx examples require an operator-supplied listener)");
}
