import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXAMPLE_TOOLS } from "../../scripts/lib/attribution-patterns.ts";
import { scanText } from "../../scripts/lib/attribution-scan.ts";
import { checkCss, findHostnames, findInternalHostnames } from "../../scripts/lib/dist-checks.ts";

for (const text of [
  "https://vaultbox/path",
  "//vaultbox/path",
  "Host: vaultbox",
  "host: vaultbox",
  "ServerName vaultbox",
  "server_name vaultbox;",
  "server_name localhost vaultbox;",
  "$ ssh vaultbox",
  "$ ssh -4 vaultbox",
  "$ ssh -p 2222 vaultbox",
  "ssh -i keyfile user@vaultbox",
  "scp vaultbox:/srv/file ./",
  "rsync vaultbox:relative ./",
  "rsync vaultbox::module ./",
  "scp file vaultbox:/srv/",
  "rsync -av file user@vaultbox:/srv/",
  "user@vaultbox",
  "@vaultbox",
  "vaultbox:8443",
  "run `ssh srv42` first",
  "`ssh root@srv42`",
  "`http://srv42`",
  "`https://nas`",
  "`Host: srv42`",
  "(ssh srv42)",
  "ssh srv42.",
  "**ssh srv42**",
  "`scp dist.tar srv42:`",
  "$ ssh nas:8080",
  "server srv42;",
  "ping srv42",
  "dig srv42",
  "nc srv42 8080",
  ...["lan", "local", "internal", "home.arpa", "localdomain", "corp", "intranet"].map((suffix) => `vaultbox.${suffix}`),
]) {
  test(`host check catches ${text}`, () => {
    assert.ok(findInternalHostnames("fixture", text).length);
    assert.ok(findHostnames("fixture", text).length);
  });
}
for (const text of [
  "a server and a host in plain prose",
  "const server = value; host: string;",
  "button.copy passgen.settings index.html crypto.getRandomValues",
  "Host: localhost",
  "server_name example.com;",
  "ssh localhost",
  "user@localhost",
  "localhost:8080",
  "example.com example.net example.org",
  "import test from '@playwright/test';",
  "@blocked path_regexp blocked",
  "@media screen { }",
  "time 07:00",
  "SSH access is required",
  "Connect over SSH to the server",
  "Length:20",
  "Entropy:128",
  "file:///tmp/x",
  "node@22",
  "@internal",
  "@public",
  "@ts-expect-error",
  "Host: any static host",
  "uses: actions/checkout@abc123",
]) {
  test(`context check allows ${text}`, () => assert.deepEqual(findInternalHostnames("fixture", text), []));
}
test("context checks have no new findings in repository prose and deploy examples", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file.endsWith(".md") || file.startsWith("deploy/examples/"));
  for (const file of files) assert.deepEqual(findInternalHostnames(file, readFileSync(file, "utf8")), [], file);
});
for (const tool of EXAMPLE_TOOLS.filter((name) => !/[ -]/.test(name))) {
  for (const identifier of [
    `generatedBy${tool}`,
    `made_with_${tool.toLowerCase()}`,
    `${tool.length <= 2 ? `${tool}_` : tool}Credit`,
    `${tool}_attribution`,
  ]) {
    test(`catches credit identifier ${identifier}`, () => {
      assert.ok(scanText("fixture", `const ${identifier} = true;`).length);
      assert.ok(scanText("fixture", `// ${identifier}`).length);
    });
  }
}
test("catches co-author constants", () => {
  for (const name of [
    ["co", "Authored", "By"].join(""),
    ["CO", "AUTHORED", "BY"].join("_"),
    ["co", "authored", "by"].join("_"),
  ])
    assert.ok(scanText("fixture", `const ${name} = "writer";`).length);
});
for (const text of [
  "const cursorPosition = 0;",
  "cursor: pointer;",
  "const piValue = Math.PI;",
  "const generatedByUser = true;",
  "const made_with_care = true;",
  "const authorName = user.name;",
  "const creditCard = value;",
]) {
  test(`allows legitimate code ${text}`, () => assert.deepEqual(scanText("fixture", text), []));
}

test("CSS declarations stay ordinary code while strings and comments are scanned", () => {
  assert.deepEqual(checkCss("fixture.css", "a{top:0;left:10px;z-index:1000}"), []);
  for (const text of [
    'a::after{content:"vaultbox:8443"}',
    "/* Host: vaultbox */a{}",
    'a::after{content:"vaultbox.lan"}',
  ])
    assert.ok(checkCss("fixture.css", text).length);
});

test("Caddy site names are scanned only in Caddy files", () => {
  assert.ok(findInternalHostnames("deploy/Caddyfile", "srv42 {").length);
  assert.deepEqual(findInternalHostnames("fixture.ts", "srv42 {"), []);
});

for (const tool of EXAMPLE_TOOLS) {
  for (const text of [
    `generatedBy${tool.replaceAll(" ", "")}AI`,
    `madeWith${tool.replaceAll(" ", "")}Agent`,
    `generatedBy${tool.replaceAll(" ", "")}2`,
    `${tool.replaceAll(" ", "")}${tool.replaceAll(" ", "").length <= 2 ? "_" : ""}Generated`,
    `${tool.replaceAll(" ", "").toUpperCase()}_GENERATED`,
    `generatedBy: "${tool}"`,
    `credit: "${tool}"`,
    `<meta name="generator" content="${tool}">`,
    `<meta content="${tool}" name="generator">`,
  ])
    test(`catches expanded credit ${text}`, () => assert.ok(scanText("fixture", text).length));
}
for (const text of [
  "modelAuthor",
  "agentCredit",
  "botAuthor",
  "createdFromModel",
  "builtWithAgent",
  "cursor: pointer",
  "cursorPosition",
  "pilot",
  "piValue",
  "generatedByUser",
  "creditCard",
])
  test(`allows ordinary identifier ${text}`, () => assert.deepEqual(scanText("fixture", text), []));

test("review item 1: Markdown and punctuation end host tokens", () => {
  for (const text of [
    `run ${String.fromCharCode(96)}ssh srv42${String.fromCharCode(96)} first`,
    `${String.fromCharCode(96)}ssh root@srv42${String.fromCharCode(96)}`,
    `${String.fromCharCode(96)}http://srv42${String.fromCharCode(96)}`,
    `${String.fromCharCode(96)}https://nas${String.fromCharCode(96)}`,
    `${String.fromCharCode(96)}Host: srv42${String.fromCharCode(96)}`,
    "(ssh srv42)",
    "ssh srv42.",
    "**ssh srv42**",
    `${String.fromCharCode(96)}scp dist.tar srv42:${String.fromCharCode(96)}`,
  ])
    assert.ok(findInternalHostnames("fixture", text).length, text);
});
test("review item 2: command contexts differ from prose", () => {
  for (const text of ["SSH access is required", "Connect over SSH to the server"])
    assert.deepEqual(findInternalHostnames("fixture", text), [], text);
  for (const text of ["run ssh -p 2222 srv42", "$ sudo ssh srv42", "~~~sh\nsudo ssh srv42\n~~~"])
    assert.ok(findInternalHostnames("fixture", text).length, text);
});
test("review item 3: UI metrics differ from host ports", () => {
  for (const text of ["Length:20", "Entropy:128"]) assert.deepEqual(findHostnames("fixture", text), [], text);
  for (const text of ["http://nas:8080", "$ ssh nas:8080"])
    assert.ok(findInternalHostnames("fixture", text).length, text);
});
test("review item 4: syntax and explanatory phrases are allowed", () => {
  for (const text of ["file:///tmp/x", "node@22", "@internal", "@public", "@ts-expect-error", "Host: any static host"])
    assert.deepEqual(findInternalHostnames("fixture", text), [], text);
});
test("review item 5: server configs and network commands name targets", () => {
  for (const text of ["server srv42;", "ping srv42", "dig srv42", "nc srv42 8080"])
    assert.ok(findInternalHostnames("fixture", text).length, text);
  assert.ok(findInternalHostnames("Caddyfile", "srv42 {").length);
});
test("review item 6: credits require named tools", () => {
  const tool = EXAMPLE_TOOLS.find((name) => name.toLowerCase() === "cursor") as string;
  for (const text of [
    `generatedBy${tool}AI`,
    `madeWith${tool}Agent`,
    `generatedBy${tool}2`,
    `${tool.toLowerCase()}Generated`,
    `${tool.toUpperCase()}_GENERATED`,
    `generatedBy: "${tool}"`,
    `credit: "${tool}"`,
    `<meta name="generator" content="${tool}">`,
  ])
    assert.ok(scanText("fixture", text).length, text);
  for (const text of [
    "modelAuthor",
    "agentCredit",
    "botAuthor",
    "createdFromModel",
    "builtWithAgent",
    "cursor: pointer",
    "cursorPosition",
    "pilot",
    "piValue",
    "generatedByUser",
    "creditCard",
  ])
    assert.deepEqual(scanText("fixture", text), [], text);
});

for (const keyword of [
  "media",
  "supports",
  "container",
  "import",
  "font-face",
  "namespace",
  "keyframes",
  "property",
  "layer",
]) {
  test(`CSS at-rule documentation permits only bare syntax ${keyword}`, () => {
    const quoted = `${String.fromCharCode(96)}@${keyword}${String.fromCharCode(96)}`;
    assert.deepEqual(findInternalHostnames("documentation.md", quoted), []);
    for (const target of [`http://${keyword}`, `user@${keyword}`, `$ ssh ${keyword}`])
      assert.ok(findInternalHostnames("fixture", target).length, target);
  });
}
test("CSS syntax exceptions retain resource checks", () => {
  for (const source of [
    '@import "./asset.css";',
    '@font-face{font-family:demo;src:url("./asset.woff2")}',
    '@namespace svg "http://example.com/svg";',
  ])
    assert.ok(checkCss("fixture.css", source).some((finding) => finding.problem.includes("CSS loads a resource")));
});

test("source-relative style guide reference is a file, not a domain", () => {
  assert.deepEqual(findHostnames("fixture", "See src/styles/README.md."), []);
  assert.deepEqual(checkCss("fixture.css", "/* See src/styles/README.md. */a{}"), []);
  for (const target of [
    "README.md",
    "readme.md",
    "https://README.md",
    "//README.md",
    "user@README.md",
    "https://src/styles/README.md",
  ])
    assert.ok(findHostnames("fixture", target).length, target);
});
