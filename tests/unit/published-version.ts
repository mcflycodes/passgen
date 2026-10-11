// Runs the release image job's "Refuse to replace a published version" step with
// a stub curl, as GitHub Actions runs it (bash -e), against each registry answer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STEP = "      - name: Refuse to replace a published version\n";
const GITHUB_TOKEN = "github-token-for-test";
const BEARER = "registry-bearer-for-test";
const MANIFEST_URL = "https://ghcr.io/v2/mcflycodes/passgen/manifests/1.2.3";

const STUB_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/argv"
cat >> "$STUB_DIR/config"
url="\${@: -1}"
case "$url" in
  "https://ghcr.io/token?"*)
    case "$STUB_TOKEN" in
      ok) printf '{"token":"%s"}\\n' "$STUB_BEARER" ;;
      missing) printf '{}\\n' ;;
      *) echo "curl: (22) The requested URL returned error: 401" >&2; exit 22 ;;
    esac ;;
  "https://ghcr.io/v2/"*)
    if [ "$STUB_MANIFEST" = transport ]; then
      printf 000
      echo "curl: (7) Failed to connect to ghcr.io port 443" >&2
      exit 7
    fi
    printf '%s' "$STUB_MANIFEST" ;;
  *) echo "unexpected URL $url" >&2; exit 99 ;;
esac
`;

/** The step's env block and run script, dedented. */
export function publishedVersionStep(image: string): { env: string; script: string } {
  const step = image.split(STEP)[1]?.split(/\n {6}- /)[0];
  assert.ok(step, "The image job must refuse to replace a published version");
  const env = step.match(/^ {8}env:\n((?: {10}.+\n)+)/m)?.[1] ?? "";
  const run = step.match(/^ {8}run: \|\n((?: {10}.*(?:\n|$)| *\n)+)/m)?.[1];
  assert.ok(run, "The published-version step needs a run script");
  return { env, script: run.replace(/^ {10}/gm, "") };
}

type Answer = { token: "ok" | "fail" | "missing"; manifest: string };

function run(script: string, answer: Answer) {
  const dir = mkdtempSync(join(resolve(tmpdir()), "passgen-published-"));
  try {
    writeFileSync(join(dir, "curl"), STUB_CURL);
    chmodSync(join(dir, "curl"), 0o755);
    writeFileSync(join(dir, "argv"), "");
    writeFileSync(join(dir, "config"), "");
    writeFileSync(join(dir, "step.sh"), script);
    const result = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        IMAGE: "ghcr.io/mcflycodes/passgen",
        GITHUB_ACTOR: "release-actor",
        GH_TOKEN: GITHUB_TOKEN,
        RELEASE_VERSION: "1.2.3",
        STUB_DIR: dir,
        STUB_TOKEN: answer.token,
        STUB_BEARER: BEARER,
        STUB_MANIFEST: answer.manifest,
      },
    });
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      stdout: result.stdout,
      argv: readFileSync(join(dir, "argv"), "utf8"),
      config: readFileSync(join(dir, "config"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Only a definite 404 for X.Y.Z lets the release continue. An existing tag,
 * any other status, and token or transport failures must stop it.
 */
export function checkPublishedVersionGuard(image: string) {
  const { env, script } = publishedVersionStep(image);
  assert.match(env, /^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(env, /^ {10}RELEASE_VERSION: \$\{\{ needs\.validate\.outputs\.version \}\}$/m);
  const steps = image.indexOf(STEP);
  assert.ok(steps < image.indexOf("--password-stdin"), "Check before logging in to push");
  assert.ok(steps < image.indexOf("docker buildx build "), "Check before building");

  const free = run(script, { token: "ok", manifest: "404" });
  assert.equal(free.status, 0, `404 must let the release continue:\n${free.stdout}`);
  const requests = free.argv.trim().split("\n");
  assert.equal(requests.length, 2, "One token request and one manifest lookup");
  assert.ok(requests[1]?.endsWith(` ${MANIFEST_URL}`), "Look up exactly the release version");
  assert.match(requests[1] ?? "", /--head\b/);
  for (const type of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ])
    assert.ok(requests[1]?.includes(type), `Accept ${type}, so a tag of any manifest type is found`);
  assert.ok(!free.argv.includes(GITHUB_TOKEN) && !free.argv.includes(BEARER), "Credentials stay out of argv");
  assert.ok(free.config.includes(GITHUB_TOKEN) && free.config.includes(BEARER), "Credentials go through --config");

  for (const manifest of ["200", "301", "401", "403", "429", "500", "502", "503", "", "transport"]) {
    const refused = run(script, { token: "ok", manifest });
    assert.notEqual(refused.status, 0, `Lookup answer ${manifest || "(empty)"} must stop the release`);
    assert.match(refused.stdout, /::error::/, `Lookup answer ${manifest || "(empty)"} must explain the refusal`);
  }
  for (const token of ["fail", "missing"] as const) {
    const refused = run(script, { token, manifest: "404" });
    assert.notEqual(refused.status, 0, `Token ${token} must stop the release`);
    assert.equal(refused.argv.trim().split("\n").length, 1, `Token ${token}: no manifest lookup`);
  }
}
