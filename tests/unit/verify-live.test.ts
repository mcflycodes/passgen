import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseManifest, verifyLive } from "../../scripts/lib/live-checks.ts";
import { createStaticServer } from "../../scripts/lib/static-server.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const CASES: ReadonlyArray<readonly [string, RegExp | undefined]> = [
  ["clean", undefined],
  ["missing-header", /Referrer-Policy missing or different/],
  ["csp-mismatch", /Content-Security-Policy missing or different/],
  ["wrong-header-value", /Referrer-Policy missing or different/],
  ["root-redirect", /GET : unexpected status 302/],
  ["spa-fallback", /GET passgen-verification-missing-.*unexpected status 200/],
  ["head-refused", /HEAD : unexpected status 405/],
  ["options-allowed", /OPTIONS : unexpected status 200/],
  ["hidden-allowed", /GET .hidden: unexpected status 200/],
  ["php-allowed", /GET x.php: unexpected status 200/],
  ["listing", /assets\/: directory listing/],
  ["directory-served", /GET assets\/: unexpected status 200/],
  ["changed-file", /SHA-256 mismatch: assets\/app.js/],
  ["changed-root", /Root HTML SHA-256 mismatch/],
  ["changed-local-file", /Local SHA-256 mismatch: assets\/app.js/],
  ["extra-file", /Release file set differs/],
  ["post-allowed", /POST : unexpected status 200/],
];

for (const [mode, expected] of CASES) {
  test(`live verifier: ${mode}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "passgen-live-"));
    const root = join(scratch, "dist");
    await mkdir(join(root, "assets"), { recursive: true });
    const files = new Map([
      ["index.html", "<!doctype html><title>PassGen</title>"],
      ["assets/app.js", "export {};"],
    ]);
    const manifest = join(scratch, "SHA256SUMS");
    await writeFile(
      manifest,
      [...files].map(([file, content]) => `${createHash("sha256").update(content).digest("hex")}  ${file}\n`).join(""),
    );
    for (const [file, content] of files) await writeFile(join(root, file), content);
    if (mode === "changed-file" || mode === "changed-local-file")
      await writeFile(join(root, "assets/app.js"), "changed");
    if (mode === "changed-root") await writeFile(join(root, "index.html"), "changed");
    if (mode === "extra-file") await writeFile(join(root, "extra.txt"), "extra");
    const staticServer = createStaticServer({ root, base: "/tools/passgen/" });
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const path = req.url ?? "";
      requests.push(`${req.method} ${path}`);
      if (["missing-header", "csp-mismatch", "wrong-header-value"].includes(mode)) {
        const original = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
          if (mode === "missing-header" && name.toLowerCase() === "referrer-policy") return res;
          if (mode === "csp-mismatch" && name.toLowerCase() === "content-security-policy")
            return original(name, "default-src 'self'");
          if (mode === "wrong-header-value" && name.toLowerCase() === "referrer-policy")
            return original(name, "unsafe-url");
          return original(name, value);
        };
      }
      const rootRequest = path === "/tools/passgen/";
      const attack =
        (mode === "root-redirect" && rootRequest) ||
        (mode === "spa-fallback" && path.includes("passgen-verification-missing-")) ||
        (mode === "head-refused" && req.method === "HEAD") ||
        (mode === "options-allowed" && req.method === "OPTIONS") ||
        (mode === "post-allowed" && req.method === "POST") ||
        (mode === "hidden-allowed" && path.endsWith("/.hidden")) ||
        (mode === "php-allowed" && path.endsWith("/x.php")) ||
        (["listing", "directory-served"].includes(mode) && path.endsWith("/assets/")) ||
        (mode === "changed-local-file" && path.endsWith("/assets/app.js"));
      if (!attack) {
        staticServer.emit("request", req, res);
        return;
      }
      for (const header of SECURITY_HEADERS) res.setHeader(header.name, header.value);
      let status = 200;
      let body = files.get("index.html");
      if (mode === "root-redirect") {
        status = 302;
        res.setHeader("Location", "/tools/passgen/index.html");
      } else if (mode === "head-refused") status = 405;
      else if (mode === "listing") {
        // A permitted directory-probe status isolates the listing regex from status checks.
        status = 404;
        body = "<title>Index of assets</title>";
      } else if (mode === "changed-local-file") {
        // HTTP bytes remain correct: only the mounted local release is corrupt.
        body = files.get("assets/app.js");
      }
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(req.method === "HEAD" ? undefined : body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = {
      url: `http://127.0.0.1:${address.port}/tools/passgen/`,
      manifest,
      localHttp: true,
      ...(["clean", "extra-file", "changed-local-file"].includes(mode) ? { releaseDir: root } : {}),
    };
    try {
      if (expected) await assert.rejects(verifyLive(options), expected);
      else {
        assert.equal(await verifyLive(options), 2);
        for (const probe of [
          "HEAD /tools/passgen/",
          "OPTIONS /tools/passgen/",
          "POST /tools/passgen/",
          "GET /tools/passgen/.hidden",
          "GET /tools/passgen/x.php",
          "GET /tools/passgen/assets/",
        ])
          assert.ok(requests.includes(probe), `missing probe: ${probe}`);
        assert.ok(requests.some((request) => request.startsWith("GET /tools/passgen/passgen-verification-missing-")));
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test("manifest parser rejects traversal with a valid index.html present", () => {
  const hash = "a".repeat(64);
  assert.throws(
    () => parseManifest(`${hash}  index.html\n${hash}  ../payload.js\n`),
    /Unsafe or duplicate manifest path/,
  );
});

test("manifest parser rejects absolute paths, duplicate paths and malformed hashes", () => {
  const hash = "a".repeat(64);
  for (const text of [`${hash}  /index.html`, `${hash}  index.html\n${hash}  index.html`, "bad  index.html"])
    assert.throws(() => parseManifest(text));
});

for (const [name, options, expected] of [
  ["plain HTTP", { url: "http://127.0.0.1:1/" }, /Live verification requires HTTPS/],
  ["non-loopback local HTTP", { url: "http://example.com/", localHttp: true }, /--local-http requires loopback HTTP/],
] as const) {
  test(`live verifier rejects ${name} before reading the manifest or fetching`, async () => {
    await assert.rejects(verifyLive({ ...options, manifest: "nonexistent-manifest" }), expected);
  });
}

test("live verifier CLI passes a clean production build", async () => {
  const run = promisify(execFile);
  const scratch = await mkdtemp(join(tmpdir(), "passgen-live-build-"));
  const root = join(scratch, "dist");
  const repo = join(import.meta.dirname, "../..");
  let server: ReturnType<typeof createStaticServer> | undefined;
  try {
    await run(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "build", "--outDir", root], {
      cwd: repo,
    });
    await run(process.execPath, [join(repo, "scripts/manifest.ts"), "--dir", root, "--out", scratch]);
    server = createStaticServer({ root });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const { stdout } = await run(process.execPath, [
      join(repo, "scripts/verify-live.ts"),
      "--url",
      `http://127.0.0.1:${address.port}/`,
      "--manifest",
      join(scratch, "SHA256SUMS"),
      "--release-dir",
      root,
      "--local-http",
    ]);
    assert.match(stdout, /PASS:/);
    assert.match(stdout, /file set matches exactly/);
    await writeFile(join(root, "index.html"), "changed production HTML");
    await assert.rejects(
      verifyLive({ url: `http://127.0.0.1:${address.port}/`, manifest: join(scratch, "SHA256SUMS"), localHttp: true }),
      /Root HTML SHA-256 mismatch/,
    );
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("live verifier CLI trusts a private CA only when NODE_EXTRA_CA_CERTS supplies it", async () => {
  const run = promisify(execFile);
  const scratch = await mkdtemp(join(tmpdir(), "passgen-live-tls-"));
  const cert = join(scratch, "cert.pem");
  const key = join(scratch, "key.pem");
  const root = join(scratch, "dist");
  let server: ReturnType<typeof createHttpsServer> | undefined;
  try {
    await mkdir(root);
    const body = "<!doctype html><title>PassGen</title>";
    await writeFile(join(root, "index.html"), body);
    const manifest = join(scratch, "SHA256SUMS");
    await writeFile(manifest, `${createHash("sha256").update(body).digest("hex")}  index.html\n`);
    const ca = join(scratch, "ca.pem");
    await run("bash", [join(import.meta.dirname, "../../scripts/lib/test-certificates.sh"), scratch, "IP:127.0.0.1"]);
    assert.equal(new X509Certificate(await readFile(cert)).ca, false);
    assert.equal(new X509Certificate(await readFile(ca)).ca, true);
    await run("openssl", ["verify", "-CAfile", ca, cert]);
    const staticServer = createStaticServer({ root });
    server = createHttpsServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) =>
      staticServer.emit("request", req, res),
    );
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const args = [
      join(import.meta.dirname, "../../scripts/verify-live.ts"),
      "--url",
      `https://127.0.0.1:${address.port}/`,
      "--manifest",
      manifest,
      "--release-dir",
      root,
    ];
    await assert.rejects(
      run(process.execPath, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: "" } }),
      /fetch failed/,
    );
    const { stdout } = await run(process.execPath, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca } });
    assert.match(stdout, /PASS: 1 file hashes/);
    const { stdout: curlBody } = await run("curl", [
      "--silent",
      "--show-error",
      "--fail",
      "--noproxy",
      "*",
      "--max-time",
      "15",
      "--cacert",
      ca,
      `https://127.0.0.1:${address.port}/`,
    ]);
    assert.equal(curlBody, body);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
