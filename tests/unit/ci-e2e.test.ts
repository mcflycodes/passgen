import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROJECTS } from "../../playwright.config.ts";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.match(/^ {2}e2e:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m)?.[0];
assert.ok(job, "CI must have an e2e job");
type MatrixEntry = { project: string; shard: number };

function readMatrix(configuration: string): MatrixEntry[] {
  assert.doesNotMatch(configuration, /^ {8}exclude:/m, "CI must not exclude project/shard combinations");
  assert.doesNotMatch(configuration, /^ {8}include:/m, "CI matrix must use only the project and shard axes");
  const projects = configuration.match(/^ {8}project: (\[.*\])$/m)?.[1];
  const shards = configuration.match(/^ {8}shard: (\[.*\])$/m)?.[1];
  assert.ok(projects && shards, "Keep the e2e matrix axes in JSON syntax");
  const projectAxis: string[] = JSON.parse(projects);
  const shardAxis: number[] = JSON.parse(shards);
  return projectAxis.flatMap((project) =>
    shardAxis.map((shard) => ({
      project,
      shard,
    })),
  );
}

const matrix = readMatrix(job);
// The long accessibility matrix sorts first in file order and Playwright cuts
// the ordered test list into contiguous shards, so CI shards it as its own class.
const A11Y_TAG = "@a11y-matrix";
const E2E_COMMANDS = [
  `pnpm test:e2e --shard="$PLAYWRIGHT_SHARD/3" --grep-invert "${A11Y_TAG}"`,
  `pnpm test:e2e --shard="$PLAYWRIGHT_SHARD/3" --grep "${A11Y_TAG}"`,
];
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const playwrightVersion: string = packageJson.devDependencies["@playwright/test"];

function checkContainer(configuration: string, version: string) {
  const container = configuration.match(/^ {4}container:\n((?:^ {6}.+\n)+)/m)?.[1];
  assert.ok(container, "CI e2e must use a container");
  const image = container.match(
    /^ {6}image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[a-f0-9]{64}(?: +#.*)?$/m,
  );
  assert.ok(image, "CI e2e must pin the official Playwright container by SHA-256 digest");
  assert.equal(image[1], version, "CI Playwright container version must match @playwright/test");
}

function checkCoverage(entries: MatrixEntry[]) {
  assert.deepEqual(
    entries.map((entry) => `${entry.project}/${entry.shard}`).sort(),
    PROJECTS.flatMap((project) => [1, 2, 3].map((shard) => `${project.name}/${shard}`)).sort(),
    "CI e2e matrix must cover every Playwright project with every shard exactly once",
  );
}

function checkSteps(configuration: string) {
  const steps = configuration.split(/^ {6}- /m);
  const e2eSteps = steps.filter((step) => /\bpnpm test:e2e\b/.test(step));
  assert.equal(e2eSteps.length, 1, "CI must run the e2e tests in exactly one step per matrix job");
  const e2eStep = e2eSteps[0];
  assert.ok(e2eStep);
  assert.match(
    e2eStep,
    /^ {8}env:\n {10}PASSGEN_E2E_PROJECTS: \$\{\{ matrix\.project \}\}\n {10}PLAYWRIGHT_SHARD: \$\{\{ matrix\.shard \}\}$/m,
  );
  const commands = e2eStep.match(/^ {8}run: \|\n((?: {10}.*\n)+)/m)?.[1];
  assert.deepEqual(
    commands
      ?.split("\n")
      .filter(Boolean)
      .map((line) => line.trim()),
    E2E_COMMANDS,
    "CI must run `pnpm test:e2e --shard=...` once per test class, the accessibility matrix on its own",
  );
  const gateSteps = steps.filter((step) => /^ {8}run: pnpm test:gate$/m.test(step));
  assert.equal(gateSteps.length, 1, "CI must have exactly one combined-gate step");
  const gateStep = gateSteps[0];
  assert.ok(gateStep);
  assert.match(gateStep, /^ {8}if: matrix\.project == 'chromium' && matrix\.shard == 1$/m);
  assert.match(
    configuration,
    /^ {10}name: playwright-report-\$\{\{ matrix\.project \}\}-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.sha \}\}$/m,
  );
}

test("CI e2e matrix covers every Playwright project and shard", () => {
  checkCoverage(matrix);
  assert.match(job, /^ {6}fail-fast: false$/m);
  assert.match(job, /shard \$\{\{ matrix\.shard \}\}\/3/);
  checkSteps(job);
});

test("CI e2e guard rejects a missing or duplicate shard", () => {
  for (const axis of ["[1]", "[1, 2]", "[1, 2, 2]"]) {
    assert.throws(
      () => checkCoverage(readMatrix(job.replace("shard: [1, 2, 3]", `shard: ${axis}`))),
      /must cover every Playwright project with every shard exactly once/,
    );
  }
});

test("CI e2e guard rejects running the combined gate on all shards", () => {
  assert.throws(() => checkSteps(job.replace(" && matrix.shard == 1", "")), /matrix/);
});

test("CI e2e guard rejects broken project or shard environment wiring", () => {
  for (const dimension of ["project", "shard"]) {
    assert.throws(() => checkSteps(job.replace(`: \${{ matrix.${dimension} }}`, ": 1")), /PASSGEN_E2E_PROJECTS/);
  }
  assert.throws(() => checkSteps(job.replace("$PLAYWRIGHT_SHARD/3", "1/3")), /--shard/);
});

test("CI e2e guard rejects sharding the accessibility matrix together with the rest", () => {
  const single = job.replace(
    /^ {8}run: \|\n {10}pnpm test:e2e .*\n(?: {10}.*\n)*/m,
    '        run: pnpm test:e2e --shard="$PLAYWRIGHT_SHARD/3"\n',
  );
  assert.notEqual(single, job);
  assert.throws(() => checkSteps(single), /accessibility matrix/);
  for (const command of E2E_COMMANDS) {
    assert.throws(() => checkSteps(job.replace(`          ${command}\n`, "")), /accessibility matrix/);
  }
});

test("the accessibility matrix carries the tag CI shards it by", () => {
  const spec = readFileSync(new URL("../../tests/e2e/accessibility.spec.ts", import.meta.url), "utf8");
  assert.match(spec, new RegExp(`^ *test\\(\`accessibility .*\`, \\{ tag: "${A11Y_TAG}" \\}, async`, "m"));
});

test("CI e2e guard rejects artifact names shared by all shards", () => {
  assert.throws(
    () => checkSteps(job.replace(`-\${{ matrix.shard }}-\${{ github.sha }}`, `-\${{ github.sha }}`)),
    /playwright-report/,
  );
});

test("CI e2e uses a digest-pinned container matching the Playwright dependency", () => {
  checkContainer(job, playwrightVersion);
  assert.match(job, /^ {6}options: --init --ipc=host --user 1001$/m);
  assert.match(job, /^ {4}timeout-minutes: 40$/m);
  assert.doesNotMatch(job, /playwright install|--with-deps/);
  assert.match(job, /^ {10}node-version-file: \.nvmrc$/m);
});

test("CI e2e container guard rejects a Playwright upgrade without an image update", () => {
  const upgradedVersion = playwrightVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  assert.throws(() => checkContainer(job, upgradedVersion), /container version must match @playwright\/test/);
});

test("CI e2e container guard rejects a missing container or digest", () => {
  assert.throws(() => checkContainer("", playwrightVersion), /must use a container/);
  assert.throws(
    () => checkContainer(job.replace(/@sha256:[a-f0-9]{64}/, ""), playwrightVersion),
    /must pin the official Playwright container by SHA-256 digest/,
  );
});

test("CI e2e coverage guard rejects a missing project", () => {
  assert.throws(
    () => checkCoverage(matrix.slice(3)),
    /must cover every Playwright project with every shard exactly once/,
  );
});

test("CI e2e coverage guard rejects an unknown project", () => {
  assert.throws(
    () => checkCoverage([...matrix, { project: "unknown", shard: 1 }]),
    /must cover every Playwright project with every shard exactly once/,
  );
});

function checkReleaseWorkflow(configuration: string) {
  assert.match(configuration, /^permissions: \{\}$/m);
  const jobs = (configuration.split("jobs:\n")[1] ?? "").split(/^ {2}(?=[\w-]+:\n)/m).slice(1);
  assert.equal(jobs.length, 2);
  assert.match(jobs[0] ?? "", /^validate:\n/);
  assert.match(jobs[0] ?? "", /permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.match(jobs[1] ?? "", /^publish:\n {4}needs: validate\n/);
  assert.match(jobs[1] ?? "", /permissions:\n {6}contents: write\n {4}steps:/);
  assert.equal((configuration.match(/contents: write/g) ?? []).length, 1);
  assert.doesNotMatch(configuration, /cache:|actions\/cache@|secrets\.|write-all|read-all|test:e2e/);
  for (const action of configuration.matchAll(/uses: (\S+)/g)) {
    assert.match(action[1] ?? "", /@[a-f0-9]{40}$/);
  }
  assert.match(configuration, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(configuration, /ref: \$\{\{ needs\.validate\.outputs\.commit \}\}/);
  assert.match(configuration, /run: node scripts\/check-release\.ts/);
  assert.match(configuration, /node scripts\/release-notes\.ts/);
  assert.match(configuration, /gh release create .*--verify-tag.*--notes-file/);
  assert.doesNotMatch(configuration, /--draft|--prerelease/);
  for (const run of configuration.matchAll(/run:.*(?:\n {10}.*)*/g)) assert.doesNotMatch(run[0], /\$\{\{/);
}

const releaseWorkflow = read(".github/workflows/release.yml");
function read(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("release workflow pins actions, limits permissions and builds without cache", () => {
  checkReleaseWorkflow(releaseWorkflow);
});

test("release workflow guard rejects broken pins, permissions, caching and input interpolation", () => {
  for (const broken of [
    releaseWorkflow.replace(/@[a-f0-9]{40}/, "@main"),
    releaseWorkflow.replace("permissions: {}", "permissions: write-all"),
    releaseWorkflow.replace("contents: read", "contents: write"),
    releaseWorkflow.replace("node-version-file: .nvmrc", "node-version-file: .nvmrc\n          cache: pnpm"),
    releaseWorkflow.replace("run: node scripts/check-release.ts", `run: echo \${{ github.ref_name }}`),
  ])
    assert.throws(() => checkReleaseWorkflow(broken));
});
