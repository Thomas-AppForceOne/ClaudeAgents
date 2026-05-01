/**
 * R2 sprint 1 — feature-branch warning tests.
 *
 * Stubs `git rev-parse --abbrev-ref HEAD` via a path-front-loaded git stub to
 * exercise both the warning-emitting branch and a benign branch. Real git is
 * not consulted because the stub appears earlier on PATH.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnInstaller } from './_spawn.js';

const tmpDirs: string[] = [];

const SYSTEM_UTILITIES = [
  '/bin/cat',
  '/bin/ls',
  '/usr/bin/uname',
  '/usr/bin/dirname',
  '/usr/bin/printf',
  '/usr/bin/env',
];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

interface BranchStubOptions {
  branch: string;
  nodeVersion?: string;
  withClaude?: boolean;
}

function makeBranchStub(opts: BranchStubOptions): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-installer-branch-'));
  tmpDirs.push(dir);

  for (const src of SYSTEM_UTILITIES) {
    const name = path.basename(src);
    try {
      symlinkSync(src, path.join(dir, name));
    } catch {
      // utility may not exist on this platform
    }
  }

  const node = `#!/bin/bash\nif [ "$1" = "--version" ]; then\n  echo "${opts.nodeVersion ?? 'v20.10.0'}"\nfi\n`;
  const nodePath = path.join(dir, 'node');
  writeFileSync(nodePath, node);
  chmodSync(nodePath, 0o755);

  const git = `#!/bin/bash\nif [ "$1" = "rev-parse" ]; then\n  echo "${opts.branch}"\nfi\n`;
  const gitPath = path.join(dir, 'git');
  writeFileSync(gitPath, git);
  chmodSync(gitPath, 0o755);

  if (opts.withClaude !== false) {
    const claude = `#!/bin/bash\necho "claude stub"\n`;
    const claudePath = path.join(dir, 'claude');
    writeFileSync(claudePath, claude);
    chmodSync(claudePath, 0o755);
  }

  return dir;
}

describe('install.sh feature-branch warning', () => {
  it('warns when the current branch is feature/stack-plugin-rfc', async () => {
    const stubBin = makeBranchStub({ branch: 'feature/stack-plugin-rfc' });
    const result = await spawnInstaller({
      pathOverride: stubBin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('feature/stack-plugin-rfc');
    const phrase = /non-functional|mid-pivot/i;
    expect(result.stderr).toMatch(phrase);
  });

  it('does not warn when the current branch is main', async () => {
    const stubBin = makeBranchStub({ branch: 'main' });
    const result = await spawnInstaller({
      pathOverride: stubBin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('feature/stack-plugin-rfc');
    expect(result.stderr).not.toMatch(/non-functional|mid-pivot/i);
  });
});
