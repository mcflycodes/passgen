#!/usr/bin/env bash
# Brings up each Docker Compose recipe in deploy/compose/ unchanged and probes it.
# The PassGen service runs an image built here from dist/; Caddy issues the test
# certificate from its internal CA, since .localhost names never use public ACME.
set -euo pipefail
: "${TMPDIR:?Set TMPDIR to task scratch space}"
test -f dist/index.html && test -f dist-manifest/SHA256SUMS
work=$(mktemp -d "$TMPDIR/compose-XXXX")
image="passgen-compose-ci:$$"
domain=passgen.localhost
manifest=dist-manifest/SHA256SUMS
recipe=
project=
compose() { docker compose -f "$work/$recipe/compose.yaml" -p "$project" "$@"; }
finish() {
  compose logs --no-color || true
  compose down --volumes --remove-orphans || true
  project=
}
cleanup() {
  if [[ -n "$project" ]]; then finish; fi
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Anonymous registry pulls are rate limited and shared between runners; retry with backoff.
retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    echo "Attempt $attempt failed: $*"
    sleep $((attempt * 15))
  done
  echo "FAIL: $*"
  return 1
}

# Each recipe runs from a copy with only its documented .env values and files added.
start() {
  recipe=$1
  project="passgen-ci-$1"
  echo "== $recipe"
  cp -R "deploy/compose/$recipe" "$work/$recipe"
  if [[ -f "$work/$recipe/example.env" ]]; then
    sed -e "s|^PASSGEN_IMAGE=.*|PASSGEN_IMAGE=$image|" -e "s|^PASSGEN_DOMAIN=.*|PASSGEN_DOMAIN=$domain|" \
      "$work/$recipe/example.env" > "$work/$recipe/.env"
    if grep -q '<digest>\|example\.com' "$work/$recipe/.env"; then echo "FAIL: unknown example.env value"; exit 1; fi
  fi
  if [[ "$recipe" == *-files ]]; then cp -R dist "$work/$recipe/passgen"; fi
  chmod -R u=rwX,go=rX "$work/$recipe"
  compose config --quiet
  local pinned
  for pinned in $(compose config --images); do
    if [[ "$pinned" != "$image" ]]; then retry docker pull --quiet "$pinned" >/dev/null; fi
  done
  compose up --detach --wait --wait-timeout 120 --pull never
  echo "PASS $recipe: docker compose up --wait"
}

inspect() { docker inspect "$(compose ps --quiet "$1")" > "$work/$1.json"; }

# Caddy's local CA root appears in its data volume once it has issued the certificate.
caddy_ready() {
  for attempt in {1..30}; do
    if compose exec -T "$1" cat /data/caddy/pki/authorities/local/root.crt > "$work/ca.pem" 2>/dev/null &&
      curl --silent --noproxy '*' --max-time 2 --cacert "$work/ca.pem" --resolve "$domain:443:127.0.0.1" \
        "https://$domain/" -o /dev/null; then return 0; fi
    sleep 1
  done
  echo "FAIL: Caddy did not serve HTTPS"
  return 1
}

probe_https() {
  node scripts/probe-server.ts --url "https://$domain/" --manifest "$manifest" --ca-file "$work/ca.pem" \
    --address 127.0.0.1 --redirect --conditional
  NODE_EXTRA_CA_CERTS="$work/ca.pem" node scripts/verify-live.ts --url "https://$domain/" \
    --manifest "$manifest" --release-dir dist
  curl --silent --show-error --noproxy '*' --max-time 15 --include --resolve "$domain:80:127.0.0.1" \
    "http://$domain/index.html?probe=1" > "$work/redirect"
  node scripts/check-compose.ts redirect --response "$work/redirect" --location "https://$domain/index.html?probe=1"
}

probe_loopback() {
  node scripts/probe-server.ts --url http://127.0.0.1:8080/ --manifest "$manifest" --local-http "$@"
  node scripts/verify-live.ts --url http://127.0.0.1:8080/ --manifest "$manifest" --release-dir dist --local-http
}

# Nothing answers on this port at any of the runner's own non-loopback addresses.
not_exposed() {
  local address url
  for address in $(hostname -I); do
    if [[ "$address" == *:* ]]; then url="http://[$address]:$1/"; else url="http://$address:$1/"; fi
    if curl --silent --globoff --noproxy '*' --max-time 3 -o /dev/null "$url"; then
      echo "FAIL: port $1 answers on $address"
      exit 1
    fi
  done
  echo "PASS port $1 does not answer on the runner's non-loopback addresses: $(hostname -I)"
}

# The image is built exactly as the container job builds it, for this runner's platform only.
chmod -R u=rwX,go=rX dist deploy/container deploy/examples/nginx/passgen-headers.conf
retry docker build --quiet --tag "$image" . >/dev/null

start caddy-https
caddy_ready caddy
probe_https
inspect passgen
inspect caddy
node scripts/check-compose.ts hardening --inspect "$work/passgen.json" --user 101:101
node scripts/check-compose.ts hardening --inspect "$work/caddy.json" --user "" --cap-add NET_BIND_SERVICE
node scripts/check-compose.ts published --inspect "$work/passgen.json"
node scripts/check-compose.ts published --inspect "$work/caddy.json" \
  --expect '*:80->80/tcp' --expect '*:443->443/tcp' --expect '*:443->443/udp'
docker network inspect "${project}_backend" "${project}_edge" > "$work/networks.json"
node scripts/check-compose.ts internal --inspect "$work/passgen.json" --networks "$work/networks.json" \
  --network "${project}_backend"
backend=$(jq -er --arg network "${project}_backend" '.[0].NetworkSettings.Networks[$network].IPAddress' "$work/passgen.json")
docker run --rm --network "${project}_backend" --entrypoint wget "$image" -q -T 5 -O /dev/null http://passgen:8080/index.html
echo "PASS control: a container on the internal network reaches passgen:8080"
for target in http://passgen:8080/index.html "http://$backend:8080/index.html"; do
  if docker run --rm --network "${project}_edge" --entrypoint wget "$image" -q -T 5 -O /dev/null "$target"; then
    echo "FAIL: $target is reachable from the edge network"
    exit 1
  fi
done
echo "PASS PassGen is unreachable from Caddy's public edge network, by name or address"
not_exposed 8080
compose stop passgen
for method in GET HEAD; do
  request=(--request GET)
  if [[ "$method" == HEAD ]]; then request=(--head); fi
  for path in "" index.html; do
    curl --silent --show-error --noproxy '*' --max-time 15 --include "${request[@]}" --cacert "$work/ca.pem" \
      --resolve "$domain:443:127.0.0.1" "https://$domain/$path" > "$work/gateway"
    node scripts/check-compose.ts generated --response "$work/gateway" --status 502
  done
done
compose up --detach --wait --wait-timeout 120 --pull never
curl --fail --silent --show-error --noproxy '*' --max-time 15 --cacert "$work/ca.pem" \
  --resolve "$domain:443:127.0.0.1" "https://$domain/" -o /dev/null
echo "PASS PassGen serves through Caddy again after restarting"
finish

start localhost
probe_loopback --conditional
inspect passgen
node scripts/check-compose.ts hardening --inspect "$work/passgen.json" --user 101:101
node scripts/check-compose.ts published --inspect "$work/passgen.json" --expect '127.0.0.1:8080->8080/tcp'
not_exposed 8080
finish

start caddy-files
caddy_ready passgen
probe_https
inspect passgen
node scripts/check-compose.ts hardening --inspect "$work/passgen.json" --user "" --cap-add NET_BIND_SERVICE
node scripts/check-compose.ts published --inspect "$work/passgen.json" \
  --expect '*:80->80/tcp' --expect '*:443->443/tcp' --expect '*:443->443/udp'
finish

start httpd-files
probe_loopback --conditional-date
inspect passgen
node scripts/check-compose.ts hardening --inspect "$work/passgen.json" --user 65534:65534
node scripts/check-compose.ts published --inspect "$work/passgen.json" --expect '127.0.0.1:8080->8080/tcp'
not_exposed 8080
finish
