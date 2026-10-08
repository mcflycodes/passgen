// Writes deploy/examples/ from security/headers.ts.
// `--check` writes nothing and fails if the committed files differ from the definition.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { renderSnippets } from "./lib/snippets.ts";

const OUT_DIR = join(import.meta.dirname, "..", "deploy", "examples");
const check = process.argv.includes("--check");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(OUT_DIR, join(e.parentPath, e.name)).split("\\").join("/"));
}

const expected = renderSnippets();
const problems: string[] = [];

for (const [file, content] of expected) {
  const path = join(OUT_DIR, file);
  if (check) {
    const actual = await readFile(path, "utf8").catch(() => null);
    if (actual === null) problems.push(`missing: deploy/examples/${file}`);
    else if (actual !== content) problems.push(`out of date: deploy/examples/${file}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

for (const file of await listFiles(OUT_DIR)) {
  if (!expected.has(file))
    problems.push(`not generated (remove it or add it to the generator): deploy/examples/${file}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(check ? "Run `pnpm headers:gen` and commit the result." : "");
  process.exit(1);
}
console.log(
  check ? "deploy/examples/ matches security/headers.ts." : `Wrote ${expected.size} files to deploy/examples/.`,
);
