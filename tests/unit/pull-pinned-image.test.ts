import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The CI image-pull helper, run against a stub docker and a simulated clock:
// no network, no real sleeping.
const HELPER = fileURLToPath(new URL("../../scripts/ci/pull-pinned-image.sh", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const START = 1_000_000;

const HTTPD_DIGEST = "sha256:c842ac797bd1fe8b3cd26d002ac9d948aa2814097544600600b35aef42e6785a";
const HTTPD = `public.ecr.aws/docker/library/httpd:2.4@${HTTPD_DIGEST}`;
const ECR = `public.ecr.aws/docker/library/httpd@${HTTPD_DIGEST}`;
const HUB = `docker.io/library/httpd@${HTTPD_DIGEST}`;
const GCR = `mirror.gcr.io/library/httpd@${HTTPD_DIGEST}`;
const BASE_DIGEST = "sha256:3af0c10d960cc2502427fe1219c52989d309e7d65596869c60a34fd2fa2406f0";
const BASE = `public.ecr.aws/nginx/nginx-unprivileged:1.30.5-alpine-slim@${BASE_DIGEST}`;

const RATE_LIMIT = "1|toomanyrequests: Rate exceeded";

const STUBS = {
  // Each non-inspect call takes the next scripted "status|message" line; none left means success.
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/calls"
if [ "$1 $2" = "image inspect" ]; then
  if grep -qxF "\${@: -1}" "$STUB_DIR/missing"; then echo "Error: No such image: \${@: -1}" >&2; exit 1; fi
  exit 0
fi
line=$(head -n 1 "$STUB_DIR/outcomes")
tail -n +2 "$STUB_DIR/outcomes" > "$STUB_DIR/outcomes.next" && mv "$STUB_DIR/outcomes.next" "$STUB_DIR/outcomes"
[ -n "$line" ] || exit 0
[ -z "\${line#*|}" ] || echo "\${line#*|}" >&2
exit "\${line%%|*}"
`,
  date: `#!/usr/bin/env bash
cat "$STUB_DIR/clock"
`,
  sleep: `#!/usr/bin/env bash
echo "sleep $1" >> "$STUB_DIR/calls"
echo $(( $(cat "$STUB_DIR/clock") + $1 )) > "$STUB_DIR/clock"
`,
  // Records the attempt limit, charges each attempt 5 simulated seconds (at most its limit) and runs the command.
  timeout: `#!/usr/bin/env bash
echo "timeout $2" >> "$STUB_DIR/calls"
echo $(( $(cat "$STUB_DIR/clock") + ($2 < 5 ? $2 : 5) )) > "$STUB_DIR/clock"
shift 2
exec "$@"
`,
};

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every image ref docker was asked to pull or build from, in order. */
  refs: string[];
  calls: string[];
  sleeps: number[];
  limits: number[];
  elapsed: number;
};

function run(args: string[], outcomes: string[] = [], options: { missing?: string[]; env?: object } = {}): Run {
  const dir = mkdtempSync(join(resolve(tmpdir()), "passgen-pull-"));
  try {
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, "outcomes"), outcomes.map((line) => `${line}\n`).join(""));
    writeFileSync(join(dir, "missing"), (options.missing ?? []).map((line) => `${line}\n`).join(""));
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "clock"), `${START}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, TMPDIR: dir };
    for (const name of Object.keys(env)) if (name.startsWith("PINNED_IMAGE_")) delete env[name];
    const result = spawnSync("bash", [HELPER, ...args], { encoding: "utf8", env: { ...env, ...options.env } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    const leftovers = readdirSync(dir).filter((name) => name.startsWith("pull-pinned-image-"));
    assert.deepEqual(leftovers, [], "The helper removes its work directory");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      refs: calls
        .filter((call) => call.startsWith("docker ") && !call.startsWith("docker image inspect"))
        .map((call) => call.match(/(?:pull --quiet |docker-image:\/\/)(\S+)/)?.[1] ?? call),
      calls,
      sleeps: calls.filter((call) => call.startsWith("sleep ")).map((call) => Number(call.slice(6))),
      limits: calls.filter((call) => call.startsWith("timeout ")).map((call) => Number(call.slice(8))),
      elapsed: Number(readFileSync(join(dir, "clock"), "utf8")) - START,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every ref handed to docker is name@digest with the pinned digest: never a tag. */
function assertPinned(result: Run, digest: string) {
  assert.ok(result.refs.length > 0);
  for (const ref of result.refs) assert.match(ref, new RegExp(`^[a-z0-9./-]+@${digest}$`), ref);
}

/** Jittered exponential backoff: the nth wait is between half and all of min(60, 2^n) seconds. */
function assertBackoff(sleeps: number[]) {
  sleeps.forEach((seconds, index) => {
    const ceiling = Math.min(60, 2 ** (index + 1));
    assert.ok(seconds >= Math.floor(ceiling / 2) && seconds <= ceiling, `wait ${index + 1}: ${seconds}s`);
  });
}

test("every pinned image in CI, the release, the Dockerfile and the recipes has fallback sources by its digest", () => {
  const files = [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "Dockerfile",
    ...["caddy-files", "caddy-https", "httpd-files"].map((recipe) => `deploy/compose/${recipe}/compose.yaml`),
  ];
  const refs = new Set(
    files.flatMap((file) =>
      [...read(file).matchAll(/(?:public\.ecr\.aws|mirror\.gcr\.io)\/[\w./-]+(?::[\w.-]+)?@sha256:[a-f0-9]{64}/g)].map(
        (match) => match[0],
      ),
    ),
  );
  assert.ok(refs.size >= 5, [...refs].join("\n"));
  const expected: Record<string, string[]> = {
    "public.ecr.aws/docker/library/caddy": ["docker.io/library/caddy", "mirror.gcr.io/library/caddy"],
    "public.ecr.aws/docker/library/httpd": ["docker.io/library/httpd", "mirror.gcr.io/library/httpd"],
    "public.ecr.aws/docker/library/nginx": ["docker.io/library/nginx", "mirror.gcr.io/library/nginx"],
    "public.ecr.aws/nginx/nginx-unprivileged": [
      "docker.io/nginxinc/nginx-unprivileged",
      "mirror.gcr.io/nginxinc/nginx-unprivileged",
    ],
    "mirror.gcr.io/moby/buildkit": ["docker.io/moby/buildkit"],
  };
  for (const ref of refs) {
    const repo = ref.replace(/(?::[\w.-]+)?@.*$/, "");
    const digest = ref.slice(ref.indexOf("@") + 1);
    const result = run(["sources", ref]);
    assert.equal(result.status, 0, result.stderr);
    // AWS ECR Public first where the pin is there, then Docker Hub, then Google's mirror.
    assert.deepEqual(
      result.stdout.trim().split("\n"),
      [repo, ...(expected[repo] ?? [])].map((source) => `${source}@${digest}`),
    );
  }
});

test("refuses refs not pinned by digest, unknown repositories and commands without {image}", () => {
  for (const args of [
    ["sources", "public.ecr.aws/docker/library/httpd:2.4"],
    ["pull", "public.ecr.aws/docker/library/httpd:2.4"],
    ["pull", HTTPD, "public.ecr.aws/docker/library/caddy:2"],
    ["pull", HTTPD.replace(/[a-f0-9]{64}$/, "abc")],
    ["pull", HTTPD.replace(/[a-f0-9]{64}$/, "A".repeat(64))],
    ["pull", HTTPD.replace("sha256:", "sha512:")],
    ["pull", `docker.io/library/redis:7@${HTTPD_DIGEST}`],
    ["run", BASE, "--", "docker", "build", "."],
    ["run", BASE.replace(/@.*/, ""), "--", "docker", "build", "--build-context", "upstream=docker-image://{image}"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.deepEqual(result.calls, [], "Nothing is pulled when a ref is not pinned");
  }
});

test("pulls the pinned registry first, by digest only, and prints the ref used", () => {
  const result = run(["pull", HTTPD]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${ECR}\n`);
  assert.deepEqual(result.refs, [ECR]);
  assert.ok(result.calls.includes(`docker image inspect --format {{.Id}} ${ECR}`), "Pulled digest is confirmed");
  assert.deepEqual(result.sleeps, []);
  assert.match(result.stderr, /attempt 1: public\.ecr\.aws\/docker\/library\/httpd@sha256:c842\S+ succeeded/);
});

test("on rate limits, 5xx and network errors, falls back to Docker Hub, then round-robins with backoff", () => {
  const result = run(
    ["pull", HTTPD],
    [
      RATE_LIMIT,
      "1|Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit",
      "1|received unexpected HTTP status: 503 Service Unavailable",
      "1|dial tcp: lookup public.ecr.aws: i/o timeout",
      "1|toomanyrequests: Data limit exceeded",
    ],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.refs, [ECR, HUB, GCR, ECR, HUB, GCR]);
  assert.equal(result.stdout, `${GCR}\n`);
  assertPinned(result, HTTPD_DIGEST);
  assert.equal(result.sleeps.length, 5);
  assertBackoff(result.sleeps);
  // One log line per failed attempt: attempt number, source and the registry's error.
  assert.match(result.stderr, /attempt 1: public\.ecr\.aws\/\S+ failed \(retryable\): toomanyrequests: Rate exceeded/);
  assert.match(result.stderr, /attempt 2: docker\.io\/\S+ failed \(retryable\): .*unauthenticated pull rate limit/);
  assert.match(result.stderr, /attempt 3: mirror\.gcr\.io\/\S+ failed \(retryable\): .*503 Service Unavailable/);
  assert.match(result.stderr, /attempt 4: public\.ecr\.aws\/\S+ failed \(retryable\): .*i\/o timeout/);
  assert.match(result.stderr, /attempt 6: mirror\.gcr\.io\/\S+ succeeded/);
});

test("a source without the digest is dropped and the rotation continues with the rest", () => {
  const result = run(["pull", HTTPD], ["1|Error response from daemon: manifest unknown", RATE_LIMIT, RATE_LIMIT]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.refs, [ECR, HUB, GCR, HUB]);
  assert.match(result.stderr, /attempt 1: public\.ecr\.aws\/\S+ failed \(dropping this source\): .*manifest unknown/);
  assertPinned(result, HTTPD_DIGEST);
});

test("a pull the daemon cannot find under the pinned digest counts as a mismatch for that source", () => {
  const result = run(["pull", HTTPD], [], { missing: [ECR] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.refs, [ECR, HUB]);
  assert.equal(result.stdout, `${HUB}\n`);
  assert.match(result.stderr, /failed \(dropping this source\): digest mismatch/);
});

test("fails at once when no source serves the digest", () => {
  const result = run(
    ["pull", HTTPD],
    [
      "1|manifest unknown",
      "1|Error response from daemon: manifest for docker.io/library/httpd@sha256:c842 not found",
      `1|failed to resolve source metadata for ${GCR}: ${GCR}: not found`,
    ],
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.refs, [ECR, HUB, GCR]);
  assert.match(result.stderr, /FAIL: \S+: no source serves sha256:c842/);
  assert.equal(result.stdout, "");
});

test("an outage fails loudly before the deadline; waits never exceed 60s and attempts never outlast it", () => {
  const outage = Array.from({ length: 200 }, () => RATE_LIMIT);
  const result = run(["pull", HTTPD], outage);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /FAIL: \S+: gave up before attempt \d+; the next try would pass the deadline/);
  assert.ok(result.elapsed <= 480, `${result.elapsed}s`);
  assert.ok(result.refs.length >= 9, `${result.refs.length} attempts`);
  assertBackoff(result.sleeps);
  assert.ok(result.limits.every((limit) => limit > 0 && limit <= 240));
  assertPinned(result, HTTPD_DIGEST);
  // Strict rotation through all three sources.
  assert.deepEqual(
    result.refs,
    result.refs.map((_, index) => [ECR, HUB, GCR][index % 3]),
  );
});

test("a shared deadline caps every call, and attempts get only the time that is left", () => {
  const result = run(
    ["pull", HTTPD],
    Array.from({ length: 50 }, () => RATE_LIMIT),
    {
      env: { PINNED_IMAGE_DEADLINE: String(START + 40) },
    },
  );
  assert.equal(result.status, 1);
  assert.ok(result.elapsed <= 40, `${result.elapsed}s`);
  assert.equal(result.limits[0], 40);
  const late = run(["pull", HTTPD], [], { env: { PINNED_IMAGE_DEADLINE: String(START) } });
  assert.equal(late.status, 1);
  assert.deepEqual(late.calls, []);
  assert.match(late.stderr, /deadline reached after 0 attempts/);
});

test("the backoff doubles from 2s with jitter and stays capped at 60s", () => {
  const result = run(
    ["pull", HTTPD],
    Array.from({ length: 12 }, () => "1|502 Bad Gateway"),
    {
      env: { PINNED_IMAGE_BUDGET: "100000" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.sleeps.length, 12);
  assertBackoff(result.sleeps);
  assert.ok(result.sleeps.slice(6).every((seconds) => seconds >= 30 && seconds <= 60));
});

test("a failure that is not a registry error stops at once with its own status", () => {
  const result = run(
    ["run", BASE, "--", "docker", "buildx", "build", "--build-context", "upstream=docker-image://{image}", "."],
    ['17|ERROR: failed to calculate checksum of ref: "/dist": not found'],
  );
  assert.equal(result.status, 17);
  assert.equal(result.refs.length, 1);
  assert.deepEqual(result.sleeps, []);
  assert.match(result.stderr, /not a registry error; not retried/);
});

test("run supplies each source by the pinned digest wherever {image} appears", () => {
  const result = run(
    ["run", BASE, "--", "docker", "buildx", "build", "--build-context", "upstream=docker-image://{image}", "."],
    [RATE_LIMIT],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const builds = result.calls.filter((call) => call.startsWith("docker buildx build"));
  assert.deepEqual(builds, [
    `docker buildx build --build-context upstream=docker-image://public.ecr.aws/nginx/nginx-unprivileged@${BASE_DIGEST} .`,
    `docker buildx build --build-context upstream=docker-image://docker.io/nginxinc/nginx-unprivileged@${BASE_DIGEST} .`,
  ]);
  assertPinned(result, BASE_DIGEST);
});

test("pull takes several refs under one deadline and prints the ref used for each, in order", () => {
  const caddy =
    "public.ecr.aws/docker/library/caddy:2@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772";
  const result = run(["pull", HTTPD, caddy], [RATE_LIMIT]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [HUB, caddy.replace(":2@", "@")]);
});

test("the helper needs only bash and docker: no logins, secrets, project tooling or tag-only pulls", () => {
  const helper = read("scripts/ci/pull-pinned-image.sh");
  assert.match(helper, /^set -euo pipefail$/m);
  assert.doesNotMatch(helper, /docker login|--password|secrets\.|GH_TOKEN|\bnode\b|\bpnpm\b|\bpython3?\b|\bcurl\b/);
  assert.doesNotMatch(helper, /\$\{\{/);
  // Every candidate is built from source@DIGEST.
  assert.match(helper, /source="\$\{active\[next\]\}@\$DIGEST"/);
  assert.match(helper, /echo "\$source@\$DIGEST"/);
});
