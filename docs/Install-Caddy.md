# Set up Caddy

PassGen ships a complete Caddy site block and a header file, generated from the
one definition of its security headers. This page installs them for a PassGen
folder you have already put on the server.

**Who it's for:** anyone serving PassGen with Caddy, after
[Install by hand](Install-by-hand.md) or the [install script](Install-script.md).
The [self-hosting guide](self-hosting.md#caddy) explains what each part of the
config does. To run Caddy in Docker instead, see [Docker](Install-Docker.md).

## Before you start

You need:

- Caddy 2 with its main config at `/etc/caddy/Caddyfile`.
- A hostname that serves only PassGen, and `sudo`.
- A certificate and key, or ports 80 and 443 reachable from the internet so Caddy
  can get a certificate itself.
- The PassGen files in a folder, for example `/srv/passgen`. Caddy follows
  symbolic links, so the release must contain none and the server must only be
  able to read it.
- A checkout of the same release tag as your files, for its examples:
  `git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git passgen-setup-X.Y.Z`.

The paths are the same on RHEL, AlmaLinux, Debian and Ubuntu. Run the commands
from the checkout folder.

## Steps

1. List the files this page creates or changes. The backup and rollback commands
   use this list; set it again if you open a new shell.

   ```sh
   FILES="/etc/caddy/Caddyfile /etc/caddy/passgen/passgen-headers.caddy /etc/caddy/passgen/passgen.caddy"
   ```

2. Back up and install in one step. This copies every file in the list that
   already exists to `<file>.previous`, then installs the PassGen files. It
   installs nothing, prints a `Stop:` line and returns an error if `FILES` is
   empty, if an earlier `.previous` backup (even a broken link) is still there,
   or if any copy fails. After a failed copy, move away any `.previous` files it
   made before running it again. It also adds the import line for the site block
   to the end of the main Caddyfile, outside any other site block, unless the
   line is already there.

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
     sudo install -D -m 0644 deploy/examples/caddy/passgen-headers.caddy /etc/caddy/passgen/passgen-headers.caddy &&
     sudo install -m 0644 deploy/examples/caddy/Caddyfile /etc/caddy/passgen/passgen.caddy &&
     { sudo grep -qE '^[[:space:]]*import[[:space:]]+/etc/caddy/passgen/passgen[.]caddy[[:space:]]*$' /etc/caddy/Caddyfile ||
       printf '\nimport /etc/caddy/passgen/passgen.caddy\n' | sudo tee -a /etc/caddy/Caddyfile > /dev/null; } &&
     echo "Installed the PassGen files."
   else
     echo "Stop: nothing was installed."; false
   fi
   ```

   It installs the header file at the path the site block imports, and the
   [site block](../deploy/examples/caddy/Caddyfile) next to it.

3. Edit `/etc/caddy/passgen/passgen.caddy` and replace `example.com`,
   `/srv/passgen` and the certificate and key paths on the `tls` line. Keep every
   header value exactly as shipped.

   **Optional:** delete the `tls` line to let Caddy get and renew a public
   certificate on its own.

4. Validate, and reload only if it says the configuration is valid. Validation
   may read certificates and provision modules.

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

5. Check the site. The first command lists all nine security headers; the second
   must be refused (405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

Keep the `.previous` files until the site works. Move them away before the next
update; step 2 refuses to overwrite them.

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/caddy passgen-setup-X.Y.Z/deploy/examples/caddy
```

If anything changed, move the old `.previous` files away, run steps 1 to 3 from
the new checkout (step 2 backs up your current files first), then validate and
reload as in step 4.

## Roll back

Set `FILES` as in step 1, then put back every file that was backed up. This
also restores the main Caddyfile, which removes the import line after a first
install:

```sh
for f in $FILES; do
  if sudo test -e "$f.previous" || sudo test -L "$f.previous"; then sudo mv -T "$f.previous" "$f" && echo "Restored $f"; fi
done
```

Validate and reload as in step 4. After rolling back a **first** install, the
PassGen files that did not exist before are no longer imported; remove them if
you like:

```sh
sudo rm /etc/caddy/passgen/passgen.caddy /etc/caddy/passgen/passgen-headers.caddy
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `caddy reload` cannot reach the admin endpoint | Caddy is not running, or its admin API is turned off. Start it with your service manager, or reload it the way your setup expects. |
| Certificate errors | With the `tls` line, check the paths and that Caddy can read the files. Without it, check that the hostname points here and ports 80 and 443 are reachable. |
| Headers missing on errors | Keep the example's `handle_errors` block: it adds the headers and `no-cache` to error responses. |
| 403 Forbidden on every page | Caddy cannot read the folder or a parent, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
