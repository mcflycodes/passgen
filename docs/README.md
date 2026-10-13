# PassGen documentation

PassGen is a password and passphrase generator that runs entirely in the browser,
shipped as a folder of static files. Start with the install page that matches
your setup; the reference guides hold every detail.

## Install

| Page | For |
|---|---|
| [Install by hand](Install-by-hand.md) | Download, unzip and point your web server at it. The shortest path. |
| [Install script](Install-script.md) | One verified command on a Linux server, with backups and automatic rollback. |
| [Docker](Install-Docker.md) | The official image: setup behind HTTPS, parameters, support and updates. |
| [AI agent](Install-AI-agent.md) | Let your agent ask, plan and install, with your approval. |
| [Apache](Install-Apache.md) | Site config and security headers for Apache httpd. |
| [nginx](Install-nginx.md) | Site config and security headers for nginx. |
| [Caddy](Install-Caddy.md) | Site block and security headers for Caddy. |
| [Static hosts and CDNs](Static-hosts-and-CDNs.md) | Cloudflare Pages, Netlify, any static host, and CDN settings. |

Reference guides: [Self-hosting](self-hosting.md) (every server rule, CDN
setting and fully verified procedure), [installer reference](install-release.md),
[Docker recipes without the PassGen image](docker.md) and
[HTTPS in front of the container](docker-https.md).

## Configure

| Page | Covers |
|---|---|
| [Configuration](Configuration.md) | The configuration file, page text, links, saved settings and strength estimates. |
| [Styles](Styles.md) | The five shipped styles, the style rules and adding a style. |
| [Word lists](Word-lists.md) | The five passphrase word lists, their sources, licenses and checks. |
| [How it works](How-it-works.md) | How passwords and passphrases are generated, and how the page is wired. |

## Operate

| Page | Covers |
|---|---|
| [Security headers](Security-headers.md) | Where the headers and CSP come from, the build checks, checking a deployed copy. |
| [Verification](verify.md) | The build manifest, live checks and what a mismatch means. |
| [Security policy](../SECURITY.md) | Supported versions, private vulnerability reporting and the security model. |

## Project

| Page | Covers |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Setup, commands, checks and contribution guidelines. |
| [Releasing](releasing.md) | Cutting a release and publishing the container image. |
| [Changelog](../CHANGELOG.md) | What changed in each release. |
| [License](../LICENSE) | Apache-2.0; word list credits are in [NOTICE](../NOTICE). |
