# Changelog

All notable changes to PassGen are documented here, following Keep a Changelog.
Versions follow Semantic Versioning.

## [Unreleased]

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
  restores it automatically if any check fails.
- Download each release as a site zip with its SHA-256 manifest.
- Start from example Apache, nginx and Caddy configurations, which CI tests
  against real servers on every change.
- Report vulnerabilities privately; see SECURITY.md. CONTRIBUTING.md describes
  how to build and test PassGen.
