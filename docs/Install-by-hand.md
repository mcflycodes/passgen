# Install by hand

The shortest way to run PassGen on your own web server: download one ZIP, unzip
it into a folder and point your web server at that folder. No build, no scripts.

**Who it's for:** anyone with shell access to a Linux server that already runs
Apache, nginx or Caddy. For one command that also backs up and rolls back on its
own, use the [install script](Install-script.md). For a container, see
[Docker](Install-Docker.md). Without shell access, see
[Static hosts and CDNs](Static-hosts-and-CDNs.md).

## Before you start

You need:

- A hostname that serves only PassGen, with HTTPS already working. Other pages
  on the same origin could read generated passwords, so a path next to another
  site is not enough. See [Before you start](self-hosting.md#before-you-start).
- A Linux shell with `curl`, `unzip`, `sha256sum` and GNU `mv` (for `mv -T`). On
  macOS, follow the [self-hosting guide](self-hosting.md#detailed-install-update-and-rollback) instead.
- A writable parent folder **outside** every web root, which the web server can
  traverse. The site folder (`./passgen`), its file list (`passgen.SHA256SUMS`)
  and the backups all live there.
- A normal umask such as `022`, so the web server can read the files.
- Permission to edit and reload your web server's configuration.

Every command block below is one chain: if any part fails, the rest does not run.
Stop if a block prints an error or a checksum line that does not say `OK`.

## Install

1. Go to the parent folder. Download the latest release and its file list, unzip
   it into a new site folder (`./passgen`) and check every file against the list:

   ```sh
   curl --fail --location --output passgen.zip https://github.com/mcflycodes/passgen/releases/latest/download/passgen.zip &&
   curl --fail --location --output passgen.SHA256SUMS https://github.com/mcflycodes/passgen/releases/latest/download/SHA256SUMS &&
   unzip -DD passgen.zip -d ./passgen &&
   (cd ./passgen && sha256sum -c ../passgen.SHA256SUMS)
   ```

   Every file must say `OK`. Keep `passgen.SHA256SUMS` next to the site folder:
   updates and rollbacks use it. `unzip -DD` skips the archive's timestamps, so
   the new files get the current time and browsers and CDNs do not keep an older
   page.

2. Add the security headers. Copy the ready-made site config and its header file
   for your server, change the domain, the absolute site folder, the certificate
   and the include paths, then validate and reload your server. Each page walks
   through it:
   [Apache](Install-Apache.md) ([site config](../deploy/examples/apache/passgen-site.conf),
   [headers](../deploy/examples/apache/passgen-headers.conf)),
   [nginx](Install-nginx.md) ([site config](../deploy/examples/nginx/passgen-site.conf),
   [headers](../deploy/examples/nginx/passgen-headers.conf)) or
   [Caddy](Install-Caddy.md) ([site config](../deploy/examples/caddy/Caddyfile),
   [headers](../deploy/examples/caddy/passgen-headers.caddy)).

3. **Only if SELinux is enforcing** (common on RHEL and AlmaLinux): label the
   folder as web content, or the server answers 403. Add the rule once, with your
   site folder's absolute path in place of `/srv/passgen`, then apply it:

   ```sh
   sudo semanage fcontext -a -t httpd_sys_content_t '/srv/passgen(/.*)?'
   sudo restorecon -R /srv/passgen
   ```

4. Open your HTTPS site. A password should already be there. To check the
   headers, run this with your hostname; the response lists all nine headers,
   including `content-security-policy` and `strict-transport-security`:

   ```sh
   curl --head https://example.com/
   ```

   **Optional:** run the full live check described in
   [verification](verify.md#public-deployment-checks).

## Update

Run this from the same parent folder. It downloads the latest release into
`./passgen-next` and checks every file, then moves the current site to
`./passgen-previous` (with its file list, `passgen-previous.SHA256SUMS`) and the
new one into place. It replaces the whole site, including old hashed assets,
never deletes anything, and keeps the previous release for rollback. It refuses
to run if a `passgen-previous` backup already exists, if `./passgen` is missing
or a symbolic link, or if `passgen.SHA256SUMS` is missing.

1. Read the release notes on
   [GitHub Releases](https://github.com/mcflycodes/passgen/releases). If they
   mention server config or header changes, apply them to your server config
   first (see your server's page above).
2. Move any `passgen-previous` folder and `passgen-previous.SHA256SUMS` file from
   an earlier update somewhere else.
3. **Only if you installed before this page kept a file list** (there is no
   `passgen.SHA256SUMS` next to `./passgen`): download the list for the version
   you have installed, shown in the page footer, in place of `X.Y.Z`, and check
   the site against it. Every file must say `OK`:

   ```sh
   curl --fail --location --output passgen.SHA256SUMS https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS &&
   (cd ./passgen && sha256sum -c ../passgen.SHA256SUMS)
   ```

4. Run the update. Visitors may see a brief interruption while the folders switch.

   ```sh
   test ! -e ./passgen-previous && test ! -L ./passgen-previous &&
   test ! -e ./passgen-previous.SHA256SUMS && test ! -L ./passgen-previous.SHA256SUMS &&
   test -d ./passgen && test ! -L ./passgen && test -f ./passgen.SHA256SUMS &&
   curl --fail --location --output passgen.zip https://github.com/mcflycodes/passgen/releases/latest/download/passgen.zip &&
   curl --fail --location --output passgen-next.SHA256SUMS https://github.com/mcflycodes/passgen/releases/latest/download/SHA256SUMS &&
   mkdir ./passgen-next &&
   unzip -DD passgen.zip -d ./passgen-next &&
   (cd ./passgen-next && sha256sum -c ../passgen-next.SHA256SUMS) &&
   mv -T ./passgen.SHA256SUMS ./passgen-previous.SHA256SUMS &&
   mv -T ./passgen ./passgen-previous &&
   mv -T ./passgen-next ./passgen &&
   mv -T ./passgen-next.SHA256SUMS ./passgen.SHA256SUMS
   ```

5. **Only if SELinux is enforcing:** relabel the new folder (step 3 of Install).

   ```sh
   sudo restorecon -R /srv/passgen
   ```

6. Reload the page in your browser and check the version in the footer.

## Roll back

To go back to the version before the last update, run this from the same parent
folder. It first checks every file of `./passgen-previous` against the file list
saved with it and makes sure it holds no symbolic links. Only if both checks pass
does it refresh the backup's timestamps (so browsers and CDNs fetch the restored
page instead of keeping the newer one), move the current site to
`./passgen-failed` and put the previous release back. If any check fails, it
stops without changing anything.

1. If you are rolling back right after an update, wait a second first.
2. Run the rollback:

   ```sh
   test -d ./passgen-previous && test ! -L ./passgen-previous && test -f ./passgen-previous.SHA256SUMS &&
   test ! -e ./passgen-failed && test ! -L ./passgen-failed &&
   test ! -e ./passgen-failed.SHA256SUMS && test ! -L ./passgen-failed.SHA256SUMS &&
   (cd ./passgen-previous && sha256sum -c ../passgen-previous.SHA256SUMS) &&
   test -z "$(find -P ./passgen-previous -type l -print)" &&
   find -P ./passgen-previous \( -type f -o -type d \) -exec touch -h -c {} + &&
   mv -T ./passgen.SHA256SUMS ./passgen-failed.SHA256SUMS &&
   mv -T ./passgen ./passgen-failed &&
   mv -T ./passgen-previous ./passgen &&
   mv -T ./passgen-previous.SHA256SUMS ./passgen.SHA256SUMS
   ```

3. **Only if SELinux is enforcing:** run `sudo restorecon -R /srv/passgen` again.
4. If you changed the server config for the update, restore your saved copy, then
   validate and reload the server.
5. Purge your CDN cache, if you use one, and reload the page.

If a checksum line says `FAILED`, the backup has changed since it was installed.
Do not use it: install a fresh copy instead, by moving the backup away and
following [Install](#install) into a new folder.

## Troubleshooting

| Problem | What to do |
|---|---|
| The update or rollback does nothing and prints nothing | One of its safety checks failed: a backup or `passgen-failed` from an earlier run already exists, `./passgen` is missing or a symbolic link, or a `.SHA256SUMS` file is missing. Move old backups away, or run it from the folder that holds `./passgen`. Without `passgen.SHA256SUMS`, follow step 3 of Update. |
| A checksum line says `FAILED` during an update | The download is damaged, or a new release came out between the two downloads. Delete the `./passgen-next` folder and run the update again. Nothing was switched. |
| `mkdir: cannot create directory './passgen-next': File exists` | An earlier run stopped partway. Delete the `./passgen-next` folder, then run the update again. |
| The update stopped after moving `./passgen` away | The old site is in `./passgen-previous` and its file list in `passgen-previous.SHA256SUMS`. Rename them back to `./passgen` and `passgen.SHA256SUMS` before retrying. |
| `mv: invalid option -- 'T'` | You are not using GNU `mv`, for example on macOS. Follow the [self-hosting guide](self-hosting.md#detailed-install-update-and-rollback). |
| 403 Forbidden on every page | On SELinux hosts, run the labeling step above. Otherwise check the server can read the folder and every parent folder, and that the site root is not a symbolic link: the example configs refuse those. |
| 404 for the home page, or another site appears | The config's root path or hostname does not match. Check the absolute folder path and the hostname everywhere in the site config. |
| Headers missing from `curl --head` | The header file is not included, or (nginx) a block with its own `add_header` lost them. See your server's page. |
| The old page still shows after an update | A browser or CDN cache. Purge the CDN cache and reload. |
| Anything else | The [self-hosting guide](self-hosting.md) has the full details, including the server rules, CDN settings and a fully verified install. |
