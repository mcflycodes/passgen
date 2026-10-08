// Renders the reference server configs in deploy/examples/ from security/headers.ts.
// Each snippet sets every header on every response, including errors such as 404.

import { SECURITY_HEADERS, type SecurityHeader } from "../../security/headers.ts";
import { renderSiteConfigs } from "./site-configs.ts";

const GENERATED = "Generated from security/headers.ts by `pnpm headers:gen`. Do not edit by hand.";

function hashComments(lines: readonly string[]): string {
  return lines.map((line) => `# ${line}`.trimEnd()).join("\n");
}

function purposeComment(header: SecurityHeader, indent: string): string {
  return `${indent}# ${header.purpose}`;
}

function apache(): string {
  const body = SECURITY_HEADERS.map((h) => `${purposeComment(h, "")}\nHeader always set ${h.name} "${h.value}"`).join(
    "\n",
  );
  return `${hashComments([
    GENERATED,
    "",
    "Apache httpd with mod_headers. Include this file in the <VirtualHost> or <Directory>",
    "that serves the PassGen files, or copy it into a .htaccess file there.",
    "It is deliberately not wrapped in <IfModule>: if mod_headers is missing, Apache",
    "should refuse to start rather than serve the page without its headers.",
    "`always` makes Apache add the headers to error responses such as 404 too.",
  ])}\n\n${body}\n`;
}

function nginx(): string {
  const body = SECURITY_HEADERS.map((h) => `${purposeComment(h, "")}\nadd_header ${h.name} "${h.value}" always;`).join(
    "\n",
  );
  return `${hashComments([
    GENERATED,
    "",
    "nginx. Include this file in the server or location block that serves the PassGen",
    "files, e.g. `include /etc/nginx/snippets/passgen-headers.conf;`.",
    "nginx drops inherited add_header lines in any block that has its own add_header,",
    "so include this file in every such block.",
    "`always` makes nginx add the headers to error responses such as 404 too.",
  ])}\n\n${body}\n`;
}

function caddy(): string {
  const body = SECURITY_HEADERS.map((h) => `${purposeComment(h, "    ")}\n    ${h.name} "${h.value}"`).join("\n");
  return `${hashComments([
    GENERATED,
    "",
    "Caddy. Paste this header block inside the site block that serves the PassGen files,",
    "next to `file_server`. Check that a missing path's 404 response carries the headers.",
  ])}\n\nheader {\n${body}\n}\n`;
}

function headersFile(host: string): string {
  const body = SECURITY_HEADERS.map((h) => `${purposeComment(h, "    ")}\n    ${h.name}: ${h.value}`).join("\n");
  return `${hashComments([
    GENERATED,
    "",
    `${host} _headers file. Copy it into the folder you publish, next to index.html.`,
    "Check that a missing path's 404 response carries the headers too.",
  ])}\n\n/*\n${body}\n`;
}

function readme(files: readonly string[]): string {
  return `<!-- ${GENERATED} -->

# Reference header configs

PassGen is a folder of static files that works on any static web server. The page
carries its Content Security Policy in a \`<meta>\` tag, so its main protections
hold everywhere. Some protections only work as HTTP headers: HSTS, framing
protection, the referrer and permissions policies, and the CSP header itself. These
files set all of them for common servers. Copy the one you need; none is required
and none is preferred.

Header snippets here are generated from \`security/headers.ts\`. To change a header, edit
that file and run \`pnpm headers:gen\`; CI fails if these files drift from it. Full site configs are generated from
\`scripts/lib/site-configs.ts\` and include the matching header snippet. See
the self-hosting guide under docs/ for setup and constraints.

| File | Server |
|---|---|
${files.map((f) => `| \`${f}\` | ${describe(f)} |`).join("\n")}

Required headers (every response, including 404):

| Header | Value |
|---|---|
${SECURITY_HEADERS.map((h) => `| \`${h.name}\` | \`${h.value}\` |`).join("\n")}
`;
}

const SERVERS: Record<string, [string, () => string]> = {
  "apache/passgen-headers.conf": ["Apache httpd (mod_headers)", apache],
  "caddy/passgen-headers.caddy": ["Caddy", caddy],
  "cloudflare-pages/_headers": ["Cloudflare Pages", () => headersFile("Cloudflare Pages")],
  "netlify/_headers": ["Netlify", () => headersFile("Netlify")],
  "nginx/passgen-headers.conf": ["nginx", nginx],
};

function describe(file: string): string {
  return SERVERS[file]?.[0] ?? "";
}

/** Every generated file, keyed by its path relative to deploy/examples/. */
export function renderSnippets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, [, render]] of Object.entries(SERVERS)) {
    out.set(file, render());
  }
  for (const [file, content] of renderSiteConfigs()) out.set(file, content);
  out.set("README.md", readme(Object.keys(SERVERS)));
  return out;
}
