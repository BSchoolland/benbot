#!/bin/bash
# Tests for wp-forensics.sh: a failing DB/wp-cli call must fail its check; empty results are clean; secrets never print.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WPF_LIB=1 . "$HERE/../wp-forensics.sh" >/dev/null
fail=0
expect() { if grep -qxF -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1: expected '$2' in:"; sed 's/^/     /' <<<"$3"; fail=1; fi; }
reject() { if grep -qF -- "$2" <<<"$3"; then echo "FAIL $1: found '$2'"; fail=1; else echo "ok   $1"; fi; }
PFX=wp_ P=/nonexistent

# Every DB query fails.
W() { echo "Error: db down" >&2; return 1; }
for c in counts app_passwords snippets db_code secrets_locations content; do
  out=$(check "t $c" "$c"); expect "$c fails when the DB query fails" "=== t $c rc=1" "$(grep '^=== ' <<<"$out")"
done

# DB works, nothing found.
W() { case "$*" in "db query"*) return 0 ;; "user list"*) echo 3 ;; "option get"*) echo 0 ;; *) return 0 ;; esac; }
expect "snippets: missing table is clean" "(no snippets table)" "$(check t snippets)"
expect "snippets: missing table rc=0" "=== t snippets rc=0" "$(check "t snippets" snippets | grep '^===')"
expect "app_passwords: none is explicit" "users with app passwords: none" "$(check t app_passwords)"
expect "secrets_locations: none rc=0" "=== t secrets_locations rc=0" "$(check "t secrets_locations" secrets_locations | grep '^===')"

# wp-cli ignores --fields and dumps the hash: the backstop withholds it.
W() { case "$*" in "db query"*) echo 4 ;; "user application-password list"*) printf 'uuid,name,password\nabc,ios,$P$Bsomehashvalue123\n' ;; esac; }
out=$(check t app_passwords)
reject "app password hash never printed" '$P$Bsome' "$out"
expect "withheld marker shown instead" "user=4,abc,ios,[hash withheld]" "$out"
# Every check the main loop runs must be defined (a bad edit once deleted six of them).
for c in $(sed -n 's/^  for c in \(.*\); do$/\1/p' "$HERE/../wp-forensics.sh") fail2ban reporter; do
  declare -F "$c" >/dev/null && echo "ok   defined: $c" || { echo "FAIL undefined check: $c"; fail=1; }
done | grep -v '^ok' ; [ ${PIPESTATUS[0]} -eq 0 ] || fail=1
W() { echo "Error: Error establishing a database connection" ; return 1; }
expect "plugin_checksums fails on a wp-cli error" "=== t pc rc=1" "$(check "t pc" plugin_checksums | grep '^===')"
W() { printf 'Warning: x\nplugin_name\tfile\tmessage\nhello\thello.php\tChecksum does not match\nError: Only verified 18 of 23 plugins (3 failed, 2 skipped).\n'; return 1; }
out=$(check "t pc" plugin_checksums)
expect "plugin_checksums: mismatches are a finding, rc=0" "=== t pc rc=0" "$(grep '^===' <<<"$out")"
expect "plugin_checksums: mismatch line shown" "hello	hello.php	Checksum does not match" "$out"
exit $fail
