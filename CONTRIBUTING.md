# Contributing

Bug fixes, tests and new styles are welcome. Keep changes focused so they are
easy to review. Report vulnerabilities using [the security policy](SECURITY.md).

## Setup and checks

You need:

- Node.js **22.23.2** (`.nvmrc`)
- pnpm **11.15.1**, pinned in `package.json` (`corepack enable` picks it up)
- Python 3 for release packaging and its unit tests

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install   # browsers for the end-to-end tests
pnpm check                     # every local gate; see Gates below
```

Other commands:

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server (no meta CSP; the dev client needs inline script) |
| `pnpm build` | Production build into `dist/` |
| `pnpm screenshots` | Build and capture the README images in `docs/screenshots/` |
| `pnpm serve` | Serve `dist/` on `http://127.0.0.1:4173/` with the reference security headers (a local test server, not for deployment) |
| `pnpm headers:gen` | Regenerate `deploy/examples/`, `deploy/container/` and the `deploy/compose/` config folders after changing `security/headers.ts` |
| `pnpm format` | Apply formatting and safe lint fixes |

### Gates

`pnpm check` runs these in order and stops at the first failure.

| Check | What it guards | Command |
|---|---|---|
| Dependencies | No runtime dependencies, exact pins, pnpm supply-chain settings | `pnpm deps:check` |
| Attribution | No attribution to tools, models or vendors | `pnpm attribution:check` |
| HTML sinks | No HTML sinks or executable/link attributes in shipped source | `pnpm html-sinks:check` |
| Word lists | Authenticated word lists and emitted modules match | `pnpm wordlist:check` |
| Types | Strict typecheck | `pnpm typecheck` |
| Lint | Lint and format | `pnpm lint` |
| Unit tests | Unit tests, including documentation links and snippets | `pnpm test:unit` |
| Header snippets | Reference header snippets match the definition | `pnpm headers:check` |
| Styles | Style checks (R4b): tokens, contrast, CSS-only rules | `pnpm styles:check` |
| Build | HTML-sink gate, configuration validation (C2) and style checks, then production build | `pnpm build` |
| Built files | No hostname beyond the configured links, no provider file, inline code or CSS resource in the build; CSP meta in place | `pnpm verify:dist` |
| Manifest | SHA-256 manifest of the build | `pnpm manifest` |
| Browser tests | End-to-end, accessibility and header tests on the built files | `pnpm test:e2e` |
| Combined gates | Injected fixtures through build, verify-dist and browser checks | `pnpm test:gate` |
| Licenses | Dependency licenses | `pnpm licenses:check` |
| Audit | Dependency audit | `pnpm run audit` |

PR and main CI keep the static, build, supply-chain and attribution gates; browser
coverage is described below.

### Screenshots

The README images in `docs/screenshots/` are fixed demonstration values.
Regenerate them with `pnpm screenshots` using the pinned toolchain and Playwright
Chromium (`pnpm exec playwright install chromium`). Images are reproducible on
the same OS, with reduced motion, a fixed clock, and no external requests.

### Browser coverage

The end-to-end tests run on Chromium, Firefox and WebKit, plus mobile emulation.
Local runs may cover only Chromium when the machine lacks Playwright's Firefox
or WebKit system libraries. Select that coverage explicitly:

```sh
PASSGEN_E2E_PROJECTS=chromium,mobile-chrome pnpm check
```

Pull requests and main pushes run functional tests in desktop Chromium, Firefox
and WebKit, the full accessibility matrix in Chromium, and one accessibility
matrix smoke case in each other engine. Chromium uses two shards because its
full matrix exceeds five minutes unsharded; the other engines use one job each.
Combined-gate regressions run once.
Known documentation-only changes skip the `e2e`, `server-configs` and `container` jobs; static,
build, supply-chain and attribution checks still run. Unknown paths count as code.
The required checks are `CI result` and `No attribution`.

[Full suite](.github/workflows/full-suite.yml) runs all five projects, including
mobile Chrome and mobile Safari, with the exhaustive accessibility matrix,
nightly on main, on demand, and before every release on the tagged commit.
An engine-specific regression may reach main and be caught nightly or before
release; this is an accepted coverage tradeoff. Both workflows use the same
pinned Playwright container. State any local coverage limits in your pull request.

To run the fast browser coverage locally after building:

```sh
PASSGEN_E2E_MODE=pr pnpm test:e2e
```

Leave `PASSGEN_E2E_MODE` unset for the full suite. `pnpm check` keeps full local
coverage by default.

On a supported system, run `pnpm exec playwright install --with-deps` to install
the browsers and system libraries, then run `pnpm check` with
`PASSGEN_E2E_PROJECTS` unset. Alternatively, run those checks inside the exact
Playwright container image, including its digest, in
[the full-suite workflow](.github/workflows/full-suite.yml), using the pinned Node and pnpm
versions and a frozen-lockfile install there too.
CI runs the pinned image with `--user 1001 --ipc=host --init` and installs Node via `setup-node`.

## Branches and pull requests

Fork the repository, create a topic branch from `main`, make your change and run
`pnpm check`. Open a pull request describing the change and how you checked it.
Every change needs green CI and review before merge; do not merge your own pull
request, push directly to `main` or force-push.

Use conventional commit messages and pull request titles: `type(scope): summary`,
such as `docs(styles): clarify token rules`. Types are `feat`, `fix`, `docs`,
`test`, `refactor`, `perf`, `build`, `ci`, `chore` and `security`.

## Conventions

[AGENTS.md](AGENTS.md) has the full rule list. Key conventions:

- No tool, AI, model or vendor attribution in commits, pull request text, code,
  docs or the site, including co-author trailers. CI enforces this.
- No runtime dependencies. Pin development dependencies to exact versions,
  explain additions in the pull request and preserve the supply-chain settings.
- Keep asset paths relative and hostnames and hosting providers out of the build.
- Keep the CSP strict: no inline code, network requests, `eval` or HTML sinks.
  Build DOM with `createElement` and `textContent`.
- Change security headers only in `security/headers.ts`, then run
  `pnpm headers:gen` and include the generated snippets.
- Use only `crypto.getRandomValues` with unbiased selection. Never put generated
  values in storage, URLs, history, console output or errors; mark output elements
  with `data-generated`.

Call out changes to randomness, selection, entropy, headers, CSP injection,
dependencies or CI: these require an independent security review before merge.

For styles, follow the [style guide](src/styles/README.md). Styles contribute
design tokens, with no external resources, and must pass both-theme contrast
checks and the full checks above.
