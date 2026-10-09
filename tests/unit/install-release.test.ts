// Runs scripts/install-release.sh against fixture releases built with the real
// manifest tool: a tiny dist, zipped with a minimal store-only zip writer so the
// tests can also craft hostile entries (zip-slip paths, symbolic links, devices).
// Hostile timing (a docroot swapped mid-install, a tampered backup, a failing
// rm) comes from shims put first on PATH. Needs bash, unzip, rsync and
// sha256sum, as the installer does; the mount-point cases also need unshare.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  cp,
  link,
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
/** 2026-01-01T00:00:00Z, for a `date` shim that stops the clock. */
const FROZEN_EPOCH = 1767225600;
const FROZEN_SECOND = "20260101T000000Z";
const BACKUP_NAME = /^\d{8}T\d{6}Z-\d{6}$/;

/** The fixture build: paths relative to the web root and their contents. */
const DIST: ReadonlyArray<readonly [string, string]> = [
  ["index.html", '<!doctype html>\n<title>t</title>\n<script type="module" src="./assets/app-1a2b3c.js"></script>\n'],
  ["assets/app-1a2b3c.js", "document.title = 'ready';\n"],
  ["assets/style-4d5e6f.css", "body { margin: 0 }\n"],
  ["img/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>\n"],
];
const LOGO = DIST.find(([path]) => path === "img/logo.svg")?.[1] as string;

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

/** Single-quotes a value for a bash shim. */
const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

let scratch: string;
let bash: string;
let realRsync: string;
let realRm: string;
let realDate: string;
let releaseDir: string;
let manifestText: string;
let releaseCount = 0;
let ids: string;

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

/** A SHA256SUMS for `files`, in the manifest tool's format. */
function manifestFor(files: ReadonlyArray<readonly [string, string]>): string {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, text]) => `${sha256(text)}  ${path}\n`)
    .join("");
}

before(async () => {
  // The installer refuses directories other users can write to; keep the fixtures' modes predictable.
  process.umask(0o022);
  scratch = await mkdtemp(join(resolve(tmpdir()), "passgen-install-"));
  const which = async (name: string) => (await run("bash", ["-c", `command -v ${name}`])).stdout.trim();
  bash = await which("bash");
  realRsync = await which("rsync");
  realRm = await which("rm");
  realDate = await which("date");
  ids = `${process.getuid?.()}:${process.getgid?.()}`;
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
  assert.equal(manifestText, manifestFor(DIST));
  releaseDir = await makeRelease(distEntries(), manifestText);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runScript(command: string, args: string[], env: Record<string, string> = {}, cwd?: string) {
  try {
    const { stdout, stderr } = await run(command, args, { env: { ...process.env, ...env }, cwd });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, output: e.stdout + e.stderr };
  }
}

/**
 * In a user namespace (such as `unshare -r`, which the gates use), root's directories show as the
 * kernel's overflow ID, which the installer only trusts when told to.
 */
const OVERFLOW_UID = readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim();
const IN_USER_NAMESPACE = !/^\s*0\s+0\s+4294967295\s*$/.test(readFileSync("/proc/self/uid_map", "utf8"));
const TRUST = IN_USER_NAMESPACE ? ["--trust-owner", OVERFLOW_UID] : [];
const IS_ROOT = process.getuid?.() === 0;

const install = (args: string[], env: Record<string, string> = {}, cwd?: string) =>
  runScript(bash, [SCRIPT, ...TRUST, ...args], env, cwd);

let binCount = 0;

/** A PATH whose first directory holds one executable bash shim named `name`. */
async function shim(name: string, lines: readonly string[]): Promise<Record<string, string>> {
  const bin = join(scratch, `bin-${binCount++}`);
  await mkdir(bin);
  await writeFile(join(bin, name), ["#!/usr/bin/env bash", ...lines, ""].join("\n"), { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

/** Every entry under `dir`: path, type, mode, uid:gid, and the content hash for files. */
async function snapshot(dir: string): Promise<string[]> {
  const lines: string[] = [];
  async function walk(prefix: string) {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(join(dir, rel));
      const meta = `${(info.mode & 0o7777).toString(8)} ${info.uid}:${info.gid}`;
      if (info.isSymbolicLink()) {
        lines.push(`${rel} -> ${await readlink(join(dir, rel))}`);
      } else if (info.isDirectory()) {
        lines.push(`${rel}/ ${meta}`);
        await walk(rel);
      } else {
        lines.push(`${rel} ${meta} ${sha256(await readFile(join(dir, rel)))}`);
      }
    }
  }
  await walk("");
  const root = await stat(dir);
  lines.push(`. ${(root.mode & 0o7777).toString(8)} ${root.uid}:${root.gid}`);
  return lines.sort();
}

/** `dir` and everything under it with its change time, which any write or metadata change moves. */
async function ctimes(dir: string): Promise<string[]> {
  const lines = [`. ${(await stat(dir, { bigint: true })).ctimeNs}`];
  for (const name of await readdir(dir, { recursive: true })) {
    lines.push(`${name} ${(await lstat(join(dir, name), { bigint: true })).ctimeNs}`);
  }
  return lines.sort();
}

/** The snapshot the fixture release must produce once installed. */
function expectedSnapshot(fileMode = "644", dirMode = "755", owner = ids): string[] {
  const lines = [`. ${dirMode} ${owner}`, `assets/ ${dirMode} ${owner}`, `img/ ${dirMode} ${owner}`];
  for (const [path, text] of DIST) lines.push(`${path} ${fileMode} ${owner} ${sha256(text)}`);
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

/** The backup directory the installer reports in its last line; the copy is in its docroot/. */
function reportedBackup(output: string): string {
  const path = output.match(/; backup in (.+)\/docroot$/m)?.[1];
  assert.ok(path, `no backup reported in:\n${output}`);
  return path;
}

/** Makes backup directories named `names` in `backups`, each holding one file. */
async function makeBackups(backups: string, names: readonly string[]) {
  await mkdir(backups, { recursive: true, mode: 0o700 });
  for (const name of names) {
    await mkdir(join(backups, name));
    await writeFile(join(backups, name, "index.html"), name);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/`;
}

/** Whether this machine can run `unshare` with these flags as an unprivileged user. */
async function canUnshare(flags: readonly string[] = ["-rm"]): Promise<boolean> {
  try {
    await run("unshare", [...flags, "true"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs bash `setup` in new namespaces (`unshare` with `flags`, as root there), then the installer
 * with `args`. Root's directories show there as the overflow ID, so the installer is told to trust it.
 */
function installInNamespace(setup: string, args: readonly string[], flags: readonly string[] = ["-rm"]) {
  return runScript("unshare", [
    ...flags,
    bash,
    "-c",
    `${setup}\nexec "$@"`,
    "in-namespace",
    bash,
    SCRIPT,
    "--trust-owner",
    OVERFLOW_UID,
    ...args,
  ]);
}

/** Runs the installer in a new mount namespace with a tmpfs mounted on `mountPoint`. */
function installWithTmpfs(mountPoint: string, args: string[]) {
  return installInNamespace(`mount -t tmpfs -o mode=0755 passgen-test ${q(mountPoint)} || exit 99`, args);
}

/** ACL entry tags, as the kernel stores them in system.posix_acl_* attributes. */
const ACL = { userObj: 0x01, user: 0x02, groupObj: 0x04, group: 0x08, mask: 0x10, other: 0x20 } as const;
const UNNAMED = 0xffffffff;

/** Sets a default ACL on `dir` without the acl tools: [tag, permissions, id] in tag order. */
async function setDefaultAcl(dir: string, acl: ReadonlyArray<readonly [number, number, number]>) {
  await run("python3", [
    "-I",
    "-c",
    [
      "import os, struct, sys",
      "entries = [tuple(int(x) for x in e.split(',')) for e in sys.argv[2:]]",
      "value = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *e) for e in entries)",
      "os.setxattr(sys.argv[1], 'system.posix_acl_default', value)",
    ].join("\n"),
    dir,
    ...acl.map((entry) => entry.join(",")),
  ]);
}

/** Whether `path` carries a default ACL. */
async function hasDefaultAcl(path: string): Promise<boolean> {
  const { stdout } = await run("python3", [
    "-I",
    "-c",
    [
      "import os, sys",
      "try:",
      "    os.getxattr(sys.argv[1], 'system.posix_acl_default')",
      "    print('yes')",
      "except OSError:",
      "    print('no')",
    ].join("\n"),
    path,
  ]);
  return stdout.trim() === "yes";
}

const hasTool = async (name: string) => (await runScript("bash", ["-c", `command -v ${name}`])).code === 0;

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
    const { parent, docroot } = await makeSite();
    const before = await snapshot(docroot);
    const parentBefore = await ctimes(parent);
    for (const args of [
      ["--docroot", docroot],
      ["--version", "latest", "--docroot", docroot],
      ["--version", "1.2.3", "--docroot", docroot],
      ["--version", "v1.2.3-rc.1", "--docroot", docroot],
      ["--version", VERSION],
      ["--version", VERSION, "--docroot", docroot, "--file-mode", "rw-r--r--"],
      // Modes that would lock the installer out of its own files.
      ["--version", VERSION, "--docroot", docroot, "--dir-mode", "0000"],
      ["--version", VERSION, "--docroot", docroot, "--dir-mode", "0644"],
      // Root can manage a 0500 tree; anyone else needs owner write.
      ...(IS_ROOT ? [] : [["--version", VERSION, "--docroot", docroot, "--dir-mode", "0500"]]),
      // A docroot others can write is not supported.
      ["--version", VERSION, "--docroot", docroot, "--dir-mode", "0775"],
      ["--version", VERSION, "--docroot", docroot, "--dir-mode", "0757"],
      ["--version", VERSION, "--docroot", docroot, "--trust-owner", "nobody"],
      ["--version", VERSION, "--docroot", docroot, "--trust-owner", "-1"],
      ["--version", VERSION, "--docroot", docroot, "--owner", "no-such-user-passgen"],
      ["--version", VERSION, "--docroot", docroot, "--file-mode", "0000"],
      ["--version", VERSION, "--docroot", docroot, "--file-mode", "0200"],
      ["--version", VERSION, "--docroot", docroot, "--url", "http://example.test/"],
      ["--version", VERSION, "--docroot", docroot, "--url", "https://user:pw@example.test/"],
      ["--version", VERSION, "--docroot", docroot, "--bogus"],
    ]) {
      const result = await install([...args, "--from-dir", releaseDir]);
      assert.equal(result.code, 2, `${args.join(" ")}: ${result.output}`);
    }
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await ctimes(parent), parentBefore, "no staging directory was created");
  });

  test("rejects control characters in paths and names, so a trailing newline cannot pick a sibling", async () => {
    // realpath's output loses a trailing newline in $(...), so "www\n" would become the sibling "www".
    const parent = join(scratch, "newline");
    const www = join(parent, "www");
    await mkdir(www, { recursive: true });
    await writeFile(join(www, "index.html"), "the sibling site");
    await writeFile(join(www, "data.txt"), "the sibling's data");
    const before = await snapshot(www);
    const fresh = join(parent, "new");
    for (const args of [
      ["--docroot", `${www}\n`],
      ["--docroot", `${www}\n\n`],
      ["--docroot", `${www}\r`],
      ["--docroot", `${www}\t`],
      ["--docroot", fresh, "--backup-dir", `${www}\n`],
      ["--docroot", fresh, "--staging-dir", `${www}\n`],
      ["--docroot", fresh, "--from-dir", `${releaseDir}\n`],
      ["--docroot", fresh, "--version", `${VERSION}\n`],
      ["--docroot", fresh, "--repo", "owner/name\n"],
      ["--docroot", fresh, "--owner", `${userInfo().username}\r`],
      ["--docroot", fresh, "--url", "https://example.test/\n"],
    ]) {
      const result = await install(["--version", VERSION, "--from-dir", releaseDir, ...args]);
      assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.output}`);
      assert.match(result.output, /must not contain control characters/);
    }
    assert.deepEqual(await snapshot(www), before);
    assert.deepEqual(await entries(parent), ["www"]);
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
  test("installs over an older deployment, applies modes and owner, keeps a private backup, removes staging", async () => {
    const { parent, docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const group = (await run("id", ["-gn"])).stdout.trim();
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
      `${userInfo().username}:${group}`,
    ]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot("640", "750"));
    assert.equal((await stat(backups)).mode & 0o7777, 0o700, "the backup directory is private");
    const backupNames = await entries(backups);
    assert.equal(backupNames.length, 1);
    assert.match(backupNames[0] as string, BACKUP_NAME);
    const backup = join(backups, backupNames[0] as string);
    assert.equal(reportedBackup(result.output), backup);
    assert.equal((await stat(backup)).mode & 0o7777, 0o700, "each backup directory is private too");
    assert.deepEqual(await entries(backup), ["docroot"]);
    assert.deepEqual(await snapshot(join(backup, "docroot")), before);
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

  test("--dry-run writes nothing outside a private directory under TMPDIR, and removes that", async () => {
    const { parent, docroot, backups } = await makeSite();
    await makeBackups(backups, ["20000101T000000Z-000001"]);
    const tmp = await mkdtemp(join(scratch, "dry-run-tmp-"));
    const before = {
      docroot: await snapshot(docroot),
      backups: await snapshot(backups),
      changes: await ctimes(parent),
    };
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir, "--dry-run"], {
      TMPDIR: tmp,
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /files match SHA256SUMS/);
    assert.match(result.output, /\[dry-run\] would back up/);
    assert.match(result.output, /\[dry-run\] would set directories to 0755 and files to 0644/);
    assert.match(result.output, new RegExp(`only files written were in ${tmp}/passgen-dry-run\\.`));
    assert.deepEqual(
      {
        docroot: await snapshot(docroot),
        backups: await snapshot(backups),
        changes: await ctimes(parent),
      },
      before,
      "nothing in the docroot, the backups or the staging directory changed",
    );
    assert.deepEqual(await entries(tmp), [], "the private directory under TMPDIR is removed");
  });

  test("--dry-run refuses a TMPDIR inside the docroot", async () => {
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir, "--dry-run"], {
      TMPDIR: join(docroot, "assets"),
    });
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /TMPDIR .* must not be inside the docroot/);
    assert.deepEqual(await snapshot(docroot), before);
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
    await mkdir(join(backupRoot, "keep-me"), { recursive: true, mode: 0o700 });
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
      names.filter((n) => !BACKUP_NAME.test(n)),
      ["keep-me", "notes.txt"],
    );
    assert.equal(names.length, 5);
  });

  test("numbers backups within one second so they sort, and keeps the one just taken", async () => {
    // With a stopped clock the old "-N" suffix reached "-10", which sorts before "-2",
    // and rotation deleted the backup it had just taken.
    const { docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const legacy = [FROZEN_SECOND, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${FROZEN_SECOND}-${n}`)];
    const numbered = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${FROZEN_SECOND}-${String(n).padStart(6, "0")}`);
    await makeBackups(backups, [...legacy, ...numbered]);
    const env = await shim("date", [`exec ${q(realDate)} -d @${FROZEN_EPOCH} "$@"`]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.equal(result.code, 0, result.output);
    const current = `${FROZEN_SECOND}-000010`;
    assert.equal(reportedBackup(result.output), join(backups, current));
    assert.deepEqual(await snapshot(join(backups, current, "docroot")), before, "the backup just taken is kept");
    assert.deepEqual(
      await entries(backups),
      [...legacy, `${FROZEN_SECOND}-000008`, `${FROZEN_SECOND}-000009`, current].sort(),
      "the two newest earlier backups are kept; names in another format are left alone",
    );
  });

  test("keeps the backup just taken even when older backups sort after it", async () => {
    // A clock that was once ahead leaves backups whose names sort after today's.
    const { docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const future = [1, 2, 3].map((n) => `20991231T235959Z-00000${n}`);
    await makeBackups(backups, future);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 0, result.output);
    const current = reportedBackup(result.output);
    assert.deepEqual(await snapshot(join(current, "docroot")), before);
    assert.deepEqual(await entries(backups), [current.slice(backups.length + 1), ...future.slice(1)].sort());
  });

  test("a failure to remove an old backup only warns: the verified install stands and exits 0", async () => {
    const { parent, docroot, backups } = await makeSite();
    const old = ["20000101T000000Z-000001", "20000101T000000Z-000002", "20000101T000000Z-000003"];
    await makeBackups(backups, old);
    const env = await shim("rm", [
      'for arg in "$@"; do',
      `  if [[ $arg == *${old[0]}* ]]; then echo "rm: cannot remove '$arg': Operation not permitted" >&2; exit 1; fi`,
      "done",
      `exec ${q(realRm)} "$@"`,
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /cannot remove '.*20000101T000000Z-000001'/);
    assert.match(result.output, /backup rotation did not finish .* the install itself succeeded/);
    assert.doesNotMatch(result.output, /restoring the backup/);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
    assert.deepEqual(await entries(backups), [...old, reportedBackup(result.output).slice(backups.length + 1)].sort());
    assert.deepEqual(await entries(parent), [".htdocs-backups", "htdocs"], "staging is removed");
  });

  test("--staging-dir elsewhere on the docroot's filesystem", async () => {
    const { parent, docroot } = await makeSite();
    const staging = join(scratch, `staging-${siteCount}`);
    await mkdir(staging);
    const result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--staging-dir",
      staging,
    ]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
    assert.deepEqual(await entries(staging), [], "staging is removed");
    assert.deepEqual(await entries(parent), [".htdocs-backups", "htdocs"]);
  });

  test("accepts a sticky world-writable directory above the docroot, as /tmp is", async () => {
    const { parent, docroot } = await makeSite();
    await chmod(parent, 0o1777);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });
});

describe("install-release: release verification (exit 5, nothing changed)", () => {
  const nearMisses = ["indexXhtml", "index.html.bak", "Index.html", "sub/index.html", "index.htm"];
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
      "a tampered last file when SHA256SUMS has no trailing newline",
      () => {
        const last = manifestText.trimEnd().split("\n").at(-1)?.slice(66);
        return makeRelease(
          distEntries(DIST.map(([p, t]) => (p === last ? [p, `${t} changed`] : [p, t]))),
          manifestText.trimEnd(),
        );
      },
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
    // A consistent release whose page is not exactly index.html: the name must match literally.
    ...nearMisses.map((name): readonly [string, () => Promise<string>, RegExp] => [
      `a release whose page is ${name} instead of index.html`,
      () => {
        const files = DIST.map(([p, t]): readonly [string, string] => (p === "index.html" ? [name, t] : [p, t]));
        return makeRelease(distEntries(files), manifestFor(files));
      },
      /does not list index\.html/,
    ]),
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

  test("installs a release whose SHA256SUMS has no trailing newline", async () => {
    const { docroot } = await makeSite();
    const dir = await makeRelease(distEntries(), manifestText.trimEnd());
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", dir]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /4 files match SHA256SUMS/);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });
});

describe("install-release: refused paths (exit 4, nothing changed)", () => {
  test("refuses / as the docroot", async () => {
    const result = await install(["--version", VERSION, "--docroot", "/", "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /refusing to use \/ as the docroot/);
  });

  test("refuses a docroot given as a symbolic link, and names the real directory", async () => {
    const { parent, docroot } = await makeSite();
    const current = join(parent, "current");
    await symlink(docroot, current);
    const before = await snapshot(docroot);
    for (const given of [current, `${current}/`, `${current}//`]) {
      const result = await install(["--version", VERSION, "--docroot", given, "--from-dir", releaseDir]);
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, new RegExp(`is a symbolic link; pass the directory it points to \\(${docroot}\\)`));
    }
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(parent), ["current", "htdocs"]);
  });

  test("refuses a docroot below a directory other users can write to", async () => {
    const { parent, docroot } = await makeSite();
    const before = await snapshot(docroot);
    for (const mode of [0o777, 0o775]) {
      await chmod(parent, mode);
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
      assert.equal(result.code, 4, result.output);
      assert.match(
        result.output,
        new RegExp(`${parent}, on the path to the docroot, is writable by other users \\(mode ${mode.toString(8)}\\)`),
      );
    }
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(parent), ["htdocs"]);
  });

  test("refuses backup and staging directories other users can write to, or below one", async () => {
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    const open = join(scratch, `open-${siteCount}`);
    await mkdir(join(open, "private"), { recursive: true, mode: 0o700 });
    await chmod(open, 0o777);
    const shared = join(scratch, `shared-backups-${siteCount}`);
    await mkdir(shared);
    await chmod(shared, 0o770);
    for (const [args, expected] of [
      [["--backup-dir", join(open, "backups")], /on the path to the backup directory, is writable by other users/],
      [["--backup-dir", join(open, "private", "backups")], /on the path to the backup directory, is writable/],
      [["--backup-dir", shared], /the backup directory .* has mode 770; it must be 0700/],
      [["--staging-dir", open], /on the path to the staging directory, is writable by other users/],
      [["--staging-dir", join(open, "private")], /on the path to the staging directory, is writable/],
    ] as const) {
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir, ...args]);
      assert.equal(result.code, 4, `${args.join(" ")}: ${result.output}`);
      assert.match(result.output, expected);
    }
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(open), ["private"]);
    assert.deepEqual(await entries(join(open, "private")), []);
    assert.deepEqual(await entries(shared), []);
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

  test("refuses a docroot file hard-linked from outside, which stays 0600", async () => {
    // Same content as the release's logo, so a content-based rsync would keep the inode and chmod it.
    const { parent, docroot, backups } = await makeSite();
    const outside = join(parent, "outside-secret");
    await writeFile(outside, LOGO, { mode: 0o600 });
    await mkdir(join(docroot, "img"));
    await link(outside, join(docroot, "img", "logo.svg"));
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /more than one hard link[\s\S]*img\/logo\.svg \(2 links\)/);
    assert.equal((await stat(outside)).mode & 0o7777, 0o600);
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(backups), []);
  });

  test("refuses --staging-dir on another filesystem than the docroot", async (t) => {
    if (!(await canUnshare())) return t.skip("needs unprivileged user and mount namespaces");
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    const staging = join(scratch, `tmpfs-staging-${siteCount}`);
    await mkdir(staging);
    const result = await installWithTmpfs(staging, [
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--staging-dir",
      staging,
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /staging directory .* is not on the docroot's filesystem; pass --staging-dir/);
    assert.deepEqual(await snapshot(docroot), before);
  });

  test("refuses a docroot that is a mount point when staging would be on another filesystem", async (t) => {
    if (!(await canUnshare())) return t.skip("needs unprivileged user and mount namespaces");
    const { parent, docroot } = await makeSite();
    const result = await installWithTmpfs(docroot, [
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(
      result.output,
      /is a mount point, so the staging directory .* is on another filesystem; pass --staging-dir/,
    );
    assert.deepEqual(await entries(parent), ["htdocs"], "no backup or staging directory was created");
  });
});

describe("install-release: a docroot swapped during the install (exit 8)", () => {
  // The reviewer's attack: rename the docroot and leave a symbolic link to a victim
  // directory in its place, between the script's checks and its writes. The shim
  // does it just before the matching rsync runs.
  const swaps: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["while the backup is taken", "*/.htdocs-backups/*", /is no longer the directory checked at the start/],
    ["before the first install pass", "*--exclude=/index.html*", /ROLLBACK REFUSED: .* is no longer the directory/],
    ["before the deleting install pass", "*--delete*", /ROLLBACK REFUSED: .* is no longer the directory/],
  ];

  for (const [label, trigger, expected] of swaps) {
    test(`writes nothing through the swapped path, and refuses to roll back, ${label}`, async () => {
      const { parent, docroot } = await makeSite();
      const victim = join(parent, "victim");
      await mkdir(join(victim, "data"), { recursive: true });
      await writeFile(join(victim, "index.html"), "the victim's page");
      await writeFile(join(victim, "data", "precious.txt"), "must survive");
      await chmod(join(victim, "data", "precious.txt"), 0o600);
      const before = await snapshot(victim);
      const marker = join(parent, "swapped");
      const env = await shim("rsync", [
        `if [[ " $* " == ${trigger} && ! -e ${q(marker)} ]]; then`,
        `  : > ${q(marker)}`,
        `  mv ${q(docroot)} ${q(`${docroot}.moved`)}`,
        `  ln -s ${q(victim)} ${q(docroot)}`,
        "fi",
        `exec ${q(realRsync)} "$@"`,
      ]);
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
      assert.ok(existsSync(marker), "the swap happened");
      assert.equal(result.code, 8, result.output);
      assert.match(result.output, expected);
      assert.doesNotMatch(result.output, /rollback complete/);
      assert.deepEqual(await snapshot(victim), before, "the victim directory is untouched");
    });
  }
});

describe("install-release: rollback (exit 6, or 7 when it is refused)", () => {
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

  test("checks the last manifest line on the live site when SHA256SUMS has no trailing newline", async () => {
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    const last = manifestText.trimEnd().split("\n").at(-1)?.slice(66) as string;
    // A site that serves every file right except the one on the manifest's last line.
    const served = join(scratch, "dist-last-differs");
    await cp(join(scratch, "dist"), served, { recursive: true });
    await writeFile(join(served, last), "not the release");
    const dir = await makeRelease(distEntries(), manifestText.trimEnd());
    const server = createStaticServer({ root: served });
    const url = await listen(server);
    try {
      const result = await install([
        "--version",
        VERSION,
        "--docroot",
        docroot,
        "--from-dir",
        dir,
        "--url",
        url,
        "--local-http",
      ]);
      assert.equal(result.code, 6, result.output);
      assert.match(
        result.output,
        new RegExp(`${last.replaceAll(".", "\\.")}: the served file differs from the release`),
      );
      assert.match(result.output, /rollback complete/);
      assert.deepEqual(await snapshot(docroot), before);
    } finally {
      server.close();
    }
  });

  test("restores the exact previous tree when rsync fails part-way", async () => {
    const { docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const env = await shim("rsync", [
      'if [[ " $* " == *--include=/index.html* ]]; then',
      '  echo "rsync error: some files/attrs were not transferred (code 23)" >&2',
      "  exit 23",
      "fi",
      `exec ${q(realRsync)} "$@"`,
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
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
    const { parent, docroot, backups } = await makeSite();
    const before = await snapshot(docroot);
    const marker = join(parent, "planted");
    const env = await shim("rsync", [
      `${q(realRsync)} "$@"`,
      "rc=$?",
      `if [[ " $* " == *" --delete "* && ! -e ${q(marker)} ]]; then`,
      `  echo rogue > ${q(join(docroot, "rogue.txt"))}`,
      `  : > ${q(marker)}`,
      "fi",
      "exit $rc",
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.equal(result.code, 6, result.output);
    assert.match(result.output, /installed files: the file set differs from the manifest:\n\s+extra: rogue\.txt/);
    assert.match(result.output, /rollback complete/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.equal((await entries(backups)).length, 1);
  });

  test("never changes a file hard-linked into the docroot during the install", async () => {
    // The link appears after the preflight checks; the installer writes every file anew
    // instead of changing the mode of the one it finds.
    const { parent, docroot } = await makeSite();
    const outside = join(parent, "outside-secret");
    await writeFile(outside, LOGO, { mode: 0o600 });
    const marker = join(parent, "linked");
    const env = await shim("rsync", [
      `${q(realRsync)} "$@"`,
      "rc=$?",
      `if [[ " $* " == *--exclude=/index.html* && ! -e ${q(marker)} ]]; then`,
      `  ln -f ${q(outside)} ${q(join(docroot, "img", "logo.svg"))}`,
      `  : > ${q(marker)}`,
      "fi",
      "exit $rc",
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.ok(existsSync(marker), "the link was planted");
    assert.equal(result.code, 0, result.output);
    const info = await stat(outside);
    assert.equal(info.mode & 0o7777, 0o600, "the outside file keeps its mode");
    assert.equal(info.nlink, 1, "the docroot no longer shares the outside file");
    assert.equal(await readFile(outside, "utf8"), LOGO);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
  });

  test("refuses to restore a backup that changed after it was taken (exit 7)", async () => {
    const { parent, docroot, backups } = await makeSite();
    const marker = join(parent, "planted");
    const env = await shim("rsync", [
      `${q(realRsync)} "$@"`,
      "rc=$?",
      // During the install, rewrite the backup's index.html, then make the post-install check fail.
      'if [[ " $* " == *--exclude=/index.html* ]]; then',
      `  for f in ${q(backups)}/*/docroot/index.html; do printf tampered > "$f"; done`,
      "fi",
      `if [[ " $* " == *" --delete "* && ! -e ${q(marker)} ]]; then`,
      `  echo rogue > ${q(join(docroot, "rogue.txt"))}`,
      `  : > ${q(marker)}`,
      "fi",
      "exit $rc",
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.equal(result.code, 7, result.output);
    assert.match(result.output, /ROLLBACK REFUSED: the backup in .* changed after it was taken/);
    assert.notEqual(
      await readFile(join(docroot, "index.html"), "utf8"),
      "tampered",
      "the tampered bytes were not installed",
    );
    assert.equal(await readFile(join(docroot, "index.html"), "utf8"), DIST[0]?.[1]);
  });
});

describe("install-release: resolved paths (exit 4, nothing changed)", () => {
  test("refuses --docroot . from a working directory whose name ends in a newline", async () => {
    // $(realpath .) would drop the newline and name the sibling "www".
    const parent = join(scratch, `cwd-newline-${siteCount++}`);
    const www = join(parent, "www");
    await mkdir(www, { recursive: true });
    await writeFile(join(www, "index.html"), "the sibling site");
    await mkdir(join(parent, "www\n"));
    const before = await snapshot(www);
    const result = await install(["--version", VERSION, "--docroot", ".", "--from-dir", releaseDir], {}, `${www}\n`);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /the docroot resolves to \$'.*\/www\\n', which contains a control character/);
    assert.deepEqual(await snapshot(www), before);
    assert.deepEqual(await entries(join(parent, "www\n")), []);
    assert.deepEqual(await entries(parent), ["www", "www\n"]);
  });

  test("refuses backup, staging and TMPDIR paths whose symbolic links resolve to a name with a control character", async () => {
    const { parent, docroot } = await makeSite();
    const before = await snapshot(docroot);
    // Siblings the stripped names would select, each private so they would otherwise pass.
    for (const name of ["victim", "stage", "tmp"]) {
      await mkdir(join(parent, name), { mode: 0o700 });
      await mkdir(join(parent, `${name}\n`), { mode: 0o700 });
      await writeFile(join(parent, name, "keep.txt"), name);
      await symlink(join(parent, `${name}\n`), join(parent, `${name}-link`));
    }
    const snapshots = async () =>
      Promise.all(["victim", "stage", "tmp", "victim\n", "stage\n", "tmp\n"].map((n) => snapshot(join(parent, n))));
    const siblings = await snapshots();
    for (const [args, env, label] of [
      [["--backup-dir", join(parent, "victim-link")], {}, "backup directory"],
      [["--staging-dir", join(parent, "stage-link")], {}, "staging directory"],
      [["--dry-run"], { TMPDIR: join(parent, "tmp-link") }, "TMPDIR"],
    ] as const) {
      const result = await install(
        ["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir, ...args],
        env,
      );
      assert.equal(result.code, 4, `${label}: ${result.output}`);
      assert.match(result.output, new RegExp(`the ${label} resolves to .*control character`));
    }
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await snapshots(), siblings);
  });
});

describe("install-release: private backups (exit 4 when refused)", () => {
  test("refuses an existing backup directory that is not mode 0700", async () => {
    const { docroot, backups } = await makeSite();
    await mkdir(backups, { mode: 0o755 });
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /the backup directory .* has mode 755; it must be 0700/);
    assert.deepEqual(await snapshot(docroot), before);
    assert.deepEqual(await entries(backups), []);
  });

  test("refuses a backup directory whose parent does not exist, rather than creating it", async () => {
    const { docroot } = await makeSite();
    const missing = join(scratch, `missing-${siteCount}`);
    const result = await install([
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
      "--backup-dir",
      join(missing, "backups"),
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /the backup directory's parent .* does not exist/);
    assert.equal(existsSync(missing), false);
  });

  test("a permissive default ACL on the parent cannot produce a backup directory other than 0700", async () => {
    const { parent, docroot, backups } = await makeSite();
    // Everything created in the parent would get rwx for owner, group and others, whatever the umask.
    await setDefaultAcl(parent, [
      [ACL.userObj, 7, UNNAMED],
      [ACL.groupObj, 7, UNNAMED],
      [ACL.other, 7, UNNAMED],
    ]);
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    if (await hasTool("setfacl")) {
      // The installer strips the inherited ACL and goes ahead.
      assert.equal(result.code, 0, result.output);
      assert.equal((await stat(backups)).mode & 0o7777, 0o700);
      assert.equal(await hasDefaultAcl(backups), false);
      assert.equal((await stat(reportedBackup(result.output))).mode & 0o7777, 0o700);
    } else {
      // Without setfacl it cannot strip the ACL, so it refuses and removes what it made.
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /would inherit ACL entries from the default ACL of .*setfacl -k/);
      assert.equal(existsSync(backups), false);
      assert.deepEqual(await snapshot(docroot), before);
    }
  });

  test("refuses an existing backup directory with a default ACL", async () => {
    const { docroot, backups } = await makeSite();
    await mkdir(backups, { mode: 0o700 });
    await setDefaultAcl(backups, [
      [ACL.userObj, 7, UNNAMED],
      [ACL.groupObj, 5, UNNAMED],
      [ACL.other, 5, UNNAMED],
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /the backup directory .* has (a default ACL|ACL entries)/);
    assert.deepEqual(await entries(backups), []);
  });
});

describe("install-release: bind mounts and mounts inside the docroot (exit 4, nothing written)", () => {
  // Each case runs in its own user and mount namespace, where bind mounts need no privilege.
  // `alias` is a bind mount of the docroot; `env` is exported before the installer runs.
  interface AliasCase {
    readonly args: readonly string[];
    readonly env?: string;
  }
  const cases: ReadonlyArray<readonly [string, (alias: string) => AliasCase, RegExp]> = [
    [
      "a dry run whose TMPDIR reaches the docroot through a bind mount",
      (alias) => ({ args: ["--dry-run"], env: `TMPDIR=${q(join(alias, "assets"))}` }),
      /the TMPDIR .* is inside the docroot: .*alias is the docroot under another name/,
    ],
    [
      "a staging directory reached through a bind mount of the docroot",
      (alias) => ({ args: ["--staging-dir", join(alias, "assets")] }),
      /the staging directory .* is inside the docroot: .*alias is the docroot under another name/,
    ],
    [
      "a backup directory reached through a bind mount of the docroot",
      (alias) => ({ args: ["--backup-dir", join(alias, "backups")] }),
      /the backup directory .* is inside the docroot: .*alias is the docroot under another name/,
    ],
  ];

  for (const [label, build, expected] of cases) {
    test(`refuses ${label}`, async (t) => {
      if (!(await canUnshare())) return t.skip("needs unprivileged user and mount namespaces");
      const { parent, docroot } = await makeSite();
      const alias = join(parent, "alias");
      await mkdir(alias);
      const before = [await snapshot(docroot), await ctimes(docroot)];
      const { args, env } = build(alias);
      const setup = [`mount --bind ${q(docroot)} ${q(alias)} || exit 99`, env ? `export ${env}` : ""].join("\n");
      const result = await installInNamespace(setup, [
        "--version",
        VERSION,
        "--docroot",
        docroot,
        "--from-dir",
        releaseDir,
        ...args,
      ]);
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, expected);
      assert.deepEqual([await snapshot(docroot), await ctimes(docroot)], before, "nothing in the docroot changed");
      assert.deepEqual(await entries(alias), []);
    });
  }

  test("refuses an outside directory mounted inside the docroot, including a name mountinfo escapes", async (t) => {
    if (!(await canUnshare())) return t.skip("needs unprivileged user and mount namespaces");
    const { parent, docroot } = await makeSite();
    const outside = join(parent, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "not part of the site");
    // "my assets" appears in mountinfo as my\040assets.
    await mkdir(join(docroot, "my assets"));
    const before = [await snapshot(docroot), await snapshot(outside)];
    const result = await installInNamespace(`mount --bind ${q(outside)} ${q(join(docroot, "my assets"))} || exit 99`, [
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /\/htdocs\/my assets is a mount point inside the docroot/);
    assert.deepEqual([await snapshot(docroot), await snapshot(outside)], before);
    assert.deepEqual(await entries(parent), ["htdocs", "outside"], "no staging or backup directory was created");
  });
});

describe("install-release: trust and writers", () => {
  test("never trusts the overflow UID implicitly inside a user namespace", async (t) => {
    if (!(await canUnshare(["-r"]))) return t.skip("needs unprivileged user namespaces");
    const { docroot } = await makeSite();
    const before = await snapshot(docroot);
    const result = await runScript("unshare", [
      "-r",
      bash,
      SCRIPT,
      "--version",
      VERSION,
      "--docroot",
      docroot,
      "--from-dir",
      releaseDir,
    ]);
    assert.equal(result.code, 4, result.output);
    assert.match(
      result.output,
      new RegExp(`is owned by uid ${OVERFLOW_UID}; only root, uid 0, .* or a --trust-owner UID`),
    );
    assert.deepEqual(await snapshot(docroot), before);
  });

  test("refuses a docroot with a directory group or others can write", async () => {
    const { docroot, backups } = await makeSite();
    for (const [dir, mode] of [
      [join(docroot, "old-dir"), 0o775],
      [docroot, 0o757],
    ] as const) {
      const site = (await stat(dir)).mode & 0o7777;
      await chmod(dir, mode);
      const before = await snapshot(docroot);
      const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /directories (group or others|users other than root) can write to\. A web server/);
      assert.match(result.output, new RegExp(`\\(mode 0${mode.toString(8)}, `));
      assert.deepEqual(await snapshot(docroot), before);
      await chmod(dir, site);
    }
    assert.deepEqual(await entries(backups), []);
  });

  test("running as root, refuses a docroot directory owned by another user unless it is the --owner user", async (t) => {
    const flags = ["-r", "--map-auto"];
    if (!(await canUnshare(flags)))
      return t.skip("needs a user namespace with subordinate IDs (newuidmap, /etc/subuid)");
    // Inside the namespace uid 65534 ("nobody") is a real, mapped user. The files it ends up
    // owning belong to a subordinate ID outside, so the site is removed from inside as well.
    const { parent, docroot } = await makeSite();
    const installCommand = (extra: string) =>
      `${q(bash)} ${q(SCRIPT)} --trust-owner ${OVERFLOW_UID} --version ${VERSION} --docroot ${q(docroot)} --from-dir ${q(releaseDir)} ${extra}; echo "exit=$?"`;
    const result = await runScript("unshare", [
      ...flags,
      bash,
      "-c",
      [
        `chown -R 65534 ${q(join(docroot, "old-dir"))} || exit 99`,
        installCommand(""),
        installCommand("--owner nobody"),
        `stat -c 'owner=%u' ${q(join(docroot, "index.html"))}`,
        `rm -rf ${q(parent)}`,
      ].join("\n"),
    ]);
    const exits = [...result.output.matchAll(/^exit=(\d+)$/gm)].map((m) => m[1]);
    assert.deepEqual(exits, ["4", "0"], result.output);
    assert.match(
      result.output,
      /directories users other than root can write to[\s\S]*old-dir \(mode 0755, owner nobody\)/,
    );
    assert.match(result.output, /^owner=65534$/m);
  });

  test("refuses a docroot directory whose default ACL lets another group write", async (t) => {
    if (!(await hasTool("getfacl")))
      return t.skip("getfacl (acl) is not installed; mode bits alone cannot show a default ACL");
    const { docroot } = await makeSite();
    const gid = process.getgid?.() as number;
    await setDefaultAcl(join(docroot, "assets"), [
      [ACL.userObj, 7, UNNAMED],
      [ACL.groupObj, 5, UNNAMED],
      [ACL.group, 7, gid],
      [ACL.mask, 7, UNNAMED],
      [ACL.other, 5, UNNAMED],
    ]);
    const before = await snapshot(docroot);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir]);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /can write to[\s\S]*assets \(ACL default:group:/);
    assert.deepEqual(await snapshot(docroot), before);
  });

  test("running as root, installs read-only modes 0555 and 0444", async (t) => {
    if (!(await canUnshare(["-r"]))) return t.skip("needs unprivileged user namespaces");
    const { docroot } = await makeSite();
    try {
      const result = await installInNamespace(
        "",
        [
          "--version",
          VERSION,
          "--docroot",
          docroot,
          "--from-dir",
          releaseDir,
          "--dir-mode",
          "0555",
          "--file-mode",
          "0444",
        ],
        ["-r"],
      );
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(await snapshot(docroot), expectedSnapshot("444", "555"));
    } finally {
      await run("chmod", ["-R", "u+w", docroot]);
    }
  });
});

describe("install-release: rotation that cannot list the backups (exit 0, with a warning)", () => {
  test("warns when the backups cannot be listed, and keeps the verified install", async () => {
    const { docroot, backups } = await makeSite();
    const realFind = (await run("bash", ["-c", "command -v find"])).stdout.trim();
    const env = await shim("find", [
      'if [[ " $* " == *" -regextype "* ]]; then',
      `  echo "find: '${backups}': Input/output error" >&2`,
      "  exit 1",
      "fi",
      `exec ${q(realFind)} "$@"`,
    ]);
    const result = await install(["--version", VERSION, "--docroot", docroot, "--from-dir", releaseDir], env);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /could not list the backups in /);
    assert.match(result.output, /backup rotation did not finish .* the install itself succeeded/);
    assert.deepEqual(await snapshot(docroot), expectedSnapshot());
    assert.equal((await entries(backups)).length, 1);
  });
});
