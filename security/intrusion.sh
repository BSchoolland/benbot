#!/bin/bash
# Runs on a remote host (ssh <host> bash -s -- <since> < intrusion.sh) and prints a stable, diffable snapshot of
# everything an intruder would add: users, keys, sudoers, cron, units, pm2, listeners, temp executables, vhosts,
# app-tree drift, auth events since <since> (default: 26 hours ago). Works on Debian 12 and AlmaLinux 8 (bash >= 4.4).
#
# Every check prints "=== <name> rc=<exit status>", then its output, then its stderr as "!! " lines. Checks run under
# errexit + pipefail + inherit_errexit, so any failing command, pipeline stage, loop iteration or command substitution
# assigned to a variable fails the check. Substitutions are always assigned first, never used inline in arguments,
# where bash would ignore their status. An empty section means clean only when rc=0. The last line is "=== end".
export LC_ALL=C
SINCE=${1:-26 hours ago}
echo "# taken $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname) since: $SINCE"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
check() {
  local name=$1 rc; shift
  ( set -eo pipefail; shopt -s inherit_errexit; "$@" ) >"$TMP/out" 2>"$TMP/err"
  rc=$?
  echo; echo "=== $name rc=$rc"
  cat "$TMP/out"
  sed 's/^/!! /' "$TMP/err"
}
# grep exits 1 for "no match"; only 2+ is a failure.
g() { local r=0; grep "$@" || r=$?; [ $r -le 1 ] || return $r; }
# pgrep exits 1 for "no process"; only 2+ is a failure.
pg() { local r=0; pgrep "$@" || r=$?; [ $r -le 1 ] || return $r; }
need() { command -v "$1" >/dev/null || { echo "$1 not installed" >&2; return 3; }; }
procname() { g -oP 'users:\(\("\K[^"]+' <<<"$1"; }

users() { awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ {print $1":"$3":"$6":"$7}' /etc/passwd | sort; }
uid0() { awk -F: '$3==0 {print $1}' /etc/passwd; }
admin_groups() { g -E '^(sudo|wheel|admin):' /etc/group; }
key_files() { ( shopt -s nullglob; printf '%s\n' /root/.ssh/authorized_keys* /home/*/.ssh/authorized_keys* ); }
keys() {
  local f files
  files=$(key_files)
  : >"$TMP/keys"
  for f in $files; do
    [ -f "$f" ] || continue
    if [ -s "$f" ]; then ssh-keygen -lf "$f" | awk -v f="$f" '{print f, $2, $NF}' >>"$TMP/keys"
    else echo "$f (empty)" >>"$TMP/keys"; fi
  done
  sort "$TMP/keys"
}
sudoers() {
  local sum
  sum=$( { cat /etc/sudoers; find /etc/sudoers.d -type f -exec cat {} +; } | g -vE '^\s*(#|$)' | sort | md5sum)
  echo "$sum"
  ls /etc/sudoers.d/
}
crontabs() {
  local f d list
  : >"$TMP/cron"
  for f in /var/spool/cron/crontabs/* /var/spool/cron/[!c]* /etc/crontab /etc/cron.d/*; do
    [ -f "$f" ] || continue
    g -vE '^\s*(#|$)' "$f" | sed "s#^#$f: #" >>"$TMP/cron"
  done
  sort "$TMP/cron"
  for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
    if [ -d "$d" ]; then list=$(ls "$d" | tr '\n' ' '); echo "$d: $list"; fi
  done
}
units() {
  local d
  for d in /etc/systemd/system /usr/local/lib/systemd /home/*/.config/systemd /root/.config/systemd; do
    if [ -d "$d" ]; then find "$d" \( -name '*.service' -o -name '*.timer' -o -name '*.path' -o -name '*.socket' \); fi
  done | g -v '\.wants/' | sort
}
running() { systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}' | sort; }
pm2_children() {
  local d c daemons kids user exe cwd args
  daemons=$(pg -f 'PM2 v[0-9.]+: God Daemon')
  : >"$TMP/pm2"
  for d in $daemons; do
    kids=$(pg -P "$d")
    for c in $kids; do
      user=$(ps -o user= -p "$c"); exe=$(readlink "/proc/$c/exe"); cwd=$(readlink "/proc/$c/cwd"); args=$(ps -o args= -p "$c")
      echo "$user $exe cwd=$cwd ${args:0:120}" >>"$TMP/pm2"
    done
  done
  sort "$TMP/pm2"
}
docker_ps() {
  if ! command -v docker >/dev/null; then
    echo "(docker not installed)"
    if command -v podman >/dev/null; then echo "podman present: not inventoried"; fi
    return 0
  fi
  docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | sort
}
listeners() {
  local proto local_ users name
  ss -Hltnup >"$TMP/ss"
  while read -r proto _ _ _ local_ _ users; do
    name=$(procname "$users")
    echo "$proto $local_ $name"
  done <"$TMP/ss" | sed -E 's/%[a-z0-9]+:/:/' | sort -u
}
outbound() {
  local listening local_ peer users name
  listening=$(ss -Hltn | awk '{n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ')
  listening=" $listening "
  ss -Htnp state established >"$TMP/est"
  while read -r _ _ local_ peer users; do
    case "$listening" in *" ${local_##*:} "*) continue ;; esac
    name=$(procname "$users")
    echo "${peer#::ffff:} $name"
  done <"$TMP/est" | sort | uniq -c | sort -rn | sed -n '1,40p'
}
tmp_exec() {
  find /tmp /var/tmp /dev/shm -xdev -type f \( -perm -u+x -o -name '*.sh' -o -name '*.elf' \) \
    | g -vE '/(systemd-private|snap-private-tmp)' | sort | sed -n '1,50p'
}
tmp_hidden() {
  find /tmp /var/tmp /dev/shm -maxdepth 2 -name '.*' ! -name '.X*' ! -name '.ICE-unix' ! -name '.font-unix' ! -name '.Test-unix' | sort
}
suid() { find / -xdev -perm -4000 -type f | g -vE '^/(usr/(bin|sbin|lib|libexec|lib64)|bin|sbin|var/lib/(docker|containers))/' | sort; }
preload() { if [ -e /etc/ld.so.preload ]; then cat /etc/ld.so.preload; fi; }
git_dirs() { ( shopt -s nullglob; for d in /opt/*/ /var/www/* /root/*/ /root/heroku-migrated/*/ /home/*/*/; do [ -d "$d/.git" ] && echo "$d"; done; true ); }
git_drift() {
  local d dirs c abs head
  dirs=$(git_dirs)
  : >"$TMP/git"
  for d in $dirs; do
    c=$(git -C "$d" -c safe.directory='*' status --porcelain --untracked-files=normal | g -vE '(node_modules|\.next|dist|build|\.log|\.pm2)/?' | wc -l)
    abs=$(cd "$d" && pwd); head=$(git -C "$d" -c safe.directory='*' rev-parse --short HEAD)
    echo "$abs head=$head dirty=$c" >>"$TMP/git"
  done
  sort -u "$TMP/git"
}
vhost_dirs() { local d; for d in /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/apache2/sites-enabled /etc/httpd/conf.d /etc/caddy /usr/local/lsws/conf/vhosts; do if [ -d "$d" ]; then echo "$d"; fi; done; }
vhost_names() {
  # nginx/Apache directives, or Caddyfile site-address lines ("example.com, www.example.com {").
  case "$1" in
    *Caddyfile*|*.caddy) g -hoE '^[A-Za-z0-9*:.-][^{(#]*\{' "$1" | tr -d '{,' ;;
    *) g -hoiE '^\s*(server_name|ServerName|ServerAlias)\s+[^;#]+' "$1" | awk '{$1=""; print}' ;;
  esac
}
vhosts() {
  local d f dirs files names
  dirs=$(vhost_dirs)
  if [ -z "$dirs" ]; then echo "(no web server config dirs)"; return 0; fi
  for d in $dirs; do
    files=$(find "$d" -maxdepth 2 \( -type f -o -type l \) | sort)
    for f in $files; do
      names=$(vhost_names "$f" | tr -s ' \n' ' ')
      echo "$f: ${names# }"
    done
  done
}
docroots() { local r; for r in /var/www /home/*/public_html; do if [ -d "$r" ]; then echo "$r"; fi; done; }
since_minutes() { local now s; now=$(date +%s); s=$(date -d "$SINCE" +%s); echo $(( (now - s) / 60 + 1 )); }
php_changed() {
  local m roots r
  m=$(since_minutes); roots=$(docroots)
  for r in $roots; do find "$r" -xdev -name '*.php' -mmin -"$m"; done | sed -E 's#/[^/]+$##' | sort | uniq -c | sort -rn | sed -n '1,20p'
}
webshells() {
  local roots r
  roots=$(docroots)
  for r in $roots; do
    g -rlE --include='*.php' 'eval\(\s*(base64_decode|gzinflate|str_rot13)|eval\(\$_(POST|GET|REQUEST|COOKIE)|assert\(\$_|FilesMan|preg_replace\(.*/e.,\s*\$_' "$r"
  done | sed -n '1,20p'
}
auth() {
  local failed
  need journalctl
  journalctl -q --since "$SINCE" -t sshd -t sshd-session -o cat >"$TMP/ssh"
  g -E 'Accepted' "$TMP/ssh" | awk '{print $1, $2, $4, $6}' | sort | uniq -c
  failed=$(g -cE 'Failed|Invalid user' "$TMP/ssh")
  echo "failed: $failed"
  journalctl -q --since "$SINCE" -t sudo -o cat >"$TMP/sudo"
  g -E 'COMMAND' "$TMP/sudo" | sed -E 's/ +TTY=\S+ ; PWD=\S+ ;//; s/COMMAND=.*//' | sort | uniq -c | sed -n '1,20p'
  journalctl -q --since "$SINCE" -o cat >"$TMP/all"
  g -E 'useradd|usermod|groupadd|passwd\[' "$TMP/all" | sed -n '1,20p'
}

# Sourced by the tests with INTRUSION_LIB=1: definitions only.
if [ -n "${INTRUSION_LIB:-}" ]; then return 0; fi

check "users with a shell" users
check "uid 0" uid0
check "groups sudo/wheel/admin" admin_groups
check "authorized_keys" keys
check "sudoers" sudoers
check "crontabs" crontabs
check "systemd units (non-vendor)" units
check "running services" running
check "pm2 children (all users)" pm2_children
check "docker" docker_ps
check "listeners" listeners
check "outbound established (remote ip:port process)" outbound
check "executables in tmp dirs" tmp_exec
check "hidden entries in tmp dirs" tmp_hidden
check "suid outside package dirs" suid
check "ld.so.preload" preload
check "web vhosts" vhosts
check "git drift in app dirs" git_drift
check "php in docroots modified since" php_changed
check "webshell signatures in docroots" webshells
check "auth since" auth
echo; echo "=== end"
