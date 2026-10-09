# Installing a release with one command

`scripts/install-release.sh` installs one tagged PassGen release onto a Linux
static web server. It downloads the release, verifies every byte before anything
touches the web root, backs up what is there, switches to the new files,
verifies the result and restores the backup on its own if anything fails.

It complements, not replaces, the [self-hosting guide](self-hosting.md): the
server still needs the response headers, method refusal, no listing and the
other settings described there. [Verification](verify.md) explains the manifest
the installer checks against.

## Threat model

The installer is run by the server's administrator, as root or as the user that
owns the site. It is designed to be safe against:

- **other local users who are not root**, who may own directories, create
  files, race the script and try to make it write somewhere else, read its
  backups or have it change files outside the web root; and
- **a malformed or hostile release**: a bad checksum, tampered or extra files,
  unsafe paths, links or special entries in the zip, or a bad manifest.

It does not defend against root, or against how root has set the system up. A
bind mount that root placed inside the web root, a hostile `--trust-owner`, or
an administrator who passes the wrong `--docroot` are root's decisions. Where
such a setup is cheap to detect, the script refuses; the rest is listed under
[What it cannot detect](#what-it-cannot-detect).

A web server account that can write the web root is not supported: the script
refuses such a docroot (see [Trusted directories](#trusted-directories)) unless
you name that account with `--owner`, which makes it trusted. Give the server
read access only.

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

- Linux. Mount detection reads `/proc/self/mountinfo`.
- bash 4.4 or newer, GNU coreutils, findutils and diffutils, `sha256sum`,
  `unzip`, and `rsync` 3.1 or newer.
- Optional: `getfacl` and `setfacl` (the `acl` package), which the script uses
  for the ACL checks described below when they are installed.
- For downloads: `curl`, or `gh` logged in (`gh auth login`). `gh` is used when
  it is available and authenticated, which is also the way to reach a private
  repository; otherwise `curl` fetches from the public release URL.
- Write access to the docroot, to the staging directory (by default the
  docroot's parent) and to the backup directory or its parent.
- [Trusted directories](#trusted-directories) on the way to the docroot, the
  backups and the staging directory, and inside the docroot.
- For `--owner` with another user, root.

The script checks for its tools up front and exits 3 naming any that is missing.

## Usage

```sh
scripts/install-release.sh --version vX.Y.Z --docroot DIR [--repo OWNER/NAME]
    [--from-dir DIR] [--file-mode 0644] [--dir-mode 0755]
    [--owner USER[:GROUP]] [--backup-dir DIR] [--staging-dir DIR]
    [--trust-owner UID]... [--url https://example.com/] [--dry-run]
```

| Option | Meaning |
|---|---|
| `--version vX.Y.Z` | Required. The exact release tag; releases are stable `X.Y.Z` versions only. |
| `--docroot DIR` | Required. The directory the web server serves. Created if it does not exist. It must be the real directory: a symbolic link is refused, and the message names the directory it points to, which is what to pass instead. |
| `--repo OWNER/NAME` | The GitHub repository that publishes the releases. Default: the `repository` field of the `package.json` next to the script, else the origin remote of the checkout the script sits in. A copied script outside a checkout needs this option. |
| `--from-dir DIR` | Use `passgen-X.Y.Z.zip`, `passgen-X.Y.Z.zip.sha256` and `SHA256SUMS` from `DIR` instead of downloading. For offline installs and tests. |
| `--file-mode MODE` | Mode for every installed file. Default `0644`. It must let the owner read (`0400`), so the script can verify what it installed. |
| `--dir-mode MODE` | Mode for the docroot and every directory in it. Default `0755`. It must give the owner read, write and search (`0700`); running as root, read and search (`0500`) are enough, so `0555` works. It must not let group or others write. |
| `--owner USER[:GROUP]` | Owner and group for the docroot and everything in it, set as the files are written. The user must exist. Default: none. Every file is written anew, so without this option the files belong to the user running the script; existing directories keep their owner. |
| `--backup-dir DIR` | Where backups go. Default: a sibling of the docroot named `.<docroot-name>-backups`. See [Backups](#backups). |
| `--staging-dir DIR` | Where the release is downloaded and unpacked before it is installed. It must exist, be on the same filesystem as the docroot and lie outside it. Default: the docroot's parent. |
| `--trust-owner UID` | Also trust directories owned by this numeric UID on the way to the docroot, the backups and the staging directory. Repeatable. Meant for user namespaces; see [Trusted directories](#trusted-directories). |
| `--url https://example.com/` | After installing, fetch every released file from the live site and compare it with the release, and check that `index.html` carries the nine security headers. |
| `--local-http` | Allow a plain `http://` `--url` on `127.0.0.1`, `localhost` or `[::1]`. For local tests only. |
| `--dry-run` | Check everything, download and verify the release in a private temporary directory, and print every install action. See [Dry run](#dry-run). |
| `-h`, `--help` | Print the usage text from the top of the script. |

Options also take the `--option=value` form. No value may contain a control
character such as a newline, carriage return or tab, and neither may any path
once resolved: the script resolves paths byte for byte, so a directory whose
name ends in a newline is refused rather than mistaken for its sibling.

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
   value, modes that would lock the owner out or let others write, an unknown
   `--owner` user, a docroot of `/` or one given as a symbolic link.
2. **Checks the paths.** Resolves the docroot, staging directory, backup
   directory, `--from-dir` and (for a dry run) `$TMPDIR`, refusing any whose
   resolved path holds a control character. Every directory on the way must be
   [trusted](#trusted-directories). The script records the docroot's device and
   inode number, refuses anything mounted inside the docroot, and refuses a
   staging directory, backup directory or `$TMPDIR` that lies inside the
   docroot, whether by name or [by identity](#bind-mounts-and-mounts). It
   refuses a docroot inside the backup directory the same ways. An existing
   backup directory must be [private](#backups). The staging directory must be
   on the docroot's filesystem: when the docroot is itself a mount point, its
   parent is not, so the script refuses and asks for `--staging-dir`.
3. **Refuses a docroot it cannot back up or update safely.** Only regular
   files and directories are supported. A symbolic link, device, socket or
   pipe in the docroot, an entry this user cannot read or update, a file with
   more than one hard link, or a directory an untrusted user could write
   ([Trusted directories](#trusted-directories)) stops the run before anything
   changes. A hard link may be the same file as one outside the docroot;
   replace it with an independent copy (`cp --remove-destination`) or remove it.
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
7. **Backs up the docroot** into a new, private backup directory (see
   [Backups](#backups)), with modes and times (and ownership when running as
   root). The script repeats step 3's checks, copies the docroot, records every
   entry of the copy (type, mode, owner when running as root, and content hash)
   and confirms the record matches the docroot. From here on, any failure
   restores this backup.
8. **Installs with rsync** in three passes so the page never references assets
   that are not there yet: new and changed assets first, `index.html` second,
   stale files deleted last. Every file is written anew under a temporary name
   and renamed into place, even when its content is unchanged, and gets
   `--file-mode` (directories `--dir-mode`, including the docroot itself) and
   `--owner` as it is written. After verifying the copied tree, it sets every
   file and directory modification time to one captured install timestamp.
   This prevents the reproducible ZIP’s 1980 dates from making browsers and
   CDNs keep an older page. The script never changes the mode or owner of a
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
    the backups cannot be listed or an old one cannot be removed, the script
    warns, keeps the verified install and still exits 0.

If step 8 or 9 fails, the script restores the backup and exits 6. It first
checks the backup against the record from step 7 and refuses to restore a
backup that has changed since (exit 7). It restores with `rsync --delete`,
writing every file anew, then checks the docroot against the record. The
backup is kept. Restored files and directories receive one restore timestamp,
at least one second later than the failed install timestamp, so caches
revalidate the restored page even during an immediate rollback.

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
must be trusted and lie outside the docroot (by name and by identity) and the
backup directory. The docroot, the backup directory and the staging directory
are not touched.

### Manual timestamps

For a manual install or update, require every staged checksum to pass, then
check for symlinks before refreshing timestamps or moving the payload into place:

```sh
(cd "/path/to/staging" && sha256sum -c /path/to/trusted/SHA256SUMS)
```

Continue only if every checksum says `OK`; otherwise, stop.

```sh
find -P "/path/to/staging" -type l -print
```

If this prints anything, stop: the release contains a symbolic link. Do not continue.

```sh
find -P "/path/to/staging" \( -type f -o -type d \) -exec touch -h -c {} +
```

Use the real staging and trusted manifest paths. For a manual rollback, use the
same checksum and symlink checks with the previous release’s trusted manifest,
then refresh that verified restored tree before publishing it, waiting until the next second if the install just finished.
Refreshing timestamps makes browsers and CDNs revalidate the changed page.

## Trusted directories

The script runs as root or as the site's owner, on paths it was given. Another
user who could rename a directory on one of those paths, or write inside the
docroot, could swap an entry for a symbolic link between the script's checks
and its writes and send them somewhere else. So, as OpenSSH does with
`StrictModes`, the script refuses to run unless:

- every existing directory above the docroot, above and including the staging
  directory, and above the backup directory is owned by root, by the user
  running the script, or by a `--trust-owner` UID, and is not writable by its
  group or by others unless it has the sticky bit set (as `/tmp` does, where
  only an entry's owner can rename it); and
- no directory inside the docroot, nor the docroot itself, can be written by an
  untrusted user. Running as root, each must be owned by root or the `--owner`
  user. Either way, none may be writable by its group or by others. When
  `getfacl` is installed, ACL entries that grant another user or group write
  access, or would grant it to what is created inside, are refused too. Access
  ACL entries for named users and groups are capped by the group permission
  bits, so the group-write check covers them even without `getfacl`.

`/srv/passgen` under a root-owned `/srv` passes; `/home/alice/www` fails when
root runs the script, because alice could rename `www`. Move the docroot, or
run the script as the owner of the directories above it.

A docroot the web server can write is refused when the server's access comes
from group or other write bits, or from an ACL. A tree owned by the web server
account, such as `www-data`, is refused too, unless you pass `--owner www-data`.
`--owner` names an account the script trusts as much as root: it accepts
directories that account owns, and gives it the whole installed tree. That is a
deliberate choice, and a discouraged one. The account can then change what the
site serves at any time, and anyone who compromises the web server, through a
bug in it or in anything else that runs as that account, can deface the site or
race a later install. The installer cannot tell such a takeover from a normal
deployment. The recommended setup keeps the tree owned by root (or by the user
running the script) and gives the server read access only:

```sh
sudo chown -R root:www-data /srv/passgen
sudo chmod -R u=rwX,g=rX,o= /srv/passgen
```

then install with `--owner root:www-data --file-mode 0640 --dir-mode 0750`, as
in the example under [Usage](#usage). Running the installer as the site's own
user instead works too, as long as no other account can write the tree.

### User namespaces

Inside a user namespace, such as a rootless container or `unshare -r`, IDs that
are not mapped into it show as the kernel's overflow ID, usually 65534. The
host's root-owned directories, `/` among them, show that way, but so do every
other unmapped user's. The script never trusts the overflow ID on its own; pass
`--trust-owner 65534` if, and only if, you know the directories above your paths
that show as 65534 belong to root.

### Bind mounts and mounts

Comparing paths by name is not enough: a bind mount can make a directory inside
the docroot appear somewhere unrelated. So the script also compares identities.
If the staging directory, the backup directory or `$TMPDIR` (dry run), or any
directory above them, has the docroot's device and inode number, it lies inside
the docroot under another name, and the script refuses. It refuses a docroot
inside the backup directory the same way.

It also refuses when `/proc/self/mountinfo` lists any mount point strictly
inside the docroot, since the install would overwrite and delete whatever is
mounted there. The paths in mountinfo are decoded (`\040` is a space, and so
on) before they are compared.

### What it cannot detect

- **Same-filesystem bind mounts are seen only through mountinfo.** That is
  Linux-specific. Without `/proc/self/mountinfo` the script warns and carries
  on, and mounts inside the docroot go unnoticed.
- **Aliases of a docroot that does not exist yet** cannot be compared by
  identity; the name checks still apply.
- **A bind mount of only part of the docroot.** If root bind-mounts a directory
  inside the docroot, such as `assets`, somewhere else, and that place is then
  used as the staging directory, backup directory or `$TMPDIR`, the identity
  check does not see it: it compares the docroot itself, not each directory
  inside it, and the new mount point is outside the docroot, so mountinfo does
  not flag it either. Such a mount is root's own setup and outside the threat
  model.
- **Root's own setup.** A mount created by root while the script runs, or a
  `--trust-owner` UID that turns out to belong to someone else, is outside the
  threat model.
- **ACLs without the acl tools.** Without `getfacl`, default ACL entries inside
  the docroot are not inspected. They cannot open what the script installs,
  because rsync sets every mode explicitly, which caps named ACL entries.

## Backups

Backups live in the backup directory, by default `.<docroot-name>-backups` next
to the docroot, outside the web root, so they are never served. Each run adds
`<UTC timestamp>-<number>`, for example `20261009T153012Z-000001`, holding the
copy in `docroot/`. The number counts up within one second, so names sort in
the order the backups were taken. To restore by hand, copy from
`<backup>/docroot/`.

Nobody but the user running the script may read or change a backup:

- An existing backup directory must belong to that user and have mode exactly
  `0700`. It must not carry a default ACL, nor, when `getfacl` is installed, any
  extended ACL entry. Otherwise the script refuses and says how to fix it.
- A missing backup directory is created with mode `0700`, but its parent must
  exist; the script does not create a chain of directories. If the parent has a
  default ACL, the new directory would inherit entries from it: the script
  removes them with `setfacl -b` when it can, and otherwise removes the
  directory again and refuses.
- Each `<UTC timestamp>-<number>` directory is created with mode `0700`, and
  the script confirms that and the backup directory's own owner and mode before
  copying anything into it. The docroot's mode and owner are kept on the
  `docroot/` copy one level down, not on these directories.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Installed and verified. Old backups may not all have been removed; the output says so. |
| 2 | Usage error. |
| 3 | A required tool is missing. |
| 4 | Refused before anything changed: unsafe, untrusted or aliased paths, a mount inside the docroot, a docroot others can write, a docroot, staging or backup directory the script will not use, or docroot contents the backup cannot capture. |
| 5 | The release failed verification. Nothing changed. |
| 6 | The install failed. The backup was restored and verified. |
| 7 | The install failed and the docroot was not restored: the backup changed after it was taken (`ROLLBACK REFUSED`), or the restore failed or could not be verified (`ROLLBACK NOT VERIFIED`). Read the output, then restore by hand from the backup directory it names. |
| 8 | The docroot was renamed, replaced or swapped for a symbolic link while the script ran. The script wrote nothing through the path and did not roll back. Read the output, find out what changed the docroot, then restore by hand from the backup it names, if any. |

## Notes for administrators

- **ACLs and SELinux.** The script sets plain modes and, optionally, the owner.
  rsync runs without `--acls` and `--xattrs`, so POSIX ACLs are neither copied
  into the backup nor applied to new files, and SELinux contexts on new files
  come from the filesystem's defaults. On an SELinux host, run
  `restorecon -R /srv/passgen` after the install (or add a file context rule for
  the docroot). The ACL checks above only refuse; the script never adds ACL
  entries, and it removes them only from a backup directory it has just created.
- **Caches.** The `--url` check compares the live site with the release. A CDN
  or proxy that still serves the previous version fails the check and triggers a
  rollback. Purge the cache before installing, or install without `--url` and
  run `scripts/verify-live.ts` after the purge.
- **Backups** hold the previous web root, nothing more. Keep the release's
  `SHA256SUMS` elsewhere if you want to verify the deployment later; the script
  does not install it.
- **Network.** The script makes no network requests other than the release
  download and the optional `--url` check. It sends nothing anywhere.
- **Web server configuration** is out of scope: headers, HTTPS, method refusal
  and the rest come from the [self-hosting guide](self-hosting.md) and the
  generated examples in `deploy/examples/`.

## Tests

`tests/unit/install-release.test.ts` runs the script against fixture releases
built from a tiny dist with the real manifest tool and a minimal zip writer, so
it can also craft hostile entries. Shims put first on `PATH` (for `rsync`, `rm`,
`find` and `date`) supply hostile timing and failures. `unshare` supplies mount
points, bind mounts and root: `-rm` for mounts, and `-r --map-auto` (subordinate
IDs) for a second user that root must not trust. Default ACLs are set through
extended attributes, so that part needs no acl tools. It covers:

- the happy path with modes, owner and group, private backup directories,
  creating a missing docroot, `--staging-dir`, a sticky world-writable parent,
  read-only `0555`/`0444` modes as root, and the `--url` check;
- release verification: bad zip checksums, tampered, extra and missing files,
  zip-slip and absolute paths, symbolic link and device entries, malformed and
  unsafe manifests, near-miss names for `index.html`, and a manifest without a
  trailing newline, checked locally and on the live site;
- refused paths: control characters in arguments and in resolved paths (a
  working directory or symbolic link target whose name ends in a newline must
  not select a sibling), modes that would lock the owner out or let others
  write, a docroot of `/` or given as a symbolic link, untrusted directories
  above the docroot, backups and staging, the overflow ID without
  `--trust-owner`, backup containment both ways, docroot contents the backup
  cannot capture, a hard link from outside the docroot, directories in the
  docroot that group, others, another owner or a default ACL could write,
  staging on another filesystem and a docroot that is a mount point;
- bind mounts: a dry run's `$TMPDIR`, a staging directory and a backup
  directory reached through a bind mount of the docroot, and an outside
  directory mounted inside the docroot under a name mountinfo escapes;
- private backups: an existing backup directory that is not `0700` or carries
  a default ACL, a missing parent, and a parent whose default ACL would open a
  new backup directory;
- a docroot swapped for a symbolic link while the backup is taken, before the
  first install pass and before the deleting pass: nothing outside is touched,
  and the rollback is refused with exit 8;
- rollback, restoring the exact previous tree with modes and ownership, after a
  failed live check, an rsync failure, and a file appearing during the install;
  a hard link planted during the install never has its mode changed; a backup
  tampered with before a failed check is not restored (exit 7);
- backup rotation, including backups taken within the same second, older
  backups whose names sort after the new one, and a listing or removal failure,
  which only warns;
- a dry run that writes nothing outside its private temporary directory, and
  refuses a `TMPDIR` inside the docroot.

It runs as part of `pnpm test:unit`, so `pnpm check` includes it. Tests that run
inside a user namespace pass `--trust-owner` explicitly. A case skips, saying
why, when its namespace feature is unavailable (for example `--map-auto` inside
another user namespace), or, for the default ACL inside the docroot, when
`getfacl` is not installed.
