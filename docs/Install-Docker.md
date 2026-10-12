# Install with Docker

The official image, `ghcr.io/mcflycodes/passgen`, is the release build served by
unprivileged nginx over plain HTTP on port 8080, for amd64 and arm64. It sends
all nine security headers on every response but does not do HTTPS, so something
must put HTTPS in front of it. The recommended Compose recipe, `caddy-https`,
runs it behind Caddy, which gets and renews the certificate.

**Who it's for:** anyone with a host that runs Docker. The full guide,
[Running PassGen with Docker](docker.md), covers every recipe, the hardening
settings and what CI tests. [HTTPS in front of the container](docker-https.md)
covers Traefik, nginx with Certbot, Cloudflare Tunnel and an existing Apache or
nginx proxy.

## Before you start

You need:

- Docker Engine with Compose v2, and `git`.
- A hostname that serves only PassGen, pointing at this host. See
  [Before you start](self-hosting.md#before-you-start).
- Ports 80 and 443 reachable from the internet, so Caddy can get a certificate.
- The version to run, `X.Y.Z`, from
  [GitHub Releases](https://github.com/mcflycodes/passgen/releases). The image
  was first published with release 1.4.0.

Replace `X.Y.Z` and `passgen.example.com` with your own values throughout.

## Install

1. Download the recipe from the same release tag as the image, so the
   configuration matches it, and create its settings file:

   ```sh
   git clone --depth 1 --branch vX.Y.Z https://github.com/mcflycodes/passgen.git
   cd passgen/deploy/compose/caddy-https
   cp example.env .env
   ```

2. Look up the image digest for that version. Use the top-level `Digest` line,
   which covers both architectures:

   ```sh
   docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
   ```

3. **Optional, recommended:** check that the release workflow built that digest
   from the tagged commit. Run it inside the clone; `gh` is the GitHub CLI.
   If `gh` cannot read the registry, run `docker login ghcr.io` first.

   ```sh
   gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<index-digest> \
     --repo mcflycodes/passgen \
     --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
     --source-digest "$(git rev-parse 'vX.Y.Z^{commit}')"
   ```

4. Edit `.env`: set `PASSGEN_DOMAIN` to your hostname and `PASSGEN_IMAGE` to the
   image with its digest. The placeholder in `example.env` also has the `X.Y.Z`
   tag before the `@`; that is only a label for people, and Docker pulls the
   digest:

   ```text
   PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<index-digest>
   PASSGEN_DOMAIN=passgen.example.com
   ```

5. Start it and check the result:

   ```sh
   docker compose up -d
   docker compose ps
   curl --head https://passgen.example.com/
   ```

6. **Optional:** run the full live check from the clone, with the release's
   `SHA256SUMS` (Node 22.18 or newer, no dependency install):

   ```sh
   curl --fail --location --remote-name https://github.com/mcflycodes/passgen/releases/download/vX.Y.Z/SHA256SUMS
   node ../../../scripts/verify-live.ts --url https://passgen.example.com/ --manifest SHA256SUMS
   ```

**Other recipes:** `localhost` publishes the image only on `127.0.0.1:8080` for a
proxy already on the host; `caddy-files` and `httpd-files` serve verified
release files with the official Caddy or Apache httpd image, with no PassGen
image. See [Choose a recipe](docker.md#choose-a-recipe). Never publish the
container on every interface: use `127.0.0.1:8080:8080` for a proxy on the same
host, or a shared Docker network.

## Update

Run these in the recipe folder of your clone (`passgen/deploy/compose/caddy-https`).
Replace `X.Y.Z` with the new version and `OLD` with the one you run now.

1. Read the release notes.

2. Fetch the new release tag into the clone and switch the recipe folder to it,
   so the configuration matches the new image. The clone only holds the tag it
   was made from, so the fetch is needed before the tag can be used. Your `.env`
   is not tracked and stays as it is:

   ```sh
   git fetch --depth 1 origin tag vX.Y.Z
   git checkout vX.Y.Z
   ```

3. Look up the new digest, as in step 2 of Install:

   ```sh
   docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
   ```

4. **Optional, recommended:** check its provenance against the new tag's commit,
   as in step 3 of Install:

   ```sh
   gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<new-digest> \
     --repo mcflycodes/passgen \
     --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
     --source-digest "$(git rev-parse 'vX.Y.Z^{commit}')"
   ```

5. Edit `.env`, keeping the previous line as a comment for rollback:

   ```sh
   # Previous: PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<previous-digest>
   PASSGEN_IMAGE=ghcr.io/mcflycodes/passgen@sha256:<new-digest>
   ```

6. Apply it and check the site:

   ```sh
   docker compose pull
   docker compose up -d
   ```

Do not use tools that pull a moving tag and restart containers on their own; see
[Why not Watchtower or automatic updates](docker.md#why-not-watchtower-or-automatic-updates).

## Roll back

Put the previous `PASSGEN_IMAGE` line back in `.env`, switch the recipe folder
back to the previous tag, which the clone still has, and apply it:

```sh
git checkout vOLD
docker compose up -d
```

Docker keeps the old image locally until you prune it, and the registry keeps
published digests. For `caddy-files` and `httpd-files`, see
[Update and roll back](docker.md#update-and-roll-back).

## Troubleshooting

| Problem | What to do |
|---|---|
| Compose refuses to start and says to set `PASSGEN_IMAGE` | `.env` still has the placeholder. Set the image with its verified digest (step 4). |
| No certificate, or the browser shows a certificate error | Check that the hostname points at this host and that ports 80 and 443 are reachable from the internet. `docker compose logs` shows Caddy's messages. |
| 502 from Caddy | The PassGen container is not running or not healthy yet. Check `docker compose ps` and `docker compose logs`. |
| The files recipes return 403, or the containers cannot read files | On SELinux hosts, label the mounted folders, for example `chcon -R -t container_file_t caddy passgen`. See [Release files](docker.md#release-files-for-caddy-files-and-httpd-files). |
| Headers missing or doubled behind your own proxy | The proxy must pass the container's headers through unchanged. See [Rules for every setup](docker-https.md#rules-for-every-setup). |
