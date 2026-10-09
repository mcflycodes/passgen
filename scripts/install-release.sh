#!/usr/bin/env bash
# install-release.sh: install a PassGen release onto a Linux static web server.
#
# Downloads one tagged release (the zip, its .sha256 and the SHA256SUMS build
# manifest), verifies every byte before it goes anywhere near the web root,
# backs up the current web root, switches to the new files, verifies the result
# and restores the backup automatically if anything fails. docs/install-release.md
# has the full reference.
#
# Usage:
#   install-release.sh --version vX.Y.Z --docroot DIR [--repo OWNER/NAME]
#       [--from-dir DIR] [--file-mode 0644] [--dir-mode 0755]
#       [--owner USER[:GROUP]] [--backup-dir DIR] [--url https://example.com/] [--dry-run]
#
# Required:
#   --version vX.Y.Z      The exact release tag to install. There is no "latest".
#   --docroot DIR         The directory the web server serves. Created if missing.
#
# Options:
#   --repo OWNER/NAME     GitHub repository that publishes the releases. Default:
#                         the "repository" field of the package.json next to this
#                         script, else the origin remote of the checkout it is in.
#   --from-dir DIR        Take passgen-X.Y.Z.zip, passgen-X.Y.Z.zip.sha256 and
#                         SHA256SUMS from DIR instead of downloading them.
#   --file-mode MODE      Mode for every installed file. Default 0644.
#   --dir-mode MODE       Mode for the docroot and every directory in it. Default 0755.
#   --owner USER[:GROUP]  Owner (and group) for the docroot and everything in it,
#                         applied with chown after the files are in place.
#                         Default: unchanged.
#   --backup-dir DIR      Where backups go, one subdirectory per run, named by
#                         UTC timestamp. Default: a sibling of the docroot named
#                         .<docroot-name>-backups. The newest 3 are kept.
#   --url https://example.com/   After installing, fetch every released file from this
#                         URL, compare it with the release and check that
#                         index.html carries the nine security headers (names
#                         only; scripts/verify-live.ts checks the values).
#   --local-http          Allow a plain http:// --url on 127.0.0.1, localhost or
#                         [::1]. For local tests only.
#   --dry-run             Download and verify the release, then print every
#                         install action without touching the docroot or backups.
#   -h, --help            Print this text.
#
# Needs bash 4.4+, GNU coreutils and findutils, sha256sum, unzip, rsync, and
# curl or an authenticated gh for downloads.
#
# Exit codes:
#   0  installed and verified
#   2  usage error
#   3  a required tool is missing
#   4  refused before anything was changed (unsafe docroot, backup or contents)
#   5  the release failed verification; nothing was changed
#   6  the install failed, the backup was restored and verified
#   7  the install failed and the restore could not be verified: read the output

set -euo pipefail

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "install-release: bash 4.4 or newer is required" >&2
  exit 3
fi

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)
readonly KEEP_BACKUPS=3
# The header names security/headers.ts defines; tests/unit/install-release.test.ts keeps them in sync.
readonly SECURITY_HEADER_NAMES=(
  Content-Security-Policy
  Strict-Transport-Security
  X-Content-Type-Options
  X-Frame-Options
  Referrer-Policy
  Permissions-Policy
  Cross-Origin-Opener-Policy
  Cross-Origin-Embedder-Policy
  Cross-Origin-Resource-Policy
)

version=''
docroot=''
repo=''
from_dir=''
file_mode=0644
dir_mode=0755
owner=''
backup_root=''
url=''
dry_run=0
local_http=0

# Runtime state the exit handler reads.
work=''
backup=''
backup_manifest=''
phase=start # start -> staged -> installing -> finished

# ---------------------------------------------------------------- output

log() { printf '%s\n' "$*"; }
note() { printf '==> %s\n' "$*"; }
warn() { printf 'install-release: %s\n' "$*" >&2; }
die() {
  local code=$1
  shift
  warn "$*"
  exit "$code"
}

usage() {
  sed -n '2,${/^#/!q;s/^# \{0,1\}//p}' "$SCRIPT_PATH"
}

# ---------------------------------------------------------------- arguments

parse_args() {
  local opt val
  while (($# > 0)); do
    case $1 in
      --*=*)
        opt=${1%%=*}
        val=${1#*=}
        shift
        ;;
      --dry-run)
        dry_run=1
        shift
        continue
        ;;
      --local-http)
        local_http=1
        shift
        continue
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      --version | --docroot | --repo | --from-dir | --file-mode | --dir-mode | --owner | --backup-dir | --url)
        (($# >= 2)) || die 2 "$1 needs a value (see --help)"
        opt=$1
        val=$2
        shift 2
        ;;
      *) die 2 "unknown option: $1 (see --help)" ;;
    esac
    case $opt in
      --version) version=$val ;;
      --docroot) docroot=$val ;;
      --repo) repo=$val ;;
      --from-dir) from_dir=$val ;;
      --file-mode) file_mode=$val ;;
      --dir-mode) dir_mode=$val ;;
      --owner) owner=$val ;;
      --backup-dir) backup_root=$val ;;
      --url) url=$val ;;
      *) die 2 "unknown option: $opt (see --help)" ;;
    esac
  done

  [[ -n $version ]] || die 2 "--version vX.Y.Z is required (see --help)"
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die 2 "--version must be an exact tag such as v1.2.3, not '$version'"
  [[ -n $docroot ]] || die 2 "--docroot DIR is required (see --help)"
  [[ $file_mode =~ ^[0-7]{3,4}$ ]] || die 2 "--file-mode must be octal such as 0644, not '$file_mode'"
  [[ $dir_mode =~ ^[0-7]{3,4}$ ]] || die 2 "--dir-mode must be octal such as 0755, not '$dir_mode'"
  [[ -z $owner || $owner =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?$ ]] ||
    die 2 "--owner must be USER or USER:GROUP, not '$owner'"
  [[ -z $repo || $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 2 "--repo must be OWNER/NAME, not '$repo'"
  if [[ -n $url ]]; then
    [[ $url != *@* && $url != *'?'* && $url != *'#'* ]] ||
      die 2 "--url must not carry credentials, a query or a fragment"
    if [[ $url =~ ^https://[^/]+(/.*)?$ ]]; then
      :
    elif [[ $url =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]]; then
      ((local_http)) || die 2 "--url must use https:// (plain http is only allowed on loopback with --local-http)"
    else
      die 2 "--url must be an https:// URL ending in /, not '$url'"
    fi
    [[ $url == */ ]] || url="$url/"
  fi
}

# ---------------------------------------------------------------- tools

downloader=''

check_tools() {
  local -a missing=()
  local tool
  for tool in sha256sum unzip rsync find sort uniq cut sed grep diff mktemp realpath chmod date cp rm mkdir; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die 3 "missing required tools: ${missing[*]} (install coreutils, findutils, unzip and rsync)"
  if [[ -z $from_dir ]]; then
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      downloader=gh
    elif command -v curl >/dev/null 2>&1; then
      downloader=curl
    else
      die 3 "downloading needs curl, or gh logged in with 'gh auth login'; or pass --from-dir"
    fi
  fi
  if [[ -n $url ]]; then
    command -v curl >/dev/null 2>&1 || die 3 "--url needs curl"
  fi
}

# ---------------------------------------------------------------- repository

resolve_repo() {
  [[ -z $repo ]] || return 0
  local pkg="$SCRIPT_DIR/../package.json" text=''
  if [[ -f $pkg ]]; then
    text=$(grep -A3 '"repository"' "$pkg" || true)
    if [[ $text =~ github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+) ]]; then
      repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
    elif [[ $text =~ github:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+) ]]; then
      repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
  fi
  if [[ -z $repo ]] && command -v git >/dev/null 2>&1; then
    text=$(git -C "$SCRIPT_DIR" config --get remote.origin.url 2>/dev/null || true)
    if [[ $text =~ github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+) ]]; then
      repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
    fi
  fi
  [[ -n $repo ]] || die 2 "could not work out the release repository; pass --repo OWNER/NAME"
}

# ---------------------------------------------------------------- paths

# True when $1 is $2 or lies inside it. Both must be canonical absolute paths.
inside() {
  [[ $1 == "$2" || $1 == "$2"/* ]]
}

parent=''

preflight_paths() {
  docroot=$(realpath -m -- "$docroot")
  [[ $docroot != / ]] || die 4 "refusing to use / as the docroot"
  if [[ -e $docroot && ! -d $docroot ]]; then
    die 4 "$docroot exists and is not a directory"
  fi
  parent=$(dirname -- "$docroot")
  [[ -d $parent ]] || die 4 "the docroot's parent directory $parent does not exist"
  [[ -w $parent && -x $parent ]] ||
    die 4 "the docroot's parent directory $parent must be writable: staging and backups are created there"

  if [[ -z $backup_root ]]; then
    backup_root="$parent/.$(basename -- "$docroot")-backups"
  fi
  backup_root=$(realpath -m -- "$backup_root")
  [[ $backup_root != / ]] || die 4 "refusing to use / as the backup directory"
  ! inside "$backup_root" "$docroot" || die 4 "the backup directory $backup_root must not be inside the docroot"
  ! inside "$docroot" "$backup_root" || die 4 "the docroot $docroot must not be inside the backup directory $backup_root"
  if [[ -e $backup_root && ! -d $backup_root ]]; then
    die 4 "$backup_root exists and is not a directory"
  fi

  if [[ -n $from_dir ]]; then
    [[ -d $from_dir ]] || die 2 "--from-dir $from_dir is not a directory"
    from_dir=$(realpath -e -- "$from_dir")
    ! inside "$from_dir" "$docroot" || die 4 "--from-dir must not be inside the docroot"
  fi
}

# Refuse a docroot the backup cannot capture or the install cannot update.
preflight_docroot_contents() {
  [[ -d $docroot ]] || return 0
  local odd
  odd=$(find "$docroot" -mindepth 1 ! -type f ! -type d -printf '  %P (%y)\n')
  [[ -z $odd ]] || die 4 "the docroot has entries the backup cannot capture (only regular files and directories are supported):"$'\n'"$odd"
  odd=$(find "$docroot" \( \( -type f ! -readable \) -o \( -type d \( ! -readable -o ! -executable -o ! -writable \) \) \) -printf '  %p\n')
  [[ -z $odd ]] || die 4 "the docroot has entries this user cannot read or update:"$'\n'"$odd"
}

# ---------------------------------------------------------------- release files

zip_name=''
release=''
stage=''
manifest=''

make_work_dir() {
  work=$(mktemp -d "$parent/.passgen-install.XXXXXXXX")
  ! inside "$docroot" "$work" || die 4 "the docroot must not be inside the staging directory $work"
  release="$work/release"
  stage="$work/stage"
  mkdir -- "$release" "$stage"
  manifest="$release/SHA256SUMS"
}

fetch_release() {
  local name base
  zip_name="passgen-${version#v}.zip"
  local -a names=("$zip_name" "$zip_name.sha256" "SHA256SUMS")
  if [[ -n $from_dir ]]; then
    note "Taking release files from $from_dir"
    for name in "${names[@]}"; do
      [[ -f "$from_dir/$name" && ! -L "$from_dir/$name" ]] || die 5 "$from_dir/$name is missing or not a regular file"
      cp -- "$from_dir/$name" "$release/$name"
    done
  elif [[ $downloader == gh ]]; then
    note "Downloading $version from $repo with gh"
    gh release download "$version" --repo "$repo" --dir "$release" \
      --pattern "$zip_name" --pattern "$zip_name.sha256" --pattern SHA256SUMS ||
      die 5 "gh could not download release $version from $repo"
  else
    base="https://github.com/$repo/releases/download/$version"
    note "Downloading $version from $base with curl"
    for name in "${names[@]}"; do
      curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --retry 3 \
        --output "$release/$name" -- "$base/$name" || die 5 "could not download $base/$name"
    done
  fi
  for name in "${names[@]}"; do
    [[ -f "$release/$name" ]] || die 5 "release $version has no $name"
  done
}

verify_zip_checksum() {
  local line hash name actual
  IFS= read -r line <"$release/$zip_name.sha256" || true
  hash=${line%%[[:space:]]*}
  name=${line#"$hash"}
  name=${name#"${name%%[![:space:]]*}"}
  name=${name#\*}
  [[ $hash =~ ^[0-9a-f]{64}$ ]] || die 5 "$zip_name.sha256 is not a sha256sum line"
  [[ $name == "$zip_name" ]] || die 5 "$zip_name.sha256 names '$name', expected $zip_name"
  actual=$(sha256sum -- "$release/$zip_name" | cut -d' ' -f1)
  [[ $actual == "$hash" ]] || die 5 "$zip_name checksum mismatch: expected $hash, got $actual"
  log "    $zip_name matches its .sha256"
}

# A relative path with no empty, "." or ".." component, no backslash, no control character.
safe_relative_path() {
  case $1 in
    '' | /* | ../* | */../* | */.. | .. | ./* | */./* | */. | . | */ | *//*) return 1 ;;
    *\\* | *[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

check_zip_entries() {
  local zipfile="$release/$zip_name" names name dupes types n_names n_types bad
  names=$(unzip -Z1 "$zipfile") || die 5 "$zip_name is not a zip file unzip can read"
  [[ -n $names ]] || die 5 "$zip_name is empty"
  while IFS= read -r name; do
    safe_relative_path "${name%/}" || die 5 "unsafe path in $zip_name: '$name'"
  done <<<"$names"
  dupes=$(printf '%s\n' "$names" | LC_ALL=C sort | uniq -d)
  [[ -z $dupes ]] || die 5 "duplicate entries in $zip_name:"$'\n'"$dupes"
  # zipinfo's long listing starts each entry with its type: - file, d directory,
  # ? no type bits (unzip treats it as a file), l symbolic link, b/c device, p pipe, s socket.
  n_names=$(printf '%s\n' "$names" | grep -c '')
  types=$(unzip -Z "$zipfile" | sed -nE 's/^([-dlbcps?])[-a-zA-Z]+[[:space:]]+[0-9]+\.[0-9]+[[:space:]]+[a-z]{3}[[:space:]].*/\1/p')
  n_types=$(printf '%s' "$types" | grep -c '' || true)
  [[ $n_types == "$n_names" ]] || die 5 "could not read the entry types of $zip_name ($n_types of $n_names)"
  bad=$(printf '%s' "$types" | grep -vc '^[-d?]$' || true)
  [[ $bad == 0 ]] || die 5 "$zip_name has $bad entries that are not regular files or directories (symbolic links, devices or other special entries)"
}

# Every manifest line is 'sha256  path' with a safe relative path, and index.html is listed.
validate_manifest() {
  local bad path
  bad=$(grep -nvE '^[0-9a-f]{64}  [^[:space:]].*$' "$manifest" || true)
  [[ -z $bad ]] || die 5 "SHA256SUMS has lines that are not 'sha256  path':"$'\n'"$bad"
  while IFS= read -r path; do
    safe_relative_path "$path" || die 5 "unsafe path in SHA256SUMS: '$path'"
  done < <(manifest_paths)
  manifest_paths | grep -qx 'index.html' || die 5 "SHA256SUMS does not list index.html"
}

manifest_paths() {
  cut -c67- "$manifest"
}

# verify_tree DIR MANIFEST LABEL: DIR holds exactly the manifest's files, as
# regular files, with matching hashes. Prints what differs and returns 1 otherwise.
verify_tree() {
  local dir=$1 tree_manifest=$2 label=$3 odd expected actual
  odd=$(find "$dir" -mindepth 1 ! -type f ! -type d -printf '  %P (%y)\n')
  if [[ -n $odd ]]; then
    warn "$label: entries that are not regular files or directories:"$'\n'"$odd"
    return 1
  fi
  expected=$(cut -c67- "$tree_manifest" | LC_ALL=C sort)
  actual=$(find "$dir" -type f -printf '%P\n' | LC_ALL=C sort)
  if [[ $expected != "$actual" ]]; then
    warn "$label: the file set differs from the manifest:"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") |
      sed -n 's/^< /  missing: /p; s/^> /  extra: /p' >&2 || true
    return 1
  fi
  if [[ -n $expected ]]; then
    (cd "$dir" && sha256sum --check --strict --quiet -- "$tree_manifest") || {
      warn "$label: hashes differ from the manifest"
      return 1
    }
  fi
}

unpack_and_verify() {
  note "Verifying $zip_name"
  verify_zip_checksum
  check_zip_entries
  validate_manifest
  unzip -q -n -d "$stage" "$zipfile_path" || die 5 "unzip failed on $zip_name"
  local count
  count=$(manifest_paths | grep -c '' || true)
  verify_tree "$stage" "$manifest" "staged release" || die 5 "$zip_name does not match SHA256SUMS; nothing was changed"
  log "    $count files match SHA256SUMS"
  phase=staged
}

# ---------------------------------------------------------------- install

# Backups and rollbacks keep modes and times; ownership too when running as root.
copy_flags=(-rtp --no-links)
if ((EUID == 0)); then
  copy_flags+=(-og)
fi

set_modes() {
  local dir=$1
  find "$dir" -type d -exec chmod "$dir_mode" -- {} +
  find "$dir" -type f -exec chmod "$file_mode" -- {} +
}

take_backup() {
  local ts n
  mkdir -p -- "$backup_root"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$backup_root/$ts"
  n=1
  while [[ -e $backup ]]; do
    n=$((n + 1))
    backup="$backup_root/$ts-$n"
  done
  note "Backing up $docroot to $backup"
  mkdir -- "$backup"
  rsync "${copy_flags[@]}" -- "$docroot/" "$backup/"
  backup_manifest="$work/backup.SHA256SUMS"
  (cd "$backup" && find . -type f -printf '%P\n' | LC_ALL=C sort | while IFS= read -r f; do sha256sum -- "$f"; done) >"$backup_manifest"
  verify_tree "$docroot" "$backup_manifest" "backup" ||
    die 4 "the backup in $backup does not match the docroot; nothing was changed"
}

rotate_backups() {
  local -a old=()
  local name
  mapfile -t old < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
    -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z(-[0-9]+)?' -printf '%f\n' |
    LC_ALL=C sort | head -n -"$KEEP_BACKUPS")
  for name in "${old[@]}"; do
    note "Removing old backup $backup_root/$name"
    rm -rf -- "${backup_root:?}/$name"
  done
}

# Three passes so the page never references assets that are not there yet:
# new assets first, index.html second (rsync renames it into place), stale files last.
apply_release() {
  note "Installing $version into $docroot"
  set_modes "$stage"
  rsync -rt --checksum --no-links --exclude=/index.html -- "$stage/" "$docroot/"
  rsync -rt --checksum --no-links --include=/index.html --exclude='*' -- "$stage/" "$docroot/"
  rsync -rt --checksum --delete --no-links -- "$stage/" "$docroot/"
  set_modes "$docroot"
  if [[ -n $owner ]]; then
    chown -R -- "$owner" "$docroot"
  fi
}

post_check() {
  note "Checking the installed files"
  verify_tree "$docroot" "$manifest" "installed files" || die 6 "the docroot does not match the release after install"
  log "    $docroot matches SHA256SUMS"
  if [[ -n $url ]]; then
    note "Checking $url"
    check_url || die 6 "the site at $url does not serve the installed release"
  fi
}

check_url() {
  local line hash path body="$work/fetch" headers="$work/headers" code actual protos='=https' header
  local -a missing=()
  ((local_http)) && protos='=http,https'
  while IFS= read -r line; do
    hash=${line:0:64}
    path=${line:66}
    code=$(curl --silent --show-error --max-redirs 0 --retry 2 --proto "$protos" \
      --header 'Accept-Encoding: identity' --dump-header "$headers" --output "$body" \
      --write-out '%{http_code}' -- "$url$path") || {
      warn "$url$path: request failed"
      return 1
    }
    if [[ $code != 200 ]]; then
      warn "$url$path: status $code, expected 200"
      return 1
    fi
    actual=$(sha256sum <"$body" | cut -d' ' -f1)
    if [[ $actual != "$hash" ]]; then
      warn "$url$path: the served file differs from the release"
      return 1
    fi
    if [[ $path == index.html ]]; then
      for header in "${SECURITY_HEADER_NAMES[@]}"; do
        grep -qi "^$header:" "$headers" || missing+=("$header")
      done
      if ((${#missing[@]} > 0)); then
        warn "${url}index.html is missing security headers: ${missing[*]}"
        return 1
      fi
    fi
  done <"$manifest"
  log "    every released file is served with its release hash; index.html has all ${#SECURITY_HEADER_NAMES[@]} security headers"
}

dry_run_plan() {
  local p='[dry-run]'
  note "Dry run: nothing below is applied"
  [[ -d $docroot ]] || log "$p would create $docroot"
  log "$p would back up $docroot to $backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
  log "$p would apply the release with rsync (new assets, then index.html, then deletions):"
  if [[ -d $docroot ]]; then
    rsync -rtn --itemize-changes --checksum --delete --no-links -- "$stage/" "$docroot/" | sed 's/^/    /'
  else
    find "$stage" -type f -printf '    +%P\n' | LC_ALL=C sort
  fi
  log "$p would chmod directories $dir_mode and files $file_mode in $docroot"
  [[ -z $owner ]] || log "$p would chown -R $owner $docroot"
  log "$p would re-hash $docroot against SHA256SUMS"
  [[ -z $url ]] || log "$p would fetch every file from $url and check the ${#SECURITY_HEADER_NAMES[@]} security headers on index.html"
  log "$p would keep the newest $KEEP_BACKUPS backups in $backup_root"
}

# ---------------------------------------------------------------- rollback and exit

rollback() {
  rsync "${copy_flags[@]}" --checksum --delete --no-links -- "$backup/" "$docroot/" || return 1
  verify_tree "$docroot" "$backup_manifest" "rollback"
}

cleanup() {
  [[ -z $work ]] || rm -rf -- "$work"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [[ $phase == installing ]]; then
    warn "installing $version into $docroot failed (exit $rc); restoring the backup from $backup"
    if rollback; then
      warn "rollback complete: $docroot matches the backup taken before the install"
      rc=6
    else
      warn "ROLLBACK NOT VERIFIED: restore $docroot by hand from $backup"
      rc=7
    fi
  fi
  cleanup
  exit "$rc"
}

# ---------------------------------------------------------------- main

main() {
  parse_args "$@"
  check_tools
  [[ -n $from_dir ]] || resolve_repo
  preflight_paths
  preflight_docroot_contents
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  make_work_dir
  fetch_release
  zipfile_path="$release/$zip_name"
  unpack_and_verify

  if ((dry_run)); then
    dry_run_plan
    return 0
  fi

  if [[ ! -d $docroot ]]; then
    note "Creating $docroot"
    mkdir -- "$docroot"
    chmod "$dir_mode" -- "$docroot"
  fi
  take_backup
  phase=installing
  apply_release
  post_check
  phase=finished
  rotate_backups
  note "Installed $version into $docroot; backup in $backup"
}

zipfile_path=''
main "$@"
