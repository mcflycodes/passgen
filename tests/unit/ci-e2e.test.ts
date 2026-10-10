import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { PR_PROJECTS, PROJECTS } from "../../playwright.config.ts";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const fullWorkflow = readFileSync(new URL("../../.github/workflows/full-suite.yml", import.meta.url), "utf8");
const job = fullWorkflow.match(/^ {2}e2e:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m)?.[0];
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
  assert.match(spec, /test\([\s\S]*?`accessibility [\s\S]*?@a11y-matrix.*@a11y-smoke/);
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
  assert.equal(configuration.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1], "  push:\n    tags: ['v*.*.*']\n\n");
  assert.equal(jobs.length, 4);
  const [validate = "", full = "", build = "", publish = ""] = jobs;
  assert.match(full, /^full-suite:\n {4}needs: validate\n/);
  assert.match(full, /uses: \.\/\.github\/workflows\/full-suite\.yml/);
  assert.match(full, /commit: \$\{\{ needs\.validate\.outputs\.commit \}\}/);
  assert.match(full, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(full, /secrets:|if:/);
  assert.match(validate, /^validate:\n/);
  assert.match(validate, /permissions:\n {6}contents: read\n {6}actions: read\n {4}outputs:/);
  assert.match(build, /^build:\n {4}needs: \[validate, full-suite\]\n/);
  assert.match(build, /permissions:\n {6}contents: read\n {4}steps:/);
  assert.match(publish, /^publish:\n {4}needs: \[validate, full-suite, build\]\n/);
  assert.match(publish, /permissions:\n {6}contents: write\n {4}steps:/);
  assert.doesNotMatch(publish, /checkout|setup-node|action-setup|\bnode\b|\bpnpm\b|\bpython3?\b|\bnpm\b/);
  assert.match(build, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(publish, /uses: actions\/download-artifact@[a-f0-9]{40}/);
  for (const job of [build, publish]) {
    assert.match(job, /^ {10}name: passgen-release$/m);
    assert.match(job, /^ {10}path: release\/$/m);
  }
  assert.match(publish, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/v\$RELEASE_VERSION"/);
  assert.match(publish, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/tags\/\$sha"/);
  assert.match(publish, /test "\$type" = commit/);
  assert.match(publish, /test "\$sha" = "\$RELEASE_COMMIT"/);
  assert.match(publish, /gh release create .*--repo "\$GITHUB_REPOSITORY".*--verify-tag.*--notes-file/);
  assert.match(
    publish,
    /gh release create .*"release\/passgen-\$RELEASE_VERSION\.zip" release\/SHA256SUMS "release\/passgen-\$RELEASE_VERSION\.zip\.sha256" release\/passgen\.zip release\/passgen\.zip\.sha256/,
  );
  assert.equal((configuration.match(/contents: write/g) ?? []).length, 1);
  assert.doesNotMatch(configuration, /cache:|actions\/cache@|secrets\.|write-all|read-all|test:e2e/);
  for (const action of configuration.matchAll(/uses: (\S+)/g)) {
    if (action[1] === "./.github/workflows/full-suite.yml") continue;
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
    releaseWorkflow.replace(" release/passgen.zip release/passgen.zip.sha256", ""),
    releaseWorkflow.replace("permissions: {}", "permissions: write-all"),
    releaseWorkflow.replace("contents: read", "contents: write"),
    releaseWorkflow.replace("node-version-file: .nvmrc", "node-version-file: .nvmrc\n          cache: pnpm"),
    releaseWorkflow.replace("run: node scripts/check-release.ts", `run: echo \${{ github.ref_name }}`),
  ])
    assert.throws(() => checkReleaseWorkflow(broken));
});

test("release workflow guard rejects write permission in build, dependency code in publish and PR triggers", () => {
  const brokenBuild = releaseWorkflow.replace(/( {2}build:[\s\S]*?contents:) read/, "$1 write");
  const brokenPublish = releaseWorkflow.replace(
    "      - name: Verify remote tag and publish release",
    "      - run: pnpm install\n      - name: Verify remote tag and publish release",
  );
  const brokenTrigger = releaseWorkflow.replace("on:\n", "on:\n  pull_request:\n");
  for (const broken of [brokenBuild, brokenPublish, brokenTrigger]) {
    assert.notEqual(broken, releaseWorkflow);
    assert.throws(() => checkReleaseWorkflow(broken));
  }
});

function checkPushConcurrency(configuration: string, prefix: string) {
  assert.equal(
    configuration.match(/^ {2}group: (.+)$/m)?.[1],
    `${prefix}-\${{ github.workflow }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}`,
    "Push runs must use their commit SHA; PR runs must share their ref's group",
  );
  assert.equal(
    configuration.match(/^ {2}cancel-in-progress: (.+)$/m)?.[1],
    `\${{ github.event_name == 'pull_request' }}`,
  );
}

const concurrencyWorkflows = [
  { name: "CI", prefix: "ci", configuration: workflow },
  { name: "Attribution", prefix: "attribution", configuration: read(".github/workflows/attribution.yml") },
];
for (const { name, prefix, configuration } of concurrencyWorkflows) {
  test(`${name} groups push runs by SHA and supersedes PR runs by ref`, () => {
    checkPushConcurrency(configuration, prefix);
  });
}

test("push concurrency guard rejects ref-wide grouping and unconditional cancellation", () => {
  for (const { prefix, configuration } of concurrencyWorkflows) {
    assert.throws(() =>
      checkPushConcurrency(configuration.replace(/^( {2}group:).+$/m, `$1 ${prefix}-\${{ github.ref }}`), prefix),
    );
    assert.throws(() =>
      checkPushConcurrency(configuration.replace(/^ {2}cancel-in-progress:.+$/m, "  cancel-in-progress: true"), prefix),
    );
  }
});

function checkServerWorkflow(configuration: string) {
  assert.equal(
    configuration.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1],
    "  pull_request:\n  push:\n    branches: [main]\n\n",
  );
  assert.equal(configuration.match(/^permissions:\n([\s\S]*?)(?=^\S)/m)?.[1], "  contents: read\n\n");
  checkPushConcurrency(configuration, "ci");
  const server = configuration.match(/^ {2}server-configs:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m)?.[0];
  assert.ok(server, "CI must test server configs");
  assert.match(server, /^ {4}runs-on: ubuntu-24\.04$/m);
  assert.doesNotMatch(server, /permissions:|cache:|actions\/cache|secrets\.|container:|self-hosted/);
  for (const [variable, image] of [
    ["HTTPD", "public.ecr.aws/docker/library/httpd:2.4"],
    ["NGINX", "public.ecr.aws/docker/library/nginx:stable"],
    ["CADDY", "public.ecr.aws/docker/library/caddy:2"],
  ] as const) {
    assert.match(
      server,
      new RegExp(`^ {10}${variable}_IMAGE: ${image.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`, "m"),
    );
  }
  for (const run of server.matchAll(/run:.*(?:\n {10}.*)*/g)) assert.doesNotMatch(run[0], /\$\{\{/);
  for (const action of server.matchAll(/uses: (\S+)/g)) assert.match(action[1] ?? "", /@[a-f0-9]{40}$/);
  assert.match(server, /persist-credentials: false/);
  assert.equal((server.match(/pnpm build/g) ?? []).length, 1);
  for (const command of ["pnpm headers:check", "pnpm manifest", "bash scripts/test-server-configs.sh"])
    assert.ok(server.includes(command));
}

test("server config CI pins official images, actions, read-only permissions and safe triggers", () => {
  checkServerWorkflow(workflow);
});

test("server config guard rejects each missing image digest", () => {
  for (const image of [
    "public.ecr.aws/docker/library/httpd:2.4",
    "public.ecr.aws/docker/library/nginx:stable",
    "public.ecr.aws/docker/library/caddy:2",
  ]) {
    const broken = workflow.replace(new RegExp(`${image.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}`), image);
    assert.notEqual(broken, workflow);
    assert.throws(() => checkServerWorkflow(broken));
  }
});

test("server config guard rejects elevated permissions and unsafe triggers", () => {
  for (const broken of [
    workflow.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
    workflow.replace("  contents: read\n", "  contents: read\n  id-token: write\n"),
    workflow.replace("  contents: read\n", "  contents: read\n  packages: write\n"),
    workflow.replace("  server-configs:\n", "  server-configs:\n    permissions: write-all\n"),
    workflow.replace("  pull_request:", "  pull_request_target:"),
    workflow.replace("branches: [main]", "branches: ['*']"),
    workflow.replace("  push:\n", "  workflow_dispatch:\n  push:\n"),
  ]) {
    assert.notEqual(broken, workflow);
    assert.throws(() => checkServerWorkflow(broken));
  }
});

test("server config guard rejects expressions in single-line and multiline run commands", () => {
  for (const broken of [
    workflow.replace(
      "      - run: pnpm install",
      `      - run: echo \${{ github.event.pull_request.title }}; pnpm install`,
    ),
    workflow.replace(
      '          TMPDIR="$RUNNER_TEMP/passgen-configs"',
      `          echo \${{ github.event.pull_request.title }}\n          TMPDIR="$RUNNER_TEMP/passgen-configs"`,
    ),
  ]) {
    assert.notEqual(broken, workflow);
    assert.throws(() => checkServerWorkflow(broken));
  }
});

function jobBlock(configuration: string, name: string): string {
  const block = configuration.match(new RegExp(`^ {2}${name}:\\n[\\s\\S]*?(?=^ {2}[\\w-]+:|$(?![\\s\\S]))`, "m"))?.[0];
  assert.ok(block, `Missing job ${name}`);
  return block;
}

function checkFast(configuration: string) {
  const browser = jobBlock(configuration, "e2e");
  assert.deepEqual(JSON.parse(browser.match(/^ {8}include: (\[.*\])$/m)?.[1] ?? "[]"), [
    { project: "chromium", shard: 1, label: "chromium 1/2" },
    { project: "chromium", shard: 2, label: "chromium 2/2" },
    { project: "firefox", shard: 0, label: "firefox" },
    { project: "webkit", shard: 1, label: "webkit 1/2" },
    { project: "webkit", shard: 2, label: "webkit 2/2" },
  ]);
  assert.doesNotMatch(browser, /mobile-chrome|mobile-safari/);
  assert.match(browser, /^ {4}timeout-minutes: 15$/m);
  assert.match(browser, /^ {6}fail-fast: false$/m);
  assert.match(browser, /^ {10}PASSGEN_E2E_MODE: pr$/m);
  assert.match(browser, /^ {10}PASSGEN_E2E_PROJECTS: \$\{\{ matrix.project \}\}$/m);
  assert.match(browser, /^ {10}PLAYWRIGHT_SHARD: \$\{\{ matrix.shard \}\}$/m);
  assert.match(browser, /if \[ "\$PLAYWRIGHT_SHARD" = 0 \]; then\n {12}pnpm test:e2e\n {10}else/);
  const e2eSteps = browser.split(/^ {6}- /m).filter((step) => /\bpnpm test:e2e\b/.test(step));
  assert.equal(e2eSteps.length, 1);
  const commands = e2eSteps[0]?.match(/^ {8}run: \|\n((?: {10}.*\n)+)/m)?.[1];
  assert.deepEqual(
    commands
      ?.split("\n")
      .filter(Boolean)
      .map((line) => line.trim()),
    [
      'if [ "$PLAYWRIGHT_SHARD" = 0 ]; then',
      "pnpm test:e2e",
      "else",
      ...E2E_COMMANDS.map((command) => command.replace("/3", "/2")),
      "fi",
    ],
    "Fast CI must run each test class exactly once per shard",
  );
  assert.match(browser, /name: playwright-report-pr-\$\{\{ matrix.project \}\}-\$\{\{ matrix.shard \}\}/);
  assert.match(browser, /^ {8}if: matrix.project == 'chromium' && matrix.shard == 1$/m);
  assert.equal((configuration.match(/run: pnpm test:gate/g) ?? []).length, 1);
  checkContainer(browser, playwrightVersion);
  assert.match(browser, /^ {6}options: --init --ipc=host --user 1001$/m);
  assert.doesNotMatch(configuration, /secrets\.|pull_request_target|contents: write/);
  for (const name of ["e2e", "server-configs"]) {
    const block = jobBlock(configuration, name);
    assert.match(block, /^ {4}needs: changes$/m);
    assert.match(block, /^ {4}if: needs.changes.outputs.code == 'true'$/m);
  }
  for (const name of ["static", "build", "supply-chain"]) {
    assert.doesNotMatch(jobBlock(configuration, name), /^ {4}(?:if|needs):/m);
  }
  const changes = jobBlock(configuration, "changes");
  assert.match(changes, /fetch-depth: 0/);
  assert.match(changes, /run: node scripts\/ci-changes.ts/);
  assert.match(changes, /CHANGE_BASE: \$\{\{ github.event.pull_request.base.sha \|\| github.event.before \}\}/);
  const summary = jobBlock(configuration, "result");
  assert.match(summary, /^ {4}name: CI result$/m);
  assert.match(summary, /^ {4}if: always\(\)$/m);
  const needs: string[] = summary.match(/^ {4}needs: \[(.*)\]$/m)?.[1]?.split(", ") ?? [];
  const jobNames = [...(configuration.split("jobs:\n")[1] ?? "").matchAll(/^ {2}([\w-]+):$/gm)]
    .map((match) => match[1])
    .filter((name) => name !== "result");
  assert.deepEqual(needs.sort(), jobNames.sort(), "Summary must need every other job");
}

function runSummary(configuration: string, code: string, overrides: Record<string, string> = {}, omitted?: string) {
  const summary = jobBlock(configuration, "result");
  const script = summary.split("node <<'JS'\n")[1]?.split("          JS")[0];
  assert.ok(script);
  const names = ["changes", "static", "build", "e2e", "supply-chain", "server-configs"];
  const results = Object.fromEntries(
    names.map((name) => [
      name,
      {
        result:
          overrides[name] ?? (code === "false" && ["e2e", "server-configs"].includes(name) ? "skipped" : "success"),
        outputs: name === "changes" ? { code } : {},
      },
    ]),
  );
  if (omitted) delete results[omitted];
  const resultProcess = {
    env: { RESULTS: JSON.stringify(results) },
    exitCode: 0,
    exit: (code: number) => {
      throw new Error(`Summary exited ${code}`);
    },
  };
  runInNewContext(script, { process: resultProcess, console: { error: () => {} } });
  assert.equal(resultProcess.exitCode, 0, "Summary must reject this result");
}

test("fast CI covers desktop engines and always runs static, build and supply chain", () => {
  checkFast(workflow);
  assert.deepEqual(
    PR_PROJECTS.map((project) => project.name),
    ["chromium", "firefox", "webkit"],
  );
  const spec = read("tests/e2e/accessibility.spec.ts");
  assert.match(spec, /style === STYLES\[0\] && theme === "system" && scheme === "light" && intro/);
  for (const project of PR_PROJECTS) {
    if (project.name === "chromium") assert.equal(project.grepInvert, undefined);
    else {
      assert.equal(project.grepInvert?.test("functional"), false);
      assert.equal(project.grepInvert?.test("accessibility @a11y-matrix"), true);
      assert.equal(project.grepInvert?.test("accessibility @a11y-matrix @a11y-smoke"), false);
    }
  }
  assert.doesNotMatch(read(".github/workflows/attribution.yml"), /^ {4}if:|paths-ignore:|paths:/m);
});

test("fast CI guards reject mobile projects, missing needs, skipped mandatory jobs and missing split", () => {
  for (const broken of [
    workflow.replace('"project":"webkit"', '"project":"mobile-safari"'),
    workflow.replace('"shard":2', '"shard":1'),
    workflow.replace("$PLAYWRIGHT_SHARD/2", "1/2"),
    workflow.replace(" && matrix.shard == 1", ""),
    workflow.replace(
      "[changes, static, build, e2e, supply-chain, server-configs]",
      "[changes, static, build, e2e, supply-chain]",
    ),
    workflow.replace("  static:\n", "  static:\n    if: needs.changes.outputs.code == 'true'\n"),
    workflow.replace("PASSGEN_E2E_MODE: pr", "PASSGEN_E2E_MODE: full"),
    workflow.replace("matrix.project == 'chromium'", "always()"),
  ]) {
    assert.notEqual(broken, workflow);
    assert.throws(() => checkFast(broken));
  }
});

test("fast CI rejects a missing, duplicate or unsharded WebKit leg", () => {
  const entry = '{"project":"webkit","shard":2,"label":"webkit 2/2"}';
  for (const broken of [
    workflow.replace(`,${entry}`, ""),
    workflow.replace(entry, '{"project":"webkit","shard":1,"label":"webkit 1/2"}'),
    workflow.replace(entry, '{"project":"webkit","shard":0,"label":"webkit"}'),
  ]) {
    assert.notEqual(broken, workflow);
    assert.throws(() => checkFast(broken));
  }
});

test("summary permits only planned skips and rejects every failed or cancelled job", () => {
  runSummary(workflow, "true");
  runSummary(workflow, "false");
  assert.throws(() => runSummary(workflow, ""));
  for (const code of ["true", "false"]) {
    for (const name of ["changes", "static", "build", "e2e", "supply-chain", "server-configs"]) {
      assert.throws(() => runSummary(workflow, code, {}, name));
      for (const result of ["failure", "cancelled"])
        assert.throws(() => runSummary(workflow, code, { [name]: result }));
      if (code === "true" || !["e2e", "server-configs"].includes(name))
        assert.throws(() => runSummary(workflow, code, { [name]: "skipped" }));
    }
  }
  const broken = workflow.replace("process.exitCode = 1;", "process.exitCode = 0;");
  assert.throws(() => assert.throws(() => runSummary(broken, "true", { static: "failure" })));
});

test("full suite runs nightly, manually and on the validated release commit", () => {
  assert.match(fullWorkflow, /schedule:\n {4}- cron: '/);
  assert.match(fullWorkflow, /^ {2}workflow_dispatch:$/m);
  assert.match(fullWorkflow, /^ {2}workflow_call:$/m);
  assert.match(fullWorkflow, /commit:[\s\S]*?required: true\n {8}type: string/);
  assert.match(job, /ref: \$\{\{ inputs.commit \|\| github.sha \}\}/);
  assert.match(fullWorkflow, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(fullWorkflow, /PASSGEN_E2E_MODE|secrets\.|pull_request/);
});

test("release guard rejects bypassing the full suite or testing a different commit", () => {
  for (const broken of [
    releaseWorkflow.replace("needs: [validate, full-suite]", "needs: validate"),
    releaseWorkflow.replace("needs: [validate, full-suite, build]", "needs: [validate, build]"),
    releaseWorkflow.replace(`commit: \${{ needs.validate.outputs.commit }}`, "commit: main"),
    releaseWorkflow.replace("  full-suite:\n", "  full-suite:\n    if: always()\n"),
  ])
    assert.throws(() => checkReleaseWorkflow(broken));
});
