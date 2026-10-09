import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";

const root = join(import.meta.dirname, "../..");
const run = promisify(execFile);
const EXPECTED_WORDLIST_SHA256 = "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e";
test("wordlist checksum matches the independent gate pin", async () => {
  const raw = await readFile(join(root, "vendor/eff_large_wordlist.txt"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), EXPECTED_WORDLIST_SHA256);
});
const name = EXAMPLE_TOOLS.find((tool) => tool.startsWith("Co") && tool.endsWith("pilot")) as string;
for (const injection of [
  "none",
  "module comment",
  "extra export",
  "wordlist byte",
  "wordlist and checksum",
  "ordinary source",
  "docs",
  "PR body",
] as const) {
  test(`attribution gate: ${injection}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "passgen-word-credit-"));
    try {
      await mkdir(join(dir, "src/core"), { recursive: true });
      await cp(join(root, "vendor"), join(dir, "vendor"), { recursive: true });
      const module = join(dir, "src/core/wordlist.ts");
      await cp(join(root, "src/core/wordlist.ts"), module);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      if (injection === "module comment")
        await writeFile(module, `${await readFile(module, "utf8")}\n// Built with ${name}\n`);
      if (injection === "extra export")
        await writeFile(module, `${await readFile(module, "utf8")}\nexport const credit = "${name}";\n`);
      if (injection === "wordlist byte") {
        const path = join(dir, "vendor/eff_large_wordlist.txt");
        await writeFile(path, (await readFile(path, "utf8")).replace("abacus", "abacut"));
      }
      if (injection === "wordlist and checksum") {
        // Simulate both coordinated pin edits and a freshly emitted module.
        await cp(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
        await mkdir(join(dir, "tests/gate"), { recursive: true });
        const pinTest = join(dir, "tests/gate/wordlist-attribution.test.ts");
        await cp(join(root, "tests/gate/wordlist-attribution.test.ts"), pinTest);
        const vendorName = EXAMPLE_TOOLS.find((entry) => entry.startsWith("Cl") && entry.length === 6) as string;
        const path = join(dir, "vendor/eff_large_wordlist.txt");
        const raw = (await readFile(path, "utf8")).replace("ablaze", vendorName.toLowerCase());
        const hash = createHash("sha256").update(raw).digest("hex");
        await writeFile(path, raw);
        await writeFile(join(dir, "vendor/eff_large_wordlist.sha256"), `${hash}  eff_large_wordlist.txt\n`);
        for (const pin of [join(dir, "scripts/lib/wordlist.ts"), pinTest]) {
          const before = await readFile(pin, "utf8");
          assert.ok(before.includes(EXPECTED_WORDLIST_SHA256));
          await writeFile(pin, before.replace(EXPECTED_WORDLIST_SHA256, hash));
        }
        await run(process.execPath, [join(dir, "scripts/gen-wordlist.ts")], { cwd: dir });
        await run(process.execPath, [join(dir, "scripts/gen-wordlist.ts"), "--check"], { cwd: dir });
      }
      if (injection === "ordinary source")
        await writeFile(join(dir, "src/other.ts"), `export const credit = "${name}";\n`);
      if (injection === "docs") await writeFile(join(dir, "README.md"), `${name}\n`);
      let code = 0;
      let output = "";
      try {
        const result = await run(
          process.execPath,
          [join(injection === "wordlist and checksum" ? dir : root, "scripts/check-attribution.ts")],
          {
            cwd: dir,
            env: {
              ...process.env,
              ATTRIBUTION_RANGE: "--all",
              PR_TITLE: "",
              PR_BODY: injection === "PR body" ? name : "",
            },
          },
        );
        output = result.stdout + result.stderr;
      } catch (error) {
        const result = error as { code: number; stdout: string; stderr: string };
        code = result.code;
        output = result.stdout + result.stderr;
      }
      if (injection === "none") assert.equal(code, 0, output);
      else {
        assert.notEqual(code, 0, output);
        if (injection === "module comment") assert.match(output, /src\/core\/wordlist\.ts:\d+: authorship credit/);
        if (injection === "wordlist byte") assert.match(output, /SHA-256 mismatch/);
        if (injection === "wordlist and checksum") {
          assert.doesNotMatch(output, /SHA-256 mismatch|module differs/);
          assert.match(output, /vendor\/eff_large_wordlist\.txt:\d+: assistant or vendor name/);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("a production bundle exempts its word data while scanning other literals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "passgen-word-bundle-"));
  try {
    for (const entry of ["index.html", "src", "public", "vendor"])
      await cp(join(root, entry), join(dir, entry), { recursive: true });
    const main = join(dir, "src/main.ts");
    const original = await readFile(main, "utf8");
    const exercise =
      '\nimport { WORDS } from "./core/wordlist.ts";\ndocument.querySelector("h1")?.replaceChildren(WORDS[0] ?? "");\n';
    const { build } = await import("vite");
    const { readdir } = await import("node:fs/promises");
    const { checkJs } = await import("../../scripts/lib/dist-checks.ts");
    const { config, configuredLinks } = await import("../../src/config/validate.ts");
    // The bundle carries the configured links (decision 0005, point 5); nothing else is exempt.
    const allowed = configuredLinks(config);
    async function bundle(extra: string): Promise<string> {
      await writeFile(main, original + exercise + extra);
      await build({ root: dir, configFile: join(root, "vite.config.ts"), logLevel: "silent" });
      // The entry bundle, not the small boot script the build also emits.
      const js = (await readdir(join(dir, "dist/assets"))).find(
        (file) => file.startsWith("index-") && file.endsWith(".js"),
      ) as string;
      return readFile(join(dir, "dist/assets", js), "utf8");
    }
    const clean = await bundle("");
    assert.ok(clean.includes(name.toLowerCase()));
    assert.deepEqual(checkJs("bundle.js", clean, allowed), []);
    assert.ok(checkJs("bundle.js", clean).length > 0, "the configured links are found without the list");
    const bad = await bundle(`\ndocument.title = "${name}";\n`);
    assert.ok(checkJs("bundle.js", bad, allowed).some((finding) => finding.problem.includes("attribution")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
