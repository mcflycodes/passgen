# PassGen repository guide for agents

This file governs code work in this repository and its worktrees. The product
requirements, decision records and roadmap live in the owner's planning
workspace, not here; your brief names the ones that apply to your task.

## What this is

A client-side-only password and passphrase generator, shipped as a folder of
static files that must work on any static host, at any domain or subpath.
Plain TypeScript and Vite, no UI framework, no runtime dependencies.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `src/` | The page and its code. Everything here ships to users. |
| `public/` | Static files copied into the build as they are. |
| `security/headers.ts` | The one definition of the security headers and CSP. High-risk. |
| `scripts/` | Build, verification and supply-chain scripts, run with Node's built-in TypeScript support. |
| `tests/unit/` | Node test runner tests (`*.test.ts`). |
| `tests/e2e/` | Playwright and axe tests, run against the built files in `dist/`. |
| `deploy/examples/` | Reference server configs, generated from `security/headers.ts`. Never edit by hand. |
| `.github/workflows/` | CI. Every third-party action is pinned to a full commit SHA. |

## Gates

Run `pnpm check` before every commit you intend to push. It runs every local gate
in order and must pass:

```sh
pnpm install --frozen-lockfile
pnpm check
```

The individual gates are listed in `README.md`. PR and main CI run desktop
Chromium, Firefox and WebKit functional tests, the accessibility matrix in
Chromium, and one matrix smoke case in each other engine. Full five-project
coverage and the exhaustive accessibility matrix run nightly and before releases.
Known documentation-only changes skip browser and server-config checks only;
`CI result` and `No attribution` are the required checks. Local `pnpm check`
retains full coverage by default; `PASSGEN_E2E_MODE=pr pnpm test:e2e` selects
fast coverage. If your machine cannot launch every browser engine, use
`PASSGEN_E2E_PROJECTS=chromium,mobile-chrome pnpm check` locally and say so in
your report. Never weaken or skip a gate to make it pass.

## Rules

- **No attribution.** Nothing in this repository may credit a tool, model,
  assistant or vendor for writing it: no co-author trailers, "generated with"
  notes, footers, comments or page text. This covers commit messages, pull
  request titles and bodies, code, docs and the site. `pnpm attribution:check`
  and CI enforce it.
- **Conventional commits.** Commit messages and pull request titles use
  `type(scope): summary`, e.g. `feat(passphrase): add separator picker` or
  `fix(headers): restore frame-ancestors`. Types: `feat`, `fix`, `docs`,
  `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `security`.
- **No runtime dependencies.** `dependencies` in `package.json` stays absent.
  Dev dependencies are pinned to exact versions; never add `^` or `~`.
- **Supply chain.** Keep the settings in `pnpm-workspace.yaml`: exact saves,
  strict engines, a 7-day minimum release age, and install scripts blocked for
  every package. A new dev dependency needs a reason in the pull request.
- **No hostnames.** Nothing in the build may name a domain, URL, address or
  hosting provider. Asset paths stay relative. `pnpm verify:dist` enforces it.
  The only exception is the two links the configuration declares
  (`links.repoUrl`, `links.licenseUrl`), accepted exactly as configured, as an
  anchor's `href` and as the configuration string in the bundle.
- **CSP.** No inline script, inline style, event-handler attributes, `eval`,
  or network requests. Same-origin files only. Trusted Types are enforced, so
  build DOM with `createElement` and `textContent`, never `innerHTML`.
- **Headers in one place.** Change headers and the CSP only in
  `security/headers.ts`, then run `pnpm headers:gen` and commit the result.
- **Randomness.** All randomness comes from `crypto.getRandomValues`, selected
  without modulo bias. Never `Math.random`.
- **Generated values never leave the tab**: not in storage, URLs, history,
  console output or error messages.
- **Mark generated output.** Every element the app fills with a generated
  password or passphrase carries `data-generated`. The browser host-name
  check skips those elements, since random output can look like a host
  (`9Qa.com#…`); the attribution check does not.
- **Never** push to `main`, force-push, or merge your own pull request.

## High-risk areas

Changes to randomness, character or word selection, entropy calculation,
`security/headers.ts`, the CSP injection in `vite.config.ts`, the dependency
set, or CI need an independent security review before merge. Say in the pull
request which of these your change touches.
