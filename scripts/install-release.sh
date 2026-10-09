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
#       [--owner USER[:GROUP]] [--backup-dir DIR] [--staging-dir DIR]
#       [--url https://example.com/] [--dry-run]
#
# Required:
#   --version vX.Y.Z      The exact release tag to install. There is no "latest".
#   --docroot DIR         The directory the web server serves. Created if missing.
#                         Must be the real directory, not a symbolic link to it.
#
# Options:
#   --repo OWNER/NAME     GitHub repository that publishes the releases. Default:
#                         the "repository" field of the package.json next to this
#                         script, else the origin remote of the checkout it is in.
#   --from-dir DIR        Take passgen-X.Y.Z.zip, passgen-X.Y.Z.zip.sha256 and
#                         SHA256SUMS from DIR instead of downloading them.
#   --file-mode MODE      Mode for every installed file. Default 0644. Must leave
#                         the owner able to read.
#   --dir-mode MODE       Mode for the docroot and every directory in it. Default
#                         0755. Must give the owner read, write and search.
#   --owner USER[:GROUP]  Owner (and group) for the docroot and everything in it.
#                         Default: none; every file is written anew, so the files
#                         belong to the user running the script.
#   --backup-dir DIR      Where backups go, one subdirectory per run. Default: a
#                         sibling of the docroot named .<docroot-name>-backups,
#                         created with mode 0700. The newest 3 are kept.
#   --staging-dir DIR     Where the release is unpacked before it is installed.
#                         Must be on the docroot's filesystem. Default: the
#                         docroot's parent directory.
#   --url https://example.com/   After installing, fetch every released file from this
#                         URL, compare it with the release and check that
#                         index.html carries the nine security headers (names
#                         only; scripts/verify-live.ts checks the values).
#   --local-http          Allow a plain http:// --url on 127.0.0.1, localhost or
#                         [::1]. For local tests only.
#   --dry-run             Check everything, download and verify the release in a
#                         private temporary directory under $TMPDIR (removed on
#                         exit), and print every install action. Writes nothing else.
#   -h, --help            Print this text.
#
# Every directory above the docroot, the backup directory and the staging
# directory must be owned by root or the user running the script, and must not
# be writable by anyone else unless it has the sticky bit (like /tmp).
#
# Needs bash 4.4+, GNU coreutils and findutils, sha256sum, unzip, rsync 3.1+,
# and curl or an authenticated gh for downloads.
#
# Exit codes:
#   0  installed and verified
#   2  usage error
#   3  a required tool is missing
#   4  refused before anything was changed (unsafe paths, docroot, backup or contents)
#   5  the release failed verification; nothing was changed
#   6  the install failed, the backup was restored and verified
#   7  the install failed and the backup was not restored, or the restore could
#      not be verified: read the output
#   8  the docroot was replaced (renamed, or swapped for a symbolic link) while
#      the script ran; it stopped writing and did not roll back: read the output

set -euo pipefail
umask 077

if ((BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4))); then
  echo "install-release: bash 4.4 or newer is required" >&2
  exit 3
fi

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_DIR=$(cd "$(dirname "$SCRIPT_PATH")" && pwd)
readonly KEEP_BACKUPS=3
# The status in_docroot returns when the docroot is no longer the directory recorded at the start.
readonly MOVED=99
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
staging_dir=''
url=''
dry_run=0
local_http=0

# Runtime state the exit handler reads.
work=''
backup=''
backup_record=''
docroot_id='' # device:inode of the docroot, recorded once its path is checked
phase=start   # start -> staged -> installing -> finished

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

# A newline at the end of a path would be stripped by command substitution and
# name a different directory, so no argument may hold a control character.
no_control() {
  [[ $2 != *[[:cntrl:]]* ]] || die 2 "$1 must not contain control characters such as a newline or carriage return"
}

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
      --version | --docroot | --repo | --from-dir | --file-mode | --dir-mode | --owner | --backup-dir | --staging-dir | --url)
        (($# >= 2)) || die 2 "$1 needs a value (see --help)"
        opt=$1
        val=$2
        shift 2
        ;;
      *) die 2 "unknown option: $1 (see --help)" ;;
    esac
    no_control "$opt" "$val"
    case $opt in
      --version) version=$val ;;
      --docroot) docroot=$val ;;
      --repo) repo=$val ;;
      --from-dir) from_dir=$val ;;
      --file-mode) file_mode=$val ;;
      --dir-mode) dir_mode=$val ;;
      --owner) owner=$val ;;
      --backup-dir) backup_root=$val ;;
      --staging-dir) staging_dir=$val ;;
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
  # The script must be able to read back what it installs, and to update and remove it later.
  (((8#$file_mode & 8#400) == 8#400)) || die 2 "--file-mode must let the owner read files (such as 0644), not '$file_mode'"
  (((8#$dir_mode & 8#700) == 8#700)) ||
    die 2 "--dir-mode must give the owner read, write and search on directories (such as 0755), not '$dir_mode'"
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
  if ((dry_run)); then
    no_control TMPDIR "${TMPDIR:-}"
  fi
}

# ---------------------------------------------------------------- tools

downloader=''

check_tools() {
  local -a missing=()
  local tool
  for tool in sha256sum unzip rsync find sort uniq cut sed grep diff cmp mktemp realpath stat chmod date cp rm mkdir; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die 3 "missing required tools: ${missing[*]} (install coreutils, findutils, diffutils, unzip and rsync)"
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

# The owners trusted for the directories on the way to the docroot, the backups
# and the staging directory: root and the user running this script. Inside a
# user namespace (a rootless container, or unshare -r), owners that are not
# mapped into it, the host's root among them, all show as the kernel's overflow
# ID, so that ID is trusted there too; outside one it is an ordinary account.
trusted_uids=(0 "$EUID")
init_trusted_uids() {
  local inner outer count
  [[ -r /proc/self/uid_map && -r /proc/sys/kernel/overflowuid ]] || return 0
  read -r inner outer count </proc/self/uid_map || return 0
  if [[ "$inner $outer $count" != "0 0 4294967295" ]]; then
    trusted_uids+=("$(</proc/sys/kernel/overflowuid)")
  fi
}

trusted_uid() {
  local uid
  for uid in "${trusted_uids[@]}"; do
    [[ $1 != "$uid" ]] || return 0
  done
  return 1
}

# check_trusted PATH LABEL [self]: every existing directory above PATH (and PATH
# itself with "self") must be one only root or this user can change: owned by
# one of them, and not group- or world-writable unless the sticky bit is set.
# This is the rule sshd's StrictModes applies. Without it another user could
# rename a directory on the path and leave a symbolic link in its place.
check_trusted() {
  local dir=$1 label=$2 uid mode type
  if [[ ${3:-} != self ]]; then
    dir=${dir%/*}
    dir=${dir:-/}
  fi
  while :; do
    if [[ -e $dir || -L $dir ]]; then
      read -r uid mode type < <(stat -c '%u %a %F' -- "$dir")
      [[ $type == directory ]] || die 4 "$dir, on the path to the $label, is a $type, not a directory"
      trusted_uid "$uid" ||
        die 4 "$dir, on the path to the $label, is owned by uid $uid; only root or uid $EUID, which runs this script, may own it"
      if (((8#$mode & 8#022) && !(8#$mode & 8#1000))); then
        die 4 "$dir, on the path to the $label, is writable by other users (mode $mode); remove group and other write access, or set the sticky bit"
      fi
    fi
    [[ $dir != / ]] || break
    dir=${dir%/*}
    dir=${dir:-/}
  done
}

device_of() {
  stat -c %d -- "$1"
}

parent=''

preflight_paths() {
  local given=$docroot uid mode fs_dir

  # Refuse a symbolic link rather than follow it: the link could be repointed
  # between the checks below and the writes.
  while [[ $given == */ && $given != / ]]; do
    given=${given%/}
  done
  if [[ -L $given ]]; then
    die 4 "--docroot $given is a symbolic link; pass the directory it points to ($(realpath -m -- "$given")) instead"
  fi
  docroot=$(realpath -m -- "$docroot")
  [[ $docroot != / ]] || die 4 "refusing to use / as the docroot"
  if [[ -e $docroot && ! -d $docroot ]]; then
    die 4 "$docroot exists and is not a directory"
  fi
  parent=${docroot%/*}
  parent=${parent:-/}
  [[ -d $parent ]] || die 4 "the docroot's parent directory $parent does not exist"
  check_trusted "$docroot" docroot
  if [[ -d $docroot ]]; then
    docroot_id=$(stat -c %d:%i -- "$docroot")
  else
    [[ -w $parent && -x $parent ]] ||
      die 4 "the docroot does not exist and its parent directory $parent is not writable, so it cannot be created"
  fi

  [[ -n $staging_dir ]] || staging_dir=$parent
  [[ -d $staging_dir ]] || die 4 "the staging directory $staging_dir does not exist"
  staging_dir=$(realpath -e -- "$staging_dir")
  ! inside "$staging_dir" "$docroot" || die 4 "the staging directory $staging_dir must not be inside the docroot"
  check_trusted "$staging_dir" "staging directory" self
  [[ -w $staging_dir && -x $staging_dir ]] || die 4 "the staging directory $staging_dir must be writable"
  fs_dir=$docroot
  [[ -d $docroot ]] || fs_dir=$parent
  if [[ $(device_of "$staging_dir") != "$(device_of "$fs_dir")" ]]; then
    if [[ $fs_dir == "$docroot" && $(device_of "$docroot") != "$(device_of "$parent")" ]]; then
      die 4 "the docroot $docroot is a mount point, so the staging directory $staging_dir is on another filesystem; pass --staging-dir with a directory on the docroot's filesystem, outside the docroot"
    fi
    die 4 "the staging directory $staging_dir is not on the docroot's filesystem; pass --staging-dir with a directory on the same filesystem as $docroot"
  fi

  if [[ -z $backup_root ]]; then
    backup_root="$parent/.${docroot##*/}-backups"
  fi
  backup_root=$(realpath -m -- "$backup_root")
  [[ $backup_root != / ]] || die 4 "refusing to use / as the backup directory"
  ! inside "$backup_root" "$docroot" || die 4 "the backup directory $backup_root must not be inside the docroot"
  ! inside "$docroot" "$backup_root" || die 4 "the docroot $docroot must not be inside the backup directory $backup_root"
  check_trusted "$backup_root" "backup directory"
  if [[ -e $backup_root ]]; then
    [[ -d $backup_root ]] || die 4 "$backup_root exists and is not a directory"
    read -r uid mode < <(stat -c '%u %a' -- "$backup_root")
    ((uid == EUID)) || die 4 "the backup directory $backup_root is owned by uid $uid, not by uid $EUID, which runs this script"
    (((8#$mode & 8#022) == 0)) ||
      die 4 "the backup directory $backup_root is writable by other users (mode $mode); make it 0700"
  fi

  if [[ -n $from_dir ]]; then
    [[ -d $from_dir ]] || die 2 "--from-dir $from_dir is not a directory"
    from_dir=$(realpath -e -- "$from_dir")
    ! inside "$from_dir" "$docroot" || die 4 "--from-dir must not be inside the docroot"
  fi
}

# in_docroot COMMAND...: run COMMAND in a subshell whose working directory is
# the docroot, after checking that the docroot path is still a real directory
# with the device and inode recorded at the start, and that the directory the
# subshell entered is that same one. COMMAND must address the docroot as ".":
# the working directory stays on the recorded directory even if the path is
# renamed or swapped for a symbolic link afterwards. Returns MOVED if the check
# fails, otherwise COMMAND's status. Callers test that status, so errexit is off
# inside: COMMAND must report its own failures.
in_docroot() {
  [[ -n $docroot_id && -d $docroot && ! -L $docroot ]] || return "$MOVED"
  [[ $(stat -c %d:%i -- "$docroot") == "$docroot_id" ]] || return "$MOVED"
  (
    cd -P -- "$docroot" 2>/dev/null || exit "$MOVED"
    [[ $(stat -c %d:%i -- .) == "$docroot_id" ]] || exit "$MOVED"
    "$@"
  )
}

# pinned COMMAND...: in_docroot, stopping the script with exit 8 if the docroot was replaced.
pinned() {
  local rc=0
  in_docroot "$@" || rc=$?
  ((rc != MOVED)) ||
    die 8 "$docroot is no longer the directory checked at the start (it was renamed, replaced or made a symbolic link); stopping without writing through it"
  return "$rc"
}

# Refuse a docroot the backup cannot capture or the install cannot update safely.
# Runs in the docroot (see in_docroot).
check_docroot_contents() {
  local odd
  odd=$(find . -mindepth 1 ! -type f ! -type d -printf '  %P (%y)\n')
  [[ -z $odd ]] || die 4 "the docroot has entries the backup cannot capture (only regular files and directories are supported):"$'\n'"$odd"
  odd=$(find . \( \( -type f ! -readable \) -o \( -type d \( ! -readable -o ! -executable -o ! -writable \) \) \) -printf '  %P\n')
  [[ -z $odd ]] || die 4 "the docroot has entries this user cannot read or update:"$'\n'"$odd"
  # A hard link is the same file under another name, perhaps outside the docroot,
  # and setting the mode or owner of one changes the other.
  odd=$(find . -type f -links +1 -printf '  %P (%n links)\n')
  [[ -z $odd ]] || die 4 "the docroot has files with more than one hard link, which may also be reachable outside it; replace each with an independent copy (cp --remove-destination) or remove it:"$'\n'"$odd"
}

# ---------------------------------------------------------------- release files

zip_name=''
release=''
stage=''
manifest=''

make_work_dir() {
  local tmp
  if ((dry_run)); then
    # A dry run writes nothing outside a private directory under $TMPDIR.
    tmp=$(realpath -e -- "${TMPDIR:-/tmp}") || die 4 "TMPDIR ${TMPDIR:-/tmp} does not exist"
    ! inside "$tmp" "$docroot" || die 4 "TMPDIR $tmp must not be inside the docroot for a dry run"
    ! inside "$tmp" "$backup_root" || die 4 "TMPDIR $tmp must not be inside the backup directory for a dry run"
    check_trusted "$tmp" TMPDIR self
    work=$(mktemp -d "$tmp/passgen-dry-run.XXXXXXXX")
  else
    work=$(mktemp -d "$staging_dir/.passgen-install.XXXXXXXX")
  fi
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
# The last line may lack its newline; every reader below handles that.
validate_manifest() {
  local bad path
  bad=$(grep -nvE '^[0-9a-f]{64}  [^[:space:]].*$' "$manifest" || true)
  [[ -z $bad ]] || die 5 "SHA256SUMS has lines that are not 'sha256  path':"$'\n'"$bad"
  while IFS= read -r path; do
    safe_relative_path "$path" || die 5 "unsafe path in SHA256SUMS: '$path'"
  done < <(manifest_paths)
  manifest_paths | grep -qxF 'index.html' || die 5 "SHA256SUMS does not list index.html"
}

# The manifest's paths, one per line, each ending in a newline.
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

# record_tree DIR: one line per entry under DIR, DIR itself as ".", sorted: the
# type, the mode, the owner and group when running as root (otherwise every copy
# is this user's), the sha256 of each file, and the path, shell-quoted. Equal
# records mean equal trees.
record_tree() (
  cd -- "$1" || exit 1
  find . -printf '%y\0%#m\0%U:%G\0%p\0' | {
    status=0
    while IFS= read -r -d '' type && IFS= read -r -d '' mode && IFS= read -r -d '' ids && IFS= read -r -d '' path; do
      ((EUID == 0)) || ids=-
      hash=-
      if [[ $type == f ]]; then
        hash=$(sha256sum <"$path") || status=1
        hash=${hash%% *}
      fi
      printf '%s %s %s %s %q\n' "$type" "$mode" "$ids" "$hash" "$path"
    done
    exit "$status"
  } | LC_ALL=C sort
)

unpack_and_verify() {
  note "Verifying $zip_name"
  verify_zip_checksum
  check_zip_entries
  validate_manifest
  unzip -q -n -d "$stage" "$release/$zip_name" || die 5 "unzip failed on $zip_name"
  local count
  count=$(manifest_paths | grep -c '' || true)
  verify_tree "$stage" "$manifest" "staged release" || die 5 "$zip_name does not match SHA256SUMS; nothing was changed"
  log "    $count files match SHA256SUMS"
  phase=staged
}

# ---------------------------------------------------------------- install

# Backups and rollbacks keep modes and times; ownership too when running as root.
# rsync always writes a file to a temporary name and renames it into place, so
# every copy is a new file; -I makes it do so even when the content is unchanged.
copy_flags=(-rtp -I --no-links)
if ((EUID == 0)); then
  copy_flags+=(-og --numeric-ids)
fi

take_backup() {
  local ts name n=0 seq
  if [[ ! -d $backup_root ]]; then
    # umask 077 (set at the top) makes this and any missing parent mode 0700.
    mkdir -p -- "$backup_root" || die 4 "could not create the backup directory $backup_root"
  fi
  # Names sort in the order the backups were taken: the UTC second, then a
  # six-digit number for backups taken within the same second.
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  for name in "$backup_root/$ts"-[0-9][0-9][0-9][0-9][0-9][0-9]; do
    [[ -e $name ]] || continue
    seq=$((10#${name##*-}))
    ((seq < n)) || n=$seq
  done
  printf -v backup '%s/%s-%06d' "$backup_root" "$ts" $((n + 1))
  mkdir -m 0700 -- "$backup" || die 4 "could not create the backup directory $backup"
  note "Backing up $docroot to $backup"
  pinned check_docroot_contents
  pinned rsync "${copy_flags[@]}" -- ./ "$backup/"
  backup_record="$work/backup.record"
  record_tree "$backup" >"$backup_record"
  pinned record_tree . >"$work/docroot.record"
  cmp -s "$backup_record" "$work/docroot.record" ||
    die 4 "the backup in $backup does not match the docroot; nothing was changed"
}

# rotate_backups: keep the backup just taken and the newest others, up to
# KEEP_BACKUPS. Best effort: it runs after the install is verified, so a
# failure here only warns. Returns 1 if an old backup could not be removed.
rotate_backups() {
  local -a names=() others=()
  local name i status=0
  mapfile -t names < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
    -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z-[0-9]{6}' -printf '%f\n' | LC_ALL=C sort)
  for name in "${names[@]}"; do
    [[ $backup_root/$name == "$backup" ]] || others+=("$name")
  done
  for ((i = 0; i < ${#others[@]} - (KEEP_BACKUPS - 1); i++)); do
    note "Removing old backup $backup_root/${others[i]}"
    rm -rf -- "${backup_root:?}/${others[i]}" || status=1
  done
  return "$status"
}

# rsync flags for the install: every file is written anew (never chmod or chown
# of an existing one) with the requested modes and owner.
install_flags=()
set_install_flags() {
  install_flags=(-rtp -I --no-links --chmod="D$dir_mode,F$file_mode")
  if [[ -n $owner ]]; then
    install_flags+=(--chown="$owner" -o)
    [[ $owner != *:* ]] || install_flags+=(-g)
  fi
}

# Three passes so the page never references assets that are not there yet:
# new assets first, index.html second (rsync renames it into place), stale files last.
apply_release() {
  note "Installing $version into $docroot"
  pinned rsync "${install_flags[@]}" --exclude=/index.html -- "$stage/" ./
  pinned rsync "${install_flags[@]}" --include=/index.html --exclude='*' -- "$stage/" ./
  pinned rsync "${install_flags[@]}" --delete -- "$stage/" ./
}

# Every directory has --dir-mode, every file --file-mode, and everything belongs
# to --owner when given. Runs in the docroot.
check_metadata() {
  local odd
  local -a not_owned=()
  if [[ -n $owner ]]; then
    not_owned=(-o ! -user "${owner%%:*}")
    [[ $owner != *:* ]] || not_owned+=(-o ! -group "${owner#*:}")
  fi
  odd=$(find . \( \( -type d ! -perm "$dir_mode" \) -o \( -type f ! -perm "$file_mode" \) "${not_owned[@]}" \) \
    -printf '  %p (mode %#m, owner %u:%g)\n') || return 1
  if [[ -n $odd ]]; then
    warn "installed files: modes or owner differ from --dir-mode $dir_mode, --file-mode $file_mode${owner:+, --owner $owner}:"$'\n'"$odd"
    return 1
  fi
}

post_check() {
  note "Checking the installed files"
  pinned verify_tree . "$manifest" "installed files" || die 6 "the docroot does not match the release after install"
  pinned check_metadata || die 6 "the docroot does not have the requested modes or owner after install"
  log "    $docroot matches SHA256SUMS, with the requested modes${owner:+ and owner}"
  if [[ -n $url ]]; then
    note "Checking $url"
    check_url || die 6 "the site at $url does not serve the installed release"
  fi
}

check_url() {
  local line hash path body="$work/fetch" headers="$work/headers" code actual protos='=https' header
  local -a missing=()
  ((local_http)) && protos='=http,https'
  while IFS= read -r line || [[ -n $line ]]; do
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
  note "Dry run: nothing below is applied; the only files written were in $work, which is removed on exit"
  [[ -d $docroot ]] || log "$p would create $docroot"
  [[ -d $backup_root ]] || log "$p would create $backup_root with mode 0700"
  log "$p would back up $docroot to $backup_root/$(date -u +%Y%m%dT%H%M%SZ)-NNNNNN"
  log "$p would apply the release with rsync (new assets, then index.html, then deletions), writing every file anew;"
  log "$p files whose content would change:"
  if [[ -d $docroot ]]; then
    pinned rsync -rn --itemize-changes --checksum --delete --no-links -- "$stage/" ./ | sed 's/^/    /'
  else
    find "$stage" -type f -printf '    +%P\n' | LC_ALL=C sort
  fi
  log "$p would set directories to $dir_mode and files to $file_mode in $docroot${owner:+, owned by $owner}"
  log "$p would re-hash $docroot against SHA256SUMS and check modes${owner:+ and owner}"
  [[ -z $url ]] || log "$p would fetch every file from $url and check the ${#SECURITY_HEADER_NAMES[@]} security headers on index.html"
  log "$p would keep the newest $KEEP_BACKUPS backups in $backup_root"
}

# ---------------------------------------------------------------- rollback and exit

# Returns 0 when the backup was restored and verified, 1 when the restore failed
# or did not verify, 2 when the backup no longer matches its record (it was not
# restored) and 3 when the docroot was replaced (nothing was written through it).
rollback() {
  local rc=0
  record_tree "$backup" >"$work/backup.now" 2>/dev/null || return 2
  cmp -s "$backup_record" "$work/backup.now" || return 2
  in_docroot rsync "${copy_flags[@]}" --delete -- "$backup/" ./ || rc=$?
  ((rc != MOVED)) || return 3
  ((rc == 0)) || return 1
  in_docroot record_tree . >"$work/restored.record" || rc=$?
  ((rc != MOVED)) || return 3
  ((rc == 0)) || return 1
  cmp -s "$backup_record" "$work/restored.record"
}

cleanup() {
  [[ -z $work ]] || rm -rf -- "$work"
}

on_exit() {
  local rc=$? status=0
  trap - EXIT
  if [[ $phase == installing ]]; then
    warn "installing $version into $docroot failed (exit $rc); restoring the backup from $backup"
    rollback || status=$?
    case $status in
      0)
        warn "rollback complete: $docroot matches the backup taken before the install"
        rc=6
        ;;
      2)
        warn "ROLLBACK REFUSED: the backup in $backup changed after it was taken, so it was not restored; $docroot holds the failed install. Find out what changed the backup before restoring anything from it."
        rc=7
        ;;
      3)
        warn "ROLLBACK REFUSED: $docroot is no longer the directory this run backed up (it was renamed, replaced or made a symbolic link), so nothing was written through it. The backup is in $backup. Find out what replaced the docroot before restoring by hand."
        rc=8
        ;;
      *)
        warn "ROLLBACK NOT VERIFIED: restore $docroot by hand from $backup"
        rc=7
        ;;
    esac
  fi
  cleanup
  exit "$rc"
}

# ---------------------------------------------------------------- main

main() {
  parse_args "$@"
  check_tools
  [[ -n $from_dir ]] || resolve_repo
  init_trusted_uids
  preflight_paths
  [[ -z $docroot_id ]] || pinned check_docroot_contents
  set_install_flags
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  make_work_dir
  fetch_release
  unpack_and_verify

  if ((dry_run)); then
    dry_run_plan
    return 0
  fi

  if [[ ! -d $docroot ]]; then
    note "Creating $docroot"
    mkdir -m "$dir_mode" -- "$docroot"
    docroot_id=$(stat -c %d:%i -- "$docroot")
  fi
  take_backup
  phase=installing
  apply_release
  post_check
  # Nothing after this point can undo a verified install: rotation only warns.
  phase=finished
  if ! rotate_backups; then
    warn "could not remove every old backup in $backup_root; the install itself succeeded and is verified, so remove old backups by hand"
  fi
  note "Installed $version into $docroot; backup in $backup"
}

main "$@"
