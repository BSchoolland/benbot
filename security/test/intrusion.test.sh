#!/bin/bash
# Tests for intrusion.sh. Each case runs a REAL check function with system commands shadowed by bash functions, and
# covers the ways a multi-command check can lie: an early command failing before a successful final command, a failure
# in the middle of a loop, and a failing command substitution.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
INTRUSION_LIB=1 . "$HERE/../intrusion.sh" >/dev/null
fail=0
rc_of() { check t "$@" | sed -n 's/^=== t rc=//p'; }
expect_rc() {  # expect_rc <label> <ok|fail> <fn...>
  local label=$1 want=$2 got; shift 2
  got=$(rc_of "$@")
  if { [ "$want" = ok ] && [ "$got" = 0 ]; } || { [ "$want" = fail ] && [ "$got" != 0 ] && [ -n "$got" ]; }; then echo "ok   $label (rc=$got)"
  else echo "FAIL $label: wanted $want, got rc=$got"; check t "$@" | sed 's/^/     /'; fail=1; fi
}
expect_line() { if grep -qxF -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1: expected '$2' in:"; sed 's/^/     /' <<<"$3"; fail=1; fi; }
# Drop command stubs, then re-source so lib functions a test replaced (git_dirs, key_files...) come back.
reset() { unset -f ss pgrep ps readlink git find journalctl date cat 2>/dev/null; INTRUSION_LIB=1 . "$HERE/../intrusion.sh" >/dev/null; }

# --- wrapper and helpers
ok_fn() { echo hello; }; expect_rc "plain success" ok ok_fn
bad_fn() { echo partial; echo boom >&2; return 4; }
out=$(check b bad_fn); expect_line "failure keeps rc" "=== b rc=4" "$out"; expect_line "stderr captured" "!! boom" "$out"
early_then_ok() { false; echo "last command fine"; }; expect_rc "generic: early failure then successful final command" fail early_then_ok
subst_in_assign() { local x; x=$(false); echo "x=$x"; }; expect_rc "generic: failing substitution in an assignment" fail subst_in_assign
nested_subst() { local x; x=$(true; false; true); echo "$x"; }; expect_rc "generic: failure inside a substitution body (inherit_errexit)" fail nested_subst
nomatch() { echo abc | g zzz; }; expect_rc "grep no-match is success" ok nomatch
badgrep() { echo abc | g -E '('; }; expect_rc "grep error is failure" fail badgrep

# --- listeners / outbound
reset; ss() { echo "ss: netlink" >&2; return 2; }
expect_rc "listeners: ss failing" fail listeners
reset; ss() { case "$*" in -Hltn) return 2 ;; *) printf 'ESTAB 0 0 10.0.0.1:5555 1.2.3.4:443 users:(("node",pid=1,fd=3))\n' ;; esac; }
expect_rc "outbound: early ss (listening ports) fails, final ss succeeds" fail outbound
reset; ss() { case "$*" in -Hltn) printf 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n' ;; *) printf '0 0 10.0.0.1:5555 1.2.3.4:443 users:(("node",pid=1,fd=3))\n' ;; esac; }
out=$(check t outbound); expect_line "outbound: healthy run lists the peer" "      1 1.2.3.4:443 node" "$out"

# --- pm2: substitution failures
reset; pgrep() { return 2; }
expect_rc "pm2: pgrep error inside the daemon-list substitution" fail pm2_children
reset; pgrep() { return 1; }
expect_rc "pm2: no daemons (pgrep 1) is clean" ok pm2_children
reset; pgrep() { case "$*" in -f*) echo 100 ;; -P*) echo 200; echo 201 ;; esac; }
ps() { echo root; }; readlink() { case "$1" in /proc/201/*) return 1 ;; *) echo /x ;; esac; }
expect_rc "pm2: readlink failing for the 2nd child (mid-loop, in a substitution)" fail pm2_children

# --- git drift: mid-loop failure
reset; git_dirs() { printf '%s\n' /tmp/a /tmp/b; }
git() { case "$*" in *"-C /tmp/a"*status*) echo "fatal: bad index" >&2; return 128 ;; *status*) return 0 ;; *rev-parse*) echo abc123 ;; esac; }
expect_rc "git drift: status fails for the first repo, second fine" fail git_drift
reset; git_dirs() { printf '%s\n' /tmp /var; }
git() { case "$*" in *"-C /var"*rev-parse*) return 128 ;; *status*) return 0 ;; *rev-parse*) echo abc ;; esac; }
expect_rc "git drift: rev-parse fails for the last repo (in a substitution)" fail git_drift

# --- vhosts: mid-loop failure
reset; vhost_dirs() { printf '%s\n' /tmp /var/tmp; }
find() { case "$1" in /tmp) return 1 ;; *) command find "$@" ;; esac; }
expect_rc "vhosts: find fails on the first config dir, second fine" fail vhosts
reset; vhost_dirs() { true; }
out=$(check t vhosts); expect_line "vhosts: no config dirs is stated, not empty" "(no web server config dirs)" "$out"

# --- vhost_names: Caddy site files (*.caddy and Caddyfile), nginx
d=$(mktemp -d); printf 'example.com, www.example.com {\n  reverse_proxy 127.0.0.1:3000 {\n  }\n}\n' >"$d/site.caddy"
printf 'server {\n  server_name a.example b.example;\n}\n' >"$d/nginx.conf"
expect_line "vhost_names: .caddy site addresses" "example.com www.example.com " "$(vhost_names "$d/site.caddy" | tr -s ' \n' ' ')"
expect_line "vhost_names: nginx server_name" "a.example b.example " "$(vhost_names "$d/nginx.conf" | tr -s ' \n' ' ' | sed 's/^ //')"
rm -rf "$d"

# --- auth: early journalctl failure, later ones fine
reset; journalctl() { case "$*" in *sshd*) return 1 ;; *) return 0 ;; esac; }
expect_rc "auth: sshd journal fails, sudo/all journals succeed" fail auth
reset; journalctl() { case "$*" in *sudo*) return 1 ;; *) echo "Accepted publickey for root from 1.2.3.4 port 1 ssh2" ;; esac; }
expect_rc "auth: middle (sudo) journal fails" fail auth

# --- php_changed: date failing inside a substitution
reset; date() { case "$*" in *-d*) echo "date: invalid date" >&2; return 1 ;; *) command date "$@" ;; esac; }
expect_rc "php_changed: unparseable --since date" fail php_changed

# --- sudoers: early cat failure, md5sum (final) fine
reset; cat() { case "$1" in /etc/sudoers) return 1 ;; *) command cat "$@" ;; esac; }
expect_rc "sudoers: cat /etc/sudoers fails before md5sum" fail sudoers

# --- crontabs: one unreadable crontab in the middle of the loop
reset; g() { case "${*: -1}" in /etc/crontab) echo "grep: /etc/crontab: Permission denied" >&2; return 2 ;; *) local r=0; grep "$@" || r=$?; [ $r -le 1 ] || return $r ;; esac; }
expect_rc "crontabs: /etc/crontab unreadable mid-loop" fail crontabs
g() { local r=0; grep "$@" || r=$?; [ $r -le 1 ] || return $r; }

# --- keys: mid-loop bad file, empty file reported
reset; d=$(mktemp -d); mkdir -p "$d/a" "$d/b"
echo "not a key" >"$d/a/authorized_keys"; ssh-keygen -q -t ed25519 -N '' -f "$d/k" && cp "$d/k.pub" "$d/b/authorized_keys"; : >"$d/c"
key_files() { printf '%s\n' "$d/a/authorized_keys" "$d/c" "$d/b/authorized_keys"; }
expect_rc "keys: unparseable file mid-loop, later file fine" fail keys
key_files() { printf '%s\n' "$d/c" "$d/b/authorized_keys"; }
out=$(check t keys); expect_line "keys: empty file is reported" "$d/c (empty)" "$out"; expect_line "keys: healthy rc" "=== t rc=0" "$out"
rm -rf "$d"; reset

# --- real host smoke: every check that does not need root passes on this machine (the snapshot itself runs as root)
reset
for fn in users uid0 keys crontabs units running listeners outbound preload vhosts php_changed auth; do
  expect_rc "smoke: $fn passes here" ok "$fn"
done
exit $fail
