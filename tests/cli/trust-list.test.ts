/**
 * End-to-end tests for `gan trust list`.
 *
 * `trust list` enumerates every approved project from the trust cache. These
 * tests verify the empty-cache surface ("No trust approvals found." / an empty
 * `approvals` array), that an approval made via `trust approve` then appears in
 * the listing with its hash and timestamp, that the human surface renders each
 * entry's projectRoot/hash/approved-at, and that the `--json` form is
 * byte-deterministic across runs.
 *
 * Isolation: each test uses a throwaway HOME so the cache it lists is its own,
 * independent of other tests and of the developer's real ~/.claude.
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

// Isolated HOME per test so the listed trust cache starts empty.
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
    // `/m` (multiline) so `^- ` matches a bullet at the start of any line, not
    // only the first — the listing renders one bulleted entry per approval.
    expect(r.stdout).toMatch(/^- /m);
    expect(r.stdout).toMatch(/hash:\s+sha256:/);
    expect(r.stdout).toMatch(/approved at:/);
  });
});
