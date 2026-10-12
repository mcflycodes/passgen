# Set up nginx

PassGen ships a complete nginx site config and a header file, generated from the
one definition of its security headers. This page installs them for a PassGen
folder you have already put on the server.

**Who it's for:** anyone serving PassGen with nginx, after
[Install by hand](Install-by-hand.md) or the [install script](Install-script.md).
The [self-hosting guide](self-hosting.md#nginx) explains what each part of the
config does.

## Before you start

You need:

- nginx with HTTPS support, and the standard `mime.types` table loaded in
  `http {}` (the default `nginx.conf` does this).
- A hostname that serves only PassGen, its certificate and key, and `sudo`.
- The PassGen files in a real folder (not a symbolic link), for example
  `/srv/passgen`.
- A checkout of the same release tag as your files, for its examples:
  `git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git passgen-setup-X.Y.Z`.

The site config goes inside `http {}`. The default `nginx.conf` on RHEL,
AlmaLinux, Debian and Ubuntu includes every `/etc/nginx/conf.d/*.conf` file
there, so the commands below work on all of them. Run them from the checkout
folder.

## Steps

1. List the files this page creates or changes. The backup and rollback commands
   use this list; set it again if you open a new shell.

   ```sh
   FILES="/etc/nginx/passgen/passgen-headers.conf /etc/nginx/conf.d/passgen.conf"
   ```

2. Back up and install in one step. This copies every file in the list that
   already exists to `<file>.previous`, then installs the PassGen files. It
   installs nothing, prints a `Stop:` line and returns an error if `FILES` is
   empty, if an earlier `.previous` backup (even a broken link) is still there,
   or if any copy fails. After a failed copy, move away any `.previous` files it
   made before running it again. nginx does not load the `.previous` files,
   since they do not end in `.conf`.

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
     sudo install -D -m 0644 deploy/examples/nginx/passgen-headers.conf /etc/nginx/passgen/passgen-headers.conf &&
     sudo install -m 0644 deploy/examples/nginx/passgen-site.conf /etc/nginx/conf.d/passgen.conf &&
     echo "Installed the PassGen files."
   else
     echo "Stop: nothing was installed."; false
   fi
   ```

   It installs the header file at the path the site config includes, and the
   [site config](../deploy/examples/nginx/passgen-site.conf).

3. Edit `/etc/nginx/conf.d/passgen.conf` and replace `example.com` in
   `server_name`, `/srv/passgen` in `root`, and the certificate and key paths.
   Keep every header value exactly as shipped.

4. Validate, and reload only if the test is successful:

   ```sh
   sudo nginx -t
   sudo nginx -s reload
   ```

5. Check the site. The first command lists all nine security headers; the second
   must be refused (405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

6. **Optional:** add an HTTP-to-HTTPS redirect server on port 80 if nothing in
   front of nginx does it. Review other sites before changing the listener's
   default site.

Keep the `.previous` files until the site works. Move them away before the next
update; step 2 refuses to overwrite them.

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/nginx passgen-setup-X.Y.Z/deploy/examples/nginx
```

If anything changed, move the old `.previous` files away, run steps 1 to 3 from
the new checkout (step 2 backs up your current files first), then validate and
reload as in step 4.

## Roll back

Set `FILES` as in step 1, then put back every file that was backed up:

```sh
for f in $FILES; do
  if sudo test -e "$f.previous" || sudo test -L "$f.previous"; then sudo mv -T "$f.previous" "$f" && echo "Restored $f"; fi
done
```

Validate and reload as in step 4.

Files that did not exist before were not backed up, so they stay. After rolling
back a **first** install, remove PassGen's own files too, then validate and
reload:

```sh
sudo rm /etc/nginx/conf.d/passgen.conf /etc/nginx/passgen/passgen-headers.conf
```

## Troubleshooting

| Problem | What to do |
|---|---|
| Some responses lack the headers | nginx stops inheriting `add_header` in any block that declares its own. Every such block must include the header file again, as the example does. |
| 404 for the home page | The `root` is a symbolic link (the example disables symlinks; switch releases by renaming folders) or does not match the folder. |
| 403 Forbidden on every page | nginx cannot read the folder or a parent, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |
| Another site answers | The `server_name` does not match, or another server is the default for the listener. |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
