import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
