/**
 * End-to-end tests for `gan trust revoke`.
 *
 * Revoking removes a project's approval from the trust cache. The key contract
 * is the no-op-vs-real distinction: revoking when nothing was approved is a
 * benign no-op ("No approvals to revoke" / `mutated: false`), while revoking an
 * existing approval reports success / `mutated: true`. The end-to-end
 * approve→revoke→info path confirms the approval is actually gone afterwards
 * (`approved: false`). A missing `--project-root` is a usage error (exit 64).
 *
 * Isolation: each test runs against a throwaway HOME so its revoke only affects
 * its own cache, never the developer's real ~/.claude.
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

// Isolated HOME per test; registered for teardown.
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
    // First revoke with nothing approved: mutated must be false (no-op), yet
    // still exit 0 — revoking an unapproved project is not an error.
    const noopJson = await runGan(['trust', 'revoke', '--project-root', PROJECT, '--json'], {
      extraEnv: { HOME: home },
    });
    expect(noopJson.exitCode).toBe(0);
    const noopParsed = JSON.parse(noopJson.stdout) as { mutated: boolean };
    expect(noopParsed.mutated).toBe(false);

    // Now approve, then revoke again against the same HOME: this time something
    // is actually removed, so mutated flips to true.
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
