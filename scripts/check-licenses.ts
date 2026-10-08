// Fails if any installed package has a license outside the allow list.
// Every package here is a dev dependency (scripts/check-deps.ts enforces that),
// so nothing below ships in the page; the list still keeps the toolchain to
// licenses compatible with an Apache-2.0 project.

import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "Apache-2.0 OR MIT",
  // axe-core and lightningcss (a Vite dependency): file-level copyleft, used
  // unmodified as test and build tools, never shipped in the page.
  "MPL-2.0",
]);

interface LicensedPackage {
  readonly name: string;
  readonly versions: readonly string[];
}

const output = execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" });
const byLicense = JSON.parse(output) as Record<string, LicensedPackage[]>;

let count = 0;
const problems: string[] = [];
for (const [license, packages] of Object.entries(byLicense)) {
  count += packages.length;
  if (!ALLOWED.has(license)) {
    for (const p of packages) problems.push(`${p.name}@${p.versions.join(",")}: ${license}`);
  }
}

if (problems.length > 0) {
  console.error("Packages with licenses outside the allow list:");
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${count} packages, all with allowed licenses.`);
