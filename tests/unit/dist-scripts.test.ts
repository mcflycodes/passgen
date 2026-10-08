// Runs scripts/verify-dist.ts and scripts/manifest.ts against fixture folders.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { cspMetaTag } from "../../scripts/lib/dist-checks.ts";
import { listRegularFiles, UnsafeEntryError } from "../../scripts/lib/walk.ts";

const run = promisify(execFile);
const SCRIPTS = join(import.meta.dirname, "..", "..", "scripts");
const PAGE = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${cspMetaTag()}\n<title>t</title><script type="module" src="./assets/a.js"></script></head><body><h1>t</h1></body></html>`;

let scratch: string;

before(async () => {
  scratch = await mkdtemp(join(resolve(tmpdir()), "passgen-dist-"));
  await writeFile(join(scratch, "elsewhere.txt"), "not part of the build");
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fixture(name: string, extra?: (dir: string) => Promise<void>): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), PAGE);
  await writeFile(join(dir, "assets", "a.js"), 'document.documentElement.dataset.ready="true";');
  await extra?.(dir);
  return dir;
}

async function script(name: string, ...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(SCRIPTS, name), ...args]);
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, output: e.stdout + e.stderr };
  }
}

const UNSAFE: ReadonlyArray<readonly [string, (dir: string) => Promise<void>]> = [
  ["a file symlink", (dir) => symlink(join(scratch, "elsewhere.txt"), join(dir, "assets", "b.js"))],
  ["a directory symlink", (dir) => symlink(scratch, join(dir, "linked"))],
  [
    "an index.html symlink",
    async (dir) => {
      await mkdir(join(dir, "sub"));
      await symlink(join(scratch, "elsewhere.txt"), join(dir, "sub", "index.html"));
    },
  ],
  ["a dangling symlink", (dir) => symlink(join(scratch, "missing"), join(dir, "dangling.js"))],
];

describe("build folder walker", () => {
  test("lists regular files in nested folders, sorted", async () => {
    assert.deepEqual(await listRegularFiles(await fixture("walk-ok")), ["assets/a.js", "index.html"]);
  });

  for (const [label, add] of UNSAFE) {
    test(`fails on ${label}`, async () => {
      await assert.rejects(listRegularFiles(await fixture(`walk-${label}`, add)), UnsafeEntryError);
    });
  }
});

describe("serve script", () => {
  test("takes its folder from PASSGEN_SERVE_DIR, even with $( and spaces in the path, without running it", async () => {
    const dir = join(scratch, "serve $(touch pwned) dir");
    await mkdir(dir);
    await writeFile(join(dir, "index.html"), "ok");
    const child = spawn(process.execPath, [join(SCRIPTS, "serve.ts"), "--port", "0"], {
      cwd: scratch,
      env: { ...process.env, PASSGEN_SERVE_DIR: dir },
    });
    try {
      const line = await new Promise<string>((resolveLine, reject) => {
        child.stdout.on("data", (d: Buffer) => resolveLine(d.toString()));
        child.on("exit", (code) => reject(new Error(`exited ${code}`)));
      });
      assert.ok(line.includes(dir), line);
    } finally {
      child.kill();
    }
    await assert.rejects(stat(join(scratch, "pwned")));
    await assert.rejects(stat(join(dir, "pwned")));
  });

  test("refuses a folder that does not exist", async () => {
    const res = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [join(SCRIPTS, "serve.ts"), "--port", "0"], {
        env: { ...process.env, PASSGEN_SERVE_DIR: join(scratch, "missing $(x)") },
      });
      child.on("exit", done);
    });
    assert.equal(res, 1);
  });
});

describe("verify-dist and manifest scripts", () => {
  test("pass a clean build folder", async () => {
    const dir = await fixture("clean");
    const out = join(scratch, "clean-manifest");
    assert.equal((await script("verify-dist.ts", "--dir", dir)).code, 0);
    assert.equal((await script("manifest.ts", "--dir", dir, "--out", out)).code, 0);
    const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
    assert.match(sums, /^[0-9a-f]{64} {2}assets\/a\.js\n[0-9a-f]{64} {2}index\.html\n$/);
  });

  for (const [label, add] of UNSAFE) {
    test(`both fail on ${label}`, async () => {
      const dir = await fixture(`scripts-${label}`, add);
      const out = join(scratch, `manifest-${label}`);
      const verify = await script("verify-dist.ts", "--dir", dir);
      assert.notEqual(verify.code, 0);
      assert.match(verify.output, /symbolic link/);
      const manifest = await script("manifest.ts", "--dir", dir, "--out", out);
      assert.notEqual(manifest.code, 0);
      await assert.rejects(readFile(join(out, "SHA256SUMS")));
    });
  }

  test("verify-dist fails on a hostname in the build", async () => {
    const dir = await fixture("host", (d) => writeFile(join(d, "assets", "a.js"), 'fetch("example.education")'));
    const res = await script("verify-dist.ts", "--dir", dir);
    assert.notEqual(res.code, 0);
    assert.match(res.output, /example\.education/);
  });
});
