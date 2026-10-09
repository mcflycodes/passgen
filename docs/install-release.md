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

- bash 4.4 or newer, GNU coreutils, findutils and diffutils, `sha256sum`,
  `unzip`, and `rsync` 3.1 or newer.
- For downloads: `curl`, or `gh` logged in (`gh auth login`). `gh` is used when
  it is available and authenticated, which is also the way to reach a private
  repository; otherwise `curl` fetches from the public release URL.
- Write access to the docroot, to the staging directory (by default the
  docroot's parent) and to the backup directory or the directory it is created
  in.
- [Trusted directories](#trusted-directories) on the way to the docroot, the
  backups and the staging directory.
- For `--owner` with another user, root.

The script checks for its tools up front and exits 3 naming any that is missing.

## Usage

```sh
scripts/install-release.sh --version vX.Y.Z --docroot DIR [--repo OWNER/NAME]
    [--from-dir DIR] [--file-mode 0644] [--dir-mode 0755]
    [--owner USER[:GROUP]] [--backup-dir DIR] [--staging-dir DIR]
    [--url https://example.com/] [--dry-run]
```

| Option | Meaning |
|---|---|
| `--version vX.Y.Z` | Required. The exact release tag; releases are stable `X.Y.Z` versions only. |
| `--docroot DIR` | Required. The directory the web server serves. Created if it does not exist. It must be the real directory: a symbolic link is refused, and the message names the directory it points to, which is what to pass instead. |
| `--repo OWNER/NAME` | The GitHub repository that publishes the releases. Default: the `repository` field of the `package.json` next to the script, else the origin remote of the checkout the script sits in. A copied script outside a checkout needs this option. |
| `--from-dir DIR` | Use `passgen-X.Y.Z.zip`, `passgen-X.Y.Z.zip.sha256` and `SHA256SUMS` from `DIR` instead of downloading. For offline installs and tests. |
| `--file-mode MODE` | Mode for every installed file. Default `0644`. It must let the owner read (`0400`), so the script can verify what it installed. |
| `--dir-mode MODE` | Mode for the docroot and every directory in it. Default `0755`. It must give the owner read, write and search (`0700`), so the script can update and verify the tree. |
| `--owner USER[:GROUP]` | Owner and group for the docroot and everything in it, set as the files are written. Default: none. Every file is written anew, so without this option the files belong to the user running the script; existing directories keep their owner. |
| `--backup-dir DIR` | Where backups go. Default: a sibling of the docroot named `.<docroot-name>-backups`. |
| `--staging-dir DIR` | Where the release is downloaded and unpacked before it is installed. It must exist, be on the same filesystem as the docroot and lie outside it. Default: the docroot's parent. |
| `--url https://example.com/` | After installing, fetch every released file from the live site and compare it with the release, and check that `index.html` carries the nine security headers. |
| `--local-http` | Allow a plain `http://` `--url` on `127.0.0.1`, `localhost` or `[::1]`. For local tests only. |
| `--dry-run` | Check everything, download and verify the release in a private temporary directory, and print every install action. See [Dry run](#dry-run). |
| `-h`, `--help` | Print the usage text from the top of the script. |

Options also take the `--option=value` form. No value may contain a control
character such as a newline, carriage return or tab: a trailing newline on a
path would otherwise be lost along the way and name a different directory.

A typical first install on a server where the site is served from
`/srv/passgen` by the `www-data` user, which only needs to read it:

```sh
sudo scripts/install-release.sh --version v1.0.0 --docroot /srv/passgen \
    --owner root:www-data --file-mode 0640 --dir-mode 0750 \
    --url https://passgen.example.com/
```

Rerun it with the next version to upgrade. Run it with `--dry-run` first to see
what would change.

## What it does, in order

1. **Checks its tools and arguments.** Refuses control characters in any
   value, a docroot of `/` or one given as a symbolic link, a backup directory
   inside the docroot, a docroot inside the backup directory, and a
   `--from-dir` inside the docroot.
2. **Checks the paths.** Every directory above the docroot, the backup
   directory and the staging directory must be
   [trusted](#trusted-directories). An existing backup directory must belong to
   the user running the script and must not be writable by anyone else. The
   staging directory must be on the docroot's filesystem: when the docroot is
   itself a mount point, its parent is not, so the script refuses and asks for
   `--staging-dir`. It then records the docroot's device and inode number.
3. **Refuses a docroot it cannot back up or update safely.** Only regular
   files and directories are supported. A symbolic link, device, socket or
   pipe in the docroot, an entry this user cannot read or update, or a file
   with more than one hard link stops the run before anything changes. A hard
   link may be the same file as one outside the docroot; replace it with an
   independent copy (`cp --remove-destination`) or remove it.
4. **Downloads the release** into a fresh directory, `.passgen-install.XXXXXXXX`,
   inside the staging directory, never inside the docroot. It is removed when
   the script exits, whatever the outcome.
5. **Verifies the zip** against its `.sha256`, then inspects the entries before
   unpacking. Any absolute path, `..` component, backslash, control character,
   duplicate name, symbolic link, device or other special entry is refused.
6. **Unpacks and verifies the files** against `SHA256SUMS`: every listed file
   present with the right hash, no extra files, no missing files, nothing but
   regular files and directories, and a file named exactly `index.html`. A
   manifest line that is malformed or names an unsafe path is refused. A last
   line without a newline is read like the others.
7. **Backs up the docroot** to `<backup-dir>/<UTC timestamp>-<number>`, for
   example `20261009T153012Z-000001`, with modes and times (and ownership when
   running as root). The number counts up within one second, so names sort in
   the order the backups were taken. The backup directory is created with mode
   0700, so nobody else can reach the backups. The script repeats step 3's
   checks, copies the docroot, records every entry of the copy (type, mode,
   owner when running as root, and content hash) and confirms the record
   matches the docroot. From here on, any failure restores this backup.
8. **Installs with rsync** in three passes so the page never references assets
   that are not there yet: new and changed assets first, `index.html` second,
   stale files deleted last. Every file is written anew under a temporary name
   and renamed into place, even when its content is unchanged, and gets
   `--file-mode` (directories `--dir-mode`, including the docroot itself) and
   `--owner` as it is written. The script never changes the mode or owner of a
   file that is already there.
9. **Re-hashes the docroot** against `SHA256SUMS`, checks the file set is exact
   and checks every mode, and the owner when `--owner` is given. With `--url`,
   it then fetches every file in the manifest from the site with `curl` over
   HTTPS (no redirects, identity encoding), compares each hash with the
   release, and checks that the response for `index.html` carries all nine
   security header names. Names only: run `scripts/verify-live.ts` for the
   exact values and the rest of the live checks.
10. **Rotates backups**, keeping the one it just took and the two newest others
    whose names have its format. Anything else in the backup directory is left
    alone. Rotation runs after the install is verified, so it is best effort: if
    an old backup cannot be removed, the script warns, keeps the verified
    install and still exits 0.

If step 8 or 9 fails, the script restores the backup and exits 6. It first
checks the backup against the record from step 7 and refuses to restore a
backup that has changed since (exit 7). It restores with `rsync --delete`,
writing every file anew, then checks the docroot against the record. The
backup is kept.

### A docroot that changes underneath the script

Every step that reads or writes the docroot first checks that the path is
still a real directory with the device and inode number recorded in step 2,
then works from inside that directory rather than through its path. If the
docroot has been renamed, replaced or swapped for a symbolic link, the script
stops without writing through the path. When this happens after the install
has started, it does not roll back either: a rollback would write into
whatever the path now points to. It exits 8 with a `ROLLBACK REFUSED` message
naming the backup, which you restore by hand once you know what replaced the
docroot.

### Dry run

With `--dry-run`, steps 1 to 3 and 5 and 6 run as usual, then the script prints
what steps 7 to 10 would do, including the list of files whose content would
change or be deleted, and exits. The only thing it writes is one private
directory, `passgen-dry-run.XXXXXXXX`, under `$TMPDIR` (default `/tmp`), which
holds the downloaded and unpacked release and is removed on exit. `$TMPDIR`
must be trusted and lie outside the docroot and the backup directory. The
docroot, the backup directory and the staging directory are not touched.

## Trusted directories

The script runs as root or as the web site's user, on paths it was given. If
another user could rename a directory on one of those paths, they could swap
the docroot for a symbolic link to somewhere else between the script's checks
and its writes. So, as OpenSSH does with `StrictModes`, the script refuses to
run unless every existing directory above the docroot, above and including the
backup directory, and above and including the staging directory:

- is owned by root or by the user running the script, and
- is not writable by its group or by others, unless it has the sticky bit set
  (as `/tmp` does, where only an entry's owner can rename it).

`/srv/passgen` under a root-owned `/srv` passes; `/home/alice/www` fails when
root runs the script, because alice could rename `www`. Move the docroot, or
run the script as the owner of the directories above it.

Inside a user namespace, such as a rootless container or `unshare -r`, IDs not
mapped into the namespace show as the kernel's overflow ID (usually 65534), and
the host's root-owned directories are among them. There the script also trusts
that ID, since it could not run at all otherwise. Outside a user namespace the
overflow ID is an ordinary account and is not trusted.

The docroot's own contents are not covered by this rule. A user who can write
inside the docroot, such as the `--owner` account, can always change what the
site serves; while the script runs, they could also try to race it. Where that
matters, give the web server read access only, as in the example under
[Usage](#usage).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Installed and verified. Old backups may not all have been removed; the output says so. |
| 2 | Usage error. |
| 3 | A required tool is missing. |
| 4 | Refused before anything changed: unsafe or untrusted paths, a docroot, staging or backup directory the script will not use, or docroot contents the backup cannot capture. |
| 5 | The release failed verification. Nothing changed. |
| 6 | The install failed. The backup was restored and verified. |
| 7 | The install failed and the docroot was not restored: the backup changed after it was taken (`ROLLBACK REFUSED`), or the restore failed or could not be verified (`ROLLBACK NOT VERIFIED`). Read the output, then restore by hand from the backup directory it names. |
| 8 | The docroot was renamed, replaced or swapped for a symbolic link while the script ran. The script wrote nothing through the path and did not roll back. Read the output, find out what changed the docroot, then restore by hand from the backup it names, if any. |

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
  web root in a mode 0700 directory, so they are neither served nor reachable
  by other users, and the default location is hidden (`.<docroot-name>-backups`).
  Keep the release's `SHA256SUMS` elsewhere if you want to verify the deployment
  later; the script does not install it.
- **Network.** The script makes no network requests other than the release
  download and the optional `--url` check. It sends nothing anywhere.
- **Web server configuration** is out of scope: headers, HTTPS, method refusal
  and the rest come from the [self-hosting guide](self-hosting.md) and the
  generated examples in `deploy/examples/`.

## Tests

`tests/unit/install-release.test.ts` runs the script against fixture releases
built from a tiny dist with the real manifest tool and a minimal zip writer, so
it can also craft hostile entries. Shims put first on `PATH` (for `rsync`, `rm`
and `date`) supply hostile timing, and `unshare` supplies mount points. It
covers:

- the happy path with modes, owner and group, a private backup directory,
  creating a missing docroot, `--staging-dir`, a sticky world-writable parent,
  and the `--url` check;
- release verification: bad zip checksums, tampered, extra and missing files,
  zip-slip and absolute paths, symbolic link and device entries, malformed and
  unsafe manifests, near-miss names for `index.html`, and a manifest without a
  trailing newline, checked locally and on the live site;
- refused paths: control characters (a trailing newline must not select a
  sibling directory), modes that would lock the owner out, a docroot of `/` or
  given as a symbolic link, untrusted directories above the docroot, backups
  and staging, a group-writable backup directory, backup containment both ways,
  docroot contents the backup cannot capture, a hard link from outside the
  docroot, staging on another filesystem and a docroot that is a mount point;
- a docroot swapped for a symbolic link while the backup is taken, before the
  first install pass and before the deleting pass: nothing outside is touched,
  and the rollback is refused with exit 8;
- rollback, restoring the exact previous tree with modes and ownership, after a
  failed live check, an rsync failure, and a file appearing during the install;
  a hard link planted during the install never has its mode changed; a backup
  tampered with before a failed check is not restored (exit 7);
- backup rotation, including backups taken within the same second, older
  backups whose names sort after the new one, and a failure to remove an old
  backup, which only warns;
- a dry run that writes nothing outside its private temporary directory, and
  refuses a `TMPDIR` inside the docroot.

It runs as part of `pnpm test:unit`, so `pnpm check` includes it. The ownership
checks compare uid and gid with the user running the tests; changing ownership
to another user needs root, which the tests do not assume.
