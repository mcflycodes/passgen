# Install with Docker

The official image, `ghcr.io/mcflycodes/passgen`, is the PassGen release build
served by unprivileged nginx over plain HTTP on port 8080. It sends all nine
security headers on every response, runs as a non-root user on a read-only
filesystem, and takes no environment variables or volumes. It does not do
HTTPS: something in front of it must.

Replace `X.Y.Z`, `<index-digest>` and `passgen.example.com` with your own values
throughout. Versions are listed on
[GitHub Releases](https://github.com/mcflycodes/passgen/releases); the image was
first published with release 1.4.0.

## Supported architectures

Each release is one multi-platform image. Pulling any tag or digest gets the
right architecture for the host automatically.

| Architecture | Available | Tag |
|---|---|---|
| x86-64 | Yes | `X.Y.Z`, `X.Y`, `latest` |
| arm64 | Yes | `X.Y.Z`, `X.Y`, `latest` |
| armhf | No | |

| Tag | Meaning |
|---|---|
| `X.Y.Z` | One release. Never replaced or rebuilt once published. |
| `X.Y` | The most recently published release in that series. |
| `latest` | The most recently published release. |

Tags are only names. Deploy by digest; see [Pin by digest](#pin-by-digest).

## Application setup

The container serves plain HTTP on port 8080 and never handles TLS, so put it
behind an HTTPS reverse proxy on a hostname that serves only PassGen. Paths do
not isolate it from other pages on the same origin; see
[Before you start](self-hosting.md#before-you-start).

Pick one of the Compose recipes in [deploy/compose](../deploy/compose/README.md).
CI brings up all four unchanged on amd64 and arm64 and probes them; see
[What CI tests](docker.md#what-ci-tests).

| Recipe | What runs | HTTPS | Published ports |
|---|---|---|---|
| `caddy-https` (recommended) | PassGen image and Caddy | Caddy, automatic | 80 and 443, Caddy only |
| `localhost` | PassGen image | Your existing proxy on this host | `127.0.0.1:8080` |
| `caddy-files` | Official Caddy image serving verified release files | Caddy, automatic | 80 and 443 |
| `httpd-files` | Official Apache httpd image serving verified release files | Your existing proxy on this host | `127.0.0.1:8080` |

- **`caddy-https`** is the simplest new installation. PassGen publishes no port;
  only Caddy reaches it, over an internal network. Caddy gets and renews the
  certificate, passes PassGen's headers through untouched, and adds the same
  headers to the responses it creates itself, such as its HTTP-to-HTTPS redirect
  and the 502 page shown while PassGen is down. The internal backend network
  also prevents PassGen from accessing outside networks.
- **`localhost`** suits a host that already runs Apache, nginx or Caddy with
  working certificates. Point that proxy at `http://127.0.0.1:8080`. It is the
  recipe shown under [Usage](#usage).
- **`caddy-files`** and **`httpd-files`** use no PassGen image: you mount
  verified release files into an official server image. See
  [Docker recipes without the PassGen image](docker.md#release-files-for-caddy-files-and-httpd-files).

Other proxies, including Traefik, nginx with Certbot, Cloudflare Tunnel and an
existing Apache or nginx on the host, and the rules every proxy must follow, are
in [HTTPS in front of the container](docker-https.md).

Never publish the container on every interface. Use `127.0.0.1:8080:8080` for a
proxy on the same host, or a shared Docker network for a proxy in a container.

### Set up caddy-https

You need Docker Engine with Compose v2, `git`, a hostname that serves only
PassGen pointing at this host, and ports 80 and 443 reachable from the internet
so Caddy can get a certificate.

1. Download the recipe from the same release tag as the image, so the
   configuration matches it, and create its settings file:

   ```sh
   git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git
   cd passgen/deploy/compose/caddy-https
   cp example.env .env
   ```

2. Look up the image digest for that version, as in
   [Pin by digest](#pin-by-digest), and, optionally but recommended,
   [verify its provenance](#verify-provenance) from this clone.

3. Edit `.env`: set `PASSGEN_DOMAIN` to your hostname and `PASSGEN_IMAGE` to the
   image with its digest:

   ```text
   PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<index-digest>
   PASSGEN_DOMAIN=passgen.example.com
   ```

4. Start it and check the result:

   ```sh
   docker compose up -d
   docker compose ps
   curl --head https://passgen.example.com/
   ```

5. **Optional:** run the full live check from the clone, with the release's
   `SHA256SUMS` (Node 22.18 or newer, no dependency install):

   ```sh
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
   node ../../../scripts/verify-live.ts --url https://passgen.example.com/ --manifest SHA256SUMS
   ```

Keep the `caddy_data` volume: it holds the certificates and their private keys.

## Read-only operation

The image runs with a read-only root filesystem. The only writable place it
needs is a small in-memory `/tmp`, mounted `noexec`, `nosuid` and `nodev`. Its
configuration and site files are owned by root and are not writable by the user
it runs as. Every recipe and the [Usage](#usage) examples run it this way.

## Non-root operation

The image runs as UID 101, GID 101, the base image's unprivileged nginx user,
never root. It listens on port 8080, so it needs no Linux capabilities: run it
with every capability dropped and `no-new-privileges`.

The official Caddy image in `caddy-https` and `caddy-files` runs as root inside
its container. The recipes drop every capability except `NET_BIND_SERVICE` (to
listen on 80 and 443), make its root filesystem read-only and set
no-new-privileges. Rootless Docker or user namespace remapping reduces that risk
further.

## Usage

Unless a parameter is marked `#optional`, it is required. Both examples run the
`localhost` recipe: PassGen on `127.0.0.1:8080` for a proxy on this host.

### docker compose (recommended)

This is [the `localhost` recipe](../deploy/compose/localhost/compose.yaml) with
`PASSGEN_IMAGE` filled in. To use the recipe file itself, copy its `example.env`
to `.env` and set `PASSGEN_IMAGE` there.

```yaml
services:
  passgen:
    image: ghcr.io/mcflycodes/passgen@sha256:<index-digest>
    user: "101:101"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:8080:8080"
    restart: unless-stopped #optional
```

### docker cli

```sh
docker run -d \
  --name passgen \
  --user 101:101 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  -p 127.0.0.1:8080:8080 \
  --restart unless-stopped \
  ghcr.io/mcflycodes/passgen@sha256:<index-digest>
```

`--restart unless-stopped` is optional, as in the Compose example.

## Parameters

Containers are configured with parameters passed at runtime, such as those
above. Parameters with two values are separated by a colon and mean
`<external>:<internal>`: `-p 127.0.0.1:8080:8080` makes port 8080 inside the
container reachable on port 8080 of the host's loopback address only.

### Ports (`-p`)

| Parameter | Function |
|---|---|
| `127.0.0.1:8080:8080` | PassGen over plain HTTP, reachable only from this host. With `caddy-https`, publish no port at all: Caddy reaches PassGen over an internal Docker network. |

Never publish a bare `8080:8080`: it listens on every interface and bypasses the
HTTPS proxy.

### Environment variables (`-e`)

None. The image takes no configuration at runtime.

### Volume mappings (`-v`)

None. The image holds the whole site and keeps no data.

### Miscellaneous options

| Parameter | Function |
|---|---|
| `--user 101:101` | Runs as the image's unprivileged nginx user, never root. The image defaults to it; setting it makes the intent explicit. |
| `--read-only` | The container cannot change its own files, configuration or site. |
| `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777` | The only writable place: a 16 MiB in-memory `/tmp` that cannot hold executables. |
| `--cap-drop ALL` | No Linux capabilities. Port 8080 needs none. |
| `--security-opt no-new-privileges:true` | Nothing in the container can gain privileges, for example through setuid files. |
| `--restart unless-stopped` | Restarts the container after a crash or reboot unless you stopped it. #optional |

The image has a built-in health check that fetches `index.html` every 30
seconds; `docker ps` shows the result. The recipes set no memory, CPU or process
limits, because suitable values depend on the host; add them after measuring.
Log rotation belongs in your Docker daemon configuration.

## Support info

- Logs, which nginx writes to stdout and stderr:

  ```sh
  docker logs -f passgen
  ```

  With Compose, from the recipe folder: `docker compose logs -f passgen`.

- Health status, shown as `(healthy)`, `(unhealthy)` or `(health: starting)`
  in the `STATUS` column:

  ```sh
  docker ps --filter name=passgen
  ```

  With Compose: `docker compose ps`.

- Shell access while the container runs. The image has BusyBox `sh`, not bash,
  and the filesystem is read-only apart from `/tmp`:

  ```sh
  docker exec -it passgen sh
  ```

  With Compose: `docker compose exec passgen sh`.

- Container version number:

  ```sh
  docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' passgen
  ```

- Image version number and the commit it was built from:

  ```sh
  docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }} {{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/mcflycodes/passgen@sha256:<index-digest>
  ```

| Problem | What to do |
|---|---|
| Compose refuses to start and says to set `PASSGEN_IMAGE` | `PASSGEN_IMAGE` is unset or empty. Set the image with its verified digest. |
| No certificate, or the browser shows a certificate error | Check that the hostname points at this host and that ports 80 and 443 are reachable from the internet. For `caddy-https`, use `docker compose logs caddy`; for `caddy-files`, use `docker compose logs passgen`. |
| 502 from Caddy | The PassGen container is not running or not healthy yet. Check `docker compose ps` and `docker compose logs passgen`. |
| The files recipes return 403, or the containers cannot read files | On SELinux hosts, label the mounted folders, for example `chcon -R -t container_file_t caddy passgen`. See [Release files](docker.md#release-files-for-caddy-files-and-httpd-files). |
| Headers missing or doubled behind your own proxy | The proxy must pass the container's headers through unchanged. See [Rules for every setup](docker-https.md#rules-for-every-setup). |

## Updating info

PassGen is updated by deploying a new release's image by digest, deliberately,
and keeping the previous digest for rollback. Read the release notes first.

### Pin by digest

Deploy by digest, not by tag:

```text
ghcr.io/mcflycodes/passgen@sha256:<index-digest>
```

Look up the index digest, the top-level `Digest` line, which covers both
architectures:

```sh
docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
```

The recipes' `example.env` files also put the `X.Y.Z` tag after the image name,
before the `@`, as a label for people. When a reference has both, Docker pulls
the digest and ignores the tag. The official Caddy and httpd images in the
recipes are pinned the same way. They come from AWS's public copy of Docker's
official images, which avoids Docker Hub's anonymous pull limit; Docker Hub
serves the same digests under the same version tags, which you can confirm with
the same `imagetools inspect` command.

### Verify provenance

Each release attests the exact index digest it pushed, recording which workflow
built it from which commit. Check that attestation for the digest you will run,
in a clone of the release tag so `git rev-parse` gives the release commit. `gh`
is the GitHub CLI; if it cannot read the registry, run `docker login ghcr.io`
first.

```sh
gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<index-digest> \
  --repo mcflycodes/passgen \
  --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
  --source-digest "$(git rev-parse 'vX.Y.Z^{commit}')"
```

Verification proves where and how the image was built. It does not prove the
base image is free of vulnerabilities, and it does not check your proxy; after
deploying, check the live site with `scripts/verify-live.ts` from the same tag
and the release's `SHA256SUMS`, as in step 5 of
[Set up caddy-https](#set-up-caddy-https).

### Via Docker Compose

Run these in the recipe folder of your clone, for example
`passgen/deploy/compose/caddy-https`. Replace `X.Y.Z` with the new version and
`OLD` with the one you run now.

1. Fetch the new release tag into the clone and switch to it, so the recipe
   configuration matches the new image. The clone only holds the tag it was made
   from, so the fetch is needed first. Your `.env` is not tracked and stays as it
   is:

   ```sh
   git fetch --depth 1 origin tag vX.Y.Z
   git checkout vX.Y.Z
   ```

2. Look up the new digest, as in [Pin by digest](#pin-by-digest):

   ```sh
   docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
   ```

3. **Optional, recommended:** check its provenance against the new tag's commit,
   as in [Verify provenance](#verify-provenance):

   ```sh
   gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<new-digest> \
     --repo mcflycodes/passgen \
     --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
     --source-digest "$(git rev-parse 'vX.Y.Z^{commit}')"
   ```

4. Edit `.env`, keeping the previous line as a comment for rollback:

   ```sh
   # Previous: PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<previous-digest>
   PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<new-digest>
   ```

5. Pull the image and recreate the container:

   ```sh
   docker compose pull
   docker compose up -d
   ```

6. Check the site, as in step 4 or 5 of
   [Set up caddy-https](#set-up-caddy-https).

To roll back, put the previous `PASSGEN_IMAGE` line back in `.env`, switch the
recipe folder back to the previous tag, which the clone still has, and apply it:

```sh
git checkout vOLD
docker compose up -d
```

Docker keeps the old image locally until you prune it, and the registry keeps
published digests. For `caddy-files` and `httpd-files`, see
[Update and roll back the files recipes](docker.md#update-and-roll-back-the-files-recipes).

### Via Docker Run

1. Look up and, optionally, verify the new digest, as in
   [Pin by digest](#pin-by-digest) and [Verify provenance](#verify-provenance).
   Write down the digest you run now, for rollback.

2. Pull the new image:

   ```sh
   docker pull ghcr.io/mcflycodes/passgen@sha256:<new-digest>
   ```

3. Stop and delete the running container:

   ```sh
   docker stop passgen
   docker rm passgen
   ```

4. Recreate it with the same `docker run` parameters as in [Usage](#docker-cli),
   with the new digest as the last argument.

5. Check the live site through your HTTPS proxy, as in step 4 or 5 of
   [Set up caddy-https](#set-up-caddy-https).

To roll back, repeat steps 3 and 4 with the previous digest, then check the
site again.

**Optional:** remove old images once you no longer need them for rollback:

```sh
docker image prune
```

### Base image refreshes

A published `X.Y.Z` is never rebuilt. When the nginx base image needs a security
update, PassGen ships it as a new patch version, so a base refresh is an ordinary
update.

### Image update notifications

To hear about new releases, watch the repository's releases on GitHub, or run a
notify-only tool such as [Diun](https://crazymax.dev/diun/) (Docker Image Update
Notifier), which tells you when a tag moves and changes nothing. Then update
deliberately with the steps above.

### Why not Watchtower or automatic updates

Tools that pull a moving tag and restart containers on their own change the code
that generates your passwords without anyone reviewing it. A container that
restarts is not proof that the site still sends the right headers and bytes.
Watchtower's upstream repository is archived, and such tools usually need the
Docker socket, which is root on the host. Deploy by digest, update deliberately,
verify, and keep the previous digest. If you automate anything, automate the
proposal (for example a pull request to your own configuration), not the
deployment.

## Building locally

The Dockerfile only adds files to the base image, including the already-built
site: it has no `RUN` steps, so it builds for either architecture without
emulation. Build the site
first, with the Node and pnpm versions pinned in `.nvmrc` and `package.json`,
then the image:

```sh
git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git
cd passgen
corepack enable
pnpm install --frozen-lockfile
pnpm build
chmod -R u=rwX,go=rX dist deploy/container deploy/examples/nginx/passgen-headers.conf
docker buildx build --load --tag passgen:local .
```

The `chmod` normalises file modes the same way CI and the release do. A local
build is labelled version `0.0.0` unless you pass
`--build-arg PASSGEN_VERSION=X.Y.Z`, and it is not the attested release image.
The [contributing guide](../CONTRIBUTING.md) covers the full checks.

## Versions

Changes to the image and the recipes are listed in the
[changelog](../CHANGELOG.md) and on
[GitHub Releases](https://github.com/mcflycodes/passgen/releases).
