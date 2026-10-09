# PassGen

A no-nonsense password and passphrase generator. Open the page, a strong password
is already there, copy it, done. Everything happens in your browser: no accounts,
no tracking, no third-party code, and no network requests after the page loads.

PassGen is a folder of static files. It works on any ordinary static web server, at
any domain or subpath, with no hosting provider, CDN or domain required.

**Status:** v1 is released, with both generators, strength estimates, extra
results, saved settings, and five visual styles. See `CHANGELOG.md` for what
has changed since.

## Deploy

### A. Let your AI agent do it

Copy this prompt into your AI agent:

> Fetch and follow the instructions at https://raw.githubusercontent.com/mcflycodes/passgen/main/agent-setup/prompt.md to set up PassGen for me.

It will ask about your server and show you the commands for approval before making
changes. You can also paste [the instructions](agent-setup/prompt.md) if it cannot
fetch the URL. To install it yourself, choose B or C below.

### Before you start

You need a static web server, a domain with HTTPS already working, and shell
access with permission to write the site's files and configure the server.
Use a hostname dedicated to PassGen: other pages on the same origin could read
its generated passwords. See [why this matters](docs/self-hosting.md#before-you-start).
For a managed static host without shell access, use the
[static-host guide](docs/self-hosting.md#any-static-host).

The commands below are for Linux. Replace `1.0.0`, `/srv/passgen` and
`https://example.com/` with your release number, web root (the folder your server
publishes), and URL. Keep downloads and source code outside that web root.
The repository is public; `curl` downloads need no GitHub login.
Stop if any command fails, except `diff` returning 1 to report expected differences.

Use only the row for your server when a step says validate or reload. Config
paths vary by OS; these are the paths in the shipped examples. Always validate
successfully before reloading.

| Server | Validate configuration | Graceful reload |
|---|---|---|
| Apache | `sudo apachectl configtest` | `sudo apachectl graceful` |
| nginx | `sudo nginx -t` | `sudo nginx -s reload` |
| Caddy | `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | `sudo caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` |

### B. Automated install

1. Set the release number. Pick it from
   [GitHub Releases](https://github.com/mcflycodes/passgen/releases).

   ```sh
   VERSION=1.0.0
   ```

2. Download that release's source into a fresh folder outside the web root.

   ```sh
   git clone --depth 1 --branch "v$VERSION" https://github.com/mcflycodes/passgen.git "passgen-setup-$VERSION"
   ```

3. Open that folder.

   ```sh
   cd "passgen-setup-$VERSION"
   ```

4. Configure your dedicated site using the ready-made
   [Apache, nginx or Caddy config and header file](deploy/examples/README.md).
   Follow your server's [setup steps](docs/self-hosting.md#server-setup): back up
   any config you change, replace the hostname, web root and certificate paths,
   and keep the header values exactly as shipped. The installer only handles files.

5. Validate the server configuration using your row in the table above.

6. Gracefully reload the server using your row in the table above.

7. Install the release. This verifies the ZIP and every payload file, backs up
   the current web root, and replaces its contents. Default permissions let the
   server read the files; with `sudo`, new files belong to root.

   ```sh
   sudo scripts/install-release.sh --version "v$VERSION" --docroot /srv/passgen
   ```

   **Optional variant:** Instead of the command above, check the live files and
   header names during the install. A mismatch triggers an attempted rollback.
   Configure headers and clear stale CDN caches first; this does not check exact
   header values.

   ```sh
   sudo scripts/install-release.sh --version "v$VERSION" --docroot /srv/passgen --url https://example.com/
   ```

   Save the printed backup path. See [requirements and ownership options](docs/install-release.md#requirements)
   for missing tools or different permissions, and
   [administrator notes](docs/install-release.md#notes-for-administrators) for SELinux labeling.
   The installer downloads anonymously with `curl` unless authenticated `gh` is available.

8. **Optional:** Download the manifest for the fuller live check.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/SHA256SUMS"
   ```

   **Optional alternative:** Use `gh release download "v$VERSION" --repo mcflycodes/passgen --pattern SHA256SUMS` instead.

9. **Optional:** Run the live check. Node **22.18 or newer** is needed; prefer the
   release's pinned version in `.nvmrc`. No dependency installation is needed.

   ```sh
   node scripts/verify-live.ts --url https://example.com/ --manifest SHA256SUMS --release-dir /srv/passgen
   ```

### C. Manual install

1. Set the release number.

   ```sh
   VERSION=1.0.0
   ```

2. Download that release's source into a fresh folder outside the web root.

   ```sh
   git clone --depth 1 --branch "v$VERSION" https://github.com/mcflycodes/passgen.git "passgen-setup-$VERSION"
   ```

3. Open that folder.

   ```sh
   cd "passgen-setup-$VERSION"
   ```

4. Download the release ZIP. It contains the finished site; no build is needed.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/passgen-$VERSION.zip"
   ```

   **Optional alternative to steps 4–6:** Download all three assets with `gh`:

   ```sh
   gh release download "v$VERSION" --repo mcflycodes/passgen \
     --pattern "passgen-$VERSION.zip" --pattern "passgen-$VERSION.zip.sha256" --pattern SHA256SUMS
   ```

5. Download the ZIP checksum.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/passgen-$VERSION.zip.sha256"
   ```

6. Download the file manifest. Keep it outside the public root for later checks.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/SHA256SUMS"
   ```

7. **Optional, recommended:** Verify the ZIP checksum. Continue only if it says `OK`.

   ```sh
   sha256sum -c "passgen-$VERSION.zip.sha256"
   ```

8. Unzip into a fresh staging folder outside the public root, on the web root's
   filesystem. This keeps incomplete files away from visitors.

   ```sh
   sudo unzip "passgen-$VERSION.zip" -d "/srv/passgen-staging-$VERSION"
   sudo find "/srv/passgen-staging-$VERSION" -exec touch {} +
   ```

   Refreshing timestamps prevents the reproducible ZIP’s 1980 dates from making
   browsers and CDNs keep an older page.

9. **Optional, recommended:** Verify the staged files before publishing.

   ```sh
   (cd "/srv/passgen-staging-$VERSION" && sha256sum -c -) < SHA256SUMS
   ```

10. Give the server read access; only the owner can write.

    ```sh
    sudo chmod -R u=rwX,go=rX "/srv/passgen-staging-$VERSION"
    ```

11. Move staging into place. `/srv/passgen` must not exist; use the update steps
    below if a release is already installed. `-T` prevents nesting in an existing folder.

    ```sh
    sudo mv -T "/srv/passgen-staging-$VERSION" /srv/passgen
    ```

12. **If SELinux is enforcing:** Set up the correct labels before serving.
    On RHEL/AlmaLinux, a new directory under `/srv` defaults to a label unsuitable
    for web content, so httpd returns 403; moving files also preserves old labels.
    See [Notes for administrators](docs/install-release.md#notes-for-administrators)
    and [Red Hat's labeling procedure](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/selinux_users_and_administrators_guide/sect-security-enhanced_linux-working_with_selinux-selinux_contexts_labeling_files).
    For this web root, add the persistent rule once (if absent):

    ```sh
    sudo semanage fcontext -a -t httpd_sys_content_t '/srv/passgen(/.*)?'
    ```

13. **If SELinux is enforcing:** Apply that rule. Repeat this after each install,
    manual update or rollback; do not disable SELinux.

    ```sh
    sudo restorecon -R /srv/passgen
    ```

14. Add the ready-made [Apache, nginx or Caddy config and header file](deploy/examples/README.md)
    using your server's [setup steps](docs/self-hosting.md#server-setup).
    Back up any config you change, replace the hostname, web root and certificate
    paths, and keep every security header, including the CSP, exactly as shipped.

15. Validate configuration using your server's row in the table above.

16. Gracefully reload using your server's row in the table above.

17. **Optional:** Run the live check from this source folder. Node **22.18 or newer**
    is needed; prefer the release's pinned `.nvmrc` version. No dependencies are needed.

    ```sh
    node scripts/verify-live.ts --url https://example.com/ --manifest SHA256SUMS --release-dir /srv/passgen
    ```

**Optional:** If a CDN sits in front of your server, restrict direct access to the
origin using the [CDN-only setup](docs/self-hosting.md#optional-raw-peer-restrictions).
Review [CDN settings](docs/self-hosting.md#cdn-and-proxy-settings) to prevent script
injection or file rewriting, and check the public URL after any cache purge.

### Updating to a new release

Start in the old `passgen-setup-<version>` source folder. Keep it and its
`SHA256SUMS` for rollback. Replace `X.Y.Z` with the new release number. Backup and
staging paths must be outside every public root and must not already exist.

1. Record the installed version.

   ```sh
   PREVIOUS=1.0.0
   ```

2. **If you skipped the earlier manifest download:** Save the previous release's
   manifest here before leaving its source folder.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$PREVIOUS/SHA256SUMS"
   ```

3. Set the new release number.

   ```sh
   VERSION=X.Y.Z
   ```

4. Go to the source folder's parent.

   ```sh
   cd ..
   ```

5. Clone the new tag into its own fresh folder.

   ```sh
   git clone --depth 1 --branch "v$VERSION" https://github.com/mcflycodes/passgen.git "passgen-setup-$VERSION"
   ```

6. Compare the shipped configs and headers. `diff` exit code 1 means they changed;
   review and apply those changes to your backed-up site config before reloading.

   ```sh
   diff -ru "passgen-setup-$PREVIOUS/deploy/examples" "passgen-setup-$VERSION/deploy/examples"
   ```

7. Open the new source folder. All following scripts and examples come from this tag.

   ```sh
   cd "passgen-setup-$VERSION"
   ```

8. Download the new ZIP.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/passgen-$VERSION.zip"
   ```

9. Download its ZIP checksum.

   ```sh
   curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/passgen-$VERSION.zip.sha256"
   ```

10. Download its new manifest. Never check the new release against the old manifest.

    ```sh
    curl --fail --location --remote-name "https://github.com/mcflycodes/passgen/releases/download/v$VERSION/SHA256SUMS"
    ```

11. Back up the PassGen server config you will change. Replace these two paths
    with your actual config and a new backup filename; repeat for each changed file.

    ```sh
    sudo cp -a /path/to/passgen-site.conf /path/to/passgen-site.conf.previous
    ```

12. Apply any config/header changes found in step 6 using this release's
    `deploy/examples/` and your existing hostname, paths and certificates.

13. **Automated:** Run the new tag's installer. It verifies the downloaded assets,
    backs up the old web root again, and keeps the newest three backups.
    Skip steps 14–20, then continue with SELinux labeling, validation and reload.

    ```sh
    sudo scripts/install-release.sh --version "v$VERSION" --docroot /srv/passgen --from-dir "$PWD"
    ```

14. **Manual:** Verify the ZIP checksum before extracting. Continue only on `OK`.

    ```sh
    sha256sum -c "passgen-$VERSION.zip.sha256"
    ```

15. **Manual:** Unzip the new release into fresh staging.

    ```sh
    sudo unzip "passgen-$VERSION.zip" -d "/srv/passgen-staging-$VERSION"
    sudo find "/srv/passgen-staging-$VERSION" -exec touch {} +
    ```

    Refreshing timestamps prevents browsers and CDNs from keeping the previous
    page after an update.

16. **Manual:** Verify staged files before switching.

    ```sh
    (cd "/srv/passgen-staging-$VERSION" && sha256sum -c -) < SHA256SUMS
    ```

17. **Manual:** Give the server read access to staging.

    ```sh
    sudo chmod -R u=rwX,go=rX "/srv/passgen-staging-$VERSION"
    ```

18. **Manual:** Set root ownership, so the server cannot write the new files.

    ```sh
    sudo chown -R root:root "/srv/passgen-staging-$VERSION"
    ```

19. **Manual:** Move the old web root to its backup. Visitors may see a brief
    interruption until the next step finishes.

    ```sh
    sudo mv -T /srv/passgen "/srv/passgen-backup-$PREVIOUS"
    ```

20. **Manual:** Move the verified staging folder into place.

    ```sh
    sudo mv -T "/srv/passgen-staging-$VERSION" /srv/passgen
    ```

21. **If SELinux is enforcing:** Reapply your existing web-content label rule.
    Automated-path (B) users: follow C12 first if you have not yet added the
    `semanage fcontext` rule.

    ```sh
    sudo restorecon -R /srv/passgen
    ```

22. Validate configuration using your server's row in the table above.

23. Gracefully reload using your server's row in the table above.

24. Check the new site using the new source folder and new manifest (Node 22.18+).

    ```sh
    node scripts/verify-live.ts --url https://example.com/ --manifest SHA256SUMS --release-dir /srv/passgen
    ```

### Rolling back

For a failed automated install, read its output: it attempts to restore and
verify its backup. If rollback was refused or unverified, stop and follow the
[exit-code guidance](docs/install-release.md#exit-codes). Do not copy from a
changed backup or through a replaced root.

To undo a successful update, start in the new source folder and use the previous
release number saved during updating. For the web-root directory moves/copies,
use destination paths that do not already exist.

1. Set the previous release number you want to restore.

   ```sh
   PREVIOUS=1.0.0
   ```

2. Set the release number being replaced (substitute its actual number).

   ```sh
   VERSION=X.Y.Z
   ```

3. **Automated:** Reinstall the previous tag. This re-verifies that release and
   backs up the current web root again; it does not restore server config.
   Skip steps 4–5, then continue with config restoration.

   ```sh
   sudo scripts/install-release.sh --version "v$PREVIOUS" --docroot /srv/passgen
   ```

4. **Manual (or automated backup fallback):** Move the current release aside.

   ```sh
   sudo mv -T /srv/passgen "/srv/passgen-failed-$VERSION"
   ```

5. **Manual:** Move the saved web root back into place.

   ```sh
   sudo find "/srv/passgen-backup-$PREVIOUS" -exec touch {} +
   sudo mv -T "/srv/passgen-backup-$PREVIOUS" /srv/passgen
   ```

   **Automated fallback:** Instead of the command above, copy from the backup
   printed by the update install (Updating step 13). Replace the placeholder with
   that backup's exact `docroot/` path.
   This fallback is for an intact backup and unchanged root, not a refused rollback.

   ```sh
   sudo cp -a /path/to/installer-backup/docroot /srv/passgen
   sudo find /srv/passgen -exec touch {} +
   ```

   Refresh restored timestamps so browsers and CDNs revalidate the restored
   page; wait until the next second if rolling back immediately after an install.

6. Restore each server config/header file changed during the update from its
   saved copy. Replace the paths with the pair used when you backed it up.

   ```sh
   sudo cp -a /path/to/passgen-site.conf.previous /path/to/passgen-site.conf
   ```

7. **If SELinux is enforcing:** Reapply the existing label rule.

   ```sh
   sudo restorecon -R /srv/passgen
   ```

8. Validate configuration using your server's row in the table above.

9. Gracefully reload using your server's row in the table above.

10. Return to the previous release's source folder.

    ```sh
    cd "../passgen-setup-$PREVIOUS"
    ```

11. Verify with its saved manifest (Node 22.18+).

    ```sh
    node scripts/verify-live.ts --url https://example.com/ --manifest SHA256SUMS --release-dir /srv/passgen
    ```

See [self-hosting](docs/self-hosting.md), the [installer reference](docs/install-release.md)
and [verification](docs/verify.md) for details.

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
| No hostname beyond the configured links, no provider file, inline code or CSS resource in the build; CSP meta in place | `pnpm verify:dist` |
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
defaults and bounds, the style options, the separator symbols and the two
outward links are inserted as escaped plain text and attribute values at build
time, with length caps checked by the validator and the result scanned by the
attribution and host-name checks. An empty tagline leaves the tagline out;
`text.intro.enabled: false` leaves the intro out; one offered style leaves the
Style control out. The footer also shows the version from `package.json`.

`links.repoUrl` is the repository link beside the Style control and
`links.licenseUrl` is the "Apache-2.0" link in the footer. Each is an `https`
URL, written in its normalised form with no credentials, or empty to leave
that link out. They render as plain anchors with `rel="noopener noreferrer"`,
cause no request, and are the only addresses the build may carry: the
host-name checks accept each one exactly as configured, as an anchor's `href`
and as the configuration string in the bundle, and nothing else.

Saved settings are explicit. "Save as my default" writes one snapshot of
every setting of both generators, the theme and the style to the browser's
local storage under one versioned key (`src/boot/storage.ts`); "Reset to
defaults" removes it and restores the configured defaults. A change made after
saving is not saved unless Save is pressed again, so a one-off tweak never
becomes the default. Each press is confirmed by a short status beside the
buttons, announced politely to screen readers, and a highlight on the button
that fades out (or simply ends under reduced motion). A stored record is
checked by `src/boot/stored-settings.ts` both before the first paint and when
the app starts, never includes a generated value, and is removed when it fails
the check. Nothing is written to storage until Save or Reset is pressed, not
even a probe; a browser whose storage cannot be read says so under the
buttons, and one that refuses the write says so when Save is pressed.

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
setting in one serialisable object and binds the Save and Reset buttons;
`src/ui/theme.ts` applies the theme and style choices; `src/ui/pointer.ts` is the shared pointer effect for decorative
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
`https://data.iana.org/TLD/tlds-alpha-by-domain.txt` when needed. The one
exception is the configured links (`links.repoUrl`, `links.licenseUrl`), which
may appear exactly as configured as an anchor's `href` in the page and as a
whole string in the bundle; written any other way, or anywhere else, they are
reported like any other address.

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
