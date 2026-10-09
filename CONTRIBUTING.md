# Contributing

Bug fixes, tests and new styles are welcome. Keep changes focused so they are
easy to review. Report vulnerabilities using [the security policy](SECURITY.md).

## Setup and checks

Use Node.js **22.23.2** (`.nvmrc`) and pnpm **11.15.1** (`package.json`).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install
pnpm check
```

`pnpm dev` starts the development server. `pnpm check` runs every local gate;
the [README](README.md#gates) lists them.

### Browser coverage

Local runs may cover only Chromium when the machine lacks Playwright's Firefox
or WebKit system libraries. Select that coverage explicitly:

```sh
PASSGEN_E2E_PROJECTS=chromium,mobile-chrome pnpm check
```

CI runs all five projects (Chromium, Firefox, WebKit, mobile Chrome and mobile
Safari) in the pinned Playwright container and is the source of truth for browser
coverage. State any local coverage limits in your pull request.

On a supported system, run `pnpm exec playwright install --with-deps` to install
the browsers and system libraries, then run `pnpm check` with
`PASSGEN_E2E_PROJECTS` unset. Alternatively, run those checks inside the exact
Playwright container image, including its digest, in
[the CI workflow](.github/workflows/ci.yml), using the pinned Node and pnpm
versions and a frozen-lockfile install there too.

## Branches and pull requests

Fork the repository, create a topic branch from `main`, make your change and run
`pnpm check`. Open a pull request describing the change and how you checked it.
Every change needs green CI and review before merge; do not merge your own pull
request, push directly to `main` or force-push.

Use conventional commit messages and pull request titles: `type(scope): summary`,
such as `docs(styles): clarify token rules`. Types are `feat`, `fix`, `docs`,
`test`, `refactor`, `perf`, `build`, `ci`, `chore` and `security`.

## Conventions

Follow [AGENTS.md](AGENTS.md), including these rules:

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
