# Install by hand

The shortest way to run PassGen on your own web server: download one ZIP, unzip
it into a folder and point your web server at that folder. No build, no scripts.

**Who it's for:** anyone with shell access to a Linux server that already runs
Apache, nginx or Caddy. For one command that also verifies, backs up and rolls
back, use the [install script](Install-script.md). For a container, see
[Docker](Install-Docker.md). Without shell access, see
[Static hosts and CDNs](Static-hosts-and-CDNs.md).

## Before you start

You need:

- A hostname that serves only PassGen, with HTTPS already working. Other pages
  on the same origin could read generated passwords, so a path next to another
  site is not enough. See [Before you start](self-hosting.md#before-you-start).
- A Linux shell with `curl`, `unzip` and GNU `mv` (for `mv -T`). On macOS,
  follow the [self-hosting guide](self-hosting.md#detailed-install-update-and-rollback) instead.
- A writable parent folder **outside** every web root, which the web server can
  traverse. The site folder (`./passgen`) and its backups live there.
- A normal umask such as `022`, so the web server can read the files.
- Permission to edit and reload your web server's configuration.

## Install

1. Go to the parent folder. Download the latest release and unzip it into a new
   site folder (`./passgen` here):

   ```sh
   curl --fail --location --output passgen.zip https://github.com/mcflycodes/passgen/releases/latest/download/passgen.zip &&
   unzip -DD passgen.zip -d ./passgen
   ```

   `unzip -DD` skips the archive's timestamps, so the new files get the current
   time and browsers and CDNs do not keep an older page.

   **Optional: check the download first.** Instead of the `curl` line above, look
   up the latest version on
   [GitHub Releases](https://github.com/mcflycodes/passgen/releases), replace
   `X.Y.Z` with it, and download that exact release with its checksum and file
   list. Continue only if the check says `OK`:

   ```sh
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen.zip &&
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen.zip.sha256 &&
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS &&
   sha256sum -c passgen.zip.sha256
   ```

   Then run the `unzip` line above and check every unpacked file. Every line must
   say `OK`. Keep `SHA256SUMS` outside the web root for later checks:

   ```sh
   (cd passgen && sha256sum -c ../SHA256SUMS)
   ```

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
`./passgen-next`, moves the current site to `./passgen-previous` and the new one
into place. It replaces the whole site, including old hashed assets, never
deletes anything, and keeps the previous folder for rollback. It refuses to run
if a `passgen-previous` backup already exists or if `./passgen` is missing or a
symbolic link.

1. Read the release notes on
   [GitHub Releases](https://github.com/mcflycodes/passgen/releases). If they
   mention server config or header changes, apply them to your server config
   first (see your server's page above).
2. Move any `passgen-previous` folder from an earlier update somewhere else.
3. Run the update. Stop if it prints an error. Visitors may see a brief
   interruption while the folders switch.

   ```sh
   test ! -e ./passgen-previous && test ! -L ./passgen-previous &&
   test -d ./passgen && test ! -L ./passgen &&
   curl --fail --location --output passgen.zip https://github.com/mcflycodes/passgen/releases/latest/download/passgen.zip &&
   mkdir ./passgen-next &&
   unzip -DD passgen.zip -d ./passgen-next &&
   mv -T ./passgen ./passgen-previous &&
   mv -T ./passgen-next ./passgen
   ```

4. **Only if SELinux is enforcing:** relabel the new folder (step 3 of Install).

   ```sh
   sudo restorecon -R /srv/passgen
   ```

5. Reload the page in your browser and check the version in the footer.

## Roll back

To go back to the version before the last update, run these from the same parent
folder. They move the broken site to `./passgen-failed` and put
`./passgen-previous` back.

1. Check that the backup holds no symbolic links. If this prints anything, stop.

   ```sh
   find -P ./passgen-previous -type l -print
   ```

2. Refresh the backup's timestamps, so browsers and CDNs fetch the restored page
   instead of keeping the newer one. If you are rolling back right after an
   update, wait a second first.

   ```sh
   find -P ./passgen-previous \( -type f -o -type d \) -exec touch -h -c {} +
   ```

3. Switch the folders:

   ```sh
   test -d ./passgen-previous && test ! -L ./passgen-previous &&
   test ! -e ./passgen-failed && test ! -L ./passgen-failed &&
   mv -T ./passgen ./passgen-failed &&
   mv -T ./passgen-previous ./passgen
   ```

4. **Only if SELinux is enforcing:** run `sudo restorecon -R /srv/passgen` again.
5. If you changed the server config for the update, restore your saved copy, then
   validate and reload the server.
6. Purge your CDN cache, if you use one, and reload the page.

## Troubleshooting

| Problem | What to do |
|---|---|
| The update command does nothing and prints nothing | One of its safety checks failed: `./passgen-previous` already exists, or `./passgen` is missing or a symbolic link. Move the old backup away, or run the update from the folder that holds `./passgen`. |
| `mkdir: cannot create directory './passgen-next': File exists` | An earlier run stopped partway. Delete the `./passgen-next` folder, then run the update again. |
| The update stopped after moving `./passgen` away | The old site is in `./passgen-previous`. Rename it back to `./passgen` before retrying. |
| `mv: invalid option -- 'T'` | You are not using GNU `mv`, for example on macOS. Follow the [self-hosting guide](self-hosting.md#detailed-install-update-and-rollback). |
| 403 Forbidden on every page | On SELinux hosts, run the labeling step above. Otherwise check the server can read the folder and every parent folder, and that the site root is not a symbolic link: the example configs refuse those. |
| 404 for the home page, or another site appears | The config's root path or hostname does not match. Check the absolute folder path and the hostname everywhere in the site config. |
| Headers missing from `curl --head` | The header file is not included, or (nginx) a block with its own `add_header` lost them. See your server's page. |
| The old page still shows after an update | A browser or CDN cache. Purge the CDN cache and reload. |
| Anything else | The [self-hosting guide](self-hosting.md) has the full details, including the server rules, CDN settings and a fully verified install. |
