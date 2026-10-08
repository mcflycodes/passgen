import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWordlist, wordlistModule } from "./lib/wordlist.ts";

const root = join(import.meta.dirname, "..");
if (process.argv.includes("--check")) checkWordlist(root);
else writeFileSync(join(root, "src/core/wordlist.ts"), wordlistModule(root));
