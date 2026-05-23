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

    const pathEscapeResult = validateAll(
      { projectRoot: invariantPathEscape },
      { env: { GAN_TRUST: 'strict' }, homeDir: tmpHome },
    );
    const pathEscapePhase3Issues = pathEscapeResult.issues.filter((i) => i.code === 'PathEscape');
    expect(pathEscapePhase3Issues.length).toBeGreaterThan(0);

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
