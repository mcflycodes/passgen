# Static hosts and CDNs

PassGen is a folder of static files, so any static host can serve it: Cloudflare
Pages, Netlify or any other host that publishes a folder. This page covers
publishing there, and the settings that matter when a CDN or proxy sits in front
of any server.

**Who it's for:** anyone without shell access to a web server, or with a CDN in
front of one. With a Linux server, see [Install by hand](Install-by-hand.md) or
the [install script](Install-script.md). The
[self-hosting guide](self-hosting.md#server-setup) has every detail.

## Before you start

You need:

- A hostname that serves only PassGen. See
  [Before you start](self-hosting.md#before-you-start).
- An account on the host, with a project that has no Functions, form handling,
  injected scripts or "single-page app" fallback.
- A shell with `curl`, `unzip` and `sha256sum` to prepare the files (on macOS,
  `shasum -a 256 -c` in place of `sha256sum -c`).
- The version to publish, `X.Y.Z`, from
  [GitHub Releases](https://github.com/mcflycodes/passgen/releases).

A release ZIP uses the shipped configuration. To change it, build from source;
see [Configuration](Configuration.md).

## Publish

1. Download the release and its checksum files into a working folder:

   ```sh
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip.sha256
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
   ```

2. Check the ZIP, unpack it and check every file:

   ```sh
   sha256sum -c passgen-X.Y.Z.zip.sha256
   mkdir payload
   unzip passgen-X.Y.Z.zip -d payload
   (cd payload && sha256sum -c ../SHA256SUMS)
   ```

   Continue only if every checksum says `OK`; otherwise, stop.

3. Check for symbolic links. If this prints anything, stop:

   ```sh
   find -P payload -type l -print
   ```

4. Refresh the timestamps, so the archive's 1980 dates do not make browsers and
   CDNs keep an older page:

   ```sh
   find -P payload \( -type f -o -type d \) -exec touch -h -c {} +
   ```

5. Copy the files into a publishing folder. Keep `payload` itself unchanged, so
   it still matches `SHA256SUMS`:

   ```sh
   cp -R payload publish
   ```

   Then save your host's header file into `publish/`, next to `index.html`:

   - **Cloudflare Pages:** [`_headers`](../deploy/examples/cloudflare-pages/_headers).
     Pages may need a top-level `404.html` so missing paths are not answered
     with the page; an added page needs its own reviewed manifest.
   - **Netlify:** [`_headers`](../deploy/examples/netlify/_headers). Check the
     platform reads the file rather than serving it.
   - **Any other host:** set the headers from the
     [generated header table](../deploy/examples/README.md) in the host's
     settings.

6. Upload the publishing folder with the host's normal deploy method.

7. Check the public site: the page loads, `curl --head` with your URL lists all
   nine security headers, a missing path is a 404 with the same headers, and a
   `POST` is refused. Hosts that cannot do this need an edge rule; see
   [Any static host](self-hosting.md#any-static-host).

8. **Optional:** run the full live check from a checkout of the same tag; see
   [verification](verify.md#public-deployment-checks).

## CDN and proxy settings

These apply to any CDN or proxy in front of PassGen, including one in front of
your own server. Changing the page's bytes breaks the checksums and can break or
weaken the Content Security Policy.

- **Turn off** HTML rewriting, script injection, email obfuscation, HTML, JS and
  CSS minification, script optimisers, analytics or RUM injection and font
  injection.
- **Avoid** stale-page or offline snapshots, HTML cache-time overrides, "cache
  everything" rules and script challenges that replace the page. Compression is
  fine.
- **Keep** the origin's caching: HTML is revalidated every time, and only
  fingerprinted files are cached for long.
- **HTTPS:** use a valid origin certificate, strict certificate checking at the
  CDN, and a permanent HTTP-to-HTTPS redirect.
- **Optional:** allow only your CDN's addresses to reach the origin; see
  [Optional raw-peer restrictions](self-hosting.md#optional-raw-peer-restrictions).

The [CDN and proxy settings](self-hosting.md#cdn-and-proxy-settings) section has
the full list, including the Cloudflare feature names.

## Update

Repeat the steps with the new version in a fresh working folder, then deploy it
as a complete replacement, not on top of the old files. Purge the CDN cache
afterwards.

## Roll back

Use your host's rollback to the previous deployment (both Pages and Netlify keep
earlier deploys), or publish the previous verified folder again after refreshing
its timestamps as in step 4. Purge the CDN cache afterwards.

## Troubleshooting

| Problem | What to do |
|---|---|
| Headers missing | The `_headers` file is not next to `index.html` in the published folder, or the host does not read it. Add the headers in the host's settings instead. |
| Missing paths show the page with 200 | The host is falling back to `index.html`. Turn off the single-page app fallback, or add a `404.html` where needed. |
| The page is blank and the console reports a CSP error | A CDN or host feature is changing or injecting scripts. Turn it off (see above). |
| The old page still shows | Purge the CDN cache. |
