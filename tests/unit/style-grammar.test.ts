import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  checkStyleSource,
  contrastRatio,
  layerBox,
  luminance,
  overBox,
  parseStyle,
  type Rgba,
} from "../../scripts/lib/style-checks.ts";
import { checkTokenValue, GRADIENT_LIMITS, SHADOW_LIMITS, TOKEN_TYPES } from "../../scripts/lib/style-grammar.ts";
import config from "../../src/config/config.json" with { type: "json" };

const ROOT = join(import.meta.dirname, "../..");
const calm = readFileSync(join(ROOT, "src/styles/calm/style.css"), "utf8");
const problems = (css: string) => checkStyleSource("calm", css).map((p) => p.problem);
const edit = (from: string, to: string) => {
  assert.ok(calm.includes(from), `fixture contains ${from}`);
  return calm.replace(from, to);
};
/** Problems of one token value, judged by its own spec. */
const value = (name: string, text: string) => {
  const parsed = parseStyle("x", `:root[data-style="x"] { ${name}: ${text} }`);
  const declaration = parsed.declarations[0];
  assert.ok(declaration, "parsed");
  const spec = TOKEN_TYPES[name];
  assert.ok(spec, `${name} has a spec`);
  return checkTokenValue(name, declaration.value, spec).problems;
};

describe("the token table", () => {
  test("every token the shipped styles declare is typed, and every shipped style passes", () => {
    for (const { id } of config.style.offered) {
      const css = readFileSync(join(ROOT, `src/styles/${id}/style.css`), "utf8");
      for (const d of parseStyle(id, css).declarations) assert.ok(TOKEN_TYPES[d.name], `${id}: ${d.name} is typed`);
      assert.deepEqual(checkStyleSource(id, css), [], id);
    }
  });
  test("every token the layout reads is in the table, and nothing else is accepted", () => {
    const layout = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    const read = new Set([...layout.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string));
    const own = new Set(["--hairline", "--fill", "--px", "--py", "--pxs", "--pys", "--pxt", "--pyt", "--pxn", "--pyn"]);
    for (const name of read) if (!own.has(name)) assert.ok(TOKEN_TYPES[name], `${name} is typed`);
    assert.ok(
      problems(`${calm}\n:root[data-style="calm"] { --my-color: #fff; }`).some((p) =>
        /--my-color is not a token the layout reads/.test(p),
      ),
    );
    assert.ok(
      problems(`${calm}\n:root[data-style="calm"] { --hairline: 1px solid red; }`).some((p) =>
        /--hairline is not a token/.test(p),
      ),
    );
    assert.ok(problems(`${calm}\n:root[data-style="calm"] { --px: 50%; }`).some((p) => /--px is not a token/.test(p)));
  });
});

describe("surfaces under text are opaque", () => {
  for (const name of ["--bg", "--panel", "--field", "--chip"]) {
    test(`${name} may not carry alpha or be transparent`, () => {
      const lightDark = calm.match(new RegExp(`${name}: (light-dark\\([^;]*\\));`))?.[1] as string;
      for (const bad of [
        "transparent",
        "rgba(255, 255, 255, 0.5)",
        "light-dark(#ffffff, rgba(0, 0, 0, 0.9))",
        "#ffffff80",
      ]) {
        const found = problems(edit(`${name}: ${lightDark};`, `${name}: ${bad};`));
        assert.ok(
          found.some((p) => new RegExp(`${name} \\((light|dark)\\): must be an opaque colour`).test(p)),
          `${bad}: ${JSON.stringify(found)}`,
        );
      }
    });
  }
  test("the security review repro (transparent field under a text-coloured inset shadow) fails", () => {
    const found = problems(
      edit("--field: light-dark(#ffffff, #141417);", "--field: transparent;").replace(
        /--shadow:[^;]*;/,
        "--shadow: inset 0 0 0 10000px var(--text);",
      ),
    );
    assert.ok(
      found.some((p) => /--field \(light\): must be an opaque colour/.test(p)),
      JSON.stringify(found),
    );
    assert.ok(
      found.some((p) => /inset shadows are not allowed/.test(p)),
      JSON.stringify(found),
    );
    assert.ok(
      found.some((p) => /shadow colour must be a literal, never var\(\)/.test(p)),
      JSON.stringify(found),
    );
  });
  test("decorative colours may carry alpha", () => {
    assert.deepEqual(problems(edit("--line: light-dark(#e1e2e7, #2a2a31);", "--line: rgba(0, 0, 0, 0.1);")), []);
  });
});

describe("shadows", () => {
  test("accept none and bounded outer shadows with literal colours", () => {
    assert.deepEqual(value("--shadow", "none"), []);
    assert.deepEqual(
      value("--shadow", "0 1px 2px rgba(0, 0, 0, 0.1), 0 8px 24px -16px light-dark(#00000030, transparent)"),
      [],
    );
    assert.deepEqual(value("--shadow", "0 20px 50px -24px rgba(109, 40, 217, 0.55)"), []);
    assert.deepEqual(value("--shadow", "0 0 0 1px transparent"), []);
  });
  for (const [label, text, expected] of [
    ["an inset shadow alone", "inset 0 0 0 1px #000", /inset shadows are not allowed/],
    ["an inset shadow with a literal colour", "inset 0 0 0 10000px #000", /inset shadows are not allowed/],
    ["a var() colour", "0 1px 2px var(--text)", /must be a literal, never var\(\)/],
    ["a var() to a non-text token", "0 1px 2px var(--line)", /must be a literal, never var\(\)/],
    ["a huge spread", `0 0 0 ${SHADOW_LIMITS.spreadMax + 1}px #000`, /spread must be/],
    ["a huge negative spread", `0 0 0 ${SHADOW_LIMITS.spreadMin - 1}px #000`, /spread must be/],
    ["a huge blur", `0 0 ${SHADOW_LIMITS.blur + 1}px #000`, /blur must be/],
    ["a huge offset", `${SHADOW_LIMITS.offset + 1}px 0 0 #000`, /offsets must stay within/],
    ["a negative blur", "0 0 -1px #000", /blur must be/],
    ["too few lengths", "1px #000", /two to four lengths/],
    ["too many lengths", "1px 1px 1px 1px 1px #000", /two to four lengths/],
    ["a length in em", "0 1em 0 #000", /a shadow is/],
    ["two colours", "0 1px 0 #000 #fff", /a shadow is/],
    ["a colour the parser cannot compute", "0 1px 0 rgb(var(--x), 0, 0)", /a shadow is/],
    ["a keyword other than none", "unset", /a shadow is/],
    ["an empty item", "0 1px 0 #000,", /empty shadow/],
  ] as const) {
    test(`refuse ${label}`, () => {
      const found = value("--shadow", text);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });
  }
});

describe("gradients", () => {
  test("accept the shipped forms: literal stops, pointer positions, arithmetic", () => {
    assert.deepEqual(value("--fx-static", "none"), []);
    assert.deepEqual(
      value(
        "--fx-pointer",
        "radial-gradient(600px circle at var(--pxs) var(--pys), light-dark(rgba(6, 182, 212, 0.2), rgba(34, 211, 238, 0.17)) 0%, transparent 70%)",
      ),
      [],
    );
    assert.deepEqual(
      value(
        "--fx-pointer",
        "linear-gradient(calc(160deg + (var(--pxn) - 0.5) * 70deg), transparent 34%, rgba(124, 58, 237, 0.15) 50%, transparent 66%)",
      ),
      [],
    );
    assert.deepEqual(
      value(
        "--fx-static",
        "repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.035) 0 1px, transparent 1px 56px), radial-gradient(circle at 1px 1px, #000 1px, transparent 1.6px)",
      ),
      [],
    );
  });
  for (const [label, text, expected] of [
    [
      "a var() of a colour token",
      "linear-gradient(var(--text), #fff)",
      /may only read the pointer position through var\(\), not --text/,
    ],
    ["a var() of --hairline", "linear-gradient(var(--hairline), #fff)", /not --hairline/],
    ["a string", 'linear-gradient("x", #fff)', /may not contain string token/],
    ["a url()", "linear-gradient(url(x), #fff)", /may not contain url\(\)/],
    ["an unknown function", "linear-gradient(env(x), #fff)", /may not contain env\(\)/],
    ["an unknown word", "linear-gradient(to nowhere, #fff)", /may not contain ident token "nowhere"/],
    ["a non-gradient function", "image-set(#fff)", /must be none or a list of/],
    ["a bare colour", "#fff", /must be none or a list of/],
    [
      "a var() inside calc() that is not the pointer",
      "linear-gradient(calc(1deg * var(--display-weight)), #fff, #000)",
      /arithmetic may only read the pointer position/,
    ],
  ] as const) {
    test(`refuse ${label}`, () => {
      const found = value("--fx-static", text);
      assert.ok(
        found.some((p) => expected.test(p)),
        `${label}: ${JSON.stringify(found)}`,
      );
    });
  }
  // Calm's intro band is opaque, so its gradients never show under the intro
  // text; with a transparent band they do, and the worst stop must still carry the text.
  const strongStatic = (css: string) =>
    css.replace(
      /--fx-static: radial-gradient\([^;]*\);/,
      "--fx-static: radial-gradient(120% 460px at 50% 0%, light-dark(rgba(36, 87, 214, 0.95), rgba(141, 176, 255, 0.16)) 0%, transparent 70%);",
    );
  test("a gradient stop under a transparent band is checked against the intro text", () => {
    const calmTransparentBand = edit("--bg-band: light-dark(#f5f5f6, #121214);", "--bg-band: transparent;");
    assert.deepEqual(problems(calmTransparentBand), []);
    const found = problems(strongStatic(calmTransparentBand));
    assert.ok(
      found.some((p) => /--text-2 on the intro background .*\(light\)/.test(p)),
      JSON.stringify(found),
    );
  });
  test("an opaque band hides the gradients from the intro text, and the check knows it", () => {
    assert.deepEqual(
      problems(strongStatic(calm)).filter((p) => /intro background/.test(p)),
      [],
    );
  });
  test("a gradient stop that would show through the header fails the contrast check", () => {
    const found = problems(
      calm.replace(
        /--fx-static: radial-gradient\([^;]*\);/,
        "--fx-static: radial-gradient(120% 460px at 50% 0%, rgba(0, 0, 0, 1) 0%, transparent 70%);",
      ),
    );
    assert.ok(
      found.some((p) => /on the header \(90% --bg over the page or a panel\) \(light\)/.test(p)),
      JSON.stringify(found),
    );
  });
});

describe("stacked layers are composited and bounded (round-4 review)", () => {
  const transparentBand = edit("--bg-band: light-dark(#f5f5f6, #121214);", "--bg-band: transparent;");
  const withStatic = (css: string, gradient: string) =>
    css.replace(/--fx-static: radial-gradient\([^;]*\);/, `--fx-static: ${gradient};`);
  const veil = "linear-gradient(rgba(22, 22, 26, 0.3), rgba(22, 22, 26, 0.3))";
  test("one translucent layer passes, three stacked copies of it fail composited (repro 1, bounded)", () => {
    assert.deepEqual(problems(withStatic(transparentBand, veil)), []);
    const found = problems(withStatic(transparentBand, [veil, veil, veil].join(", ")));
    assert.ok(
      found.some((p) => /--text-2 on the intro background .*\(light\)/.test(p)),
      JSON.stringify(found),
    );
  });
  test("four layers are refused for complexity, never truncated (repro 1 as reported)", () => {
    const found = problems(withStatic(transparentBand, [veil, veil, veil, veil].join(", ")));
    assert.ok(
      found.some((p) => /--fx-static: may have at most 3 layers, not 4/.test(p)),
      JSON.stringify(found),
    );
  });
  test("a layer that matches the footer's text colour fails the footer check (repro 2)", () => {
    for (const layer of [
      "linear-gradient(light-dark(#5f6270, #a0a1ab), light-dark(#5f6270, #a0a1ab))", // the reported repro, --muted
      "linear-gradient(light-dark(#34353c, #c9c9d0), light-dark(#34353c, #c9c9d0))", // the footer's --text-2
    ]) {
      const found = problems(withStatic(calm, layer));
      assert.ok(
        found.some((p) => /--text-2 on the footer \(the page with its decorative layers\) \((light|dark)\)/.test(p)),
        JSON.stringify(found),
      );
    }
  });
  test("more than eight stops are refused, so no stop is ever ignored (repro 3)", () => {
    const stops = `${Array.from({ length: 24 }, () => "transparent 0%").join(", ")}, #16161a 1%, #16161a 100%`;
    const found = problems(withStatic(transparentBand, `linear-gradient(${stops})`));
    assert.ok(
      found.some((p) => /a gradient may have at most 8 colour stops, not 26/.test(p)),
      JSON.stringify(found),
    );
    const nine = `linear-gradient(${Array.from({ length: 9 }, () => "transparent").join(", ")})`;
    assert.ok(problems(withStatic(calm, nine)).some((p) => /at most 8 colour stops, not 9/.test(p)));
    const eight = `linear-gradient(${Array.from({ length: 8 }, () => "transparent").join(", ")})`;
    assert.deepEqual(problems(withStatic(calm, eight)), []);
  });
  test("a dark stop late in a stop list is found even with a transparent band", () => {
    const found = problems(
      withStatic(transparentBand, "linear-gradient(transparent 0%, transparent 1%, #16161a 2%, #16161a 100%)"),
    );
    assert.ok(
      found.some((p) => /--text on the intro background .*\(light\)/.test(p)),
      JSON.stringify(found),
    );
  });
  test("pointer layers stack over static layers in paint order", () => {
    // A pointer veil over a static veil composites to a darker page than either alone.
    const css = withStatic(transparentBand, veil).replace(
      "--fx-follow: 0;",
      `--fx-follow: 1; --fx-pointer: ${veil}, ${veil};`,
    );
    const found = problems(css);
    assert.ok(
      found.some((p) => /--text-2 on the intro background/.test(p)),
      JSON.stringify(found),
    );
  });
  test("every shipped style stays within the layer and stop limits", () => {
    for (const { id } of config.style.offered) {
      const css = readFileSync(join(ROOT, `src/styles/${id}/style.css`), "utf8");
      for (const d of parseStyle(id, css).declarations.filter(
        (d) => d.name === "--fx-static" || d.name === "--fx-pointer",
      )) {
        const result = checkTokenValue(d.name, d.value, TOKEN_TYPES[d.name] as never);
        assert.ok(result.layers.length <= GRADIENT_LIMITS.layers, `${id} ${d.name} layers`);
        for (const layer of result.layers) assert.ok(layer.length <= GRADIENT_LIMITS.stops, `${id} ${d.name} stops`);
      }
    }
  });
});

describe("the interval bound (round-5 review)", () => {
  const transparentBand = edit("--bg-band: light-dark(#f5f5f6, #121214);", "--bg-band: transparent;");
  const withStatic = (css: string, gradient: string) =>
    css.replace(/--fx-static: radial-gradient\([^;]*\);/, `--fx-static: ${gradient};`);
  // The reviewer's repro: two opaque stops that each clear AA against the
  // footer text, whose midpoint rgb(127, 148, 128) gives only 3.75:1.
  const repro = "linear-gradient(90deg, light-dark(#ff7800, #121214) 0px, light-dark(#00b0ff, #121214) 600px)";
  test("the midpoint between two passing stops is caught where an endpoint check was not (repro)", () => {
    const text2 = { r: 0x34, g: 0x35, b: 0x3c, a: 1 };
    for (const stop of [
      { r: 255, g: 120, b: 0, a: 1 },
      { r: 0, g: 176, b: 255, a: 1 },
    ])
      assert.ok(contrastRatio(text2, stop) >= 4.5, "each stop alone passes");
    assert.ok(contrastRatio(text2, { r: 127, g: 148, b: 128, a: 1 }) < 4.5, "the midpoint fails");
    const found = problems(withStatic(calm, repro));
    assert.ok(
      found.some((p) => /--text-2 on the footer .*\(light\): text contrast can fall to/.test(p)),
      JSON.stringify(found),
    );
  });
  test("a layer box spans every stop per premultiplied channel and alpha", () => {
    const box = layerBox([
      { r: 255, g: 120, b: 0, a: 1 },
      { r: 0, g: 176, b: 255, a: 0.5 },
      { r: 0, g: 0, b: 0, a: 0 },
    ]);
    assert.deepEqual(box, { pLo: [0, 0, 0], pHi: [255, 120, 127.5], aLo: 0, aHi: 1 });
  });
  test("compositing a box is conservative: it contains every rendered combination", () => {
    const stops = [
      { r: 255, g: 120, b: 0, a: 0.3 },
      { r: 0, g: 176, b: 255, a: 0.1 },
    ];
    const bg = { r: 245, g: 245, b: 246, a: 1 };
    const box = overBox(layerBox(stops), { lo: bg, hi: bg });
    for (let t = 0; t <= 1; t += 0.05) {
      // Premultiplied interpolation between the two stops, then source-over onto bg.
      const [a0, a1] = [stops[0] as Rgba, stops[1] as Rgba];
      const a = a0.a + (a1.a - a0.a) * t;
      const premul = (c0: number, c1: number) => c0 * a0.a + (c1 * a1.a - c0 * a0.a) * t;
      const px = {
        r: premul(a0.r, a1.r) + (1 - a) * bg.r,
        g: premul(a0.g, a1.g) + (1 - a) * bg.g,
        b: premul(a0.b, a1.b) + (1 - a) * bg.b,
      };
      for (const ch of ["r", "g", "b"] as const) {
        assert.ok(px[ch] >= box.lo[ch] - 1e-9 && px[ch] <= box.hi[ch] + 1e-9, `${ch} at t=${t}`);
      }
    }
  });
  test("luminance is monotone per channel, so the corners bound every pixel", () => {
    const lo = { r: 10, g: 20, b: 30, a: 1 };
    const hi = { r: 200, g: 210, b: 220, a: 1 };
    for (const [r, g, b] of [
      [10, 210, 30],
      [200, 20, 220],
      [100, 100, 100],
      [10, 20, 220],
    ]) {
      const l = luminance({ r: r as number, g: g as number, b: b as number, a: 1 });
      assert.ok(l >= luminance(lo) && l <= luminance(hi));
    }
  });
  test("text whose luminance lies inside the box can be shown at 1:1 and is refused", () => {
    // A layer spanning from darker than the text to lighter than it, under a transparent band.
    const found = problems(withStatic(transparentBand, "linear-gradient(#000000, #ffffff)"));
    assert.ok(
      found.some((p) => /--text-2 on the intro background .*: text contrast can fall to 1\.00:1/.test(p)),
      JSON.stringify(found),
    );
  });
  test("the shipped Purple light soft light at 0.16 fails the bound and 0.15 passes", () => {
    const purple = readFileSync(join(ROOT, "src/styles/purple/style.css"), "utf8");
    assert.deepEqual(checkStyleSource("purple", purple), []);
    const was = purple.replace(
      "rgba(167, 139, 250, 0.15), rgba(167, 139, 250, 0.19)",
      "rgba(167, 139, 250, 0.16), rgba(167, 139, 250, 0.24)",
    );
    assert.notEqual(was, purple);
    const found = checkStyleSource("purple", was).map((p) => p.problem);
    assert.ok(
      found.some((p) => /--text-2 on the (intro|footer).*\(light\)/.test(p)),
      JSON.stringify(found),
    );
    assert.ok(
      found.some((p) => /--text-2 on the (intro|footer).*\(dark\)/.test(p)),
      JSON.stringify(found),
    );
  });
});

describe("other token types", () => {
  const cases: Array<[string, string, boolean, RegExp?]> = [
    ["--radius", "10px", true],
    ["--radius-sm", "999px", true],
    ["--radius", "50%", true],
    ["--radius", "1001px", false, /must be a radius/],
    ["--radius", "-1px", false, /must be a radius/],
    ["--radius", "60%", false, /must be a radius/],
    ["--radius", "var(--pad)", false, /must be a radius/],
    ["--band-gap", "-1px", true],
    ["--band-gap", "-9px", false, /from -8px to 64px/],
    ["--panel-gap", "0", true],
    ["--panel-gap", "1em", false, /must be a length in px/],
    ["--pad", "clamp(16px, 2.2vw, 28px)", true],
    ["--pad", "clamp(16px, 20vw, 28px)", false, /clamp\(\) must be/],
    ["--pad", "clamp(16px, 2vw, 99px)", false, /clamp\(\) must be/],
    ["--pad", "min(16px, 2vw)", false, /must be a length in px or a clamp\(\)/],
    ["--row-gap", "49px", false, /from 0px to 48px/],
    ["--control-h", "40px", true],
    ["--header-h", "200px", false, /from 40px to 120px/],
    ["--display-weight", "620", true],
    ["--display-weight", "50", false, /from 100 to 1000/],
    ["--display-weight", "bold", false, /plain number/],
    ["--fx-follow", "1", true],
    ["--fx-follow", "2", false, /from 0 to 1/],
    ["--fx-rest-x", "0.62", true],
    ["--fx-rest-x", "999", false, /from 0 to 1/],
    ["--fx-attach", "scroll", true],
    ["--fx-attach", "local", false, /one of fixed, scroll/],
    ["--fx-size", "26px 26px", true],
    ["--fx-size", "auto", true],
    ["--fx-size", "0px", false, /1px to 512px/],
    ["--fx-size", "cover", false, /must be auto/],
    ["--tagline-case", "uppercase", true],
    ["--tagline-case", "full-width", false, /one of none/],
    ["--tagline-size", "12px", true],
    ["--tagline-size", "40px", false, /10px to 20px/],
    ["--track", "-0.05em", true],
    ["--track", "0", true],
    ["--track", "1em", false, /letter-spacing/],
    ["--tagline-track", "var(--label-track)", true],
    ["--tagline-track", "var(--text)", false, /may only refer to --label-track or --track/],
    ["--label-track", "var(--track)", false, /may only refer to nothing/],
    ["--sans", 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif', true],
    ["--tagline-font", "var(--mono)", true],
    ["--tagline-font", "var(--text)", false, /may only refer to --sans or --mono/],
    ["--mono", "url(x)", false, /plain name|url/],
    ["--mono", '"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"', false, /1 to 12 font families/],
    ["--sans", "ui-sans-serif, 12px", false, /plain name/],
    ["--band-border", "0", true],
    ["--band-border", "none", true],
    ["--band-border", "var(--hairline)", true],
    ["--band-border", "1px solid #000", true],
    ["--band-border", "1px solid var(--line)", true],
    ["--band-border", "5px solid #000", false, /must be 0, none/],
    ["--band-border", "1px dashed #000", false, /must be 0, none/],
    ["--band-border", "1px solid var(--text)", false, /must be 0, none/],
    ["--band-border", "var(--line)", false, /must be 0, none/],
  ];
  for (const [name, text, ok, expected] of cases) {
    test(`${name}: ${text} is ${ok ? "accepted" : "refused"}`, () => {
      const found = value(name, text);
      if (ok) assert.deepEqual(found, []);
      else
        assert.ok(
          found.some((p) => (expected as RegExp).test(p)),
          JSON.stringify(found),
        );
    });
  }
});
