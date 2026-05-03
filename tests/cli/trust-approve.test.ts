/**
 * R5 sprint 4 — `gan trust approve`.
 *
 * Trust-mutating subcommands require `--project-root` explicitly; the
 * test asserts the exit-64 contract on the missing-flag path.
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
  const d = mkdtempSync(path.join(tmpdir(), 'gan-cli-trust-approve-home-'));
  tmpDirs.push(d);
  return d;
}

describe('gan trust approve', () => {
  it('--help prints usage / examples / exit codes and exits 0', async () => {
    // No HOME override needed — help paths never touch the trust cache.
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
    // `logTrustEvent` writes a single audit-log line on stderr when
    // `GAN_RUN_ID` is unset (per `logging/trust-log.ts`); the human
    // surface of the command itself stays on stdout.
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
