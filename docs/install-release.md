# Installing a release with one command

`scripts/install-release.sh` installs one tagged PassGen release onto a Linux
static web server. It downloads the release, verifies every byte before anything
touches the web root, backs up what is there, switches to the new files,
verifies the result and restores the backup on its own if anything fails.

It complements, not replaces, the [self-hosting guide](self-hosting.md): the
server still needs the response headers, method refusal, no listing and the
other settings described there. [Verification](verify.md) explains the manifest
the installer checks against.

## What a release contains

Each GitHub Release `vX.Y.Z` attaches three files, which the installer treats as
its contract:

| File | Content |
|---|---|
| `passgen-X.Y.Z.zip` | The build: the contents of `dist/` at the zip root. |
| `passgen-X.Y.Z.zip.sha256` | One `sha256sum` line for the zip. |
| `SHA256SUMS` | The build manifest: one `sha256sum` line per file, paths relative to the web root, as `pnpm manifest` writes it. |

Obtain the version you intend to install through a channel you trust, such as
the release notes, and pass it exactly. There is no "latest".

## Requirements

- bash 4.4 or newer, GNU coreutils and findutils, `sha256sum`, `unzip`, `rsync`.
- For downloads: `curl`, or `gh` logged in (`gh auth login`). `gh` is used when
  it is available and authenticated, which is also the way to reach a private
  repository; otherwise `curl` fetches from the public release URL.
- Write access to the docroot and to its parent directory, where the staging
  directory and the default backup directory are created.
- For `--owner`, root.

The script checks for its tools up front and exits 3 naming any that is missing.

## Usage

```sh
scripts/install-release.sh --version vX.Y.Z --docroot DIR [--repo OWNER/NAME]
    [--from-dir DIR] [--file-mode 0644] [--dir-mode 0755]
    [--owner USER[:GROUP]] [--backup-dir DIR] [--url https://site/] [--dry-run]
```

| Option | Meaning |
|---|---|
| `--version vX.Y.Z` | Required. The exact release tag. |
| `--docroot DIR` | Required. The directory the web server serves. Created if it does not exist. |
| `--repo OWNER/NAME` | The GitHub repository that publishes the releases. Default: the `repository` field of the `package.json` next to the script, else the origin remote of the checkout the script sits in. A copied script outside a checkout needs this option. |
| `--from-dir DIR` | Use `passgen-X.Y.Z.zip`, `passgen-X.Y.Z.zip.sha256` and `SHA256SUMS` from `DIR` instead of downloading. For offline installs and tests. |
| `--file-mode MODE` | Mode for every installed file. Default `0644`. |
| `--dir-mode MODE` | Mode for the docroot and every directory in it. Default `0755`. |
| `--owner USER[:GROUP]` | Owner and group for the docroot and everything in it, applied after the files are in place. Default: unchanged. |
| `--backup-dir DIR` | Where backups go. Default: a sibling of the docroot named `.<docroot-name>-backups`. |
| `--url https://site/` | After installing, fetch every released file from the live site and compare it with the release, and check that `index.html` carries the nine security headers. |
| `--local-http` | Allow a plain `http://` `--url` on `127.0.0.1`, `localhost` or `[::1]`. For local tests only. |
| `--dry-run` | Download and verify the release, then print every install action without changing the docroot or the backups. |
| `-h`, `--help` | Print the usage text from the top of the script. |

Options also take the `--option=value` form.

A typical first install on a server where the site is served from
`/srv/passgen` by the `www-data` user:

```sh
sudo scripts/install-release.sh --version v1.0.0 --docroot /srv/passgen \
    --owner www-data:www-data --url https://passgen.example.com/
```

Rerun it with the next version to upgrade. Run it with `--dry-run` first to see
what would change.

## What it does, in order

1. **Checks its tools and arguments.** Refuses a docroot of `/`, a backup
   directory inside the docroot, a docroot inside the backup directory, and a
   `--from-dir` inside the docroot. The docroot's parent must be writable.
2. **Refuses a docroot it cannot back up.** Only regular files and directories
   are supported. A symbolic link, device, socket or pipe in the docroot, or an
   entry this user cannot read or update, stops the run before anything changes.
3. **Downloads the release** into a fresh staging directory next to the docroot
   (`.passgen-install.XXXXXXXX`), never inside it. The staging directory sits on
   the docroot's filesystem unless the docroot is itself a mount point, and it is
   removed when the script exits, whatever the outcome.
4. **Verifies the zip** against its `.sha256`, then inspects the entries before
   unpacking. Any absolute path, `..` component, backslash, control character,
   duplicate name, symbolic link, device or other special entry is refused.
5. **Unpacks and verifies the files** against `SHA256SUMS`: every listed file
   present with the right hash, no extra files, no missing files, nothing but
   regular files and directories, and `index.html` listed. A manifest line that
   is malformed or names an unsafe path is refused.
6. **Backs up the docroot** to `<backup-dir>/<UTC timestamp>` with modes and
   times (and ownership when running as root), then confirms the backup matches
   the docroot. From here on, any failure restores this backup.
7. **Installs with rsync** in three passes so the page never references assets
   that are not there yet: new and changed assets first, `index.html` second
   (rsync writes it to a temporary name and renames it into place), stale files
   deleted last. Then it applies `--file-mode` and `--dir-mode` to everything
   under the docroot, including the docroot itself, and `--owner` if given.
8. **Re-hashes the docroot** against `SHA256SUMS` and checks the file set is
   exact. With `--url`, it then fetches every file in the manifest from the site
   with `curl` over HTTPS (no redirects, identity encoding), compares each hash
   with the release, and checks that the response for `index.html` carries all
   nine security header names. Names only: run `scripts/verify-live.ts` for the
   exact values and the rest of the live checks.
9. **Rotates backups**, keeping the newest three directories whose names look
   like its timestamps (`YYYYMMDDTHHMMSSZ`, with a `-N` suffix when two runs
   share a second). Anything else in the backup directory is left alone.

If step 7 or 8 fails, the script restores the backup with `rsync --checksum
--delete`, re-hashes the docroot against a manifest of the backup to confirm
the restore, and exits 6. The backup is kept.

With `--dry-run`, steps 1 to 5 run as usual (the release is downloaded and
verified in the staging directory), then the script prints what steps 6 to 9
would do, including rsync's itemised list of files it would add, update and
delete, and exits without touching the docroot or the backups.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Installed and verified. |
| 2 | Usage error. |
| 3 | A required tool is missing. |
| 4 | Refused before anything changed: unsafe docroot or backup directory, or docroot contents the backup cannot capture. |
| 5 | The release failed verification. Nothing changed. |
| 6 | The install failed. The backup was restored and verified. |
| 7 | The install failed and the restore could not be verified. Restore the docroot by hand from the backup directory named in the output. |

## Notes for administrators

- **ACLs and SELinux are not touched.** The script sets plain modes and,
  optionally, the owner. rsync runs without `--acls` and `--xattrs`, so POSIX
  ACLs are neither copied into the backup nor applied to new files, and SELinux
  contexts on new files come from the filesystem's defaults. On an SELinux host,
  run `restorecon -R /srv/passgen` after the install (or add a file context rule
  for the docroot). If the docroot relies on ACLs, reapply them with `setfacl`
  after the install and restore them after a rollback.
- **Caches.** The `--url` check compares the live site with the release. A CDN
  or proxy that still serves the previous version fails the check and triggers a
  rollback. Purge the cache before installing, or install without `--url` and
  run `scripts/verify-live.ts` after the purge.
- **Backups** hold the previous web root, nothing more. They live outside the
  web root, so they are not served, and the default location is hidden
  (`.<docroot-name>-backups`). Keep the release's `SHA256SUMS` elsewhere if you
  want to verify the deployment later; the script does not install it.
- **Network.** The script makes no network requests other than the release
  download and the optional `--url` check. It sends nothing anywhere.
- **Web server configuration** is out of scope: headers, HTTPS, method refusal
  and the rest come from the [self-hosting guide](self-hosting.md) and the
  generated examples in `deploy/examples/`.

## Tests

`tests/unit/install-release.test.ts` runs the script against fixture releases
built from a tiny dist with the real manifest tool and a minimal zip writer, so
it can also craft hostile entries. It covers the happy path with modes and
owner, creating a missing docroot, the `--url` check, bad zip checksums,
tampered files, extra and missing files, zip-slip and absolute paths, symbolic
link and device entries, malformed and unsafe manifests, a docroot of `/`,
backup directories inside the docroot and the reverse, docroot contents the
backup cannot capture, rollback (restoring the exact previous tree, modes
included) after a failed live check, after an rsync failure, and after a file
appears in the docroot during the install, backup rotation, and a dry run that
changes nothing. It runs as part of `pnpm test:unit`, so `pnpm check` includes it.
