#!/bin/bash
# Runs on a remote host (ssh <host> bash -s -- <since> < intrusion.sh) and prints a stable, diffable snapshot of
# everything an intruder would add: users, keys, sudoers, cron, units, pm2, listeners, temp executables, app-tree
# drift, auth events since <since> (default: 26 hours ago). Works on Debian 12 and AlmaLinux 8.
#
# Every check prints "=== <name> rc=<exit status>", then its output, then its stderr as "!! " lines. Each check runs
# under pipefail, so an empty section means clean only when rc=0. The last line is "=== end", so a cut-off snapshot is
# detectable.
export LC_ALL=C
SINCE=${1:-26 hours ago}
echo "# taken $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname) since: $SINCE"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
check() {
  local name=$1; shift
  local rc
  ( set -o pipefail; "$@" ) >"$TMP/out" 2>"$TMP/err"
  rc=$?
  echo; echo "=== $name rc=$rc"
  cat "$TMP/out"
  sed 's/^/!! /' "$TMP/err"
}
# grep exits 1 for "no match"; only 2+ is a failure.
g() { grep "$@"; local r=$?; [ $r -le 1 ] || return $r; }
need() { command -v "$1" >/dev/null || { echo "$1 not installed" >&2; return 3; }; }

users() { awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ {print $1":"$3":"$6":"$7}' /etc/passwd | sort; }
uid0() { awk -F: '$3==0 {print $1}' /etc/passwd; }
admin_groups() { g -E '^(sudo|wheel|admin):' /etc/group; }
key_files() { ( shopt -s nullglob; printf '%s\n' /root/.ssh/authorized_keys* /home/*/.ssh/authorized_keys* ); }
keys() {
  local f rc=0
  : >"$TMP/keys"
  for f in $(key_files); do
    [ -f "$f" ] || continue
    if [ -s "$f" ]; then ssh-keygen -lf "$f" | awk -v f="$f" '{print f, $2, $NF}' >>"$TMP/keys" || rc=1
    else echo "$f (empty)" >>"$TMP/keys"; fi
  done
  sort "$TMP/keys"
  return $rc
}
sudoers() {
  cat /etc/sudoers /etc/sudoers.d/* | g -vE '^\s*(#|$)' | sort | md5sum
  ls /etc/sudoers.d/
}
crontabs() {
  local f d rc=0
  : >"$TMP/cron"
  for f in /var/spool/cron/crontabs/* /var/spool/cron/[!c]* /etc/crontab /etc/cron.d/*; do
    [ -f "$f" ] || continue
    g -vE '^\s*(#|$)' "$f" | sed "s#^#$f: #" >>"$TMP/cron" || rc=1
  done
  sort "$TMP/cron"
  for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
    if [ -d "$d" ]; then echo "$d: $(ls "$d" | tr '\n' ' ')"; fi
  done
  return $rc
}
units() {
  local d
  for d in /etc/systemd/system /usr/local/lib/systemd /home/*/.config/systemd /root/.config/systemd; do
    if [ -d "$d" ]; then find "$d" \( -name '*.service' -o -name '*.timer' -o -name '*.path' -o -name '*.socket' \); fi
  done | g -v '\.wants/' | sort
}
running() { systemctl list-units --type=service --state=running --no-legend --plain | awk '{print $1}' | sort; }
pm2_children() {
  local d c
  for d in $(pgrep -f 'PM2 v[0-9.]+: God Daemon'); do
    for c in $(pgrep -P "$d"); do
      echo "$(ps -o user= -p "$c") $(readlink "/proc/$c/exe") cwd=$(readlink "/proc/$c/cwd") $(ps -o args= -p "$c" | cut -c1-120)"
    done
  done | sort
}
docker_ps() {
  command -v docker >/dev/null || { echo "(docker not installed)"; command -v podman >/dev/null && echo "podman present: not inventoried"; return 0; }
  docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | sort
}
listeners() {
  ss -Hltnup | while read -r proto _ _ _ local _ users; do
    echo "$proto $local $(echo "$users" | g -oP 'users:\(\("\K[^"]+')"
  done | sed -E 's/%[a-z0-9]+:/:/' | sort -u
}
outbound() {
  local listening
  listening=" $(ss -Hltn | awk '{n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ') "
  ss -Htnp state established | while read -r _ _ local peer users; do
    case "$listening" in *" ${local##*:} "*) continue ;; esac
    echo "${peer#::ffff:} $(echo "$users" | g -oP 'users:\(\("\K[^"]+')"
  done | sort | uniq -c | sort -rn | sed -n '1,40p'
}
tmp_exec() {
  find /tmp /var/tmp /dev/shm -xdev -type f \( -perm -u+x -o -name '*.sh' -o -name '*.elf' \) \
    | g -vE '/(systemd-private|snap-private-tmp)' | sort | sed -n '1,50p'
}
tmp_hidden() {
  find /tmp /var/tmp /dev/shm -maxdepth 2 -name '.*' ! -name '.X*' ! -name '.ICE-unix' ! -name '.font-unix' ! -name '.Test-unix' | sort
}
suid() { find / -xdev -perm -4000 -type f | g -vE '^/(usr/(bin|sbin|lib|libexec|lib64)|bin|sbin|var/lib/(docker|containers))/' | sort; }
preload() { [ ! -e /etc/ld.so.preload ] || cat /etc/ld.so.preload; }
git_drift() {
  local d c
  for d in /opt/*/ /var/www/* /root/*/ /root/heroku-migrated/*/ /home/*/*/; do
    [ -d "$d/.git" ] || continue
    c=$(git -C "$d" -c safe.directory='*' status --porcelain --untracked-files=normal | g -vE '(node_modules|\.next|dist|build|\.log|\.pm2)/?' | wc -l) || return
    echo "$(cd "$d" && pwd) head=$(git -C "$d" -c safe.directory='*' rev-parse --short HEAD) dirty=$c"
  done | sort -u
}
vhosts() {
  local f d found=0
  for d in /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/apache2/sites-enabled /etc/httpd/conf.d /etc/caddy /usr/local/lsws/conf/vhosts; do
    [ -d "$d" ] || continue
    found=1
    for f in $(find "$d" -maxdepth 2 \( -type f -o -type l \) | sort); do
      echo "$f: $(g -hoiE '^\s*(server_name|ServerName|ServerAlias)\s+[^;#]+' "$f" | awk '{$1=""; print}' | tr -s ' \n' ' ' | sed 's/^ //')"
    done
  done
  [ $found -eq 1 ] || echo "(no web server config dirs)"
}
docroots() { local r; for r in /var/www /home/*/public_html; do [ -d "$r" ] && echo "$r"; done; return 0; }
php_changed() {
  local since_min=$(( ( $(date +%s) - $(date -d "$SINCE" +%s) ) / 60 + 1 ))
  docroots | while read -r r; do find "$r" -xdev -name '*.php' -mmin -"$since_min"; done \
    | sed -E 's#/[^/]+$##' | sort | uniq -c | sort -rn | sed -n '1,20p'
}
webshells() {
  docroots | while read -r r; do
    g -rlE --include='*.php' 'eval\(\s*(base64_decode|gzinflate|str_rot13)|eval\(\$_(POST|GET|REQUEST|COOKIE)|assert\(\$_|FilesMan|preg_replace\(.*/e.,\s*\$_' "$r"
  done | sed -n '1,20p'
}
auth() {
  need journalctl || return
  journalctl -q --since "$SINCE" -t sshd -t sshd-session -o cat >"$TMP/ssh"
  g -E 'Accepted' "$TMP/ssh" | awk '{print $1, $2, $4, $6}' | sort | uniq -c
  echo "failed: $(g -cE 'Failed|Invalid user' "$TMP/ssh")"
  journalctl -q --since "$SINCE" -t sudo -o cat | g -E 'COMMAND' | sed -E 's/ +TTY=\S+ ; PWD=\S+ ;//; s/COMMAND=.*//' | sort | uniq -c | sed -n '1,20p'
  journalctl -q --since "$SINCE" -o cat | g -E 'useradd|usermod|groupadd|passwd\[' | sed -n '1,20p'
}

# Sourced by the tests with INTRUSION_LIB=1: definitions only.
[ -n "${INTRUSION_LIB:-}" ] && return 0

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
