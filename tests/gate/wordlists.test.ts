import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";

const root = join(import.meta.dirname, "../..");
// Independent review pins: coordinated edits to the sidecar must still fail.
const pins = [
  ["orchard-street-long", "21b00942246dc7f0ecf5321dc22bc4ce2326b51ea72ea55697d754601ca115d2"],
  ["orchard-street-medium", "c50d42781d5ac20eeed37f271df5a0fd3573de493812f319cd71dd4da9a8a38e"],
  ["eff_short_wordlist_1", "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69"],
  ["eff_short_wordlist_2_0", "22b45c52e0bd0bbf03aa522240b111eb4c7c0c1d86c4e518e1be2a7eb2a625e4"],
] as const;
for (const [file, pin] of pins) {
  test(`independent ${file} fingerprint pin`, async () => {
    const raw = await readFile(join(root, `vendor/${file}.txt`));
    assert.equal(createHash("sha256").update(raw).digest("hex"), pin);
  });
  test(`production build rejects tampered ${file}, even with a matching sidecar`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "passgen-lists-"));
    try {
      for (const entry of ["index.html", "src", "public", "vendor"])
        await cp(join(root, entry), join(dir, entry), { recursive: true });
      const raw = Buffer.concat([await readFile(join(dir, `vendor/${file}.txt`)), Buffer.from("extra\n")]);
      await writeFile(join(dir, `vendor/${file}.txt`), raw);
      await writeFile(
        join(dir, `vendor/${file}.sha256`),
        `${createHash("sha256").update(raw).digest("hex")}  ${file}.txt\n`,
      );
      await assert.rejects(
        build({ root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" }),
        /SHA-256 mismatch/,
      );
      await assert.rejects(readFile(join(dir, "dist/index.html")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
