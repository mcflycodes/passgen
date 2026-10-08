import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  checkStyleSource,
  checkStyles,
  contrastRatio,
  findCssResources,
  METER_TOKENS,
  over,
  parseStyle,
  REQUIRED_TOKENS,
  resolveToken,
  topLevelIndex,
} from "../../scripts/lib/style-checks.ts";
import config from "../../src/config/config.json" with { type: "json" };

const ROOT = join(import.meta.dirname, "../..");
const calm = readFileSync(join(ROOT, "src/styles/calm/style.css"), "utf8");
const problems = (css: string, id = "calm") => checkStyleSource(id, css).map((p) => p.problem);
const edit = (from: string, to: string) => {
  assert.ok(calm.includes(from), `fixture contains ${from}`);
  return calm.replace(from, to);
};

describe("shipped styles", () => {
  test("every offered style passes, and the default is offered", () => {
    assert.deepEqual(checkStyles(ROOT, config.style), []);
  });
  for (const { id } of config.style.offered) {
    test(`${id} declares every required token in its top-level rule`, () => {
      const tokens = topLevelIndex(
        parseStyle(id, readFileSync(join(ROOT, `src/styles/${id}/style.css`), "utf8")).declarations,
      );
      for (const name of REQUIRED_TOKENS) assert.ok(tokens.has(name), `${id} has ${name}`);
      for (const name of METER_TOKENS) assert.ok(tokens.has(name), `${id} declares the meter ramp ${name}`);
    });
  }
  test("a missing stylesheet and an unoffered default are reported", () => {
    const found = checkStyles(ROOT, {
      default: "nope",
      offered: [
        { id: "calm", label: "Calm" },
        { id: "ghost", label: "G" },
      ],
    });
    assert.deepEqual(
      found.map((p) => p.problem),
      [
        "the default style is not one of the offered styles",
        "offered but has no stylesheet at src/styles/ghost/style.css",
      ],
    );
  });
});

describe("colour arithmetic", () => {
  test("contrast ratios match WCAG reference values", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    assert.equal(contrastRatio(white, black), 21);
    assert.equal(contrastRatio(black, white), 21);
    assert.ok(Math.abs(contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, white) - 4.48) < 0.01);
  });
  test("composites translucent colours over an opaque surface", () => {
    assert.deepEqual(over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), {
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
  });
});

describe("token resolution from the parsed stylesheet", () => {
  const style = (body: string) => `:root[data-style="x"] { ${body} }`;
  const index = (css: string) => topLevelIndex(parseStyle("x", css).declarations);
  const color = (css: string, name: string, theme: "light" | "dark") => {
    const result = resolveToken(index(css), name, theme);
    assert.ok("color" in result, JSON.stringify(result));
    return result.color;
  };
  test("reads hex, rgb(), rgba() in both syntaxes, transparent, white and black, decoded by the parser", () => {
    const css = style(
      "--a: #fff; --b: #0000; --c: #2457d6; --d: #2457d680; --e: rgb(1, 2, 3); --f: rgba(1, 2, 3, 0.5); --g: rgb(1 2 3 / 50%); --h: transparent; --i: WHITE; --j: black",
    );
    assert.deepEqual(color(css, "--a", "light"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(color(css, "--b", "light"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(color(css, "--c", "light"), { r: 36, g: 87, b: 214, a: 1 });
    // The parser keeps alpha in 8 bits, so 0.5 reads back as 128/255.
    const half = (rgba: { r: number; g: number; b: number; a: number }, r: number, g: number, b: number) => {
      assert.deepEqual([rgba.r, rgba.g, rgba.b], [r, g, b]);
      assert.ok(Math.abs(rgba.a - 128 / 255) < 0.01);
    };
    half(color(css, "--d", "light"), 36, 87, 214);
    assert.deepEqual(color(css, "--e", "light"), { r: 1, g: 2, b: 3, a: 1 });
    half(color(css, "--f", "light"), 1, 2, 3);
    half(color(css, "--g", "light"), 1, 2, 3);
    assert.deepEqual(color(css, "--h", "light"), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(color(css, "--i", "light"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(color(css, "--j", "light"), { r: 0, g: 0, b: 0, a: 1 });
  });
  test("picks the light or dark side, folded or not, and follows var() chains", () => {
    const css = style(
      "--accent: light-dark(#111111, #eeeeee); --ok: var(--accent); --mix: light-dark(var(--ok), #000000); --plain: #123456",
    );
    assert.deepEqual(color(css, "--accent", "light"), { r: 17, g: 17, b: 17, a: 1 });
    assert.deepEqual(color(css, "--accent", "dark"), { r: 238, g: 238, b: 238, a: 1 });
    assert.deepEqual(color(css, "--ok", "dark"), { r: 238, g: 238, b: 238, a: 1 });
    assert.deepEqual(color(css, "--mix", "light"), { r: 17, g: 17, b: 17, a: 1 });
    assert.deepEqual(color(css, "--mix", "dark"), { r: 0, g: 0, b: 0, a: 1 });
    assert.deepEqual(color(css, "--plain", "dark"), { r: 18, g: 52, b: 86, a: 1 });
  });
  for (const [label, body, name, expected] of [
    ["a missing token", "--a: #fff", "--missing", /not declared once in the top-level rule/],
    ["a reference to a missing token", "--a: var(--missing)", "--a", /--missing is not declared once/],
    ["a reference cycle", "--a: var(--b); --b: var(--a)", "--a", /refers to itself/],
    ["a var() with a fallback", "--a: var(--missing, #fff)", "--a", /fallback is not allowed/],
    [
      "a colour function the parser cannot compute",
      "--a: rgb(var(--x), 0, 0)",
      "--a",
      /unsupported colour function|not a hex/,
    ],
    ["a named colour other than white or black", "--a: red", "--a", /not a hex/],
    ["two values", "--a: #fff #000", "--a", /not a single colour/],
    ["currentcolor", "--a: currentcolor", "--a", /not a hex/],
  ] as const) {
    test(`refuses ${label}`, () => {
      const result = resolveToken(index(style(body)), name, "light");
      assert.ok("error" in result && expected.test(result.error), JSON.stringify(result));
    });
  }
  test("colours the parser computes itself, such as hsl() and color-mix(), read as rgb", () => {
    const css = style("--a: hsl(0 100% 50%); --b: color-mix(in srgb, #fff 50%, #000)");
    assert.deepEqual(color(css, "--a", "light"), { r: 255, g: 0, b: 0, a: 1 });
    assert.deepEqual(color(css, "--b", "light"), { r: 128, g: 128, b: 128, a: 1 });
  });
  test("an escaped identifier is decoded before anything else is decided", () => {
    const parsed = parseStyle("x", style("--te\\78t: #fff; --f\\69 eld: #000"));
    assert.deepEqual(
      parsed.declarations.map((d) => d.name),
      ["--text", "--field"],
    );
  });
  test("a declaration is top-level only in the style's own exact selector at depth 0", () => {
    const parsed = parseStyle(
      "x",
      `${style("--a: #fff")}
       @media (min-width: 1px) { :root[data-style="x"] { --b: #fff } }
       :root[data-style="x"] .gen { --c: #fff }
       :root[data-style="x"], :root[data-style="x"] { --d: #fff }`,
    );
    assert.deepEqual(
      parsed.declarations.map((d) => [d.name, d.topLevel]),
      [
        ["--a", true],
        ["--b", false],
        ["--c", false],
        ["--d", false],
      ],
    );
    const idx = topLevelIndex(parsed.declarations);
    assert.deepEqual([...idx.keys()], ["--a"]);
  });
});

describe("resources are refused wherever they appear", () => {
  const style = (body: string) => `:root[data-style="x"] { ${body} }`;
  const problems = (css: string) => parseStyle("x", css).problems;
  for (const [label, css, expected] of [
    [
      "an image-set() in a custom property (security review repro 1)",
      style('--fx-static: image-set("/outside.svg" 1x)'),
      /image-set\(\) is not allowed/,
    ],
    [
      "an encoded traversal url() in a property (security review repro 2)",
      style("background-image: url(%2e%2e/outside.svg)"),
      /url\(%2e%2e\/outside\.svg\) is not allowed/,
    ],
    ["an absolute url() in a custom property", style("--a: url(/outside.svg)"), /url\(\/outside\.svg\) is not allowed/],
    ["a relative url() in a custom property", style("--a: url(grid.png)"), /url\(grid\.png\) is not allowed/],
    ["a data: url()", style("--a: url(data:image/png;base64,AAAA)"), /url\(.*\) is not allowed/],
    ["an escaped url( call", style("--a: \\75rl(/outside.svg)"), /url\(.*\) is not allowed/],
    ["a url() inside light-dark()", style('--a: light-dark(#fff, url("a.png"))'), /url\(a\.png\) is not allowed/],
    ["a url() in a var() fallback", style("--a: var(--b, url(a.png))"), /url\(a\.png\) is not allowed/],
    [
      "-webkit-image-set()",
      style('--a: -webkit-image-set(url("a.png") 1x)'),
      /image-set\(\) is not allowed|url\(.*\) is not allowed/,
    ],
    ["image()", style('--a: image("a.png")'), /image\(\) is not allowed/],
    [
      "cross-fade()",
      style("--a: cross-fade(url(a.png), url(b.png), 50%)"),
      /cross-fade\(\) is not allowed|url\(.*\) is not allowed/,
    ],
    ["element()", style("--a: element(#x)"), /element\(\) is not allowed/],
    ["-moz-element()", style("--a: -moz-element(#x)"), /-moz-element\(\) is not allowed/],
    ["paint()", style("--a: paint(x)"), /paint\(\) is not allowed/],
    ["src()", style('--a: src("a.png")'), /src\(\) is not allowed/],
    [
      "an image-set() in a typed property",
      style('background-image: image-set("a.png" 1x)'),
      /image-set\(\) is not allowed/,
    ],
    ["an escaped @import", `@\\69mport "x.css";\n${style("--a: #fff")}`, /@import is not allowed/],
    [
      "a web font with a url",
      `${style("--a: #fff")}\n@font-face { font-family: X; src: url(x.woff2); }`,
      /@font-face is not allowed/,
    ],
    [
      "@namespace",
      `@namespace svg url(http://www.w3.org/2000/svg);\n${style("--a: #fff")}`,
      /@namespace is not allowed/,
    ],
    ["a selector outside the style", `${style("--a: #fff")}\nbody { color: red }`, /a rule other than a top-level/],
    [
      "another style's selector",
      `${style("--a: #fff")}\n:root[data-style="other"] { --pad: 1px }`,
      /a rule other than a top-level/,
    ],
  ] as const) {
    test(`refuses ${label}`, () => {
      const found = problems(css);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });
  }
  test("accepts a comment between declarations, but not one anywhere inside a value", () => {
    assert.deepEqual(problems(style("/* Surfaces */ --a: #fff; /* note */ --c: 1px 2px; /* end */")), []);
    for (const body of ["--b: /* note */ 1px", "--b: 1px /* end */", "--b: 1px/**/", "--b: 1px /* x */ 2px"])
      assert.ok(
        problems(style(body)).some((p) => /a comment inside a token value/.test(p)),
        body,
      );
  });
  test("accepts gradients and plain token values, in one or several top-level token rules", () => {
    assert.deepEqual(
      problems(
        `${style('--a: radial-gradient(120% 460px at 50% 0%, rgba(1, 2, 3, 0.2) 0%, transparent 70%); --b: 1px; --c: "str"')}
         :root[data-style="x"] { --pad: 8px }`,
      ),
      [],
    );
  });
});

describe("a style is tokens only (round-2 review)", () => {
  const style = (body: string) => `:root[data-style="x"] { ${body} }`;
  const problems = (css: string) => parseStyle("x", css).problems;
  for (const [label, css, expected] of [
    [
      "an ordinary property in the token rule (text-fill repro)",
      style("--a: #fff; -webkit-text-fill-color: transparent"),
      /-webkit-text-fill-color: only custom properties/,
    ],
    [
      "an ordinary property with var() (unparsed)",
      style("--a: #fff; color: var(--field)"),
      /color: only custom properties/,
    ],
    [
      "a descendant rule under the style (.value repro)",
      `${style("--a: #fff")}\n:root[data-style="x"] .value { color: var(--field) }`,
      /a rule other than a top-level .* token rule is not allowed/,
    ],
    ["a selector list", `:root[data-style="x"], :root[data-style="x"] { --a: #fff }`, /a rule other than/],
    ["another selector", `${style("--a: #fff")}\nbody { --a: #000 }`, /a rule other than/],
    [
      "a compound selector with the theme attribute",
      `${style("--a: #fff")}\n:root[data-style="x"][data-theme="dark"] { --a: #000 }`,
      /a rule other than/,
    ],
    [
      "an @media block",
      `${style("--a: #fff")}\n@media (max-width: 600px) { :root[data-style="x"] { --pad: 8px } }`,
      /@media is not allowed/,
    ],
    [
      "an @supports block",
      `${style("--a: #fff")}\n@supports (color: #000) { :root[data-style="x"] { --pad: 8px } }`,
      /@supports is not allowed/,
    ],
    [
      "an @supports block with a selector condition",
      `${style("--a: #fff")}\n@supports selector(:has(a)) { :root[data-style="x"] { --pad: 8px } }`,
      /@supports is not allowed/,
    ],
    [
      "an @container block",
      `${style("--a: #fff")}\n@container (min-width: 1px) { :root[data-style="x"] { --pad: 8px } }`,
      /@container is not allowed/,
    ],
    ["a nested rule", style("--a: #fff; & .value { color: red }"), /nested rule is not allowed|a rule other than/],
    [
      "a comment-split resource function in a token (u/**/rl repro)",
      style("--fx-static: u/**/rl(/outside.svg)"),
      /url\(\/outside\.svg\) is not allowed/,
    ],
    [
      "a comment-split resource function in a token that is declared again later",
      style("--fx-static: u/**/rl(/outside.svg); --fx-static: none"),
      /a comment inside a token value is not allowed/,
    ],
    [
      "a comment inside a token value, even without a function",
      style("--a: 1/**/px"),
      /a comment inside a token value/,
    ],
    [
      "a comment split inside a var() fallback",
      style("--a: var(--b, u/**/rl(x))"),
      /a comment inside a token value|url\(x\) is not allowed/,
    ],
    [
      "a comment-split image-set()",
      style('--fx-static: image-/**/set("/outside.svg" 1x)'),
      /image-set\(\) is not allowed/,
    ],
    [
      "an escaped resource function name in a token",
      style("--fx-static: \\75 rl(/outside.svg)"),
      /url\(.*\) is not allowed/,
    ],
  ] as const) {
    test(`refuses ${label}`, () => {
      const found = problems(css);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });
  }
  test("the minified form is checked from its own declarations, and the source declarations are kept", () => {
    const parsed = parseStyle("x", style("--a: /* note */ #fff; --b: u/**/rl(x)"));
    assert.deepEqual(
      parsed.declarations.map((d) => d.name),
      ["--a", "--b"],
    );
    assert.ok(
      parsed.problems.some((p) => /url\(x\) is not allowed/.test(p)),
      JSON.stringify(parsed.problems),
    );
  });
});

describe("resources in emitted CSS", () => {
  for (const [label, css, expected] of [
    ["a url() in a custom property", ":root{--fx-static:url(/outside.svg)}", /url\(\/outside\.svg\)/],
    ["a url() in a property", "body{background:url(a.png)}", /url\(a\.png\)/],
    ["an image-set()", ':root{--a:image-set("a.png" 1x)}', /image-set\(\)/],
    ["an @import", "@import url(x.css);", /@import/],
    ["an @font-face", "@font-face{font-family:X;src:url(x.woff2)}", /@font-face|url\(/],
    ["an @namespace", "@namespace svg url(http://www.w3.org/2000/svg);", /@namespace/],
    [
      "the u/**/rl repro as the build would emit it",
      ":root[data-style=calm]{--fx-static:url(/outside.svg)}",
      /url\(\/outside\.svg\)/,
    ],
  ] as const) {
    test(`finds ${label}`, () => {
      const found = findCssResources("a.css", css);
      assert.ok(
        found.some((f) => expected.test(f)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });
  }
  test("finds nothing in the shipped layout and styles", () => {
    assert.deepEqual(findCssResources("styles.css", readFileSync(join(ROOT, "src/styles.css"), "utf8")), []);
    for (const { id } of config.style.offered)
      assert.deepEqual(
        findCssResources(`${id}.css`, readFileSync(join(ROOT, `src/styles/${id}/style.css`), "utf8")),
        [],
      );
  });
});

describe("checkStyleSource", () => {
  test("accepts the shipped Calm style", () => {
    assert.deepEqual(problems(calm), []);
  });

  const cases: Array<[string, string, RegExp]> = [
    ["an @import", `@import url("x.css");\n${calm}`, /@import is not allowed/],
    ["an @import with a scheme", `@import "https://fonts.invalid/x.css";\n${calm}`, /@import is not allowed/],
    ["a web font", `${calm}\n@font-face { font-family: X; src: local(X); }`, /@font-face is not allowed/],
    [
      "a url() with a scheme",
      edit("--fx-follow: 0;", '--fx-follow: 0; --fx-static: url("https://x.invalid/a.png");'),
      /url\(.*\) is not allowed/,
    ],
    ["a missing required token", edit("--panel: light-dark(#ffffff, #19191d);", ""), /missing required token --panel/],
    ["a selector outside the style", `${calm}\nbody { color: red }`, /a rule other than a top-level/],
    ["another style's selector", `${calm}\n:root[data-style="other"] { --pad: 1px }`, /a rule other than a top-level/],
    ["a keyframes block", `${calm}\n@keyframes x { from { opacity: 0 } }`, /@keyframes is not allowed/],
    ["a property registration", `${calm}\n@property --x { syntax: "*"; inherits: false; }`, /@property is not allowed/],
    ["a layer", `${calm}\n@layer x;`, /@layer/],
    [
      "a colour token overridden in @media",
      `${calm}\n@media (min-width: 1px) { :root[data-style="calm"] { --text: #999; } }`,
      /@media is not allowed|--text is declared more than once/,
    ],
    [
      "an unreadable colour",
      edit("--accent: light-dark(#2457d6, #8db0ff);", "--accent: rgb(var(--x), 0, 0);"),
      /--x is never declared|unsupported colour function/,
    ],
    [
      "a translucent page background",
      edit("--bg: light-dark(#f5f5f6, #121214);", "--bg: rgba(0, 0, 0, 0.5);"),
      /must be an opaque colour/,
    ],
    [
      "muted text too light",
      edit("--muted: light-dark(#5f6270, #a0a1ab);", "--muted: light-dark(#999999, #a0a1ab);"),
      /--muted on --bg \(light\): text contrast 2\.61:1 is below 4\.5:1/,
    ],
    [
      "muted text too dark in dark mode",
      edit("--muted: light-dark(#5f6270, #a0a1ab);", "--muted: light-dark(#5f6270, #666666);"),
      /--muted on --bg \(dark\): text contrast/,
    ],
    [
      "accent text pair failing",
      edit("--on-accent: light-dark(#ffffff, #0b1430);", "--on-accent: light-dark(#8888ff, #0b1430);"),
      /--on-accent on --accent \(light\)/,
    ],
    [
      "a control colour too faint",
      edit("--line-strong: light-dark(#878b98, #72727e);", "--line-strong: light-dark(#cccccc, #72727e);"),
      /--line-strong on --bg \(light\): control contrast .* is below 3:1/,
    ],
    [
      "a meter step too faint",
      edit("--meter-4: light-dark(#1f7a3d, #6fd48f);", "--meter-4: light-dark(#dddddd, #6fd48f);"),
      /--meter-4 on --panel \(light\): control contrast/,
    ],
    [
      "a declared --fx-peak, which the layout never paints",
      edit("--fx-follow: 0;", "--fx-follow: 0; --fx-peak: light-dark(#ffffff, #000000);"),
      /--fx-peak is not a token the layout reads/,
    ],
    [
      "a !important token",
      edit("--pad: clamp(16px, 2.2vw, 28px);", "--pad: 1px !important;"),
      /!important is not allowed/,
    ],
    [
      "no top-level rule",
      `@media (min-width: 1px) { :root[data-style="calm"] { --bg: #fff } }`,
      /must declare its tokens in a top-level/,
    ],
    [
      "unparsable CSS",
      ':root[data-style="calm"] { --bg: #fff; ',
      /must declare its tokens|does not parse|missing required token/,
    ],
  ];
  for (const [label, css, expected] of cases)
    test(`refuses ${label}`, () => {
      const found = problems(css);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });

  test("a colour token used only through var() still resolves for the pair check", () => {
    const found = problems(edit("--ok: light-dark(#1f7a3d, #6fd48f);", "--ok: var(--accent);"));
    assert.deepEqual(found, []);
  });

  // Security review repro 3: the contrast check must not be fooled by an
  // escaped identifier or by an alias redefined under a condition.
  test("refuses an escaped identifier that redefines a text token to a surface (repro 3a)", () => {
    const found = problems(`${calm}\n:root[data-style="calm"] { --te\\78t: var(--field); }`);
    assert.ok(
      found.some((p) => /--text is declared more than once/.test(p)),
      JSON.stringify(found),
    );
  });
  test("refuses an alias of a colour token redefined inside @media (repro 3b)", () => {
    const css = `${edit("--text: light-dark(#16161a, #ececef);", "--text: var(--alias); --alias: light-dark(#16161a, #ececef);")}\n@media (prefers-color-scheme: dark) { :root[data-style="calm"] { --alias: #121214; } }`;
    const found = problems(css);
    assert.ok(
      found.some((p) => /--alias is declared more than once/.test(p)),
      JSON.stringify(found),
    );
  });
  test("refuses an alias declared only under a condition, a nested rule or another selector", () => {
    for (const extra of [
      `@supports (color: #000) { :root[data-style="calm"] { --alias: #fff; } }`,
      `:root[data-style="calm"] .gen { --alias: #fff; }`,
      `:root[data-style="calm"][data-theme="dark"] { --alias: #fff; }`,
    ]) {
      const found = problems(`${edit("--text: light-dark(#16161a, #ececef);", "--text: var(--alias);")}\n${extra}`);
      assert.ok(
        found.some((p) => /@supports is not allowed|a rule other than a top-level|--alias is declared outside/.test(p)),
        `${extra}: ${JSON.stringify(found)}`,
      );
    }
  });
  test("refuses an unresolvable chain and a reference cycle", () => {
    const missing = problems(edit("--text: light-dark(#16161a, #ececef);", "--text: var(--nowhere);"));
    assert.ok(
      missing.some((p) => /--nowhere is never declared/.test(p)),
      JSON.stringify(missing),
    );
    const cycle = problems(
      edit("--ok: light-dark(#1f7a3d, #6fd48f);", "--ok: var(--focus);").replace(
        "--focus: light-dark(#2457d6, #8db0ff);",
        "--focus: var(--ok);",
      ),
    );
    assert.ok(
      cycle.some((p) => /refers to itself/.test(p)),
      JSON.stringify(cycle),
    );
  });
  test("accepts a chain through known colour tokens, and refuses a private alias", () => {
    assert.deepEqual(problems(edit("--ok: light-dark(#1f7a3d, #6fd48f);", "--ok: var(--focus);")), []);
    const found = problems(
      edit("--text: light-dark(#16161a, #ececef);", "--text: var(--ink); --ink: light-dark(#16161a, #ececef);"),
    );
    assert.ok(
      found.some((p) => /--ink is not a token the layout reads/.test(p)),
      JSON.stringify(found),
    );
  });
});
