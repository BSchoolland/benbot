#!/usr/bin/env node
// Hourly vulnerability scan of every box in hosts.json. No model involved.
// Collects real installed versions over SSH, matches them against OSV, the Node.js security-wg feed,
// WPVulnerability and CISA KEV, and wakes the security-triage job only for new findings that are
// CVSS >= 9 or known-exploited. Everything it could not cover goes to coverage.json for the daily job.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import semver from 'semver';
import { cvss3 } from './cvss.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state/security');
const CACHE = path.join(STATE, 'cache');
const THRESHOLD = 9.0;
const BLIND_AFTER = 3;
for (const d of ['inventory', 'cache/osv', 'pending']) fs.mkdirSync(path.join(STATE, d), { recursive: true });

const readJson = (f, dflt) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : dflt);
const writeJson = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f); };
const now = new Date().toISOString();
const errors = [];

async function http(url, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status < 500) throw new Error(`${opts.method ?? 'GET'} ${url} -> ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function cached(name, maxAgeMs, load) {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < maxAgeMs) return readJson(f);
  const v = await load();
  writeJson(f, v);
  return v;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function collect(host) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host.ssh, 'python3 -I -'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 600000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`collect ${host.name}: ssh exit ${code}: ${err.trim().slice(-300)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`collect ${host.name}: bad JSON: ${e.message}`)); }
    });
    p.stdin.end(fs.readFileSync(path.join(HERE, 'collect.py')));
  });
}

// ---------- feeds ----------
const KEV = new Set((await cached('kev.json', 3 * 3600e3, () =>
  http('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'))).vulnerabilities.map((v) => v.cveID));
const NODE_VULNS = Object.values(await cached('node-core-vulns.json', 3 * 3600e3, () =>
  http('https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json')));
const NODE_SCHEDULE = await cached('node-schedule.json', 24 * 3600e3, () =>
  http('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'));

// ---------- OSV ----------
const osvDetail = (id) => cached(`osv/${id.replace(/[^\w.-]/g, '_')}.json`, 24 * 3600e3, () => http(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`));

async function osvIds(queries) {
  const ids = queries.map(() => []);
  let pending = queries.map((q, i) => ({ q, i }));
  while (pending.length) {
    const next = [];
    for (let s = 0; s < pending.length; s += 1000) {
      const chunk = pending.slice(s, s + 1000);
      const res = await http('https://api.osv.dev/v1/querybatch', { method: 'POST', body: JSON.stringify({ queries: chunk.map((c) => c.q) }) });
      res.results.forEach((r, k) => {
        const { q, i } = chunk[k];
        for (const v of r.vulns ?? []) ids[i].push(v.id);
        if (r.next_page_token) next.push({ q: { ...q, page_token: r.next_page_token }, i });
      });
    }
    pending = next;
  }
  return ids;
}

const LABEL = { CRITICAL: 9.0, HIGH: 7.0, MODERATE: 4.0, MEDIUM: 4.0, LOW: 0.1 };
async function judge(v) {
  const cves = [...new Set([v.id, ...(v.aliases ?? []), ...(v.upstream ?? []), ...(v.related ?? [])].filter((x) => /^CVE-\d+-\d+$/.test(x)))];
  let score = null;
  const take = (s) => { if (s != null && (score == null || s > score)) score = s; };
  for (const s of v.severity ?? []) if (s.type === 'CVSS_V3') take(cvss3(s.score));
  take(LABEL[String(v.database_specific?.severity ?? '').toUpperCase()]);
  if (/^Critical:/.test(v.summary ?? '')) take(9.0);
  // Distro advisories (ALSA, some DEBIAN-CVE) carry no vector; borrow the NVD score from the CVE record.
  if (score == null) {
    for (const c of cves.slice(0, 40)) {
      const rec = await osvDetail(c).catch(() => null);
      for (const s of rec?.severity ?? []) if (s.type === 'CVSS_V3') take(cvss3(s.score));
    }
  }
  return { score, kev: cves.some((c) => KEV.has(c)), cves };
}

function fixedFor(v, name, ecosystem) {
  const out = new Set();
  for (const a of v.affected ?? []) if (a.package?.name === name && a.package?.ecosystem === ecosystem) for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) out.add(e.fixed);
  return [...out];
}

// ---------- WordPress ----------
function wpCmp(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
const OPS = { lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0, eq: (c) => c === 0 };
function wpAffected(ver, op) {
  if (op.min_version && !OPS[op.min_operator]?.(wpCmp(ver, op.min_version))) return false;
  if (op.max_version && !OPS[op.max_operator]?.(wpCmp(ver, op.max_version))) return false;
  if (!op.min_version && !op.max_version) return op.unfixed === '1';
  return true;
}
const wpFeed = (kind, slug) => cached(`wp-${kind}-${slug}.json`, 3 * 3600e3, () => http(`https://www.wpvulnerability.net/${kind}/${slug}/`));

// ---------- scan ----------
const hosts = readJson(path.join(HERE, 'hosts.json'));
const findings = readJson(path.join(STATE, 'findings.json'), {});
const health = readJson(path.join(STATE, 'health.json'), {});
const coverage = { at: now, hosts: {} };
const seen = new Set();
const scannedHosts = new Set();

function record(f) {
  const key = [f.host, f.where, f.pkg, f.vuln].join('|');
  seen.add(key);
  // A distro CVE the release itself has not fixed has nothing to install; it waits for the daily pass, not the pager.
  const unpatchableDistro = f.where.startsWith('os ') && !f.fixed.length;
  const flagged = f.kind === 'eol' || f.kev || (f.score != null && f.score >= THRESHOLD && !unpatchableDistro);
  const old = findings[key];
  findings[key] = { ...old, ...f, flagged, first_seen: old?.first_seen ?? now, last_seen: now, status: 'open', resolved_at: undefined };
  if (old?.status === 'resolved') findings[key].reopened = now;
}

const inventories = await Promise.all(hosts.map((h) => collect(h).then((inv) => ({ h, inv }), (e) => ({ h, err: e }))));
for (const { h, inv, err } of inventories) {
  const hk = `host:${h.name}`;
  if (err) { errors.push(err.message); health[hk] = { fails: (health[hk]?.fails ?? 0) + 1, last_error: err.message, since: health[hk]?.since ?? now }; continue; }
  health[hk] = { fails: 0 };
  writeJson(path.join(STATE, 'inventory', `${h.name}.json`), { at: now, ...inv });
  const cov = (coverage.hosts[h.name] = { scanned: [], not_scanned: [], collector_errors: inv.errors });
  for (const e of inv.errors) errors.push(`${h.name} collector: ${e}`);

  try {
    // OS packages + npm through OSV
    const queries = [], where = [];
    if (inv.os_pkgs) {
      for (const [name, version] of inv.os_pkgs.pkgs) { queries.push({ package: { name, ecosystem: inv.os_pkgs.ecosystem }, version }); where.push({ where: `os ${inv.os_pkgs.ecosystem}`, ecosystem: inv.os_pkgs.ecosystem, pkg: name, version }); }
      cov.scanned.push(`${inv.os_pkgs.pkgs.length} ${inv.os_pkgs.ecosystem} packages`);
      for (const f of inv.os_pkgs.foreign) cov.not_scanned.push(`third-party apt package ${f} (only covered if it is a runtime handled below)`);
    }
    for (const app of inv.npm ?? []) {
      for (const [name, version] of app.pkgs) { queries.push({ package: { name, ecosystem: 'npm' }, version }); where.push({ where: `npm ${app.app} (${app.dir})`, ecosystem: 'npm', pkg: name, version }); }
      cov.scanned.push(`${app.pkgs.length} npm packages in ${app.app}`);
      if (!app.pkgs.length) cov.not_scanned.push(`${app.app} (${app.dir}): no node_modules found to read`);
    }
    const idLists = await osvIds(queries);
    const allIds = [...new Set(idLists.flat())];
    const details = Object.fromEntries((await pool(allIds, 12, async (id) => [id, await osvDetail(id)])));
    const judged = Object.fromEntries(await pool(allIds, 6, async (id) => [id, await judge(details[id])]));
    idLists.forEach((ids, i) => {
      for (const id of ids) {
        const v = details[id], j = judged[id];
        record({ host: h.name, kind: 'vuln', ...where[i], vuln: id, cves: j.cves, score: j.score, kev: j.kev, summary: (v.summary ?? v.details ?? '').slice(0, 200), fixed: fixedFor(v, where[i].pkg, where[i].ecosystem) });
      }
    });

    // Node runtimes not owned by a distro package (nvm, nodesource): Node's own security feed + EOL.
    for (const n of inv.node ?? []) {
      if (n.runtime !== 'node') { cov.not_scanned.push(`${n.runtime} ${n.version} at ${n.path} (used by ${n.used_by.join(', ') || 'nothing in pm2'}): no vulnerability feed wired`); continue; }
      const major = `v${semver.major(n.version)}`;
      const sched = NODE_SCHEDULE[major];
      if (!sched) errors.push(`${h.name}: no Node release schedule entry for ${major}`);
      else if (new Date(sched.end) < new Date()) record({ host: h.name, kind: 'eol', where: `runtime ${n.path}`, pkg: 'node', version: n.version, vuln: `EOL-${major}`, score: null, kev: false, cves: [], summary: `Node ${major} end-of-life since ${sched.end}; gets no security fixes. Used by: ${n.used_by.join(', ') || 'nothing in pm2'}`, fixed: [] });
      const distro = /dfsg|deb\d|module_el|el\d/.test(n.package_owner ?? '');
      if (distro) { cov.scanned.push(`node ${n.version} at ${n.path} via distro advisories (${n.package_owner})`); continue; }
      for (const v of NODE_VULNS) {
        if (!semver.satisfies(n.version, v.vulnerable) || (v.patched && semver.satisfies(n.version, v.patched))) continue;
        const cves = v.cve ?? [];
        record({ host: h.name, kind: 'vuln', where: `runtime ${n.path}`, pkg: 'node', version: n.version, vuln: cves[0] ?? v.ref, cves, score: LABEL[String(v.severity).toUpperCase()] ?? null, kev: cves.some((c) => KEV.has(c)), summary: `${v.description ?? ''} (used by: ${n.used_by.join(', ') || 'nothing in pm2'})`.slice(0, 240), fixed: v.patched ? [v.patched] : [] });
      }
      cov.scanned.push(`node ${n.version} at ${n.path} via nodejs/security-wg`);
    }

    // WordPress core, plugins, themes
    for (const site of inv.wordpress ?? []) {
      if (!site.core) { cov.not_scanned.push(`WordPress at ${site.path}: wp-cli could not read it`); continue; }
      const items = [['core', site.core, site.core], ...site.plugins.map(([s, v]) => ['plugin', s, v]), ...site.themes.map(([s, v]) => ['theme', s, v])];
      await pool(items, 6, async ([kind, slug, ver]) => {
        const feed = await wpFeed(kind, slug);
        for (const v of feed.data?.vulnerability ?? []) {
          if (kind !== 'core' && !wpAffected(ver, v.operator ?? {})) continue;
          const cves = (v.source ?? []).map((s) => s.id).filter((x) => /^CVE-/.test(x));
          const score = v.impact?.cvss?.score != null ? Number(v.impact.cvss.score) : null;
          record({ host: h.name, kind: 'vuln', where: `wordpress ${site.url} ${kind}`, pkg: kind === 'core' ? 'wordpress' : slug, version: ver, vuln: cves[0] ?? v.uuid, cves, score, kev: !!v.impact?.ssvc?.kev || cves.some((c) => KEV.has(c)), summary: (v.name ?? '').slice(0, 200), fixed: v.operator?.max_operator === 'lt' ? [v.operator.max_version] : [] });
        }
      });
      cov.scanned.push(`WordPress ${site.url}: core ${site.core}, ${site.plugins.length} plugins, ${site.themes.length} themes`);
    }
    for (const [name, image] of inv.containers ?? []) cov.not_scanned.push(`container ${name} (${image}): image contents not scanned`);
    scannedHosts.add(h.name);
  } catch (e) {
    errors.push(`${h.name} matching: ${e.stack ?? e.message}`);
    health[`match:${h.name}`] = { fails: (health[`match:${h.name}`]?.fails ?? 0) + 1, last_error: e.message };
    continue;
  }
  health[`match:${h.name}`] = { fails: 0 };
}

// Only resolve findings on hosts whose scan fully completed this run.
for (const [k, f] of Object.entries(findings)) {
  if (f.status === 'open' && scannedHosts.has(f.host) && !seen.has(k)) Object.assign(f, { status: 'resolved', resolved_at: now });
}

const fresh = Object.values(findings).filter((f) => f.status === 'open' && f.flagged && (!f.alerted_at || f.reopened === now));
const blind = Object.entries(health).filter(([, v]) => v.fails >= BLIND_AFTER && !v.alerted).map(([k, v]) => ({ check: k, ...v }));
const BASELINE = process.argv.includes('--baseline');
if ((fresh.length || blind.length) && !BASELINE) {
  const file = path.join(STATE, 'pending', `${now.replace(/[:.]/g, '-')}.json`);
  writeJson(file, { at: now, new_findings: fresh, blind });
  execFileSync(path.join(ROOT, 'scripts/jobs'), ['run', 'security-triage'], { stdio: 'inherit' });
  for (const f of fresh) f.alerted_at = now;
  for (const b of blind) health[b.check].alerted = now;
}

if (BASELINE) for (const f of fresh) f.alerted_at = `${now} (baseline)`;
const open = Object.values(findings).filter((f) => f.status === 'open');
writeJson(path.join(STATE, 'findings.json'), findings);
writeJson(path.join(STATE, 'health.json'), health);
writeJson(path.join(STATE, 'coverage.json'), coverage);
writeJson(path.join(STATE, 'last-run.json'), { at: now, hosts_scanned: [...scannedHosts], open: open.length, open_flagged: open.filter((f) => f.flagged).length, new_flagged: fresh.length, blind: blind.map((b) => b.check), errors });
console.log(`scanned ${[...scannedHosts].join(', ')}; ${open.length} open, ${open.filter((f) => f.flagged).length} flagged, ${fresh.length} new flagged${errors.length ? `; ${errors.length} errors` : ''}`);
for (const e of errors) console.error(e);
process.exit(errors.length ? 1 : 0);
