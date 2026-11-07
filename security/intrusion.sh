#!/bin/bash
# Runs on a remote host (ssh <host> bash -s < intrusion.sh) and prints a stable, diffable snapshot of
# everything an intruder would add: users, keys, sudoers, cron, units, pm2, listeners, temp executables,
# app-tree drift. The daily pass diffs today's snapshot against yesterday's.
# Works on Debian 12 and AlmaLinux 8.
export LC_ALL=C
sec() { echo; echo "=== $1"; }

sec "users with a shell"
awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ {print $1":"$3":"$6":"$7}' /etc/passwd | sort
sec "uid 0"
awk -F: '$3==0 {print $1}' /etc/passwd
sec "groups sudo/wheel/admin"
grep -E '^(sudo|wheel|admin):' /etc/group
sec "authorized_keys"
for f in /root/.ssh/authorized_keys* /home/*/.ssh/authorized_keys*; do
  [ -f "$f" ] || continue
  ssh-keygen -lf "$f" 2>/dev/null | awk -v f="$f" '{print f, $2, $NF}'
done | sort
sec "sudoers"
cat /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -vE '^\s*(#|$)' | sort | md5sum
ls /etc/sudoers.d/ 2>/dev/null
sec "crontabs"
for f in /var/spool/cron/crontabs/* /var/spool/cron/[!c]* /etc/crontab /etc/cron.d/*; do
  [ -f "$f" ] || continue
  grep -vE '^\s*(#|$)' "$f" | sed "s#^#$f: #"
done | sort
ls /etc/cron.{hourly,daily,weekly,monthly} 2>/dev/null | tr '\n' ' '; echo
sec "systemd units (enabled, non-vendor)"
find /etc/systemd/system /usr/local/lib/systemd /home/*/.config/systemd /root/.config/systemd -name '*.service' -o -name '*.timer' 2>/dev/null | grep -v '\.wants/' | sort
sec "running services"
systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | sort
sec "pm2 (all users)"
for d in $(pgrep -f 'PM2 v[0-9.]+: God Daemon'); do
  for c in $(pgrep -P "$d"); do
    echo "$(ps -o user= -p "$c") $(readlink "/proc/$c/exe") cwd=$(readlink "/proc/$c/cwd") $(ps -o args= -p "$c" | cut -c1-120)"
  done
done | sort
sec "docker"
docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>/dev/null | sort
sec "listeners"
ss -Hltnup 2>/dev/null | while read -r proto _ _ _ local _ users; do
  echo "$proto $local $(echo "$users" | grep -oP 'users:\(\("\K[^"]+')"
done | sed -E 's/%[a-z0-9]+:/:/' | sort -u
sec "outbound established (remote ip:port process)"
listening=" $(ss -Hltn | awk '{n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ') "
ss -Htnp state established 2>/dev/null | while read -r _ _ local peer users; do
  case "$listening" in *" ${local##*:} "*) continue ;; esac
  echo "${peer#::ffff:} $(echo "$users" | grep -oP 'users:\(\("\K[^"]+')"
done | sort | uniq -c | sort -rn | head -40
sec "executables in tmp dirs"
find /tmp /var/tmp /dev/shm -xdev -type f \( -perm -u+x -o -name '*.sh' -o -name '*.elf' \) 2>/dev/null \
  | grep -vE '/(systemd-private|snap-private-tmp)' | sort | head -50
sec "hidden dirs in tmp"
find /tmp /var/tmp /dev/shm -maxdepth 2 -name '.*' ! -name '.X*' ! -name '.ICE-unix' ! -name '.font-unix' ! -name '.Test-unix' 2>/dev/null | sort
sec "suid outside package dirs"
find / -xdev -perm -4000 -type f 2>/dev/null | grep -vE '^/(usr/(bin|sbin|lib|libexec|lib64)|bin|sbin|var/lib/(docker|containers))/' | sort
sec "ld.so.preload"
cat /etc/ld.so.preload 2>/dev/null
sec "git drift in app dirs"
for d in /opt/*/ /var/www/* /root/*/ /root/heroku-migrated/*/ /home/*/*/; do
  [ -d "$d/.git" ] || continue
  c=$(git -C "$d" -c safe.directory='*' status --porcelain --untracked-files=normal 2>/dev/null | grep -vE '(node_modules|\.next|dist|build|\.log|\.pm2)/?' | wc -l)
  echo "$(cd "$d" && pwd) head=$(git -C "$d" -c safe.directory='*' rev-parse --short HEAD 2>/dev/null) dirty=$c"
done | sort -u
sec "php in docroots modified in last 26h"
for r in /var/www /home/*/public_html; do
  [ -d "$r" ] && find "$r" -xdev -name '*.php' -mmin -1560 2>/dev/null
done | sed -E 's#/[^/]+$##' | sort | uniq -c | sort -rn | head -20
sec "webshell signatures in docroots"
for r in /var/www /home/*/public_html; do
  [ -d "$r" ] && grep -rlE --include='*.php' 'eval\(\s*(base64_decode|gzinflate|str_rot13)|eval\(\$_(POST|GET|REQUEST|COOKIE)|assert\(\$_|FilesMan|preg_replace\(.*/e.,\s*\$_' "$r" 2>/dev/null
done | head -20
sec "auth (last 26h)"
journalctl -q --since "26 hours ago" -t sshd -t sshd-session -o cat 2>/dev/null | grep -E 'Accepted' \
  | awk '{print $1, $2, $4, $6}' | sort | uniq -c
echo "failed: $(journalctl -q --since '26 hours ago' -t sshd -t sshd-session -o cat 2>/dev/null | grep -cE 'Failed|Invalid user')"
journalctl -q --since "26 hours ago" -t sudo -o cat 2>/dev/null | grep -E 'COMMAND' | awk -F'COMMAND=' '{print $1}' | sed -E 's/ +TTY=\S+ ; PWD=\S+ ;//' | sort | uniq -c | head
journalctl -q --since "26 hours ago" -o cat 2>/dev/null | grep -E 'useradd|usermod|groupadd|passwd\[' | head
