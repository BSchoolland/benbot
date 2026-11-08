#!/bin/bash
# Tests for intrusion.sh's check wrapper: exit status, pipefail, stderr capture, grep no-match, loop failures.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
INTRUSION_LIB=1 . "$HERE/../intrusion.sh" >/dev/null
fail=0
expect() { if grep -qxF -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1: expected line '$2' in:"; sed 's/^/     /' <<<"$3"; fail=1; fi; }

ok_fn() { echo hello; }
expect "success has rc=0" "=== s rc=0" "$(check s ok_fn)"
bad_fn() { echo partial; echo boom >&2; return 4; }
out=$(check b bad_fn)
expect "failure keeps its rc" "=== b rc=4" "$out"
expect "failure keeps its stdout" "partial" "$out"
expect "stderr is captured with !! prefix" "!! boom" "$out"
early_fail() { false | sort; }
expect "pipefail: an early pipeline stage failing is a failure" "=== p rc=1" "$(check p early_fail)"
nomatch() { echo abc | g zzz; }
expect "grep no-match is success" "=== n rc=0" "$(check n nomatch)"
badgrep() { echo abc | g -E '('; }
expect "grep error is a failure" "=== e rc=2" "$(check e badgrep)"
missing() { need definitely-not-a-command-xyz && echo never; }
out=$(check m missing)
expect "missing tool is a failure" "=== m rc=3" "$out"
expect "missing tool says so" "!! definitely-not-a-command-xyz not installed" "$out"

# keys(): an unparseable file in the middle of the loop must fail the check even if later files parse.
d=$(mktemp -d); mkdir -p "$d/a" "$d/b"
echo "not a key" >"$d/a/authorized_keys"; ssh-keygen -q -t ed25519 -N '' -f "$d/k" && cp "$d/k.pub" "$d/b/authorized_keys"
: >"$d/c"
key_files() { printf '%s\n' "$d/a/authorized_keys" "$d/c" "$d/b/authorized_keys"; }
out=$(check k keys)
expect "a bad key file mid-loop fails the check" "=== k rc=1" "$out"
expect "empty key file is reported, not skipped" "$d/c (empty)" "$out"
rm -rf "$d"

# units(): a missing optional directory at the end of the list is not a failure.
out=$(check u units)
expect "units passes on this machine (missing optional dirs are fine)" "=== u rc=0" "$out"
expect "crontabs passes on this machine" "=== c rc=0" "$(check c crontabs)"
exit $fail
