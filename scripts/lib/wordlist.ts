import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseWordlist(raw: string): { words: string[]; excluded: string[]; min: number; max: number } {
  const lines = raw.trimEnd().split("\n");
  if (lines.length !== 7776) throw new Error("Wordlist requires 7776 raw entries");
  const dice = new Set<string>();
  const words: string[] = [];
  const excluded: string[] = [];
  for (const line of lines) {
    const match = /^([1-6]{5})\t([^\s]+)$/.exec(line);
    if (!match || dice.has(match[1] as string)) throw new Error("Invalid or duplicate wordlist dice code");
    dice.add(match[1] as string);
    const word = match[2] as string;
    if (word.includes("-")) excluded.push(word);
    else {
      if (!/^[a-z]+$/.test(word)) throw new Error("Wordlist requires lowercase a-z words");
      words.push(word);
    }
  }
  if (excluded.length !== 4) throw new Error("Wordlist requires exactly four hyphenated entries");
  if (words.length !== 7772 || new Set(words).size !== words.length)
    throw new Error("Invalid wordlist count or duplicate words");
  const min = Math.min(...words.map((word) => word.length));
  const max = Math.max(...words.map((word) => word.length));
  if (min !== 3 || max !== 9) throw new Error("Wordlist length range must be 3–9");
  return { words, excluded, min, max };
}

export const WORDLIST_SHA256 = "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e";
export const WORDLIST_PATH = "vendor/eff_large_wordlist.txt";
export const WORDLIST_MODULE_PATH = "src/core/wordlist.ts";

export function verifiedWordlist(root: string): ReturnType<typeof parseWordlist> & { raw: string } {
  const dir = join(root, "vendor");
  const raw = readFileSync(join(dir, "eff_large_wordlist.txt"));
  const checksum = readFileSync(join(dir, "eff_large_wordlist.sha256"), "utf8");
  if (!/^[a-f0-9]{64} {2}eff_large_wordlist\.txt\n$/.test(checksum)) throw new Error("Invalid wordlist checksum file");
  if (checksum.slice(0, 64) !== WORDLIST_SHA256 || createHash("sha256").update(raw).digest("hex") !== WORDLIST_SHA256)
    throw new Error("Wordlist SHA-256 mismatch");
  return { ...parseWordlist(raw.toString("utf8")), raw: raw.toString("utf8") };
}

export function wordlistModule(root: string): string {
  const { words, min, max } = verifiedWordlist(root);
  return `// EFF Large Wordlist; license and modifications are described in NOTICE.\nexport const MIN_WORD_LENGTH = ${min};\nexport const MAX_WORD_LENGTH = ${max};\nexport const WORDS: readonly string[] = Object.freeze(\n  "${words.join(" ")}".split(\n    " ",\n  ),\n);\n`;
}

export function checkWordlist(root: string): void {
  if (readFileSync(join(root, "src/core/wordlist.ts"), "utf8") !== wordlistModule(root))
    throw new Error("Wordlist module differs from the verified vendored file; run pnpm wordlist:gen");
}
