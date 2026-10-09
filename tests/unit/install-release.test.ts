// Runs scripts/install-release.sh against fixture releases built with the real
// manifest tool: a tiny dist, zipped with a minimal store-only zip writer so the
// tests can also craft hostile entries (zip-slip paths, symbolic links, devices).
// Needs bash, unzip, rsync and sha256sum, as the installer does.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { createStaticServer } from "../../scripts/lib/static-server.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "install-release.sh");
const VERSION = "v1.2.3";
const ZIP = "passgen-1.2.3.zip";

/** The fixture build: paths relative to the web root and their contents. */
const DIST: ReadonlyArray<readonly [string, string]> = [
  ["index.html", '<!doctype html>\n<title>t</title>\n<script type="module" src="./assets/app-1a2b3c.js"></script>\n'],
  ["assets/app-1a2b3c.js", "document.title = 'ready';\n"],
  ["assets/style-4d5e6f.css", "body { margin: 0 }\n"],
  ["img/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>\n"],
];

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  /** Unix mode written to the external attributes; 0 leaves the type bits unset. */
  readonly mode?: number;
}

/** A store-only zip: enough for unzip, and enough to write entries unzip must refuse. */
function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

let scratch: string;
let bash: string;
let releaseDir: string;
let manifestText: string;
let releaseCount = 0;

/** Writes a release folder (zip, .sha256, SHA256SUMS) and returns its path. */
async function makeRelease(
  entries: readonly ZipEntry[],
  manifest: string,
  options: { sha256?: string } = {},
): Promise<string> {
  const dir = join(scratch, `release-${releaseCount++}`);
  await mkdir(dir);
  const zip = writeZip(entries);
  await writeFile(join(dir, ZIP), zip);
  await writeFile(join(dir, `${ZIP}.sha256`), options.sha256 ?? `${sha256(zip)}  ${ZIP}\n`);
  await writeFile(join(dir, "SHA256SUMS"), manifest);
  return dir;
}

function distEntries(files: ReadonlyArray<readonly [string, string]> = DIST): ZipEntry[] {
  const dirs = new Set<string>();
  for (const [path] of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [
    ...[...dirs].map((name) => ({ name, data: Buffer.alloc(0), mode: 0o40755 })),
    ...files.map(([name, text]) => ({ name, data: Buffer.from(text) })),
  ];
}

before(async () => {
  scratch = await mkdtemp(join(resolve(tmpdir()), "passgen-install-"));
  bash = (await run("bash", ["-c", "command -v bash"])).stdout.trim();
  // The fixture dist and its manifest, written by the real manifest tool.
  const dist = join(scratch, "dist");
  for (const [path, text] of DIST) {
    await mkdir(dirname(join(dist, path)), { recursive: true });
    await writeFile(join(dist, path), text);
  }
  const out = join(scratch, "manifest");
  await run(process.execPath, [join(ROOT, "scripts", "manifest.ts"), "--dir", dist, "--out", out]);
  manifestText = await readFile(join(out, "SHA256SUMS"), "utf8");
  assert.equal(manifestText.split("\n").filter(Boolean).length, DIST.length);
  releaseDir = await makeRelease(distEntries(), manifestText);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function install(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(bash, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, output: e.stdout + e.stderr };
  }
}

/** Every entry under `dir`: path, type, mode, and the content hash for files. */
async function snapshot(dir: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(prefix: string) {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(join(dir, rel));
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isSymbolicLink()) {
        lines.push(`${rel} -> ${await readlink(join(dir, rel))}`);
      } else if (info.isDirectory()) {
        lines.push(`${rel}/ ${mode}`);
        await walk(rel);
      } else {
        lines.push(`${rel} ${mode} ${sha256(await readFile(join(dir, rel)))}`);
      }
    }
  }
  await walk("");
  const root = await stat(dir);
  lines.push(`. ${(root.mode & 0o7777).toString(8)}`);
  return lines.sort();
}

/** The snapshot the fixture release must produce once installed. */
function expectedSnapshot(fileMode = "644", dirMode = "755"): string[] {
  const lines = [`. ${dirMode}`, `assets/ ${dirMode}`, `img/ ${dirMode}`];
  for (const [path, text] of DIST) lines.push(`${path} ${fileMode} ${sha256(text)}`);
  return lines.sort();
}

let siteCount = 0;

/** A fresh site folder holding an older deployment, next to where backups will go. */
async function makeSite(): Promise<{ parent: string; docroot: string; backups: string }> {
  const parent = join(scratch, `site-${siteCount++}`);
  const docroot = join(parent, "htdocs");
  await mkdir(join(docroot, "assets"), { recursive: true });
  await mkdir(join(docroot, "old-dir"));
  await writeFile(join(docroot, "index.html"), "<!doctype html><title>old</title>");
  await writeFile(join(docroot, "assets", "app-000000.js"), "old");
  await writeFile(join(docroot, "old-dir", "notes.txt"), "keep me out of the new release");
  await writeFile(join(docroot, "private.txt"), "mode 600 survives a rollback");
  await chmod(join(docroot, "private.txt"), 0o600);
  return { parent, docroot, backups: join(parent, ".htdocs-backups") };
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/`;
}

describe("install-release: fixtures and arguments", () => {
  test("the security header names match security/headers.ts", async () => {
    const script = await readFile(SCRIPT, "utf8");
    const block = script.match(/SECURITY_HEADER_NAMES=\(\n([\s\S]*?)\)/)?.[1];
    assert.ok(block, "the script declares SECURITY_HEADER_NAMES");
    const names = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(
      names,
      SECURITY_HEADERS.map((h) => h.name),
    );
  });

  test("installs a release packaged by the real scripts/package-release.py", async () => {
    // The packager writes no directory entries, Unix file-type bits and a two-space .sha256 line.
    const dir = join(scratch, "packaged");
    await mkdir(dir);
    const packager = join(ROOT, "scripts", "package-release.py");
    await run("python3", [
      "-I",
      "-B",
      "-c",
      [
        "import importlib.util, sys",
        "from pathlib import Path",
        "spec = importlib.util.spec_from_file_location('packager', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "module.package(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])",
      ].join("\n"),
      packager,
      join(scratch, "dist"),
      dir,
      "1.2.3",
    ]);
    await writeFile(join(dir, "SHA256SUMS"), manifestText);
    assert.deepEqual((await readdir(dir)).sort(), ["SHA256SUMS", ZIP, `${ZIP}.sha256`]);
    const { docroot } = await makeSite();
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", dir]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });

  test("the fixture zip is one unzip reads back to the manifest's files", async () => {
    const dir = join(scratch, "unzip-check");
    await mkdir(dir);
    await run("unzip", ["-q", join(releaseDir, ZIP), "-d", dir]);
    const lines = manifestText.trimEnd().split("\n");
    for (const line of lines) {
      const [hash, path] = line.split("  ");
      assert.equal(sha256(await readFile(join(dir, path as string))), hash);
    }
  });

  test("usage errors exit 2 before touching anything", async () => {
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    for (const args of [
      ["--docroot", docroot],
      ["--version", "latest", "--docroot", docroot],
      ["--version", "1.2.3", "--docroot", docroot],
      ["--version", "v1.2.3-rc.1", "--docroot", docroot],
      ["--version", VERSION],
      ["--version", VERSION, "--docroot", docroot, "--file-mode", "rw-r--r--"],
      ["--version", VERSION, "--docroot", docroot, "--url", "http://example.test/"],
      ["--version", VERSION, "--docroot", docroot, "--url", "https://user:pw@example.test/"],
      ["--version", VERSION, "--docroot", docroot, "--bogus"],
    ]) {
      const result = await install(args);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.output}`);
    }
    assert.deepEqual(await snapshot(docroot), before);
  });

  test("a missing tool exits 3 with its name", async () => {
    const result = await install(["--version", VERSION, "--docroot", "/nonexistent/x"], { PATH: "/nonexistent" });
    assert.equal(result.code, 3, result.output);
    assert.match(result.output, /missing required tools: .*unzip/);
  });

  test("--help prints the usage reference", async () => {
    const result = await install(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.output, /--version vX\.Y\.Z --docroot DIR/);
    assert.match(result.output, /Exit codes:/);
  });
});

describe("install-release: happy paths", () => {
  test("installs over an older deployment, applies modes and owner, keeps a backup, removes staging", async () => {
    const { parent, docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--file-mode",
      "0640",
      "--dir-mode",
      "0750",
      "--owner",
      userInfo().username,
    ]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot("640", "750"));
    const backupNames = await entries(backups);
    assert.equal(backupNames.length, 1);
    assert.match(backupNames[0] as string, /^\d{8}T\d{6}Z$/);
    assert.deepEqual(await snapshot(join(backups, backupNames[0] as string)), before);
    assert.deepEqual(await entries(parent), [".htdocs-backups", "htdocs"], "no staging directory is left behind");
    assert.match(result.output, /Installed v1\.2\.3 into/);
  });

  test("creates a missing docroot", async () => {
    const parent = join(scratch, "fresh");
    await mkdir(parent);
    const docroot = join(parent, "www");
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });

  test("--url verifies the served site and the header names", async () => {
    const { docroot } = await makeSite();
    const server = createStaticServer({ root: docroot });
    const url = await listen(server);
    try {
      const result = await install([
        "--version",
        VERSION,
        "--docroot",
        docroot,
        "--from-dir",
        releaseDir,
        "--url",
        url,
        "--local-http",
      ]);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /every released file is served with its release hash/);
      assert.deepEqual(await snapshot(docroot), expectedSnapshot());
    } finally {
      server.close();
    }
  });

  test("--dry-run verifies the release and changes nothing", async () => {
    const { parent, docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir, "--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /files match SHA256SUMS/);
    assert.match(result.output, /\[dry-run\] would back up/);
    assert.match(result.output, /\[dry-run\] would chmod directories 0755 and files 0644/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(backups), []);
    assert.deepEqual(await entries(parent), ["htdocs"]);
  });

  test("keeps only the newest three backups", async () => {
    const { docroot, backups } = await makeSite();
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Make each run change something so every backup is a real snapshot.
      await writeFile(join(docroot, "index.html"), `run ${i}`);
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
      assert.equal(result.code, 0, result.output);
      names.push(...(await entries(backups)).filter((n) => !names.includes(n)));
    }
    assert.equal(names.length, 5);
    const kept = await entries(backups);
    assert.deepEqual(kept, names.slice(-3), "the three newest backups remain, in timestamp order");
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });

  test("--backup-dir elsewhere, and unrelated entries in it survive rotation", async () => {
    const { docroot } = await makeSite();
    const backupRoot = join(scratch, "backups-elsewhere");
    await mkdir(join(backupRoot, "keep-me"), { recursive: true });
    await writeFile(join(backupRoot, "notes.txt"), "not a backup");
    for (let i = 0; i < 4; i++) {
      await writeFile(join(docroot, "index.html"), `run ${i}`);
      const result = await install([
        "--version",
        VERSION,
        "--docroot",
        docroot,
        "--from-dir",
        releaseDir,
        "--backup-dir",
        backupRoot,
      ]);
      assert.equal(result.code, 0, result.output);
    }
    const names = await entries(backupRoot);
    assert.deepEqual(
      names.filter((n) => !/^\d{8}T\d{6}Z(-\d+)?$/.test(n)),
      ["keep-me", "notes.txt"],
    );
    assert.equal(names.length, 5);
  });
});

describe("install-release: release verification (exit 5, nothing changed)", () => {
  const cases: ReadonlyArray<readonly [string, () => Promise<string>, RegExp]> = [
    [
      "a bad zip checksum",
      () => makeRelease(distEntries(), manifestText, { sha256: `${"0".repeat(64)}  ${ZIP}\n` }),
      /checksum mismatch/,
    ],
    [
      "a .sha256 naming another file",
      async () => {
        const zip = writeZip(distEntries());
        return makeRelease(distEntries(), manifestText, { sha256: `${sha256(zip)}  other.zip\n` });
      },
      /names 'other.zip'/,
    ],
    [
      "a tampered file",
      () =>
        makeRelease(
          distEntries(DIST.map(([p, t]) => (p === "assets/app-1a2b3c.js" ? [p, `${t}// changed`] : [p, t]))),
          manifestText,
        ),
      /hashes differ from the manifest[\s\S]*does not match SHA256SUMS/,
    ],
    [
      "an extra file",
      () => makeRelease([...distEntries(), { name: "extra.txt", data: Buffer.from("x") }], manifestText),
      /extra: extra\.txt/,
    ],
    [
      "a missing file",
      () => makeRelease(distEntries(DIST.filter(([p]) => p !== "assets/style-4d5e6f.css")), manifestText),
      /missing: assets\/style-4d5e6f\.css/,
    ],
    [
      "a zip-slip entry",
      () => makeRelease([...distEntries(), { name: "../evil.txt", data: Buffer.from("x") }], manifestText),
      /unsafe path in passgen-1\.2\.3\.zip: '\.\.\/evil\.txt'/,
    ],
    [
      "an absolute entry",
      () => makeRelease([...distEntries(), { name: "/tmp/evil.txt", data: Buffer.from("x") }], manifestText),
      /unsafe path in passgen-1\.2\.3\.zip: '\/tmp\/evil\.txt'/,
    ],
    [
      "a symlink entry",
      () =>
        makeRelease(
          [...distEntries(), { name: "assets/link.js", data: Buffer.from("../../etc/passwd"), mode: 0o120777 }],
          manifestText,
        ),
      /not regular files or directories \(symbolic links/,
    ],
    [
      "a device entry",
      () => makeRelease([...distEntries(), { name: "assets/dev", data: Buffer.alloc(0), mode: 0o20644 }], manifestText),
      /not regular files or directories/,
    ],
    [
      "a manifest without index.html",
      () =>
        makeRelease(
          distEntries(),
          manifestText
            .split("\n")
            .filter((l) => !l.endsWith("  index.html"))
            .join("\n"),
        ),
      /does not list index\.html/,
    ],
    [
      "a manifest with an unsafe path",
      () => makeRelease(distEntries(), `${manifestText}${"0".repeat(64)}  ../outside\n`),
      /unsafe path in SHA256SUMS/,
    ],
    [
      "a malformed manifest line",
      () => makeRelease(distEntries(), `${manifestText}not a checksum line\n`),
      /not 'sha256 {2}path'/,
    ],
  ];

  for (const [label, build, expected] of cases) {
    test(`refuses ${label}`, async () => {
      const { parent, docroot, backups } = await makeSite();
      const before = await snapshot(docroot);
      const dir = await build();
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", dir]);
      assert.equal(result.code, 5, result.output);
      assert.match(result.output, expected);
      assert.deepEqual(await snapshot(docroot), before);
      assert.deepEqual(await entries(backups), [], "no backup is taken");
      assert.deepEqual(await entries(parent), ["htdocs"], "staging is removed");
    });
  }
});

describe("install-release: refused docroots (exit 4, nothing changed)", () => {
  test("refuses / as the docroot", async () => {
    const result = await install(["--version", VERSION, "--docroot", "/", "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /refusing to use \/ as the docroot/);
  });

  test("refuses a backup directory inside the docroot, and a docroot inside the backup directory", async () => {
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    let result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--backup-dir",
      join(docroot, "backups"),
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /must not be inside the docroot/);
    result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--backup-dir",
      dirname(docroot),
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /must not be inside the backup directory/);
    assert.deepEqual(await snapshot(docroot), before);
  });

  test("refuses --from-dir inside the docroot", async () => {
    const { docroot } = await makeSite();
    await cp(releaseDir, join(docroot, "release"), { recursive: true });
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", join(docroot, "release")]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /--from-dir must not be inside the docroot/);
  });

  test("refuses a docroot the backup cannot capture", async () => {
    const { docroot, backups } = await makeSite();
    await symlink(join(scratch, "dist"), join(docroot, "linked"));
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /cannot capture[\s\S]*linked \(l\)/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(backups), []);
  });
});

describe("install-release: rollback (exit 6)", () => {
  const rollbacks: ReadonlyArray<readonly [string, (docroot: string) => Server, RegExp]> = [
    [
      "the site serves different content",
      () => createStaticServer({ root: join(scratch, "dist-stale") }),
      /served file differs from the release|status 404/,
    ],
    [
      "index.html lacks a security header",
      (docroot) => createStaticServer({ root: docroot, headers: false }),
      /index\.html is missing security headers: Content-Security-Policy .*Cross-Origin-Resource-Policy/,
    ],
  ];

  before(async () => {
    // A site that serves yesterday's files: every path exists but index.html differs.
    const stale = join(scratch, "dist-stale");
    await cp(join(scratch, "dist"), stale, { recursive: true });
    await writeFile(join(stale, "index.html"), "stale");
  });

  for (const [label, serve, expected] of rollbacks) {
    test(`restores the exact previous tree when ${label}`, async () => {
      const { parent, docroot, backups } = await makeSite();
      const before = await snapshot(docroot);
      const server = serve(docroot);
      const url = await listen(server);
      try {
        const result = await install([
          "--version",
          VERSION,
          "--docroot",
          docroot,
          "--from-dir",
          releaseDir,
          "--url",
          url,
          "--local-http",
        ]);
        assert.equal(result.code, 6, result.output);
        assert.match(result.output, expected);
        assert.match(result.output, /rollback complete/);
        assert.deepEqual(await snapshot(docroot), before);
        const backupNames = await entries(backups);
        assert.equal(backupNames.length, 1, "the backup is kept after a rollback");
        assert.deepEqual(await entries(parent), [".htdocs-backups", "htdocs"]);
      } finally {
        server.close();
      }
    });
  }

  test("restores the exact previous tree when rsync fails part-way (a file mode nobody can read)", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read mode 0000 files, so rsync does not fail");
    const { docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--file-mode",
      "0000",
    ]);
    assert.equal(result.code, 6, result.output);
    assert.match(result.output, /rsync error/);
    assert.match(result.output, /rollback complete/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.equal((await entries(backups)).length, 1);
  });

  test("restores the exact previous tree when a file appears in the docroot during the install", async () => {
    // Simulate a concurrent writer with an rsync shim on PATH: it runs the real
    // rsync and, once, plants a rogue file after the delete pass. The re-hash of
    // the docroot must notice the extra file and the rollback must remove it.
    const { docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const bin = join(scratch, "rogue-bin");
    await mkdir(bin, { recursive: true });
    const realRsync = (await run("bash", ["-c", "command -v rsync"])).stdout.trim();
    const marker = join(bin, "planted");
    await writeFile(
      join(bin, "rsync"),
      [
        "#!/usr/bin/env bash",
        `"${realRsync}" "$@"`,
        "rc=$?",
        `if [[ " $* " == *" --delete "* && ! -e "${marker}" ]]; then`,
        `  echo rogue > "${join(docroot, "rogue.txt")}"`,
        `  : > "${marker}"`,
        "fi",
        "exit $rc",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    assert.equal(result.code, 6, result.output);
    assert.match(result.output, /installed files: the file set differs from the manifest:\n\s+extra: rogue\.txt/);
    assert.match(result.output, /rollback complete/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.equal((await entries(backups)).length, 1);
  });
});
