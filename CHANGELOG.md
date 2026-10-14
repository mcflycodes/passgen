# Changelog

All notable changes to PassGen are documented here, following Keep a Changelog.
Versions follow Semantic Versioning.

## [Unreleased]

## [1.5.2] - 2026-10-14

Version 1.5.1 was tagged but never published; this release contains all of its changes.

### Changed

- "Save as my default" and "Reset to defaults" are now in the header, at its right end, so saving no longer means scrolling to the bottom. A press confirms on the pressed button, which is highlighted and briefly reads Saved, Cleared or Failed, and screen readers hear the full message once. The explanation of what Save keeps is read with both buttons and shown as their tooltip. Below 1024px wide the buttons read Save and Reset, keeping their full names for assistive technology.
- The header reads, after the PassGen name: the Style control, the System/Light/Dark switch, a thin separator line, then Save and Reset. The GitHub link moved from the header to the footer.
- The header stays pinned at the top at every width, down to the 320px minimum the page supports with no horizontal scrolling. Below 900px it is one compact row: the name, an Appearance button that opens the Style and theme controls as a panel (Escape closes it and puts focus back on the button; a click outside also closes it), the separator, Save and Reset. Controls reached with the keyboard always scroll clear of it. A viewport under 400px tall, such as a phone on its side or 400% zoom, leaves the header in normal flow so it does not take a large share of the height.
- The footer is laid out in columns. From 1200px wide: the privacy line on the left, `vX.Y.Z · Apache-2.0 · Credits · GitHub` in the middle, both centred against the Settings code box on the right. From 901px: the privacy and meta lines stacked on the left, the Settings code box on the right. At 900px and below they stack, in the same order as they are read and reached with the keyboard: privacy, meta, Settings code. Credits still opens a full-width panel below, now starting at the footer's left edge.
- The settings code is always shown, in its own box at the bottom of the page: the code for the current settings updates as they change, with a Copy button, and while a setting is marked with an error the box says "Fix the marked settings to get a code" and Copy is disabled. The space for the code is reserved, so the box does not change size as the code gets longer or shorter. "Apply settings code" now reads Apply on screen, keeping its full name for assistive technology.
- Documentation: the Docker page, `docs/Install-Docker.md`, now follows a scannable image-page layout: supported architectures and tags, setup behind HTTPS, read-only and non-root operation, matching Compose and `docker run` examples, a parameters reference, support commands, and step-by-step updates for Compose and `docker run` with digest pinning, provenance checks and update notifications. `docs/docker.md` now covers the release-file recipes and what CI tests.

### Removed

- The Save and Reset buttons at the bottom of the page; the header's are the only ones.
- The "Get settings code" button, since the code is always shown.

### Fixed

- The Settings code box has the same rounded corners as the generator cards in every style; in Purple it was drawn as a pill.
- In Safari and other WebKit browsers, a control reached with Tab or Shift+Tab is no longer left hidden under the pinned header, even briefly.

## [1.5.0] - 2026-10-12

### Added

- Settings codes. "Get settings code", below the Save and Reset buttons, shows a short code for every setting of both generators, the theme and the style; "Apply settings code" in another browser sets the same settings there at once, with no server, account or network request. PassGen's shipped defaults give `PG1-ZW`, and other codes stay short because a code lists only the settings that differ from those shipped defaults. Case, spaces and hyphens do not matter when typing a code; I and L are read as 1, and O as 0. Its two check characters detect every single-character substitution and adjacent transposition that changes the normalized code, and most other typos. A code holds settings only, never a password, and is never put in the URL. Applying a code does not save it; press Save as my default to keep it. An invalid code, a code using an unsupported format or field, or one asking for settings the page does not offer is refused with a message and changes no settings.

### Changed

- Documentation: the README is now a short landing page. Each install method, configuration, styles, word lists and security headers have their own page under `docs/`, listed on `docs/README.md`, and the gates table moved to `CONTRIBUTING.md`. The by-hand install keeps each release's file list next to the site folder and checks files against it on update and rollback, and the Apache, nginx and Caddy pages back up the files they change and restore them on rollback.

## [1.4.1] - 2026-10-11

### Fixed

- At default settings the password and passphrase result boxes are the same height, so the two cards line up when they sit side by side from 901px wide.
- Open Credits entries are right-aligned under the toggle, and their separators and word counts no longer wrap awkwardly on phones.
- Site configuration checks now validate passphrase strength at default settings for every offered word list, requiring at least 80 bits and the configured Strong threshold.

### Changed

- Tighter spacing between the result box and the strength meter, and between the crack-time line and Other attack scenarios.
- Strength warnings now appear below the quantum line, in space both cards reserve, and settings notices appear below the settings. This reduces how far the controls move when settings change; very long results can still grow the result box.

## [1.4.0] - 2026-10-11

### Added

- This release first publishes the official container image at `ghcr.io/mcflycodes/passgen`. It serves the release files with nginx over HTTP on port 8080, runs as a non-root user, and supports a read-only root filesystem. Each release publishes `X.Y.Z`, `X.Y` and `latest` tags for amd64 and arm64, with a signed build provenance attestation for the image digest. It sends all nine security headers on every response and does not do HTTPS itself; put it behind an HTTPS reverse proxy.
- Docker Compose recipes in `deploy/compose/`: `caddy-https`, the recommended default with automatic HTTPS; `localhost`, which exposes the image only on `127.0.0.1:8080` for an existing proxy; and `caddy-files` and `httpd-files`, which serve verified release files with the official Caddy or Apache httpd image. The recipes use digest-pinned images and read-only root filesystems.
- A Docker guide covers choosing a recipe, verifying and pinning images by digest, updates, rollback and container security settings. A companion HTTPS guide covers Caddy, Traefik, nginx with Certbot, Cloudflare Tunnel and existing Apache or nginx proxies.

### Fixed

- The open Credits panel spans the full footer width and wraps text between words instead of breaking ordinary words across lines.

## [1.3.1] - 2026-10-10

### Changed

- Simplified manual deployment and updates in the README; detailed checks and rollback procedures are in the self-hosting guide.

### Added

- Release archives and checksums also have stable `passgen.zip` and `passgen.zip.sha256` download names.

## [1.3.0] - 2026-10-10

### Added

- You can choose among Orchard Street Long and Medium, EFF Large, and EFF Short #1 and #2 word lists.
- Word-length limits and strength estimates reflect the selected list. Saved defaults keep your list choice; Reset restores the deployment defaults.
- Site hosts can choose which lists to offer, the default list and each list's default word-length range. The picker is hidden when only one list is offered.
- Credits in the footer show each offered list's author, license, source and usable word count.
- Bundled word lists are checked against pinned fingerprints and expected word-length distributions during builds. Automated tests check unambiguous decoding without separators for every supported word-length range.

### Changed

- Orchard Street Long is now the default word list, with a default range of 5–10 letters per word.
- Saved settings use a new schema; settings saved by 1.2.x are ignored on load and removed on save or reset.

## [1.2.2] - 2026-10-10

### Fixed

- The default intro paragraph fits on one line on wide screens and still wraps naturally on phones.
- Strength text and warnings reserve space to reduce layout shifts as settings change; result boxes reserve room for typical passwords and passphrases and grow for longer results.

## [1.2.1] - 2026-10-10

### Added

- Passphrases can exclude look-alike separator symbols while keeping words and numbers unchanged.

### Changed

- The header repository link is an accessible GitHub mark icon.
- Style and theme controls match the header tagline typography in every style.
- Saved settings use a new schema; settings saved by 1.2.0 are ignored on load and removed on save or reset.

## [1.2.0] - 2026-10-09

### Added

- Passphrases offer symbol position (Both sides, Before, After), number lengths
  from 1–3 digits, and capitalization modes Off, Random, and Every word.
- Random (unique) uses each symbol before repeating, with even reuse when
  needed and a short note when repeats become unavoidable.

### Changed

- Passphrase symbols default to Random, which chooses every slot independently.
  Strength estimates count the exact spaces for all separator and case options.
- Saved settings use a new schema; older saved settings are ignored on load
  and removed when saving or resetting defaults.

## [1.1.1] - 2026-10-09

### Fixed

- The installer now stamps installed files with the install time and gives
  restored files a newer timestamp on rollback, helping browsers and CDNs
  revalidate changed pages. Manual deployment instructions now check for
  symbolic links and then safely refresh timestamps before publishing.

## [1.1.0] - 2026-10-09

### Added

- Passphrase separators can now use a random simple symbol for each word gap,
  with an option to keep every gap's symbol different. Number separators keep
  the same symbol on both sides. The strength estimate includes these choices.
- Passwords now avoid starting with a symbol by default. Turn this off if needed.
  If your other settings require only symbols, this option is skipped with a
  note. Passwords remain equally likely within your settings, and the strength
  estimate includes the first-character rule.
- A source repository link beside the Style control, plus the version
  and an "Apache-2.0" license link in the footer. Both URLs come from the
  configuration (`links.repoUrl`, `links.licenseUrl`), must be `https`, and
  can be left empty to hide a link.
- Step-by-step deployment guides, and setup instructions you can hand to your
  AI agent (`agent-setup/prompt.md`).

### Changed

- Saving settings is now explicit. "Save as my default" saves every setting of
  both generators, the theme and the style once; "Reset to defaults" removes the
  saved settings and restores the defaults. Changes made after saving are not
  saved unless Save is pressed again. Successful saves and resets show a short
  confirmation, announced to screen readers, and a highlight that fades out,
  or simply ends under reduced motion. Changing controls does not write settings
  to the browser.

### Removed

- The "Save current settings as default" checkbox and the `saveSettings`
  configuration key. Saved settings from 1.0.0 are ignored; Save and Reset remove
  the old record.

## [1.0.0]

### Added

- Generate random passwords and word-based passphrases entirely in your browser.
  Generated values never leave the tab or enter saved settings.
- Choose password length, character types and per-type minimum and maximum
  counts, with optional look-alike exclusion.
- Customize passphrase word count, word lengths, capitalization and separators.
- See a strength meter with entropy and attack assumptions. Crack-time estimates
  respect hash-output caps.
- Generate extra results and copy each with its own copy button.
- Save settings locally in this browser; generated values are never stored.
- Choose Calm, Payload, Slate, Green or Purple styles with light, dark or system
  appearance.
- Build from a validated configuration to customize defaults, limits and text.
- Serve a static site on any domain or subpath, protected by a strict Content
  Security Policy and reference security headers.
- Check deployments against a SHA-256 build manifest with verify-live, including
  response headers and, when locally available, the exact deployed file set.
- Support WCAG 2.2 AA accessibility with keyboard operation, visible focus,
  contrast checks and accessible controls.
- Install a release onto a Linux web server with one command. The installer
  verifies the release against its checksums, backs up the current site and
  attempts to restore it automatically if the installation fails.
- Download each release as a site zip with its SHA-256 manifest.
- Start from example Apache, nginx and Caddy configurations, which CI tests
  against real servers on every change.
- Report vulnerabilities privately; see SECURITY.md. CONTRIBUTING.md describes
  how to build and test PassGen.
