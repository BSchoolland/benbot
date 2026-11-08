#!/bin/bash
# Daily intrusion snapshot of every host in hosts.json, diffed against that host's previous snapshot.
# Usage: security/intrusion-snapshot.sh <YYYY-MM-DD>
# Writes state/security/snapshots/<host>-<date>.txt and prints, per host: ssh status, failed checks, and the diff of
# every section except the ones that churn by nature (outbound, auth, recently changed PHP).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/state/security/snapshots
DATE=${1:?usage: intrusion-snapshot.sh YYYY-MM-DD}
mkdir -p "$DIR"
VOLATILE='^=== (outbound established|auth since|php in docroots modified since)'

# Section names before the Nov 7 rewrite map onto the current ones so the first diff isn't all renames.
stable() {
  awk -v vol="$VOLATILE" '/^=== /{skip = ($0 ~ vol)} !skip && !/^# taken /' "$1" | sed -E 's/^(=== .*) rc=[0-9]+$/\1/
    s/^=== systemd units \(enabled, non-vendor\)$/=== systemd units (non-vendor)/; s/^=== pm2 \(all users\)$/=== pm2 children (all users)/
    s/^=== hidden dirs in tmp$/=== hidden entries in tmp dirs/' | grep -vx '=== end'
}

for host in $(jq -r '.[].ssh' "$ROOT/security/hosts.json"); do
  out=$DIR/$host-$DATE.txt
  prev=$(find "$DIR" -maxdepth 1 -regextype egrep -regex ".*/$host-[0-9]{4}-[0-9]{2}-[0-9]{2}\.txt" ! -name "$host-$DATE.txt" | sort | tail -1)
  # Review interval: from 10 minutes before the previous snapshot was written (overlap, never a gap).
  if [ -n "$prev" ]; then since=$(date -u -d "@$(( $(stat -c %Y "$prev") - 600 ))" '+%Y-%m-%d %H:%M:%S UTC'); else since="26 hours ago"; fi
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$host" "TERM=dumb bash -s -- '$since'" <"$ROOT/security/intrusion.sh" >"$out.tmp" 2>"$out.ssh-err"
  rc=$?
  echo "##### $host ssh rc=$rc since='$since' prev=${prev:+$(basename "$prev")}"
  if [ $rc -ne 0 ] || ! tail -1 "$out.tmp" | grep -qx '=== end'; then
    echo "SNAPSHOT INCOMPLETE: ssh rc=$rc, last line: $(tail -1 "$out.tmp")"; sed 's/^/  ssh!! /' "$out.ssh-err"
    mv "$out.tmp" "$out.incomplete"; continue
  fi
  mv "$out.tmp" "$out"; rm -f "$out.ssh-err"
  grep -E '^=== .* rc=[1-9][0-9]*$' "$out" | sed 's/^/FAILED CHECK: /'
  stderr_n=$(grep -c '^!! ' "$out"); [ "$stderr_n" -gt 0 ] && echo "stderr lines: $stderr_n (see file)"
  if [ -n "$prev" ]; then
    d=$(diff <(stable "$prev") <(stable "$out") | grep -E '^[<>]')
    if [ -n "$d" ]; then sed 's/^/  /' <<<"$d"; else echo "  (no change in stable sections)"; fi
  fi
done
