// Fails if the build output in dist/ breaks domain or host independence (decision 0005)
// or carries a missing or misplaced CSP <meta> tag (requirement H2).

import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkFile, type Finding, findProviderFiles } from "./lib/dist-checks.ts";
import { listRegularFiles } from "./lib/walk.ts";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const DIST = resolve(values.dir ?? join(import.meta.dirname, "..", "dist"));
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".webmanifest", ".xml", ".map"]);

let files: string[];
try {
  files = await listRegularFiles(DIST);
} catch (err) {
  console.error(`${DIST}: ${(err as Error).message}`);
  process.exit(1);
}

const findings: Finding[] = [...findProviderFiles(files)];
if (!files.includes("index.html")) findings.push({ file: "index.html", problem: "missing" });

for (const file of files) {
  const ext = extname(file).toLowerCase();
  if (!TEXT.has(ext)) {
    findings.push({
      file,
      problem: `unexpected file type ${ext || "(none)"}; add it to the text checks or the allow list`,
    });
    continue;
  }
  const text = await readFile(join(DIST, file), "utf8");
  findings.push(...checkFile(file, text));
}

if (findings.length > 0) {
  for (const f of findings) console.error(`${f.file}: ${f.problem}`);
  process.exit(1);
}
console.log(`dist/: ${files.length} files, no hostnames, no provider files, CSP <meta> in place.`);
