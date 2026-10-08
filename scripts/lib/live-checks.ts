// Deployment checks use a trusted local manifest, never a manifest fetched from the site.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECURITY_HEADERS } from "../../security/headers.ts";
import { listRegularFiles } from "./walk.ts";

export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9_./-]+)$/.exec(line);
    if (!match) throw new Error("Invalid SHA256SUMS line");
    const [, digest, file] = match;
    if (
      !digest ||
      !file ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      entries.has(file)
    ) {
      throw new Error("Unsafe or duplicate manifest path");
    }
    entries.set(file, digest);
  }
  if (!entries.has("index.html")) throw new Error("Manifest must contain index.html");
  return entries;
}

function hash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function verifyLive(options: {
  url: string;
  manifest: string;
  releaseDir?: string;
  localHttp?: boolean;
}): Promise<number> {
  const base = new URL(options.url);
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Use a base URL without credentials, query or fragment");
  if (options.localHttp) {
    if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
      throw new Error("--local-http requires loopback HTTP");
    }
  } else if (base.protocol !== "https:") throw new Error("Live verification requires HTTPS");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const entries = parseManifest(await readFile(options.manifest, "utf8"));
  if (options.releaseDir) {
    const files = await listRegularFiles(options.releaseDir);
    if (files.join("\n") !== [...entries.keys()].sort().join("\n"))
      throw new Error("Release file set differs from manifest");
    for (const [file, digest] of entries) {
      if (hash(await readFile(join(options.releaseDir, file))) !== digest)
        throw new Error(`Local SHA-256 mismatch: ${file}`);
    }
  }
  async function inspect(path: string, statuses: number[], method = "GET"): Promise<Uint8Array> {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "manual",
      headers: { "Accept-Encoding": "identity" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!statuses.includes(response.status)) throw new Error(`${method} ${path}: unexpected status ${response.status}`);
    for (const header of SECURITY_HEADERS) {
      if (response.headers.get(header.name) !== header.value)
        throw new Error(`${path}: ${header.name} missing or different`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (/<(?:title|h1)[^>]*>\s*(?:Index of|Directory listing)/i.test(new TextDecoder().decode(body))) {
      throw new Error(`${path}: directory listing`);
    }
    return body;
  }
  if (hash(await inspect("", [200])) !== entries.get("index.html")) throw new Error("Root HTML SHA-256 mismatch");
  await inspect("", [200], "HEAD");
  for (const [file, digest] of entries) {
    if (hash(await inspect(file, [200])) !== digest) throw new Error(`SHA-256 mismatch: ${file}`);
  }
  await inspect(`passgen-verification-missing-${randomUUID()}`, [404]);
  for (const method of ["POST", "OPTIONS"]) await inspect("", [403, 405], method);
  for (const path of [".hidden", "x.php"]) await inspect(path, [403, 404]);
  const directories = new Set<string>();
  for (const file of entries.keys()) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(`${parts.slice(0, i).join("/")}/`);
  }
  for (const path of directories) {
    if (!entries.has(`${path}index.html`)) await inspect(path, [403, 404]);
  }
  return entries.size;
}
