<!-- Generated from security/headers.ts by `pnpm headers:gen`. Do not edit by hand. -->

# Reference header configs

PassGen is a folder of static files that works on any static web server. The page
carries its Content Security Policy in a `<meta>` tag, so its main protections
hold everywhere. Some protections only work as HTTP headers: HSTS, framing
protection, the referrer and permissions policies, and the CSP header itself. These
files set all of them for common servers. Copy the one you need; none is required
and none is preferred.

Header snippets here are generated from `security/headers.ts`. To change a header, edit
that file and run `pnpm headers:gen`; CI fails if these files drift from it. Full site configs are generated from
`scripts/lib/site-configs.ts` and include the matching header snippet. See
the self-hosting guide under docs/ for setup and constraints.

| File | Server |
|---|---|
| `apache/passgen-headers.conf` | Apache httpd (mod_headers) |
| `caddy/passgen-headers.caddy` | Caddy |
| `cloudflare-pages/_headers` | Cloudflare Pages |
| `netlify/_headers` | Netlify |
| `nginx/passgen-headers.conf` | nginx |

Required headers (every response, including 404):

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; manifest-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(self), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
