import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";
import { scanText } from "../../scripts/lib/attribution-scan.ts";
import { type CIRun, releaseNotes, releaseVersion, requireSuccessfulCI } from "../../scripts/lib/release.ts";

const root = resolve(import.meta.dirname, "../..");

test("release tag must be stable and match the package version", () => {
  assert.equal(releaseVersion("v1.0.0", "1.0.0"), "1.0.0");
  for (const tag of ["1.0.0", "v1.0", "v1.0.0-rc.1", "v1.0.0\n", "v1.0.0; touch x", "v2.0.0"]) {
    assert.throws(() => releaseVersion(tag, "1.0.0"));
  }
  for (const version of ["1.0", "1.0.0-rc.1", "1.0.0\n", "1.0.0; touch x"]) {
    assert.throws(() => releaseVersion(`v${version}`, version));
  }
});

test("release requires completed successful push CI on the exact main commit", () => {
  const valid: CIRun = {
    head_sha: "abc",
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  requireSuccessfulCI([valid], "abc");
  for (const change of [
    { head_sha: "def" },
    { head_branch: "work/topic" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: null },
  ])
    assert.throws(() => requireSuccessfulCI([{ ...valid, ...change }], "abc"));
  assert.throws(() => requireSuccessfulCI([], "abc"));
});

test("release notes select only the matching section including nested headings", () => {
  const log =
    "# Changelog\n\n## [Unreleased]\n\nFuture\n\n## [1.0.0] - 2026-10-09\n\n### Added\n\n- First release.\n\n## [0.9.0]\n\nOld\n";
  assert.equal(releaseNotes(log, "1.0.0"), "### Added\n\n- First release.\n");
  assert.equal(releaseNotes(log.replace(" - 2026-10-09", ""), "1.0.0"), "### Added\n\n- First release.\n");
});

test("release notes fail for missing, empty or duplicate sections", () => {
  for (const log of ["## [Unreleased]\n", "## [1.0.0]\n\n## [0.9.0]\nOld", "## [1.0.0]\nOne\n## [1.0.0]\nTwo"]) {
    assert.throws(() => releaseNotes(log, "1.0.0"));
  }
});

test("the initial release notes pass the existing credit scanner", async () => {
  const notes = releaseNotes(await readFile(join(root, "CHANGELOG.md"), "utf8"), "1.0.0");
  assert.deepEqual(scanText("release notes", notes), []);
  assert.match(await readFile(join(root, "scripts/release-notes.ts"), "utf8"), /scanText\("release notes", notes\)/);
});

test("two production builds package identically despite changed mtimes and permissions", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "passgen-release-"));
  try {
    const hashes: string[] = [];
    for (const name of ["first", "second"]) {
      execFileSync("pnpm", ["build", "--outDir", join(scratch, name)], { cwd: root, stdio: "pipe" });
      const archive = join(scratch, name, "..", `${name}-zip`, "passgen-1.0.0.zip");
      const code = `import importlib.util, pathlib, os, zipfile
spec = importlib.util.spec_from_file_location('pack', ${JSON.stringify(join(root, "scripts/package-release.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
dist = pathlib.Path(${JSON.stringify(join(scratch, name))})
for path in dist.rglob('*'):
    if path.is_file():
        os.utime(path, (${name === "first" ? "1000000000" : "1700000000"},) * 2)
        path.chmod(${name === "first" ? "0o600" : "0o755"})
archive = module.package(dist, pathlib.Path(${JSON.stringify(join(scratch, `${name}-zip`))}), '1.0.0')
with zipfile.ZipFile(archive) as zipped:
    assert zipped.namelist() == sorted(zipped.namelist())
    assert 'index.html' in zipped.namelist()
    assert all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in zipped.infolist())
    assert all(i.external_attr >> 16 == 0o100644 for i in zipped.infolist())
    zipped.extractall(pathlib.Path(${JSON.stringify(join(scratch, `${name}-extracted`))}))
`;
      execFileSync("python3", ["-B", "-c", code], { cwd: root });
      const digest = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
      hashes.push(digest);
      assert.equal(await readFile(`${archive}.sha256`, "utf8"), `${digest}  passgen-1.0.0.zip\n`);
      execFileSync(
        process.execPath,
        ["scripts/manifest.ts", "--dir", join(scratch, name), "--out", join(scratch, `${name}-manifest`)],
        { cwd: root },
      );
      execFileSync("sha256sum", ["-c", join(scratch, `${name}-manifest`, "SHA256SUMS")], {
        cwd: join(scratch, `${name}-extracted`),
      });
    }
    assert.equal(hashes[0], hashes[1]);
    await writeFile(join(scratch, "bad"), "x");
    const code = `import importlib.util, pathlib
spec = importlib.util.spec_from_file_location('pack', ${JSON.stringify(join(root, "scripts/package-release.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.package(pathlib.Path(${JSON.stringify(join(scratch, "bad"))}), pathlib.Path(${JSON.stringify(scratch)}), '1.0.0')`;
    assert.throws(() => execFileSync("python3", ["-B", "-c", code], { stdio: "pipe" }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release validation command rejects ancestry and API failures before producing outputs", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "passgen-release-check-"));
  try {
    await mkdir(join(scratch, "bin"));
    await writeFile(join(scratch, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(
      join(scratch, "bin/git"),
      '#!/bin/sh\ncase "$1" in\nrev-parse) echo abc ;;\nmerge-base) exit "$ANCESTRY_STATUS" ;;\n*) exit 7 ;;\nesac\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(scratch, "bin/gh"),
      '#!/bin/sh\n[ "$API_STATUS" = 0 ] || exit "$API_STATUS"\nprintf "%s" "$API_RESPONSE"\n',
      { mode: 0o755 },
    );
    const valid: CIRun = {
      head_sha: "abc",
      head_branch: "main",
      event: "push",
      status: "completed",
      conclusion: "success",
    };
    const env = {
      ...process.env,
      PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
      GITHUB_REF_NAME: "v1.0.0",
      GITHUB_REPOSITORY: "example/project",
      GITHUB_OUTPUT: join(scratch, "output"),
      ANCESTRY_STATUS: "0",
      API_STATUS: "0",
      API_RESPONSE: JSON.stringify([{ workflow_runs: [] }, { workflow_runs: [valid] }]),
    };
    const command = (changes: Record<string, string> = {}) =>
      execFileSync(process.execPath, [join(root, "scripts/check-release.ts")], {
        cwd: scratch,
        env: { ...env, ...changes },
        stdio: "pipe",
      });
    for (const changes of [
      { ANCESTRY_STATUS: "1" },
      { API_STATUS: "1" },
      { API_RESPONSE: "[]" },
      { GITHUB_REF_NAME: "v2.0.0" },
      { GITHUB_REF_NAME: "v1.0.0-beta" },
    ]) {
      assert.throws(() => command(changes));
      await assert.rejects(readFile(env.GITHUB_OUTPUT));
    }
    command();
    assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "version=1.0.0\ncommit=abc\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release notes command refuses prohibited credits before writing notes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "passgen-release-notes-"));
  try {
    await mkdir(join(scratch, "release"));
    await writeFile(join(scratch, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(join(scratch, "CHANGELOG.md"), `## [1.0.0]\nBuilt with ${EXAMPLE_TOOLS[0]}\n`);
    const command = () =>
      execFileSync(process.execPath, [join(root, "scripts/release-notes.ts")], { cwd: scratch, stdio: "pipe" });
    assert.throws(command);
    await assert.rejects(readFile(join(scratch, "release/notes.md")));
    await writeFile(join(scratch, "CHANGELOG.md"), "## [1.0.0]\n### Added\nFirst release.\n");
    command();
    assert.equal(await readFile(join(scratch, "release/notes.md"), "utf8"), "### Added\nFirst release.\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
