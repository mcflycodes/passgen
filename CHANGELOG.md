# Changelog

All notable changes to PassGen are documented here, following Keep a Changelog.
Versions follow Semantic Versioning.

## [Unreleased]

### Added

- Passphrase separators can now use a random simple symbol for each word gap,
  with an option to keep every gap's symbol different. Number separators keep
  the same symbol on both sides. The strength estimate includes these choices.
- Passwords now avoid starting with a symbol by default. Turn this off if needed.
  If your other settings require only symbols, this option is skipped with a
  note. Passwords remain equally likely within your settings, and the strength
  estimate includes the first-character rule.

- Link to the source repository beside the Style control, and show the version
  and an "Apache-2.0" license link in the footer. Both URLs come from the
  configuration (`links.repoUrl`, `links.licenseUrl`), must be `https`, and
  can be left empty to hide a link.

### Changed

- Saving settings is now explicit. "Save as my default" saves every setting of
  both generators, the theme and the style once; "Reset to defaults" removes the
  saved settings and restores the defaults. Changes made after saving are not
  saved unless Save is pressed again. Each press shows a short confirmation,
  announced to screen readers, and a highlight that fades out, or simply ends
  under reduced motion. Nothing is written to the browser until Save or Reset
  is pressed.

### Removed

- The "Save current settings as default" checkbox and the `saveSettings`
  configuration key. Saved settings from 1.0.0 are discarded; Save and Reset remove the legacy record.

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
