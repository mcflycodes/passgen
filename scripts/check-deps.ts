// Dependency rules (decision 0001, threat model T4):
// - no runtime dependencies: the shipped page contains only code from this repo;
// - every dev dependency pinned to an exact version;
// - the pnpm supply-chain settings stay in place.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
const workspace = await readFile(join(ROOT, "pnpm-workspace.yaml"), "utf8");
const problems: string[] = [];

for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]) {
  const deps = pkg[field];
  if (deps !== undefined && (typeof deps !== "object" || deps === null || Object.keys(deps).length > 0)) {
    problems.push(`package.json "${field}" must be absent: the page has no runtime dependencies`);
  }
}

const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
for (const [name, version] of Object.entries(dev)) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`devDependency ${name} must be an exact version, not "${version}"`);
  }
}

const required: ReadonlyArray<readonly [string, RegExp]> = [
  ["saveExact: true", /^saveExact:\s*true\s*$/m],
  ["engineStrict: true", /^engineStrict:\s*true\s*$/m],
  ["minimumReleaseAge of at least 10080 minutes (7 days)", /^minimumReleaseAge:\s*(\d+)\s*$/m],
  ["ignoreScripts: true", /^ignoreScripts:\s*true\s*$/m],
  ["onlyBuiltDependencies: []", /^onlyBuiltDependencies:\s*\[\]\s*$/m],
  ["verifyDepsBeforeRun: error", /^verifyDepsBeforeRun:\s*error\s*$/m],
];
for (const [label, pattern] of required) {
  const match = pattern.exec(workspace);
  if (match === null || (match[1] !== undefined && Number(match[1]) < 10080)) {
    problems.push(`pnpm-workspace.yaml must set ${label}`);
  }
}

if (typeof pkg.packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+\+sha512\./.test(pkg.packageManager)) {
  problems.push('package.json "packageManager" must pin pnpm to an exact version with its sha512 hash');
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `No runtime dependencies; ${Object.keys(dev).length} dev dependencies, all exact; pnpm supply-chain settings in place.`,
);
