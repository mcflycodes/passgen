import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";

const root = join(import.meta.dirname, "../..");
for (const [name, mutate] of [
  ["changed byte", (raw: string) => raw.replace("abacus", "abacut")],
  ["uppercase word", (raw: string) => raw.replace("abacus", "Abacus")],
  ["duplicate word", (raw: string) => raw.replace("abdomen", "abacus")],
  ["fifth hyphenated word", (raw: string) => raw.replace("abacus", "aba-cus")],
  ["stale module", undefined],
] as const)
  test(`production build rejects ${name} without output`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "passgen-wordlist-"));
    try {
      for (const entry of ["index.html", "src", "public", "vendor"])
        await cp(join(root, entry), join(dir, entry), { recursive: true });
      const path = join(dir, mutate ? "vendor/eff_large_wordlist.txt" : "src/core/wordlist.ts");
      const raw = await readFile(path, "utf8");
      await writeFile(path, mutate ? mutate(raw) : `${raw}\n`);
      await assert.rejects(
        build({ root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" }),
        mutate ? /SHA-256 mismatch/ : /module differs/,
      );
      await assert.rejects(readFile(join(dir, "dist/index.html")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
