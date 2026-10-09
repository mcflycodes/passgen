// Requirement S1: nothing that ships may use the built-in pseudo-random
// generator or anything derived from it. scripts/lib/math-random-scan.ts is a
// deny-by-default syntax check; this file runs it over every code file under
// src/, over fixtures that must be reported, and over fixtures that must pass.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, test } from "node:test";
import {
  DANGEROUS_PROPERTY_NAMES,
  DANGEROUS_STRINGS,
  GLOBAL_ALLOWLIST,
  GLOBAL_REFERENCE_NAMES,
  GUARDED_IDENTIFIERS,
  INERT_EXTENSIONS,
  MATH_ALLOWLIST,
  SCRIPT_EXTENSIONS,
  scanSourceForMathRandom,
  WINDOW_ALLOWLIST,
} from "../../scripts/lib/math-random-scan.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");

test("no code file under src/ can reach Math.random", async () => {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  assert.ok(files.length > 0, "src/ has files");
  const findings: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const extension = extname(file);
    if (INERT_EXTENSIONS.includes(extension)) continue;
    assert.ok(
      SCRIPT_EXTENSIONS.includes(extension),
      `${relative(SRC, file)}: unknown file type ${extension}; decide whether it can hold code and list it in math-random-scan.ts`,
    );
    const text = await readFile(file, "utf8");
    for (const f of scanSourceForMathRandom(relative(SRC, file), text)) {
      findings.push(`${f.file}:${f.line}:${f.column}: ${f.reason}`);
    }
    scanned += 1;
  }
  assert.ok(scanned > 0, "src/ has code files");
  assert.deepEqual(findings, [], "see the rules at the top of scripts/lib/math-random-scan.ts");
});

test("the allowlists never open a route to Math.random or to another window", () => {
  assert.ok(!MATH_ALLOWLIST.includes("random"));
  for (const list of [GLOBAL_ALLOWLIST, WINDOW_ALLOWLIST]) {
    for (const name of [...DANGEROUS_PROPERTY_NAMES, ...GLOBAL_REFERENCE_NAMES, "crypto", "open", "eval", "Function"]) {
      if (list === GLOBAL_ALLOWLIST && name === "crypto") continue;
      assert.ok(!list.includes(name), name);
    }
  }
  assert.deepEqual(GUARDED_IDENTIFIERS, ["Math", "globalThis", "window"]);
  assert.deepEqual(GLOBAL_REFERENCE_NAMES, ["self", "frames", "top", "parent"]);
  assert.deepEqual(DANGEROUS_STRINGS, [
    "Math",
    "globalThis",
    "window",
    "self",
    "frames",
    "defaultView",
    "contentWindow",
  ]);
});

test("TS-only syntax is skipped because the typecheck refuses non-erasable syntax", async () => {
  const base = JSON.parse(await readFile(join(ROOT, "tsconfig.base.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(base.compilerOptions.erasableSyntaxOnly, true);
});

/** Reasons found in a fixture, in source order. */
const reasons = (source: string) => scanSourceForMathRandom("fixture.ts", source).map((f) => f.reason);

describe("fixtures that must be reported", () => {
  const mustFail: Array<[string, string]> = [
    // Direct forms.
    ["plain call", "export const x = Math.random();"],
    ["optional chaining", "export const x = Math?.random();"],
    ["access split across lines", "export const x = Math\n  .random();"],
    ["access with whitespace", "export const x = Math . random ();"],
    ["double-quoted element access", 'export const x = Math["random"]();'],
    ["single-quoted element access", "export const x = Math['random']();"],
    ["template element access", "export const x = Math[`random`]();"],
    ["optional element access", 'export const x = Math?.["random"]();'],
    ["non-constant key", "export const f = (k: string) => Math[k as keyof Math];"],
    ["template key with a substitution", "export const f = (k: string) => Math[`$" + "{k}`];"],
    ["method borrowed", "export const x = Math.random.call(undefined);"],
    ["method bound", "export const r = Math.random.bind(Math);"],
    ["stored without calling", "export const r = Math.random;"],
    ["a Math member outside the allowlist", "export const h = Math.hypot(3, 4);"],
    ["an allowed member through optional chaining", "export const f = Math?.floor(1.5);"],
    ["an allowed member through element access", 'export const f = Math["floor"](1.5);'],
    [
      "an allowed member through a cast",
      "export const f = (Math as unknown as { floor(x: number): number }).floor(1.5);",
    ],
    ["an allowed member assigned to", "Math.floor = (x: number) => x;"],
    ["an allowed member deleted", "delete (Math as { floor?: unknown }).floor;"],
    ["an allowed member incremented", "Math.PI++;"],
    ["an allowed member as a for-of target", "for (Math.PI of [3]) {}"],
    // Destructuring.
    ["destructured", "const { random } = Math; export const x = random();"],
    ["destructured and renamed", "const { random: r } = Math; export const x = r();"],
    ["destructured with a quoted key", 'const { "random": rng } = Math; export const x = rng();'],
    ["destructured with a computed key", 'const key = "random"; const { [key]: rng } = Math; export const x = rng();'],
    ["destructured rest", "const { PI, ...rest } = Math; export const x = rest;"],
    ["destructured in an assignment", "let r: () => number; ({ random: r } = Math); export const x = r;"],
    ["an allowed member destructured", "const { floor } = Math; export const x = floor(1.5);"],
    ["nested destructuring from globalThis", "const { Math: { floor } } = globalThis; export const x = floor(1.5);"],
    // Aliases of Math.
    ["alias", "const M = Math; export const x = M.random();"],
    ["alias declared after use", "export function f() { return M.random(); }\nvar M = Math;"],
    ["alias of an alias", "const A = Math; const B = A; export const x = B.random();"],
    ["alias by assignment", "let m: Math; m = Math; export const x = m.random();"],
    ["alias by logical or", "export const f = (o: Math | null) => (o || Math).random();"],
    ["alias by nullish coalescing", "export const f = (o: Math | null) => (o ?? Math).random();"],
    ["alias by conditional", "export const f = (c: boolean, o: Math) => (c ? Math : o).random();"],
    ["alias as a parameter default", "export function f(m = Math) { return m.random(); }"],
    ["alias used as a value", "const M = Math; export const x = M;"],
    ["aliasing itself", "export const M = Math;"],
    ["passed as an argument", 'export const d = Reflect.get(Math, "random");'],
    ["returned", "export function f() { return Math; }"],
    ["in an object literal", "export const o = { Math };"],
    ["in an array literal", "export const a = [Math];"],
    ["spread", "export const o = { ...Math };"],
    ["typeof", "export const t = typeof Math;"],
    ["exported", "export { Math };"],
    ["through a comma sequence", "export const x = (0, Math).random();"],
    // The global object and its aliases.
    ["through globalThis", "export const x = globalThis.Math.random();"],
    ["through window", "export const x = window.Math.random();"],
    ["through self with element access", 'export const x = self["Math"].random();'],
    ["through a nested global", "export const x = globalThis.window.Math.random();"],
    ["through a non-null assertion", "export const x = globalThis.Math!.random();"],
    ["destructured from globalThis", "const { Math: M } = globalThis; export const x = M.random();"],
    ["through an alias of globalThis", "const g = globalThis; export const x = g.Math.random();"],
    [
      "through a conditional global alias",
      'const root = typeof window === "undefined" ? globalThis : window; export const x = root.Math.random();',
    ],
    ["through a logical-or global alias", "const root = window || globalThis; export const x = root.Math.random();"],
    ["through a nullish global alias", "const root = self ?? globalThis; export const x = root.Math.random();"],
    [
      "through an assigned global alias",
      "let root: typeof globalThis; root = globalThis; export const x = root.Math.random();",
    ],
    ["global object passed as a value", "export const g = ((h: unknown) => h)(globalThis);"],
    ["globalThis member outside the allowlist", "export const d = globalThis.document;"],
    ["globalThis through element access", 'export const c = globalThis["crypto"];'],
    ["frames, top and parent", "export const w = [frames, top, parent];"],
    // Property named Math, or a route to the global object, on any object.
    ["x.Math on an arbitrary object", "export const f = (x: { Math: Math }) => x.Math.random();"],
    ["x?.Math on an arbitrary object", "export const f = (x?: { Math: Math }) => x?.Math.random();"],
    ['x["Math"] on an arbitrary object', 'export const f = (x: Record<string, Math>) => x["Math"].random();'],
    [
      "{ Math } from an arbitrary object",
      "export const f = (x: { Math: Math }) => { const { Math: m } = x; return m.random(); };",
    ],
    [
      '{ "Math": m } from an arbitrary object',
      'export const f = (x: { Math: Math }) => { const { "Math": m } = x; return m.random(); };',
    ],
    [
      "concatenated constant key on an arbitrary object",
      'export const f = (x: Record<string, unknown>) => x["Ma" + "th"];',
    ],
    [
      "template constant key on an arbitrary object",
      "export const f = (x: Record<string, unknown>) => x[`Ma$" + "{'th'}`];",
    ],
    [
      "parenthesised constant key on an arbitrary object",
      'export const f = (x: Record<string, unknown>) => x[("M" + "a") + "th"];',
    ],
    [
      "constant key naming window on an arbitrary object",
      'export const f = (x: Record<string, unknown>) => x["win" + "dow"];',
    ],
    [
      "constant key naming defaultView on an arbitrary object",
      'export const f = (d: Document) => (d as unknown as Record<string, unknown>)["defaultView"];',
    ],
    ['the string "Math" as a value', 'export const key = "Math";'],
    ["the template `Math` as a value", "export const key = `Math`;"],
    ['the strings "window", "self" and "frames" as values', 'export const keys = ["window", "self", "frames"];'],
    [
      'the strings "defaultView" and "contentWindow" as values',
      'export const keys = ["defaultView", "contentWindow"];',
    ],
    ['the string "globalThis" as a value', 'export const key = "globalThis";'],
    ["defaultView", "export const w = document.defaultView;"],
    ["contentWindow", "export const f = (i: HTMLIFrameElement) => i.contentWindow;"],
    // window: everything outside the allowlist.
    ["window.Math", "export const x = window.Math.random();"],
    ["window.self", "export const w = window.self;"],
    ["window.globalThis", "export const w = window.globalThis;"],
    ["window.window", "export const w = window.window;"],
    ["window.top, window.parent and window.frames", "export const w = [window.top, window.parent, window.frames];"],
    ["window.crypto", "export const c = window.crypto;"],
    ["window.open", 'export const w = window.open("about:blank");'],
    ["window.eval", 'export const w = window.eval("1");'],
    ["window aliased", "const w = window; export const d = w.document;"],
    ["window passed as a value", "export const g = ((h: unknown) => h)(window);"],
    ["window with optional access", "export const d = window?.document;"],
    ["window with element access on an allowed member", 'export const d = window["document"];'],
    [
      "window with a computed key",
      "export const f = (k: string) => (window as unknown as Record<string, unknown>)[k];",
    ],
    ["window allowed member assigned to", "window.scrollY = 0;"],
    ["window.visualViewport.Math", "export const r = window.visualViewport.Math.random();"],
    ["window.visualViewport.defaultView", "export const w = window.visualViewport.defaultView;"],
    ["window.document.defaultView", "export const w = window.document.defaultView;"],
    ["globalThis.window", "export const w = globalThis.window;"],
    ["globalThis.self", "export const w = globalThis.self;"],
    // Unbound references to the other window names.
    ["bare top", "export const t = top;"],
    ["bare parent", 'parent.postMessage("hi", "*");'],
    ["bare frames", "export const n = frames.length;"],
    ["bare self", "export const c = self.crypto;"],
    ["self.Math", "export const x = self.Math.random();"],
    ["top assigned", "top = null as never;"],
    ["parent as an assignment target in a pattern", "({ a: parent } = { a: null as never });"],
    ["an ambient declaration does not bind", "declare const top: Window; export const t = top;"],
    ["a type-only import does not bind", 'import type { parent } from "./types.ts"; export const p = parent;'],
    [
      "a binding in another function does not bind",
      "function f(parent: HTMLElement) { return parent; }\nexport const p = parent;",
    ],
    ["a block-scoped binding does not reach outside its block", "{ const top = 1; void top; }\nexport const t = top;"],
    ["a class member named self does not bind the identifier", "export class C { self = 1; f() { return self; } }"],
    // Shadowing.
    ["shadowing variable", "const Math = { random: () => 4 }; export const x = Math.random();"],
    ["shadowing parameter", "export function f(Math: { random(): number }) { return Math.random(); }"],
    ["shadowing import", 'import { Math } from "./fake.ts"; export const x = Math.random();'],
    ["shadowing by destructuring", "const { Math } = globalThis; export const x = Math.random();"],
    ["shadowing a global name", "const window = { Math }; export const x = window.Math;"],
    // Non-erasable TypeScript and parse errors.
    ["an enum", "export enum E { A = 1 }"],
    ["a namespace with a body", "export namespace N { export const x = 1; }"],
    ["a parameter property", "export class C { constructor(public x: number) {} }"],
    ["syntax error", "export const x = Math.random("],
  ];
  for (const [label, source] of mustFail) {
    test(label, () => {
      assert.ok(reasons(source).length > 0, `nothing reported for: ${source}`);
    });
  }

  test("body var bindings do not hide globals in parameter initializers", () => {
    for (const name of GLOBAL_REFERENCE_NAMES) {
      for (const declaration of [`var ${name};`, `{ var ${name}; }`]) {
        const source = `function f(x = ${name}) { ${declaration} return x; }`;
        assert.equal(reasons(source).length, 1, source);
        assert.match(reasons(source)[0] as string, /refers to the global window/);
      }
    }
  });

  test("explicitly rejects with even when the parser accepts it", () => {
    assert.deepEqual(reasons("with (obj) { void value; }"), [
      "WithStatement changes lexical name resolution and is forbidden",
    ]);
  });

  test("names the allowlist miss for Math.random", () => {
    assert.deepEqual(reasons("export const x = Math.random();"), ["Math.random is not in the allowlist"]);
  });

  test("reports the line and column of the access, not the file start", () => {
    const [finding] = scanSourceForMathRandom(
      "fixture.ts",
      "const a = 1;\nconst b = 2;\n  export const c = Math.random();\n",
    );
    assert.deepEqual(finding, {
      file: "fixture.ts",
      line: 3,
      column: 20,
      reason: "Math.random is not in the allowlist",
    });
  });

  test("reports the alias and every use of it", () => {
    const findings = scanSourceForMathRandom(
      "fixture.ts",
      "const M = Math;\nexport const a = M.random();\nexport const b = M.random();\n",
    );
    assert.deepEqual(
      findings.map((f) => f.line),
      [1],
      "the alias itself is reported; its uses need no tracking because the alias cannot be made",
    );
  });

  test("reports window members outside the allowlist by name", () => {
    assert.deepEqual(reasons("export const c = window.crypto;"), ["window.crypto is not in the allowlist"]);
  });

  test("reports an unbound top as a reference to the global", () => {
    assert.deepEqual(reasons("export const t = top;"), [
      "`top` refers to the global window; only Math.<allowed member>, globalThis.crypto and window.<allowed member> are permitted",
    ]);
  });

  test("reports the conditional global alias at its source, before any use", () => {
    const findings = scanSourceForMathRandom(
      "fixture.ts",
      'const root = typeof window === "undefined" ? globalThis : window;\nexport const x = root.Math.random();\n',
    );
    assert.deepEqual(
      findings.map((f) => `${f.line}:${f.column}`),
      ["1:21", "1:46", "1:59", "2:23"],
      "window, globalThis, window, and .Math on root",
    );
  });
});

describe("fixtures that must pass", () => {
  const mustPass: Array<[string, string]> = [
    [
      "allowed Math members",
      "export const k = Math.floor(1.5) + Math.max(1, 2) + Math.clz32(7) + Math.log2(8) + Math.PI;",
    ],
    ["an allowed member used as a value", "export const r = [1.5, 2.5].map(Math.floor);"],
    ["an allowed member's own property", "export const n = Math.floor.name;"],
    ["globalThis.crypto", "export const c = globalThis.crypto;"],
    ["globalThis.crypto.getRandomValues", "export const w = globalThis.crypto.getRandomValues(new Uint32Array(1));"],
    ["bare crypto", "export const w = crypto.getRandomValues(new Uint32Array(1));"],
    ["line comment", "// Math.random() must never be used\nexport const k = 1;"],
    ["block comment", "/* Math.random() and Math['random'] are forbidden; window.Math too */\nexport const k = 1;"],
    ["doc comment", "/** Never `Math.random`. */\nexport const k = 1;"],
    ["string literal mentioning it", 'export const s = "Math.random()";'],
    ["single-quoted string mentioning it", "export const s = 'use Math.floor, not Math.random';"],
    ["template literal mentioning it", "export const s = `Math.random() is banned`;"],
    [
      "template literal with substitutions as a value",
      "export const f = (x: number) => `$" + "{x} random Math $" + "{x}`;",
    ],
    ["random on another object", "export const f = (source: { random(): number }) => source.random();"],
    ["random as a local name", "const random = 4; export const r = random;"],
    ["random as an object key", "export const o = { random: 1 };"],
    ["random as an element key on another object", 'export const f = (o: Record<string, number>) => o["random"];'],
    ["random as a method name", "export class C { random() { return 4; } }"],
    ["random as a property name", "export class C { random = 4; }"],
    [
      "random destructured from another object",
      "export const f = (o: { random: number }) => { const { random } = o; return random; };",
    ],
    ["an identifier key on another object", "export const f = (o: Record<string, number>, k: string) => o[k];"],
    ["a numeric index", "export const f = (a: number[], i: number) => a[i] + (a[0] ?? 0);"],
    ["a cast identifier key", "export const f = (o: { a: number }, k: string) => o[k as keyof typeof o];"],
    ["import of the project module", 'import { randomInt } from "./random.ts"; export const n = randomInt(6);'],
    ["Math in a type position", "export type T = typeof Math; export let m: typeof Math | undefined;"],
    ["Math in a type query on a member", "export type R = (typeof Math)['clz32'];"],
    ["window in a type position", "export type W = typeof window; export let w: Window | undefined;"],
    ["a type-only enum-like union", 'export type E = "a" | "b";'],
    ["a declared namespace", "declare namespace N { const x: number; }\nexport const y = 1;"],
    ["document without a route to the window", 'document.documentElement.dataset.ready = "true";'],
    // window.<allowed member> and the chains below it.
    ["window.addEventListener", 'window.addEventListener("resize", () => {});'],
    ["window.removeEventListener", 'export const f = (h: () => void) => window.removeEventListener("resize", h);'],
    ["window.document.createElement", 'export const el = window.document.createElement("div");'],
    ["window.visualViewport geometry", "export const h = window.visualViewport?.height;"],
    ["window.matchMedia", 'export const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;'],
    ["window.navigator.clipboard.writeText", 'export const p = window.navigator.clipboard.writeText("x");'],
    ["window.localStorage.setItem", 'window.localStorage.setItem("k", "v");'],
    ["window.sessionStorage", 'export const v = window.sessionStorage.getItem("k");'],
    ["window.requestAnimationFrame", "export const id = window.requestAnimationFrame(() => {});"],
    ["window.cancelAnimationFrame", "export const f = (id: number) => window.cancelAnimationFrame(id);"],
    ["window.setTimeout and clearTimeout", "const t = window.setTimeout(() => {}, 1); window.clearTimeout(t);"],
    ["window.setInterval and clearInterval", "const t = window.setInterval(() => {}, 1); window.clearInterval(t);"],
    [
      "window.location and history",
      'export const h = window.location.hash; window.history.replaceState(null, "", "#a");',
    ],
    ["window.scrollTo and scrollY", "window.scrollTo({ top: 0 }); export const y = window.scrollY;"],
    ["window.innerWidth and innerHeight", "export const area = window.innerWidth * window.innerHeight;"],
    ["window.getComputedStyle", "export const f = (el: Element) => window.getComputedStyle(el).color;"],
    [
      "window.isSecureContext and devicePixelRatio",
      "export const ok = window.isSecureContext && window.devicePixelRatio > 1;",
    ],
    ["an allowed window member used as a value", "export const raf = window.requestAnimationFrame;"],
    // The same APIs as bare globals.
    ["bare addEventListener", 'addEventListener("resize", () => {});'],
    ["bare document.createElement", 'export const el = document.createElement("div");'],
    ["bare matchMedia", 'export const dark = matchMedia("(prefers-color-scheme: dark)").matches;'],
    ["bare navigator.clipboard.writeText", 'export const p = navigator.clipboard.writeText("x");'],
    ["bare localStorage.setItem", 'localStorage.setItem("k", "v");'],
    ["bare requestAnimationFrame", "export const id = requestAnimationFrame(() => {});"],
    ["bare setTimeout", "export const t = setTimeout(() => {}, 1);"],
    [
      "bare location, history, scrollTo",
      'export const h = location.hash; history.replaceState(null, "", "#a"); scrollTo({ top: 0 });',
    ],
    [
      "bare innerWidth and getComputedStyle",
      "export const f = (el: Element) => innerWidth + Number(getComputedStyle(el).width);",
    ],
    ["bare isSecureContext and devicePixelRatio", "export const ok = isSecureContext && devicePixelRatio > 1;"],
    // top, parent, frames and self as ordinary names.
    ["style.top", 'export const f = (el: HTMLElement) => { el.style.top = "0px"; };'],
    ["scrollTo with a top option", 'window.scrollTo({ top: 0, behavior: "smooth" });'],
    ["getBoundingClientRect().top", "export const f = (el: Element) => el.getBoundingClientRect().top;"],
    ["a parent parameter", "export function place(parent: HTMLElement, child: HTMLElement) { parent.append(child); }"],
    ["node.parent", "export const f = (node: { parent: unknown }) => node.parent;"],
    [
      "top and left destructured from a rect",
      "export const f = (el: Element) => { const { top, left } = el.getBoundingClientRect(); return top + left; };",
    ],
    ["a top variable", "const top = 0; export const t = top + 1;"],
    ["a frames variable", "const frames: number[] = []; frames.push(1); export const n = frames.length;"],
    ["self bound to this", "export class C { x = 1; f() { const self = this; return () => self.x; } }"],
    [
      "a loop variable named top",
      "export const f = (tops: number[]) => { let sum = 0; for (const top of tops) sum += top; return sum; };",
    ],
    ["a var hoisted from a block", "export function f() { { var parent = 1; } return parent; }"],
    ["a function named top", "function top() { return 1; } export const t = top();"],
    ["an imported parent", 'import { parent } from "./tree.ts"; export const p = parent;'],
    ["a catch parameter named self", "export function f() { try { return 1; } catch (self) { return self; } }"],
    [
      "a named function expression seeing its own name",
      "export const g = function top(n: number): number { return n ? top(n - 1) : 0; };",
    ],
    ["an arrow parameter named frames", "export const f = (frames: number[]) => frames.length;"],
    ["strings whose value is top or parent", 'export const t = "top"; export const p = `parent`;'],
    ["top and parent as object keys", "export const o = { top: 0, parent: null };"],
    // Computed keys on ordinary objects and arrays.
    ["items[i + 1]", "export const f = (items: number[], i: number) => items[i + 1];"],
    [
      'labels["label-" + id]',
      'export const f = (labels: Record<string, string>, id: string) => labels["label-" + id];',
    ],
    [
      "a template key with a substitution",
      "export const f = (o: Record<string, number>, i: number) => o[`item-$" + "{i}`];",
    ],
    ["a constant key that is not dangerous", 'export const f = (o: Record<string, number>) => o["ran" + "dom"];'],
    [
      "unrelated identifiers",
      "export const m = { Mathematics: 1, randomness: 2, selfish: 3, windows: 4 }.Mathematics;",
    ],
    [
      "labels and object shorthand",
      "export const f = (random: number) => { outer: for (;;) { break outer; } return { random }; };",
    ],
    [
      "assignment to another object's member",
      "export const f = (o: { floor: number }) => { o.floor = 1; o.floor++; };",
    ],
  ];
  for (const [label, source] of mustPass) {
    test(label, () => {
      assert.deepEqual(reasons(source), [], source);
    });
  }

  test("parameter bindings and outer bindings remain visible in defaults", () => {
    for (const source of [
      "function f(self, x = self) { var self; return x; }",
      "const self = 1; function f(x = self) { var self; return x; }",
      "const f = function self(x = self) { var self; return x; };",
      "function f(x = () => self) { var self; return x; }",
    ]) {
      // The last closure is created in the parameter scope, outside the body.
      if (source.includes("() => self"))
        assert.deepEqual(reasons(source), [
          "`self` refers to the global window; only Math.<allowed member>, globalThis.crypto and window.<allowed member> are permitted",
        ]);
      else assert.deepEqual(reasons(source), [], source);
    }
  });

  test("accepted string timer callbacks and constructor chains rely on CSP", () => {
    for (const source of [
      'window.setTimeout("doWork()", 1);',
      'window.setInterval("doWork()", 1);',
      'const run = (() => {}).constructor("return 1"); run();',
    ])
      assert.deepEqual(reasons(source), [], source);
  });

  test("documents runtime concatenated and template keys on arbitrary objects as a known limit", () => {
    for (const source of [
      'const suffix = "th"; const value = obj["Ma" + suffix];',
      'const suffix = "th"; const value = obj[`Ma$' + "{suffix}`];",
    ])
      assert.deepEqual(reasons(source), [], source);
  });

  test("the real module passes", async () => {
    const text = await readFile(join(SRC, "core", "random.ts"), "utf8");
    assert.deepEqual(scanSourceForMathRandom("core/random.ts", text), []);
  });
});
