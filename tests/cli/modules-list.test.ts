
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

const FIXTURE = stackFixturePath('js-ts-minimal');

describe('gan modules list', () => {
  it('human surface prints the pre-M1 marker', async () => {
    const r = await runGan(['modules', 'list', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('No modules registered');
    expect(r.stdout).toContain('M1 not yet implemented');
  });

  it('--json emits an empty modules array verbatim', async () => {
    const r = await runGan(['modules', 'list', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { modules: string[] };
    expect(parsed.modules).toEqual([]);
  });

  it('--json output is byte-identical across runs (determinism)', async () => {
    const a = await runGan(['modules', 'list', '--project-root', FIXTURE, '--json']);
    const b = await runGan(['modules', 'list', '--project-root', FIXTURE, '--json']);
    expect(a.stdout).toBe(b.stdout);
  });
});
