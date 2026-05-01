/**
 * R3 sprint 2 — `gan stacks list`.
 *
 * Covers contract criterion F-AC5: the CLI's view of the active set
 * agrees with R1's `getActiveStacks()` library call. Verified against
 * two fixtures:
 *   - `js-ts-minimal/` — empty active set (no `package.json` at root,
 *     no `stack.override`).
 *   - `polyglot-webnode-synthetic/` — both `web-node` and
 *     `synthetic-second` activate (multi-stack guard rail).
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import { getActiveStacks } from '../../src/index.js';

describe('gan stacks list', () => {
  it('F-AC5: human surface lists active stack names one per line', async () => {
    const fixture = stackFixturePath('polyglot-webnode-synthetic');
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trim().split('\n');
    // Multi-stack fixture: both stacks must be present.
    expect(lines).toContain('web-node');
    expect(lines).toContain('synthetic-second');
  });

  it('F-AC5: --json emits the verbatim getActiveStacks response (sorted-key JSON)', async () => {
    const fixture = stackFixturePath('polyglot-webnode-synthetic');
    const r = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { active: string[] };
    expect(Array.isArray(parsed.active)).toBe(true);
    expect(parsed.active).toContain('web-node');
    expect(parsed.active).toContain('synthetic-second');
  });

  it('F-AC5: CLI active set matches R1.getActiveStacks() programmatically (polyglot)', async () => {
    const fixture = stackFixturePath('polyglot-webnode-synthetic');
    const lib = getActiveStacks({ projectRoot: fixture });
    const cli = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    const parsed = JSON.parse(cli.stdout) as { active: string[] };
    // Library and CLI agree byte-for-byte on the active list.
    expect(parsed.active).toEqual(lib.active);
  });

  it('F-AC5: empty active set renders "(none)" in human form', async () => {
    const fixture = stackFixturePath('js-ts-minimal');
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('(none)');
  });

  it('F-AC5: empty active set under --json is `{"active":[]}`', async () => {
    const fixture = stackFixturePath('js-ts-minimal');
    const r = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { active: string[] };
    expect(parsed.active).toEqual([]);
  });
});
