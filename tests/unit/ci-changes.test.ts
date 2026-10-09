import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCodePath } from "../../scripts/lib/ci-changes.ts";

test("only known documentation paths can skip browser and server jobs", () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "LICENSE.txt",
    "LICENSE.md",
    "NOTICE.md",
    "NOTICE.txt",
    "notes.md",
    "docs/releasing.md",
    "agent-setup/example.json",
  ])
    assert.equal(isCodePath(path), false, path);
  for (const path of [
    "src/styles/README.md",
    "scripts/README.md",
    "tests/fixtures/example.md",
    "deploy/README.md",
    "security/headers.ts",
    "config/example.md",
    ".github/workflows/ci.yml",
    ".github/README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "playwright.config.ts",
    "vite.config.ts",
    ".nvmrc",
    "index.html",
    "public/NOTICE",
    "public/README.md",
    "unknown/file.md",
    "unknown.txt",
    "notice.ts",
    "License.mjs",
    "changelog.config.js",
    "LICENSE.js",
    "NOTICE.json",
    "CHANGELOG",
    "CHANGELOG.txt",
    "LICENSE.TXT",
    "NOTICE.MD",
    "README.MD",
    "license",
    "notice",
  ])
    assert.equal(isCodePath(path), true, path);
});

const script = new URL("../../scripts/ci-changes.ts", import.meta.url);
const zeroBase = "0".repeat(40);

type Repo = {
  dir: string;
  base: string;
  commit: () => string;
  run: (base: string, scriptURL?: URL) => Promise<string>;
};

async function withRepo(check: (repo: Repo) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "passgen-ci-changes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  const commit = () => {
    git("add", "--all");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  try {
    git("init", "--quiet");
    // Require rename detection so removing --no-renames cannot accidentally pass.
    git("config", "diff.renames", "true");
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "src/x.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "README.md"), "# Fixture\n");
    const base = commit();
    const output = join(dir, "output");
    const run: Repo["run"] = async (changeBase, scriptURL = script) => {
      await rm(output, { force: true });
      execFileSync(process.execPath, [fileURLToPath(scriptURL)], {
        cwd: dir,
        env: {
          ...process.env,
          CHANGE_BASE: changeBase,
          CHANGE_HEAD: git("rev-parse", "HEAD").trim(),
          GITHUB_OUTPUT: output,
        },
        stdio: "pipe",
      });
      return readFile(output, "utf8");
    };
    await check({ dir, base, commit, run });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mutantScript(dir: string, remove: string): Promise<URL> {
  const source = await readFile(script, "utf8");
  const mutated = source.replace(remove, "");
  assert.notEqual(mutated, source, "Mutation must change the script");
  const url = pathToFileURL(join(dir, "mutant.ts"));
  // Keep imports bound to the real classifier while executing the mutated CLI.
  await writeFile(
    url,
    mutated.replace(
      '"./lib/ci-changes.ts"',
      JSON.stringify(new URL("../../scripts/lib/ci-changes.ts", import.meta.url).href),
    ),
  );
  return url;
}

test("change script counts a source-to-docs rename as code and rejects removing --no-renames", async () => {
  await withRepo(async ({ dir, base, commit, run }) => {
    await rename(join(dir, "src/x.ts"), join(dir, "docs/x.ts"));
    commit();
    assert.equal(await run(base), "code=true\n");
    const mutant = await mutantScript(dir, '"--no-renames", ');
    const result = await run(base, mutant);
    assert.equal(result, "code=false\n", "Rename detection hides the deleted source path");
    assert.throws(() => assert.equal(result, "code=true\n"), { code: "ERR_ASSERTION" });
  });
});

test("change script counts deletion of source as code", async () => {
  await withRepo(async ({ dir, base, commit, run }) => {
    await rm(join(dir, "src/x.ts"));
    commit();
    assert.equal(await run(base), "code=true\n");
  });
});

test("change script reports docs-only commits as no code changes", async () => {
  await withRepo(async ({ dir, base, commit, run }) => {
    await writeFile(join(dir, "docs/guide.md"), "# Guide\n");
    await writeFile(join(dir, "README.md"), "# Updated fixture\n");
    commit();
    assert.equal(await run(base), "code=false\n");
  });
});

test("change script treats an all-zeros base as code and rejects removing the zero-base check", async () => {
  await withRepo(async ({ dir, run }) => {
    assert.equal(await run(zeroBase), "code=true\n");
    const mutant = await mutantScript(dir, "  /^0{40}$/.test(base) ||\n");
    await assert.rejects(run(zeroBase, mutant), /Command failed/);
  });
});

test("change script fails closed when the base commit is missing", async () => {
  await withRepo(async ({ dir, run }) => {
    await assert.rejects(run("f".repeat(40)), /Command failed/);
    await assert.rejects(readFile(join(dir, "output")), { code: "ENOENT" });
  });
});
