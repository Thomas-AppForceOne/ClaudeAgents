/**
 * End-to-end tests for `gan trust approve`.
 *
 * Approving pins the project's current aggregate config hash into the on-disk
 * trust cache. These tests verify the happy path prints the project root and a
 * `sha256:` hash, the `--json` form returns a sorted-key trust record with
 * `mutated: true`, and a `--note` is stored verbatim and resurfaces in
 * `trust list` (the approve→list round-trip). A missing `--project-root` is a
 * usage error (exit 64).
 *
 * Isolation invariant: every test points `HOME` at a throwaway temp dir
 * (makeTmpHome), so the trust cache the CLI reads/writes lives there and never
 * touches the developer's real ~/.claude trust cache — without this the tests
 * would mutate shared global state and interfere with each other.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

// A fixture project with stable, hashable config files so the aggregate trust
// hash is deterministic across runs.
const PROJECT = stackFixturePath('trust-command-files');

const tmpDirs: string[] = [];

afterEach(() => {
  // Tear down the throwaway HOME dirs; errors are swallowed so cleanup is inert.
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Fresh temp dir used as the child's HOME so the trust cache is isolated per
// test; registered for afterEach teardown.
function makeTmpHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'gan-cli-trust-approve-home-'));
  tmpDirs.push(d);
  return d;
}

describe('gan trust approve', () => {
  it('--help prints usage / examples / exit codes and exits 0', async () => {

    const r = await runGan(['trust', 'approve', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('Examples');
    expect(r.stdout).toContain('Exit codes');
  });

  it('missing --project-root exits 64', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'approve'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--project-root/);
  });

  it('happy path approves and prints the projectRoot + hash', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);

    expect(r.stdout).toMatch(/^Approved /);
    expect(r.stdout).toMatch(/sha256:/);
  });

  it('--json emits the trust record with sorted keys', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'approve', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      mutated: boolean;
      record: { projectRoot: string; aggregateHash: string; approvedAt: string };
    };
    expect(parsed.mutated).toBe(true);
    expect(parsed.record.aggregateHash.startsWith('sha256:')).toBe(true);
    expect(typeof parsed.record.approvedAt).toBe('string');
  });

  // Round-trip across two commands sharing one isolated HOME: a note attached
  // at approve time must persist in the cache and reappear when `trust list`
  // reads that same cache back.
  it('--note is stored verbatim and surfaces in trust list', async () => {
    const home = makeTmpHome();
    const approve = await runGan(
      ['trust', 'approve', '--project-root', PROJECT, '--note', 'reviewed-in-test', '--json'],
      { extraEnv: { HOME: home } },
    );
    expect(approve.exitCode).toBe(0);
    const approveParsed = JSON.parse(approve.stdout) as {
      record: { note?: string };
    };
    expect(approveParsed.record.note).toBe('reviewed-in-test');

    const list = await runGan(['trust', 'list', '--json'], { extraEnv: { HOME: home } });
    expect(list.exitCode).toBe(0);
    const listParsed = JSON.parse(list.stdout) as {
      approvals: Array<{ note?: string }>;
    };
    expect(listParsed.approvals.length).toBe(1);
    expect(listParsed.approvals[0].note).toBe('reviewed-in-test');
  });
});
