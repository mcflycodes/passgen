import { join } from "node:path";
import { checkHtmlSinks } from "./lib/html-sink-scan.ts";

const problems = await checkHtmlSinks(join(import.meta.dirname, "../src"));
if (problems.length) throw new Error(problems.join("\n"));
console.log("No HTML sinks in src/.");
