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

## Steps

1. Back up `/etc/caddy/Caddyfile`.

2. From the checkout, install the header file at the path the site block imports,
   and the [site block](../deploy/examples/caddy/Caddyfile) next to it:

   ```sh
   sudo install -D -m 0644 deploy/examples/caddy/passgen-headers.caddy /etc/caddy/passgen/passgen-headers.caddy
   sudo install -m 0644 deploy/examples/caddy/Caddyfile /etc/caddy/passgen/passgen.caddy
   ```

3. Edit `/etc/caddy/passgen/passgen.caddy` and replace `example.com`,
   `/srv/passgen` and the certificate and key paths on the `tls` line. Keep every
   header value exactly as shipped.

   **Optional:** delete the `tls` line to let Caddy get and renew a public
   certificate on its own.

4. Add this line to `/etc/caddy/Caddyfile`, outside any other site block:

   ```caddyfile
   import /etc/caddy/passgen/passgen.caddy
   ```

5. Validate, and reload only if it says the configuration is valid. Validation
   may read certificates and provision modules.

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

6. Check the site. The first command lists all nine security headers; the second
   must be refused (405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/caddy passgen-setup-X.Y.Z/deploy/examples/caddy
```

If anything changed, back up your config, apply the change with your hostname
and paths, then validate and reload as in step 5.

## Roll back

Put back the files you backed up, then validate and reload as in step 5.

## Troubleshooting

| Problem | What to do |
|---|---|
| `caddy reload` cannot reach the admin endpoint | Caddy is not running, or its admin API is turned off. Start it with your service manager, or reload it the way your setup expects. |
| Certificate errors | With the `tls` line, check the paths and that Caddy can read the files. Without it, check that the hostname points here and ports 80 and 443 are reachable. |
| Headers missing on errors | Keep the example's `handle_errors` block: it adds the headers and `no-cache` to error responses. |
| 403 Forbidden on every page | Caddy cannot read the folder or a parent, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
