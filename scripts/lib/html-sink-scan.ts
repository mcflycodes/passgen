// No HTML sink is needed by PassGen. Fail closed without exceptions or
// exemptions, using the same decoded syntax tree as the build scanners.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSync } from "vite";

type Node = { type: string; start?: number; [key: string]: unknown };
const SINKS = new Set([
  "setHTMLUnsafe",
  "parseHTMLUnsafe",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "parseFromString",
  "createContextualFragment",
  "srcdoc",
]);

function literal(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0)
    return ((node.quasis as Node[])[0]?.value as { cooked?: string } | undefined)?.cooked;
  if (["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"].includes(node.type))
    return literal(node.expression as Node);
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left as Node);
    const right = literal(node.right as Node);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

export function htmlSinkProblems(source: string): string[] {
  const { program, errors } = parseSync("source.ts", source, { sourceType: "module" });
  if (errors.length) return ["Source does not parse"];
  const problems: string[] = [];
  const documents = new Set(["document"]);
  const isDocument = (node: Node | undefined): boolean =>
    !!node &&
    ((node.type === "Identifier" && documents.has(node.name as string)) ||
      (node.type === "MemberExpression" &&
        ["document", "ownerDocument"].includes(
          (node.computed ? literal(node.property as Node) : (node.property as Node).name) as string,
        )));
  const aliases = (node: Node) => {
    if (node.type === "VariableDeclarator" && isDocument(node.init as Node) && (node.id as Node).type === "Identifier")
      documents.add((node.id as Node).name as string);
    if (
      node.type === "AssignmentExpression" &&
      isDocument(node.right as Node) &&
      (node.left as Node).type === "Identifier"
    )
      documents.add((node.left as Node).name as string);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") aliases(child);
      } else if (value && typeof value === "object" && "type" in value) aliases(value as Node);
    }
  };
  // Repeat to resolve aliases regardless of declaration order.
  let size: number;
  do {
    size = documents.size;
    aliases(program as unknown as Node);
  } while (documents.size !== size);
  const report = (node: Node, reason: string) => {
    const line = source.slice(0, node.start ?? 0).split("\n").length;
    problems.push(`${line}: ${reason}`);
  };
  const walk = (node: Node, parent?: Node) => {
    const name = node.type === "Identifier" ? node.name : literal(node);
    if (typeof name === "string" && SINKS.has(name)) report(node, `Forbidden HTML sink: ${name}`);
    if (
      node.type === "VariableDeclarator" &&
      isDocument(node.init as Node) &&
      (node.id as Node).type === "ObjectPattern"
    ) {
      for (const property of (node.id as Node).properties as Node[]) {
        const key = property.key as Node | undefined;
        if (["write", "writeln"].includes((key?.name ?? literal(key)) as string))
          report(property, "Do not borrow document HTML sinks");
      }
    }
    if (node.type === "MemberExpression") {
      const property = node.property as Node;
      const member = node.computed ? literal(property) : property.name;
      if ((member === "write" || member === "writeln") && isDocument(node.object as Node))
        report(node, "Forbidden document HTML sink");
      if (member === "setAttribute" || member === "setAttributeNS") {
        const attr =
          parent?.type === "CallExpression" && parent.callee === node
            ? literal((parent.arguments as Node[])[member === "setAttributeNS" ? 1 : 0])
            : undefined;
        if (attr === undefined || /^(?:on|href$|src$|srcdoc$)/i.test(attr.split(":").at(-1) ?? ""))
          report(node, `${member} requires a fixed, non-executable, non-URL attribute`);
      }
    }
    if (
      node.type === "Property" &&
      ["setAttribute", "setAttributeNS"].includes(((node.key as Node)?.name ?? literal(node.key as Node)) as string)
    )
      report(node, "Do not borrow attribute setters");
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") walk(child, node);
      } else if (value && typeof value === "object" && "type" in value) walk(value as Node, node);
    }
  };
  walk(program as unknown as Node);
  return problems;
}

/** Scan the actual build root, including nested shipped modules. */
export async function checkHtmlSinks(directory: string): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) problems.push(...(await checkHtmlSinks(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name))
      problems.push(...htmlSinkProblems(await readFile(path, "utf8")).map((problem) => `${path}:${problem}`));
  }
  return problems;
}
