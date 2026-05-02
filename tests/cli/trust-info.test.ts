/**
 * R5 sprint 4 — `gan trust info`.
 *
 * Spawns the built CLI bin against a fixture project with a tmp HOME
 * so the test's trust-cache reads/writes never touch the developer's
 * real `~/.claude/gan/`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

const PROJECT = stackFixturePath('trust-command-files');

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
  const d = mkdtempSync(path.join(tmpdir(), 'gan-cli-trust-info-home-'));
  tmpDirs.push(d);
  return d;
}

describe('gan trust info', () => {
  it('--help prints usage / examples / exit codes and exits 0', async () => {
    const r = await runGan(['trust', 'info', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('Examples');
    expect(r.stdout).toContain('Exit codes');
  });

  it('reports approved: no for a fresh project (empty cache)', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'info', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Approved: no');
    expect(r.stdout).toMatch(/Current hash: sha256:/);
  });

  it('--json emits sorted-key JSON with approved: false on a fresh project', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'info', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      approved: boolean;
      currentHash: string;
      summary?: { additionalChecksCount: number };
    };
    expect(parsed.approved).toBe(false);
    expect(parsed.currentHash.startsWith('sha256:')).toBe(true);
    expect(parsed.summary?.additionalChecksCount).toBe(1);
  });

  it('end-to-end: approve then info reports approved: true (JSON)', async () => {
    const home = makeTmpHome();
    const approve = await runGan(['trust', 'approve', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(approve.exitCode).toBe(0);

    const info = await runGan(['trust', 'info', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(info.exitCode).toBe(0);
    const parsed = JSON.parse(info.stdout) as {
      approved: boolean;
      currentHash: string;
      approvedHash?: string;
      approvedAt?: string;
    };
    expect(parsed.approved).toBe(true);
    expect(parsed.approvedHash).toBe(parsed.currentHash);
    expect(typeof parsed.approvedAt).toBe('string');
  });
});
