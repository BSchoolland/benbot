// node --test security/test/  — matching decisions on representative affected, fixed and cross-stream cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { osvDecision, wpScore } from '../match.mjs';

const dpkgLess = (a, b) => { try { execFileSync('dpkg', ['--compare-versions', a, 'lt', b]); return true; } catch (e) { if (e.status === 1) return false; throw e; } };
const alma = (o) => osvDecision({ ecosystem: 'AlmaLinux:8', dpkgLess, ...o });
const deb = (o) => osvDecision({ ecosystem: 'Debian:12', dpkgLess, moduleStreams: undefined, ...o });

test('Alma, plain package, affected: kept with its fix', () => {
  const d = alma({ installed: '1.0.6-3.el8', fixed: ['1.0.6-5.el8_10'], osv: { summary: 'Important: brotli security update' }, moduleStreams: ['php:7.2'] });
  assert.deepEqual(d.fixed, ['1.0.6-5.el8_10']);
});
test('Alma, installed build equals a listed fixed build: not a finding (libzip ALSA-2019:3735)', () => {
  assert.equal(alma({ installed: '1.5.1-2.module_el8.3.0+2010+7c76a223', fixed: ['1.5.1-2.module_el8.3.0+2010+7c76a223', '1.5.1-2.module_el8.4.0+2228+7c76a223'], osv: { summary: 'Critical: php:7.2 security update' }, moduleStreams: ['php:7.2'] }), null);
});
test('Alma, non-modular install vs modular-only fix: not a finding (perl 5.26 vs perl:5.32)', () => {
  assert.equal(alma({ installed: '0.32-395.el8', fixed: ['1:0.32-481.module_el8.6.0+2912+a0b8d8f6'], osv: { summary: 'Moderate: perl:5.32 security update' }, moduleStreams: ['perl:5.26'] }), null);
});
test('Alma, fix only in a stream the host does not run: kept, unfixed for this host (redis:6 vs redis:5)', () => {
  const d = alma({ installed: '5.0.3-5.module_el8.4.0+2583+b9845322', fixed: ['6.2.20-1.module_el8.10.0+4056+739731b0'], osv: { summary: 'Important: redis:6 security update' }, moduleStreams: ['redis:5', 'php:7.2'] });
  assert.deepEqual(d.fixed, []);
  assert.match(d.summary, /^\[fix only in redis:6; host runs redis:5\]/);
});
test('Alma, fix in the stream the host runs: kept with its fix', () => {
  const d = alma({ installed: '1.5.1-1.module_el8.3.0+2010+7c76a223', fixed: ['1.5.1-2.module_el8.10.0+4000+aaaaaaaa'], osv: { summary: 'Important: php:7.2 security update' }, moduleStreams: ['php:7.2'] });
  assert.deepEqual(d.fixed, ['1.5.1-2.module_el8.10.0+4000+aaaaaaaa']);
});
test('Alma, module streams unknown (collector failed): keep the fix rather than guess unfixed', () => {
  const d = alma({ installed: '5.0.3-5.module_el8.4.0+2583+b9845322', fixed: ['6.2.20-1.module_el8.10.0+4056+739731b0'], osv: { summary: 'Important: redis:6 security update' }, moduleStreams: undefined });
  assert.deepEqual(d.fixed, ['6.2.20-1.module_el8.10.0+4056+739731b0']);
});
test('Debian unfixed, tracker postponed: kept unfixed, annotated', () => {
  const d = deb({ installed: '7.88.1-10+deb12u15', fixed: [], osv: { summary: 'curl UAF' }, debianEntry: ['open', 'not yet assigned', 'postponed', null] });
  assert.deepEqual(d.fixed, []);
  assert.deepEqual(d.debian, { status: 'open', urgency: 'not yet assigned', nodsa: 'postponed' });
});
test('Debian: tracker resolved with a newer version OSV missed: becomes an installable fix', () => {
  const d = deb({ installed: '2.4.68-1~deb12u1', fixed: [], osv: { summary: 'apache2' }, debianEntry: ['resolved', 'high', null, '2.4.68-1~deb12u2'] });
  assert.deepEqual(d.fixed, ['2.4.68-1~deb12u2']);
});
test('Debian: tracker resolved at or below the installed version: no false installable fix', () => {
  const d = deb({ installed: '2.4.68-1~deb12u2', fixed: [], osv: { summary: 'apache2' }, debianEntry: ['resolved', 'high', null, '2.4.68-1~deb12u2'] });
  assert.deepEqual(d.fixed, []);
});
test('Debian: tracker resolved with fixed_version 0 (never affected): stays unfixed', () => {
  assert.deepEqual(deb({ installed: '1.0-1', fixed: [], osv: {}, debianEntry: ['resolved', 'unimportant', null, '0'] }).fixed, []);
});
test('npm: passes through untouched', () => {
  const d = osvDecision({ installed: '14.2.35', ecosystem: 'npm', fixed: ['15.5.28'], osv: { summary: 'Next.js RCE' }, dpkgLess });
  assert.deepEqual(d.fixed, ['15.5.28']);
});

const src = (description) => [{ id: 'CVE-X', description }];
test('WP: unscored unauthenticated SQL injection (slicewp CVE-2026-120043) estimates 9', () => {
  assert.deepEqual(wpScore({ name: 'SliceWP < 1.2.15', impact: [], source: src('is vulnerable to generic SQL Injection via the email parameter ... This makes it possible for unauthenticated attackers to append additional SQL queries') }), { score: 9, estimated: true });
});
test('WP: unscored unauthenticated session-cookie theft (greenshift CVE-2026-120520) estimates 9', () => {
  assert.equal(wpScore({ name: 'Greenshift', source: src('makes it possible for unauthenticated attackers to extract authenticated users\' HttpOnly WordPress session cookies') }).score, 9);
});
test('WP: admin-only SQL injection (rank-math CVE-2026-104753) stays unscored', () => {
  assert.deepEqual(wpScore({ name: 'Rank Math', source: src('allowing high-privilege users such as administrators to perform SQL injection attacks') }), { score: null, estimated: false });
});
test('WP: unauthenticated but minor (data deletion of SEO analysis) stays unscored', () => {
  assert.equal(wpScore({ name: 'Rank Math', source: src('does not perform a capability or nonce check before clearing its stored SEO analysis data, allowing unauthenticated users to delete it.') }).score, null);
});
test('WP: a real CVSS always wins over the estimate', () => {
  assert.deepEqual(wpScore({ name: 'x', impact: { cvss: { score: '6.1' } }, source: src('unauthenticated SQL injection') }), { score: 6.1, estimated: false });
});

import { bunAffected } from '../match.mjs';
test('Bun ranges: boundaries of ">= 1.3.14, < 1.4.4"', () => {
  assert.equal(bunAffected('1.3.10', '>= 1.3.14, < 1.4.4'), false);
  assert.equal(bunAffected('1.3.14', '>= 1.3.14, < 1.4.4'), true);
  assert.equal(bunAffected('1.4.3', '>= 1.3.14, < 1.4.4'), true);
  assert.equal(bunAffected('1.4.4', '>= 1.3.14, < 1.4.4'), false);
  assert.equal(bunAffected('1.3.10', '< 1.4.4'), true);
});
test('Bun ranges: garbage throws instead of silently not matching', () => {
  assert.throws(() => bunAffected('1.3.10', 'all versions'), /unparseable/);
});

import { collectorHealth } from '../match.mjs';
test('collector step failures count up per step and go blind at 3; recovery resets', () => {
  const h = {};
  for (let i = 0; i < 3; i++) collectorHealth(h, 'ps', ['listeners: ss -Hltnp -> 1: boom', 'rpm packages: dnf -> 1'], `t${i}`);
  assert.equal(h['collect:ps:listeners'].fails, 3);
  assert.equal(h['collect:ps:listeners'].since, 't0');
  assert.equal(h['collect:ps:rpm packages'].fails, 3);
  collectorHealth(h, 'ps', ['rpm packages: dnf -> 1'], 't3');
  assert.deepEqual(h['collect:ps:listeners'], { fails: 0 });
  assert.equal(h['collect:ps:rpm packages'].fails, 4);
  collectorHealth(h, 'other', [], 't4');
  assert.equal(h['collect:ps:rpm packages'].fails, 4, 'another host never resets this one');
});

import { foreignToOsv } from '../match.mjs';
test('third-party apt: caddy maps to its Go module with the upstream version', () => {
  assert.deepEqual(foreignToOsv('caddy 2.11.4 (any-version)'), { ecosystem: 'Go', name: 'github.com/caddyserver/caddy/v2', pkg: 'caddy', version: '2.11.4' });
  assert.equal(foreignToOsv('caddy 2.11.9-1 (any-version)').version, '2.11.9');
});
test('third-party apt: unmapped package stays unscanned; garbage throws', () => {
  assert.equal(foreignToOsv('nodejs 22.23.4-1nodesource1 (nodistro)'), null);
  assert.throws(() => foreignToOsv('weird'), /unparseable/);
});
