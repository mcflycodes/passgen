# Running PassGen with Docker

The official image, `ghcr.io/mcflycodes/passgen`, is the release build served
over plain HTTP on port 8080 by unprivileged nginx, for amd64 and arm64. It sends
all nine security headers on every response. It does not do HTTPS: put an HTTPS
reverse proxy in front of it, as the recipes below do. The
[HTTPS guide](docker-https.md) covers Caddy, Traefik, nginx with Certbot,
Cloudflare Tunnel and an existing Apache or nginx proxy.

Releases publish the image starting with the first release whose notes mention
it. Until then there is no published digest to deploy; the recipes refuse to
start without one.

PassGen still needs its own hostname. Paths do not isolate it from other pages
on the same origin; see [Before you start](self-hosting.md#before-you-start).

## Quick start

You need Docker Engine with Compose v2, a hostname that serves only PassGen
pointing at this host, and ports 80 and 443 reachable from the internet so Caddy
can obtain a certificate.

```sh
git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git
cd passgen/deploy/compose/caddy-https
cp example.env .env
```

Edit `.env`: set `PASSGEN_DOMAIN` to your hostname and `PASSGEN_IMAGE` to the
verified image reference for the same version (see
[Pin by digest](#pin-by-digest)). Then start it and check the result:

```sh
docker compose up -d
docker compose ps
curl --head https://passgen.example.com/
```

Replace `X.Y.Z` and `passgen.example.com` throughout. Use the recipe folder from
the same release tag as the image, so the configuration matches the image.

## Choose a recipe

Each recipe is a folder under [deploy/compose](../deploy/compose/README.md) with a
`compose.yaml`. CI brings up all four unchanged on amd64 and arm64 and probes
them; see [What CI tests](#what-ci-tests).

| Recipe | What runs | HTTPS | Published ports |
|---|---|---|---|
| `caddy-https` (recommended) | PassGen image and Caddy | Caddy, automatic | 80 and 443, Caddy only |
| `localhost` | PassGen image | Your existing proxy on this host | `127.0.0.1:8080` |
| `caddy-files` | Official Caddy image serving verified release files | Caddy, automatic | 80 and 443 |
| `httpd-files` | Official Apache httpd image serving verified release files | Your existing proxy on this host | `127.0.0.1:8080` |

- **`caddy-https`** is the simplest new installation. PassGen has no published
  port; only Caddy reaches it, over an internal network. Caddy passes PassGen's
  headers through untouched and adds the same generated headers to the responses
  it creates itself, such as its HTTP-to-HTTPS redirect and the 502 page shown
  while PassGen is down.
- **`localhost`** suits a host that already runs Apache, nginx or Caddy with
  working certificates. Point that proxy at `http://127.0.0.1:8080`. The
  [HTTPS guide](docker-https.md#existing-apache-or-nginx-on-the-host) has examples.
- **`caddy-files`** and **`httpd-files`** use no PassGen image. You download and
  verify the release files yourself and mount them read-only into the official
  Caddy or httpd image, with configuration generated from the same templates as
  the [shipped server examples](../deploy/examples/README.md). Choose these if you
  prefer one of those servers or do not want another image to track.

Never publish PassGen as a bare `8080:8080`. That listens on every interface,
bypassing the HTTPS proxy. Use `127.0.0.1:8080:8080` for a proxy on the same
host, or a shared Docker network for a proxy in a container.

### Release files for caddy-files and httpd-files

Inside the recipe folder, download the three versioned assets for the release,
then verify and unpack them into `./passgen`:

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

## Pin by digest

The image has three tags per release: `X.Y.Z`, `X.Y` and `latest`. `X.Y.Z` is
never replaced by project policy, but any tag is only a name. Deploy by digest,
keeping the version in front as a label for people:

```text
ghcr.io/mcflycodes/passgen:X.Y.Z@sha256:<index-digest>
```

When a reference has both, Docker pulls the digest and ignores the tag. Look up
the index digest, the top-level `Digest` line, which covers both architectures:

```sh
docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
```

Verify that digest before putting it in `.env`. The official Caddy and httpd
images in the recipes are pinned the same way. They come from AWS's public copy of
Docker's official images, which avoids Docker Hub's anonymous pull limit; Docker
Hub serves the same digest under `caddy:2.11.7` and `httpd:2.4.69`, which you can
confirm with the same `imagetools inspect` command.

## Verify the image

Each release attests the exact index digest it pushed, recording which workflow
built it from which commit. Check that attestation for the digest you will run:

```sh
gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<index-digest> \
  --repo mcflycodes/passgen \
  --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
  --source-digest "$(git rev-parse 'vX.Y.Z^{commit}')"
```

Run it in the clone from the quick start, so `git rev-parse` gives the release
commit. If `gh` cannot read the registry, run `docker login ghcr.io` first.
Verification proves where and how the image was built. It does not prove the
base image is free of vulnerabilities, and it does not check your proxy; after
deploying, check the live site with the verifier from the same tag and the
release's `SHA256SUMS`:

```sh
node scripts/verify-live.ts --url https://passgen.example.com/ --manifest /path/to/SHA256SUMS
```

For `caddy-files` and `httpd-files`, add `--release-dir` with the path to the
recipe's `passgen` folder so it also checks the complete file set.

## Update and roll back

1. Read the release notes. If configuration or headers changed, update the
   recipe folder from the new tag too.
2. Look up and verify the new digest as above.
3. Edit `.env`, keeping the previous line as a comment for rollback:

   ```sh
   # Previous: PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen:X.Y.Z@sha256:<previous-digest>
   PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen:X.Y.Z@sha256:<new-digest>
   ```

4. Apply it and check the site:

   ```sh
   docker compose pull
   docker compose up -d
   ```

To roll back, put the previous line back and run `docker compose up -d` again.
Docker keeps the old image locally until you prune it, and the registry keeps
published digests.

For `caddy-files` and `httpd-files`, unpack and verify the new release into
`./passgen-next` with the same steps, then swap the folders and recreate the
container, which otherwise keeps serving the old folder it mounted:

```sh
mv passgen passgen-previous
mv passgen-next passgen
docker compose up -d --force-recreate
```

Rolling back is the same swap in reverse.

### Why not Watchtower or automatic updates

Tools that pull a moving tag and restart containers on their own change the
code that generates your passwords without anyone reviewing it. A container
that restarts is not proof that the site still sends the right headers and
bytes. Watchtower's upstream repository is archived, and such tools usually need
the Docker socket, which is root on the host. Deploy by digest, update
deliberately, verify, and keep the previous digest. If you automate anything,
automate the proposal (for example a pull request to your own configuration),
not the deployment.

### Base image refreshes

A published `X.Y.Z` is never rebuilt. When the nginx base image needs a security
update, PassGen ships it as a new patch version, so a base refresh is an ordinary
update. To hear about releases, watch the repository's releases on GitHub.

## What the hardening settings do

| Setting | Effect |
|---|---|
| `user: "101:101"` | Runs as the image's unprivileged nginx user, never root. |
| `read_only: true` | The container cannot change its own files, configuration or site. |
| `tmpfs: /tmp:...,size=16m` | The only writable place: a small in-memory `/tmp` that cannot hold executables. |
| `cap_drop: [ALL]` | No Linux capabilities. Port 8080 needs none. |
| `security_opt: no-new-privileges` | Nothing in the container can gain privileges, for example through setuid files. |
| No `ports`, internal network | Only the proxy on the same internal network can connect, and PassGen has no outside network access. |
| `127.0.0.1:8080:8080` | Reachable only from this host. |
| `create_host_path: false` | A missing folder fails the start instead of being created empty. |

The official Caddy and httpd images are general-purpose and cannot match the
PassGen image exactly:

- **Caddy** runs as root inside its container. The recipes drop every capability
  except `NET_BIND_SERVICE` (to listen on 80 and 443), make the root filesystem
  read-only and set no-new-privileges, but Caddy must write certificates and keys
  to its `caddy_data` volume. Back that volume up and keep it private.
- **httpd** runs as UID 65534 (`nobody`) with the same flags as the PassGen image,
  bypassing the image's start script and loading only the modules the site
  needs. Its image is larger and includes modules and tools the recipe does not
  use.
- Neither has a built-in health check; the PassGen image does.

The recipes set no memory, CPU or process limits, because suitable values depend
on the host; add them after measuring. Log rotation belongs in your Docker daemon
configuration. Rootless Docker or user namespace remapping reduces the risk from
the root-running Caddy container further.

## What CI tests

On every code change, CI builds the PassGen image locally on amd64 and arm64,
brings up each recipe with its `compose.yaml` and generated configuration
unchanged, and checks:

- every release file with GET and HEAD, plus 304, 404, refused methods (405) and
  refused paths (403), each with all nine headers exactly once and the right
  cache policy (Apache: 304 via `If-Modified-Since`, since its examples disable
  ETags);
- the live bytes against the build manifest, with the verifier;
- Caddy's HTTP-to-HTTPS redirect and, for `caddy-https`, its 502 while PassGen is
  stopped, both with all nine headers;
- the hardening flags as Docker applied them, the exact published ports, that
  PassGen is unreachable from Caddy's public network and that the loopback
  recipes do not answer on the runner's other addresses.

CI uses Caddy's internal test CA for a `.localhost` name; public certificate
issuance and renewal, real DNS and the other proxies in the HTTPS guide are not
tested.
