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
