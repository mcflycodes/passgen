// Deny-by-default check that shipped code cannot reach the built-in
// pseudo-random generator `Math.random` (requirement S1). It analyses the
// syntax tree of each code file under src/, parsed with oxc through Vite, the
// parser the build checks in dist-checks.ts use. Comments, strings and
// templates are never read as code, so prose about the rule cannot trip it.
//
// Three objects are guarded: `Math`, and the two routes to a window object
// that normal page code touches, `globalThis` and `window`. Each may be used
// only through a short allowlist of direct member accesses; every other
// appearance is reported.
//
// 1. `Math` may appear only as `Math.<member>`: a direct, non-optional,
//    non-computed member access whose member is in `MATH_ALLOWLIST`, and
//    which is not being assigned to, incremented or deleted. `random` is not
//    in the list and never will be. Every other appearance of `Math` is
//    reported: `Math.random`, `Math?.x`, `Math[k]`, `Math.hypot` (not
//    listed), destructuring of any kind, aliasing, passing it as a value,
//    spreading it, `typeof Math`, casts such as `(Math as X).floor`,
//    exporting it, and a declaration that binds the name.
// 2. `globalThis` may appear only as `globalThis.<member>` with the member
//    in `GLOBAL_ALLOWLIST` (`crypto`), and `window` only as
//    `window.<member>` with the member in `WINDOW_ALLOWLIST`, the ordinary
//    browser APIs the page needs, under the same conditions as rule 1.
//    Anything reached through an allowed member is ordinary code:
//    `window.navigator.clipboard.writeText` and `window.document.createElement`
//    pass. Aliasing or passing either object, optional or computed access,
//    and members outside the lists (`window.Math`, `window.self`,
//    `window.top`, `window.crypto`, `window.open`, ...) are reported, so no
//    alias of the global object can be made and none needs tracking.
// 3. The identifiers `self`, `frames`, `top` and `parent`, which also name
//    the window, are reported when they are an unbound reference to the
//    global. A variable, parameter, function, class or import of the same
//    name in an enclosing scope makes the reference ordinary code, so
//    `function place(parent: HTMLElement)` and `const top = rect.top` pass.
//    Binding is decided by lexical scope analysis: a pre-pass records the
//    names each scope declares (`var` and function declarations hoist to
//    the enclosing function or module, `let`, `const`, `class` and `catch`
//    parameters stay in their block), and a reference is bound when any
//    enclosing scope declares it. Ambient `declare` statements and type-only
//    imports create no run-time binding and do not count. These four names
//    are never special as property names, object keys or strings:
//    `style.top`, `{ top: 0 }`, `rect.top`, `node.parent` pass.
// 4. A property name or key that is a route to the Math object or a window
//    is reported on ANY object: `x.Math`, `x?.Math`, `x["Math"]`,
//    `{ Math } = x`, `x.window`, `x.globalThis`, `x.defaultView`,
//    `x.contentWindow`. A string or template whose whole value is one of
//    `Math`, `globalThis`, `window`, `self`, `frames`, `defaultView` or
//    `contentWindow` is reported too, since that is such a name waiting to
//    be used as a key.
// 5. A computed key on an ordinary object or array is allowed unless it is a
//    constant that evaluates to one of the names in rule 4, folding literal
//    concatenations and substitution-free templates (`x["Ma" + "th"]` is
//    reported). Computed access on `Math`, `globalThis` or `window` is
//    reported whatever the key (rules 1 and 2).
// 6. TypeScript syntax with run-time effect (enums, namespaces with bodies,
//    parameter properties) is reported. The typecheck already refuses it
//    through `erasableSyntaxOnly`, so every other TS-only node is a type and
//    is skipped, except the expression wrappers (`as`, `satisfies`, `!`,
//    `<T>`), which are walked through.
// 7. A file that does not parse, or contains a WithStatement, is reported.
//
// `random` on its own is never special: a local, property or method named
// `random` on anything other than `Math` passes.
//
// Known limits, all needing deliberate obfuscation, which the independent
// review of every change to this area (S8) exists to catch: a key assembled
// from fragments at run time (`x[prefix + name]`, a template with
// substitutions, `String.fromCharCode`, decoding) used on an ordinary object
// is not followed; and a window reached through a value this file cannot
// see, such as `UIEvent.view` or the return value of a function, is not
// followed either. String timer callbacks and constructor chains to Function
// are allowed by this syntax check; the enforced CSP blocks their execution.

import { parseSync } from "vite";

export interface MathRandomFinding {
  file: string;
  line: number;
  column: number;
  reason: string;
}

/** Extensions of files that hold code and are analysed. */
export const SCRIPT_EXTENSIONS: readonly string[] = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];
/** Extensions of files that cannot hold executable code and are skipped. Anything else is an error. */
export const INERT_EXTENSIONS: readonly string[] = [".json", ".css", ".txt", ".md"];

/** The only members of `Math` that src/ may use. Keep it to what the code needs; `random` is never added. */
export const MATH_ALLOWLIST: readonly string[] = [
  "abs",
  "ceil",
  "clz32",
  "exp",
  "floor",
  "imul",
  "log",
  "log10",
  "log2",
  "max",
  "min",
  "pow",
  "round",
  "sign",
  "sqrt",
  "trunc",
  "E",
  "LN2",
  "LN10",
  "LOG2E",
  "LOG10E",
  "PI",
  "SQRT2",
];

/** The only member of `globalThis` that src/ may use, as `globalThis.<member>`. */
export const GLOBAL_ALLOWLIST: readonly string[] = ["crypto"];

/** The only members of `window` that src/ may use, as `window.<member>`. Web Crypto is `globalThis.crypto`, not `window.crypto`. */
export const WINDOW_ALLOWLIST: readonly string[] = [
  "addEventListener",
  "removeEventListener",
  "document",
  "matchMedia",
  "navigator",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "location",
  "history",
  "scrollTo",
  "scrollY",
  "innerWidth",
  "innerHeight",
  "getComputedStyle",
  "isSecureContext",
  "devicePixelRatio",
];

/** Identifiers that are reported wherever they appear, except as the object of an allowed member access. */
export const GUARDED_IDENTIFIERS: readonly string[] = ["Math", "globalThis", "window"];
/** Identifiers that name the window and are reported only as unbound references to the global. */
export const GLOBAL_REFERENCE_NAMES: readonly string[] = ["self", "frames", "top", "parent"];
/** Property names and keys that are a route to Math or a window, reported on any object. */
export const DANGEROUS_PROPERTY_NAMES: readonly string[] = [
  "Math",
  "globalThis",
  "window",
  "defaultView",
  "contentWindow",
];
/** Whole-string values that are reported, since they are a dangerous name waiting to be used as a key. */
export const DANGEROUS_STRINGS: readonly string[] = [
  "Math",
  "globalThis",
  "window",
  "self",
  "frames",
  "defaultView",
  "contentWindow",
];

const ALLOWLISTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Math", new Set(MATH_ALLOWLIST)],
  ["globalThis", new Set(GLOBAL_ALLOWLIST)],
  ["window", new Set(WINDOW_ALLOWLIST)],
]);
const GUARDED = new Set(GUARDED_IDENTIFIERS);
const GLOBAL_REFERENCES = new Set(GLOBAL_REFERENCE_NAMES);
const DANGEROUS_PROPERTIES = new Set(DANGEROUS_PROPERTY_NAMES);
const DANGEROUS_STRING_SET = new Set(DANGEROUS_STRINGS);
const PERMITTED_FORMS = "Math.<allowed member>, globalThis.crypto and window.<allowed member>";

/** TypeScript expression wrappers with no run-time effect; their `expression` is walked. */
const TRANSPARENT_TS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
/** TypeScript declarations with run-time effect, which `erasableSyntaxOnly` forbids. */
const RUNTIME_TS: ReadonlySet<string> = new Set(["TSEnumDeclaration", "TSModuleDeclaration", "TSParameterProperty"]);
/** Keys under which only type syntax lives. */
const TYPE_KEYS: ReadonlySet<string> = new Set(["typeAnnotation", "typeParameters", "typeArguments", "returnType"]);
/** Nodes that open a lexical scope. */
const FUNCTION_SCOPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "StaticBlock",
]);
const BLOCK_SCOPES: ReadonlySet<string> = new Set([
  "BlockStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "CatchClause",
  "ClassDeclaration",
  "ClassExpression",
]);
/** Node types whose non-computed `key` is a name, not an expression. */
const KEYED: ReadonlySet<string> = new Set(["Property", "PropertyDefinition", "MethodDefinition", "AccessorProperty"]);

type Node = { type: string; start?: number; end?: number; [key: string]: unknown };
/** How an identifier is used: as an expression, as a name (property, key, label), or as a binding being declared. */
type Context = "expression" | "name" | "binding";

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** Strips the TypeScript wrappers from an expression. */
function unwrapTs(node: Node): Node {
  let current = node;
  while (TRANSPARENT_TS.has(current.type)) current = current.expression as Node;
  return current;
}

/**
 * The string a constant expression evaluates to: a string literal, a template
 * whose substitutions are all constant, or a `+` of constants. Undefined when
 * any part is not a literal.
 */
function constantString(node: Node): string | undefined {
  const inner = unwrapTs(node);
  if (inner.type === "ParenthesizedExpression") return constantString(inner.expression as Node);
  if (inner.type === "Literal") {
    return typeof inner.value === "string" || typeof inner.value === "number" ? String(inner.value) : undefined;
  }
  if (inner.type === "TemplateLiteral") {
    const quasis = inner.quasis as Array<{ value: { cooked: string | null } }>;
    const expressions = inner.expressions as Node[];
    let out = "";
    for (let i = 0; i < quasis.length; i += 1) {
      const cooked = quasis[i]?.value.cooked;
      if (cooked === null || cooked === undefined) return undefined;
      out += cooked;
      if (i < expressions.length) {
        const part = constantString(expressions[i] as Node);
        if (part === undefined) return undefined;
        out += part;
      }
    }
    return out;
  }
  if (inner.type === "BinaryExpression" && inner.operator === "+") {
    const left = constantString(inner.left as Node);
    const right = constantString(inner.right as Node);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

/** Every name a binding pattern introduces. */
function boundNames(pattern: Node, out: string[] = []): string[] {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties as Node[]) {
        boundNames(property.type === "RestElement" ? (property.argument as Node) : (property.value as Node), out);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements as Array<Node | null>) if (element) boundNames(element, out);
      break;
    case "RestElement":
      boundNames(pattern.argument as Node, out);
      break;
    case "AssignmentPattern":
      boundNames(pattern.left as Node, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Pre-pass: the names each scope declares at run time. `var` and function
 * declarations hoist to the nearest function or module scope; `let`, `const`
 * and `class` stay in their block; parameters belong to their function; a
 * named function or class expression sees its own name; `catch (e)` binds in
 * the catch clause; imports bind in the module. `declare` statements and
 * type-only imports bind nothing.
 */
function collectScopes(program: Node): Map<Node, Set<string>> {
  const scopes = new Map<Node, Set<string>>();
  const stack: Node[] = [];
  const declare = (scope: Node, names: readonly string[]) => {
    let set = scopes.get(scope);
    if (set === undefined) {
      set = new Set();
      scopes.set(scope, set);
    }
    for (const name of names) set.add(name);
  };
  const enclosing = () => stack[stack.length - 1] as Node;
  const nearestFunction = () => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const scope = stack[i] as Node;
      if (scope.type === "Program" || FUNCTION_SCOPES.has(scope.type)) {
        // Body var bindings are invisible to parameter initializers. The body
        // block is visited separately; parameters stay in the function scope.
        return isNode(scope.body) && scope.body.type === "BlockStatement" ? scope.body : scope;
      }
    }
    return program;
  };

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isNode(node)) return;
    if (node.type.startsWith("TS") && !TRANSPARENT_TS.has(node.type)) return;

    // Declarations that bind in the scope enclosing the node.
    if (node.type === "FunctionDeclaration" && node.id && node.declare !== true)
      declare(enclosing(), boundNames(node.id as Node));
    if (node.type === "ClassDeclaration" && node.id && node.declare !== true)
      declare(enclosing(), boundNames(node.id as Node));
    if (node.type === "VariableDeclaration" && node.declare !== true) {
      const target = node.kind === "var" ? nearestFunction() : enclosing();
      for (const declarator of node.declarations as Node[]) declare(target, boundNames(declarator.id as Node));
    }
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      for (const specifier of node.specifiers as Node[]) {
        if (specifier.importKind !== "type") declare(program, boundNames(specifier.local as Node));
      }
    }

    const opensScope = node.type === "Program" || FUNCTION_SCOPES.has(node.type) || BLOCK_SCOPES.has(node.type);
    if (opensScope) stack.push(node);
    // Declarations that bind inside the node's own scope.
    if (FUNCTION_SCOPES.has(node.type)) {
      if (node.type === "FunctionExpression" && node.id) declare(node, boundNames(node.id as Node));
      for (const param of (node.params as Node[] | undefined) ?? []) declare(node, boundNames(param));
    }
    if (node.type === "ClassExpression" && node.id) declare(node, boundNames(node.id as Node));
    if (node.type === "CatchClause" && node.param) declare(node, boundNames(node.param as Node));

    for (const [key, value] of Object.entries(node)) {
      if (TYPE_KEYS.has(key)) continue;
      visit(value);
    }
    if (opensScope) stack.pop();
  }
  visit(program);
  return scopes;
}

export function scanSourceForMathRandom(file: string, source: string): MathRandomFinding[] {
  const findings: MathRandomFinding[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const report = (node: Node, reason: string) => {
    const offset = node.start ?? 0;
    let line = lineStarts.findIndex((start) => start > offset);
    if (line === -1) line = lineStarts.length;
    findings.push({ file, line, column: offset - (lineStarts[line - 1] ?? 0) + 1, reason });
  };

  const { program, errors } = parseSync(file, source, { sourceType: "module" });
  if (errors.length > 0) {
    for (const error of errors) findings.push({ file, line: 0, column: 0, reason: `does not parse: ${error.message}` });
    return findings;
  }

  const scopes = collectScopes(program as unknown as Node);
  const scopeStack: Node[] = [];
  const isBound = (name: string) => scopeStack.some((scope) => scopes.get(scope)?.has(name) === true);

  /** Identifier nodes that are the object of an allowed member access. */
  const allowedObjects = new Set<Node>();

  /** Applies the allowlists to a member access on Math, globalThis or window, and the key rules to everything else. */
  function checkMember(node: Node, assigned: boolean): void {
    const object = node.object as Node;
    const property = node.property as Node;
    const computed = node.computed === true;
    const optional = node.optional === true;

    const allowed = object.type === "Identifier" ? ALLOWLISTS.get(object.name as string) : undefined;
    if (allowed !== undefined) {
      const root = object.name as string;
      const name = computed ? undefined : (property.name as string);
      if (computed) report(node, `computed access on ${root}; only ${root}.<allowed member> is permitted`);
      else if (optional) report(node, `optional access on ${root}; only ${root}.<allowed member> is permitted`);
      else if (!allowed.has(name as string)) report(node, `${root}.${name} is not in the allowlist`);
      else if (assigned) report(node, `${root}.${name} is assigned to`);
      allowedObjects.add(object); // either allowed, or already reported at the access
      return;
    }
    if (computed) checkComputedKey(property, "property access");
    // A dangerous non-computed property name is reported where the identifier is visited.
  }

  /** Computed keys on ordinary objects may not be a constant that evaluates to a dangerous name. */
  function checkComputedKey(key: Node, where: string): void {
    const value = constantString(key);
    if (value !== undefined && DANGEROUS_PROPERTIES.has(value)) report(key, `${where} with the key "${value}"`);
  }

  function checkIdentifier(node: Node, context: Context): void {
    const name = node.name as string;
    if (GUARDED.has(name)) {
      if (!allowedObjects.has(node))
        report(node, `\`${name}\` may not appear here; only ${PERMITTED_FORMS} are permitted`);
      return;
    }
    if (context === "name" && DANGEROUS_PROPERTIES.has(name)) {
      report(node, `property named ${name} is a route to the global object`);
      return;
    }
    if (context === "expression" && GLOBAL_REFERENCES.has(name) && !isBound(name)) {
      report(node, `\`${name}\` refers to the global window; only ${PERMITTED_FORMS} are permitted`);
    }
  }

  /** The context each child of `node` is in, given the node's own context. */
  function childContext(node: Node, key: string, context: Context): Context {
    switch (node.type) {
      case "MemberExpression":
        return key === "property" && node.computed !== true ? "name" : "expression";
      case "Property":
      case "PropertyDefinition":
      case "MethodDefinition":
      case "AccessorProperty":
        if (key === "key") return node.computed === true ? "expression" : "name";
        return key === "value" && context === "binding" ? "binding" : "expression";
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
        return context; // a pattern passes its own context (binding, or expression for an assignment target) down
      case "AssignmentPattern":
        return key === "left" ? context : "expression";
      case "VariableDeclarator":
        return key === "id" ? "binding" : "expression";
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return key === "id" || key === "params" ? "binding" : "expression";
      case "ClassDeclaration":
      case "ClassExpression":
        return key === "id" ? "binding" : "expression";
      case "CatchClause":
        return key === "param" ? "binding" : "expression";
      case "ImportSpecifier":
        return key === "imported" ? "name" : "binding";
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        return "binding";
      case "ExportSpecifier":
        return key === "exported" ? "name" : "expression";
      case "LabeledStatement":
      case "BreakStatement":
      case "ContinueStatement":
        return key === "label" ? "name" : "expression";
      case "MetaProperty":
        return "name";
      default:
        return "expression";
    }
  }

  /**
   * Walks evaluation positions. `assigned` is true below the target of an
   * assignment, update or delete, where an allowed member access is not allowed.
   */
  function walk(node: unknown, context: Context, assigned: boolean): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context, assigned);
      return;
    }
    if (!isNode(node)) return;
    if (node.type.startsWith("TS") && !TRANSPARENT_TS.has(node.type)) {
      if (RUNTIME_TS.has(node.type) && node.declare !== true)
        report(node, `${node.type} has run-time effect and is not erasable`);
      return;
    }

    switch (node.type) {
      case "WithStatement":
        report(node, "WithStatement changes lexical name resolution and is forbidden");
        break;
      case "Identifier":
        checkIdentifier(node, context);
        return; // identifiers have no evaluated children
      case "Literal":
      case "TemplateLiteral": {
        const value =
          node.type === "TemplateLiteral" && (node.expressions as unknown[]).length > 0
            ? undefined
            : constantString(node);
        if (value !== undefined && DANGEROUS_STRING_SET.has(value))
          report(node, `string "${value}" names a dangerous object`);
        break;
      }
      case "MemberExpression":
        checkMember(node, assigned);
        break;
      default:
        if (KEYED.has(node.type) && node.computed === true) checkComputedKey(node.key as Node, "computed key");
        break;
    }

    const opensScope = node.type === "Program" || FUNCTION_SCOPES.has(node.type) || BLOCK_SCOPES.has(node.type);
    if (opensScope) scopeStack.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (TYPE_KEYS.has(key)) continue;
      const target =
        (node.type === "AssignmentExpression" && key === "left") ||
        (node.type === "UpdateExpression" && key === "argument") ||
        (node.type === "UnaryExpression" && node.operator === "delete" && key === "argument") ||
        ((node.type === "ForInStatement" || node.type === "ForOfStatement") && key === "left");
      // Below a member access that is itself a target, only the outermost access is "assigned to".
      const nextAssigned = target ? true : node.type === "MemberExpression" ? false : assigned;
      walk(value, childContext(node, key, context), nextAssigned);
    }
    if (opensScope) scopeStack.pop();
  }

  walk(program, "expression", false);

  const seen = new Set<string>();
  return findings
    .filter((f) => {
      const key = `${f.line}:${f.column}:${f.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}
