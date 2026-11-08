#!/bin/bash
# Daily WordPress forensic snapshot for the given sites (ssh HOST bash -s -- <since> < wp-forensics.sh).
# Same output contract as intrusion.sh: "=== <site> <check> rc=<n>", output, "!! " stderr, final "=== end".
#
# Credential-bearing data never leaves the host. Application passwords: user id, uuid, name, created, last_used,
# last_ip only. Snippets: id, name, active, modified (no code). Options and posts: names, ids and lengths only. Secret
# patterns: location and count only.
export LC_ALL=C
SINCE=${1:-26 hours ago}
SITES="SITES"
echo "# taken $(date -u +%Y-%m-%dT%H:%M:%SZ) since: $SINCE"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
check() {
  local name=$1 rc; shift
  ( set -o pipefail; "$@" ) >"$TMP/out" 2>"$TMP/err"; rc=$?
  echo; echo "=== $name rc=$rc"; redact <"$TMP/out"; redact <"$TMP/err" | sed 's/^/!! /'
}
# Backstop if a command ever ignores --fields: phpass/bcrypt/argon/wp hashes and API-key shapes never print.
redact() { sed -E 's/\$(P|H|wp|2[aby]|argon2[a-z]*)\$[^ ,"]*/[hash withheld]/g; s/sk-(ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/[key withheld]/g'; }
g() { grep "$@"; local r=$?; [ $r -le 1 ] || return $r; }
W() { sudo -u www-data wp --path="$P" --skip-plugins --skip-themes "$@"; }
Q() { W db query "$1" --skip-column-names; }

core() { W core version; W core verify-checksums 2>&1; }
admins() { W user list --role=administrator --fields=ID,user_login,user_email,user_registered --format=csv; }
counts() {
  echo "users=$(W user list --format=count)"
  echo "users_can_register=$(W option get users_can_register)"
  echo "admin_email=$(W option get admin_email)"
  Q "SELECT 'newest_user', MAX(user_registered) FROM ${PFX}users"
  Q "SELECT 'admin_cap_rows', COUNT(*) FROM ${PFX}usermeta WHERE meta_key='${PFX}capabilities' AND meta_value LIKE '%administrator%'"
}
app_passwords() {
  local id ids
  ids=$(Q "SELECT user_id FROM ${PFX}usermeta WHERE meta_key='_application_passwords' AND meta_value<>'a:0:{}'") || return
  for id in $ids; do
    W user application-password list "$id" --fields=uuid,name,created,last_used,last_ip --format=csv | sed "s/^/user=$id,/" || return
  done
  echo "users with app passwords: ${ids:-none}"
}
plugins() { W plugin list --fields=name,status,version --format=csv; ls -la "$P/wp-content/mu-plugins/"; }
# Mismatches also exit 1, so success means wp-cli got far enough to print its verdict line.
plugin_checksums() {
  W plugin verify-checksums --all >"$TMP/pc" 2>&1
  g -vE '^Success|^plugin_name' "$TMP/pc"
  grep -qE '^(Success: Verified|Error: Only verified) ' "$TMP/pc"
}
dropins() { local f; for f in object-cache.php advanced-cache.php db.php; do [ -e "$P/wp-content/$f" ] && echo "PRESENT $f"; done; return 0; }
stray() { find "$P" -maxdepth 2 \( -name '*.sql' -o -name '*.sql.gz' -o -name 'wp-config*.bak*' -o -name 'wp-config*~' \); find "$P/wp-content/uploads" -name '*.php' -printf '%s %TY-%Tm-%Td %p\n'; }
php_changed() {
  local m=$(( ( $(date +%s) - $(date -d "$SINCE" +%s) ) / 60 + 1 ))
  find "$P" -name '*.php' -mmin -"$m" | sed -E 's#^'"$P"'/##; s#^(wp-content/(plugins|themes)/[^/]+|wp-content/[^/]+|wp-includes|wp-admin)/.*#\1#' | sort | uniq -c
}
loaders() {
  g -rlE --include='*.php' 'eval\(\s*(base64_decode|gzinflate|gzuncompress|str_rot13)|eval\(\$_(POST|GET|REQUEST|COOKIE|SERVER)|assert\(\$_|FilesMan|preg_replace\(.*/e.,|gzinflate\(\s*base64_decode|create_function\(.*\$_(POST|GET|REQUEST|COOKIE)' "$P/wp-content" "$P/wp-includes" "$P/wp-admin" "$P"/*.php
}
has_snippets() { local t; t=$(Q "SHOW TABLES LIKE '${PFX}snippets'") || return 2; [ -n "$t" ]; }
snippets() {
  has_snippets; case $? in 0) ;; 1) echo "(no snippets table)"; return 0 ;; *) return 1 ;; esac
  Q "SELECT id, name, active, modified FROM ${PFX}snippets"
}
db_code() {
  Q "SELECT option_name, LENGTH(option_value) FROM ${PFX}options WHERE autoload IN ('yes','on','auto-on','auto') AND (option_value LIKE '%eval(%' OR option_value LIKE '%base64_decode%' OR option_value LIKE '%gzinflate%' OR option_value LIKE '%<?php%')"
}
secrets_locations() {
  # Location and count only: the suppressed-topic credentials Ben asked us to keep tracking.
  local pat='(sk-ant-|sk-proj-|sk-or-v1-|sk-[A-Za-z0-9]{20})'
  Q "SELECT 'options', option_name FROM ${PFX}options WHERE option_value REGEXP '$pat'" || return
  Q "SELECT 'revisions/posts', ID, post_type, post_status FROM ${PFX}posts WHERE post_content REGEXP '$pat'" || return
  has_snippets; case $? in 0) Q "SELECT 'snippets', id FROM ${PFX}snippets WHERE code REGEXP '$pat'" ;; 1) ;; *) return 1 ;; esac
}
content() { Q "SELECT post_type, post_status, COUNT(*) FROM ${PFX}posts WHERE post_date > '$(date -u -d "$SINCE" '+%F %T')' OR post_modified_gmt > '$(date -u -d "$SINCE" '+%F %T')' GROUP BY 1,2"; }
cron_hooks() { W cron event list --fields=hook --format=csv | sort -u | tr '\n' ' '; echo; }
htaccess() { md5sum "$P/.htaccess"; stat -c '%y %z' "$P/.htaccess"; }
batch_endpoint() { echo "POST batch/v1 -> $(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$HOST/wp-json/batch/v1")"; echo "GET / -> $(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/")"; }

fail2ban() {
  fail2ban-client status | g 'Jail list'
  local j
  for j in $(fail2ban-client status | sed -n 's/.*Jail list:\s*//p' | tr ',' ' '); do
    echo "$j $(fail2ban-client status "$j" | g -E 'Currently banned|Total banned' | awk -F: '{gsub(/ /,"",$2); printf "%s ", $2}')"
  done
}
reporter() {
  echo "last: $(tail -1 /var/log/abuseipdb-report.log | cut -c1-60)"
  echo "since-window reports: $(awk -v s="[$(date -u -d "$SINCE" +%Y-%m-%dT%H:%M)" '$1 >= s' /var/log/abuseipdb-report.log | g -c REPORT)"
  echo "since-window errors: $(awk -v s="[$(date -u -d "$SINCE" +%Y-%m-%dT%H:%M)" '$1 >= s' /var/log/abuseipdb-report.log | g -ciE 'error|fail|429|401')"
}
# Sourced by the tests with WPF_LIB=1: definitions only.
[ -n "${WPF_LIB:-}" ] && return 0

for s in $SITES; do
  SITE=${s%%:*}; P=${s#*:}
  PFX=$(W db prefix) || { echo; echo "=== $SITE db-prefix rc=1"; continue; }
  HOST=$(W option get siteurl | sed -E 's#^https?://##; s#/.*##')
  for c in core admins counts app_passwords plugins plugin_checksums dropins stray php_changed loaders snippets db_code secrets_locations content cron_hooks htaccess batch_endpoint; do
    check "$SITE $c" "$c"
  done
done

check "fail2ban" fail2ban
check "abuseipdb reporter" reporter
echo; echo "=== end"
