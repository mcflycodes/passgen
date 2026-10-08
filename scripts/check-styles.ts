// Runs the R4b style checks on the offered styles of src/config/config.json
// and fails if any style would fail the build. `pnpm styles:check`.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkStyles, styleSheet } from "./lib/style-checks.ts";

const { values } = parseArgs({ options: { root: { type: "string" } } });
const ROOT = resolve(values.root ?? join(import.meta.dirname, ".."));
const config = JSON.parse(readFileSync(join(ROOT, "src/config/config.json"), "utf8")) as {
  style: { default: string; offered: Array<{ id: string; label: string }> };
};

const problems = checkStyles(ROOT, config.style);
if (problems.length) {
  console.error("Style check failed (R4b):");
  for (const p of problems) console.error(`  ${styleSheet(p.style)}: ${p.problem}`);
  process.exit(1);
}
console.log(
  `styles: ${config.style.offered.map((s) => s.id).join(", ")} pass the R4b checks (default ${config.style.default}).`,
);
