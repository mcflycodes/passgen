# PassGen

A no-nonsense password and passphrase generator. Open the page, a strong password
is already there, copy it, done. Everything happens in your browser: no accounts,
no tracking, no third-party code, and no network requests after the page loads.

PassGen is a folder of static files. It works on any ordinary static web server, at
any domain or subpath, with no hosting provider, CDN or domain required.

**Status:** v1 is released, with both generators, strength estimates, extra
results, saved settings, and five visual styles.

## Deploy

Download the release ZIP, `SHA256SUMS` and the ZIP checksum from
[GitHub Releases](https://github.com/mcflycodes/passgen/releases). Verify the ZIP
checksum, unpack into an empty staging directory, then check its files against
`SHA256SUMS`. Promote those files into any static web root. Add the required
security headers using the ready-made Apache, nginx or Caddy configurations in
[`deploy/examples/`](deploy/examples/), then check the live site with
`verify-live` and the trusted manifest.

Follow the [step-by-step self-hosting guide](docs/self-hosting.md#deploy-from-a-release)
for downloads, commands and host requirements. Maintainers can follow
[the release procedure](docs/releasing.md).

## Requirements

- Node.js 22.23.2 (see `.nvmrc`)
- pnpm 11.15.1, pinned in `package.json` (`corepack enable` picks it up)
- Python 3 for release packaging and its unit tests

## Getting started

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install   # browsers for the end-to-end tests
pnpm check                     # every local gate; see below
```

Other commands:

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server (no meta CSP; the dev client needs inline script) |
| `pnpm build` | Production build into `dist/` |
| `pnpm serve` | Serve `dist/` on `http://127.0.0.1:4173/` with the reference security headers (a local test server, not for deployment) |
| `pnpm headers:gen` | Regenerate `deploy/examples/` after changing `security/headers.ts` |
| `pnpm format` | Apply formatting and safe lint fixes |

## Gates

`pnpm check` runs these in order and stops at the first failure. CI runs the same
gates on every pull request.

| Gate | Command |
|---|---|
| No runtime dependencies, exact pins, pnpm supply-chain settings | `pnpm deps:check` |
| No attribution to tools, models or vendors | `pnpm attribution:check` |
| No HTML sinks or executable/link attributes in shipped source | `pnpm html-sinks:check` |
| Authenticated EFF wordlist and emitted module match | `pnpm wordlist:check` |
| Typecheck (strict) | `pnpm typecheck` |
| Lint and format | `pnpm lint` |
| Unit tests | `pnpm test:unit` |
| Reference header snippets match the definition | `pnpm headers:check` |
| Style checks (R4b): tokens, contrast, CSS-only rules | `pnpm styles:check` |
| HTML-sink gate, configuration validation (C2) and style checks, then production build | `pnpm build` |
| No hostname, provider file, inline code or CSS resource in the build; CSP meta in place | `pnpm verify:dist` |
| SHA-256 manifest of the build | `pnpm manifest` |
| End-to-end, accessibility and header tests on the built files | `pnpm test:e2e` |
| Combined-gate regressions: injected fixtures through build, verify-dist and browser checks | `pnpm test:gate` |
| Dependency licenses | `pnpm licenses:check` |
| Dependency audit | `pnpm run audit` |

The end-to-end tests run on Chromium, Firefox and WebKit, plus mobile emulation.
On a machine that cannot launch every engine, narrow a local run explicitly, e.g.
`PASSGEN_E2E_PROJECTS=chromium,mobile-chrome pnpm check`. CI always runs all of them.

## Configuration

`src/config/config.json` holds product defaults and limits, the offered styles
and the page text. Import it as JSON; there is no runtime dependency.
`src/config/validate.ts` checks the schema and security invariants before Vite
builds and in unit tests. Invalid configuration stops the build before any
files are emitted. The combined gates prove this with invalid configuration
fixtures.

The build fills `index.html` from the configuration (`scripts/lib/page-template.ts`):
the header tagline, the optional intro headline and paragraph, the control
defaults and bounds, the style options and the separator symbols are inserted
as escaped plain text at build time, with length caps checked by the validator
and the result scanned by the attribution and host-name checks. An empty
tagline leaves the tagline out; `text.intro.enabled: false` leaves the intro
out; one offered style leaves the Style control out.

`saveSettings` is whether "Save current settings as default" starts checked
when nothing is stored. It is a per-visit default, not a remembered choice:
unchecking the box removes the stored settings, which is the only record there
is, so with `saveSettings: true` the next visit starts saving again. The
shipped value is `false`. Saved settings live in the browser's local storage
under one versioned key (`src/boot/storage.ts`), are checked by
`src/boot/stored-settings.ts` both before the first paint and when the app
starts, and never include a generated value. Nothing is written to storage
until the box is checked, not even a probe; a browser that refuses the first
write disables the box and says why.

Unspecified slow-hash and online attack estimates are `null`: consumers must
show them as unavailable, rather than substituting an estimate. The optional
future quantum estimate is also unavailable. The wordlist build computes the
pool size for the configured default filter
and checks that the defaults reach the configured Strong threshold (at least
80 bits). No derived word count is stored in configuration.

## Passwords

`src/core/password.ts` exposes `generatePassword`, `generatePasswords`,
`planPassword`, `normalizeCounts`, `countPasswords` and `defaultOptions`. Each
selected character type (lowercase, uppercase, numbers, symbols; Simple and
Complex symbols count as one type) has a Min and a Max count, with Min 1 and
Max equal to the length by default. Every password of the chosen length that
meets every limit is exactly equally likely: the number of characters of each
type is drawn in proportion to how many valid passwords have those counts,
using exact integer arithmetic and the unbiased randomness core, the type
labels are shuffled with Fisher-Yates, and each position is filled with a
uniform pick from its type. `countPasswords` gives the exact number of valid
passwords for a request, which the strength meter will take the entropy from.
Invalid requests raise typed errors before any randomness is drawn, and no
error carries generated output.

## Wordlist and passphrases

`vendor/eff_large_wordlist.txt` is the verbatim EFF Large Wordlist; its CC BY
license and credit are in `NOTICE`. The build verifies the pinned SHA-256,
7,776 raw entries and exactly four excluded hyphenated entries. The remaining
7,772 words must be unique lowercase ASCII words with lengths from 3 to 9.
`pnpm wordlist:gen` emits `src/core/wordlist.ts`; `pnpm wordlist:check` and every
production build require it to match the authenticated input exactly. These
steps read only local files and never fetch from the network.

`src/core/passphrase.ts` exposes `generatePassphrase`, `filteredWordCount` and
`defaultPassphraseOptions`. Each word is picked independently with replacement;
each separator digit and each optional capitalization bit use the unbiased
randomness core. Invalid options and empty pools raise typed errors without
returning output.

The attribution gate blanks only the explicitly reviewed collision words in
`DICTIONARY_COLLISIONS`, within authenticated data lines and the verified
word-data literal. Bundles apply the same limited exception to verified string
or constant template literals. Every other dictionary word and all surrounding
content remain scanned. Browser checks retain rendered `innerText`, validate
marked output before replacing it with a placeholder in that rendered scan,
and separately scan every output with only the allowlisted words blanked.
Attributes, comments, CSS content and non-output text remain scanned.

## Interface

`src/main.ts` wires the page. `src/ui/password.ts` and `src/ui/passphrase.ts`
bind the controls to the generators and turn each core error into a message
with generation disabled; `src/ui/settings.ts` holds every user-changeable
setting in one serialisable object; `src/ui/theme.ts` applies the theme and
style choices; `src/ui/pointer.ts` is the shared pointer effect for decorative
backgrounds; `src/ui/meter.ts` and `src/ui/results.ts` own the strength meter
and the extra-results markup.

The theme and style are applied before the first paint by a small classic
script, built from `src/boot/theme.ts` into `assets/boot-<hash>.js` and placed
in `<head>` before the stylesheet, so there is no inline script and the CSP is
unchanged. System follows `prefers-color-scheme` live through `color-scheme`
and `light-dark()` colours.

## Styles

A style is one stylesheet of design tokens under `src/styles/<id>/style.css`,
offered through `style.offered` in the configuration. The five shipped styles
are Calm (default), Payload, Slate, Green and Purple. `src/styles/README.md`
is the style guide: the token list, the rules every style must keep (tokens
only: custom properties in the style's own `:root[data-style]` rule, with no
ordinary property, other selector or at-rule; no external resource of any kind;
every required token for both themes, declared once along with everything a
colour token refers to; WCAG 2.2 AA contrast for the token pairs) and how to
test one. The checks judge the parsed, decoded CSS and its minified form; the
build runs them and fails on any problem, and `pnpm verify:dist` refuses any
resource in the emitted CSS.

## Security headers

`security/headers.ts` is the one definition of the page's security headers. From
it, the build puts the Content Security Policy in the page as a `<meta>` tag, so
the main protections hold even on a host that cannot set headers, and
`deploy/examples/` holds reference configs for Apache, nginx, Caddy, Cloudflare
Pages and Netlify. Those are examples only; none is required or preferred.

`pnpm serve` and the build checks are local tools. They refuse symbolic links
and anything outside the folder, but they assume nothing else on the machine
changes the folder while they run; that case is out of scope.

The build checks parse JavaScript with oxc and CSS with lightningcss (both part
of the Vite toolchain), check HTML against a byte-exact head structure, and
leave how the page actually parses to the browser tests. Host names are
recognised by their top-level domain, from a committed snapshot of IANA's list
in `scripts/lib/data/iana-tlds.txt`; refresh it from
`https://data.iana.org/TLD/tlds-alpha-by-domain.txt` when needed.

Each build also writes `dist-manifest/SHA256SUMS`, so anyone can check that a
deployed copy matches a reviewed build: run `sha256sum -c SHA256SUMS` inside the
served folder.

See [self-hosting](docs/self-hosting.md) for server setup and CDN settings, and
[build and deployment verification](docs/verify.md) for the S7 manifest checks.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and contribution guidelines.

## Security

See [SECURITY.md](SECURITY.md) for supported versions, private vulnerability
reporting and the security model.
