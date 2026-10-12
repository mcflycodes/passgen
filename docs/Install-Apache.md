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

The paths below are the ones in the examples, which suit RHEL and AlmaLinux.
On Debian and Ubuntu, Apache's folder is `/etc/apache2`: put the header file
under it and change the `Include` line to match, copy the site config to
`/etc/apache2/sites-available/passgen.conf`, and enable it with
`sudo a2enmod ssl headers` and `sudo a2ensite passgen` before validating.

## Steps

1. Back up any Apache config you will change.

2. From the checkout, install the header file at the path the site config
   includes:

   ```sh
   sudo install -D -m 0644 deploy/examples/apache/passgen-headers.conf /etc/httpd/passgen/passgen-headers.conf
   ```

3. Copy the [site config](../deploy/examples/apache/passgen-site.conf) into
   Apache's config folder:

   ```sh
   sudo install -m 0644 deploy/examples/apache/passgen-site.conf /etc/httpd/conf.d/passgen.conf
   ```

4. Edit the copy and replace, everywhere they appear:

   - `example.com` in `ServerName` and in the Host check
     (`example[.]com` in the `Require expr` line);
   - `/srv/passgen` in `DocumentRoot`, the `<Directory>` line and the
     `REQUEST_FILENAME` containment check;
   - the certificate and key paths;
   - the `Include` path, if you put the header file elsewhere.

   Keep every header value exactly as shipped.

5. Set `ServerTokens Prod` in the global config, if it is not already set.

6. Validate, and reload only if it says `Syntax OK`:

   ```sh
   sudo apachectl configtest
   sudo apachectl graceful
   ```

7. Check the site. The first command lists all nine security headers; the second
   must be refused (403 or 405); the third must be a 404 that also carries them:

   ```sh
   curl --head https://example.com/
   curl --include --request POST https://example.com/
   curl --head https://example.com/missing
   ```

8. **Optional:** add an HTTP-to-HTTPS redirect virtual host if nothing in front
   of Apache does it.

## Update

Before installing a new release, compare its examples with the ones you used:

```sh
diff -ru passgen-setup-OLD/deploy/examples/apache passgen-setup-X.Y.Z/deploy/examples/apache
```

If anything changed, back up your config, apply the change with your hostname
and paths, then validate and reload as in step 6.

## Roll back

Put back the config files you backed up, then validate and reload as in step 6.

## Troubleshooting

| Problem | What to do |
|---|---|
| `Invalid command 'Header'` | mod_headers is not loaded. Enable it. The header file is deliberately not wrapped in `<IfModule>`, so Apache refuses to start without it. |
| 403 Forbidden on every page | The `DocumentRoot` is a symbolic link (switch releases by renaming folders instead), the containment check or Host check still names the example values, or SELinux needs the labeling step from [Install by hand](Install-by-hand.md). |
| Another site answers | The `ServerName` does not match, or another virtual host is the default for the listener. |
| Headers missing or doubled | Make sure the header file is included once, and that no other config sets the same headers. |

The [self-hosting guide](self-hosting.md#server-setup) lists the full server
rules, and [verification](verify.md) the full live check.
