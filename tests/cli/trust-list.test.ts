/**
 * R5 sprint 4 — `gan trust list`.
 *
 * Verifies the empty-cache human surface, the JSON shape, and the
 * approve-then-list end-to-end.
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
  const d = mkdtempSync(path.join(tmpdir(), 'gan-cli-trust-list-home-'));
  tmpDirs.push(d);
  return d;
}

describe('gan trust list', () => {
  it('--help prints usage / examples / exit codes and exits 0', async () => {
    const r = await runGan(['trust', 'list', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('Examples');
    expect(r.stdout).toContain('Exit codes');
  });

  it('prints "No trust approvals found." for an empty cache (human mode)', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'list'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('No trust approvals found.\n');
  });

  it('--json emits {approvals: []} for an empty cache', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'list', '--json'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { approvals: unknown[] };
    expect(parsed.approvals).toEqual([]);
  });

  it('lists every approved project after trust approve', async () => {
    const home = makeTmpHome();
    await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    const r = await runGan(['trust', 'list', '--json'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      approvals: Array<{ projectRoot: string; aggregateHash: string; approvedAt: string }>;
    };
    expect(parsed.approvals.length).toBe(1);
    expect(parsed.approvals[0].aggregateHash.startsWith('sha256:')).toBe(true);
    expect(typeof parsed.approvals[0].approvedAt).toBe('string');
  });

  it('--json round-trip is byte-identical across runs (determinism)', async () => {
    const home = makeTmpHome();
    await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    const a = await runGan(['trust', 'list', '--json'], { extraEnv: { HOME: home } });
    const b = await runGan(['trust', 'list', '--json'], { extraEnv: { HOME: home } });
    expect(a.stdout).toBe(b.stdout);
  });

  it('human surface lists the projectRoot, hash, and approved-at timestamp', async () => {
    const home = makeTmpHome();
    await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    const r = await runGan(['trust', 'list'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^- /m);
    expect(r.stdout).toMatch(/hash:\s+sha256:/);
    expect(r.stdout).toMatch(/approved at:/);
  });
});
