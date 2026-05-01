/**
 * R2 sprint 1 — prerequisite-check tests.
 *
 * Builds a stub bin directory per case to control which prerequisite tools
 * resolve and what versions they report. The PATH passed to install.sh is
 * `<stubBin>:/usr/bin:/bin` so basic shell utilities (uname, cat, command)
 * remain available while node/git/claude are exclusively the test stubs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnInstaller } from './_spawn.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

interface Stubs {
  node?: string | null;
  git?: string | null;
  claude?: string | null;
}

// Standard utilities install.sh shells out to. We symlink these into the stub
// bin so the spawned shell can resolve them without exposing the system's
// node / git / claude (we only want test-controlled versions of those).
const SYSTEM_UTILITIES = [
  '/bin/cat',
  '/bin/ls',
  '/usr/bin/uname',
  '/usr/bin/dirname',
  '/usr/bin/printf',
  '/usr/bin/env',
];

function makeStubBin(stubs: Stubs): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-installer-prereq-'));
  tmpDirs.push(dir);

  for (const src of SYSTEM_UTILITIES) {
    const name = path.basename(src);
    try {
      symlinkSync(src, path.join(dir, name));
    } catch {
      // utility may not exist on this platform; install.sh tolerates absence
      // for any utility it does not actually call.
    }
  }

  if (stubs.node !== null && stubs.node !== undefined) {
    const script = `#!/bin/bash\nif [ "$1" = "--version" ]; then\n  echo "${stubs.node}"\nfi\n`;
    const p = path.join(dir, 'node');
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  if (stubs.git !== null && stubs.git !== undefined) {
    const script = `#!/bin/bash\nif [ "$1" = "rev-parse" ]; then\n  echo "${stubs.git}"\nfi\n`;
    const p = path.join(dir, 'git');
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  if (stubs.claude !== null && stubs.claude !== undefined) {
    const script = `#!/bin/bash\necho "claude stub"\n`;
    const p = path.join(dir, 'claude');
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  return dir;
}

function pathFor(stubBin: string): string {
  return stubBin;
}

describe('install.sh prerequisite checks', () => {
  it('F-AC4: rejects Node 20.9.0 with a stderr error naming Node and 20.10', async () => {
    const stubBin = makeStubBin({ node: 'v20.9.0', git: 'main', claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Node');
    expect(result.stderr).toContain('20.10');
  });

  it('F-AC8: rejects Node 23.0.0 with a stderr error naming Node and 20.10', async () => {
    const stubBin = makeStubBin({ node: 'v23.0.0', git: 'main', claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Node');
    expect(result.stderr).toContain('20.10');
  });

  it('F-AC5: rejects when git is missing with a stderr error naming git', async () => {
    const stubBin = makeStubBin({ node: 'v20.10.0', git: null, claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('git');
  });

  it('F-AC6: rejects when claude is missing with a stderr error naming Claude Code', async () => {
    const stubBin = makeStubBin({ node: 'v20.10.0', git: 'main', claude: null });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Claude Code');
  });

  it('F-AC7: --no-claude-code skips the Claude Code prerequisite', async () => {
    const stubBin = makeStubBin({ node: 'v20.10.0', git: 'main', claude: null });
    const result = await spawnInstaller({
      args: ['--no-claude-code'],
      pathOverride: pathFor(stubBin),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('Claude Code');
  });

  it('Node 20.10.0 passes the prerequisite check', async () => {
    const stubBin = makeStubBin({ node: 'v20.10.0', git: 'main', claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).toBe(0);
  });

  it('Node 22.x (Node 22 LTS) passes the prerequisite check', async () => {
    const stubBin = makeStubBin({ node: 'v22.4.1', git: 'main', claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    expect(result.exitCode).toBe(0);
  });

  it('platform-aware install hint is emitted on Node version failure', async () => {
    const stubBin = makeStubBin({ node: 'v20.9.0', git: 'main', claude: 'ok' });
    const result = await spawnInstaller({ pathOverride: pathFor(stubBin) });
    const stderr = result.stderr;
    const hasHint = /brew\b/.test(stderr) || /nodejs\.org/.test(stderr);
    expect(hasHint).toBe(true);
  });
});
