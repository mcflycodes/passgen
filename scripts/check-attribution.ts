// Enforces the no-attribution rule (see scripts/lib/attribution-patterns.ts).
// Scans every tracked or new (not ignored) file, and the messages and identities of commits in the
// range being checked. In CI it also scans the pull request title and body.
//
// Environment:
//   ATTRIBUTION_RANGE  git revision range to scan, default "origin/main..HEAD"
//   PR_TITLE, PR_BODY  pull request text, set by CI

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PATTERNS_FILE } from "./lib/attribution-patterns.ts";
import { scanText } from "./lib/attribution-scan.ts";
import { sourceAttributionInput } from "./lib/wordlist-attribution.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const findings: string[] = [];
const scan = (where: string, text: string) => findings.push(...scanText(where, text));

const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
  .split("\0")
  .filter((f) => f !== "" && f !== PATTERNS_FILE);
for (const file of files) {
  const buf = await readFile(file).catch(() => null);
  if (buf === null || buf.includes(0)) continue; // deleted in the working tree, or binary
  const text = buf.toString("utf8");
  try {
    scan(file, sourceAttributionInput(process.cwd(), file, text));
  } catch (error) {
    findings.push(`${file}: ${(error as Error).message}`);
    scan(file, text); // Integrity failure never opens an exemption.
  }
}
scan("file names", files.join("\n"));

const range = process.env.ATTRIBUTION_RANGE ?? "origin/main..HEAD";
let commits = 0;
try {
  const log = git("log", "--format=%H%x00%an <%ae>%n%cn <%ce>%n%B%x00%x00", range);
  for (const entry of log
    .split("\0\0")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [sha = "", body = ""] = entry.split("\0");
    scan(`commit ${sha.slice(0, 12)}`, body);
    commits += 1;
  }
} catch {
  console.error(`Could not read commits in ${range}; is the base branch fetched?`);
  process.exit(1);
}

if (process.env.PR_TITLE !== undefined) scan("PR title", process.env.PR_TITLE);
if (process.env.PR_BODY !== undefined) scan("PR body", process.env.PR_BODY);

if (findings.length > 0) {
  console.error("Attribution to a tool, model or vendor is not allowed:");
  console.error(findings.join("\n"));
  process.exit(1);
}
const pr = process.env.PR_TITLE !== undefined ? ", PR title and body" : "";
console.log(`No attribution in ${files.length} tracked files, ${commits} commits (${range})${pr}.`);
