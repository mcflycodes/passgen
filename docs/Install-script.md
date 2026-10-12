# Install with the install script

`scripts/install-release.sh` installs one exact PassGen release on a Linux web
server in one command. It downloads the release, checks every file before it
touches your site, backs up what is there, switches to the new files, checks the
result and puts the backup back on its own if anything fails.

**Who it's for:** administrators of a Linux server running Apache, nginx or
Caddy who want verified installs and automatic rollback. The script only handles
files: you still set up the web server once, using your server's page. For the
shortest path without checks, see [Install by hand](Install-by-hand.md). Every
option, exit code and safety detail is in the
[installer reference](install-release.md).

## Before you start

You need:

- A hostname that serves only PassGen, with HTTPS working. See
  [Before you start](self-hosting.md#before-you-start).
- Linux with bash 4.4 or newer, GNU coreutils, findutils and diffutils,
  `sha256sum`, `unzip`, `rsync` 3.1 or newer, `git`, and `curl` (or a logged-in
  `gh`). The script exits with code 3 and names any tool that is missing.
- Write access to the web root and its parent folder, usually through `sudo`.
- The exact version to install, such as `X.Y.Z` from
  [GitHub Releases](https://github.com/mcflycodes/passgen/releases). The script
  has no "latest" option.

The examples use `/srv/passgen` as the web root and `https://example.com/` as the
site. Replace both, and `X.Y.Z`, with your own values.

## Install

1. Download that release's source into a fresh folder outside the web root, and
   open it. The script and the server examples come from the same tag:

   ```sh
   git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git passgen-setup-X.Y.Z
   cd passgen-setup-X.Y.Z
   ```

2. Set up your web server once: [Apache](Install-Apache.md),
   [nginx](Install-nginx.md) or [Caddy](Install-Caddy.md).

3. **Optional, recommended:** do a dry run. It checks everything, downloads and
   verifies the release in a private temporary folder and prints every action,
   without changing anything:

   ```sh
   sudo scripts/install-release.sh --version vX.Y.Z --docroot /srv/passgen --dry-run
   ```

4. Install. Save the backup path it prints.

   ```sh
   sudo scripts/install-release.sh --version vX.Y.Z --docroot /srv/passgen
   ```

   **Optional variants** (add to the command above):

   - `--url https://example.com/` fetches every released file from the live site
     after installing, checks that `index.html` carries the nine security header
     names, and rolls back on a mismatch. Purge any CDN cache first.
   - `--owner root:www-data --file-mode 0640 --dir-mode 0750` lets a web server
     that runs as `www-data` read the files but not change them. Without
     `--owner`, the files belong to the user running the script (root with
     `sudo`), with modes `0644` and `0755`.

5. **Only if SELinux is enforcing:** label the web root, or the server answers
   403. Add the rule once, then apply it after every install, update or rollback:

   ```sh
   sudo semanage fcontext -a -t httpd_sys_content_t '/srv/passgen(/.*)?'
   sudo restorecon -R /srv/passgen
   ```

6. **Optional:** run the full live check, which also compares exact header values.
   It needs Node 22.18 or newer (the release's `.nvmrc` version is best) and no
   dependency install:

   ```sh
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
   node scripts/verify-live.ts --url https://example.com/ --manifest SHA256SUMS --release-dir /srv/passgen
   ```

## Update

1. Read the release notes for the new version.
2. From the parent folder, clone the new tag, compare its server examples with the
   old ones, and open it. `diff` printing nothing means no server change is needed;
   otherwise apply the changes to your server config, then validate and reload:

   ```sh
   git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git passgen-setup-X.Y.Z
   diff -ru passgen-setup-OLD/deploy/examples passgen-setup-X.Y.Z/deploy/examples
   cd passgen-setup-X.Y.Z
   ```

   Replace `OLD` with the installed version.

3. Run the new tag's script with the new version. It backs up the current site
   again and keeps the newest three backups:

   ```sh
   sudo scripts/install-release.sh --version vX.Y.Z --docroot /srv/passgen
   ```

4. **Only if SELinux is enforcing:** `sudo restorecon -R /srv/passgen`.

## Roll back

- **A failed install** rolls itself back. Read the output and the exit code (see
  below).
- **To undo a successful update**, reinstall the previous version. This verifies
  that release again and backs up the current site first. It leaves your web
  server settings alone: put back any file you changed, then validate and reload.

  ```sh
  sudo scripts/install-release.sh --version vOLD --docroot /srv/passgen
  ```

- **By hand**, copy from the backup folder the script printed: backups live next
  to the web root in `.passgen-backups/<timestamp>/docroot/`. The
  [self-hosting guide](self-hosting.md#rolling-back) has the verified steps.

## Troubleshooting

The exit code tells you what happened. Full details are under
[Exit codes](install-release.md#exit-codes).

| Exit code | Meaning and what to do |
|---|---|
| 0 | Installed and verified. |
| 2 | A usage error. Check the options; `--help` prints the usage. |
| 3 | A required tool is missing. Install the tool it names. |
| 4 | Refused before changing anything, for example a docroot given as a symbolic link (pass the real folder it names), a folder others can write, or a mount inside the docroot. See [Trusted directories](install-release.md#trusted-directories). |
| 5 | The release failed verification. Nothing changed. Try the download again; if it keeps failing, report it. |
| 6 | The install failed, and the backup was restored and verified. |
| 7 or 8 | The install failed and the site was not restored automatically. Read the output and restore by hand from the backup it names. |

| Problem | What to do |
|---|---|
| `--url` fails right after installing | A CDN or proxy is still serving the old version. Purge it, then install without `--url` and run the live check afterwards. |
| 403 Forbidden on every page | On SELinux hosts, run the labeling step above. Otherwise check the web server can read the files (see `--owner` above). |
| The site loads but headers are missing | The script does not configure the server. Follow your server's page. |
