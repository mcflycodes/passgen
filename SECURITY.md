# Security policy

## Supported versions

Security fixes target the latest 1.x release. Earlier releases are not supported.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open this repository's **Security**
tab and choose **Report a vulnerability**. Please include the affected version,
steps to reproduce and the impact. Keep vulnerability details out of public
issues and pull requests.

## Scope

We welcome reports about:

- Generation correctness, randomness and selection bias.
- Bypasses of the Content Security Policy (CSP) or reference security headers.
- Anything that makes the page send data.
- Storage leaks, especially generated passwords or passphrases.
- Build or release integrity.

Outside this project's scope:

- A host's own server or CDN misconfiguration.
- Compromised browsers, extensions or operating systems.
- Attackers with physical access or someone watching the screen.
- Clipboard history or managers accessing values after copy.
- A self-hosted copy someone modified.

## Security model

Everything runs client-side, with no runtime dependencies. Randomness comes only
from `crypto.getRandomValues`, never `Math.random`, with unbiased selection and
no fallback if Web Crypto fails. Generated values stay in the tab until the user
copies them; saved settings never include generated values.

A strict CSP permits same-origin scripts and styles, forbids inline code and
sets `connect-src 'none'`. The build embeds the supported CSP directives before
scripts; response headers supply additional protections, including framing
denial. See [self-hosting](docs/self-hosting.md) for the required headers and
the limits of a host that cannot set them.

The host-name checks (`pnpm verify:dist` on the build and the browser checks on
the rendered page) only see literal text. A host assembled at runtime would not
be seen. The CSP is the primary control against data being
sent; the scanners are a secondary check, not proof that code cannot send data.

The site must be served on its own origin, with no unrelated pages or scripts.
A subpath alone does not isolate it: other same-origin code could read generated
values and saved settings, and the CSP trusts scripts from that entire origin.

To check a deployment, rebuild from the reviewed source with the same
configuration, lockfile and pinned tool versions, or keep the manifest from the
reviewed build. `pnpm manifest` writes `dist-manifest/SHA256SUMS` for comparison
with deployed files; a different toolchain or configuration can change the bytes.
A separately trusted manifest checks integrity, not whether the source or host
is trustworthy. See [verification](docs/verify.md).
