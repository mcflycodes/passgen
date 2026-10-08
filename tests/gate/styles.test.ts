// Build-time gates for styles and page text (R4b, R4d, C1, C2): a copy of
// the app with one thing broken must fail the real production build before
// any file is emitted, and a credit hidden in the configured page text must
// be caught by verify-dist on the built page.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { build } from "vite";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const toolA = EXAMPLE_TOOLS.find((t) => t.toLowerCase() === "cursor") as string;

let scratch: string;
before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "passgen-styles-"));
});
after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: the fixture edits arbitrary configuration paths
type AnyConfig = Record<string, any>;
type Edit = (dir: string, helpers: { config: AnyConfig; style: (id: string) => string }) => Promise<void> | void;

/** A copy of the app under `name`, with `edit` applied, ready to build. */
async function fixture(name: string, edit: Edit): Promise<{ dir: string; options: Parameters<typeof build>[0] }> {
  const dir = join(scratch, name);
  for (const entry of ["index.html", "src", "public", "vendor"])
    await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
  const configPath = join(dir, "src/config/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await edit(dir, { config, style: (id) => join(dir, "src/styles", id, "style.css") });
  await writeFile(configPath, JSON.stringify(config));
  return { dir, options: { root: dir, configFile: join(ROOT, "vite.config.ts"), logLevel: "silent" as const } };
}

async function expectBuildFails(name: string, pattern: RegExp, edit: Edit) {
  const { dir, options } = await fixture(name, edit);
  await assert.rejects(build(options), pattern);
  await assert.rejects(readFile(join(dir, "dist/index.html")), { code: "ENOENT" });
}

const replaceInStyle = async (file: string, from: string, to: string) => {
  const css = await readFile(file, "utf8");
  assert.ok(css.includes(from), `style contains ${from}`);
  await writeFile(file, css.replace(from, to));
};

describe("style gates (R4b)", { timeout: 300_000 }, () => {
  test("a style missing a required token fails the build", () =>
    expectBuildFails("missing-token", /Style check failed[\s\S]*missing required token --panel/, (_dir, { style }) =>
      replaceInStyle(style("calm"), "--panel: light-dark(#ffffff, #19191d);", ""),
    ));

  test("a style whose text fails AA contrast fails the build", () =>
    expectBuildFails(
      "contrast",
      /Style check failed[\s\S]*--muted on --bg \(light\): text contrast/,
      (_dir, { style }) =>
        replaceInStyle(
          style("calm"),
          "--muted: light-dark(#5f6270, #a0a1ab);",
          "--muted: light-dark(#aaaaaa, #a0a1ab);",
        ),
    ));

  test("a style that imports a stylesheet fails the build", () =>
    expectBuildFails("import", /Style check failed[\s\S]*@import is not allowed/, async (_dir, { style }) => {
      await writeFile(style("green"), `@import url("x.css");\n${await readFile(style("green"), "utf8")}`);
    }));

  test("a style with a web font fails the build", () =>
    expectBuildFails("font", /Style check failed[\s\S]*@font-face is not allowed/, async (_dir, { style }) => {
      await writeFile(
        style("slate"),
        `${await readFile(style("slate"), "utf8")}\n@font-face { font-family: X; src: local(X); }`,
      );
    }));

  test("a style with any url() fails the build", () =>
    expectBuildFails("url", /Style check failed[\s\S]*url\(grid\.png\) is not allowed/, (_dir, { style }) =>
      replaceInStyle(style("purple"), "--fx-follow: 1;", "--fx-follow: 1; --fx-static: url(grid.png);"),
    ));

  // Security review repros: both built before, and the page then requested /outside.svg.
  test("an image-set() in a custom property fails the build (repro 1)", () =>
    expectBuildFails("image-set", /Style check failed[\s\S]*image-set\(\) is not allowed/, (_dir, { style }) =>
      replaceInStyle(style("calm"), "--fx-follow: 0;", '--fx-follow: 0; --fx-static: image-set("/outside.svg" 1x);'),
    ));

  test("an encoded traversal url() fails the build (repro 2)", () =>
    expectBuildFails(
      "encoded-url",
      /Style check failed[\s\S]*url\(%2e%2e\/outside\.svg\) is not allowed/,
      async (_dir, { style }) => {
        await writeFile(
          style("calm"),
          `${await readFile(style("calm"), "utf8")}\n:root[data-style="calm"] { background-image: url(%2e%2e/outside.svg); }`,
        );
      },
    ));

  // Round-2 review repros: each built before and reached the page.
  test("a comment-split resource function in a token fails the build (round 2, repro 1)", () =>
    expectBuildFails(
      "comment-split-url",
      /Style check failed[\s\S]*url\(\/outside\.svg\) is not allowed/,
      (_dir, { style }) =>
        replaceInStyle(style("calm"), "--fx-follow: 0;", "--fx-follow: 0; --fx-pointer: u/**/rl(/outside.svg);"),
    ));

  test("an ordinary declaration under the style's selector fails the build (round 2, repro 2a)", () =>
    expectBuildFails(
      "value-color",
      /Style check failed[\s\S]*a rule other than a top-level/,
      async (_dir, { style }) => {
        await writeFile(
          style("calm"),
          `${await readFile(style("calm"), "utf8")}\n:root[data-style="calm"] .value { color: var(--field); }`,
        );
      },
    ));

  test("an ordinary property in the token rule fails the build (round 2, repro 2b)", () =>
    expectBuildFails(
      "text-fill",
      /Style check failed[\s\S]*-webkit-text-fill-color: only custom properties/,
      (_dir, { style }) =>
        replaceInStyle(style("calm"), "--fx-follow: 0;", "--fx-follow: 0; -webkit-text-fill-color: transparent;"),
    ));

  test("a resource that reaches the emitted CSS by another route fails verify-dist", async () => {
    // The layout stylesheet is not a style, so the style gate never sees it;
    // verify-dist judges the emitted bundle itself.
    const { dir, options } = await fixture("emitted-url", async (d) => {
      const layout = join(d, "src/styles.css");
      await writeFile(layout, `${await readFile(layout, "utf8")}\n.foot{background-image:u/**/rl(/outside.svg)}`);
    });
    await build(options);
    const assets = join(dir, "dist/assets");
    const css = await readFile(join(assets, readdirSync(assets).find((f) => f.endsWith(".css")) as string), "utf8");
    assert.match(css, /url\(\/outside\.svg\)/, "the comment-split call is active in the emitted CSS");
    try {
      await run(process.execPath, [join(ROOT, "scripts", "verify-dist.ts"), "--dir", join(dir, "dist")], { cwd: ROOT });
      assert.fail("verify-dist passed");
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      assert.notEqual(e.code, 0, e.message);
      assert.match(`${e.stdout}${e.stderr}`, /CSS loads a resource: url\(\/outside\.svg\)/);
    }
  });

  // Round-3 review: typed tokens. Each built before and hid or could hide text.
  test("the inset shadow over a transparent field fails the build (round 3 repro)", () =>
    expectBuildFails(
      "inset-shadow-field",
      /Style check failed[\s\S]*(must be an opaque colour|inset shadows are not allowed)/,
      async (_dir, { style }) => {
        const css = (await readFile(style("calm"), "utf8"))
          .replace("--field: light-dark(#ffffff, #141417);", "--field: transparent;")
          .replace(/--shadow:[^;]*;/, "--shadow: inset 0 0 0 10000px var(--text);");
        await writeFile(style("calm"), css);
      },
    ));

  test("an inset shadow alone fails the build", () =>
    expectBuildFails(
      "inset-shadow",
      /Style check failed[\s\S]*inset shadows are not allowed/,
      async (_dir, { style }) => {
        await writeFile(
          style("calm"),
          (await readFile(style("calm"), "utf8")).replace(/--shadow:[^;]*;/, "--shadow: inset 0 0 0 10000px #16161a;"),
        );
      },
    ));

  test("a transparent --field alone fails the build", () =>
    expectBuildFails(
      "transparent-field",
      /Style check failed[\s\S]*--field \((light|dark)\): must be an opaque colour/,
      (_dir, { style }) =>
        replaceInStyle(style("calm"), "--field: light-dark(#ffffff, #141417);", "--field: transparent;"),
    ));

  test("a huge-spread outer shadow fails the build", () =>
    expectBuildFails("huge-spread", /Style check failed[\s\S]*shadow spread must be/, async (_dir, { style }) => {
      await writeFile(
        style("calm"),
        (await readFile(style("calm"), "utf8")).replace(/--shadow:[^;]*;/, "--shadow: 0 0 0 10000px #16161a;"),
      );
    }));

  test("an alpha surface fails the build", () =>
    expectBuildFails(
      "alpha-panel",
      /Style check failed[\s\S]*--panel \((light|dark)\): must be an opaque colour/,
      (_dir, { style }) =>
        replaceInStyle(style("calm"), "--panel: light-dark(#ffffff, #19191d);", "--panel: rgba(255, 255, 255, 0.5);"),
    ));

  test("a token the layout does not read fails the build", () =>
    expectBuildFails(
      "unknown-token",
      /Style check failed[\s\S]*--mine is not a token the layout reads/,
      (_dir, { style }) => replaceInStyle(style("calm"), "--fx-follow: 0;", "--fx-follow: 0; --mine: #000;"),
    ));

  // Round-4 review: stacked gradients. Each built before.
  const withStatic = async (file: string, gradient: string, extra = "") => {
    const css = (await readFile(file, "utf8"))
      .replace(/--fx-static: radial-gradient\([^;]*\);/, `--fx-static: ${gradient};`)
      .replace("--bg-band: light-dark(#f5f5f6, #121214);", extra || "--bg-band: light-dark(#f5f5f6, #121214);");
    await writeFile(file, css);
  };
  const veil = "linear-gradient(rgba(22, 22, 26, 0.3), rgba(22, 22, 26, 0.3))";

  test("four stacked veils under a transparent band fail the build for complexity (round 4, repro 1)", () =>
    expectBuildFails("four-layers", /Style check failed[\s\S]*may have at most 3 layers, not 4/, (_dir, { style }) =>
      withStatic(style("calm"), [veil, veil, veil, veil].join(", "), "--bg-band: transparent;"),
    ));

  test("three stacked veils that pass alone fail the build composited (round 4)", () =>
    expectBuildFails("three-layers", /Style check failed[\s\S]*--text-2 on the intro background/, (_dir, { style }) =>
      withStatic(style("calm"), [veil, veil, veil].join(", "), "--bg-band: transparent;"),
    ));

  test("a layer in the footer's text colour fails the build (round 4, repro 2)", () =>
    expectBuildFails("footer-veil", /Style check failed[\s\S]*--text-2 on the footer/, (_dir, { style }) =>
      withStatic(style("calm"), "linear-gradient(light-dark(#5f6270, #a0a1ab), light-dark(#5f6270, #a0a1ab))"),
    ));

  test("a gradient with 26 stops fails the build, never truncated (round 4, repro 3)", () =>
    expectBuildFails("many-stops", /Style check failed[\s\S]*at most 8 colour stops, not 26/, (_dir, { style }) =>
      withStatic(
        style("calm"),
        `linear-gradient(${Array.from({ length: 24 }, () => "transparent 0%").join(", ")}, #16161a 1%, #16161a 100%)`,
        "--bg-band: transparent;",
      ),
    ));

  test("a gradient with 9 stops fails the build (round 4)", () =>
    expectBuildFails("nine-stops", /Style check failed[\s\S]*at most 8 colour stops, not 9/, (_dir, { style }) =>
      withStatic(style("calm"), `linear-gradient(${Array.from({ length: 9 }, () => "transparent").join(", ")})`),
    ));

  // Round-5 review: two opaque stops that each pass, whose midpoint fails.
  test("a gradient whose midpoint fails the footer text fails the build (round 5 repro)", () =>
    expectBuildFails(
      "midpoint",
      /Style check failed[\s\S]*--text-2 on the footer .*\(light\): text contrast can fall to/,
      (_dir, { style }) =>
        withStatic(
          style("calm"),
          "linear-gradient(90deg, light-dark(#ff7800, #121214) 0px, light-dark(#00b0ff, #121214) 600px)",
        ),
    ));

  // Round-6 review: a declared --fx-peak must never stand in for the bound.
  test("a declared --fx-peak over a text-coloured veil fails the build (round 6 repro)", () =>
    expectBuildFails(
      "fx-peak",
      /Style check failed[\s\S]*--fx-peak is not a token the layout reads/,
      async (_dir, { style }) => {
        await withStatic(style("calm"), "linear-gradient(light-dark(#34353c, #c9c9d0), light-dark(#34353c, #c9c9d0))");
        await replaceInStyle(
          style("calm"),
          "--fx-follow: 0;",
          "--fx-follow: 0; --fx-peak: light-dark(#ffffff, #000000);",
        );
      },
    ));

  test("an escaped identifier redefining a text token fails the build (repro 3)", () =>
    expectBuildFails(
      "escaped-ident",
      /Style check failed[\s\S]*--text is declared more than once/,
      async (_dir, { style }) => {
        await writeFile(
          style("calm"),
          `${await readFile(style("calm"), "utf8")}\n:root[data-style="calm"] { --te\\78t: var(--field); }`,
        );
      },
    ));

  test("a default style that is not offered fails the build", () =>
    expectBuildFails("default", /Invalid config: style\.default/, (_dir, { config }) => {
      config.style.default = "ghost";
    }));

  test("an offered style with no stylesheet fails the build", () =>
    expectBuildFails("no-sheet", /Style check failed[\s\S]*offered but has no stylesheet/, (_dir, { config }) => {
      config.style.offered.push({ id: "ghost", label: "Ghost" });
    }));
});

describe("page text gates (R4d)", { timeout: 300_000 }, () => {
  test("a tagline over its cap fails the build", () =>
    expectBuildFails("tagline-cap", /Invalid config: text\.tagline: must be at most 80/, (_dir, { config }) => {
      config.text.tagline = "x".repeat(81);
    }));

  test("an enabled intro without a headline fails the build", () =>
    expectBuildFails("intro-headline", /Invalid config: text\.intro/, (_dir, { config }) => {
      config.text.intro.headline = "";
    }));

  test("a credit in the page text is escaped into the page and caught by verify-dist", async () => {
    const { dir, options } = await fixture("tagline-credit", (_dir, { config }) => {
      config.text.tagline = `Generated by ${toolA} & friends`;
    });
    await build(options);
    const html = await readFile(join(dir, "dist/index.html"), "utf8");
    assert.match(html, /Generated by \w+ &amp; friends/, "inserted as escaped text");
    try {
      await run(process.execPath, [join(ROOT, "scripts", "verify-dist.ts"), "--dir", join(dir, "dist")], { cwd: ROOT });
      assert.fail("verify-dist passed");
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      assert.notEqual(e.code, 0, e.message);
      assert.match(`${e.stdout}${e.stderr}`, /index\.html.*attribution: .*authorship credit/);
    }
  });

  test("the intro can be switched off and the generators move up", async () => {
    const { dir, options } = await fixture("intro-off", (_dir, { config }) => {
      config.text.intro.enabled = false;
      config.text.tagline = "";
    });
    await build(options);
    const html = await readFile(join(dir, "dist/index.html"), "utf8");
    assert.doesNotMatch(html, /class="intro"|class="tagline"/);
    assert.match(html, /<main>\s*<div class="generators">/);
  });

  test("one offered style leaves the style control out of the page", async () => {
    const { dir, options } = await fixture("one-style", (_dir, { config }) => {
      config.style.offered = [{ id: "payload", label: "Payload" }];
      config.style.default = "payload";
    });
    await build(options);
    const html = await readFile(join(dir, "dist/index.html"), "utf8");
    assert.doesNotMatch(html, /id="style"/);
    const css = await readFile(
      join(
        dir,
        "dist/assets",
        (await import("node:fs")).readdirSync(join(dir, "dist/assets")).find((f) => f.endsWith(".css")) as string,
      ),
      "utf8",
    );
    assert.match(css, /data-style=payload|data-style="payload"/);
    assert.doesNotMatch(css, /data-style=calm|data-style="calm"/, "unoffered styles are not shipped");
  });
});
