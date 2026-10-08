// Checks on the build output for domain and host independence (decision 0005)
// and for the in-page CSP (requirement H2). Pure functions so the tests can feed
// them known-bad input; scripts/verify-dist.ts runs them on dist/.
//
// No hand-written parsers. JavaScript is parsed with oxc and CSS with
// lightningcss, both already used by the build. HTML is held to a byte-exact
// structural rule the build controls, plus narrow fail-closed text rules; how a
// browser actually parses the page is tested in tests/e2e/built-html.spec.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";
import { parseSync, Visitor } from "vite";
import { metaCsp } from "../../security/headers.ts";
import { scanText } from "./attribution-scan.ts";
import { findCssResources } from "./style-checks.ts";
import { blankDictionaryCollisions, verifiedWordData } from "./wordlist-attribution.ts";

/**
 * Top-level domains from IANA's root zone list, a committed snapshot of
 * https://data.iana.org/TLD/tlds-alpha-by-domain.txt ("Version 2026100400",
 * fetched 2026-10-04). Refresh it from the same URL when a new TLD matters.
 */
export const TLD_LIST_PATH = join(import.meta.dirname, "data", "iana-tlds.txt");
export const TLDS: ReadonlySet<string> = new Set(
  readFileSync(TLD_LIST_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#")),
);

/**
 * Special-use names that are not in the root zone but still name hosts
 * (RFC 2606, RFC 6761, RFC 7686, and the ICANN-reserved "internal").
 */
export const SPECIAL_USE_TLDS: ReadonlySet<string> = new Set([
  "example",
  "invalid",
  "test",
  "localhost",
  "local",
  "onion",
  "internal",
]);

/** The exact CSP <meta> tag the build injects. */
export function cspMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${metaCsp()}">`;
}

/**
 * The opening every HTML page in the build must have, byte for byte apart from
 * whitespace between tags: <meta charset="utf-8"> and then the CSP <meta> tag
 * as the first two elements of <head>.
 */
export function requiredHtmlHead(): RegExp {
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^<!doctype html>[\\t\\n\\r ]*<html lang="[a-z]{2}(?:-[A-Z]{2})?"(?: translate="no")?>[\\t\\n\\r ]*<head>[\\t\\n\\r ]*<meta charset="utf-8">[\\t\\n\\r ]*${escapeRegExp(cspMetaTag())}`,
  );
}

/** The opening of the one SVG the build ships; nothing after it may name a namespace. */
const SVG_PREFIX = '<svg xmlns="http://www.w3.org/2000/svg" ';

/** Files that only mean something to one hosting provider; they belong in deploy/examples/. */
export const PROVIDER_FILES: readonly string[] = [
  "_headers",
  "_redirects",
  "_routes.json",
  ".htaccess",
  "CNAME",
  "netlify.toml",
  "vercel.json",
  "firebase.json",
  "staticwebapp.config.json",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "Caddyfile",
  "nginx.conf",
];

const DOTTED_NAME = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

const ADDRESS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["URL with a scheme", /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi],
  ["scheme-relative URL", /\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi],
  ["localhost", /localhost/gi],
  ["IPv4 address", /\d{1,3}(?:\.\d{1,3}){3}/g],
  ["IPv6 address", /\[[0-9a-f]*:[0-9a-f:.]*\]/gi],
];

/**
 * Narrow additions safe to apply to prose and server examples as well as assets.
 * Reserved examples and loopback are allowed here; the build's existing address
 * and public-domain rules remain stricter.
 */
export function findInternalHostnames(file: string, text: string, hostContexts = true): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set([
    "localhost",
    "example.com",
    "example.net",
    "example.org",
    "example.invalid",
    "example.test",
  ]);
  // Bare documentation tags and CSS at-rule keywords are syntax. This does
  // not exempt the same labels in URLs, user-qualified addresses or commands.
  const atSignSyntax = new Set([
    "internal",
    "public",
    "ts-expect-error",
    "media",
    "supports",
    "container",
    "import",
    "font-face",
    "namespace",
    "keyframes",
    "property",
    "layer",
  ]);
  const label = "[a-z](?:[a-z0-9-]*[a-z0-9])?";
  const boundary = "(?![a-z0-9.-])";
  const report = (host: string) => {
    if (!allowed.has(host.toLowerCase())) findings.push({ file, problem: `single-label host name: ${host}` });
  };
  const prose = text.replace(/\.(?![a-z0-9.-])/gi, " ");
  const contexts = [
    new RegExp(`(?:[a-z][a-z0-9+.-]*://|(?<![a-z0-9_:/.-])//)(?:[^\\s/@]+@)?(${label})${boundary}`, "gi"),
    new RegExp(`(?<![a-z0-9./_-])[a-z0-9._-]+@(${label})${boundary}`, "gi"),
    new RegExp(`(?<![a-z0-9_])@(${label})(?=[:"'<>\\x60)])`, "gim"),
    new RegExp(`^[ \\t]*@(${label})[ \\t]*$`, "gim"),
    new RegExp(`\\b(?:scp|rsync)\\s+(?:[^\\n\\x60]*?\\s)?(?:[a-z0-9._-]+@)?(${label})${boundary}:`, "gi"),
  ];
  if (hostContexts) {
    for (const pattern of contexts) {
      for (const match of prose.matchAll(pattern)) {
        const host = match[1] as string;
        if (match[0].trimStart().startsWith("@") && atSignSyntax.has(host.toLowerCase())) continue;
        report(host);
      }
    }
    // Headers have one value; a phrase such as "any static host" is prose.
    for (const match of prose.matchAll(
      new RegExp(`\\bHost:[ \\t]*(${label})(?::[0-9]+)?[ \\t]*(?=$|\\*/|[\\n<>"'\\x60)])`, "gim"),
    ))
      report(match[1] as string);
    for (const directive of prose.matchAll(/\b(?:ServerName|server_name)[ \t]+([^;\n<"'\x60]+)/gi)) {
      for (const token of (directive[1] as string).split(/\s+/))
        if (new RegExp(`^${label}$`, "i").test(token)) report(token);
    }
    for (const match of prose.matchAll(new RegExp(`\\bserver[ \\t]+(${label})(?::[0-9]+)?[ \\t]*;`, "gi")))
      report(match[1] as string);
    if (/(?:^|\/)Caddyfile$/i.test(file)) {
      let depth = 0;
      for (const line of prose.split("\n")) {
        const content = line.replace(/#.*$/, "");
        if (depth === 0) {
          const match = content.match(new RegExp(`^[ \\t]*(${label})(?::[0-9]+)?[ \\t]+\\{`, "i"));
          if (match) report(match[1] as string);
        }
        depth += (content.match(/\{/g)?.length ?? 0) - (content.match(/\}/g)?.length ?? 0);
      }
    }
    // These words introduce prose rather than naming the next command target.
    const commandStopwords = new Set([
      "into",
      "to",
      "for",
      "the",
      "a",
      "an",
      "it",
      "over",
      "via",
      "with",
      "from",
      "on",
      "in",
      "at",
      "and",
      "or",
      "of",
      "is",
      "are",
      "as",
    ]);
    // Numeric config values are not implicit host ports. Explicit URL and
    // command-target contexts still check these labels as host names.
    const configKeys = new Set([
      "port",
      "timeout",
      "retries",
      "workers",
      "max",
      "min",
      "size",
      "limit",
      "length",
      "entropy",
      "width",
      "height",
      "delay",
      "interval",
      "duration",
      "count",
      "threads",
      "attempts",
      "connections",
      "backlog",
      "buffer",
      "offset",
    ]);
    const scanCommand = (source: string, commandLike: boolean, explicitCommand: boolean) => {
      if (commandLike) {
        for (const match of source.matchAll(new RegExp(`(?<![a-z0-9_./-])(${label}):[0-9]{1,5}(?![a-z0-9])`, "gi")))
          if (!configKeys.has((match[1] as string).toLowerCase())) report(match[1] as string);
      }
      for (const command of source.matchAll(/(?<![a-z0-9])(?:_*)(ssh|ping|dig|nc)\s+([^\n\x60]+)/gi)) {
        const args = (command[2] as string).trim().split(/\s+/);
        let index = 0;
        let flags = false;
        while (args[index]?.startsWith("-")) {
          flags = true;
          const option = args[index++] as string;
          const takesValue = command[1]?.toLowerCase() === "ssh" ? /^-[piloFJ]$/ : /^-(?:c|W|w|p)$/;
          if (takesValue.test(option)) index++;
        }
        const token = (args[index] ?? "").split("|", 1)[0] ?? "";
        const piped = (args[index] ?? "").includes("|");
        const target = token.replace(/^[(*_]+|[)*;'"<>,_|]+$/g, "");
        const hostShaped = /[0-9-]|@|\.(?:lan|local|internal|home\.arpa|localdomain|corp|intranet)(?:[.:]|$)/i.test(
          target,
        );
        const punctuatedHost = (piped || /[,_|][)*;'"<>]*$/.test(token)) && hostShaped;
        if (!commandLike && !flags && !punctuatedHost) continue;
        // A command word alone can introduce prose; snippets and shell prompts
        // supply the additional context needed for plain alphabetic targets.
        if (!explicitCommand && !hostShaped) continue;
        if (commandStopwords.has(target.toLowerCase())) continue;
        const match = target.match(new RegExp(`^(${label})(?::[0-9]+)?$`, "i"));
        if (match) report(match[1] as string);
      }
    };
    // Inline code spans are command snippets even when embedded in prose.
    for (const span of prose.matchAll(/\x60+([^\x60\n]+)\x60+/g)) scanCommand(span[1] as string, true, true);
    let fenced = false;
    for (const line of prose.split("\n")) {
      if (/^[ \t]*(?:\x60{3,}|~{3,})/.test(line)) {
        fenced = !fenced;
        continue;
      }
      const explicitCommand = fenced || /^[ \t]*\$[ \t]+/.test(line);
      const commandLike =
        explicitCommand || /^[ \t]*(?:<[^>]+>\s*)?(?:\$\s+|[(*_]*)(?:ssh|scp|rsync|ping|dig|nc|openssl)\b/.test(line);
      scanCommand(line, commandLike, explicitCommand);
      // A standalone lowercase address or a command target differs from UI metrics.
      const port = line.match(new RegExp(`^[ \\t]*(?:\\x60|\\$[ \\t]+)?(${label}):[0-9]{1,5}(?:\\x60)?[ \\t]*$`));
      if (port && !configKeys.has((port[1] as string).toLowerCase())) report(port[1] as string);
    }
  }
  for (const match of text.matchAll(DOTTED_NAME)) {
    if (/\.(?:lan|local|internal|home\.arpa|localdomain|corp|intranet)(?:\.|$)/i.test(match[0]))
      findings.push({ file, problem: `internal host name: ${match[0]}` });
  }
  return dedupe(findings);
}

export interface Finding {
  readonly file: string;
  readonly problem: string;
}

/** Absolute and scheme-relative URLs, IP addresses and localhost. */
export function findAddresses(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [label, pattern] of ADDRESS_PATTERNS) {
    for (const match of text.matchAll(pattern)) findings.push({ file, problem: `${label}: ${match[0]}` });
  }
  return findings;
}

/**
 * Addresses, plus any dotted name with a top-level domain (IANA or special-use)
 * after its first label: "example.education" and "a.com.js" are reported; "button.copy",
 * "passgen.settings" and "a.min.js" are not.
 */
export function findHostnames(file: string, text: string, hostContexts = true): Finding[] {
  const findings = [...findAddresses(file, text), ...findInternalHostnames(file, text, hostContexts)];
  for (const match of text.matchAll(DOTTED_NAME)) {
    // This explicit source-relative documentation path names a file. Bare
    // README.md and URL/email spellings still name a domain and remain banned.
    if (match[0] === "README.md" && /(?:^|[\s("'\x60])src\/styles\/$/.test(text.slice(0, match.index))) continue;
    const labels = match[0].toLowerCase().split(".");
    if (labels.slice(1).some((label) => TLDS.has(label) || SPECIAL_USE_TLDS.has(label)))
      findings.push({ file, problem: `host name: ${match[0]}` });
  }
  return findings;
}

export function findProviderFiles(files: readonly string[]): Finding[] {
  return files
    .filter((f) => PROVIDER_FILES.includes(f.split("/").at(-1) ?? ""))
    .map((file) => ({ file, problem: "hosting-provider file in the build (move it to deploy/examples/)" }));
}

/**
 * Resolves a URL reference from a file in the build (the build has no <base>)
 * and returns the build-relative path it names, or null if it could leave the
 * build. The one rule for URLs in HTML attributes, CSS and JavaScript.
 *
 * Rejected outright, before any resolving: anything with a scheme, and any
 * scheme-relative or root-relative reference ("/" or "\" first, after the
 * trimming the URL parser does). The rest is walked segment by segment from
 * the file's own folder, after percent-decoding, with "/" and "\" both as
 * separators: a ".." that would climb above the build root fails at once,
 * even if later segments come back in.
 */
export function resolveWithinDist(fromFile: string, url: string): string | null {
  // The URL parser trims C0 controls and spaces, and drops tabs and newlines anywhere.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching what the URL parser strips
  const trimmed = url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const pathPart = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (pathPart === "") return fromFile;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const stack = fromFile.split("/").slice(0, -1);
  for (const segment of decoded.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/**
 * HTML: the opening from requiredHtmlHead() and exactly one http-equiv in the
 * file, plus host names in the bytes as written. Decoded content (character
 * references, text, attribute values, URLs) is checked in the browser by
 * tests/e2e/built-html.spec.ts, using resolveWithinDist() and findHostnames().
 */
export function checkHtml(file: string, html: string): Finding[] {
  const findings: Finding[] = [];
  const add = (problem: string) => findings.push({ file, problem });
  if (!requiredHtmlHead().test(html)) {
    add(
      'must open with <!doctype html>, <html lang>, <head>, <meta charset="utf-8"> and then the exact CSP <meta> tag',
    );
  }
  const httpEquivs = html.match(/http-equiv/gi)?.length ?? 0;
  if (httpEquivs !== 1) add(`expected exactly one http-equiv attribute, found ${httpEquivs}`);
  findings.push(...findHostnames(file, html));
  for (const credit of scanText(file, html)) add(`attribution: ${credit}`);
  return dedupe(findings);
}

/** The favicon: one fixed opening, then no script, styles, links, handlers, escapes or other namespaces. */
export function checkSvg(file: string, svg: string): Finding[] {
  const findings: Finding[] = [];
  const add = (problem: string) => findings.push({ file, problem });
  const hasPrefix = svg.startsWith(SVG_PREFIX);
  if (!hasPrefix) add(`must open with ${SVG_PREFIX.trim()}`);
  const rest = hasPrefix ? svg.slice(SVG_PREFIX.length) : svg;
  const banned: ReadonlyArray<readonly [string, RegExp]> = [
    ["script", /script/i],
    ["foreignObject", /foreignobject/i],
    ["style", /style/i],
    ["link or reference", /href|url\s*\(|src\s*=/i],
    ["event handler", /\bon[a-z]+\s*=/i],
    ["another namespace", /xmlns/i],
    ["character reference or escape", /[&\\]/],
  ];
  for (const [label, pattern] of banned) {
    if (pattern.test(rest)) add(`${label} is not allowed in the SVG`);
  }
  findings.push(...findHostnames(file, rest));
  return dedupe(findings);
}

/**
 * JavaScript, parsed with oxc: host names in string, template and regex
 * literals and comments; addresses anywhere; and every module specifier and
 * `new URL("…", import.meta.url)` asset path must stay inside the build.
 */
export function checkJs(file: string, source: string): Finding[] {
  const findings = findAddresses(file, source);
  const { program, comments, errors } = parseSync(file, source, { sourceType: "module" });
  for (const e of errors) findings.push({ file, problem: `does not parse: ${e.message}` });

  const texts: string[] = comments.map((c) => c.value);
  const wordData = verifiedWordData(join(import.meta.dirname, "../.."));
  const dataSpans: Array<{ start: number; end: number }> = [];
  const exemptQuasis = new Set<number>();
  new Visitor({
    TemplateLiteral(node) {
      const quasi = node.quasis[0];
      if (node.expressions.length === 0 && node.quasis.length === 1 && quasi?.value.cooked === wordData) {
        dataSpans.push({ start: node.start, end: node.end });
        exemptQuasis.add(quasi.start);
      }
    },
  }).visit(program);
  const paths: string[] = [];
  const literalString = (node: unknown): string | undefined => {
    const n = node as { type?: string; value?: unknown } | null | undefined;
    return n?.type === "Literal" && typeof n.value === "string" ? n.value : undefined;
  };
  const addPath = (node: unknown) => {
    const value = literalString(node);
    if (value !== undefined) paths.push(value);
  };
  new Visitor({
    Literal(node) {
      if (typeof node.value === "string") {
        if (node.value === wordData) {
          dataSpans.push({ start: node.start, end: node.end });
          texts.push(blankDictionaryCollisions(node.value));
        } else texts.push(node.value);
      }
      if ("regex" in node && node.regex) texts.push(node.regex.pattern, node.regex.pattern.replace(/\\(.)/g, "$1"));
    },
    TemplateElement(node) {
      if (exemptQuasis.has(node.start)) {
        texts.push(blankDictionaryCollisions(node.value.raw));
        if (typeof node.value.cooked === "string") texts.push(blankDictionaryCollisions(node.value.cooked));
        return;
      }
      texts.push(node.value.raw);
      if (typeof node.value.cooked === "string") texts.push(node.value.cooked);
    },
    ImportDeclaration(node) {
      addPath(node.source);
    },
    ExportNamedDeclaration(node) {
      addPath(node.source);
    },
    ExportAllDeclaration(node) {
      addPath(node.source);
    },
    ImportExpression(node) {
      addPath(node.source);
    },
    NewExpression(node) {
      const base = node.arguments[1] as
        | { type?: string; object?: { type?: string }; property?: { name?: string } }
        | undefined;
      const isImportMetaUrl =
        base?.type === "MemberExpression" && base.object?.type === "MetaProperty" && base.property?.name === "url";
      if (node.callee.type === "Identifier" && node.callee.name === "URL" && isImportMetaUrl)
        addPath(node.arguments[0]);
    },
  }).visit(program);

  for (const text of texts) {
    findings.push(...findHostnames(file, text));
    if (/^\s*(?:\/\/|\\\\)/.test(text)) findings.push({ file, problem: `scheme-relative URL in a string: ${text}` });
  }
  for (const path of paths) {
    if (resolveWithinDist(file, path) === null)
      findings.push({ file, problem: `module or asset path leaves the build: ${path}` });
  }
  // Only explicit collision words inside verified word-data literals are blanked.
  // All other data, comments, identifiers and decoded strings remain scanned.
  let attributionSource = source;
  for (const { start, end } of dataSpans.sort((a, b) => b.start - a.start)) {
    attributionSource =
      attributionSource.slice(0, start) +
      blankDictionaryCollisions(source.slice(start, end)) +
      attributionSource.slice(end);
  }
  for (const credit of [
    ...scanText(file, attributionSource),
    ...scanText(`${file} (decoded strings)`, texts.join("\n")),
  ]) {
    findings.push({ file, problem: `attribution: ${credit}` });
  }
  return dedupe(findings);
}

/** A lightningcss token holding a string, e.g. in `content`, or undefined. */
function stringTokenValue(item: unknown): string | undefined {
  const t = item as { type?: string; value?: { type?: string; value?: unknown } } | null;
  return t?.type === "token" && t.value?.type === "string" && typeof t.value.value === "string"
    ? t.value.value
    : undefined;
}

function isWhitespaceToken(item: unknown): boolean {
  const t = item as { type?: string; value?: { type?: string } } | null;
  return t?.type === "token" && (t.value?.type === "white-space" || t.value?.type === "whitespace");
}

/**
 * Every string in a lightningcss AST, decoded. Adjacent string tokens are also
 * joined, the way `content: "a" "b"` renders as "ab".
 */
export function collectCssStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    let run: string[] = [];
    const flush = () => {
      if (run.length > 1) out.push(run.join(""));
      run = [];
    };
    for (const item of node) {
      const value = stringTokenValue(item);
      if (value !== undefined) run.push(value);
      else if (!isWhitespaceToken(item)) flush();
      collectCssStrings(item, out);
    }
    flush();
  } else if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) collectCssStrings(value, out);
  }
  return out;
}

/**
 * CSS, parsed with lightningcss: no @import; every URL, resolved against the
 * stylesheet's own path, stays inside the build; no host names and no
 * attribution, either as written or in lightningcss's decoded strings (escapes
 * resolved), which covers generated text such as `content`, `quotes` and
 * counter-style symbols.
 */
export function checkCss(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const add = (problem: string) => findings.push({ file, problem });
  let decoded: string[] = [];
  try {
    const { dependencies } = transform({
      filename: file,
      code: Buffer.from(source),
      analyzeDependencies: true,
      visitor: {
        StyleSheetExit(sheet) {
          decoded = collectCssStrings(sheet.rules);
        },
      },
    });
    for (const dep of dependencies ?? []) {
      if (dep.type === "import") add(`@import is not allowed in shipped CSS: ${"url" in dep ? dep.url : ""}`);
      else if (!("url" in dep)) add(`unexpected CSS dependency: ${JSON.stringify(dep)}`);
      else if (resolveWithinDist(file, dep.url) === null) add(`CSS URL leaves the build: ${dep.url}`);
    }
  } catch (err) {
    add(`does not parse: ${(err as Error).message}`);
  }
  // The shipped page loads nothing from CSS (R4c, S4): no url(), image
  // function, @import, @font-face or @namespace, in any value, as emitted.
  for (const resource of findCssResources(file, source)) add(`CSS loads a resource: ${resource}`);
  // Raw CSS declarations such as top:0 are not host:port text. Apply bare-host
  // contexts only to parsed text and comment bodies; dotted hosts remain banned everywhere.
  findings.push(...findHostnames(file, source, false));
  for (const text of [...decoded, ...[...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0])])
    findings.push(...findHostnames(file, text));
  for (const credit of [...scanText(file, source), ...scanText(`${file} (decoded strings)`, decoded.join("\n"))]) {
    add(`attribution: ${credit}`);
  }
  return dedupe(findings);
}

/** Runs the checks that fit a build file's type. */
export function checkFile(file: string, text: string): Finding[] {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html") return checkHtml(file, text);
  if (ext === "svg") return checkSvg(file, text);
  if (ext === "js" || ext === "mjs") return checkJs(file, text);
  if (ext === "css") return checkCss(file, text);
  return dedupe(findHostnames(file, text));
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}\0${f.problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
