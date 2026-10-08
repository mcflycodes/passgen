import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { transform } from "lightningcss";
import { checkStyleSource, PAINTED_TOKENS, TEXT_PAIRS } from "../../scripts/lib/style-checks.ts";
import { TOKEN_TYPES } from "../../scripts/lib/style-grammar.ts";

const ROOT = join(import.meta.dirname, "../..");
const layout = readFileSync(join(ROOT, "src/styles.css"), "utf8");
const calm = readFileSync(join(ROOT, "src/styles/calm/style.css"), "utf8");

/** Every new token-driven property needs review, including future paint mechanisms. */
const NON_PAINT_PROPERTIES = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "text-transform",
  "height",
  "min-height",
  "gap",
  "padding",
  "margin",
  "margin-top",
  "margin-left",
  "scroll-padding-top",
  "border-radius",
  "background-size",
  "background-attachment",
]);
// Foregrounds have contrast pairs; focus has its own contrast check.
const MODELLED_FOREGROUNDS = new Set([...TEXT_PAIRS.map(([name]) => name), "--focus"]);

/**
 * Tokens the layout paints only where no text sits: the meter segments and
 * track (with --bad and --warn as the ramp's fallbacks), the slider track and
 * thumb, the checkbox box, the notice border ring, the hover ring and the
 * panel shadow. Reviewed by hand; a new entry here needs the same review.
 */
const NON_TEXT_PAINT = new Set([
  "--line",
  "--line-strong",
  "--bad",
  "--warn",
  "--meter-1",
  "--meter-2",
  "--meter-3",
  "--meter-4",
  "--meter-5",
  "--meter-6",
  "--shadow",
  "--fill",
  "--hairline",
  "--band-border",
]);

/** Every custom property the layout reads inside a painting declaration, as the parser sees it. */
function paintedByLayout(css = layout, unreviewedProperties = new Set<string>()): Set<string> {
  const names = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const walk = (value: unknown, target = names) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, target);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "var") {
      const ident = (node.value as { name?: { ident?: string } } | undefined)?.name?.ident;
      if (typeof ident === "string") target.add(ident);
    }
    for (const child of Object.values(node)) walk(child, target);
  };
  transform({
    filename: "styles.css",
    code: Buffer.from(css),
    visitor: {
      Declaration(declaration) {
        const property =
          declaration.property === "unparsed"
            ? (declaration.value as { propertyId?: { property?: string } }).propertyId?.property
            : declaration.property === "custom"
              ? (declaration.value as { name: string }).name
              : declaration.property;
        if (property?.startsWith("--")) {
          const dependencies = new Set<string>();
          walk(declaration, dependencies);
          aliases.set(property, dependencies);
        }
        if (property !== undefined && !NON_PAINT_PROPERTIES.has(property) && !property.startsWith("--")) {
          const tokens = new Set<string>();
          walk(declaration, tokens);
          for (const name of tokens) names.add(name);
          // A new paint mechanism must be reviewed even if it reuses a known token.
          if (
            tokens.size > 0 &&
            !/^(?:background(?:-|$)|box-shadow$|border(?:-|$)|outline(?:-|$)|color$)/.test(property)
          )
            unreviewedProperties.add(property);
        }
      },
    },
  });
  for (const name of names) for (const dependency of aliases.get(name) ?? []) names.add(dependency);
  return names;
}

describe("the contrast model and the layout cannot drift apart", () => {
  const unreviewedProperties = new Set<string>();
  const painted = paintedByLayout(layout, unreviewedProperties);

  test("every token the layout paints is either modelled behind text or reviewed as never behind text", () => {
    assert.deepEqual([...unreviewedProperties], [], "new token-driven paint mechanisms need review");
    for (const name of painted) {
      assert.ok(
        PAINTED_TOKENS.includes(name) || MODELLED_FOREGROUNDS.has(name) || NON_TEXT_PAINT.has(name),
        `${name} is painted by the layout but neither modelled nor reviewed as non-text paint`,
      );
    }
  });

  test("every modelled token is painted by the layout, so the model never trusts a declared value", () => {
    for (const name of PAINTED_TOKENS)
      assert.ok(painted.has(name), `${name} is modelled but the layout never paints it`);
  });

  test("the two lists do not overlap, and every entry is a typed token", () => {
    for (const name of PAINTED_TOKENS) assert.ok(!NON_TEXT_PAINT.has(name), name);
    for (const name of [...PAINTED_TOKENS, ...NON_TEXT_PAINT]) {
      if (name === "--fill") continue; // the slider's runtime property, never a style token
      if (name === "--hairline") continue; // layout-local alias defined in src/styles.css
      assert.ok(TOKEN_TYPES[name], `${name} is typed`);
    }
  });

  test("a style declaring a token the layout never paints fails (the --fx-peak repro)", () => {
    const css = calm
      .replace(
        /--fx-static: radial-gradient\([^;]*\);/,
        "--fx-static: linear-gradient(light-dark(#34353c, #c9c9d0), light-dark(#34353c, #c9c9d0));",
      )
      .replace("--fx-follow: 0;", "--fx-follow: 0; --fx-peak: light-dark(#ffffff, #000000);");
    const found = checkStyleSource("calm", css).map((p) => p.problem);
    assert.ok(
      found.some((p) => /--fx-peak is not a token the layout reads/.test(p)),
      JSON.stringify(found),
    );
    // And without the peak, the veil itself is caught by the footer bound.
    const veilOnly = calm.replace(
      /--fx-static: radial-gradient\([^;]*\);/,
      "--fx-static: linear-gradient(light-dark(#34353c, #c9c9d0), light-dark(#34353c, #c9c9d0));",
    );
    const veil = checkStyleSource("calm", veilOnly).map((p) => p.problem);
    assert.ok(
      veil.some((p) => /--text-2 on the footer .*can fall to 1\.00:1/.test(p)),
      JSON.stringify(veil),
    );
  });

  test("the intro stacks the grid and the glow over the band, each with its transparent stops", () => {
    // A grid line and a glow that each pass alone but veil the intro text together.
    const css = calm
      .replace("--bg-band: light-dark(#f5f5f6, #121214);", "--bg-band: transparent;")
      .replace(
        "--grid-line: transparent;",
        "--grid-line: light-dark(rgba(22, 22, 26, 0.15), rgba(236, 236, 239, 0.15));",
      )
      .replace(
        "--intro-glow: transparent;",
        "--intro-glow: light-dark(rgba(22, 22, 26, 0.15), rgba(236, 236, 239, 0.15));",
      );
    const found = checkStyleSource("calm", css).map((p) => p.problem);
    assert.ok(
      found.some((p) => /--text-2 on the intro background/.test(p)),
      JSON.stringify(found),
    );
    const gridOnly = calm
      .replace("--bg-band: light-dark(#f5f5f6, #121214);", "--bg-band: transparent;")
      .replace(
        "--grid-line: transparent;",
        "--grid-line: light-dark(rgba(22, 22, 26, 0.15), rgba(236, 236, 239, 0.15));",
      );
    assert.deepEqual(
      checkStyleSource("calm", gridOnly).filter((p) => /intro background/.test(p.problem)),
      [],
    );
  });
});

for (const property of [
  "border-color",
  "outline-color",
  "color",
  "text-shadow",
  "-webkit-text-stroke",
  "filter",
  "backdrop-filter",
  "mask",
  "mask-image",
  "fill",
  "stroke",
  "future-paint-property",
])
  test(`paint audit observes token-driven ${property}, including on pseudo-elements`, () => {
    assert.ok(paintedByLayout(`.probe::before { ${property}: var(--unreviewed-paint); }`).has("--unreviewed-paint"));
  });

for (const property of [
  "text-shadow",
  "-webkit-text-stroke",
  "filter",
  "backdrop-filter",
  "mask",
  "fill",
  "stroke",
  "future-paint-property",
])
  test(`new ${property} needs review even with an already modelled token`, () => {
    const unreviewed = new Set<string>();
    paintedByLayout(
      `.existing { background: var(--accent); } .probe::before { ${property}: var(--accent); }`,
      unreviewed,
    );
    assert.deepEqual([...unreviewed], [property]);
  });

test("reviewed paint aliases cannot conceal unreviewed tokens", () => {
  assert.ok(
    paintedByLayout(":root { --hairline: 1px solid var(--unreviewed); } .probe { border: var(--hairline); }").has(
      "--unreviewed",
    ),
  );
});
