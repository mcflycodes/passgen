# HTTPS in front of the PassGen container

The PassGen image serves plain HTTP on port 8080 and never handles TLS. This
guide shows five ways to put HTTPS in front of it. Only the Caddy setup and the
container side of the existing-proxy setup are tested in CI (the `caddy-https`
and `localhost` recipes in [Install with Docker](Install-Docker.md#application-setup)). The
Traefik, nginx with Certbot, Cloudflare Tunnel and host Apache or nginx proxy
configurations below are documented examples, not CI-tested: test your own setup
with the verifier before relying on it.

Replace `passgen.example.com` with your hostname and every `*_IMAGE` placeholder
with a version and digest you have checked; the untested examples deliberately
pin nothing for you.

## Rules for every setup

- **Own hostname.** Serve PassGen on a hostname with nothing else on it. A path
  next to another application shares its origin, which can read generated
  passwords; see [Before you start](self-hosting.md#before-you-start).
- **Keep the nine headers intact.** The container sends all nine security
  headers on every response it makes, including 404 and 405. The proxy must pass
  them through unchanged: no security-header middleware, no `add_header` or
  `Header set` for those names on proxied responses, no response rewriting. Two
  copies of a policy, or a weaker value, can break or weaken the page.
- **Headers on the proxy's own responses.** When the proxy itself answers, for
  example with 502 while the container is down or with its redirect, those
  responses need the same nine headers. Use the generated header file for your
  server from the same release, listed in the
  [reference header configs](../deploy/examples/README.md), and
  `Cache-Control: no-cache`.
- **Bind and network.** A proxy in a container shares a private Docker network
  with PassGen, and PassGen publishes no ports. A proxy on the host connects to
  `127.0.0.1:8080`, published as `127.0.0.1:8080:8080`. Never publish a bare
  `8080:8080`, which listens on every interface. A proxy on another machine
  cannot use loopback: connect over an encrypted, authenticated link and allow
  only that proxy.
- **Redirect HTTP to HTTPS at the proxy.** Never in the container, which only
  sees plain HTTP from the proxy and would loop.
- **Do not trust forwarded headers for decisions.** PassGen has no logins or
  cookies; `X-Forwarded-For` matters only for logs.

After setting up, check the live site from a checkout of the release tag:

```sh
node scripts/verify-live.ts --url https://passgen.example.com/ --manifest /path/to/SHA256SUMS
```

Stop the container briefly and check that the proxy's 502 page also carries
the headers, for example with `curl --include https://passgen.example.com/`.

## Caddy (recommended)

Tested in CI: use the [`caddy-https` recipe](../deploy/compose/caddy-https/compose.yaml).
Caddy obtains and renews certificates by itself and redirects HTTP to HTTPS.
Its generated [Caddyfile](../deploy/compose/caddy-https/caddy/Caddyfile) proxies
to the `passgen` service on port 8080 and is otherwise the same as this version
for a Caddy running on the host in front of the `localhost` recipe:

```caddyfile
{$PASSGEN_DOMAIN} {
	reverse_proxy 127.0.0.1:8080
	handle_errors {
		import /etc/caddy/passgen-headers.caddy
		header -Server
		header Cache-Control "no-cache"
		respond "PassGen is unavailable" {err.status_code}
	}
}
http://{$PASSGEN_DOMAIN} {
	import /etc/caddy/passgen-headers.caddy
	header -Server
	header Cache-Control "no-cache"
	redir https://{host}{uri} 308
}
```

`reverse_proxy` passes PassGen's responses through, headers included, so the
site block has no header rules. `handle_errors` covers responses Caddy creates
itself, such as the 502 while PassGen is down; responses from PassGen, including
its 404 and 405, are not Caddy errors and keep their own headers. The explicit
`http://` block replaces Caddy's automatic redirect so the redirect carries the
headers too; Caddy still answers ACME HTTP challenges on port 80.

DNS must point the hostname at the host, and ports 80 and 443 must be reachable,
for the default ACME challenges. If they cannot be, Caddy's DNS challenge works
with a DNS provider plugin and credentials, which needs a custom Caddy build.
Keep the `caddy_data` volume: it holds the certificates and their private keys.

To use Caddy you already run on the host instead, publish PassGen with the
`localhost` recipe and use the site blocks above with your own path to the
generated `passgen-headers.caddy`.

## Traefik with Let's Encrypt

Not CI-tested. This uses Traefik's file provider for one fixed route, so Traefik
needs no access to the Docker socket. Add these services to the `caddy-https`
recipe's `compose.yaml` in place of `caddy`, keeping its `passgen` service and
networks:

```yaml
services:
  traefik:
    image: ${TRAEFIK_IMAGE:?set a pinned Traefik image}
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.web.http.redirections.entrypoint.permanent=true
      - --providers.file.directory=/etc/traefik/dynamic
      - --certificatesresolvers.le.acme.email=${ACME_EMAIL:?set an ACME contact email}
      - --certificatesresolvers.le.acme.storage=/acme/acme.json
      - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
    environment:
      PASSGEN_HOST: passgen
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./traefik-dynamic:/etc/traefik/dynamic:ro
      - ./traefik-acme:/acme
    networks: [backend, edge]
    restart: unless-stopped
```

`traefik-dynamic/passgen.yml`:

```yaml
http:
  routers:
    passgen:
      rule: "Host(`passgen.example.com`)"
      entryPoints: [websecure]
      service: passgen
      tls:
        certResolver: le
  services:
    passgen:
      loadBalancer:
        servers:
          - url: 'http://{{ env "PASSGEN_HOST" }}:8080'
```

Traefik fills in `PASSGEN_HOST` when it reads the file, so the same route works
for Traefik running on the host against the `localhost` recipe with
`PASSGEN_HOST=127.0.0.1`.

Create `traefik-acme` readable only by its owner; it holds certificate keys.
Attach no `headers` middleware with security headers, CSP or HSTS settings to
this router, and no CORS middleware, which would answer `OPTIONS` itself.

Traefik's own responses, such as its 502 while PassGen is down and the entrypoint
redirect, carry no PassGen headers with this configuration. If you need them on
the 502, add a `headers` middleware whose `customResponseHeaders` repeat all nine
values exactly as listed in the reference header configs for the same release.
Custom headers replace the upstream copies, so every response then has one copy
of the values you set, and you must update them with every release. Route misses
and the entrypoint redirect still lack them. Headers on an HTTP redirect have no
security effect; HSTS only counts over HTTPS.

## nginx with Certbot

Not CI-tested. nginx terminates TLS, Certbot obtains and renews certificates
with the webroot method, and PassGen sits on the internal network (or on
`127.0.0.1:8080` with the `localhost` recipe if nginx runs on the host; set
`$passgen_host` to `127.0.0.1` and drop the `resolver` line).

First issue a certificate with only the port 80 server below enabled:

```sh
certbot certonly --webroot -w /var/www/acme -d passgen.example.com
```

Then enable the full configuration. Copy the generated
[nginx header file](../deploy/examples/nginx/passgen-headers.conf) from the
release to `/etc/nginx/snippets/passgen-headers.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name passgen.example.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }
    location / {
        include /etc/nginx/snippets/passgen-headers.conf;
        add_header Cache-Control "no-cache" always;
        return 308 https://passgen.example.com$request_uri;
    }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name passgen.example.com;
    ssl_certificate /etc/letsencrypt/live/passgen.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/passgen.example.com/privkey.pem;
    resolver 127.0.0.11 valid=10s;
    location / {
        set $passgen_host passgen;
        proxy_pass http://$passgen_host:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_intercept_errors off;
    }
    error_page 502 503 504 = @passgen_unavailable;
    location @passgen_unavailable {
        include /etc/nginx/snippets/passgen-headers.conf;
        add_header Cache-Control "no-cache" always;
        return 502 "PassGen is unavailable\n";
    }
}
```

The proxying `location /` has no `add_header`, so PassGen's headers pass through
as they are. Make sure no `add_header`, `proxy_hide_header` or headers-more rule
for those names is inherited from the `http` or `server` level. Keep
`proxy_intercept_errors off` so PassGen's own 404 and 405 are not replaced.
Proxying through a variable makes nginx look the name up with Docker's DNS
server at `127.0.0.11` while running, so it finds PassGen again after the
container is recreated with a new address instead of answering 502 until a
reload.

Renew with a systemd timer or cron job running `certbot renew` and reloading
nginx after a successful renewal (`--deploy-hook "systemctl reload nginx"` on a
host install). If nginx and Certbot run in containers, run the reload from the
host's scheduler; never give Certbot the Docker socket. Test renewal with
`certbot renew --dry-run`.

## Cloudflare Tunnel

Not CI-tested. A tunnel needs no inbound ports at all: the `cloudflared`
connector makes outbound connections to Cloudflare, which terminates HTTPS for
browsers. Add the connector to the `caddy-https` recipe's `compose.yaml` in place
of `caddy`, keeping its `passgen` service and networks:

```yaml
services:
  cloudflared:
    image: ${CLOUDFLARED_IMAGE:?set a pinned cloudflared image}
    command: ["tunnel", "--no-autoupdate", "run", "--token-file", "/run/secrets/tunnel_token"]
    secrets: [tunnel_token]
    networks: [backend, edge]
    restart: unless-stopped
secrets:
  tunnel_token:
    file: ./secrets/tunnel-token
```

`--token-file` needs cloudflared 2025.4.0 or later. Keep the token file out of
version control, readable by the connector's non-root user, and rotate the token
if it leaks. In the Cloudflare dashboard, create a remotely managed tunnel and
add a public hostname `passgen.example.com` with service type HTTP, pointing at
the `passgen` service on port 8080. Turn on Always Use HTTPS
for the hostname so Cloudflare redirects HTTP.

Cloudflare must not change PassGen's headers or bodies: leave zone HSTS off
(PassGen sends its own), and keep Workers, Snippets, response header transforms,
managed transforms and anything that injects scripts or challenge pages away
from this hostname. Cloudflare's own error pages, for example when the tunnel or
the container is down, do not carry PassGen's headers. A hostname-scoped
response header transform rule using **Set** with all nine exact values can add
them; Set replaces copies where Add would duplicate them. Test that rule against
real failures before relying on it.

The last hop from `cloudflared` to PassGen is plain HTTP on the private Docker
network, so SSL/TLS settings such as Full (strict) do not apply to it.

## Existing Apache or nginx on the host

The container side is the tested `localhost` recipe: PassGen on
`127.0.0.1:8080` only. Keep your proxy's existing certificate management and add
a dedicated virtual host for PassGen. These proxy configurations are not
CI-tested.

**nginx.** Use the nginx with Certbot configuration above with your own
certificate paths and `proxy_pass http://127.0.0.1:8080;`.

**Apache.** Enable `mod_ssl`, `mod_proxy`, `mod_proxy_http` and `mod_headers`.
Do not reuse the shipped static-site vhost, which disables proxying on purpose.
Apache keeps two header tables, so blindly setting headers on proxied responses
duplicates them. The vhost below takes ownership of the nine headers instead: it
removes the copies PassGen sent and sets one copy of each from the generated
[Apache header file](../deploy/examples/apache/passgen-headers.conf) on every
response, including Apache's own 502. Use the header file from the same release
as the image:

```apache
<VirtualHost *:443>
    ServerName passgen.example.com
    SSLEngine On
    SSLCertificateFile /etc/pki/tls/certs/passgen.example.com.pem
    SSLCertificateKeyFile /etc/pki/tls/private/passgen.example.com.key
    ProxyRequests Off
    ProxyPreserveHost On
    ProxyErrorOverride Off
    ProxyPass "/" "http://127.0.0.1:8080/"
    ProxyPassReverse "/" "http://127.0.0.1:8080/"
    RequestHeader set X-Forwarded-Proto "https"
    Header always set Cache-Control "no-cache" "expr=%{REQUEST_STATUS} -ge 500"
    Header onsuccess unset Content-Security-Policy
    Header onsuccess unset Strict-Transport-Security
    Header onsuccess unset X-Content-Type-Options
    Header onsuccess unset X-Frame-Options
    Header onsuccess unset Referrer-Policy
    Header onsuccess unset Permissions-Policy
    Header onsuccess unset Cross-Origin-Opener-Policy
    Header onsuccess unset Cross-Origin-Embedder-Policy
    Header onsuccess unset Cross-Origin-Resource-Policy
    Include /etc/httpd/passgen/passgen-headers.conf
</VirtualHost>
<VirtualHost *:80>
    ServerName passgen.example.com
    Redirect permanent / https://passgen.example.com/
</VirtualHost>
```

`ProxyErrorOverride Off` keeps PassGen's own 404 and 405 pages. Check that no
global `Header` rule adds a second copy of any of the nine headers.
