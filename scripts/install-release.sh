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
#       [--trust-owner UID]... [--url https://example.com/] [--dry-run]
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
#                         0755. Must give the owner read, write and search (read
#                         and search are enough when running as root), and must
#                         not let group or others write.
#   --owner USER[:GROUP]  Owner (and group) for the docroot and everything in it.
#                         Default: none; every file is written anew, so the files
#                         belong to the user running the script.
#   --backup-dir DIR      Where backups go, one subdirectory per run. Default: a
#                         sibling of the docroot named .<docroot-name>-backups.
#                         Created with mode 0700 if missing (its parent must
#                         exist); an existing one must be this user's, mode 0700.
#                         The newest 3 backups are kept.
#   --staging-dir DIR     Where the release is unpacked before it is installed.
#                         Must be on the docroot's filesystem. Default: the
#                         docroot's parent directory.
#   --trust-owner UID     Also trust directories owned by this numeric UID on the
#                         way to the docroot, backups and staging. Repeatable.
#                         For user namespaces, where root's directories show as
#                         an unmapped ID such as 65534.
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
# directory must be owned by root, the user running the script or a
# --trust-owner UID, and must not be writable by anyone else unless it has the
# sticky bit (like /tmp). No directory in the docroot, nor the docroot itself,
# may be writable by anyone but root and the --owner user (running as root), or
# by group or others (running as another user). Nothing may be mounted inside
# the docroot. docs/install-release.md has the threat model.
#
# Needs bash 4.4+, GNU coreutils and findutils, sha256sum, unzip, rsync 3.1+,
# and curl or an authenticated gh for downloads. Uses getfacl and setfacl
# (acl) when installed.
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
owner_uid=''
trusted_uids=(0 "$EUID")
dry_run=0
local_http=0

# Runtime state the exit handler reads.
work=''
backup=''
backup_tree=''
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
      --version | --docroot | --repo | --from-dir | --file-mode | --dir-mode | --owner | --backup-dir | --staging-dir | --trust-owner | --url)
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
      --trust-owner)
        [[ $val =~ ^[0-9]+$ ]] || die 2 "--trust-owner takes a numeric UID, not '$val'"
        trusted_uids+=("$((10#$val))")
        ;;
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
  # The script must be able to read back what it installs, and to update and remove it
  # later; root needs no write bit for that. Nobody else may write the docroot.
  (((8#$file_mode & 8#400) == 8#400)) || die 2 "--file-mode must let the owner read files (such as 0644), not '$file_mode'"
  if ((EUID == 0)); then
    (((8#$dir_mode & 8#500) == 8#500)) ||
      die 2 "--dir-mode must give the owner read and search on directories (such as 0755), not '$dir_mode'"
  else
    (((8#$dir_mode & 8#700) == 8#700)) ||
      die 2 "--dir-mode must give the owner read, write and search on directories (such as 0755), not '$dir_mode'"
  fi
  (((8#$dir_mode & 8#022) == 0)) ||
    die 2 "--dir-mode must not let group or others write (a docroot others can write is not supported), not '$dir_mode'"
  [[ -z $owner || $owner =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?$ ]] ||
    die 2 "--owner must be USER or USER:GROUP, not '$owner'"
  if [[ -n $owner ]]; then
    owner_uid=$(id -u -- "${owner%%:*}" 2>/dev/null) || die 2 "--owner: no such user '${owner%%:*}'"
  fi
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

# trusted_uids holds the owners trusted for the directories on the way to the
# docroot, the backups and the staging directory: root, the user running this
# script, and any --trust-owner UID.
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
        die 4 "$dir, on the path to the $label, is owned by uid $uid; only root, uid $EUID, which runs this script, or a --trust-owner UID may own it"
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

# canon VAR LABEL PATH [-e]: set VAR to PATH made absolute with every symbolic
# link resolved, byte for byte. $(realpath ...) would drop a trailing newline
# and so name another directory; the result is read NUL-terminated instead, and
# a result holding any control character is refused. -e requires PATH to exist.
canon() {
  local label=$2 path=$3 flag=${4:--m} result
  IFS= read -r -d '' result < <(realpath "$flag" -z -- "$path" 2>/dev/null) ||
    die 4 "the $label $path does not exist or cannot be resolved"
  [[ $result != *[[:cntrl:]]* ]] ||
    die 4 "the $label resolves to $(printf '%q' "$result"), which contains a control character such as a newline; refusing it"
  printf -v "$1" '%s' "$result"
}

# alias_of_docroot PATH: print the first existing directory among PATH and its
# ancestors that is the docroot itself (same device and inode), whatever its
# name. Through a bind mount, a path that looks unrelated can lie inside the
# docroot.
alias_of_docroot() {
  local dir=$1
  [[ -n $docroot_id ]] || return 1
  while :; do
    if [[ -d $dir && $(stat -c %d:%i -- "$dir") == "$docroot_id" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    [[ $dir != / ]] || return 1
    dir=${dir%/*}
    dir=${dir:-/}
  done
}

# not_in_docroot PATH LABEL: refuse PATH if it is the docroot or inside it, by
# name or by identity.
not_in_docroot() {
  local alias
  ! inside "$1" "$docroot" || die 4 "the $2 $1 must not be inside the docroot"
  if alias=$(alias_of_docroot "$1"); then
    die 4 "the $2 $1 is inside the docroot: $alias is the docroot under another name (a bind mount or similar)"
  fi
}

# Refuse a docroot with anything mounted below it: the install would write into,
# and delete from, whatever is mounted there. Linux only, through mountinfo,
# which escapes space, tab, newline and backslash in octal.
check_no_mounts_below() {
  local line point
  local -a fields
  if [[ ! -r /proc/self/mountinfo ]]; then
    warn "cannot read /proc/self/mountinfo, so mounts inside the docroot cannot be detected; make sure there are none"
    return 0
  fi
  while IFS= read -r line; do
    read -r -a fields <<<"$line"
    point=${fields[4]}
    point=${point//\\040/ }
    point=${point//\\011/$'\t'}
    point=${point//\\012/$'\n'}
    point=${point//\\134/\\}
    [[ $point != "$docroot"/* ]] ||
      die 4 "$point is a mount point inside the docroot; the install would overwrite what is mounted there. Unmount it, or move it out of the docroot"
  done </proc/self/mountinfo
}

# check_private_dir DIR LABEL: DIR must belong to this user with mode exactly
# 0700. Group-class ACL entries are capped by the mode's group bits (the ACL
# mask), so 0700 leaves any named entries no access.
check_private_dir() {
  local uid mode
  read -r uid mode < <(stat -c '%u %a' -- "$1")
  ((uid == EUID)) || die 4 "the $2 $1 is owned by uid $uid, not by uid $EUID, which runs this script"
  [[ $mode == 700 ]] || die 4 "the $2 $1 has mode $mode; it must be 0700 (chmod 0700 $1)"
}

# has_default_acl DIR: whether directories made in DIR escape umask 077, which
# only a default ACL can cause. A plain mkdir tells, without the acl tools.
has_default_acl() {
  local probe="$1/.passgen-acl-probe" mode
  mkdir -- "$probe" || die 4 "could not write in $1"
  mode=$(stat -c %a -- "$probe")
  rmdir -- "$probe"
  [[ $mode != 700 ]]
}

has_extended_acl() {
  command -v getfacl >/dev/null 2>&1 || return 1
  [[ -n $(getfacl --absolute-names --skip-base -- "$1" 2>/dev/null) ]]
}

# prepare_backup_root: make sure the backup directory exists, belongs to this
# user, has mode 0700 and no ACL that would open what is created in it.
prepare_backup_root() {
  local created=0 problem=''
  if [[ ! -e $backup_root ]]; then
    mkdir -- "$backup_root" || die 4 "could not create the backup directory $backup_root"
    chmod 0700 -- "$backup_root"
    created=1
    if command -v setfacl >/dev/null 2>&1; then
      # It may have inherited ACL entries from its parent's default ACL.
      setfacl -b -- "$backup_root" 2>/dev/null || true
    fi
  fi
  check_private_dir "$backup_root" "backup directory"
  if has_extended_acl "$backup_root"; then
    problem="has ACL entries (remove them with setfacl -b $backup_root)"
  elif has_default_acl "$backup_root"; then
    problem="has a default ACL (remove it with setfacl -k $backup_root)"
  fi
  if [[ -n $problem ]]; then
    if ((created)); then
      rmdir -- "$backup_root"
      problem="would inherit ACL entries from the default ACL of ${backup_root%/*} (remove that with setfacl -k, or choose another --backup-dir)"
    fi
    die 4 "the backup directory $backup_root $problem"
  fi
}

parent=''
tmp_dir=''

preflight_paths() {
  local given=$docroot fs_dir alias real

  # Refuse a symbolic link rather than follow it: the link could be repointed
  # between the checks below and the writes.
  while [[ $given == */ && $given != / ]]; do
    given=${given%/}
  done
  if [[ -L $given ]]; then
    canon real docroot "$given"
    die 4 "--docroot $given is a symbolic link; pass the directory it points to ($real) instead"
  fi
  canon docroot docroot "$docroot"
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
    check_no_mounts_below
  else
    [[ -w $parent && -x $parent ]] ||
      die 4 "the docroot does not exist and its parent directory $parent is not writable, so it cannot be created"
  fi

  [[ -n $staging_dir ]] || staging_dir=$parent
  canon staging_dir "staging directory" "$staging_dir" -e
  [[ -d $staging_dir ]] || die 4 "the staging directory $staging_dir is not a directory"
  not_in_docroot "$staging_dir" "staging directory"
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
  canon backup_root "backup directory" "$backup_root"
  [[ $backup_root != / ]] || die 4 "refusing to use / as the backup directory"
  not_in_docroot "$backup_root" "backup directory"
  ! inside "$docroot" "$backup_root" || die 4 "the docroot $docroot must not be inside the backup directory $backup_root"
  check_trusted "$backup_root" "backup directory"
  if [[ -e $backup_root ]]; then
    [[ -d $backup_root ]] || die 4 "$backup_root exists and is not a directory"
    check_private_dir "$backup_root" "backup directory"
    real=$(stat -c %d:%i -- "$backup_root")
    alias=$docroot
    while [[ $alias != / ]]; do
      alias=${alias%/*}
      alias=${alias:-/}
      [[ $(stat -c %d:%i -- "$alias") != "$real" ]] ||
        die 4 "the docroot $docroot is inside the backup directory: $alias is the backup directory under another name"
    done
  else
    [[ -d ${backup_root%/*} ]] ||
      die 4 "the backup directory's parent ${backup_root%/*} does not exist; create it first (owned by root or this user, not writable by others)"
  fi

  if ((dry_run)); then
    canon tmp_dir TMPDIR "${TMPDIR:-/tmp}" -e
    not_in_docroot "$tmp_dir" TMPDIR
    ! inside "$tmp_dir" "$backup_root" || die 4 "TMPDIR $tmp_dir must not be inside the backup directory for a dry run"
    check_trusted "$tmp_dir" TMPDIR self
  fi

  if [[ -n $from_dir ]]; then
    [[ -d $from_dir ]] || die 2 "--from-dir $from_dir is not a directory"
    canon from_dir "--from-dir" "$from_dir" -e
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
  check_docroot_writers
}

# Refuse a docroot that someone the script does not trust could change while it
# runs: a directory such a user can write lets them swap an entry for a symbolic
# link between the script's checks and rsync's writes. Running as root, only
# root and the --owner user may own a directory in the docroot; group and other
# write are refused either way. Access ACL entries are capped by the group bits
# checked here; default ACL entries, which only getfacl shows, are checked too.
# Runs in the docroot.
check_docroot_writers() {
  local odd who='group or others'
  local -a owners=()
  if ((EUID == 0)); then
    owners=(! -user 0)
    [[ -z $owner_uid ]] || owners+=(! -user "$owner_uid")
    who="users other than root${owner:+ and ${owner%%:*}}"
    odd=$(find . -type d \( -perm /022 -o \( "${owners[@]}" \) \) -printf '  %p (mode %#m, owner %u)\n')
  else
    odd=$(find . -type d -perm /022 -printf '  %p (mode %#m, owner %u)\n')
  fi
  if [[ -z $odd ]] && command -v getfacl >/dev/null 2>&1; then
    odd=$(getfacl -R -p -n -e --skip-base -- . 2>/dev/null | acl_write_grants)
  fi
  [[ -z $odd ]] || die 4 "the docroot has directories $who can write to. A web server or other account that can write the web root is not supported: make root (or the user running this script) own the docroot and give the server read access only, for example --owner root:www-data --dir-mode 0750 --file-mode 0640. Directories:"$'\n'"$odd"
}

# Reads getfacl output; prints each directory whose ACL lets a named user or
# group write it, or lets anyone but its owner write what is created in it.
acl_write_grants() {
  local line file='' entry perms
  while IFS= read -r line; do
    case $line in
      '# file: '*) file=${line#'# file: '} ;;
      '' | '#'* | user::* | mask::* | default:user::* | default:mask::*) ;;
      *)
        entry=${line%%[[:space:]]*}
        perms=${entry##*:}
        [[ $line != *'#effective:'* ]] || perms=${line##*'#effective:'}
        if [[ $perms == *w* && -d $file ]]; then
          printf '  %s (ACL %s)\n' "$file" "$entry"
        fi
        ;;
    esac
  done
}

# ---------------------------------------------------------------- release files

zip_name=''
release=''
stage=''
manifest=''

make_work_dir() {
  if ((dry_run)); then
    # A dry run writes nothing outside a private directory under $TMPDIR.
    # preflight_paths checked $TMPDIR (tmp_dir).
    work=$(mktemp -d "$tmp_dir/passgen-dry-run.XXXXXXXX")
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
  prepare_backup_root
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
  # The copy goes one level down, so the docroot's own mode and owner land on
  # $backup/docroot and the backup directory itself stays private.
  check_private_dir "$backup_root" "backup directory"
  check_private_dir "$backup" "backup directory"
  backup_tree="$backup/docroot"
  note "Backing up $docroot to $backup_tree"
  pinned check_docroot_contents
  pinned rsync "${copy_flags[@]}" -- ./ "$backup_tree/"
  backup_record="$work/backup.record"
  record_tree "$backup_tree" >"$backup_record"
  pinned record_tree . >"$work/docroot.record"
  cmp -s "$backup_record" "$work/docroot.record" ||
    die 4 "the backup in $backup_tree does not match the docroot; nothing was changed"
}

# rotate_backups: keep the backup just taken and the newest others, up to
# KEEP_BACKUPS. Best effort: it runs after the install is verified, so a
# failure here only warns. Returns 1 if the backups could not be listed or an
# old one could not be removed.
rotate_backups() {
  local -a names=() others=()
  local listing sorted name i status=0
  if ! listing=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
    -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z-[0-9]{6}' -printf '%f\n'); then
    warn "could not list the backups in $backup_root"
    return 1
  fi
  if ! sorted=$(printf '%s' "$listing" | LC_ALL=C sort); then
    warn "could not sort the backups in $backup_root"
    return 1
  fi
  [[ -z $sorted ]] || mapfile -t names <<<"$sorted"
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
  log "$p would back up $docroot to $backup_root/$(date -u +%Y%m%dT%H%M%SZ)-NNNNNN/docroot"
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
  record_tree "$backup_tree" >"$work/backup.now" 2>/dev/null || return 2
  cmp -s "$backup_record" "$work/backup.now" || return 2
  in_docroot rsync "${copy_flags[@]}" --delete -- "$backup_tree/" ./ || rc=$?
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
    warn "installing $version into $docroot failed (exit $rc); restoring the backup from $backup_tree"
    rollback || status=$?
    case $status in
      0)
        warn "rollback complete: $docroot matches the backup taken before the install"
        rc=6
        ;;
      2)
        warn "ROLLBACK REFUSED: the backup in $backup_tree changed after it was taken, so it was not restored; $docroot holds the failed install. Find out what changed the backup before restoring anything from it."
        rc=7
        ;;
      3)
        warn "ROLLBACK REFUSED: $docroot is no longer the directory this run backed up (it was renamed, replaced or made a symbolic link), so nothing was written through it. The backup is in $backup_tree. Find out what replaced the docroot before restoring by hand."
        rc=8
        ;;
      *)
        warn "ROLLBACK NOT VERIFIED: restore $docroot by hand from $backup_tree"
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
    warn "backup rotation did not finish in $backup_root; the install itself succeeded and is verified, so remove old backups by hand"
  fi
  note "Installed $version into $docroot; backup in $backup_tree"
}

main "$@"
