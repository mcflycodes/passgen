# Self-hosting PassGen

PassGen generates passwords and passphrases entirely in the browser. Its build
is a folder of static files with no server code, API, account database or runtime
third-party services. Any static host can serve it at any domain or subpath,
provided the origin is dedicated to PassGen.
Use a trailing slash on subpath URLs so relative assets resolve correctly.
Saved defaults belong to the browser's origin; changing domains resets them.
Generated values are never saved.

## Before you start

PassGen needs an origin that serves nothing else. A subpath is safe only if
nothing else on that host serves pages or scripts. Use a dedicated hostname,
not a path alongside other applications, user uploads or unrelated content.
An origin is the scheme, hostname and port; paths do not isolate applications.

A hostile page or script on the same origin can open PassGen in another window
and read its generated values. COOP and frame-ancestors do not block a same-origin
opener, and the CSP trusts scripts from the entire origin. Saved settings are
also shared with everything on that origin.

## Build from a reviewed tag

Replace `<tag>` with a tag whose source you have reviewed and trust. The repository
is public. Use that tag's pinned Node (`.nvmrc`) and pnpm (`package.json`) versions:

```sh
git clone https://github.com/mcflycodes/passgen.git
cd passgen
git checkout --detach <tag>
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install
pnpm check
pnpm build
pnpm verify:dist
pnpm manifest
```

Keep the reviewed commit ID, configuration, lockfile, tool versions and
`dist-manifest/SHA256SUMS` with the release. Publish only `dist/`, not source,
`.git`, the manifest directory, configs or development tools. Build once and
promote the same bytes. See [verification](verify.md) before serving a release.

Use an empty release directory, check it, then switch releases atomically where
supported. Retain the previous verified release for rollback. Give the server
read-only access. Reject payload symlinks; a static root, particularly Caddy's,
is not a filesystem sandbox. Remove old files instead of overlaying releases.
Use HTTPS with a valid certificate, arrange renewal, and permanently redirect
HTTP to HTTPS.

## Deploy from a release

Choose a reviewed tag and download these three versioned assets from its public GitHub Release
into a working directory outside the web root. No GitHub login is required:

```sh
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip.sha256
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
```

Optional alternative with `gh`:

```sh
gh release download vX.Y.Z --repo mcflycodes/passgen \
  --pattern 'passgen-X.Y.Z.zip' --pattern 'passgen-X.Y.Z.zip.sha256' \
  --pattern SHA256SUMS
```

Replace `X.Y.Z` throughout with the selected version. Verify the ZIP before
unpacking it into a fresh staging directory, then verify every extracted file:

```sh
sha256sum -c passgen-X.Y.Z.zip.sha256
mkdir payload
unzip passgen-X.Y.Z.zip -d payload
(cd payload && sha256sum -c ../SHA256SUMS)
```

Continue only if every checksum says `OK`; otherwise, stop.

```sh
find -P payload -type l -print
```

If this prints anything, stop: the release contains a symbolic link. Do not continue.

```sh
find -P payload \( -type f -o -type d \) -exec touch -h -c {} +
```

Refreshing timestamps prevents the reproducible ZIP’s 1980 dates from making
browsers and CDNs keep an older page.

Every checksum must report `OK`. On macOS use `shasum -a 256 -c`. The archive
contains the site's files directly at its root. Keep both checksum files outside
the public root and obtain them separately from the deployed site.

Configure the dedicated static host using the required headers below and the
ready-made [Apache, nginx and Caddy examples](../deploy/examples/README.md).
Move the verified staging directory into a new release directory, give the
server read-only access, and switch the web root to it atomically where your
host supports that. Do not overlay an existing release. Retain the previous
verified directory so switching back rolls back the deployment. On every update,
refresh staging timestamps with the same `find` command before switching. For
rollback, first verify the previous directory against its trusted manifest,
then check for symlinks using the same checks above before running
`find -P "/path/to/previous-release" \( -type f -o -type d \) -exec touch -h -c {} +`
before switching back so caches revalidate the restored page; wait until the
next second if rolling back immediately after an install.

Check out source from the same reviewed tag to run its verifier with the pinned
Node version (`.nvmrc`); installing dependencies is unnecessary for this script.
The `--release-dir` path must name the real release directory, not a symlinked
web root. Replace the example URL and paths with your deployment and trusted manifest:

```sh
node scripts/verify-live.ts --url https://example.com/tools/passgen/ \
  --manifest /path/to/trusted/SHA256SUMS --release-dir /srv/passgen
```

This checks live bytes and headers as well as the complete local file set,
rejecting extra files and symlinks. If the release directory is not locally
mounted, omit `--release-dir`; remote verification cannot enumerate extra files.
See [verification](verify.md) for all checks and trust limits. A release ZIP uses
the shipped configuration; customize it by building from source instead.

### Stable download names

New releases also attach `passgen.zip` and `passgen.zip.sha256`; the ZIP is
byte-identical to the versioned archive. The README uses
`https://github.com/mcflycodes/passgen/releases/latest/download/passgen.zip`.
For checksum verification, resolve the latest release to its exact tag first
and fetch both aliases from that tag, so a new release cannot mix downloads:

```sh
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen.zip
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen.zip.sha256
sha256sum -c passgen.zip.sha256
```

Then use that tag's `SHA256SUMS` and staged-file verification above. Older
releases have only the three versioned assets. The installer and setup prompt
continue to use those versioned assets and an exact tag.

### Setup prompt

The [setup prompt](../agent-setup/prompt.md) asks about your server and presents
commands for approval before changing it. Paste those instructions if your agent
cannot fetch the raw URL linked from the README. It uses an exact release tag,
verified versioned assets and a rollback plan.

### Automated install

On a Linux host, `scripts/install-release.sh` performs the download, checksum
and manifest verification, backup, switch and post-install checks above in one
command, and restores the previous web root on its own if any step after the
backup fails:

```sh
scripts/install-release.sh --version vX.Y.Z --docroot /path/to/web/root \
    --url https://example.com/
```

It verifies the release before anything touches the web root, keeps the last
three backups next to it and, with `--url`, checks that the live site serves
the installed bytes with the nine security header names present. The web
server configuration below is still yours to do. See
[the installer reference](install-release.md) for the options, exit codes and
administrator notes.

## Required response headers

[`security/headers.ts`](../security/headers.ts) defines the exact policy once.
The [generated table and snippets](../deploy/examples/README.md) list its full
values. Set all nine headers once on files and errors, including 404 and method
refusals. Avoid duplicate policies.

| Header | What is lost without it |
|---|---|
| Content-Security-Policy | The HTTP policy, especially framing denial through `frame-ancestors 'none'`. The meta policy retains its supported directives. |
| Strict-Transport-Security | Browser enforcement of HTTPS-only access for two years, including this hostname's descendants. |
| X-Content-Type-Options | MIME sniffing prevention (`nosniff`). Correct MIME types still matter. |
| X-Frame-Options | `DENY` framing protection for clients without CSP framing support. |
| Referrer-Policy | Explicit `no-referrer`; browser defaults may send referrers. |
| Permissions-Policy | Explicit disabling of unused browser/device features; clipboard writing alone is allowed. |
| Cross-Origin-Opener-Policy | Separation from other origins' window/opener relationships. |
| Cross-Origin-Embedder-Policy | The `require-corp` embedding restriction and, with opener policy, cross-origin isolation. |
| Cross-Origin-Resource-Policy | Denial of other origins embedding these files in no-CORS mode. |

On a host without response-header support, **only the in-page CSP remains**.
It precedes scripts, restricts scripts and styles to the same origin, disallows inline
code, blocks connections (`connect-src 'none'`), and enforces its other supported
meta directives, including Trusted Types where implemented. It cannot supply
HSTS, framing denial or the other headers above. HTTPS alone does not replace
them. This deployment cannot pass full header verification; use header support
or an appropriate edge layer for the complete baseline.

The generated HSTS includes `includeSubDomains`, with no preload. Confirm all
descendants of the serving hostname support HTTPS. A parent-domain policy affects
its descendants and persists in browsers; do not enable parent-wide HSTS or
preload merely to serve this site.

## Server setup

Allow GET and HEAD only; refuse POST, OPTIONS and other methods with 403 or 405.
Disable directory listing, CGI/PHP, SSI, proxy handlers, aliases outside the root
and application fallback routing. Missing files must return 404, not the page
with 200. Serve HTML with `Cache-Control: no-cache` (revalidate before reuse).
Only fingerprinted assets may have `public, max-age=31536000, immutable`; keep
errors and other files revalidated. Preserve MIME types such as `text/html`,
`text/javascript` and `text/css`. Check cache hits as well as ordinary responses.

Full configs use `example.com`, `/srv/passgen` and placeholder certificate paths.
Replace them for your deployment. Put includes outside the public root. Review
existing shared listeners and inherited settings, validate before a graceful
reload, and keep the old configuration for rollback. These examples cannot undo
every directive inherited from a shared server.

With these examples, a symlinked release root fails closed: Apache returns 403
and nginx returns 404. Switch releases by renaming the directory, or change the
configured root (and Apache's containment expression) and validate/reload the
server; do not switch these examples through a symlink.

### Apache

Install [the site config](../deploy/examples/apache/passgen-site.conf) and
[header snippet](../deploy/examples/apache/passgen-headers.conf) at the shown
paths. Requires mod_ssl, mod_headers, mod_authz_core and mod_mime. Use an existing
TLS listener and set `ServerTokens Prod` globally. Run `apachectl configtest`
(or the distribution equivalent) before enabling the vhost.

The hardened pattern denies filesystem access outside the root, checks mapped
filename containment and Host, forces the static handler after handler merging,
refuses non-GET/HEAD methods, disables overrides/listing, and blocks hidden and
executable paths. Update both the Host expression and containment expression
when changing name or root. Publish regular files only: root and payload symlinks
are disabled. Review inherited Alias/ScriptAlias and shared modules for exposure
of other applications. Provide an HTTP redirect vhost if the edge does not do it.

### nginx

Include [the site config](../deploy/examples/nginx/passgen-site.conf) in `http {}`,
load the standard `mime.types` table there, and install
[the header snippet](../deploy/examples/nginx/passgen-headers.conf) at its stated
path. Supply certificate/key paths. Run `nginx -t` before enabling it.

Locations that set caching repeat the security include: nginx stops inheriting
`add_header` when a child declares its own. Explicit local errors prevent inherited
error routes from reaching another application. `try_files` has no SPA fallback;
GET permits HEAD, symlinks are disabled, and listing is off. Add an HTTP redirect
server if needed. Review other sites before changing the listener's default site.

### Caddy

Import [the site config](../deploy/examples/caddy/Caddyfile) into your Caddyfile
and install [the header snippet](../deploy/examples/caddy/passgen-headers.caddy)
at the shown path. The example supplies certificate/key paths; managed public
certificates are another option. Run
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` before reload.
Validation may read certificates and provision modules.

The ordered route refuses methods and hidden/executable paths before static
serving. Both normal and error routes include the security snippet; errors reset
caching. There is no browse or reverse proxy. Caddy follows symlinks, so payload
symlink rejection before publishing and read-only server permissions are essential.
Review automatic HTTPS redirect listeners when integrating with an existing host.

### Cloudflare Pages

Publish the static build without Functions or injected scripts. Copy
[Pages `_headers`](../deploy/examples/cloudflare-pages/_headers) into the publishing
folder after build, next to `index.html`. This provider config stays outside the
generic build/manifest. Check the actual served payload separately from a staging
directory containing provider controls. Prevent SPA fallback for missing paths:
Pages may require a top-level `404.html`. An added error page changes the payload
and needs its own reviewed manifest. Check error headers and method refusal at
the public edge; add edge rules if needed to meet the full contract. See the
[Pages header docs](https://developers.cloudflare.com/pages/configuration/headers/)
and [serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

### Netlify

Publish `dist/` without Functions, forms processing, snippet injection or an SPA
rewrite. Copy [Netlify `_headers`](../deploy/examples/netlify/_headers) into the
publishing folder after build. Like Pages, it is provider config outside the
payload manifest. Confirm the platform consumes it rather than serves it. Check
error headers and method refusal; add edge rules if defaults do not meet the contract.
See [Netlify header configuration](https://docs.netlify.com/manage/routing/headers/).

### Any static host

Upload the verified payload through the supported host workflow. Translate the
exact generated header table into response settings, configure caching/MIME types,
refuse writes and listing, and avoid catch-all routing. Hosts that cannot enforce
headers, errors or methods need an appropriate edge layer for the complete
baseline. Keep those settings separate from the product build and run
[verification](verify.md) against the final public URL.

## CDN and proxy settings

Turn **off** HTML rewriting, script injection, email obfuscation, HTML/JS/CSS
minification, Rocket-Loader-style script optimization, analytics/RUM injection,
font injection and other body-changing features. They change manifest hashes
and can break CSP; a same-origin injected script can pass `script-src 'self'`.
Avoid stale-page/offline snapshots, HTML cache TTL overrides, Cache Everything
and script challenges that replace the page. Compression is fine when decoded
bytes remain identical. Honor HTML no-cache and fingerprinted asset caching;
purge stale HTML on rollback and verify cache misses and hits.

For Cloudflare, use Full (strict) TLS with a valid, renewed origin certificate
and a permanent HTTPS redirect. See
[Full (strict) requirements](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/). Disable Rocket Loader, Email Address Obfuscation,
Zaraz, automatic Web Analytics/RUM injection, Always Online and legacy Auto Minify
where present. Ensure Workers, Snippets and Transform Rules do not change bodies.
Scope settings to this site where possible and verify their effective behavior
and edge error headers. Avoid zone-wide HSTS unless all affected descendants are
HTTPS-ready. Use strong account authentication and scoped deployment tokens.
These settings are optional deployment choices, not product dependencies.

Optionally restrict the origin to **your CDN's published ranges**, maintaining
IPv4 and IPv6 lists. Check the actual TCP peer, not a forged forwarded client-IP
header. If restoring client IPs for logs, trust that header only from those peers
and keep admission based on the original peer. Authenticated origin requests add
another control; a shared CDN certificate authenticates its network rather than
necessarily your account. Test direct-origin refusal separately: a timeout or
TLS error alone is not proof the rule works. Keep an administrative rollback path
when changing firewall rules.

### Optional raw-peer restrictions

Use your CDN's authoritative, published IPv4 and IPv6 range list, not addresses
from DNS or a copied historical list. For example, Cloudflare publishes its
[official range list](https://www.cloudflare.com/ips/); for another CDN, use that
provider's equivalent. Replace **every** `<CDN_IPV4_CIDR>` and
`<CDN_IPV6_CIDR>` below with current ranges and repeat entries for the full list;
these placeholders are deliberately not runnable. Keep admission fail-closed
while updating ranges and validate the resulting config before reload. Never
accept client-supplied forwarding headers as proof of a CDN peer. These snippets
assume a direct CDN-to-origin connection without PROXY protocol or another local
proxy replacing the peer identity; enforce the restriction at the first listener
that sees the actual CDN TCP peer if your topology has another hop.

**Apache:** insert this block inside the existing `<Location "/">`'s
`<RequireAll>`, alongside its Host, method and filename checks. Do not replace
those checks or add a separate granting Location that overrides them:

```apache
<RequireAny>
    Require expr "%{CONN_REMOTE_ADDR} -ipmatch '<CDN_IPV4_CIDR>'"
    Require expr "%{CONN_REMOTE_ADDR} -ipmatch '<CDN_IPV6_CIDR>'"
</RequireAny>
```

`CONN_REMOTE_ADDR` retains the connection peer even when mod_remoteip rewrites
`REMOTE_ADDR`. `Require expr "-R '...'"` is shorthand for matching `REMOTE_ADDR`,
so it cannot implement this raw-peer check after realip; use the explicit
`CONN_REMOTE_ADDR -ipmatch` expressions above. See
[Apache expressions](https://httpd.apache.org/docs/2.4/expr.html).

**nginx:** requires the standard http_realip module. Add these blocks in `http {}`
outside the site's `server {}`:

```nginx
geo $realip_remote_addr $passgen_peer_allowed {
    default 0;
    <CDN_IPV4_CIDR> 1;
    <CDN_IPV6_CIDR> 1;
}
map $passgen_peer_allowed $passgen_peer_denial_status {
    default 403;
    1       0;
}
```

Add this check inside the existing PassGen `server {}`, before file serving:

```nginx
if ($passgen_peer_denial_status) { return 403; }
```

Keep the example's generated-header include and local 403 error location.
`geo` evaluates `$realip_remote_addr`, the original peer, and the map turns all
unlisted peers into a 403 decision. Do not use `allow`/`deny` against rewritten
`$remote_addr` for origin admission. If enabling client-IP restoration for logs,
configure `set_real_ip_from` with only your CDN's ranges and its documented header;
that is separate from this peer check. See
[realip variables](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
and [geo address selection](https://nginx.org/en/docs/http/ngx_http_geo_module.html).

**Caddy:** add this named matcher in the existing site block:

```caddyfile
@outside_cdn not remote_ip <CDN_IPV4_CIDR> <CDN_IPV6_CIDR>
```

Inside its existing ordered `route`, after the generated-header import and
no-cache header, but before method checks or `file_server`, add:

```caddyfile
error @outside_cdn "Forbidden" 403
```

Retain the example's `handle_errors` route for exact headers and no-cache on the
403. `remote_ip` checks the immediate peer independently of HTTP forwarded-header
restoration through `trusted_proxies`; `client_ip` instead identifies the restored
client and must not be used for this restriction. See
[Caddy remote_ip](https://caddyserver.com/docs/caddyfile/matchers#remote-ip).

After enabling any of these snippets, verify normal CDN traffic and direct-origin
403 refusal, including a direct request with a forged client-IP header containing
an allowed CDN address. Certificate/routing errors and timeouts are inconclusive.

## Threats and limits

Trust the instance you use, its build toolchain, host and CDN: they deliver the
code controlling generation. TLS and headers reduce network tampering and framing
but cannot make a malicious host trustworthy. A separately trusted manifest
detects changes from a reviewed build, not whether the build itself is safe.
Compromised browsers, extensions, OSs, screen observation and clipboard history
or other apps reading copied values are outside this protection. Do not promise
clipboard auto-clear. Verification is a snapshot; repeat it after releases and
server/CDN configuration changes.

## Detailed install, update and rollback

These Linux procedures include the optional checks and administrator steps for
release-specific deployments. For the shortest manual path, see the
[README](../README.md#deploy). Its `unzip -DD` skips archived timestamps, so new
files receive current timestamps. Use a parent folder the web server can traverse
and a normal umask such as `022` so it can read the files. Keep that parent and
all backups outside every public root. The short update never deletes files and
refuses existing staging or backup paths and a symlinked site root. If the final
move fails, the old site remains in `passgen-previous`; restore that directory
to `passgen` before retrying. Retain its trusted manifest for verified rollback.
On SELinux hosts, apply the labeling steps below after each directory switch.

### Detailed prerequisites

You need a static web server, a domain with HTTPS already working, and shell
access with permission to write the site's files and configure the server.
Use a hostname dedicated to PassGen: other pages on the same origin could read
its generated passwords. See [why this matters](self-hosting.md#before-you-start).
For a managed static host without shell access, use the
[static-host guide](self-hosting.md#any-static-host).

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

### Automated walkthrough

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
   [Apache, nginx or Caddy config and header file](../deploy/examples/README.md).
   Follow your server's [setup steps](self-hosting.md#server-setup): back up
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

   Save the printed backup path. See [requirements and ownership options](install-release.md#requirements)
   for missing tools or different permissions, and
   [administrator notes](install-release.md#notes-for-administrators) for SELinux labeling.
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

### Manual walkthrough

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
   ```

9. **Required:** Verify the staged files, check for symlinks, then refresh timestamps.
   Continue only if every checksum says `OK`.

   ```sh
   (cd "/srv/passgen-staging-$VERSION" && sha256sum -c -) < SHA256SUMS
   ```

   Continue only if every checksum says `OK`; otherwise, stop.

   ```sh
   sudo find -P "/srv/passgen-staging-$VERSION" -type l -print
   ```

   If this prints anything, stop: the release contains a symbolic link. Do not continue.

   ```sh
   sudo find -P "/srv/passgen-staging-$VERSION" \( -type f -o -type d \) -exec touch -h -c {} +
   ```

   Refreshing timestamps prevents the ZIP’s 1980 dates from making browsers
   and CDNs keep an older page.

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
    See [Notes for administrators](install-release.md#notes-for-administrators)
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

14. Add the ready-made [Apache, nginx or Caddy config and header file](../deploy/examples/README.md)
    using your server's [setup steps](self-hosting.md#server-setup).
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
origin using the [CDN-only setup](self-hosting.md#optional-raw-peer-restrictions).
Review [CDN settings](self-hosting.md#cdn-and-proxy-settings) to prevent script
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
    ```

16. **Manual, required:** Verify staged files, check for symlinks, then refresh
    timestamps before switching. Continue only if every checksum says `OK`.

    ```sh
    (cd "/srv/passgen-staging-$VERSION" && sha256sum -c -) < SHA256SUMS
    ```

    Continue only if every checksum says `OK`; otherwise, stop.

    ```sh
    sudo find -P "/srv/passgen-staging-$VERSION" -type l -print
    ```

    If this prints anything, stop: the release contains a symbolic link. Do not continue.

    ```sh
    sudo find -P "/srv/passgen-staging-$VERSION" \( -type f -o -type d \) -exec touch -h -c {} +
    ```

    Refreshing timestamps prevents the ZIP’s 1980 dates from making browsers
    and CDNs keep an older page.

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
    Automated-path users: follow Manual walkthrough step 12 first if you have not yet added the
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
[exit-code guidance](install-release.md#exit-codes). Do not copy from a
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

5. **Manual:** Verify the saved web root with the previous release’s trusted
   manifest, check for symlinks, then refresh timestamps and restore it.

   ```sh
   (cd "/srv/passgen-backup-$PREVIOUS" && sha256sum -c -) < "../passgen-setup-$PREVIOUS/SHA256SUMS"
   ```

   Continue only if every checksum says `OK`; otherwise, stop.

   ```sh
   sudo find -P "/srv/passgen-backup-$PREVIOUS" -type l -print
   ```

   If this prints anything, stop: the release contains a symbolic link. Do not continue.

   ```sh
   sudo find -P "/srv/passgen-backup-$PREVIOUS" \( -type f -o -type d \) -exec touch -h -c {} +
   sudo mv -T "/srv/passgen-backup-$PREVIOUS" /srv/passgen
   ```

   **Automated fallback:** Instead of the command above, copy from the backup
   printed by the update install (Updating step 13). Replace the placeholder with
   that backup's exact `docroot/` path.
   This fallback is for an intact backup and unchanged root, not a refused rollback.

   ```sh
   sudo cp -a /path/to/installer-backup/docroot /srv/passgen
   (cd /srv/passgen && sha256sum -c -) < "../passgen-setup-$PREVIOUS/SHA256SUMS"
   ```

   Continue only if every checksum says `OK`; otherwise, stop.

   ```sh
   sudo find -P /srv/passgen -type l -print
   ```

   If this prints anything, stop: the release contains a symbolic link. Do not continue.

   ```sh
   sudo find -P /srv/passgen \( -type f -o -type d \) -exec touch -h -c {} +
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
