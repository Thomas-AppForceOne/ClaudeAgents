/**
 * Security test: no Sprint-2 rendering surface echoes a per-stack command
 * override VALUE into its output.
 *
 * The overlay-warn-per-stack-secret fixture declares a `web-node.buildCmd`
 * whose value embeds a recognisable secret-like token. The PerStackOverrideUn-
 * supported warning carried on the snapshot names only the stack and the field
 * set — never the value — and every rendering surface reads only that
 * value-safe warning data. This test confirms the token appears in NONE of the
 * rendered surfaces' stdout/stderr: `gan stacks list` (human + --json) and
 * `gan config print` (human + --json). The startup-log surface is orchestrator
 * prose in SKILL.md (no executable code here); it renders the same value-safe
 * warning fields, so the two CLI commands are the executable surfaces under
 * test. A single leaked value would be a real secrets-exposure failure, so the
 * assertion is exhaustive across every captured stream.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

// The exact secret-like token embedded in the fixture's override value. Sourced
// from tests/fixtures/stacks/overlay-warn-per-stack-secret/.claude/gan/project.md
// (web-node.buildCmd: "deploy --token=SECRET_TOKEN_abc123XYZ"). If the fixture's
// token changes, update it here too.
const SECRET_TOKEN = 'SECRET_TOKEN_abc123XYZ';

describe('rendered warnings never echo a per-stack override value', () => {
  const fixture = stackFixturePath('overlay-warn-per-stack-secret');

  it('the fixture genuinely carries the secret-bearing override (guard)', async () => {
    // Prove the warning is actually present (so a false negative cannot come
    // from the warning simply not firing), and prove the value is absent from
    // the warning data the surfaces read.
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      warnings: { code: string; message: string; details: unknown }[];
    };
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe('PerStackOverrideUnsupported');
    // The value never reaches the warning's message or details.
    expect(parsed.warnings[0].message).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(parsed.warnings[0].details)).not.toContain(SECRET_TOKEN);
  });

  it('stacks list (human) does not echo the override value', async () => {
    const r = await runGan(['stacks', 'list', '--project-root', fixture]);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    expect(r.stderr).not.toContain(SECRET_TOKEN);
  });

  it('stacks list (--json) does not echo the override value', async () => {
    const r = await runGan(['stacks', 'list', '--project-root', fixture, '--json']);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    expect(r.stderr).not.toContain(SECRET_TOKEN);
  });

  it('config print (human) does not echo the override value', async () => {
    const r = await runGan(['config', 'print', '--project-root', fixture]);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    expect(r.stderr).not.toContain(SECRET_TOKEN);
  });

  it('config print (--json) does not echo the override value', async () => {
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.stdout).not.toContain(SECRET_TOKEN);
    expect(r.stderr).not.toContain(SECRET_TOKEN);
  });
});
