#!/usr/bin/env bash
set -euo pipefail
: "${TMPDIR:?Set TMPDIR to task scratch space}"
: "${HTTPD_IMAGE:?}" "${NGINX_IMAGE:?}" "${CADDY_IMAGE:?}"
work=$(mktemp -d "$TMPDIR/server-configs-XXXX")
container="passgen-configs-$$"
cleanup() {
  docker logs "$container" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=passgen.test \
  -addext subjectAltName=DNS:passgen.test -keyout "$work/key.pem" -out "$work/cert.pem"
for server in apache nginx caddy; do
  mkdir -p "$work/$server"
  # Only documented name, root and certificate placeholders are substituted.
  # Keep /srv/passgen and include paths unchanged, mounting their real locations.
  for source in deploy/examples/"$server"/*; do
    sed -e 's/example\[\.\]com/passgen[.]test/g' -e 's/example.com/passgen.test/g' \
      -e 's|/etc/pki/tls/certs/passgen.test.pem|/test/cert.pem|g' \
      -e 's|/etc/pki/tls/private/passgen.test.key|/test/key.pem|g' \
      "$source" > "$work/$server/$(basename "$source")"
  done
  common=(--name "$container" -v "$PWD/dist:/srv/passgen:ro" -v "$work:/test:ro")
  redirect=()
  case "$server" in
    apache)
      image=$HTTPD_IMAGE
      docker run --rm --entrypoint cat "$image" /usr/local/apache2/conf/httpd.conf > "$work/httpd.conf"
      sed -i -e 's/^Listen 80/Listen 443/' \
        -e '/^#LoadModule \(ssl\|socache_shmcb\|headers\)_module/s/^#//' "$work/httpd.conf"
      printf '\nServerName passgen.test\nServerTokens Prod\nInclude /etc/httpd/passgen/passgen-site.conf\n' >> "$work/httpd.conf"
      mounts=(-v "$work/httpd.conf:/usr/local/apache2/conf/httpd.conf:ro" -v "$work/apache:/etc/httpd/passgen:ro")
      validate=(httpd -t)
      ;;
    nginx)
      image=$NGINX_IMAGE
      mounts=(-v "$work/nginx:/etc/nginx/passgen:ro" -v "$work/nginx/passgen-site.conf:/etc/nginx/conf.d/default.conf:ro")
      validate=(nginx -t)
      ;;
    caddy)
      image=$CADDY_IMAGE
      mounts=(-v "$work/caddy:/etc/caddy/passgen:ro" -v "$work/caddy/Caddyfile:/etc/caddy/Caddyfile:ro")
      validate=(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
      redirect=(--redirect)
      ;;
  esac
  docker run --rm "${common[@]}" "${mounts[@]}" "$image" "${validate[@]}"
  docker run -d "${common[@]}" "${mounts[@]}" -p 127.0.0.1:443:443 -p 127.0.0.1:80:80 "$image"
  ready=false
  for attempt in {1..30}; do
    if curl --silent --show-error --noproxy '*' --max-time 2 --cacert "$work/cert.pem" \
      --resolve passgen.test:443:127.0.0.1 https://passgen.test/ -o /dev/null; then ready=true; break; fi
    sleep 1
  done
  "$ready"
  echo "Testing $server"
  node scripts/probe-server.ts --url https://passgen.test/ --manifest dist-manifest/SHA256SUMS \
    --ca-file "$work/cert.pem" --address 127.0.0.1 "${redirect[@]}"
  NODE_EXTRA_CA_CERTS="$work/cert.pem" node scripts/verify-live.ts --url https://passgen.test/ \
    --manifest dist-manifest/SHA256SUMS --release-dir dist
  docker logs "$container"
  docker rm -f "$container"
done
