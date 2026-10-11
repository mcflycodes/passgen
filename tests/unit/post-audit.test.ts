import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SECURITY_HEADERS } from "../../security/headers.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("permissions policy omits the unrecognised web-share directive", () => {
  assert.doesNotMatch(
    SECURITY_HEADERS.find((header) => header.name === "Permissions-Policy")?.value ?? "",
    /web-share/,
  );
});

for (const ecosystem of ["github-actions", "npm", "docker"])
  test(`Dependabot ${ecosystem} updates are weekly with a seven-day cooldown`, () => {
    const sections = read(".github/dependabot.yml").split("  - package-ecosystem: ");
    const section = sections.find((value) => value.startsWith(`${ecosystem}\n`));
    assert.ok(section);
    assert.match(section, /directory: \/\n/);
    assert.match(section, /schedule:\n {6}interval: weekly/);
    assert.match(section, /cooldown:\n {6}default-days: 7/);
  });

for (const path of ["docs/self-hosting.md", "docs/verify.md"])
  test(`${path} documents origin isolation`, () => {
    const text = read(path);
    assert.match(text, /subpath is safe only if\s+nothing else on that host serves\s+pages or scripts/i);
    assert.match(text, /same-origin/);
    assert.match(text, /saved settings/i);
  });
