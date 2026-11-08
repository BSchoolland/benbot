import semver from 'semver';
// Pure matching decisions shared by scan.mjs and its tests. No I/O here: callers pass feeds and host facts in.

const modular = (ver) => /\.module[_+]/.test(ver);

// Decide what an OSV match means for this host. Returns null when the match is not real here,
// otherwise { summary, fixed, debian } for the finding.
//   installed: installed version string; ecosystem: e.g. "AlmaLinux:8", "Debian:12", "npm"
//   osv: the OSV record; fixed: fixed versions OSV lists for this package/ecosystem
//   moduleStreams: enabled "name:stream" list for RPM hosts, or undefined
//   debianEntry: [status, urgency, nodsa, fixedVersion] from the Debian tracker for this release, or undefined
//   dpkgLess(a, b): Debian version comparison
export function osvDecision({ installed, ecosystem, osv, fixed, moduleStreams, debianEntry, dpkgLess }) {
  // OSV ignores RPM module streams: a perl:5.32 advisory matches perl 5.26 packages. Different modularity = different stream.
  if (fixed.length && fixed.every((f) => modular(f) !== modular(installed))) return null;
  // OSV unions every stream's range, so a build of the exact fixed version can still match an older build's range.
  if (fixed.includes(installed)) return null;
  let summary = (osv.summary ?? osv.details ?? '').slice(0, 200);
  let fixedHere = fixed;
  // ALSA summaries name the module stream ("php:7.2 security update"). A fix shipped in a stream this host doesn't run
  // installs nothing here: the CVE is unfixed for this host and belongs with the daily pass, not the pager.
  const stream = modular(installed) && moduleStreams && /^\w+:\s*([\w.-]+:[\w.-]+)\s/.exec(osv.summary ?? '')?.[1];
  if (stream && !moduleStreams.includes(stream)) {
    const same = moduleStreams.filter((m) => m.startsWith(stream.split(':')[0] + ':')).join(', ') || 'no such stream';
    summary = `[fix only in ${stream}; host runs ${same}] ${summary}`.slice(0, 240);
    fixedHere = [];
  }
  let debian;
  if (ecosystem.startsWith('Debian:') && !fixedHere.length && debianEntry) {
    const [status, urgency, nodsa, fixedVer] = debianEntry;
    debian = { status, urgency, nodsa };
    // Debian fixed it but OSV hasn't caught up: that is an installable fix, so let it page like one.
    if (status === 'resolved' && fixedVer && fixedVer !== '0' && dpkgLess(installed, fixedVer)) fixedHere = [fixedVer];
  }
  return { summary, fixed: fixedHere, debian };
}

// WPVulnerability often has no CVSS for days after Wordfence/WPScan publish. An unscored advisory is unknown severity,
// not low: estimate from the advisory's own words so an unauthenticated SQLi/RCE pages like the 9+ it almost always is.
const CRITICAL_CLASS = /sql injection|remote code execution|code injection|arbitrary file (upload|deletion|read|download)|php object injection|privilege escalation|authentication bypass|account takeover|arbitrary (user|admin) (creation|password)|session cookies?|session tokens?/i;
const UNAUTH = /\bunauthenticated\b/i;

export function wpScore(vuln) {
  const real = vuln.impact?.cvss?.score;
  if (real != null && real !== '') return { score: Number(real), estimated: false };
  const text = [vuln.name, ...(vuln.source ?? []).map((s) => s.description ?? '')].join(' ');
  if (UNAUTH.test(text) && CRITICAL_CLASS.test(text)) return { score: 9.0, estimated: true };
  return { score: null, estimated: false };
}

export const wpDescription = (vuln) => ((vuln.source ?? []).map((s) => s.description).find(Boolean) ?? vuln.name ?? '').replace(/^\[en\]\s*/, '');

// GitHub advisory ranges are comma-separated (">= 1.3.14, < 1.4.4"); semver wants spaces. An unparseable range throws.
export function bunAffected(version, range) {
  const r = semver.validRange(range.replace(/,/g, ' '));
  if (!r) throw new Error(`unparseable Bun advisory range: ${range}`);
  return semver.satisfies(version, r);
}

// Per-step collector health: a step that keeps failing (ss, dnf, wp-cli...) is a blind spot just like a dead host.
// Collector errors look like "<step>: <message>". Steps that succeeded this run reset to 0.
export function collectorHealth(health, host, collectorErrors, now) {
  const failing = new Map(collectorErrors.map((e) => [e.split(':')[0].trim(), e]));
  for (const key of Object.keys(health)) {
    if (!key.startsWith(`collect:${host}:`)) continue;
    if (!failing.has(key.slice(`collect:${host}:`.length))) health[key] = { fails: 0 };
  }
  for (const [step, msg] of failing) {
    const key = `collect:${host}:${step}`;
    const old = health[key];
    health[key] = { fails: (old?.fails ?? 0) + 1, last_error: msg.slice(0, 300), since: old?.since ?? now, alerted: old?.alerted };
  }
}
