# Security headers

PassGen relies on nine HTTP security headers and a strict Content Security
Policy. This page explains where they come from, what the build checks, and how
to confirm a deployed copy.

## One definition

`security/headers.ts` is the one definition of the page's security headers. From
it:

- the build puts the Content Security Policy in the page as a `<meta>` tag, so
  the main protections hold even on a host that cannot set headers; and
- `deploy/examples/` holds reference configs for Apache, nginx, Caddy, Cloudflare
  Pages and Netlify. Those are examples only; none is required or preferred.

To change a header, edit `security/headers.ts` and run `pnpm headers:gen`;
`pnpm headers:check` fails if the generated files drift from it. The
[generated table](../deploy/examples/README.md) lists every header and its exact
value, and [Required response headers](self-hosting.md#required-response-headers)
explains what each one protects and what is lost on a host without header
support.

To install them, see [Apache](Install-Apache.md), [nginx](Install-nginx.md),
[Caddy](Install-Caddy.md) or [Static hosts and CDNs](Static-hosts-and-CDNs.md).
The [Docker image](Install-Docker.md) sends them itself.

## Build checks

The build checks parse JavaScript with oxc and CSS with lightningcss (both part
of the Vite toolchain), check HTML against a byte-exact head structure, and
leave how the page actually parses to the browser tests.

Host names are recognised by their top-level domain, from a committed snapshot
of IANA's list in `scripts/lib/data/iana-tlds.txt`; refresh it from
`https://data.iana.org/TLD/tlds-alpha-by-domain.txt` when needed. The one
exceptions are the configured links (`links.repoUrl`, `links.licenseUrl`) and
the offered word lists' source/license links in the Credits section, which
may appear exactly as configured as an anchor's `href` in the page and as a
whole string in the bundle; written any other way, or anywhere else, they are
reported like any other address.

`pnpm serve` and the build checks are local tools. They refuse symbolic links
and anything outside the folder, but they assume nothing else on the machine
changes the folder while they run; that case is out of scope.

## Checking a deployed copy

Each build also writes `dist-manifest/SHA256SUMS`, so anyone can check that a
deployed copy matches a reviewed build: run `sha256sum -c SHA256SUMS` inside the
served folder. Releases publish the same file as `SHA256SUMS`.

[Build and deployment verification](verify.md) covers the S7 manifest checks and
the live checker, which compares the served files and the exact header values.
