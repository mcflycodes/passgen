import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { findHostnames } from "../../scripts/lib/dist-checks.ts";
import { renderSnippets } from "../../scripts/lib/snippets.ts";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const EXAMPLES = join(import.meta.dirname, "..", "..", "deploy", "examples");
const snippets = renderSnippets();

describe("reference header snippets", () => {
  test("cover Apache, nginx, Caddy, Cloudflare Pages and Netlify", () => {
    assert.deepEqual(
      [...snippets.keys()].sort(),
      [
        "README.md",
        "apache/passgen-site.conf",
        "nginx/passgen-site.conf",
        "caddy/Caddyfile",
        "apache/passgen-headers.conf",
        "caddy/passgen-headers.caddy",
        "cloudflare-pages/_headers",
        "netlify/_headers",
        "nginx/passgen-headers.conf",
      ].sort(),
    );
  });

  for (const [file, content] of snippets) {
    if (!file.endsWith("passgen-site.conf") && file !== "caddy/Caddyfile")
      test(`${file} sets every header with its exact value`, () => {
        for (const h of SECURITY_HEADERS) {
          assert.ok(content.includes(h.name), `${file} lacks ${h.name}`);
          assert.ok(content.includes(h.value), `${file} has the wrong value for ${h.name}`);
        }
      });

    test(`${file} uses only generic site placeholders or no hostname`, () => {
      if (file.endsWith("passgen-site.conf") || file === "caddy/Caddyfile") {
        assert.match(content, /example[.]com/);
        assert.match(content, /passgen-headers/);
      }
      // Certificate suffixes are filenames, not extra hostname labels. The
      // IPv6 wildcard listener is generic syntax; all other addresses stay scanned.
      const scanText = content
        .replaceAll("/etc/pki/tls/certs/example.com.pem", "/etc/pki/tls/certs/example.com")
        .replaceAll("/etc/pki/tls/private/example.com.key", "/etc/pki/tls/private/example.com")
        .replaceAll("listen [::]:443 ssl;", "listen 443 ssl;");
      const findings = findHostnames(file, scanText);
      assert.deepEqual(
        findings.filter((finding) => finding.problem !== "host name: example.com"),
        [],
      );
    });

    test(`${file} matches the committed copy in deploy/examples/`, async () => {
      assert.equal(await readFile(join(EXAMPLES, file), "utf8"), content, "run `pnpm headers:gen`");
    });
  }

  test("Apache and nginx add the headers to error responses such as 404", () => {
    const apache = snippets.get("apache/passgen-headers.conf") ?? "";
    const nginx = snippets.get("nginx/passgen-headers.conf") ?? "";
    for (const h of SECURITY_HEADERS) {
      assert.ok(apache.includes(`Header always set ${h.name} "${h.value}"`), h.name);
      assert.ok(nginx.includes(`add_header ${h.name} "${h.value}" always;`), h.name);
    }
    assert.doesNotMatch(apache, /^\s*<IfModule/m, "must not be wrapped in <IfModule>");
  });

  test("_headers files apply to every path", () => {
    for (const file of ["cloudflare-pages/_headers", "netlify/_headers"]) {
      assert.match(snippets.get(file) ?? "", /^\/\*$/m);
    }
  });
});

const ROOT = resolve(EXAMPLES, "../..");
const DOCS_PAGES = readdirSync(join(ROOT, "docs"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => `docs/${file}`);
// Task pages with copy-paste install commands.
const INSTALL_PAGES = DOCS_PAGES.filter((file) => /^docs\/(?:Install-|Static-hosts)/.test(file));
const RAW_MAIN = "https://raw.githubusercontent.com/mcflycodes/passgen/main/";

function headingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();
  let fence = "";
  for (const line of content.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter[0] ?? "";
      else if (delimiter.startsWith(fence)) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
      .replaceAll(" ", "-");
    const count = duplicates.get(slug) ?? 0;
    duplicates.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return anchors;
}

// Check references independently of domain detection: a misspelled .ts path
// must fail even though its extension is not a top-level domain.
function checkDocReferences(file: string, content: string): string {
  const folder = dirname(join(ROOT, file));
  const withoutLinks = content.replace(/\[[^\]]*\]\(([^)]+)\)/g, (match, target: string) => {
    if (/^[a-z]+:|^\/\//i.test(target)) return match;
    const [path = "", anchor] = target.split("#");
    const destination = path ? resolve(folder, path) : join(ROOT, file);
    assert.ok(existsSync(destination), `${file}: broken link ${target}`);
    if (anchor !== undefined) {
      assert.ok(statSync(destination).isFile(), `${file}: anchor target is not a file: ${target}`);
      assert.ok(
        headingAnchors(readFileSync(destination, "utf8")).has(decodeURIComponent(anchor)),
        `${file}: broken anchor ${target}`,
      );
    }
    return match.slice(0, match.indexOf("](") + 1);
  });
  for (const match of content.matchAll(/\bscripts\/[\w.-]+(?:\/[\w.-]+)*/g)) {
    const path = match[0].replace(/\.$/, "");
    assert.ok(existsSync(join(ROOT, path)), `${file}: missing script path ${path}`);
    assert.ok(statSync(join(ROOT, path)).isFile(), `${file}: script path is not a file: ${path}`);
  }
  for (const match of content.matchAll(
    /https:\/\/raw\.githubusercontent\.com\/mcflycodes\/passgen\/main\/[^\s"'<>)]*/g,
  )) {
    const path = new URL(match[0]).pathname.slice("/mcflycodes/passgen/main/".length);
    assert.ok(existsSync(join(ROOT, path)), `${file}: missing raw URL path ${path}`);
    assert.ok(statSync(join(ROOT, path)).isFile(), `${file}: raw URL path is not a file: ${path}`);
  }
  return withoutLinks;
}

test("deployment docs have valid links, anchors, script paths and raw URLs", async () => {
  const folder = join(ROOT, "agent-setup");
  const files = new Set([
    "README.md",
    "CONTRIBUTING.md",
    ...DOCS_PAGES,
    ...DOCKER_DOCS,
    ...(await readdir(folder)).filter((file) => file.endsWith(".md")).map((file) => `agent-setup/${file}`),
  ]);
  for (const file of files) {
    const content = await readFile(join(ROOT, file), "utf8");
    const withoutLinks = checkDocReferences(file, content);
    if (!file.startsWith("agent-setup/")) continue; // Deployment guides also link to public project and reference sites.
    // Only existing source paths are exempted from domain detection (.sh and
    // .md are also top-level domains); actual deployment paths remain scanned.
    const scanText = withoutLinks
      .replace(/(?:[\w-]+\/)+[\w.-]+/g, (path) => (existsSync(join(ROOT, path)) ? "source-file" : path))
      .replaceAll("https://example.com/", "example.com")
      .replace(/passgen(?:-X\.Y\.Z)?\.zip(?:\.sha256)?/g, "release-asset");
    assert.deepEqual(
      findHostnames(file, scanText, false).filter((finding) => finding.problem !== "host name: example.com"),
      [],
    );
  }
});

const DOCKER_DOCS = ["docs/docker.md", "docs/docker-https.md", "docs/Install-Docker.md", "deploy/compose/README.md"];
// Names the Docker guides may use: placeholders, loopback, the project's own
// repository and registry, the official image registry and container-network
// names. Links to reference sites are exempt; anything else is a finding.
const DOCKER_DOC_NAMES: [RegExp, string][] = [
  [/\]\((?:https?:)?\/\/[^)\s]+\)/g, "]"],
  [/https:\/\/github\.com\/mcflycodes\/passgen[\w./-]*/g, "project-url"],
  [/(?:oci:\/\/)?ghcr\.io\/mcflycodes\/passgen/g, "project-image"],
  [/public\.ecr\.aws\/docker\/library\/(?:caddy|httpd)/g, "official-image"],
  [/https?:\/\/passgen\.example\.com[^\s`'"]*/g, "placeholder-url"],
  [/\bpassgen\.example\.com\b/g, "placeholder-host"],
  [/(?:http:\/\/)?127\.0\.0\.1(?![\d.])/g, "loopback"],
  [/\bresolver 127\.0\.0\.11\b/g, "resolver docker-dns"],
  [/`127\.0\.0\.11`/g, "docker-dns"],
  [/http:\/\/\{\{ env "PASSGEN_HOST" \}\}:8080/g, "traefik-upstream"],
  [/http:\/\/\$passgen_host:8080/g, "nginx-upstream"],
  [/`\.localhost`/g, "loopback-name"],
  [/http:\/\/\{\$PASSGEN_DOMAIN\}|https:\/\/\{host\}\{uri\}/g, "caddy-placeholder"],
  [/`https?:\/\/`/g, "scheme"],
  [/`localhost\/?`/g, "loopback-recipe"],
  [/docker login ghcr\.io/g, "registry-login"],
  [/listen \[::\]:(?=80;|443 ssl;)/g, "listen "],
  [/--(?:entrypoints|providers|certificatesresolvers)\.[\w.]+/g, "--traefik-option"],
];

function dockerDocFindings(file: string, content: string) {
  let text = checkDocReferences(file, content);
  for (const [pattern, replacement] of DOCKER_DOC_NAMES) text = text.replace(pattern, replacement);
  text = text
    .replace(/(?:[\w-]+\/)+[\w.-]+/g, (path) => (existsSync(join(ROOT, path)) ? "source-file" : path))
    .replace(/passgen(?:-X\.Y\.Z)?\.zip(?:\.sha256)?/g, "release-asset");
  return findHostnames(file, text, false);
}

for (const file of DOCKER_DOCS) {
  test(`${file} names only placeholder hosts and the project's own registries`, async () => {
    assert.deepEqual(dockerDocFindings(file, await readFile(join(ROOT, file), "utf8")), []);
  });
}

test("Docker guide scan rejects a real-looking hostname and a bare published port", async () => {
  const guide = await readFile(join(ROOT, "docs/docker.md"), "utf8");
  assert.notDeepEqual(
    dockerDocFindings(
      "docs/docker.md",
      `${guide}
Open https://passgen.decoded.dev/.`,
    ),
    [],
  );
  assert.notDeepEqual(
    dockerDocFindings(
      "docs/docker.md",
      `${guide}
Proxy to 10.0.0.5:8080.`,
    ),
    [],
  );
});

for (const file of DOCKER_DOCS) {
  test(`${file} never tells readers to publish a bare 8080:8080`, async () => {
    const content = await readFile(join(ROOT, file), "utf8");
    for (const block of [...content.matchAll(/```\w*\n([\s\S]*?)```/g)].map((match) => match[1] ?? ""))
      assert.doesNotMatch(block, /(^|[\s"'[-])(?:0\.0\.0\.0:)?8080:8080\b/m);
  });
}

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
for (const [label, content, expected] of [
  ["README local link", `${readme}\n[Missing](docs/missing-guide.md)`, /broken link docs\/missing-guide\.md/],
  [
    "README image",
    `${readme}\n![Missing image](docs/screenshots/missing.png)`,
    /broken link docs\/screenshots\/missing\.png/,
  ],
  [
    "target heading anchor",
    `${readme}\n[Details](docs/self-hosting.md#before-you-strat)`,
    /broken anchor .*before-you-strat/,
  ],
  ["local heading anchor", `${readme}\n[Missing](#missing-deploy-section)`, /broken anchor #missing-deploy-section/],
  [
    "shell script path",
    `${readme}\nUse scripts/install-releaze.sh.`,
    /missing script path scripts\/install-releaze\.sh/,
  ],
  ["TypeScript path", `${readme}\nUse scripts/verify-lvie.ts.`, /missing script path scripts\/verify-lvie\.ts/],
  [
    "other script extension",
    `${readme}\nUse scripts/missing-check.py.`,
    /missing script path scripts\/missing-check\.py/,
  ],
  [
    "raw prompt URL",
    readme.replace(`${RAW_MAIN}agent-setup/prompt.md`, `${RAW_MAIN}agent-setup/missing-prompt.md`),
    /missing raw URL path agent-setup\/missing-prompt\.md/,
  ],
] as const) {
  test(`documentation check rejects a deliberately broken ${label}`, () => {
    assert.notEqual(content, readme, "the fixture must introduce a real break");
    assert.throws(() => checkDocReferences("README.md", content), expected);
  });
}

const TIMESTAMP_DOCS = [
  "README.md",
  "docs/self-hosting.md",
  "docs/install-release.md",
  "docs/docker.md",
  "agent-setup/prompt.md",
];

function checkTimestampCommands(file: string, content: string): void {
  const commands = [...content.matchAll(/\bfind\b[^\n`]*-exec\s+touch\b[^\n`]*/g)];
  assert.ok(commands.length > 0, `${file}: missing timestamp instructions`);
  for (const [command] of commands) {
    assert.match(command, /^find -P /, `${file}: timestamp traversal must not follow symlinks`);
    assert.match(
      command,
      /\\\( -type f -o -type d \\\)/,
      `${file}: timestamp command must select only regular files and directories`,
    );
    assert.match(command, /-exec touch -h -c \{\} \+/, `${file}: unsafe timestamp touch command`);
  }
}

for (const file of TIMESTAMP_DOCS.filter((file) => file !== "README.md")) {
  test(`${file} timestamp commands cannot follow symlinks or create targets`, async () => {
    checkTimestampCommands(file, await readFile(join(ROOT, file), "utf8"));
  });
}

const safeTimestampCommand = 'find -P "payload" \\( -type f -o -type d \\) -exec touch -h -c {} +';
for (const [label, command] of [
  ["bare touch", safeTimestampCommand.replace("touch -h -c", "touch")],
  ["touch without no-dereference", safeTimestampCommand.replace("touch -h -c", "touch -c")],
  ["touch without no-create", safeTimestampCommand.replace("touch -h -c", "touch -h")],
  ["symlink traversal", safeTimestampCommand.replace("find -P", "find -L")],
  ["unfiltered entries", safeTimestampCommand.replace("\\( -type f -o -type d \\) ", "")],
] as const) {
  test(`timestamp documentation check rejects ${label}`, () => {
    checkTimestampCommands("fixture", safeTimestampCommand);
    assert.throws(() => checkTimestampCommands("fixture", command));
  });
}

function shellBlocks(content: string): string[] {
  return [...content.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function checkInteractiveShellBlocks(file: string, content: string): void {
  for (const block of shellBlocks(content)) {
    assert.doesNotMatch(block, /\bexit\b/, `${file}: copy-paste commands must not exit the user's shell`);
  }
}

for (const file of INSTALL_PAGES) {
  const content = readFileSync(join(ROOT, file), "utf8");
  if (content.includes("-exec touch"))
    test(`${file} timestamp commands cannot follow symlinks or create targets`, () => {
      checkTimestampCommands(file, content);
    });
}

for (const file of [...TIMESTAMP_DOCS, ...INSTALL_PAGES]) {
  test(`${file} deployment commands never exit the user's shell`, async () => {
    checkInteractiveShellBlocks(file, await readFile(join(ROOT, file), "utf8"));
  });
}

for (const command of ["exit 1", "sha256sum -c SHA256SUMS || exit 1", "(exit 1)"]) {
  test(`interactive shell documentation check rejects ${command}`, () => {
    assert.throws(() => checkInteractiveShellBlocks("fixture", `\`\`\`sh\n${command}\n\`\`\``));
  });
}

test("manual timestamp steps require checksum verification, then symlink inspection, then touch", async () => {
  for (const file of TIMESTAMP_DOCS.filter((file) => file !== "agent-setup/prompt.md" && file !== "README.md")) {
    const content = await readFile(join(ROOT, file), "utf8");
    const blocks = shellBlocks(content);
    let touches = 0;
    for (const [index, block] of blocks.entries()) {
      if (!block.includes("-exec touch")) continue;
      touches++;
      assert.match(blocks[index - 2] ?? "", /sha256sum -c/, `${file}: verify checksums first`);
      assert.match(blocks[index - 1] ?? "", /find -P[^\n]+-type l -print/, `${file}: inspect symlinks next`);
    }
    assert.equal(touches, file === "docs/self-hosting.md" ? 5 : 1);
    assert.match(content, /Continue only if every checksum says `OK`; otherwise, stop\./);
    assert.match(content, /If this prints anything, stop: the release contains a symbolic link\. Do not continue\./);
  }
});

test("short by-hand deployment refreshes timestamps and replaces the tree without deletion", () => {
  const deploy = readFileSync(join(ROOT, "docs/Install-by-hand.md"), "utf8");
  assert.match(deploy, /## Install\n/);
  assert.match(deploy, /## Update\n/);
  assert.match(deploy, /## Roll back\n/);
  assert.equal((deploy.match(/unzip -DD /g) ?? []).length, 2);
  assert.doesNotMatch(deploy, /\brm\b|\$[A-Za-z{]/);
  assert.match(deploy, /mkdir \.\/passgen-next &&/);
  assert.match(deploy, /test ! -e \.\/passgen-previous && test ! -L \.\/passgen-previous &&/);
  assert.match(deploy, /test -d \.\/passgen && test ! -L \.\/passgen &&/);
  assert.match(deploy, /mv -T \.\/passgen \.\/passgen-previous &&\n\s*mv -T \.\/passgen-next \.\/passgen/);
});

test("README links the install pages and keeps the agent one-liner", () => {
  for (const page of INSTALL_PAGES) assert.ok(readme.includes(`](${page})`), `README does not link ${page}`);
  assert.match(readme, /## Install with an AI agent\n/);
  assert.ok(readme.includes(`${RAW_MAIN}agent-setup/prompt.md`));
});
