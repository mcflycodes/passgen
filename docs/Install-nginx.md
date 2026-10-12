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

The site config goes inside `http {}`. On RHEL and AlmaLinux, files in
`/etc/nginx/conf.d/` are included there, as below. On Debian and Ubuntu, put it
in `/etc/nginx/sites-available/` and link it from `/etc/nginx/sites-enabled/`.

## Steps

1. Back up any nginx config you will change.

2. From the checkout, install the header file at the path the site config
   includes:

   ```sh
   sudo install -D -m 0644 deploy/examples/nginx/passgen-headers.conf /etc/nginx/passgen/passgen-headers.conf
   ```

3. Copy the [site config](../deploy/examples/nginx/passgen-site.conf):

   ```sh
   sudo install -m 0644 deploy/examples/nginx/passgen-site.conf /etc/nginx/conf.d/passgen.conf
   ```

4. Edit the copy and replace `example.com` in `server_name`, `/srv/passgen` in
   `root`, the certificate and key paths, and every `include` path if you put
   the header file elsewhere. Keep every header value exactly as shipped.

5. Validate, and reload only if the test is successful:

   ```sh
   sudo nginx -t
   sudo nginx -s reload
   ```

6. Check the site. The first command lists all nine security headers; the second
   must be refused (405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

7. **Optional:** add an HTTP-to-HTTPS redirect server on port 80 if nothing in
   front of nginx does it. Review other sites before changing the listener's
   default site.

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/nginx passgen-setup-X.Y.Z/deploy/examples/nginx
```

If anything changed, back up your config, apply the change with your hostname
and paths, then validate and reload as in step 5.

## Roll back

Put back the config files you backed up, then validate and reload as in step 5.

## Troubleshooting

| Problem | What to do |
|---|---|
| Some responses lack the headers | nginx stops inheriting `add_header` in any block that declares its own. Every such block must include the header file again, as the example does. |
| 404 for the home page | The `root` is a symbolic link (the example disables symlinks; switch releases by renaming folders) or does not match the folder. |
| 403 Forbidden on every page | nginx cannot read the folder or a parent, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |
| Another site answers | The `server_name` does not match, or another server is the default for the listener. |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
