#!/usr/bin/env bash
# Builds the official image from dist/ and probes it with the hardened runtime flags.
set -euo pipefail
: "${TMPDIR:?Set TMPDIR to task scratch space}"
: "${BUILDKIT_IMAGE:?}"
test -f dist/index.html && test -f dist-manifest/SHA256SUMS
work=$(mktemp -d "$TMPDIR/container-XXXX")
name="passgen-container-$$"
image="passgen-ci:$$"
architecture=$(docker version --format '{{.Server.Arch}}')
version=$(node -p 'require("./package.json").version')
revision=$(git rev-parse HEAD)
epoch=$(git log -1 --format=%ct)
created=$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ)
url="http://127.0.0.1:8080/"
hardened=(--read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777
  --cap-drop ALL --security-opt no-new-privileges:true)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker buildx rm "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Same builder, arguments and annotations as the release workflow's image job.
chmod -R u=rwX,go=rX dist
docker buildx create --name "$name" --driver docker-container --driver-opt "image=$BUILDKIT_IMAGE" >/dev/null
build=(docker buildx build --builder "$name" --provenance=false --sbom=false
  --build-arg "PASSGEN_VERSION=$version" --build-arg "PASSGEN_REVISION=$revision"
  --build-arg "PASSGEN_CREATED=$created"
  --annotation "index:org.opencontainers.image.source=https://github.com/mcflycodes/passgen"
  --annotation "index:org.opencontainers.image.licenses=Apache-2.0"
  --annotation "index:org.opencontainers.image.description=Client-side password and passphrase generator served over HTTP on port 8080 by unprivileged nginx")
if [[ "$architecture" == amd64 ]]; then
  SOURCE_DATE_EPOCH=$epoch "${build[@]}" --platform linux/amd64,linux/arm64 --output "type=oci,dest=$work/index.tar" .
  index=$(tar -xOf "$work/index.tar" index.json | jq -er '.manifests | select(length == 1) | .[0].digest | sub("^sha256:"; "")')
  tar -xOf "$work/index.tar" "blobs/sha256/$index" > "$work/index.json"
  test "$(jq -cr '[.manifests[].platform | "\(.os)/\(.architecture)"] | sort | join(",")' "$work/index.json")" = linux/amd64,linux/arm64
  test "$(jq -er '.annotations["org.opencontainers.image.source"]' "$work/index.json")" = https://github.com/mcflycodes/passgen
  echo "PASS one OCI index for linux/amd64 and linux/arm64, built without emulation, with index annotations"
fi
SOURCE_DATE_EPOCH=$epoch "${build[@]}" --platform "linux/$architecture" --load --tag "$image" .
docker image inspect "$image" > "$work/inspect.json"
node scripts/check-container.ts --work "$work" --version "$version" --revision "$revision" \
  --architecture "$architecture" image

docker run --rm "${hardened[@]}" "$image" -t
echo "PASS nginx -t with the hardened runtime flags"
docker run -d --name "$name" "${hardened[@]}" -p 127.0.0.1:8080:8080 "$image" >/dev/null
ready=false
for attempt in {1..30}; do
  if curl --silent --noproxy '*' --max-time 2 "$url" -o /dev/null; then ready=true; break; fi
  sleep 1
done
"$ready"
health=starting
for attempt in {1..60}; do
  health=$(docker inspect --format '{{.State.Health.Status}}' "$name")
  [[ "$health" == starting ]] || break
  sleep 1
done
test "$health" = healthy
echo "PASS built-in health check reports healthy"

node scripts/probe-server.ts --url "$url" --manifest dist-manifest/SHA256SUMS --local-http --conditional
node scripts/verify-live.ts --url "$url" --manifest dist-manifest/SHA256SUMS --release-dir dist --local-http
curl --silent --show-error --noproxy '*' --max-time 15 --include --request POST "$url" > "$work/post"
curl --silent --show-error --noproxy '*' --max-time 15 --include --header 'Host: passgen.invalid' "$url" > "$work/other-host"
curl --silent --show-error --noproxy '*' --max-time 15 --include "$url" > "$work/root"
node scripts/check-container.ts --work "$work" responses

docker exec "$name" find /srv/passgen -type f | sed 's|^/srv/passgen/||' | LC_ALL=C sort > "$work/image-files"
sed 's/^[0-9a-f]\{64\}  //' dist-manifest/SHA256SUMS | LC_ALL=C sort > "$work/manifest-files"
diff "$work/manifest-files" "$work/image-files"
docker exec -i "$name" sh -c 'cd /srv/passgen && sha256sum -c -s' < dist-manifest/SHA256SUMS
echo "PASS image holds exactly the manifest's files with matching SHA-256"
unsafe=$(docker exec "$name" find /srv/passgen /etc/passgen \
  \( ! -user 0 -o ! -group 0 -o -perm -020 -o -perm -002 -o \( ! -type f ! -type d \) \) -print)
test -z "$unsafe" || { echo "FAIL: not root-owned, writable or special: $unsafe"; exit 1; }
echo "PASS site and configuration are root-owned regular files, not writable by the nginx user"
for path in /srv/passgen/probe /etc/passgen/probe /etc/nginx/probe /probe; do
  if docker exec "$name" touch "$path" 2>/dev/null; then echo "FAIL: $path is writable"; exit 1; fi
done
docker exec "$name" sh -c 'touch /tmp/probe && rm /tmp/probe'
echo "PASS root filesystem is read-only; only the /tmp tmpfs is writable"
docker exec "$name" sh -c 'for f in /proc/[0-9]*/status; do cat "$f" 2>/dev/null; echo; done' > "$work/proc-status"
node scripts/check-container.ts --work "$work" processes

docker stop "$name" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
echo "PASS graceful stop with exit code 0"
docker logs "$name" > "$work/logs.out" 2> "$work/logs.err"
node scripts/check-container.ts --work "$work" logs
