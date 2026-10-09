import { readFile, writeFile } from "node:fs/promises";
import { scanText } from "./lib/attribution-scan.ts";
import { releaseNotes } from "./lib/release.ts";

const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const notes = releaseNotes(await readFile("CHANGELOG.md", "utf8"), version);
const findings = scanText("release notes", notes);
if (findings.length) throw new Error(findings.join("\n"));
await writeFile("release/notes.md", notes);
