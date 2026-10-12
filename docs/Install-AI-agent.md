# Install with an AI agent

If you use an AI coding agent that can run commands on your server, it can set
up PassGen for you by following the project's
[setup instructions](../agent-setup/prompt.md). The instructions make it ask
about your server first, show you a concrete plan with the exact commands, and
wait for your approval before changing anything.

**Who it's for:** anyone who already uses an agent with shell access to the
server, or to the hosting project, and wants the careful path with checksums,
backups and a rollback plan without reading every guide.

## Before you start

Have these answers ready; the agent asks for whatever is missing:

- Which server or host: Apache, nginx, Caddy, Docker with Compose, a static
  host or CDN such as Cloudflare Pages or Netlify, or something else.
- The operating system, and whether you have shell access and `sudo`.
- The hostname that will serve PassGen. It must serve nothing else; see
  [Before you start](self-hosting.md#before-you-start).
- The web root path, and which user and group should own the files.
- Whether HTTPS is already set up, and what renews the certificates.
- Whether a CDN or reverse proxy is in front, and which one.
- Which release to install. The default is the latest release, resolved to its
  exact version tag.

## Install

1. Give your agent this one line:

   > Fetch and follow the instructions at https://raw.githubusercontent.com/mcflycodes/passgen/main/agent-setup/prompt.md to set up PassGen for me.

   If it cannot fetch URLs, paste the contents of
   [agent-setup/prompt.md](../agent-setup/prompt.md) instead.

2. Answer its questions.

3. Read the plan it shows you before saying yes. It should name the host, release
   tag, web root, ownership, the config files and exact edits, how HTTPS is
   handled, the expected interruption, the checks it will run and how to undo
   everything. Silence or elapsed time never counts as approval. Any DNS, CDN or
   firewall change is asked about separately.

4. After you approve, it backs up every config it will change, downloads the
   release and verifies its checksums, installs it (on Linux with the
   [install script](Install-script.md)), applies the shipped server
   configuration with your hostname and paths, validates and reloads the server,
   and runs the live check.

5. Read its report: file hashes, exact security headers, method refusal, missing
   paths and listing, plus the things the checker cannot prove, such as the
   HTTP-to-HTTPS redirect and certificate renewal.

## Update

Ask the agent to update PassGen to a newer release with the same instructions.
It reads the new release's files at its exact tag, shows the plan again and keeps
the previous release for rollback.

## Roll back

Ask the agent to roll back. It restores the previous files and config using the
rollback it recorded, validates before reloading and verifies the result against
the previous release's checksums. If anything looks unexpected, such as a
changed backup, it stops and asks you.

## Troubleshooting

| Problem | What to do |
|---|---|
| The agent cannot fetch the URL | Paste the contents of [agent-setup/prompt.md](../agent-setup/prompt.md). |
| The agent says the downloads fail | The repository is public and needs no login. Check the server can reach GitHub, or download the three release files elsewhere and give them to it. |
| It stops because the origin is shared | PassGen needs its own hostname. Pick a dedicated one; a different path is not enough. |
| You want to do it yourself | Use [Install by hand](Install-by-hand.md) or the [install script](Install-script.md). |
