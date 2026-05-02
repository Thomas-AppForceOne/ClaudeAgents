/**
 * R5 sprint 4 — `gan trust revoke`.
 *
 * Verifies the explicit-`--project-root` requirement, the human-mode
 * `mutated: true` / `mutated: false` branches, and the end-to-end
 * approve-then-revoke flow against a tmp HOME.
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
  const d = mkdtempSync(path.join(tmpdir(), 'gan-cli-trust-revoke-home-'));
  tmpDirs.push(d);
  return d;
}

describe('gan trust revoke', () => {
  it('--help prints usage / examples / exit codes and exits 0', async () => {
    const r = await runGan(['trust', 'revoke', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Usage');
    expect(r.stdout).toContain('Examples');
    expect(r.stdout).toContain('Exit codes');
  });

  it('missing --project-root exits 64', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'revoke'], { extraEnv: { HOME: home } });
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--project-root/);
  });

  it('prints "No approvals to revoke" when nothing was approved', async () => {
    const home = makeTmpHome();
    const r = await runGan(['trust', 'revoke', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    // `logTrustEvent` writes a single audit-log line on stderr when
    // `GAN_RUN_ID` is unset (per `logging/trust-log.ts`); the human
    // surface of the command itself stays on stdout.
    expect(r.stdout).toMatch(/^No approvals to revoke for /);
  });

  it('end-to-end: approve, revoke, then info reports approved: false', async () => {
    const home = makeTmpHome();

    const approve = await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    expect(approve.exitCode).toBe(0);

    const revoke = await runGan(['trust', 'revoke', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    expect(revoke.exitCode).toBe(0);
    expect(revoke.stdout).toMatch(/^Revoked all approvals for /);

    const info = await runGan(['trust', 'info', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(info.exitCode).toBe(0);
    const parsed = JSON.parse(info.stdout) as { approved: boolean };
    expect(parsed.approved).toBe(false);
  });

  it('--json emits {mutated: true|false}', async () => {
    const home = makeTmpHome();
    const noopJson = await runGan(['trust', 'revoke', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(noopJson.exitCode).toBe(0);
    const noopParsed = JSON.parse(noopJson.stdout) as { mutated: boolean };
    expect(noopParsed.mutated).toBe(false);

    await runGan(['trust', 'approve', '--project-root', PROJECT], {
      extraEnv: { HOME: home },
    });
    const realJson = await runGan(['trust', 'revoke', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(realJson.exitCode).toBe(0);
    const realParsed = JSON.parse(realJson.stdout) as { mutated: boolean };
    expect(realParsed.mutated).toBe(true);
  });
});
