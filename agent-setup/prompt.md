# Set up PassGen

You are an AI coding agent helping a user install PassGen, a static password and
passphrase generator. Your goal is a verified HTTPS deployment on its own origin,
with the shipped security headers and a usable rollback. These instructions are
for you to follow. If you cannot fetch URLs, ask the user to paste this file and
any required source files instead; do not guess their contents.

## Ask first

Before changing anything, ask these questions in one short batch. Reuse answers
already provided and ask only for what is missing:

- Which server or host: Apache, nginx, Caddy, a static host/CDN such as Cloudflare
  Pages or Netlify, or something else? Which machine or hosting project?
- What OS is it running? Do you have shell access, and sudo/root privileges?
- What domain/hostname will serve PassGen, and what is the web root path?
- Which user and group should own the files? The web server needs read access,
  not write access.
- Is HTTPS/TLS already set up, and what manages certificates and renewal?
- Is there a CDN or reverse proxy in front? Which one?
- Which release version should be installed? Default to the latest published
  release, resolved to its exact stable tag before planning the install.
- Optional: should direct access to the origin be restricted to the CDN?
- Will PassGen have its own hostname, with no unrelated pages, applications or
  uploads on that origin? This is required. A different path is insufficient:
  same-origin pages/scripts could read generated passwords and saved settings.
  See [origin isolation](../docs/self-hosting.md#before-you-start).

Use generic placeholders such as `example.com` in examples, then substitute only
user-confirmed values in the plan. Do not proceed without the needed answers.

## Procedure

1. **Inspect read-only.** Confirm which host you are connected to, OS, privileges,
   server version, active site config, web root, file ownership, TLS setup and
   CDN behavior. Check for existing content and shared listeners/vhosts. Confirm
   that the entire origin is dedicated to PassGen, including paths outside its
   root. A verifier cannot establish origin isolation. Stop and ask if the
   requested root contains unrelated content or the origin is shared.

2. **Read the actual release instructions and source at the selected tag.**
   Resolve the chosen release to its exact `vX.Y.Z` tag first. Read every referenced
   repository file below at that tag, not at `main`: use a checkout of the tag,
   or replace `main` with the tag in raw-file URLs. Use the repository's
   [installer reference](../docs/install-release.md),
   [self-hosting guide](../docs/self-hosting.md),
   [verification guide](../docs/verify.md),
   [installer](../scripts/install-release.sh),
   [live verifier](../scripts/verify-live.ts), and matching
   [server examples](../deploy/examples/README.md).
   Resolve the selected release to an exact `vX.Y.Z` tag and use source and
   header files from that reviewed release. The installer has no `latest` flag.
   Check required tools before proposing commands. The repository is public;
   anonymous `curl --fail --location --remote-name` downloads work. `gh` is an
   optional alternative. If downloads fail, stop and ask for the three trusted
   release assets rather than assuming credentials are required.

3. **Show a concrete plan and get explicit confirmation before any change.**
   Include exact commands, destination host, release tag, web root, ownership,
   permissions, config files and exact edits, TLS handling, expected interruption,
   verification commands, and how to restore files and config. Include downloads,
   temporary/staging directories, packages and reloads in the plan. Preserve the
   previous verified release and its manifest outside the public root. Explain
   any proposed DNS/CDN/firewall changes separately and ask before making them.
   No answer or elapsed time counts as approval. If no shell access exists,
   show the equivalent supported static-host workflow for approval.

4. **Back up before modifying.** After confirmation, save every existing config
   you will modify outside the public root, preserving its ownership and modes.
   Record the backup locations and rollback commands. The installer backs up
   only the web root, not server config. For a manual deployment or static host,
   retain the previous payload/deployment and settings using the host's supported
   rollback workflow. Do not publish source, `.git`, backups, manifests or tools.

5. **Download and verify the release. Always verify checksums.** Obtain all three
   assets from the selected trusted release: `passgen-X.Y.Z.zip`,
   `passgen-X.Y.Z.zip.sha256` and `SHA256SUMS`. Keep them outside the web root.
   Verify the ZIP before extracting, then check the extracted files against the
   manifest; all results must say `OK`. On Linux the commands are:

   ```sh
   sha256sum -c passgen-X.Y.Z.zip.sha256
   ```

   ```sh
   (cd payload && sha256sum -c ../SHA256SUMS)
   ```

   Substitute the resolved version and actual staging paths. On macOS use
   `shasum -a 256 -c`. Retain the trusted manifest for live verification and
   rollback; never fetch it from the deployed site as proof of that site's
   integrity. The Linux installer performs ZIP, safe-entry, exact file-set and
   manifest verification itself; use its `--from-dir` option for the downloaded
   assets. These checks are mandatory for you, even where the human guide marks
   them optional. A checksum mismatch means stop without deploying.

6. **Install using the path supported by the answers.** With shell access on
   Linux, prefer `scripts/install-release.sh`, using its actual flags:

   ```sh
   scripts/install-release.sh --version vX.Y.Z --docroot /srv/passgen \
     --repo mcflycodes/passgen --from-dir /path/to/release-assets
   ```

   Substitute approved paths; add approved `sudo`, `--owner USER:GROUP`, modes,
   backup/staging paths as needed. The installer needs trusted paths, a real
   docroot (not a symlink), and staging on the same filesystem outside the root.
   It does not configure the server, TLS or headers. Run the approved `--dry-run`
   first. Save its printed backup path; it keeps the newest three backups.
   Without shell access, or on an unsupported OS, use the manual/static-host
   path: unpack into empty staging, verify hashes, reject symlinks and unsafe
   entries, and publish only verified regular payload files using the supported
   host workflow. Staging checksum verification is required; stop if any hash
   fails. Then run `find -P "/path/to/staging" -type l -print`. If this prints
   anything, stop: the release contains a symbolic link. Do not continue.
   After these checks, run
   `find -P "/path/to/staging" \( -type f -o -type d \) -exec touch -h -c {} +`
   before publishing on each install or update, so the ZIP’s 1980 timestamps do
   not make caches keep an older page.
   Replace the previous release completely; do not overlay files.
   Never run scripts or install packages on another machine by assumption.

7. **Apply the shipped server security configuration.** Use the matching Apache,
   nginx or Caddy full site config and header snippet under `deploy/examples/`.
   Substitute only the approved hostname, real web root, certificate paths and
   include paths; preserve every security header value exactly as shipped,
   including the entire CSP. Follow the hosting guide's containment, static-only
   handling, GET/HEAD-only methods, no directory listing, real 404s, MIME types
   and caching rules. Apache's Host and filename-containment expressions must
   match the chosen name/root; nginx child blocks with `add_header` need the
   security include repeated. Validate inherited settings; examples cannot undo
   every shared-server directive. Never change unrelated sites or vhosts.
   For Pages or Netlify, place the matching `_headers` file in the publishing
   folder as documented. It is a provider control, outside the payload manifest:
   do not pass that staging folder to `--release-dir`. Verify the host actually
   consumes the file and meets error/method requirements. Additional error pages
   need their own reviewed manifest. Ask if the host cannot meet the baseline.

8. **Validate before reload.** Choose the actual server's command; adapt paths
   only to the inspected setup. Run with the approved privileges:

   ```sh
   apachectl configtest
   ```

   ```sh
   nginx -t
   ```

   ```sh
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   Caddy validation may read certificates and provision modules. On failure,
   restore changed config and stop; never reload invalid configuration. Prefer
   graceful reload (`apachectl graceful`, `nginx -s reload`, or
   `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`) after validation.
   Use the inspected service arrangement rather than assuming an OS service name.
   Apply approved CDN settings that prevent injection/rewriting and handle stale
   caches before verification. Origin restriction is optional and needs separate
   approval and checks of both CDN success and direct-origin refusal.

9. **Run the live check and report results.** Use the source from the same release
   and its pinned Node version (`.nvmrc`); this script requires no dependency
   install. If the deployment host lacks Node, run it from an approved machine
   with access to the public URL and trusted manifest:

   ```sh
   node scripts/verify-live.ts --url https://example.com/ \
     --manifest /path/to/trusted/SHA256SUMS --release-dir /srv/passgen
   ```

   Use the canonical HTTPS URL with a trailing slash. Keep TLS verification on.
   Include `--release-dir` only when the actual payload is locally accessible
   as a real directory; otherwise omit it and report that HTTP cannot enumerate
   extra files. Report hashes, exact security headers/CSP, HEAD, method refusal,
   missing/hidden/executable paths and listing results. Separately inspect MIME
   types, cache policy/cache hits, HTTP-to-HTTPS redirect and certificate renewal;
   the verifier does not prove those. The installer's optional `--url` checks
   hashes and header names only and does not replace this live check.

10. **On failure, roll back and report.** Use the rollback the user approved,
    restoring the previous payload and modified config, validating before any
    reload, then verifying with the previous release's manifest. The installer
    refreshes timestamps on install and restore, and attempts rollback for
    failures after backup; read its output and exit code.
    For manual rollback, require checksum verification with the previous release’s
    trusted manifest, check for symlinks, then refresh the restored tree with
    the same `find` command before publishing so caches revalidate the restored page; wait until
    the next second if the install just finished.
    If it reports a changed backup/root, refused rollback or unverified restore,
    stop and ask rather than overwriting through an unexpected path. Do not claim
    success unless checks passed; report failed checks, what was restored, and
    any remaining uncertainty. A first install has no previous deployment: undo
    only the changes in the approved plan.

## Safety rules

- Never expose secrets in output, logs, commits or web-served files. Do not ask
  the user to paste tokens, passwords or private keys; use existing secure access.
- Never weaken or drop headers or CSP. Never add analytics, scripts, fonts or
  third-party resources, or allow host/CDN injection or rewriting.
- Do not touch unrelated sites/vhosts. No firewall, DNS or CDN changes without
  asking and receiving explicit approval for those changes.
- Do not disable SELinux or AppArmor. Use the OS's supported permissions and
  labeling procedures as part of the approved plan; the installer does not
  preserve ACLs or extended attributes, including SELinux labels.
- Ask before installing packages, including a missing verifier runtime.
- Stop and ask on anything unexpected: access failures, conflicting config,
  checksum mismatch, unsupported host behavior or a changed path/backup. Restore
  only what can be safely restored under the approved rollback plan.

Finish with a short summary for the user: what changed, on which host and paths,
which release was installed, verification results and limits, how to update using
an exact new release tag, and the precise backup locations and rollback steps.
