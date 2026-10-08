import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";

const root = join(import.meta.dirname, "../..");
test("production build rejects invalid configuration before emitting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-config-"));
  try {
    for (const entry of ["index.html", "src", "public", "vendor"])
      await cp(join(root, entry), join(dir, entry), { recursive: true });
    const options = { root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" as const };
    await build(options);
    await rm(join(dir, "dist"), { recursive: true });
    const path = join(dir, "src/config/config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.password.length.min = 3;
    await writeFile(path, JSON.stringify(config));
    await assert.rejects(build(options), /Invalid config: password.length.min/);
    await assert.rejects(readFile(join(dir, "dist/index.html")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production build rejects duplicate config keys before emitting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-duplicate-config-"));
  try {
    for (const entry of ["index.html", "src", "public", "vendor"])
      await cp(join(root, entry), join(dir, entry), { recursive: true });
    const options = { root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" as const };
    await build(options);
    await rm(join(dir, "dist"), { recursive: true });
    const path = join(dir, "src/config/config.json");
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace('"theme": "system"', '"theme": "light", "theme": "system"'));
    await assert.rejects(build(options), /duplicate JSON key/);
    await assert.rejects(readFile(join(dir, "dist/index.html")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
