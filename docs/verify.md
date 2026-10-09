# Build and deployment verification (S7)

Compare deployed bytes with a build from reviewed source. Obtain the source tag
and manifest through a trusted channel separate from the site: a compromised
site can replace its own manifest. This checks integrity, not signatures, safe
source or continuous monitoring.

## Manifest format

Follow [the tagged build instructions](self-hosting.md#build-from-a-reviewed-tag),
then run `pnpm build`, `pnpm verify:dist` and `pnpm manifest`.
`scripts/manifest.ts` walks every regular file in `dist/`, rejects symlinks and
non-regular entries, sorts paths and writes `dist-manifest/SHA256SUMS` outside
the public root. The manifest does not hash itself. Each line has a lowercase
64-character SHA-256 digest, two spaces and a relative filename:

```text
<64 lowercase hex characters>  index.html
<64 lowercase hex characters>  assets/<fingerprinted filename>.js
```

These are format illustrations, not executable checksum entries. Real entries
are sorted by filename. Retain the reviewed commit, configuration, lockfile and
pinned tool versions alongside the manifest. Changed configuration produces a
different build requiring its own reviewed manifest; different toolchains may
also change bytes. Never regenerate the trusted manifest from suspect live files.

## Local checksum commands

Inside the actual served directory, with GNU coreutils:

```sh
cd /srv/passgen
sha256sum -c /path/to/trusted/SHA256SUMS
```

On macOS use `shasum -a 256 -c /path/to/trusted/SHA256SUMS`. Every file must report
`OK`. Missing and changed files fail. These commands do not detect extra files
or payload symlinks. Start from an empty directory and use `--release-dir` below
to check exact file-set equality and symlink refusal.

## Public deployment checks

Confirm that the entire origin serves only PassGen, including paths outside the
release directory. A subpath is safe only if nothing else on that host serves
pages or scripts. The verifier cannot establish origin isolation; its file-set
and header checks do not prevent same-origin pages from reading generated values
or accessing saved settings. See [Before you start](self-hosting.md#before-you-start).

Use scripts and manifest from the same reviewed revision. The dependency-free
verifier needs the pinned Node version. Use a canonical HTTPS URL (including
subpaths) with a trailing slash, without credentials, query or fragment. TLS
certificate validation stays enabled; redirects are refused.

```sh
node scripts/verify-live.ts \
  --url https://example.com/tools/passgen/ \
  --manifest dist-manifest/SHA256SUMS
```

If the actual release tree is locally mounted, add `--release-dir /srv/passgen`
for complete file-set and local hash checks. Do not point this at provider staging
folders containing additional `_headers` control files.

For local smoke tests, run `pnpm serve` in another terminal, then:

```sh
node scripts/verify-live.ts --url http://127.0.0.1:4173/ \
  --manifest dist-manifest/SHA256SUMS --release-dir dist --local-http
```

The HTTP exception only accepts loopback and does not test TLS. The verifier:

- Hashes decoded root HTML and every manifest file and checks all nine headers
  against `security/headers.ts`, including exact CSP. Duplicate/altered values fail.
- Requires HEAD success, a random missing path to return 404, POST/OPTIONS refusal
  with 403/405, and hidden/executable probe refusal with 403/404. Checks exact
  headers on these responses too.
- Probes manifest directories lacking an index for 403/404 and rejects obvious
  listing HTML. HTTP cannot enumerate arbitrary extra hidden/unlinked files;
  without `--release-dir` it reports that limit explicitly.
- With `--release-dir`, requires exactly the manifest's regular files and hashes,
  refusing extra files and symlinks.

Exit code 0 means those checks passed at that time; failures exit nonzero. The
local server deliberately uses `no-store`. The verifier does not validate cache
policy: independently inspect HTML `Cache-Control: no-cache`, fingerprinted asset
immutable caching, and non-immutable errors. Also check MIME types, permanent
HTTP-to-HTTPS redirect, certificate renewal, CDN cache hits and optional origin
restrictions using [the hosting guide](self-hosting.md).

For a manual single-file comparison, inside your own temporary working directory:

```sh
curl --fail --silent --show-error --compressed \
  https://example.com/tools/passgen/index.html -o downloaded-index.html
sha256sum downloaded-index.html
```

Compare the digest to the trusted `index.html` entry; remove the download after
checking. Do not compare an error page, redirect target or raw compressed bytes.

## Real server example checks

The `server-configs` CI job builds once without cache, renders the shipped
Apache, nginx and Caddy examples by substituting their documented placeholders,
and validates and probes digest-pinned official containers sequentially. It
checks GET and HEAD on every manifest file, exact header counts and values,
caching, method refusal, hidden/map paths, directories and 404s, then runs
`verify-live` with the same trusted manifest and local release directory.
Caddy's automatic HTTP redirect is checked too. Apache and nginx deliberately
leave the redirect listener to the operator; CI reports that unsupported probe.

The harness gives Apache inherited directory listing and conflicting response
headers, and nginx `autoindex on` and conflicting http-level `add_header`
defaults. nginx replaces an inherited header list when a child declares its own.
Before probing PassGen, a separate control vhost must return a directory listing,
`X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: unsafe-url`. CI logs first
confirm the hostile control is active, then confirm the example overrides it.
Caddy has no inherited browse setting: `file_server browse` belongs to a site's
handler route. Adding it to PassGen would alter or shadow the shipped example,
so CI reports that inherited-baseline test as unsupported for Caddy.

Dependabot does not update the server image digests stored in workflow
environment variables. CI pulls Docker Official Images from AWS ECR Public's
mirror at `public.ecr.aws/docker/library/` to avoid Docker Hub's anonymous pull
limit. To refresh the pins, look up each tag's current index digest on that
mirror:

```sh
docker buildx imagetools inspect public.ecr.aws/docker/library/httpd:2.4
docker buildx imagetools inspect public.ecr.aws/docker/library/nginx:stable
docker buildx imagetools inspect public.ecr.aws/docker/library/caddy:2
```

Use the top-level `Digest` from each result, replace the pinned digest in
`.github/workflows/ci.yml`, and open a reviewed PR. Require the workflow guard
and all three real-server checks to pass before merging.

Run the additional curl probes against any deployment (the manifest must include
the built favicon and fingerprinted assets):

```sh
node scripts/probe-server.ts --url https://example.com/ \
  --manifest dist-manifest/SHA256SUMS --redirect
```

Omit `--redirect` when testing only HTTPS. For a private CA, add
`--ca-file /path/to/ca.pem`; `--address 127.0.0.1` selects curl's `--resolve`
target without changing the TLS hostname. The existing live verifier uses Node's
standard CA environment variable, with certificate validation still enabled:

```sh
NODE_EXTRA_CA_CERTS=/path/to/ca.pem node scripts/verify-live.ts \
  --url https://example.com/ --manifest dist-manifest/SHA256SUMS --release-dir dist
```

## Mismatches

Stop promoting or using an unverified release until the difference is explained.
Wrong tags, partial uploads, stale caches, changed configuration, body rewriting,
analytics injection and tampering can all cause mismatches. Hashes cannot tell
which. Header failures indicate a policy mismatch even when bytes match; meta
CSP alone is not the complete baseline. A missing-path 200 often signals SPA
fallback, while successful POST or listing signals server misconfiguration.

Compare origin and public responses, disable rewriting, fix header inheritance,
purge stale caches, then redeploy the verified payload or roll back to the previous
verified release. Repeat full checks on ordinary responses and cache hits. Do not
weaken the verifier, delete failing entries or replace the trusted manifest with
hashes from the suspect deployment.
