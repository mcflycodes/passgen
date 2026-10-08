// Writes a SHA-256 manifest of dist/ to dist-manifest/SHA256SUMS (requirement S7).
// The format is the one `sha256sum` reads, so anyone can check a deployment with
// `sha256sum -c SHA256SUMS` run inside the served folder.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listRegularFiles } from "./lib/walk.ts";

const ROOT = join(import.meta.dirname, "..");
const { values } = parseArgs({ options: { dir: { type: "string" }, out: { type: "string" } } });
const DIST = resolve(values.dir ?? join(ROOT, "dist"));
const OUT = resolve(values.out ?? join(ROOT, "dist-manifest"));

let files: string[];
try {
  files = await listRegularFiles(DIST);
} catch (err) {
  console.error(`${DIST}: ${(err as Error).message}`);
  console.error("No manifest written.");
  process.exit(1);
}

const lines: string[] = [];
for (const file of files) {
  const hash = createHash("sha256")
    .update(await readFile(join(DIST, file)))
    .digest("hex");
  lines.push(`${hash}  ${file}`);
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`${join(OUT, "SHA256SUMS")}: ${files.length} files.`);
