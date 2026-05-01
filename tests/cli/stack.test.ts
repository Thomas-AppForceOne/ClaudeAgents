/**
 * R3 sprint 2 — `gan stack show <name>`.
 *
 * Verifies that the CLI surfaces R1's `getStack()` shape including tier
 * provenance (`sourceTier` / `sourcePath`) on both the human and the
 * `--json` paths.
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

const FIXTURE = stackFixturePath('js-ts-minimal');

describe('gan stack show', () => {
  it('human surface includes tier provenance and stack data', async () => {
    const r = await runGan(['stack', 'show', 'web-node', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('source tier:');
    expect(r.stdout).toContain('source path:');
    expect(r.stdout).toContain('data:');
    // The fixture's web-node ships under the built-in tier.
    expect(r.stdout).toMatch(/source tier: builtin/);
    // The data block shows core fields from the stack file.
    expect(r.stdout).toContain('"name": "web-node"');
    expect(r.stdout).toContain('"schemaVersion": 1');
  });

  it('--json emits the full response verbatim with tier provenance', async () => {
    const r = await runGan(['stack', 'show', 'web-node', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as {
      data: { name: string; schemaVersion: number };
      prose: { before: string; after: string };
      sourceTier: string;
      sourcePath: string;
    };
    expect(parsed.sourceTier).toBe('builtin');
    expect(parsed.sourcePath).toContain('web-node.md');
    expect(parsed.data.name).toBe('web-node');
    expect(parsed.data.schemaVersion).toBe(1);
    expect(typeof parsed.prose.before).toBe('string');
    expect(typeof parsed.prose.after).toBe('string');
  });

  it('--json output is byte-identical across runs (determinism)', async () => {
    const a = await runGan(['stack', 'show', 'web-node', '--project-root', FIXTURE, '--json']);
    const b = await runGan(['stack', 'show', 'web-node', '--project-root', FIXTURE, '--json']);
    expect(a.stdout).toBe(b.stdout);
  });

  it('missing name argument exits 64', async () => {
    const r = await runGan(['stack', 'show', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/stack name/);
  });

  it('unknown stack surfaces the F2 MissingFile error (exit 2)', async () => {
    const r = await runGan([
      'stack',
      'show',
      'definitely-not-a-real-stack',
      '--project-root',
      FIXTURE,
    ]);
    // MissingFile maps to exit 2 (validation failure) per the locked
    // exit-code table.
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/MissingFile/);
  });
});
