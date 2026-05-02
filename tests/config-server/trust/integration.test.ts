import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTrustCheck } from '../../../src/config-server/trust/integration.js';
import {
  _runPhase1ForTests,
  type ValidationSnapshot,
} from '../../../src/config-server/tools/validate.js';
import { computeTrustHash } from '../../../src/config-server/trust/hash.js';
import {
  upsertApproval,
  writeCache,
  type TrustCache,
} from '../../../src/config-server/trust/cache-io.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const jsTsMinimal = path.join(fixturesRoot, 'js-ts-minimal');
const trustCommandFiles = path.join(fixturesRoot, 'trust-command-files');

/**
 * Build a discovery-only snapshot for a fixture so tests can feed
 * `runTrustCheck` without relying on validateAll's full pipeline (which
 * itself calls runTrustCheck).
 */
function snapshotFor(fixtureRoot: string): ValidationSnapshot {
  return _runPhase1ForTests(fixtureRoot);
}

describe('trust/integration — runTrustCheck', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'r5-trust-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('(a) returns "skipped" when project overlay declares no commands', () => {
    const snapshot = snapshotFor(jsTsMinimal);
    const result = runTrustCheck({
      projectRoot: jsTsMinimal,
      snapshot,
      env: {},
      homeDir: tmpHome,
    });
    expect(result.status).toBe('skipped');
    expect(result.issues).toEqual([]);
    expect(result.currentHash).toBeUndefined();
    expect(result.trustMode).toBe('unset');
  });

  it('(b) returns "bypassed" when GAN_TRUST=unsafe-trust-all without computing hash', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'unsafe-trust-all' },
      homeDir: tmpHome,
    });
    expect(result.status).toBe('bypassed');
    expect(result.issues).toEqual([]);
    expect(result.currentHash).toBeUndefined();
    expect(result.trustMode).toBe('unsafe-trust-all');
  });

  it('(c) returns "approved" with currentHash when cache contains a matching entry', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const { aggregateHash } = computeTrustHash(trustCommandFiles);

    let cache: TrustCache = { schemaVersion: 1, approvals: [] };
    cache = upsertApproval(cache, {
      projectRoot: canonicalizePath(trustCommandFiles),
      aggregateHash,
      approvedAt: '2026-05-01T00:00:00.000Z',
    });
    writeCache(tmpHome, cache);

    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'strict' },
      homeDir: tmpHome,
    });
    expect(result.status).toBe('approved');
    expect(result.issues).toEqual([]);
    expect(result.currentHash).toBe(aggregateHash);
    expect(result.trustMode).toBe('strict');
  });

  it('(d) returns "unapproved" with one UntrustedOverlay issue when no cache entry matches', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'strict' },
      homeDir: tmpHome,
    });
    expect(result.status).toBe('unapproved');
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].code).toBe('UntrustedOverlay');
    expect(result.issues[0].severity).toBe('error');
    expect(result.currentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('(e) UntrustedOverlay message includes the current hash and a `gan trust approve` remediation', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const { aggregateHash } = computeTrustHash(trustCommandFiles);
    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'strict' },
      homeDir: tmpHome,
    });
    expect(result.issues[0].message).toContain(aggregateHash);
    expect(result.issues[0].message).toContain('gan trust approve');
    expect(result.issues[0].message).toContain('--project-root=');
  });

  it('(f) treats GAN_TRUST="" identically to unset (still enforces)', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: '' },
      homeDir: tmpHome,
    });
    expect(result.trustMode).toBe('unset');
    expect(result.status).toBe('unapproved');
  });

  it('(g) treats unknown GAN_TRUST values as strict (safe fallback)', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'allow-everything-please' },
      homeDir: tmpHome,
    });
    expect(result.trustMode).toBe('strict');
    expect(result.status).toBe('unapproved');
  });

  it('(h) converts TrustCacheCorrupt into a single Issue (does not propagate)', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    // Plant a malformed cache file. We use the same disk path the
    // cache module reads from; permissions must be 0600 so the corrupt
    // check fires on JSON parse rather than on mode.
    const cacheDir = path.join(tmpHome, '.claude', 'gan');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'trust-cache.json');
    writeFileSync(cachePath, '{not valid json', 'utf8');
    chmodSync(cachePath, 0o600);

    const result = runTrustCheck({
      projectRoot: trustCommandFiles,
      snapshot,
      env: { GAN_TRUST: 'strict' },
      homeDir: tmpHome,
    });
    expect(result.status).toBe('unapproved');
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].code).toBe('TrustCacheCorrupt');
    expect(result.currentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
