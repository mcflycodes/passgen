import assert from "node:assert/strict";
import { test } from "node:test";
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
  ])
    assert.equal(isCodePath(path), true, path);
});
