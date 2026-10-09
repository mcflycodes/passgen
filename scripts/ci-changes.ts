import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { isCodePath } from "./lib/ci-changes.ts";

const base = process.env.CHANGE_BASE ?? "";
const head = process.env.CHANGE_HEAD ?? "";
if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) throw new Error("Invalid change commit");
// A new branch has no base; conservatively run everything. NUL separators and
// disabled rename detection preserve unusual filenames and deleted code paths.
const code =
  /^0{40}$/.test(base) ||
  execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .some(isCodePath);
if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT");
await appendFile(process.env.GITHUB_OUTPUT, `code=${code}\n`);
