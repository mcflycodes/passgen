# Set up Apache

PassGen ships a complete Apache site config and a header file, generated from the
one definition of its security headers. This page installs them for a PassGen
folder you have already put on the server.

**Who it's for:** anyone serving PassGen with Apache httpd, after
[Install by hand](Install-by-hand.md) or the [install script](Install-script.md).
The [self-hosting guide](self-hosting.md#apache) explains what each part of the
config does.

## Before you start

You need:

- Apache httpd with mod_ssl, mod_headers, mod_authz_core and mod_mime, and an
  existing HTTPS listener (port 443).
- A hostname that serves only PassGen, its certificate and key, and `sudo`.
- The PassGen files in a real folder (not a symbolic link), for example
  `/srv/passgen`.
- A checkout of the same release tag as your files, for its examples:
  `git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git passgen-setup-X.Y.Z`.

The commands below come in two versions where the paths differ: RHEL and
AlmaLinux (`/etc/httpd`, the paths in the examples) and Debian and Ubuntu
(`/etc/apache2`). Run them from the checkout folder.

## Steps

1. List the files this page creates or changes, for your system. The backup and
   rollback commands use this list; set it again if you open a new shell.

   RHEL and AlmaLinux:

   ```sh
   FILES="/etc/httpd/passgen/passgen-headers.conf /etc/httpd/conf.d/passgen.conf /etc/httpd/conf/httpd.conf"
   ```

   Debian and Ubuntu:

   ```sh
   FILES="/etc/apache2/passgen/passgen-headers.conf /etc/apache2/sites-available/passgen.conf /etc/apache2/conf-available/security.conf"
   ```

2. Back up and install in one step. This copies every file in the list that
   already exists to `<file>.previous`, then installs the PassGen files. It
   installs nothing, prints a `Stop:` line and returns an error if `FILES` is
   empty, if an earlier `.previous` backup (even a broken link) is still there,
   or if any copy fails. After a failed copy, move away any `.previous` files it
   made before running it again. It installs the header file and the [site
   config](../deploy/examples/apache/passgen-site.conf).

   RHEL and AlmaLinux:

   ```sh
   ok=yes
   [ -n "$FILES" ] || { echo "Stop: FILES is empty. Set it as in step 1."; ok=no; }
   for f in $FILES; do
     if sudo test -e "$f.previous" || sudo test -L "$f.previous"; then
       echo "Stop: $f.previous already exists. Move it away first."; ok=no
     fi
   done
   if [ "$ok" = yes ]; then
     for f in $FILES; do
       if sudo test -e "$f" || sudo test -L "$f"; then
         if sudo cp -a "$f" "$f.previous"; then echo "Backed up $f"; else echo "Stop: could not back up $f."; ok=no; break; fi
       fi
     done
   fi
   if [ "$ok" = yes ]; then
     sudo install -D -m 0644 deploy/examples/apache/passgen-headers.conf /etc/httpd/passgen/passgen-headers.conf &&
     sudo install -m 0644 deploy/examples/apache/passgen-site.conf /etc/httpd/conf.d/passgen.conf &&
     echo "Installed the PassGen files."
   else
     echo "Stop: nothing was installed."; false
   fi
   ```

   Debian and Ubuntu (this also points the `Include` line at `/etc/apache2` and
   enables the modules and the site; mod_authz_core and mod_mime are on by
   default):

   ```sh
   ok=yes
   [ -n "$FILES" ] || { echo "Stop: FILES is empty. Set it as in step 1."; ok=no; }
   for f in $FILES; do
     if sudo test -e "$f.previous" || sudo test -L "$f.previous"; then
       echo "Stop: $f.previous already exists. Move it away first."; ok=no
     fi
   done
   if [ "$ok" = yes ]; then
     for f in $FILES; do
       if sudo test -e "$f" || sudo test -L "$f"; then
         if sudo cp -a "$f" "$f.previous"; then echo "Backed up $f"; else echo "Stop: could not back up $f."; ok=no; break; fi
       fi
     done
   fi
   if [ "$ok" = yes ]; then
     sudo install -D -m 0644 deploy/examples/apache/passgen-headers.conf /etc/apache2/passgen/passgen-headers.conf &&
     sudo install -m 0644 deploy/examples/apache/passgen-site.conf /etc/apache2/sites-available/passgen.conf &&
     sudo sed -i 's#/etc/httpd/passgen/#/etc/apache2/passgen/#' /etc/apache2/sites-available/passgen.conf &&
     sudo a2enmod ssl headers &&
     sudo a2ensite passgen &&
     echo "Installed the PassGen files."
   else
     echo "Stop: nothing was installed."; false
   fi
   ```

3. Edit the installed site config and replace, everywhere they appear:

   - `example.com` in `ServerName` and in the Host check
     (`example[.]com` in the `Require expr` line);
   - `/srv/passgen` in `DocumentRoot`, the `<Directory>` line and the
     `REQUEST_FILENAME` containment check;
   - the certificate and key paths.

   Keep every header value exactly as shipped.

4. Set `ServerTokens Prod` in the global config if it is not already set:
   `/etc/httpd/conf/httpd.conf` on RHEL and AlmaLinux,
   `/etc/apache2/conf-available/security.conf` on Debian and Ubuntu.

5. Validate, and reload only if it says `Syntax OK`:

   ```sh
   sudo apachectl configtest
   sudo apachectl graceful
   ```

6. Check the site. The first command lists all nine security headers; the second
   must be refused (403 or 405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

7. **Optional:** add an HTTP-to-HTTPS redirect virtual host if nothing in front
   of Apache does it.

Keep the `.previous` files until the site works. Move them away before the next
update; step 2 refuses to overwrite them.

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/apache passgen-setup-X.Y.Z/deploy/examples/apache
```

If anything changed, move the old `.previous` files away, run steps 1 to 3 from
the new checkout (step 2 backs up your current files first), then validate and
reload as in step 5.

## Roll back

Set `FILES` as in step 1, then put back every file that was backed up:

```sh
for f in $FILES; do
  if sudo test -e "$f.previous" || sudo test -L "$f.previous"; then sudo mv -T "$f.previous" "$f" && echo "Restored $f"; fi
done
```

Validate and reload as in step 5.

Files that did not exist before were not backed up, so they stay. After rolling
back a **first** install, remove PassGen's own files too, then validate and
reload. RHEL and AlmaLinux:

```sh
sudo rm /etc/httpd/conf.d/passgen.conf /etc/httpd/passgen/passgen-headers.conf
```

Debian and Ubuntu:

```sh
sudo a2dissite passgen
sudo rm /etc/apache2/sites-available/passgen.conf /etc/apache2/passgen/passgen-headers.conf
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `Invalid command 'Header'` | mod_headers is not loaded. Enable it. The header file is deliberately not wrapped in `<IfModule>`, so Apache refuses to start without it. |
| 403 Forbidden on every page | The `DocumentRoot` is a symbolic link (switch releases by renaming folders instead), the containment check or Host check still names the example values, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |
| Another site answers | The `ServerName` does not match, or another virtual host is the default for the listener. |
| Headers missing or doubled | Make sure the header file is included once, and that no other config sets the same headers. |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
