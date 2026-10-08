import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { createStaticServer, type StaticServerOptions } from "../../scripts/lib/static-server.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

let scratch: string;
let root: string;
let outside: string;
const servers: Array<{ close(): void }> = [];
const SECRET = "outside the served folder";

before(async () => {
  scratch = await mkdtemp(join(resolve(tmpdir()), "passgen-server-"));
  root = join(scratch, "site");
  outside = join(scratch, "outside");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(root, "assets", "a.js"), "export {};");
  await writeFile(join(outside, "secret.txt"), SECRET);
  await writeFile(join(outside, "index.html"), SECRET);

  // Symlinks inside the served tree that point out of it.
  await symlink(join(outside, "secret.txt"), join(root, "file-link.txt"));
  await symlink(outside, join(root, "dir-link"));
  await mkdir(join(root, "linked-index"));
  await symlink(join(outside, "index.html"), join(root, "linked-index", "index.html"));
  // A symlink that stays inside the tree is refused too.
  await symlink(join(root, "assets", "a.js"), join(root, "inside-link.js"));
});

after(async () => {
  for (const s of servers) s.close();
  await rm(scratch, { recursive: true, force: true });
});

async function start(options: Omit<StaticServerOptions, "root"> & { root?: string } = {}): Promise<string> {
  const server = createStaticServer({ root, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends a raw path, without fetch normalizing away "..". */
async function raw(origin: string, path: string, method = "GET"): Promise<Response> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request(`${origin}/`, { method, path }, (res) => {
      res.resume();
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
      resolve(new Response(null, { status: res.statusCode ?? 0, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function assertSecurityHeaders(res: Response): void {
  for (const h of SECURITY_HEADERS) assert.equal(res.headers.get(h.name), h.value, h.name);
}

describe("local static server", () => {
  test("serves index.html with every security header", async () => {
    const res = await fetch(`${await start()}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    assertSecurityHeaders(res);
  });

  test("serves assets with the right type and every security header", async () => {
    const res = await fetch(`${await start()}/assets/a.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/javascript/);
    assertSecurityHeaders(res);
  });

  test("answers a missing path with 404, not the page, and keeps every header", async () => {
    const res = await fetch(`${await start()}/no/such/page`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found\n");
    assertSecurityHeaders(res);
  });

  test("does not serve files outside its folder", async () => {
    const origin = await start();
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/assets/../../package.json", "/%00"]) {
      const res = await raw(origin, path);
      assert.ok(res.status === 404 || res.status === 400, `${path}: ${res.status}`);
      assertSecurityHeaders(res);
    }
  });

  test("refuses methods other than GET and HEAD, with every header", async () => {
    const res = await fetch(`${await start()}/`, { method: "POST" });
    assert.equal(res.status, 405);
    assertSecurityHeaders(res);
  });

  test("serves the build under a subpath and 404s outside it", async () => {
    const origin = await start({ base: "/tools/passgen/" });
    assert.equal((await fetch(`${origin}/tools/passgen/`)).status, 200);
    assert.equal((await fetch(`${origin}/tools/passgen/assets/a.js`)).status, 200);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    const redirect = await fetch(`${origin}/tools/passgen`, { redirect: "manual" });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/tools/passgen/");
  });

  test("can simulate a host that sets no headers", async () => {
    const res = await fetch(`${await start({ headers: false })}/`);
    assert.equal(res.status, 200);
    for (const h of SECURITY_HEADERS) assert.equal(res.headers.get(h.name), null, h.name);
  });

  for (const path of ["/file-link.txt", "/dir-link/secret.txt", "/dir-link/", "/linked-index/", "/inside-link.js"]) {
    test(`refuses the symlink at ${path}`, async () => {
      const res = await fetch(`${await start()}${path}`);
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.ok(!body.includes(SECRET), body);
      assertSecurityHeaders(res);
    });
  }

  test("serves a root folder reached through a symlink", async () => {
    const linkedRoot = join(scratch, "root-link");
    await symlink(root, linkedRoot);
    const res = await fetch(`${await start({ root: linkedRoot })}/assets/a.js`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "export {};");
  });

  test("answers an unreadable file with 500 and keeps serving", { skip: process.getuid?.() === 0 }, async () => {
    const origin = await start();
    const file = join(root, "assets", "locked.js");
    await writeFile(file, "x");
    await chmod(file, 0o000);
    try {
      const res = await fetch(`${origin}/assets/locked.js`);
      assert.equal(res.status, 500);
      assertSecurityHeaders(res);
    } finally {
      await rm(file, { force: true });
    }
    assert.equal((await fetch(`${origin}/assets/a.js`)).status, 200);
  });

  test("answers a file removed after listing with 404 and keeps serving", async () => {
    const origin = await start();
    const file = join(root, "assets", "gone.js");
    await writeFile(file, "x");
    await rm(file);
    const res = await fetch(`${origin}/assets/gone.js`);
    assert.equal(res.status, 404);
    assertSecurityHeaders(res);
    assert.equal((await fetch(`${origin}/`)).status, 200);
  });
});
