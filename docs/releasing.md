# Releasing PassGen

Release tags use `vX.Y.Z` and must match `package.json`. Only stable releases are
supported. The tagged commit must be on `origin/main` and have a successful CI
push run on that exact commit, including a successful `CI result` job. Wait for
the entire CI workflow to finish. The required main checks are `CI result` and
`No attribution`.

## Prerequisites

Before pushing any release tag, configure and enforce these repository settings:

- An active tag ruleset matching `refs/tags/v*`. Restrict creation to repository
  admins, block updates and deletion, and grant no non-admin bypass. Keep update
  and deletion restrictions in a separate ruleset without bypasses if needed so
  the creation exception does not permit rewriting tags.
- Enable GitHub immutable releases in repository Settings, under Releases.
  This applies to future releases; it does not retroactively protect old ones.

The workflow's checks only catch honest mistakes. The tag ruleset is what limits
who can publish; immutability protects published tags and assets. Protect main
and workflow changes through review as well. Repository admins control these
settings and remain trusted. See GitHub's
[tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
and [release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).

## Cut a release

1. On a feature branch, bump `package.json` to the new version. Move the contents
   of `CHANGELOG.md`'s Unreleased section into a matching `## [X.Y.Z]` section
   (optionally followed by ` - YYYY-MM-DD`), leaving Unreleased empty.
2. Run `pnpm install --frozen-lockfile` and `pnpm check`. Have the changes reviewed
   and merged to main. Release workflow changes require security review.
3. Fetch main and tags, identify the reviewed merge commit, and confirm its CI
   workflow succeeded. Create and push the tag from that commit:

   ```sh
   git fetch origin main --tags
   git tag -a vX.Y.Z <reviewed-commit> -m "PassGen X.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

4. Check the Release workflow and published GitHub Release. Confirm its source
   tag, notes and five assets: `passgen-X.Y.Z.zip`, its `.sha256`,
   `SHA256SUMS`, `passgen.zip` and `passgen.zip.sha256`. Confirm both ZIPs are
   byte-identical and each ZIP checksum names its matching archive. The stable
   aliases support `/releases/latest/download/passgen.zip` and its `.sha256`.
   Download them and verify the archive and extracted
   files as described in [self-hosting](self-hosting.md#deploy-from-a-release).

The workflow reruns the fast gates, builds without a dependency cache, and
checks release notes and annotated tag messages for prohibited credits. Build
and dependency code run with read-only repository permissions; a separate job
downloads the packaged artifact and rechecks the remote tag before publishing.
Before building or publishing, Release calls the reusable full-suite workflow
on the validated tagged commit. It runs all five browser projects and the full
accessibility matrix; a failed or cancelled suite blocks publication. The same
suite runs nightly on main and on demand. PR/main CI uses desktop functional
coverage and Chromium's accessibility matrix, with one matrix smoke case in each
other engine; engine-specific regressions may be caught nightly or pre-release.
The ZIP contains the contents of `dist/` at its root, ordered by path with fixed
1980 timestamps and permissions. Repeated builds produce identical ZIP bytes
when source, configuration and toolchain are the same; this is not a guarantee
across different Node, pnpm, Vite or Python versions. Python 3's standard library creates an
uncompressed ZIP to avoid compressor-dependent bytes. The file manifest stays
outside the public root. A release uses the tagged build configuration; custom
configuration requires your own build and manifest.

## Container image

The Release workflow's `image` job publishes `ghcr.io/mcflycodes/passgen`. It is
the only job with `packages: write`, `id-token: write` and `attestations: write`,
and it runs only after tag validation, the full suite and the release build
succeed. It runs no project build tooling: it checks out the validated commit
for the `Dockerfile` and generated nginx configuration, unpacks the verified
release archive into `dist/`, checks every file against `SHA256SUMS`, and runs
`docker buildx` once for `linux/amd64` and `linux/arm64`. The one pushed index
gets the tags `X.Y.Z`, `X.Y` and `latest`; the job checks that all three resolve
to the same digest, then attests that digest with `actions/attest`, stored in
the registry. The job log prints the published digest.

`X.Y.Z` is immutable by policy: the job refuses to push a version that already
exists, and nobody replaces it by hand. `X.Y` and `latest` are moving aliases.
A base image security refresh ships as a new patch version: merge the reviewed
`Dockerfile` update (Dependabot is configured to propose one weekly), bump the version, and cut
a release as above. If the job fails after pushing, for example while attesting,
a rerun refuses the existing version; cut a new patch version instead.

### Make the package public once

GitHub creates the package as private on its first publication, even for a
public repository. After the first release that publishes an image, open the
package from the repository's **Packages** list, then in **Package settings**
change its visibility to **Public**. Anonymous pulls work after that. Check that
the package settings show this repository with Actions access; the release
workflow's token needs it to push later versions.

### Verify a published image

Resolve the tag to its index digest, then verify the attestation for that exact
digest and the reviewed release commit:

```sh
docker buildx imagetools inspect ghcr.io/mcflycodes/passgen:X.Y.Z
gh attestation verify oci://ghcr.io/mcflycodes/passgen@sha256:<index-digest> \
  --repo mcflycodes/passgen \
  --signer-workflow mcflycodes/passgen/.github/workflows/release.yml \
  --source-digest <release-commit>
```

Use the top-level `Digest` from the first command. If `gh` cannot read the
registry, run `docker login ghcr.io` first. Deploy by that digest, not by a
moving tag. The attestation shows which workflow built the image from which
commit; it does not prove the base image is free of vulnerabilities.

### Refresh pinned images

Dependabot does not update the BuildKit image digest stored in the CI and
Release workflows. Both pull it from Google's Docker Hub mirror, and the base
image comes from nginx's AWS ECR Public copy, to avoid Docker Hub's anonymous
pull limit. To refresh a pin, look up the tag's index digest, confirm Docker Hub
reports the same digest, update every copy in one reviewed PR, and require the
container CI job to pass on both architectures:

```sh
docker buildx imagetools inspect mirror.gcr.io/moby/buildkit:vX.Y.Z
docker buildx imagetools inspect public.ecr.aws/nginx/nginx-unprivileged:X.Y.Z-alpine-slim
```

## Recover a failed publication

If a rerun reports "release already exists", inspect the existing release and
compare its assets with the verified build before acting. If it is complete,
leave it intact; publication may have succeeded before the workflow reported a
failure.

For an incomplete, unpublished draft left during upload, delete only that draft,
keeping the existing tag, then rerun the workflow:

```sh
gh release view vX.Y.Z --repo mcflycodes/passgen --json isDraft,assets
# Proceed only after confirming this is the incomplete draft.
gh release delete vX.Y.Z --repo mcflycodes/passgen --yes
```

Do not pass `--cleanup-tag`. Deleting and recreating an incomplete draft avoids
mixing assets from different attempts. Do not replace assets with `--clobber`.
A published immutable release cannot have assets replaced, and deleting it does
not allow the tag name to be reused. For an incomplete published immutable
release, retain it, explain the problem in its notes and cut a corrected new
version. Never disable immutability or move a tag to recover a publication.
See [GitHub's immutable release protections](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

Publishing does not deploy any host.
