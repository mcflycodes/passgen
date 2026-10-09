# Releasing PassGen

Release tags use `vX.Y.Z` and must match `package.json`. Only stable releases are
supported. The tagged commit must be on `origin/main` and have a successful CI
push run on that exact commit. Wait for the entire CI workflow to finish.

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
   tag, notes and three assets: `passgen-X.Y.Z.zip`, `SHA256SUMS`, and
   `passgen-X.Y.Z.zip.sha256`. Download them and verify the archive and extracted
   files as described in [self-hosting](self-hosting.md#deploy-from-a-release).

The workflow reruns the fast gates, builds without a dependency cache, and
publishes directly after checking the release notes for prohibited credits.
It relies on the existing CI browser matrix rather than running it again.
The ZIP contains the contents of `dist/` at its root, ordered by path with fixed
1980 timestamps and permissions. Python 3's standard library creates an
uncompressed ZIP to avoid compressor-dependent bytes. The file manifest stays
outside the public root. A release uses the tagged build configuration; custom
configuration requires your own build and manifest.

If publication fails, inspect the failed step and rerun the workflow after
resolving the cause. Do not move a published tag or replace published assets;
correct the source and cut a new version. Publishing does not deploy any host.
