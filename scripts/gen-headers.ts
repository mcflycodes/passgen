// Writes deploy/examples/ and deploy/container/ from security/headers.ts.
// `--check` writes nothing and fails if the committed files differ from the definition.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { renderContainerConfigs } from "./lib/site-configs.ts";
import { renderSnippets } from "./lib/snippets.ts";

const DEPLOY = join(import.meta.dirname, "..", "deploy");
const check = process.argv.includes("--check");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"));
}

const outputs: [string, Map<string, string>][] = [
  ["examples", renderSnippets()],
  ["container", renderContainerConfigs()],
];
const problems: string[] = [];
let written = 0;

for (const [folder, expected] of outputs) {
  const outDir = join(DEPLOY, folder);
  for (const [file, content] of expected) {
    const path = join(outDir, file);
    if (check) {
      const actual = await readFile(path, "utf8").catch(() => null);
      if (actual === null) problems.push(`missing: deploy/${folder}/${file}`);
      else if (actual !== content) problems.push(`out of date: deploy/${folder}/${file}`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      written++;
    }
  }
  for (const file of await listFiles(outDir)) {
    if (!expected.has(file))
      problems.push(`not generated (remove it or add it to the generator): deploy/${folder}/${file}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(check ? "Run `pnpm headers:gen` and commit the result." : "");
  process.exit(1);
}
console.log(
  check
    ? "deploy/examples/ and deploy/container/ match security/headers.ts."
    : `Wrote ${written} files to deploy/examples/ and deploy/container/.`,
);
