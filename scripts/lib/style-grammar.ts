// The typed grammar every style token must satisfy (requirement R4b). A
// style is tokens only; this module says what each token may hold, and
// refuses anything else: unknown tokens, the wrong kind of value, values
// out of bounds, and anything that could paint over text or load a thing.
//
// Values are judged on lightningcss's parsed token stream (escapes decoded,
// colours parsed), never on text. The table below is the one list of tokens
// the layout stylesheet reads; src/styles/README.md documents it.

import type { Rgba } from "./style-checks.ts";

type Node = Record<string, unknown>;

/** The pointer effect's position properties, the only var() a gradient may read. */
export const POINTER_VARS: ReadonlySet<string> = new Set([
  "--px",
  "--py",
  "--pxs",
  "--pys",
  "--pxt",
  "--pyt",
  "--pxn",
  "--pyn",
]);

/** Outer-shadow bounds, in px: the shipped styles fit comfortably inside them. */
export const SHADOW_LIMITS = { offset: 24, blur: 64, spreadMin: -32, spreadMax: 24 } as const;

/**
 * Gradient complexity bounds: layers per token and colour stops per gradient.
 * The contrast check composites every combination of one stop per layer, so
 * the bounds keep that search small; anything beyond is refused, never cut.
 */
export const GRADIENT_LIMITS = { layers: 3, stops: 8 } as const;

export type TokenSpec =
  /** A colour. Opaque ones are the surfaces the layout paints under text. */
  | { readonly kind: "color"; readonly opaque: boolean }
  /** A length in px (or `0`) within bounds; `clampVw` also allows clamp(px, vw, px). */
  | { readonly kind: "length"; readonly min: number; readonly max: number; readonly clampVw?: boolean }
  /** A corner radius: px up to 1000 (pills), em up to 4, or a percentage up to 50%. */
  | { readonly kind: "radius" }
  /** Letter-spacing: `0`, -0.2em..0.5em, -4px..8px, or var() of one of `aliases`. */
  | { readonly kind: "tracking"; readonly aliases?: readonly string[] }
  /** A plain number within bounds. */
  | { readonly kind: "number"; readonly min: number; readonly max: number }
  /** One of a few identifiers. */
  | { readonly kind: "keyword"; readonly values: readonly string[] }
  /** `none` or a list of outer box shadows with literal colours, within SHADOW_LIMITS. */
  | { readonly kind: "shadow" }
  /** `none` or a list of CSS gradients with literal colours; may position by the pointer vars. */
  | { readonly kind: "gradients" }
  /** A font-family list of identifiers and strings, or var() of one of `aliases`. */
  | { readonly kind: "font-stack"; readonly aliases?: readonly string[] }
  /** `0`, `none`, `var(--hairline)`, or `<length ≤ 4px> solid <colour>`. */
  | { readonly kind: "border" }
  /** `auto`, or one or two lengths (1..512px) or percentages, for background-size. */
  | { readonly kind: "size" };

const color = (opaque: boolean): TokenSpec => ({ kind: "color", opaque });
const length = (min: number, max: number, clampVw = false): TokenSpec => ({ kind: "length", min, max, clampVw });

/**
 * Every token the layout reads, with its type. Surfaces the layout paints
 * under text (`--bg`, `--panel`, `--field`, `--chip`) must be opaque. The
 * other colours may carry alpha: the contrast check composites them over the
 * surface they sit on, and the intro and header worst cases are computed
 * from the gradients and band colours themselves.
 */
export const TOKEN_TYPES: Readonly<Record<string, TokenSpec>> = {
  // Surfaces
  "--bg": color(true),
  "--bg-band": color(false),
  "--panel": color(true),
  "--field": color(true),
  "--chip": color(true),
  // Lines
  "--line": color(false),
  "--line-strong": color(false),
  "--grid-line": color(false),
  "--intro-glow": color(false),
  // Text
  "--text": color(false),
  "--text-2": color(false),
  "--muted": color(false),
  // Accent and states
  "--accent": color(false),
  "--on-accent": color(false),
  "--focus": color(false),
  "--bad": color(false),
  "--warn": color(false),
  "--ok": color(false),
  // Meter ramp (optional)
  "--meter-1": color(false),
  "--meter-2": color(false),
  "--meter-3": color(false),
  "--meter-4": color(false),
  "--meter-5": color(false),
  "--meter-6": color(false),
  // Shape
  "--radius": { kind: "radius" },
  "--radius-sm": { kind: "radius" },
  "--thumb-radius": { kind: "radius" },
  "--result-radius": { kind: "radius" },
  "--shadow": { kind: "shadow" },
  "--band-border": { kind: "border" },
  "--band-gap": length(-8, 64),
  "--panel-gap": length(-8, 64),
  "--gap-no-intro": length(-8, 64),
  // Type
  "--sans": { kind: "font-stack" },
  "--mono": { kind: "font-stack" },
  "--tagline-font": { kind: "font-stack", aliases: ["--sans", "--mono"] },
  "--track": { kind: "tracking" },
  "--label-track": { kind: "tracking" },
  "--tagline-track": { kind: "tracking", aliases: ["--label-track", "--track"] },
  "--display-weight": { kind: "number", min: 100, max: 1000 },
  "--tagline-size": length(10, 20),
  "--tagline-case": { kind: "keyword", values: ["none", "uppercase", "lowercase", "capitalize"] },
  // Spacing
  "--pad": length(0, 64, true),
  "--row-gap": length(0, 48),
  "--control-h": length(24, 64),
  "--header-h": length(40, 120),
  // Decorative background (R4c)
  "--fx-follow": { kind: "number", min: 0, max: 1 },
  "--fx-rest-x": { kind: "number", min: 0, max: 1 },
  "--fx-rest-y": { kind: "number", min: 0, max: 1 },
  "--fx-attach": { kind: "keyword", values: ["fixed", "scroll"] },
  "--fx-size": { kind: "size" },
  "--fx-static": { kind: "gradients" },
  "--fx-pointer": { kind: "gradients" },
};

/** The colour tokens, in table order. */
export const COLOR_TOKEN_NAMES: readonly string[] = Object.entries(TOKEN_TYPES)
  .filter(([, spec]) => spec.kind === "color")
  .map(([name]) => name);

// ---------------------------------------------------------------------------
// Node helpers

const tokenType = (node: Node): string | undefined => {
  if (node.type !== "token") return undefined;
  return String((node.value as Node | undefined)?.type);
};
const tokenValue = (node: Node): unknown => (node.value as Node | undefined)?.value;
const isWhitespace = (node: Node) => tokenType(node) === "white-space" || tokenType(node) === "whitespace";
const isComma = (node: Node) => tokenType(node) === "comma";
const isIdent = (node: Node, ...names: string[]) =>
  tokenType(node) === "ident" && (names.length === 0 || names.includes(String(tokenValue(node)).toLowerCase()));
const isDelim = (node: Node, ...chars: string[]) =>
  tokenType(node) === "delim" && chars.includes(String(tokenValue(node)));

const KEYWORD_COLORS: Readonly<Record<string, Rgba>> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

function rgbOf(value: unknown): Rgba | null {
  const v = value as { type?: string; r?: number; g?: number; b?: number; alpha?: number } | null | undefined;
  if (v?.type !== "rgb") return null;
  const { r, g, b, alpha } = v;
  if ([r, g, b, alpha].some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  return { r: r as number, g: g as number, b: b as number, a: alpha as number };
}

/**
 * A literal colour node, for both themes: a parsed colour (plain or a
 * folded light-dark pair), a light-dark() of literals, or a keyword.
 * Null for anything else, including var().
 */
export function literalColor(node: Node): { light: Rgba; dark: Rgba } | null {
  if (node.type === "color") {
    const value = node.value as { type?: string; light?: unknown; dark?: unknown } | undefined;
    if (value?.type === "light-dark") {
      const light = rgbOf(value.light);
      const dark = rgbOf(value.dark);
      return light && dark ? { light, dark } : null;
    }
    const rgb = rgbOf(value);
    return rgb ? { light: rgb, dark: rgb } : null;
  }
  if (node.type === "unresolved-color") {
    const pair = node.value as { type?: string; light?: Node[]; dark?: Node[] } | undefined;
    if (pair?.type !== "light-dark" || !pair.light || !pair.dark) return null;
    const side = (nodes: Node[]) => {
      const inner = nodes.filter((n) => !isWhitespace(n));
      return inner.length === 1 && inner[0] ? literalColor(inner[0]) : null;
    };
    const light = side(pair.light);
    const dark = side(pair.dark);
    return light && dark ? { light: light.light, dark: dark.dark } : null;
  }
  if (isIdent(node)) {
    const keyword = KEYWORD_COLORS[String(tokenValue(node)).toLowerCase()];
    return keyword ? { light: keyword, dark: keyword } : null;
  }
  return null;
}

/** A length node in px, or a unitless 0, as a number of px; null otherwise. */
function pxOf(node: Node): number | null {
  if (node.type === "length") {
    const v = node.value as { unit?: string; value?: number };
    return v.unit === "px" && typeof v.value === "number" ? v.value : null;
  }
  if (tokenType(node) === "number" && tokenValue(node) === 0) return 0;
  return null;
}
function lengthOf(node: Node): { unit: string; value: number } | null {
  if (node.type === "length") {
    const v = node.value as { unit?: string; value?: number };
    return typeof v.unit === "string" && typeof v.value === "number" ? { unit: v.unit, value: v.value } : null;
  }
  if (tokenType(node) === "number" && tokenValue(node) === 0) return { unit: "px", value: 0 };
  return null;
}
function percentOf(node: Node): number | null {
  return tokenType(node) === "percentage" && typeof tokenValue(node) === "number" ? (tokenValue(node) as number) : null;
}
function numberOf(node: Node): number | null {
  return tokenType(node) === "number" && typeof tokenValue(node) === "number" ? (tokenValue(node) as number) : null;
}
function varName(node: Node): string | null {
  if (node.type !== "var") return null;
  const ref = node.value as { name?: { ident?: string }; fallback?: unknown } | undefined;
  if (ref?.fallback) return null;
  return typeof ref?.name?.ident === "string" ? ref.name.ident : null;
}
function functionOf(node: Node): { name: string; args: Node[] } | null {
  if (node.type !== "function") return null;
  const fn = node.value as { name?: string; arguments?: Node[] } | undefined;
  return typeof fn?.name === "string" ? { name: fn.name.toLowerCase(), args: fn.arguments ?? [] } : null;
}

/** The value split at top-level commas, whitespace dropped. */
function items(value: readonly Node[]): Node[][] {
  const out: Node[][] = [[]];
  for (const node of value) {
    if (isWhitespace(node)) continue;
    if (isComma(node)) out.push([]);
    else (out[out.length - 1] as Node[]).push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The checks

export interface TypeResult {
  readonly problems: string[];
  /** Literal colours found in the value (gradient stops, shadow colours), for the worst-case contrast checks. */
  readonly colors: Array<{ light: Rgba; dark: Rgba }>;
  /** For gradient tokens: the colour stops of each layer, first layer on top, as the stylesheet lists them. */
  readonly layers: Array<Array<{ light: Rgba; dark: Rgba }>>;
}

/**
 * Checks one token's value against its spec. `name` is reported in every
 * problem. Colour tokens are not judged here (the colour resolver in
 * style-checks.ts follows var() chains); only their opacity rule is.
 */
export function checkTokenValue(name: string, value: readonly Node[], spec: TokenSpec): TypeResult {
  const problems: string[] = [];
  const colors: Array<{ light: Rgba; dark: Rgba }> = [];
  const layers: Array<Array<{ light: Rgba; dark: Rgba }>> = [];
  const add = (p: string) => problems.push(`${name}: ${p}`);
  const nodes = value.filter((n) => !isWhitespace(n));
  const single = nodes.length === 1 ? (nodes[0] as Node) : null;

  switch (spec.kind) {
    case "color":
      // Resolution and opacity are handled by the colour resolver; nothing to add here.
      break;
    case "number": {
      const n = single ? numberOf(single) : null;
      if (n === null) add(`must be a plain number from ${spec.min} to ${spec.max}`);
      else if (n < spec.min || n > spec.max) add(`must be from ${spec.min} to ${spec.max}, not ${n}`);
      break;
    }
    case "keyword": {
      if (!single || !isIdent(single, ...spec.values)) add(`must be one of ${spec.values.join(", ")}`);
      break;
    }
    case "length": {
      const inBounds = (px: number) => px >= spec.min && px <= spec.max;
      const fn = single ? functionOf(single) : null;
      if (spec.clampVw && fn?.name === "clamp") {
        const parts = items(fn.args);
        const [a, b, c] = parts.map((p) => (p.length === 1 ? lengthOf(p[0] as Node) : null));
        const ok =
          parts.length === 3 &&
          a?.unit === "px" &&
          inBounds(a.value) &&
          b?.unit === "vw" &&
          b.value >= 0 &&
          b.value <= 10 &&
          c?.unit === "px" &&
          inBounds(c.value) &&
          a.value <= c.value;
        if (!ok) add(`clamp() must be clamp(<px>, <vw up to 10>, <px>) within ${spec.min}px to ${spec.max}px`);
        break;
      }
      const px = single ? pxOf(single) : null;
      if (px === null) add(`must be a length in px${spec.clampVw ? " or a clamp()" : ""}`);
      else if (!inBounds(px)) add(`must be from ${spec.min}px to ${spec.max}px, not ${px}px`);
      break;
    }
    case "radius": {
      const len = single ? lengthOf(single) : null;
      const pct = single ? percentOf(single) : null;
      const ok =
        (len !== null &&
          ((len.unit === "px" && len.value >= 0 && len.value <= 1000) ||
            (len.unit === "em" && len.value >= 0 && len.value <= 4))) ||
        (pct !== null && pct >= 0 && pct <= 0.5);
      if (!ok) add("must be a radius: 0 to 1000px, 0 to 4em, or 0% to 50%");
      break;
    }
    case "tracking": {
      const alias = single ? varName(single) : null;
      if (alias !== null) {
        if (!spec.aliases?.includes(alias))
          add(`may only refer to ${spec.aliases?.join(" or ") ?? "nothing"} through var()`);
        break;
      }
      const len = single ? lengthOf(single) : null;
      const ok =
        len !== null &&
        ((len.unit === "em" && len.value >= -0.2 && len.value <= 0.5) ||
          (len.unit === "px" && len.value >= -4 && len.value <= 8));
      if (!ok) add("must be letter-spacing from -0.2em to 0.5em or -4px to 8px");
      break;
    }
    case "font-stack": {
      const alias = single ? varName(single) : null;
      if (alias !== null) {
        if (!spec.aliases?.includes(alias))
          add(`may only refer to ${spec.aliases?.join(" or ") ?? "nothing"} through var()`);
        break;
      }
      const families = items(value);
      if (families.length === 0 || families.length > 12) add("must list 1 to 12 font families");
      for (const family of families) {
        const text = family.map((n) =>
          isIdent(n) ? String(tokenValue(n)) : tokenType(n) === "string" ? String(tokenValue(n)) : null,
        );
        const ok =
          family.length > 0 &&
          text.every((t) => t !== null) &&
          (family.length === 1 || family.every((n) => isIdent(n))) &&
          text.join(" ").length <= 40 &&
          /^-?[A-Za-z][A-Za-z0-9 _-]*$/.test(text.join(" "));
        if (!ok) add("each font family must be a plain name: identifiers or one quoted string");
      }
      break;
    }
    case "border": {
      if (single && (pxOf(single) === 0 || isIdent(single, "none") || varName(single) === "--hairline")) break;
      const [width, style, colour] = nodes;
      const px = width ? pxOf(width) : null;
      const colourOk =
        colour !== undefined &&
        (literalColor(colour) !== null || ["--line", "--line-strong"].includes(varName(colour) ?? ""));
      if (nodes.length !== 3 || px === null || px < 0 || px > 4 || !style || !isIdent(style, "solid") || !colourOk)
        add(
          "must be 0, none, var(--hairline), or <length up to 4px> solid <colour literal, var(--line) or var(--line-strong)>",
        );
      break;
    }
    case "size": {
      if (single && isIdent(single, "auto")) break;
      const ok =
        nodes.length >= 1 &&
        nodes.length <= 2 &&
        nodes.every((n) => {
          const px = pxOf(n);
          const pct = percentOf(n);
          return (px !== null && px >= 1 && px <= 512) || (pct !== null && pct >= 0 && pct <= 1);
        });
      if (!ok) add("must be auto, or one or two lengths from 1px to 512px or percentages");
      break;
    }
    case "shadow": {
      if (single && isIdent(single, "none")) break;
      for (const item of items(value)) {
        if (item.length === 0) {
          add("has an empty shadow");
          continue;
        }
        const lengths: number[] = [];
        let colour: { light: Rgba; dark: Rgba } | null = null;
        let bad = false;
        for (const node of item) {
          const px = pxOf(node);
          if (px !== null) {
            lengths.push(px);
            continue;
          }
          const literal = literalColor(node);
          if (literal && colour === null) {
            colour = literal;
            continue;
          }
          bad = true;
          if (isIdent(node, "inset")) add("inset shadows are not allowed: a shadow may only paint outside a panel");
          else if (varName(node) !== null) add("a shadow colour must be a literal, never var()");
          else add("a shadow is <offset-x> <offset-y> [<blur> [<spread>]] <colour literal>, outside the panel only");
        }
        if (bad) continue;
        if (lengths.length < 2 || lengths.length > 4) {
          add("a shadow needs two to four lengths");
          continue;
        }
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
        const { offset, blur: maxBlur, spreadMin, spreadMax } = SHADOW_LIMITS;
        if (Math.abs(x) > offset || Math.abs(y) > offset) add(`shadow offsets must stay within ${offset}px`);
        if (blur < 0 || blur > maxBlur) add(`shadow blur must be 0 to ${maxBlur}px`);
        if (spread < spreadMin || spread > spreadMax) add(`shadow spread must be ${spreadMin}px to ${spreadMax}px`);
        if (colour) colors.push(colour);
      }
      break;
    }
    case "gradients": {
      if (single && isIdent(single, "none")) break;
      const list = items(value);
      if (list.length > GRADIENT_LIMITS.layers) {
        add(`may have at most ${GRADIENT_LIMITS.layers} layers, not ${list.length}`);
        break;
      }
      for (const item of list) {
        const fn = item.length === 1 ? functionOf(item[0] as Node) : null;
        if (!fn || !GRADIENTS.has(fn.name)) {
          add("must be none or a list of linear-, radial- or conic-gradient() calls");
          continue;
        }
        const stops: Array<{ light: Rgba; dark: Rgba }> = [];
        gradientArguments(fn.args, add, stops, 0);
        if (stops.length > GRADIENT_LIMITS.stops) {
          add(`a gradient may have at most ${GRADIENT_LIMITS.stops} colour stops, not ${stops.length}`);
          continue;
        }
        if (stops.length === 0) add("a gradient needs at least one colour stop");
        colors.push(...stops);
        layers.push(stops);
      }
      break;
    }
  }
  return { problems, colors, layers };
}

const GRADIENTS: ReadonlySet<string> = new Set([
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "repeating-conic-gradient",
]);
const GRADIENT_WORDS: ReadonlySet<string> = new Set([
  "at",
  "to",
  "circle",
  "ellipse",
  "closest-side",
  "closest-corner",
  "farthest-side",
  "farthest-corner",
  "center",
  "left",
  "right",
  "top",
  "bottom",
  "from",
]);
const MATH: ReadonlySet<string> = new Set(["calc", "min", "max", "clamp"]);

/** The arguments of a gradient: geometry, colour stops, pointer positions and arithmetic. Nothing else. */
function gradientArguments(args: Node[], add: (p: string) => void, colors: TypeResult["colors"], depth: number): void {
  if (depth > 4) {
    add("a gradient is nested too deeply");
    return;
  }
  for (const node of args) {
    if (isWhitespace(node) || isComma(node) || isDelim(node, "/")) continue;
    if (lengthOf(node) || percentOf(node) !== null || numberOf(node) !== null || node.type === "angle") continue;
    const literal = literalColor(node);
    if (literal) {
      colors.push(literal);
      continue;
    }
    if (isIdent(node) && GRADIENT_WORDS.has(String(tokenValue(node)).toLowerCase())) continue;
    const ref = varName(node);
    if (ref !== null) {
      if (!POINTER_VARS.has(ref)) add(`a gradient may only read the pointer position through var(), not ${ref}`);
      continue;
    }
    const fn = functionOf(node);
    if (fn && MATH.has(fn.name)) {
      mathArguments(fn.args, add, depth + 1);
      continue;
    }
    add(`a gradient may not contain ${describe(node)}`);
  }
}

/** The arguments of calc() and friends inside a gradient: numbers, lengths, angles, operators, pointer vars. */
function mathArguments(args: Node[], add: (p: string) => void, depth: number): void {
  if (depth > 4) {
    add("arithmetic is nested too deeply");
    return;
  }
  for (const node of args) {
    if (isWhitespace(node) || isComma(node) || isDelim(node, "+", "-", "*", "/")) continue;
    if (tokenType(node) === "parenthesis-block" || tokenType(node) === "close-parenthesis") continue;
    if (lengthOf(node) || percentOf(node) !== null || numberOf(node) !== null || node.type === "angle") continue;
    const ref = varName(node);
    if (ref !== null) {
      if (!POINTER_VARS.has(ref)) add(`arithmetic may only read the pointer position through var(), not ${ref}`);
      continue;
    }
    const fn = functionOf(node);
    if (fn && MATH.has(fn.name)) {
      mathArguments(fn.args, add, depth + 1);
      continue;
    }
    add(`arithmetic may not contain ${describe(node)}`);
  }
}

function describe(node: Node): string {
  const fn = functionOf(node);
  if (fn) return `${fn.name}()`;
  if (node.type === "token") return `${tokenType(node)} token${isIdent(node) ? ` "${String(tokenValue(node))}"` : ""}`;
  return `${String(node.type)}()`;
}
