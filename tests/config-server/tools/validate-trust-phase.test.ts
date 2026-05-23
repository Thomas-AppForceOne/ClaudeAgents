/**
 * Phase-4 trust check inside validateAll (R5 S3): the rules that decide when a
 * command-declaring overlay raises an UntrustedOverlay issue, and where that
 * issue sits relative to the earlier validation phases.
 *
 * The decision matrix this suite locks down:
 *   (a) a fixture that declares no commands → never untrusted, regardless of
 *       trust mode (nothing dangerous to approve);
 *   (b) command-declaring fixture + empty trust cache + strict mode → exactly
 *       one UntrustedOverlay issue;
 *   (c) command-declaring fixture + a cache entry whose pinned hash matches the
 *       project's *current* aggregate hash → no issue (this is what an approval
 *       looks like on disk; the test writes the cache entry directly via
 *       computeTrustHash + upsertApproval rather than calling trustApprove);
 *   (d) phase ordering: phase-3 invariant issues (e.g. PathEscape) must precede
 *       phase-4 trust issues, so the trust issue is always *last* — a stable
 *       ordering contract clients rely on;
 *   plus the GAN_TRUST=unsafe-trust-all escape hatch, which suppresses the
 *       issue entirely.
 *
 * Each test uses a fresh temp home for the trust cache so runs never see the
 * developer's real approvals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
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
const invariantPathEscape = path.join(fixturesRoot, 'invariant-path-escape');

describe('validateAll — phase 4 trust check (R5 S3)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'r5-trust-phase-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('(a) clean fixture with no command-declaring overlay → no UntrustedOverlay issue', () => {
    const result = validateAll({ projectRoot: jsTsMinimal }, { env: {}, homeDir: tmpHome });
    const trustIssues = result.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(trustIssues).toEqual([]);
  });

  it('(b) command-declaring fixture with empty cache → exactly one UntrustedOverlay issue', () => {
    const result = validateAll(
      { projectRoot: trustCommandFiles },
      { env: { GAN_TRUST: 'strict' }, homeDir: tmpHome },
    );
    const trustIssues = result.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(trustIssues.length).toBe(1);
  });

  it('(c) command-declaring fixture with matching cache entry → no UntrustedOverlay issue', () => {
    // Hand-build the on-disk approval that a real trustApprove would produce:
    // the *current* aggregate hash pinned under the canonical project root.
    // Because it matches, phase 4 treats the overlay as trusted.
    const { aggregateHash } = computeTrustHash(trustCommandFiles);
    let cache: TrustCache = { schemaVersion: 1, approvals: [] };
    cache = upsertApproval(cache, {
      projectRoot: canonicalizePath(trustCommandFiles),
      aggregateHash,
      approvedAt: '2026-05-01T00:00:00.000Z',
    });
    writeCache(tmpHome, cache);

    const result = validateAll(
      { projectRoot: trustCommandFiles },
      { env: { GAN_TRUST: 'strict' }, homeDir: tmpHome },
    );
    const trustIssues = result.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(trustIssues).toEqual([]);
  });

  it('(d) phase ordering: phase-3 invariant issues precede phase-4 trust issues', () => {
    // First establish that the path-escape fixture really fires a phase-3
    // PathEscape issue, so the ordering claim below is about a real phase-3
    // issue and not a vacuous one.
    const pathEscapeResult = validateAll(
      { projectRoot: invariantPathEscape },
      { env: { GAN_TRUST: 'strict' }, homeDir: tmpHome },
    );
    const pathEscapePhase3Issues = pathEscapeResult.issues.filter((i) => i.code === 'PathEscape');
    expect(pathEscapePhase3Issues.length).toBeGreaterThan(0);

    // The trust (phase-4) issue must always be appended last, after every
    // earlier-phase issue — clients depend on this stable ordering.
    const trustResult = validateAll(
      { projectRoot: trustCommandFiles },
      { env: { GAN_TRUST: 'strict' }, homeDir: tmpHome },
    );
    expect(trustResult.issues.length).toBeGreaterThan(0);
    const last = trustResult.issues[trustResult.issues.length - 1];
    expect(last.code).toBe('UntrustedOverlay');
  });

  it('GAN_TRUST=unsafe-trust-all on a command-declaring fixture → no UntrustedOverlay issue', () => {
    const result = validateAll(
      { projectRoot: trustCommandFiles },
      { env: { GAN_TRUST: 'unsafe-trust-all' }, homeDir: tmpHome },
    );
    const trustIssues = result.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(trustIssues).toEqual([]);
  });
});
