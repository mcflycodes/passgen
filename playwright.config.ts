import { defineConfig, devices } from "@playwright/test";
import { DIST_DIR, ORIGINS, SUBPATH } from "./tests/e2e/servers.ts";

// End-to-end and accessibility tests run against the built files in dist/,
// served by the plain local static server (decision 0005). Run `pnpm build` first.
// tests/e2e/servers.ts lists the servers started below.

// The command line is fixed text; the folder under test travels in an
// environment variable, so no path ever reaches a shell.
const serve = (port: number, extra: string) => ({
  command: `node scripts/serve.ts --port ${port} ${extra}`.trim(),
  env: { PASSGEN_SERVE_DIR: DIST_DIR },
  url: `http://127.0.0.1:${port}${extra.includes("--base") ? SUBPATH : "/"}`,
  reuseExistingServer: false,
  stdout: "ignore" as const,
});

export const PROJECTS = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
  { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  { name: "mobile-safari", use: { ...devices["iPhone 15"] } },
];

// CI runs every project across its matrix; tests/unit/ci-e2e.test.ts guards coverage.
// PASSGEN_E2E_PROJECTS selects a matrix leg or narrows a local run on a machine
// that cannot launch every engine. Unknown projects fail instead of silently skipping.
function selectedProjects() {
  const wanted = process.env.PASSGEN_E2E_PROJECTS;
  if (wanted === undefined || wanted === "") return PROJECTS;
  const names = wanted.split(",").map((n) => n.trim());
  const unknown = names.filter((n) => !PROJECTS.some((p) => p.name === n));
  if (unknown.length > 0) throw new Error(`Unknown Playwright project(s): ${unknown.join(", ")}`);
  if (!process.env.CI && process.env.TEST_WORKER_INDEX === undefined)
    console.warn(`PASSGEN_E2E_PROJECTS: running only ${names.join(", ")}; CI runs all ${PROJECTS.length} projects.`);
  return PROJECTS.filter((p) => names.includes(p.name));
}

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: ORIGINS.root,
    trace: "retain-on-failure",
  },
  webServer: [serve(4173, ""), serve(4174, `--base ${SUBPATH}`), serve(4175, "--no-headers")],
  projects: selectedProjects(),
});
