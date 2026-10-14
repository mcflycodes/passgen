#!/usr/bin/env bash
# Pulls digest-pinned third-party images in CI with registry fallback and retries.
#
#   pull-pinned-image.sh sources REF            list the refs tried for REF, in order
#   pull-pinned-image.sh pull REF...            docker pull each REF; print the ref used, one per line
#   pull-pinned-image.sh run REF -- COMMAND...  run COMMAND with each "{image}" in its arguments
#                                               replaced by the ref used, e.g. a build's
#                                               --build-context "upstream=docker-image://{image}"
#
# REF must be pinned as name[:tag]@sha256:<digest>. Every source is tried as
# source@sha256:<digest>, never by tag, so Docker and BuildKit verify the bytes
# against the pinned digest whichever registry serves them. Sources are tried
# round-robin, starting with the pinned registry, with exponential backoff and
# jitter between attempts:
#   - rate limits (429), 5xx and network errors are retried;
#   - a missing manifest or digest mismatch drops that source for the rest of the run;
#   - any other failure (a real build error, say) stops at once with its exit status.
# All attempts share one deadline, PINNED_IMAGE_DEADLINE (Unix seconds), or
# PINNED_IMAGE_BUDGET seconds from now (default 480), so an outage fails loudly
# well inside the job timeout. No logins: every source is pulled anonymously.
set -euo pipefail

BUDGET=${PINNED_IMAGE_BUDGET:-480}
ATTEMPT_TIMEOUT=${PINNED_IMAGE_ATTEMPT_TIMEOUT:-240}
BACKOFF_BASE=2
BACKOFF_MAX=60

# Each repository's sources, pinned registry first. Before adding a source or
# changing a pin, confirm the pinned index digest resolves byte-for-byte on
# every source listed (docs/releasing.md, "Refresh pinned images").
sources_for() {
  case "$1" in
    public.ecr.aws/docker/library/caddy | public.ecr.aws/docker/library/httpd | public.ecr.aws/docker/library/nginx)
      echo "$1 docker.io/library/${1##*/} mirror.gcr.io/library/${1##*/}" ;;
    public.ecr.aws/nginx/nginx-unprivileged)
      echo "$1 docker.io/nginxinc/nginx-unprivileged mirror.gcr.io/nginxinc/nginx-unprivileged" ;;
    # Not published on AWS ECR Public.
    mirror.gcr.io/moby/buildkit)
      echo "$1 docker.io/moby/buildkit" ;;
    *) return 1 ;;
  esac
}

RETRYABLE='toomanyrequests|too many requests|rate exceeded|data limit exceeded|rate limit|(status|status code|HTTP/[0-9.]+):? (429|5[0-9][0-9])\b|\b(429|5[0-9][0-9]) (too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)|internal server error|bad gateway|service unavailable|gateway time-?out|i/o timeout|TLS handshake timeout|connection reset|connection refused|unexpected EOF|no such host|temporary failure in name resolution|network is unreachable|context deadline exceeded|Client\.Timeout|attempt timed out'
SOURCE_FAILURE='manifest unknown|name unknown|manifest for [^ ]+ not found|@sha256:[a-f0-9]{64}: not found|digest mismatch|unexpected digest|does not match (the )?(expected )?digest|repository does not exist|pull access denied|requested access to the resource is denied|unauthorized'

log() { echo "pull-pinned-image: $*" >&2; }
die() { log "FAIL: $1"; exit "${2:-1}"; }
now() { date +%s; }

# Splits REF into REPO and DIGEST, or fails for anything not pinned by digest.
parse() {
  [[ "$1" =~ ^([a-z0-9.-]+(/[a-z0-9._-]+)+)(:[A-Za-z0-9_][A-Za-z0-9._-]*)?@(sha256:[a-f0-9]{64})$ ]] ||
    die "$1 is not pinned as name[:tag]@sha256:<digest>" 2
  REPO=${BASH_REMATCH[1]}
  DIGEST=${BASH_REMATCH[4]}
  SOURCES=$(sources_for "$REPO") || die "$REPO has no verified sources in ${BASH_SOURCE[0]}" 2
}

deadline=${PINNED_IMAGE_DEADLINE:-$(($(now) + BUDGET))}
[[ "$deadline" =~ ^[0-9]+$ ]] || die "PINNED_IMAGE_DEADLINE must be Unix seconds" 2
work=$(mktemp -d "${TMPDIR:-/tmp}/pull-pinned-image-XXXX")
trap 'rm -rf "$work"' EXIT

# Runs one command against REF's sources until it succeeds. "{image}" in the
# command's arguments is replaced by source@digest. Sets CHOSEN on success.
attempt_all() {
  local ref=$1 attempt=0 next=0 source status delay remaining reason arg
  shift
  parse "$ref"
  local -a active
  read -r -a active <<< "$SOURCES"
  while :; do
    attempt=$((attempt + 1))
    if ((attempt > 1)); then
      delay=$((BACKOFF_BASE << (attempt - 2 < 6 ? attempt - 2 : 6)))
      ((delay <= BACKOFF_MAX)) || delay=$BACKOFF_MAX
      delay=$((delay / 2 + RANDOM % (delay - delay / 2 + 1)))
      (($(now) + delay < deadline)) || die "$ref: gave up before attempt $attempt; the next try would pass the deadline"
      log "retrying in ${delay}s"
      sleep "$delay"
    fi
    remaining=$((deadline - $(now)))
    ((remaining > 0)) || die "$ref: deadline reached after $((attempt - 1)) attempts"
    ((remaining < ATTEMPT_TIMEOUT)) || remaining=$ATTEMPT_TIMEOUT
    next=$((next % ${#active[@]}))
    source="${active[next]}@$DIGEST"
    local -a command=()
    for arg in "$@"; do command+=("${arg//\{image\}/$source}"); done
    log "attempt $attempt: $source"
    set +e
    timeout --kill-after=10 "$remaining" "${command[@]}" 2>&1 | tee "$work/output" >&2
    status=${PIPESTATUS[0]}
    set -e
    if ((status == 0)); then
      CHOSEN=$source
      log "attempt $attempt: $source succeeded"
      return 0
    fi
    if ((status == 124 || status == 137)); then echo "attempt timed out after ${remaining}s" >> "$work/output"; fi
    reason=$(grep -Eio -m1 ".{0,80}($RETRYABLE).{0,80}" "$work/output" || true)
    if [[ -n "$reason" ]]; then
      log "attempt $attempt: $source failed (retryable): $reason"
      next=$((next + 1))
      continue
    fi
    reason=$(grep -Eio -m1 ".{0,80}($SOURCE_FAILURE).{0,80}" "$work/output" || true)
    if [[ -n "$reason" ]]; then
      log "attempt $attempt: $source failed (dropping this source): $reason"
      active=("${active[@]:0:next}" "${active[@]:next+1}")
      ((${#active[@]} > 0)) || die "$ref: no source serves $DIGEST"
      continue
    fi
    die "$ref: attempt $attempt on $source failed with status $status (not a registry error; not retried)" "$status"
  done
}

# docker pull, then confirm the daemon holds the image under the pinned digest.
pull_one() {
  docker pull --quiet "$1" || return
  docker image inspect --format '{{.Id}}' "$1" > /dev/null ||
    { echo "digest mismatch: $1 is not in the local image store after pulling" >&2; return 1; }
}

case "${1:-}" in
  sources)
    (($# == 2)) || die "usage: $0 sources REF" 2
    parse "$2"
    for source in $SOURCES; do echo "$source@$DIGEST"; done
    ;;
  pull)
    (($# >= 2)) || die "usage: $0 pull REF..." 2
    shift
    for ref in "$@"; do parse "$ref"; done
    for ref in "$@"; do
      attempt_all "$ref" bash "${BASH_SOURCE[0]}" __pull_one "{image}"
      echo "$CHOSEN"
    done
    ;;
  __pull_one)
    pull_one "$2"
    ;;
  run)
    (($# >= 4)) && [[ "$3" == -- ]] || die "usage: $0 run REF -- COMMAND..." 2
    ref=$2
    shift 3
    [[ "$*" == *"{image}"* ]] || die "the command must use {image}" 2
    attempt_all "$ref" "$@"
    ;;
  *) die "usage: $0 sources|pull|run ..." 2 ;;
esac
