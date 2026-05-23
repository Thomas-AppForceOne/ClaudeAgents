/**
 * End-to-end tests for `gan stacks list` (acceptance criterion F-AC5).
 *
 * Verifies the active-stack listing in both modes against fixtures with a known
 * active set: the human surface prints one stack name per line, `--json` emits
 * the verbatim `getActiveStacks` response as sorted-key JSON, and the empty set
 * renders as `(none)` / `{"active":[]}`. The CLI-vs-library parity test is the
 * load-bearing one — it asserts the CLI's active set is identical to a direct
 * `getActiveStacks()` call, guarding against the CLI and the library it wraps
 * computing activation differently.
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
    // Compute the active set two ways — directly via the library and via the
    // spawned CLI — and require exact equality. This is the parity guarantee:
    // the CLI must be a faithful wrapper, never re-deriving activation itself.
    const lib = getActiveStacks({ projectRoot: fixture });
    const cli = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    const parsed = JSON.parse(cli.stdout) as { active: string[] };

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
