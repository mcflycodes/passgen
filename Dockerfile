# Official PassGen image: the verified static build, served over plain HTTP on
# port 8080 by unprivileged nginx. Put it behind an HTTPS reverse proxy.
#
# The build context must already hold the files to publish in dist/: CI builds
# them with `pnpm build`, and releases unpack the verified release archive.
# No RUN instructions: the image adds files only, so other platforms build
# without emulation and no package manager runs.
#
# Runtime contract: UID 101, GID 101 (the base image's nginx user). Works with a
# read-only root filesystem, a small /tmp tmpfs, no capabilities and
# no-new-privileges. Configuration and site files are owned by root and are not
# writable by the nginx user. Logs go to stdout and stderr.
#
# Base: nginx's own unprivileged Alpine slim image, from its AWS ECR Public copy
# (same multi-platform index digest as Docker Hub), pinned by index digest.
FROM public.ecr.aws/nginx/nginx-unprivileged:1.30.5-alpine-slim@sha256:3af0c10d960cc2502427fe1219c52989d309e7d65596869c60a34fd2fa2406f0 AS upstream

FROM upstream

ARG PASSGEN_VERSION=0.0.0
ARG PASSGEN_REVISION=unknown
ARG PASSGEN_CREATED=1970-01-01T00:00:00Z

# Replaces every label inherited from the base image.
LABEL maintainer="" \
      org.opencontainers.image.title="PassGen" \
      org.opencontainers.image.description="Client-side password and passphrase generator served over HTTP on port 8080 by unprivileged nginx" \
      org.opencontainers.image.url="https://github.com/mcflycodes/passgen" \
      org.opencontainers.image.source="https://github.com/mcflycodes/passgen" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${PASSGEN_VERSION}" \
      org.opencontainers.image.revision="${PASSGEN_REVISION}" \
      org.opencontainers.image.created="${PASSGEN_CREATED}"

# The base image lets the nginx user write /etc/nginx; PassGen's configuration
# lives in a root-owned directory instead, and the base's default site is unused.
COPY --from=upstream --chown=0:0 --chmod=0644 /etc/nginx/mime.types /etc/passgen/mime.types
COPY --chown=0:0 --chmod=0644 deploy/container/nginx.conf deploy/container/passgen-site.conf /etc/passgen/
COPY --chown=0:0 --chmod=0644 deploy/examples/nginx/passgen-headers.conf /etc/passgen/passgen-headers.conf
COPY --chown=0:0 dist/ /srv/passgen/

USER 101:101
EXPOSE 8080
STOPSIGNAL SIGQUIT

# BusyBox wget is already in the base image; nothing is added for the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=2s --retries=3 \
  CMD ["wget", "-q", "-T", "3", "-U", "passgen-healthcheck", "-O", "/dev/null", "http://127.0.0.1:8080/index.html"]

# Start nginx directly: the base entrypoint's scripts would edit /etc/nginx.
ENTRYPOINT ["nginx", "-c", "/etc/passgen/nginx.conf"]
CMD []
