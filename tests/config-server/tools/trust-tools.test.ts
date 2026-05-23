
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTrustState, trustList } from '../../../src/config-server/tools/reads.js';
import { trustApprove, trustRevoke } from '../../../src/config-server/tools/writes.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const trustCommandFiles = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'trust-command-files');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeTmpHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'r5-s4-trust-home-'));
  tmpDirs.push(d);
  return d;
}

function makeTmpProject(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'r5-s4-trust-proj-'));
  cpSync(trustCommandFiles, d, { recursive: true });
  tmpDirs.push(d);
  return d;
}

describe('trust tools — round-trip (R5 S4)', () => {
  it('trustApprove → getTrustState reports approved: true with current hash', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();

    const before = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(before.approved).toBe(false);
    expect(typeof before.currentHash).toBe('string');

    const approved = trustApprove({ projectRoot: proj }, { homeDir: home });
    expect(approved.mutated).toBe(true);
    expect(approved.record.aggregateHash).toBe(before.currentHash);

    const after = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(after.approved).toBe(true);
    expect(after.currentHash).toBe(before.currentHash);
    expect(after.approvedHash).toBe(before.currentHash);
    expect(after.approvedAt).toBe(approved.record.approvedAt);
  });

  it('mutating the overlay after approve flips approved → false (hash drift)', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();
    trustApprove({ projectRoot: proj }, { homeDir: home });
    const approved1 = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(approved1.approved).toBe(true);

    const overlay = path.join(proj, '.claude', 'gan', 'project.md');
    writeFileSync(overlay, '\n# drifted comment\n', { flag: 'a' });

    const after = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(after.approved).toBe(false);

    expect(after.currentHash).not.toBe(approved1.approvedHash);
  });

  it('trustRevoke after approve flips approved → false', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();
    trustApprove({ projectRoot: proj }, { homeDir: home });
    expect(getTrustState({ projectRoot: proj }, { homeDir: home }).approved).toBe(true);

    const revoked = trustRevoke({ projectRoot: proj }, { homeDir: home });
    expect(revoked.mutated).toBe(true);

    const after = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(after.approved).toBe(false);
  });

  it('trustRevoke on a project with no approval is a no-op (mutated: false)', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();
    const revoked = trustRevoke({ projectRoot: proj }, { homeDir: home });
    expect(revoked.mutated).toBe(false);
  });

  it('trustList returns the recorded approval after trustApprove', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();

    const before = trustList({}, { homeDir: home });
    expect(before.approvals).toEqual([]);

    trustApprove({ projectRoot: proj, note: 'sprint test' }, { homeDir: home });
    const after = trustList({}, { homeDir: home });
    expect(after.approvals.length).toBe(1);
    expect(after.approvals[0].note).toBe('sprint test');
    expect(after.approvals[0].aggregateHash.startsWith('sha256:')).toBe(true);
  });

  it('trustApprove captures approvedCommit when the project is a git tree', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'r5-s4',
      GIT_AUTHOR_EMAIL: 'r5-s4@example.invalid',
      GIT_COMMITTER_NAME: 'r5-s4',
      GIT_COMMITTER_EMAIL: 'r5-s4@example.invalid',
    } as NodeJS.ProcessEnv;
    execFileSync('git', ['init', '-q'], { cwd: proj, env: gitEnv });
    execFileSync('git', ['add', '.'], { cwd: proj, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'r5-s4 fixture'], {
      cwd: proj,
      env: gitEnv,
    });

    const result = trustApprove({ projectRoot: proj }, { homeDir: home });
    expect(result.record.approvedCommit).toBeDefined();
    expect(typeof result.record.approvedCommit).toBe('string');
    expect((result.record.approvedCommit as string).length).toBeGreaterThan(0);

    const state = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(state.approvedCommit).toBe(result.record.approvedCommit);
  });

  it('trustApprove omits approvedCommit when the project is not a git tree', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();

    const result = trustApprove({ projectRoot: proj }, { homeDir: home });
    expect(result.record.approvedCommit).toBeUndefined();

    const state = getTrustState({ projectRoot: proj }, { homeDir: home });
    expect(state.approved).toBe(true);
    expect(state.approvedCommit).toBeUndefined();
  });

  it('end-to-end: approve then validateAll returns NO UntrustedOverlay issue', () => {
    const proj = makeTmpProject();
    const home = makeTmpHome();

    const beforeReport = validateAll(
      { projectRoot: proj },
      { env: { GAN_TRUST: 'strict' }, homeDir: home },
    );
    const beforeTrust = beforeReport.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(beforeTrust.length).toBe(1);

    trustApprove({ projectRoot: proj }, { homeDir: home });

    const afterReport = validateAll(
      { projectRoot: proj },
      { env: { GAN_TRUST: 'strict' }, homeDir: home },
    );
    const afterTrust = afterReport.issues.filter((i) => i.code === 'UntrustedOverlay');
    expect(afterTrust).toEqual([]);
  });
});
