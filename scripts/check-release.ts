import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { scanText } from "./lib/attribution-scan.ts";
import { type CIRun, releaseVersion, requireSuccessfulCI } from "./lib/release.ts";

const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" });
const tag = process.env.GITHUB_REF_NAME ?? "";
const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
releaseVersion(tag, version);
if (run("git", ["cat-file", "-t", `refs/tags/${tag}`]).trim() === "tag") {
  const findings = scanText("annotated tag", run("git", ["cat-file", "tag", `refs/tags/${tag}`]));
  if (findings.length) throw new Error(findings.join("\n"));
}
const commit = run("git", ["rev-parse", "HEAD^{commit}"]).trim();
run("git", ["merge-base", "--is-ancestor", commit, "origin/main"]);
const repository = process.env.GITHUB_REPOSITORY ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository");
const pages = JSON.parse(
  run("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&branch=main&event=push&per_page=100`,
  ]),
) as { workflow_runs: CIRun[] }[];
requireSuccessfulCI(
  pages.flatMap((page) => page.workflow_runs),
  commit,
);
if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT");
await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ncommit=${commit}\n`);
