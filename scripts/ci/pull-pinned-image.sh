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
# jitter between attempts. Only an attempt's terminal error is classified (the
# last "ERROR"/"Error" line, else the last line); for run, it must also name the
# selected source, so build, export and push errors are never retried:
#   - rate limits (429), 5xx and network errors are retried;
#   - a missing manifest or digest mismatch drops that source for the rest of the run;
#   - any other failure (a real build error, say) stops at once with its exit status.
# All attempts share one hard deadline, PINNED_IMAGE_DEADLINE (Unix seconds), or
# PINNED_IMAGE_BUDGET seconds from now (default 480): each attempt is stopped,
# kill grace included, by then, so an outage fails loudly well inside the job
# timeout. No logins: every source is pulled anonymously.
set -euo pipefail

BUDGET=${PINNED_IMAGE_BUDGET:-480}
ATTEMPT_TIMEOUT=${PINNED_IMAGE_ATTEMPT_TIMEOUT:-240}
BACKOFF_BASE=2
BACKOFF_MAX=60
# Seconds between TERM and KILL for an attempt that overruns, reserved inside the deadline.
KILL_GRACE=5

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

RETRYABLE='attempt timed out|toomanyrequests|too many requests|rate exceeded|data limit exceeded|rate limit|(status|status code|HTTP/[0-9.]+):? (429|5[0-9][0-9])\b|\b(429|5[0-9][0-9]) (too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)|internal server error|bad gateway|service unavailable|gateway time-?out|i/o timeout|TLS handshake timeout|connection reset|connection refused|unexpected EOF|no such host|temporary failure in name resolution|network is unreachable|context deadline exceeded|Client\.Timeout'
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

# docker pull, then confirm the daemon holds the image under the pinned digest.
# Fixed code run by bash -c, so the pull and the check share one attempt timeout.
# shellcheck disable=SC2016
PULL_AND_CONFIRM='docker pull --quiet "$1" || exit
docker image inspect --format "{{.Id}}" "$1" > /dev/null 2>&1 ||
  { echo "Error: digest mismatch: $1 is not in the local image store after pulling" >&2; exit 1; }'

# Classifies a failed attempt from its terminal error only. Sets KIND to retry,
# drop or fatal, and REASON. In run mode the error must name the selected source:
# the command may also push or export, and those failures are never retried.
classify() {
  local mode=$1 source=$2 status=$3 terminal path
  if ((status == 124 || status == 137)); then
    REASON="attempt timed out"
    if [[ "$mode" == pull ]]; then KIND=retry; else KIND=fatal; fi
    return
  fi
  terminal=$(grep -E '^(ERROR|Error|error)[: ]' "$work/output" | tail -n 1 || true)
  [[ -n "$terminal" ]] || terminal=$(grep -v '^[[:space:]]*$' "$work/output" | tail -n 1 || true)
  # The cause is at the end of a long BuildKit error.
  REASON=$terminal
  ((${#REASON} <= 300)) || REASON="...${REASON: -300}"
  KIND=fatal
  path=${source%@*}
  path=${path#*/}
  if [[ "$mode" == run && "$terminal" != *"$path"* ]]; then return; fi
  if grep -Eiq "$RETRYABLE" <<< "$terminal"; then
    KIND=retry
  elif grep -Eiq "$SOURCE_FAILURE" <<< "$terminal"; then
    KIND=drop
  fi
}

# Runs one command against REF's sources until it succeeds. "{image}" in the
# command's arguments is replaced by source@digest. Sets CHOSEN on success.
attempt_all() {
  local mode=$1 ref=$2 attempt=0 next=0 source status delay remaining arg pid
  shift 2
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
    # The extra second covers date +%s rounding down.
    remaining=$((deadline - $(now) - KILL_GRACE - 1))
    ((remaining > 0)) || die "$ref: deadline reached after $((attempt - 1)) attempts"
    ((remaining < ATTEMPT_TIMEOUT)) || remaining=$ATTEMPT_TIMEOUT
    next=$((next % ${#active[@]}))
    source="${active[next]}@$DIGEST"
    local -a command=()
    for arg in "$@"; do command+=("${arg//\{image\}/$source}"); done
    log "attempt $attempt: $source"
    # timeout leads its own process group. Once it returns, KILL anything left in
    # that group, such as a TERM-ignoring grandchild, so nothing outlives the
    # attempt or the deadline. Output goes to a file, streamed to the log as it comes.
    : > "$work/output"
    timeout --kill-after="$KILL_GRACE" "$remaining" "${command[@]}" > "$work/output" 2>&1 &
    pid=$!
    tail -s 0.2 -n +1 -f --pid="$pid" "$work/output" >&2 &
    status=0
    wait "$pid" || status=$?
    kill -KILL -- "-$pid" 2> /dev/null || true
    wait "$!" || true
    if ((status == 0)); then
      CHOSEN=$source
      log "attempt $attempt: $source succeeded"
      return 0
    fi
    classify "$mode" "$source" "$status"
    case "$KIND" in
      retry)
        log "attempt $attempt: $source failed (retryable): $REASON"
        next=$((next + 1))
        ;;
      drop)
        log "attempt $attempt: $source failed (dropping this source): $REASON"
        active=("${active[@]:0:next}" "${active[@]:next+1}")
        ((${#active[@]} > 0)) || die "$ref: no source serves $DIGEST"
        ;;
      *)
        die "$ref: attempt $attempt on $source failed with status $status (not a registry error for this source; not retried): $REASON" "$status"
        ;;
    esac
  done
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
      attempt_all pull "$ref" bash -c "$PULL_AND_CONFIRM" pull-pinned-image "{image}"
      echo "$CHOSEN"
    done
    ;;
  run)
    (($# >= 4)) && [[ "$3" == -- ]] || die "usage: $0 run REF -- COMMAND..." 2
    ref=$2
    shift 3
    [[ "$*" == *"{image}"* ]] || die "the command must use {image}" 2
    attempt_all run "$ref" "$@"
    ;;
  *) die "usage: $0 sources|pull|run ..." 2 ;;
esac
