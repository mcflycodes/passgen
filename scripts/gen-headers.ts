// Writes deploy/examples/, deploy/container/ and the Compose recipes' configuration
// folders under deploy/compose/ from security/headers.ts.
// `--check` writes nothing and fails if the committed files differ from the definition.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { renderComposeConfigs, renderContainerConfigs } from "./lib/site-configs.ts";
import { renderSnippets } from "./lib/snippets.ts";

const DEPLOY = join(import.meta.dirname, "..", "deploy");
const check = process.argv.includes("--check");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"));
}

const snippets = renderSnippets();
const outputs: [string, Map<string, string>][] = [
  ["examples", snippets],
  ["container", renderContainerConfigs()],
];
// Each recipe's configuration folder is generated in full; its compose.yaml is not.
for (const [file, content] of renderComposeConfigs(snippets)) {
  const folder = `compose/${dirname(file)}`;
  const name = file.slice(dirname(file).length + 1);
  let output = outputs.find(([existing]) => existing === folder);
  if (!output) {
    output = [folder, new Map()];
    outputs.push(output);
  }
  output[1].set(name, content);
}
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
  check ? "Generated files under deploy/ match security/headers.ts." : `Wrote ${written} files under deploy/.`,
);
