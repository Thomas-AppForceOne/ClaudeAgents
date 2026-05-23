// Verifies runTrustCheck — the gate that decides whether a run is allowed to
// proceed against a project's config — across the full decision matrix it must
// implement. The cases are lettered (a)–(h) to mirror the spec's enumeration,
// and together they pin the trust state machine:
//
//   (a) skipped   — overlay declares no commands ⇒ nothing dangerous to trust;
//                   the hash is not even computed.
//   (b) bypassed  — GAN_TRUST=unsafe-trust-all ⇒ explicit opt-out, no hash.
//   (c) approved  — strict mode + a cache entry matching the current hash.
//   (d) unapproved— strict mode + no matching entry ⇒ one UntrustedOverlay error.
//   (e) the error message must be actionable: it carries the current hash plus
//                   a copy-pasteable `gan trust approve --project-root=` command.
//   (f) GAN_TRUST="" is treated as unset, NOT as bypass — empty must still
//                   enforce, or an unset-but-empty env var would silently disarm
//                   the gate.
//   (g) an unknown GAN_TRUST value falls back to strict (fail-closed), never to
//                   bypass — the safe default for an unrecognised mode.
//   (h) a corrupt trust cache is converted into a single Issue and downgrades to
//                   unapproved rather than throwing, so a broken cache fails
//                   closed instead of crashing the run.
//
// `jsTsMinimal` (no commands) drives (a); `trustCommandFiles` (declares
// commands) drives the rest. Each test uses a fresh temp home for the cache.
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
    // No hash is computed when there is nothing to trust — undefined, not a
    // throwaway value.
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
    // currentHash stays undefined: bypass short-circuits BEFORE the (non-trivial)
    // hash computation, so the explicit opt-out also skips the work.
    expect(result.currentHash).toBeUndefined();
    expect(result.trustMode).toBe('unsafe-trust-all');
  });

  it('(c) returns "approved" with currentHash when cache contains a matching entry', () => {
    const snapshot = snapshotFor(trustCommandFiles);
    // Seed the cache with an approval pinned to the project's CURRENT hash, so
    // the strict-mode check finds an exact match and returns approved.
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
    // The error must be self-service: it quotes the hash being rejected and the
    // exact `gan trust approve --project-root=` command that would approve it,
    // so the user is never left guessing how to unblock the run.
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

    // Plant a corrupt cache (malformed JSON, but at the secure 0600 mode so the
    // failure is content-only). runTrustCheck must catch the resulting
    // TrustCacheCorrupt and fail CLOSED — surface it as one Issue + unapproved —
    // rather than letting the exception escape and crash the run.
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
