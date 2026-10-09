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
bash scripts/lib/test-certificates.sh "$work" 'DNS:passgen.test,DNS:control.passgen.test'
# A separate vhost proves hostile defaults are effective outside the example's scope.
mkdir -p "$work/control/listing"
echo 'Hostile baseline control' > "$work/control/listing/baseline-marker.txt"
for server in apache nginx caddy; do
  mkdir -p "$work/$server"
  # Only documented name, root and certificate placeholders are substituted.
  # Keep /srv/passgen and include paths unchanged, mounting their real locations.
  for source in deploy/examples/"$server"/*; do
    sed -e 's/example\[\.\]com/passgen[.]test/g' -e 's/example\.com/passgen.test/g' \
      -e 's|/etc/pki/tls/certs/passgen.test.pem|/test/cert.pem|g' \
      -e 's|/etc/pki/tls/private/passgen.test.key|/test/key.pem|g' \
      "$source" > "$work/$server/$(basename "$source")"
  done
  common=(--name "$container" -v "$PWD/dist:/srv/passgen:ro" -v "$work:/test:ro" -v "$work/control:/srv/control:ro")
  redirect=()
  case "$server" in
    apache)
      image=$HTTPD_IMAGE
      docker run --rm --entrypoint cat "$image" /usr/local/apache2/conf/httpd.conf > "$work/httpd.conf"
      sed -i -e 's/^Listen 80/Listen 443/' \
        -e '/^#LoadModule \(ssl\|socache_shmcb\|headers\)_module/s/^#//' "$work/httpd.conf"
      # Global hostile defaults: the example must reset Options and clear onsuccess headers.
      # The control vhost inherits the same headers and listing policy without hardening.
      cat >> "$work/httpd.conf" <<'APACHE'
ServerName passgen.test
ServerTokens Prod
<Directory "/srv/passgen">
    Options Indexes
</Directory>
Header set X-Frame-Options SAMEORIGIN
Header onsuccess set Referrer-Policy unsafe-url
<Directory "/srv/control">
    Options Indexes
    Require all granted
</Directory>
<VirtualHost *:443>
    ServerName control.passgen.test
    DocumentRoot /srv/control
    SSLEngine On
    SSLCertificateFile /test/cert.pem
    SSLCertificateKeyFile /test/key.pem
</VirtualHost>
Include /etc/httpd/passgen/passgen-site.conf
APACHE
      mounts=(-v "$work/httpd.conf:/usr/local/apache2/conf/httpd.conf:ro" -v "$work/apache:/etc/httpd/passgen:ro")
      validate=(httpd -t)
      ;;
    nginx)
      image=$NGINX_IMAGE
      # http-level defaults are inherited unless the example overrides them. nginx's
      # add_header lists replace their parent's list; the control inherits both conflicts.
      cat > "$work/nginx.conf" <<'NGINX'
events {}
http {
    include /etc/nginx/mime.types;
    autoindex on;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy unsafe-url always;
    server {
        listen 443 ssl;
        server_name control.passgen.test;
        root /srv/control;
        ssl_certificate /test/cert.pem;
        ssl_certificate_key /test/key.pem;
    }
    include /etc/nginx/passgen/passgen-site.conf;
}
NGINX
      mounts=(-v "$work/nginx:/etc/nginx/passgen:ro" -v "$work/nginx.conf:/etc/nginx/nginx.conf:ro")
      validate=(nginx -t)
      ;;
    caddy)
      # Caddy has no inherited browse/header baseline: file_server browse belongs to
      # a site's handler route. Adding it to PassGen would edit or shadow the example.
      echo 'UNSUPPORTED Caddy baseline: browse is scoped to a handler, not inherited'
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
    if curl --silent --show-error --noproxy '*' --max-time 2 --cacert "$work/ca.pem" \
      --resolve passgen.test:443:127.0.0.1 https://passgen.test/ -o /dev/null; then ready=true; break; fi
    sleep 1
  done
  "$ready"
  if [[ "$server" != caddy ]]; then
    curl --silent --show-error --noproxy '*' --max-time 15 --include --cacert "$work/ca.pem" \
      --resolve control.passgen.test:443:127.0.0.1 https://control.passgen.test/listing/ > "$work/control-response"
    node --input-type=module - "$work/control-response" <<'CHECK'
import { readFileSync } from 'node:fs';
import { checkHostileBaseline } from './scripts/lib/server-probes.ts';
checkHostileBaseline(readFileSync(process.argv[2], 'utf8'));
CHECK
    echo "PASS $server hostile control: listing, SAMEORIGIN and unsafe-url are active"
  fi
  echo "Testing $server"
  node scripts/probe-server.ts --url https://passgen.test/ --manifest dist-manifest/SHA256SUMS \
    --ca-file "$work/ca.pem" --address 127.0.0.1 "${redirect[@]}"
  NODE_EXTRA_CA_CERTS="$work/ca.pem" node scripts/verify-live.ts --url https://passgen.test/ \
    --manifest dist-manifest/SHA256SUMS --release-dir dist
  if [[ "$server" != caddy ]]; then
    echo "PASS $server example overrides hostile listing and headers"
  fi
  docker logs "$container"
  docker rm -f "$container"
done
