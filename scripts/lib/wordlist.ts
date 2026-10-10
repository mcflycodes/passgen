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
  if (
    JSON.stringify(Array.from({ length: 7 }, (_, i) => words.filter((word) => word.length === i + 3).length)) !==
    "[82,467,927,1372,1590,1778,1556]"
  )
    throw new Error("Wordlist length distribution mismatch");
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
  for (const spec of EXTRA_WORDLISTS) {
    if (readFileSync(join(root, spec.module), "utf8") !== extraWordlistModule(root, spec))
      throw new Error("Wordlist module differs from the verified vendored file; run pnpm wordlist:gen");
  }
  if (readFileSync(join(root, "src/core/wordlist.ts"), "utf8") !== wordlistModule(root))
    throw new Error("Wordlist module differs from the verified vendored file; run pnpm wordlist:gen");
}

export const EXTRA_WORDLISTS = [
  {
    id: "orchard-long",
    file: "vendor/orchard-street-long.txt",
    module: "src/core/wordlist-orchard-long.ts",
    sha256: "21b00942246dc7f0ecf5321dc22bc4ce2326b51ea72ea55697d754601ca115d2",
    rawCount: 17576,
    dice: 0,
    distribution: [176, 806, 1640, 2397, 2833, 2800, 2478, 1886, 1178, 736, 405, 169, 72],
    min: 3,
    max: 15,
    exclusions: [],
  },
  {
    id: "orchard-medium",
    file: "vendor/orchard-street-medium.txt",
    module: "src/core/wordlist-orchard-medium.ts",
    sha256: "c50d42781d5ac20eeed37f271df5a0fd3573de493812f319cd71dd4da9a8a38e",
    rawCount: 8192,
    dice: 0,
    distribution: [143, 611, 1065, 1371, 1498, 1420, 1203, 881],
    min: 3,
    max: 10,
    exclusions: [],
  },
  {
    id: "eff-short1",
    file: "vendor/eff_short_wordlist_1.txt",
    module: "src/core/wordlist-eff-short1.ts",
    sha256: "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69",
    rawCount: 1296,
    dice: 4,
    distribution: [82, 432, 781],
    min: 3,
    max: 5,
    exclusions: ["yo-yo"],
  },
  {
    id: "eff-short2",
    file: "vendor/eff_short_wordlist_2_0.txt",
    module: "src/core/wordlist-eff-short2.ts",
    sha256: "22b45c52e0bd0bbf03aa522240b111eb4c7c0c1d86c4e518e1be2a7eb2a625e4",
    rawCount: 1296,
    dice: 4,
    distribution: [6, 47, 145, 224, 252, 275, 222, 124],
    min: 3,
    max: 10,
    exclusions: ["yo-yo"],
  },
] as const;
export type ExtraWordlist = (typeof EXTRA_WORDLISTS)[number];
export function verifiedExtraWordlist(root: string, spec: ExtraWordlist): { raw: string; words: string[] } {
  const bytes = readFileSync(join(root, spec.file));
  const filename = spec.file.split("/").at(-1);
  const checksum = readFileSync(join(root, spec.file.replace(/\.txt$/, ".sha256")), "utf8");
  if (checksum !== `${spec.sha256}  ${filename}\n` || createHash("sha256").update(bytes).digest("hex") !== spec.sha256)
    throw new Error("Wordlist SHA-256 mismatch");
  const raw = bytes.toString("utf8");
  const lines = raw.trimEnd().split("\n");
  if (lines.length !== spec.rawCount) throw new Error("Invalid wordlist entry count");
  const codes = new Set<string>();
  const entries = lines.map((line) => {
    if (!spec.dice) return line;
    const match = /^([1-6]{4})\t([^\s]+)$/.exec(line);
    if (!match || codes.has(match[1] as string)) throw new Error("Invalid or duplicate wordlist dice code");
    codes.add(match[1] as string);
    return match[2] as string;
  });
  const excluded = entries.filter((word) => word.includes("-"));
  if (JSON.stringify(excluded) !== JSON.stringify(spec.exclusions)) throw new Error("Invalid wordlist exclusions");
  const words = entries.filter((word) => !word.includes("-"));
  if (words.some((word) => !/^[a-z]+$/.test(word)) || new Set(words).size !== words.length)
    throw new Error("Wordlist requires unique lowercase a-z words");
  const distribution = Array.from(
    { length: spec.max - spec.min + 1 },
    (_, i) => words.filter((w) => w.length === spec.min + i).length,
  );
  if (
    JSON.stringify(distribution) !== JSON.stringify(spec.distribution) ||
    words.some((w) => w.length < spec.min || w.length > spec.max)
  )
    throw new Error("Wordlist length distribution mismatch");
  return { raw, words };
}
export function extraWordlistModule(root: string, spec: ExtraWordlist): string {
  const { words } = verifiedExtraWordlist(root, spec);
  return `// Wordlist; license and filtering are described in NOTICE.\nexport const WORDS: readonly string[] = Object.freeze(\n  "${words.join(" ")}".split(\n    " ",\n  ),\n);\n`;
}
