# Docker recipes without the PassGen image

The main Docker page is [Install with Docker](Install-Docker.md): the image, its
parameters, setup behind HTTPS, support commands and updates. This page covers
what is specific to the two recipes that serve verified release files with an
official server image instead, and what CI tests for all four recipes.

Setting `PASSGEN_IMAGE` for the `caddy-https` or `localhost` recipe? See
[Pin by digest](Install-Docker.md#pin-by-digest) and
[Verify provenance](Install-Docker.md#verify-provenance).

| Topic | Where it is now |
|---|---|
| Quick start and choosing a recipe | [Application setup](Install-Docker.md#application-setup) |
| Pinning and verifying the image | [Updating info](Install-Docker.md#updating-info) |
| Updating and rolling back the image | [Via Docker Compose](Install-Docker.md#via-docker-compose) |
| Why not Watchtower | [Why not Watchtower or automatic updates](Install-Docker.md#why-not-watchtower-or-automatic-updates) |
| What the hardening settings do | [Miscellaneous options](Install-Docker.md#miscellaneous-options) |
| HTTPS proxies | [HTTPS in front of the container](docker-https.md) |

## Release files for caddy-files and httpd-files

`caddy-files` and `httpd-files` use no PassGen image. You download and verify the
release files yourself and mount them read-only into the official Caddy or httpd
image, with configuration generated from the same templates as the
[shipped server examples](../deploy/examples/README.md). Choose these if you
prefer one of those servers or do not want another image to track.

Download the recipe folder from the release tag as in
[Set up caddy-https](Install-Docker.md#set-up-caddy-https), using
`caddy-files` or `httpd-files` in place of `caddy-https`. Inside the recipe
folder, download the three versioned assets for the release, then verify and
unpack them into `./passgen`:

```sh
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/passgen-X.Y.Z.zip.sha256
curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
```

```sh
sha256sum -c passgen-X.Y.Z.zip.sha256
unzip -DD passgen-X.Y.Z.zip -d ./passgen
(cd passgen && sha256sum -c ../SHA256SUMS)
```

Continue only if every checksum says `OK`; otherwise, stop.

```sh
find -P passgen -type l -print
```

If this prints anything, stop: the release contains a symbolic link. Do not continue.

```sh
find -P passgen \( -type f -o -type d \) -exec touch -h -c {} +
chmod -R u=rwX,go=rX passgen
```

The timestamp refresh stops browsers and caches keeping an older page because of
the reproducible archive's 1980 dates. The files must be world-readable: httpd
runs as UID 65534. Keep `SHA256SUMS` for verifying the live site later. For
`caddy-files`, also `cp example.env .env` and set `PASSGEN_DOMAIN`. Then run
`docker compose up -d`.

On a host with SELinux enforcing, the containers cannot read the bind-mounted
folders until they are labeled for container use, for example with
`chcon -R -t container_file_t caddy passgen` (or `httpd passgen`).

To check the live site, run the verifier from the same tag with
`--release-dir` and the path to the recipe's `passgen` folder, so it also checks
the complete file set:

```sh
node ../../../scripts/verify-live.ts --url https://passgen.example.com/ --manifest /path/to/SHA256SUMS --release-dir /path/to/passgen
```

## Update and roll back the files recipes

Read the release notes. If configuration or headers changed, update the recipe
folder from the new tag too, as in
[Via Docker Compose](Install-Docker.md#via-docker-compose). Unpack and verify the
new release into `./passgen-next` with the same steps as above, then swap the
folders and recreate the container, which otherwise keeps serving the old folder
it mounted:

```sh
mv passgen passgen-previous
mv passgen-next passgen
docker compose up -d --force-recreate
```

Rolling back is the same swap in reverse.

## How the server images differ from the PassGen image

The official Caddy and httpd images are general-purpose and cannot match the
PassGen image exactly:

- **Caddy** runs as root inside its container; see
  [Non-root operation](Install-Docker.md#non-root-operation). It must write
  certificates and keys to its `caddy_data` volume. Back that volume up and keep
  it private.
- **httpd** runs as UID 65534 (`nobody`) with the same flags as the PassGen image,
  bypassing the image's start script and loading only the modules the site
  needs. Its image is larger and includes modules and tools the recipe does not
  use.
- Neither has a built-in health check; the PassGen image does.
- Both bind-mount their generated configuration folder and the release files
  read-only, with `create_host_path: false`, so a missing folder fails the start
  instead of being created empty.

## What CI tests

On every code change, CI builds the PassGen image locally on amd64 and arm64,
brings up each recipe with its `compose.yaml` and generated configuration
unchanged, and checks:

- every release file with GET and HEAD, plus 304 and 404, each with all nine
  headers exactly once and the right cache policy (Apache: 304 via
  `If-Modified-Since`, since its examples disable ETags);
- refused methods (405) and refused paths (403), each with all nine headers
  exactly once;
- the live bytes against the build manifest, with the verifier;
- Caddy's HTTP-to-HTTPS redirect and, for `caddy-https`, its 502 while PassGen is
  stopped, both with all nine headers;
- the hardening flags as Docker applied them, the exact published ports, that
  PassGen is unreachable from Caddy's public network and that the loopback
  recipes do not answer on the runner's other addresses.

CI also runs the image on its own on `127.0.0.1:8080` with the read-only,
`/tmp` tmpfs, dropped-capability and no-new-privileges flags shown under
[Usage](Install-Docker.md#usage), and checks its user, labels, health check,
file ownership, that only `/tmp` is writable, and that it stops cleanly.

CI uses Caddy's internal test CA for a `.localhost` name; public certificate
issuance and renewal, real DNS and the other proxies in the HTTPS guide are not
tested.
