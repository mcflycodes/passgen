// The automatic checks every style must pass (requirement R4b). A style is one
// stylesheet, src/styles/<id>/style.css, that sets design tokens under
// :root[data-style="<id>"]; src/styles/README.md is the style guide.
//
// Everything is judged on the stylesheet as lightningcss parses and decodes
// it (escapes resolved, identifiers normalised), never on text matching.
// Pure functions: `checkStyleSource` judges one stylesheet's text, and
// `checkStyles` reads the offered styles of a configuration from disk. The
// build (vite.config.ts) and `pnpm styles:check` run them; a style that fails
// stops the build before any file is emitted.
//
// What is checked:
// - the stylesheet parses, and is token-only: it contains nothing but
//   custom-property declarations (`--*`) inside top-level rules whose
//   selector is exactly the style's own `:root[data-style="<id>"]`. Any other
//   selector, any ordinary property, any at-rule (@media, @supports, @import,
//   @font-face, @namespace, …) and any nesting is refused. The shared layout
//   stylesheet does all real styling from the tokens;
// - the same checks are run again on the stylesheet re-serialised and
//   minified by lightningcss, so a value that only turns into a resource
//   once comments are dropped (`u/**/rl(…)`) is refused too;
// - no external resource of any kind, anywhere, including custom-property
//   values: no url(), no image function (image-set(), image(), cross-fade(),
//   element(), paint(), …), no @import, @font-face, @namespace, no src
//   descriptor, no string inside an image function. Styles are tokens plus
//   CSS gradients (R4c), so there is nothing a style may load;
// - every required token is declared in the top-level rule, so both themes
//   are covered (a `light-dark()` pair, or one value for both);
// - every token is one the layout reads, and its value parses as that
//   token's declared type within its bounds (scripts/lib/style-grammar.ts):
//   opaque colours for the surfaces under text, outer shadows only with
//   bounded geometry and literal colours, gradients with literal stops, and
//   so on; an unknown token is refused;
// - the colour tokens, and every token they reach through var(), are declared
//   exactly once, in the top-level rule, as hex, rgb() or rgba() colours,
//   `transparent`, `light-dark()` pairs of those, or var() of another such
//   token; a conditional, nested or repeated declaration, an unresolvable
//   chain or an unreadable colour is refused;
// - WCAG 2.2 AA contrast for the token pairs below, in light and in dark:
//   4.5:1 for text pairs and 3:1 for control and meter colours (1.4.3, 1.4.11).

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { transform } from "lightningcss";
import { checkTokenValue, TOKEN_TYPES } from "./style-grammar.ts";

export interface StyleProblem {
  readonly style: string;
  readonly problem: string;
}

/** The style section of the configuration (C1). */
export interface StyleConfig {
  readonly default: string;
  readonly offered: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/** Where a style's folder and stylesheet live under the project root. */
export const STYLES_DIR = "src/styles";
export const styleFolder = (id: string) => posix.join(STYLES_DIR, id);
export const styleSheet = (id: string) => posix.join(STYLES_DIR, id, "style.css");

/** Tokens every style must declare (the style guide's required list). */
export const REQUIRED_TOKENS: readonly string[] = [
  // Surfaces
  "--bg",
  "--bg-band",
  "--panel",
  "--field",
  "--chip",
  // Lines
  "--line",
  "--line-strong",
  "--grid-line",
  "--intro-glow",
  // Text
  "--text",
  "--text-2",
  "--muted",
  // Accent and states
  "--accent",
  "--on-accent",
  "--focus",
  "--bad",
  "--warn",
  "--ok",
  // Shape
  "--radius",
  "--radius-sm",
  "--thumb-radius",
  "--shadow",
  "--band-border",
  "--band-gap",
  "--panel-gap",
  // Type
  "--sans",
  "--mono",
  "--track",
  "--display-weight",
  "--label-track",
  // Spacing
  "--pad",
  "--row-gap",
  "--control-h",
  "--header-h",
];

/** Optional meter ramp tokens; checked for contrast when declared. */
export const METER_TOKENS: readonly string[] = [
  "--meter-1",
  "--meter-2",
  "--meter-3",
  "--meter-4",
  "--meter-5",
  "--meter-6",
];

/** Tokens the contrast check reads as colours. */
export const COLOR_TOKENS: readonly string[] = [
  "--bg",
  "--bg-band",
  "--grid-line",
  "--intro-glow",
  "--panel",
  "--field",
  "--chip",
  "--line-strong",
  "--text",
  "--text-2",
  "--muted",
  "--accent",
  "--on-accent",
  "--focus",
  "--bad",
  "--warn",
  "--ok",
  ...METER_TOKENS,
];

/** Surfaces text sits on, each composited over `--bg`. `intro` is the worst case under the intro text. */
const SURFACES = ["--bg", "--panel", "--field", "--chip"] as const;

/**
 * The tokens the layout paints where text can sit, which the contrast model
 * composites: the opaque surfaces, the intro band with its glow and grid, the
 * accent and ok fills under their text, and the two decorative gradient
 * layers. tests/unit/style-model.test.ts cross-checks this list against what
 * src/styles.css paints, so the model and the layout cannot drift apart.
 */
export const PAINTED_TOKENS: readonly string[] = [
  ...SURFACES,
  "--bg-band",
  "--intro-glow",
  "--grid-line",
  "--accent",
  "--ok",
  "--fx-static",
  "--fx-pointer",
];

/** Text (4.5:1) on the surfaces it is drawn on. */
export const TEXT_PAIRS: ReadonlyArray<readonly [foreground: string, surface: string]> = [
  ["--text", "--bg"],
  ["--text", "--panel"],
  ["--text", "--field"],
  ["--text", "--chip"],
  ["--text", "intro"],
  ["--text-2", "--bg"],
  ["--text-2", "--panel"],
  ["--text-2", "--field"],
  ["--text-2", "intro"],
  ["--muted", "--bg"],
  ["--muted", "--panel"],
  ["--muted", "--field"],
  ["--on-accent", "--accent"],
  ["--on-accent", "--ok"],
  ["--bad", "--panel"],
  ["--warn", "--panel"],
];

/** Controls, borders, focus rings and meter segments (3:1) on the surfaces they sit on. */
export const UI_PAIRS: ReadonlyArray<readonly [foreground: string, surface: string]> = [
  ["--accent", "--bg"],
  ["--accent", "--panel"],
  ["--accent", "--field"],
  ["--line-strong", "--bg"],
  ["--line-strong", "--panel"],
  ["--line-strong", "--field"],
  ["--focus", "--bg"],
  ["--focus", "--panel"],
  ["--focus", "--field"],
  ["--ok", "--panel"],
  ...METER_TOKENS.map((token) => [token, "--panel"] as const),
];

export const TEXT_RATIO = 4.5;
export const UI_RATIO = 3;

/**
 * Functions that name or load a resource, whatever they are given. Any call
 * to one of them, in any value, is refused. `url` tokens have their own node
 * type in the parse tree and are refused the same way.
 */
export const RESOURCE_FUNCTIONS: ReadonlySet<string> = new Set([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
  "paint",
]);

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** `fg` drawn over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type Theme = "light" | "dark";

// ---------------------------------------------------------------------------
// The parsed stylesheet

/** A value as lightningcss represents it: typed nodes and raw tokens, as JSON. */
type Node = Record<string, unknown>;

/** One custom-property declaration and where it was found. */
export interface TokenDeclaration {
  readonly name: string;
  /** The parsed, decoded value: a list of lightningcss TokenOrValue nodes. */
  readonly value: readonly Node[];
  /** True when declared directly in a top-level `:root[data-style="<id>"]` rule. */
  readonly topLevel: boolean;
  readonly important: boolean;
}

/** What `parseStyle` learns about a stylesheet. */
export interface ParsedStyle {
  readonly problems: string[];
  /** Every custom-property declaration in the file, in source order. */
  readonly declarations: readonly TokenDeclaration[];
}

/** Whether a selector is exactly `:root[data-style="<id>"]` (or `html[...]`), with nothing after it. */
function isTokenSelector(selector: Node[], id: string): boolean {
  return selector.length === 2 && ownsSelector(selector, id);
}

/** Whether a selector's components start with `:root[data-style="<id>"]`. */
function ownsSelector(selector: Node[], id: string): boolean {
  const [first, second] = selector;
  const root =
    first?.type === "pseudo-class" && first.kind === "root"
      ? true
      : first?.type === "type" && String(first.name).toLowerCase() === "html";
  if (!root || second?.type !== "attribute" || second.name !== "data-style") return false;
  const op = second.operation as { operator?: string; value?: string } | undefined;
  return op?.operator === "equal" && op.value === id;
}

/**
 * Every node in a value that names or loads a resource: `url` nodes, calls to
 * a resource function, and typed image values. The walk is exhaustive over
 * the JSON, so a resource inside light-dark(), a fallback of var(), a token
 * stream or a typed image list is found alike.
 */
function findResources(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) findResources(item, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  const node = value as Node;
  if (node.type === "url") {
    const inner = node.value as { url?: unknown } | undefined;
    out.push(`url(${typeof inner?.url === "string" ? inner.url : ""})`);
    return out;
  }
  if (node.type === "function") {
    const fn = node.value as { name?: unknown } | undefined;
    const name = typeof fn?.name === "string" ? fn.name.toLowerCase() : "";
    if (RESOURCE_FUNCTIONS.has(name)) {
      out.push(`${name}()`);
      return out;
    }
  }
  // Typed image values lightningcss understands.
  if (node.type === "image-set" || node.type === "cross-fade" || node.type === "element") {
    out.push(`${node.type}()`);
    return out;
  }
  for (const child of Object.values(node)) findResources(child, out);
  return out;
}

/**
 * Whether a token stream holds a comment, at any depth. The parser keeps
 * comments inside custom-property values as tokens and the minifier drops
 * them, so `u/**\/rl(…)` would join into `url(…)` in the build; no comment
 * is allowed inside a token value (between declarations is fine).
 */
function hasComment(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasComment);
  if (value === null || typeof value !== "object") return false;
  const node = value as Node;
  if (node.type === "token" && (node.value as Node | undefined)?.type === "comment") return true;
  return Object.values(node).some(hasComment);
}

/**
 * Parses a style's stylesheet and collects its structure problems and every
 * custom-property declaration with its position. Nothing here reads colours.
 */
export function parseStyle(id: string, css: string): ParsedStyle {
  const problems: string[] = [];
  const add = (problem: string) => problems.push(problem);
  const declarations: TokenDeclaration[] = [];
  const file = styleSheet(id);

  const visitDeclarations = (block: Node | undefined, topLevel: boolean) => {
    for (const [list, important] of [
      [block?.declarations, false],
      [block?.importantDeclarations, true],
    ] as const) {
      for (const declaration of (list as Node[] | undefined) ?? []) {
        for (const resource of findResources(declaration)) add(`${resource} is not allowed: a style loads no resource`);
        const property = declaration.property;
        // The parser files unknown properties (vendor-prefixed ones included)
        // under "custom" too: only a `--` name is a token.
        const custom = property === "custom" ? (declaration.value as { name: string; value: Node[] }) : null;
        if (custom?.name.startsWith("--")) {
          declarations.push({ name: custom.name, value: custom.value, topLevel, important });
          if (important) add(`${custom.name}: !important is not allowed`);
          if (hasComment(custom.value))
            add(`${custom.name}: a comment inside a token value is not allowed (it could join into a function name)`);
        } else if (custom) {
          add(
            `${custom.name}: only custom properties (--*) are allowed in a style; styling lives in the layout stylesheet`,
          );
        } else {
          const name =
            property === "unparsed"
              ? String(
                  (declaration.value as { propertyId?: { property?: string } } | undefined)?.propertyId?.property ??
                    property,
                )
              : String(property);
          add(`${name}: only custom properties (--*) are allowed in a style; styling lives in the layout stylesheet`);
        }
      }
    }
  };

  const visitRules = (rules: Node[], depth: number) => {
    for (const rule of rules) {
      const value = rule.value as Node | undefined;
      switch (rule.type) {
        case "style": {
          const selectors = (value?.selectors as Node[][]) ?? [];
          const topLevel = depth === 0 && selectors.length === 1 && isTokenSelector(selectors[0] as Node[], id);
          if (!topLevel) add(`a rule other than a top-level :root[data-style="${id}"] token rule is not allowed`);
          visitDeclarations(value?.declarations as Node | undefined, topLevel);
          // Nested style rules (CSS nesting) sit under `rules`; still visited, so their resources are named.
          if (Array.isArray(value?.rules) && (value.rules as Node[]).length) {
            add("a nested rule is not allowed in a style");
            visitRules(value.rules as Node[], depth + 1);
          }
          break;
        }
        case "import":
          add("@import is not allowed: a style loads no resource");
          break;
        case "font-face":
          add("@font-face is not allowed: no web fonts, system font stacks only");
          break;
        case "media":
        case "supports":
          add(`@${rule.type} is not allowed: a style is tokens only, with no conditions`);
          visitRules((value?.rules as Node[]) ?? [], depth + 1);
          break;
        case "unknown":
        case "custom":
          add(`@${String(value?.name ?? rule.type)} is not allowed in a style`);
          break;
        default:
          add(`@${String(rule.type)} is not allowed in a style`);
      }
    }
  };

  const parseOnce = (code: string, minify: boolean): string | null => {
    try {
      const result = transform({
        filename: file,
        code: Buffer.from(code),
        analyzeDependencies: true,
        minify,
        visitor: {
          StyleSheetExit(sheet) {
            visitRules(sheet.rules as unknown as Node[], 0);
          },
        },
      });
      for (const dep of result.dependencies ?? []) {
        const what = dep.type === "import" ? "@import" : `url(${"url" in dep ? dep.url : ""})`;
        add(`${what} is not allowed: a style loads no resource`);
      }
      return result.code.toString();
    } catch (error) {
      const e = error as Error & { data?: { type?: string; url?: string } };
      if (e.data?.type === "AmbiguousUrlInCustomProperty")
        add(`url(${e.data.url ?? ""}) is not allowed: a style loads no resource`);
      else add(`does not parse: ${e.message}`);
      return null;
    }
  };
  const minified = parseOnce(css, true);
  // The build ships what lightningcss re-serialises, with comments dropped
  // and tokens joined. Parse that form too, so a value that only becomes a
  // resource after minification (`u/**/rl(…)` → `url(…)`) is refused here,
  // from its own declarations.
  if (minified !== null) {
    const before = declarations.length;
    parseOnce(minified, false);
    declarations.splice(before);
  }
  return { problems: [...new Set(problems)], declarations };
}

/**
 * Resources named anywhere in a stylesheet, for the emitted CSS of a build:
 * `url()`, image functions, `@import`, `@font-face` and `@namespace`, in any
 * declaration or token stream. The shipped page loads no resource from CSS.
 */
export function findCssResources(file: string, css: string): string[] {
  const found: string[] = [];
  try {
    const { dependencies } = transform({
      filename: file,
      code: Buffer.from(css),
      analyzeDependencies: true,
      visitor: {
        StyleSheetExit(sheet) {
          const walk = (rules: Node[]) => {
            for (const rule of rules) {
              const value = rule.value as Node | undefined;
              if (rule.type === "import") found.push("@import");
              else if (rule.type === "font-face") found.push("@font-face");
              else if (rule.type === "namespace") found.push("@namespace");
              const block = value?.declarations as Node | undefined;
              for (const list of [block?.declarations, block?.importantDeclarations]) {
                for (const declaration of (list as Node[] | undefined) ?? []) found.push(...findResources(declaration));
              }
              if (rule.type === "font-face") found.push(...findResources(value?.properties));
              if (Array.isArray(value?.rules)) walk(value.rules as Node[]);
            }
          };
          walk(sheet.rules as unknown as Node[]);
        },
      },
    });
    for (const dep of dependencies ?? [])
      found.push(dep.type === "import" ? "@import" : `url(${"url" in dep ? dep.url : ""})`);
  } catch (error) {
    const e = error as Error & { data?: { type?: string; url?: string } };
    found.push(
      e.data?.type === "AmbiguousUrlInCustomProperty" ? `url(${e.data.url ?? ""})` : `does not parse: ${e.message}`,
    );
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Colours

/** An rgb colour object as lightningcss writes one, or null for any other colour space. */
function rgbOf(value: unknown): Rgba | null {
  const v = value as { type?: string; r?: number; g?: number; b?: number; alpha?: number } | null | undefined;
  if (v?.type !== "rgb") return null;
  const { r, g, b, alpha } = v;
  if ([r, g, b, alpha].some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  return { r: r as number, g: g as number, b: b as number, a: alpha as number };
}

/** The keywords a custom property keeps as plain identifiers: transparent, white and black. */
const KEYWORDS: Readonly<Record<string, Rgba>> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};
function keywordOf(node: Node): Rgba | null {
  const inner = node.value as { type?: string; value?: unknown } | undefined;
  if (node.type !== "token" || inner?.type !== "ident" || typeof inner.value !== "string") return null;
  return KEYWORDS[inner.value.toLowerCase()] ?? null;
}

/**
 * A parsed colour node as an rgb with alpha, or null for anything the check
 * does not read. A `light-dark()` of two plain colours is folded by the
 * parser into one colour node carrying both sides; `theme` picks one.
 */
function colorOf(node: Node, theme: Theme): Rgba | null {
  if (node.type !== "color") return null;
  const value = node.value as { type?: string; light?: unknown; dark?: unknown } | undefined;
  if (value?.type === "light-dark") return rgbOf(theme === "light" ? value.light : value.dark);
  return rgbOf(value);
}

const isWhitespace = (node: Node) => {
  const inner = node.value as Node | undefined;
  return node.type === "token" && (inner?.type === "white-space" || inner?.type === "whitespace");
};

/** Top-level declarations by name, for tokens declared exactly once and only at the top level. */
export type TokenIndex = ReadonlyMap<string, TokenDeclaration>;

/**
 * Resolves a token to a colour for one theme: `light-dark()` picked, `var()`
 * chains followed through the top-level declarations. Returns the colour, or
 * a reason it cannot be read.
 */
export function resolveToken(
  index: TokenIndex,
  name: string,
  theme: Theme,
  depth = 0,
): { color: Rgba } | { error: string } {
  if (depth > 16) return { error: `${name} refers to itself through var()` };
  const declaration = index.get(name);
  if (!declaration) return { error: `${name} is not declared once in the top-level rule` };
  return resolveValue(index, declaration.value, theme, depth + 1, name);
}

function resolveValue(
  index: TokenIndex,
  value: readonly Node[],
  theme: Theme,
  depth: number,
  name: string,
): { color: Rgba } | { error: string } {
  const nodes = value.filter((node) => !isWhitespace(node));
  const [node] = nodes;
  if (nodes.length !== 1 || node === undefined) return { error: `${name} is not a single colour` };
  if (node.type === "unresolved-color") {
    const pair = node.value as { type?: string; light?: Node[]; dark?: Node[] } | undefined;
    if (pair?.type !== "light-dark" || !pair.light || !pair.dark)
      return { error: `${name} uses an unsupported colour function` };
    return resolveValue(index, theme === "light" ? pair.light : pair.dark, theme, depth + 1, name);
  }
  if (node.type === "var") {
    const ref = node.value as { name?: { ident?: string }; fallback?: Node[] | null } | undefined;
    const target = ref?.name?.ident;
    if (typeof target !== "string") return { error: `${name} has an unreadable var()` };
    if (ref?.fallback) return { error: `${name}: var() with a fallback is not allowed for a colour token` };
    const resolved = resolveToken(index, target, theme, depth + 1);
    return "error" in resolved ? { error: `${name} → ${resolved.error}` } : resolved;
  }
  const color = colorOf(node, theme) ?? keywordOf(node);
  if (color) return { color };
  return { error: `${name} is not a hex, rgb(), rgba() or transparent colour` };
}

/**
 * The top-level declarations by name, for tokens declared exactly once and
 * only in the top-level rule. Names declared anywhere else, or more than
 * once, are left out; the caller reports them.
 */
export function topLevelIndex(declarations: readonly TokenDeclaration[]): TokenIndex {
  const counts = new Map<string, { total: number; topLevel: number; declaration?: TokenDeclaration }>();
  for (const declaration of declarations) {
    const entry = counts.get(declaration.name) ?? { total: 0, topLevel: 0 };
    entry.total += 1;
    if (declaration.topLevel) {
      entry.topLevel += 1;
      entry.declaration = declaration;
    }
    counts.set(declaration.name, entry);
  }
  const index = new Map<string, TokenDeclaration>();
  for (const [name, entry] of counts) {
    if (entry.total === 1 && entry.topLevel === 1 && entry.declaration) index.set(name, entry.declaration);
  }
  return index;
}

interface Resolved {
  readonly colors: ReadonlyMap<string, Rgba>;
  readonly surfaces: ReadonlyMap<string, Rgba>;
  /** Boxes bounding every colour the intro text can sit on: the band, then the glow and the grid, over the page. */
  readonly introBoxes: readonly ColorBox[];
  /** Boxes bounding every colour the header text can sit on: the 90% page background over the page or a panel. */
  readonly headerBoxes: readonly ColorBox[];
  /** The box bounding every colour the footer text can sit on: the page with its decorative layers. */
  readonly footerBoxes: readonly ColorBox[];
}

/** A gradient token's layers, first layer on top, each a list of its colour stops for both themes. */
export type Layers = ReadonlyArray<ReadonlyArray<{ light: Rgba; dark: Rgba }>>;

/** The decorative layers a style paints on the page, from the grammar check. */
export interface Decor {
  readonly static: Layers;
  readonly pointer: Layers;
}

/**
 * A per-channel box of encoded sRGB colours: every colour a region can show
 * lies inside it. `lo` and `hi` are its corners; both are opaque.
 */
export interface ColorBox {
  readonly lo: Rgba;
  readonly hi: Rgba;
}

/** A per-channel interval of a translucent layer, premultiplied: [p, p] and [a, a]. */
interface LayerBox {
  readonly pLo: readonly [number, number, number];
  readonly pHi: readonly [number, number, number];
  readonly aLo: number;
  readonly aHi: number;
}

const channels = (c: Rgba): [number, number, number] => [c.r, c.g, c.b];
const clamp255 = (n: number) => Math.min(255, Math.max(0, n));

/**
 * The box of a gradient layer: over all its stops, the per-channel minimum
 * and maximum of the premultiplied colour (channel × alpha) and of the alpha.
 * Browsers interpolate gradients in premultiplied encoded sRGB, so between
 * two stops every premultiplied channel and the alpha are linear in the
 * position: each lies between its values at the two stops, hence inside the
 * box over all stops. The box also covers the stops themselves.
 */
export function layerBox(stops: readonly Rgba[]): LayerBox {
  const premultiplied = stops.map((c) => channels(c).map((v) => v * c.a) as [number, number, number]);
  const pick = (f: (...n: number[]) => number) =>
    [0, 1, 2].map((i) => f(...premultiplied.map((p) => p[i] as number))) as [number, number, number];
  return {
    pLo: pick(Math.min),
    pHi: pick(Math.max),
    aLo: Math.min(...stops.map((c) => c.a)),
    aHi: Math.max(...stops.map((c) => c.a)),
  };
}

/**
 * Source-over of a layer box onto an opaque box, with interval arithmetic:
 * C = p + (1 - a) × B per channel, so with p ∈ [pLo, pHi], a ∈ [aLo, aHi]
 * and B ∈ [bLo, bHi] (all non-negative), C ∈ [pLo + (1 - aHi) × bLo,
 * pHi + (1 - aLo) × bHi]. The result is opaque and stays a valid box; it is
 * conservative, since p and a may not reach their extremes together.
 */
export function overBox(layer: LayerBox, below: ColorBox): ColorBox {
  const lo = channels(below.lo).map((b, i) => clamp255((layer.pLo[i] as number) + (1 - layer.aHi) * b));
  const hi = channels(below.hi).map((b, i) => clamp255((layer.pHi[i] as number) + (1 - layer.aLo) * b));
  return {
    lo: { r: lo[0] as number, g: lo[1] as number, b: lo[2] as number, a: 1 },
    hi: { r: hi[0] as number, g: hi[1] as number, b: hi[2] as number, a: 1 },
  };
}

/** One translucent colour as a one-stop layer box, for bands, glows, grids and tints. */
const single = (c: Rgba): LayerBox => layerBox([c]);

/**
 * The box of the page background: `--bg`, then the static layers bottom to
 * top, then the pointer layers bottom to top, each composited as a box. Any
 * rendered page pixel, wherever the pointer is, lies inside it.
 */
export function pageBox(bg: Rgba, decor: Decor, theme: Theme): ColorBox {
  const side = (c: { light: Rgba; dark: Rgba }) => (theme === "light" ? c.light : c.dark);
  const order = [...[...decor.static].reverse(), ...[...decor.pointer].reverse()];
  let box: ColorBox = { lo: bg, hi: bg };
  for (const layer of order) box = overBox(layerBox(layer.map(side)), box);
  return box;
}

/** Colour tokens of one theme as opaque surfaces and raw colours, or the problems that stop the reading. */
function resolveColors(
  id: string,
  index: TokenIndex,
  declared: ReadonlySet<string>,
  theme: Theme,
  decor: Decor,
): { resolved?: Resolved; problems: StyleProblem[] } {
  const problems: StyleProblem[] = [];
  const colors = new Map<string, Rgba>();
  for (const name of COLOR_TOKENS) {
    if (!declared.has(name)) continue;
    const result = resolveToken(index, name, theme);
    if ("error" in result) {
      problems.push({ style: id, problem: `${name} (${theme}): ${result.error}` });
      continue;
    }
    colors.set(name, result.color);
    const spec = TOKEN_TYPES[name];
    if (spec?.kind === "color" && spec.opaque && result.color.a < 1)
      problems.push({
        style: id,
        problem: `${name} (${theme}): must be an opaque colour, the layout paints text on it`,
      });
  }
  if (problems.length) return { problems };
  const bg = colors.get("--bg") as Rgba;
  const surfaces = new Map<string, Rgba>();
  for (const name of SURFACES) surfaces.set(name, over(colors.get(name) as Rgba, bg));
  // Text on the accent and the ok colour: those are drawn over the panel.
  const panel = surfaces.get("--panel") as Rgba;
  surfaces.set("--accent", over(colors.get("--accent") as Rgba, panel));
  surfaces.set("--ok", over(colors.get("--ok") as Rgba, panel));

  // The page background as it can look anywhere: a box bounding every pixel
  // the decorative layers can produce over --bg (see pageBox).
  const page = pageBox(bg, decor, theme);
  // The intro band is a solid fill on that; the layout then stacks its grid
  // lines and, on top, its glow, each a gradient between transparent and the
  // token, so each is a layer box with those two stops.
  const transparent = { r: 0, g: 0, b: 0, a: 0 };
  const band = colors.get("--bg-band") as Rgba;
  const glow = colors.get("--intro-glow") as Rgba;
  const grid = colors.get("--grid-line") as Rgba;
  const onBand = overBox(single(band), page);
  const introBoxes = [overBox(layerBox([transparent, glow]), overBox(layerBox([transparent, grid]), onBand))];
  // The header is the page background at 90% over whatever scrolls under it:
  // the page as above, or a panel.
  const tint = single({ ...bg, a: 0.9 });
  const headerBoxes = [overBox(tint, page), overBox(tint, { lo: panel, hi: panel })];
  // The footer is plain text on the page, with the decorative layers behind it.
  const footerBoxes = [page];
  return { resolved: { colors, surfaces, introBoxes, headerBoxes, footerBoxes }, problems };
}

function contrastProblems(
  id: string,
  index: TokenIndex,
  declared: ReadonlySet<string>,
  theme: Theme,
  decor: Decor,
): StyleProblem[] {
  const { resolved, problems } = resolveColors(id, index, declared, theme, decor);
  if (!resolved) return problems;
  const failed = new Set<string>();
  const judge = (fgName: string, surface: Rgba, where: string, minimum: number, what: string) => {
    const fg = resolved.colors.get(fgName);
    if (fg === undefined || failed.has(`${fgName}|${where}`)) return; // optional token, or already reported
    const ratio = contrastRatio(over(fg, surface), surface);
    if (ratio + 1e-9 < minimum) {
      failed.add(`${fgName}|${where}`);
      problems.push({
        style: id,
        problem: `${fgName} on ${where} (${theme}): ${what} contrast ${ratio.toFixed(2)}:1 is below ${minimum}:1`,
      });
    }
  };
  /**
   * Judges text against a box of backgrounds. Relative luminance rises with
   * each channel, so every pixel's luminance lies between the luminance of
   * the box's lower and upper corners. Text drawn over such a pixel keeps the
   * same ordering, so its own luminance lies between the text over each
   * corner. If the two ranges overlap, the bound cannot establish any
   * separation between text and background, so the contrast is reported as
   * 1:1 and refused; otherwise the lowest contrast the bound allows is
   * between the two nearest ends.
   */
  const judgeBox = (fgName: string, box: ColorBox, where: string, minimum: number, what: string) => {
    const fg = resolved.colors.get(fgName);
    if (fg === undefined || failed.has(`${fgName}|${where}`)) return;
    const bgLo = luminance(box.lo);
    const bgHi = luminance(box.hi);
    const fgLo = Math.min(luminance(over(fg, box.lo)), luminance(over(fg, box.hi)));
    const fgHi = Math.max(luminance(over(fg, box.lo)), luminance(over(fg, box.hi)));
    let ratio: number;
    if (fgHi >= bgLo && bgHi >= fgLo) ratio = 1;
    else if (fgLo > bgHi) ratio = (fgLo + 0.05) / (bgHi + 0.05);
    else ratio = (bgLo + 0.05) / (fgHi + 0.05);
    if (ratio + 1e-9 < minimum) {
      failed.add(`${fgName}|${where}`);
      problems.push({
        style: id,
        problem: `${fgName} on ${where} (${theme}): ${what} contrast can fall to ${ratio.toFixed(2)}:1, below ${minimum}:1`,
      });
    }
  };
  const check = (pairs: typeof TEXT_PAIRS, minimum: number, what: string) => {
    for (const [fgName, surfaceName] of pairs) {
      if (surfaceName === "intro") {
        for (const box of resolved.introBoxes)
          judgeBox(fgName, box, "the intro background (band, glow and grid over the page layers)", minimum, what);
        continue;
      }
      const surface = resolved.surfaces.get(surfaceName);
      if (surface !== undefined) judge(fgName, surface, surfaceName, minimum, what);
    }
  };
  check(TEXT_PAIRS, TEXT_RATIO, "text");
  check(UI_PAIRS, UI_RATIO, "control");
  for (const fgName of ["--text", "--text-2", "--muted"])
    for (const box of resolved.headerBoxes)
      judgeBox(fgName, box, "the header (90% --bg over the page or a panel)", TEXT_RATIO, "text");
  for (const box of resolved.footerBoxes)
    judgeBox("--text-2", box, "the footer (the page with its decorative layers)", TEXT_RATIO, "text");
  return problems;
}

/** The custom properties a value refers to through var(), at any depth. */
function varTargets(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) varTargets(item, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  const node = value as Node;
  if (node.type === "var") {
    const ident = (node.value as { name?: { ident?: string } } | undefined)?.name?.ident;
    if (typeof ident === "string") out.push(ident);
  }
  for (const child of Object.values(node)) varTargets(child, out);
  return out;
}

// ---------------------------------------------------------------------------
// The check

/**
 * Checks one style's stylesheet text. `id` is the style's folder name and
 * `data-style` value. The checks never read other files.
 */
export function checkStyleSource(id: string, css: string): StyleProblem[] {
  const problems: StyleProblem[] = [];
  const add = (problem: string) => problems.push({ style: id, problem });

  const parsed = parseStyle(id, css);
  for (const problem of parsed.problems) add(problem);
  if (parsed.problems.some((p) => p.startsWith("does not parse"))) return dedupe(problems);

  const topLevel = parsed.declarations.filter((d) => d.topLevel);
  if (!topLevel.length) {
    add(`must declare its tokens in a top-level :root[data-style="${id}"] rule`);
    return dedupe(problems);
  }
  const declared = new Set(topLevel.map((d) => d.name));
  for (const name of REQUIRED_TOKENS) if (!declared.has(name)) add(`missing required token ${name}`);

  // Every token is one the layout reads, holding exactly its declared type.
  // Type problems are reported alongside the colour problems below, so one
  // run names everything wrong with a value.
  const typeProblems: string[] = [];
  const decor = {
    static: [] as Array<Array<{ light: Rgba; dark: Rgba }>>,
    pointer: [] as Array<Array<{ light: Rgba; dark: Rgba }>>,
  };
  for (const declaration of topLevel) {
    const spec = TOKEN_TYPES[declaration.name];
    if (!spec) {
      add(`${declaration.name} is not a token the layout reads`);
      continue;
    }
    const result = checkTokenValue(declaration.name, declaration.value, spec);
    typeProblems.push(...result.problems);
    if (declaration.name === "--fx-static") decor.static.push(...result.layers);
    if (declaration.name === "--fx-pointer") decor.pointer.push(...result.layers);
  }

  // Colour tokens, and every token they reach through var(), are declared
  // exactly once and only in the top-level rule, so the contrast check sees
  // the one value each theme uses.
  const index = topLevelIndex(parsed.declarations);
  const occurrences = new Map<string, TokenDeclaration[]>();
  for (const d of parsed.declarations) occurrences.set(d.name, [...(occurrences.get(d.name) ?? []), d]);
  const reached = new Set<string>();
  const reach = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const d of occurrences.get(name) ?? []) for (const target of varTargets(d.value)) reach(target);
  };
  for (const name of COLOR_TOKENS) if (declared.has(name)) reach(name);
  for (const name of reached) {
    const found = occurrences.get(name) ?? [];
    if (found.length === 1 && found[0]?.topLevel) continue;
    const where =
      found.length === 0
        ? "is never declared"
        : found.length > 1
          ? "is declared more than once"
          : "is declared outside the top-level rule";
    add(
      `${name} ${where}; a colour token and everything it refers to may only be declared once, in the top-level rule`,
    );
  }
  if (problems.length) return dedupe(problems);
  for (const problem of typeProblems) add(problem);
  for (const theme of ["light", "dark"] as const) problems.push(...contrastProblems(id, index, declared, theme, decor));
  return dedupe(problems);
}

/**
 * Checks the offered styles of a configuration under `root`: the default is
 * offered, every offered style has a stylesheet, and each passes
 * `checkStyleSource`.
 */
export function checkStyles(root: string, style: StyleConfig): StyleProblem[] {
  const problems: StyleProblem[] = [];
  if (!style.offered.some((s) => s.id === style.default))
    problems.push({ style: style.default, problem: "the default style is not one of the offered styles" });
  for (const { id } of style.offered) {
    const file = join(root, styleSheet(id));
    if (!existsSync(file)) {
      problems.push({ style: id, problem: `offered but has no stylesheet at ${styleSheet(id)}` });
      continue;
    }
    problems.push(...checkStyleSource(id, readFileSync(file, "utf8")));
  }
  return problems;
}

/** Throws a single error listing every problem, for the build. */
export function assertStyles(root: string, style: StyleConfig): void {
  const problems = checkStyles(root, style);
  if (problems.length) {
    throw new Error(
      `Style check failed (R4b):\n${problems.map((p) => `  ${styleSheet(p.style)}: ${p.problem}`).join("\n")}`,
    );
  }
}

function dedupe(problems: StyleProblem[]): StyleProblem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.style}\0${p.problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
