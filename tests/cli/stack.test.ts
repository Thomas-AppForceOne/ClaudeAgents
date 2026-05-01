/**
 * R3 sprint 2 — `gan stack show <name>`.
 * R3 sprint 3 — `gan stack update <name> <field> <value>`.
 *
 * Verifies that the CLI surfaces R1's `getStack()` shape including tier
 * provenance, and that the update path round-trips a value through R1's
 * `updateStackField` and is reflected by a follow-up `gan stack show`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

const FIXTURE = stackFixturePath('js-ts-minimal');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-stack-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

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

describe('gan stack update', () => {
  it('round-trips: update a stack field, show reflects the new value, the file changed on disk', async () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const before = readFileSync(stackPath, 'utf8');
    expect(before).toContain('npm run lint');

    const updateR = await runGan([
      'stack',
      'update',
      'web-node',
      'lintCmd',
      'vitest run',
      '--project-root',
      proj,
    ]);
    expect(updateR.exitCode).toBe(0);
    expect(updateR.stderr).toBe('');
    expect(updateR.stdout).toMatch(/Updated `lintCmd` on stack `web-node` to `"vitest run"`/);

    const after = readFileSync(stackPath, 'utf8');
    expect(after).toContain('vitest run');
    expect(after).not.toBe(before);

    // `gan stack show --json` reflects the new value.
    const showR = await runGan(['stack', 'show', 'web-node', '--project-root', proj, '--json']);
    expect(showR.exitCode).toBe(0);
    const parsed = JSON.parse(showR.stdout) as { data: { lintCmd: string } };
    expect(parsed.data.lintCmd).toBe('vitest run');
  });

  it('--json emits a structured write result', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'stack',
      'update',
      'web-node',
      'lintCmd',
      '"npm run lint:next"',
      '--project-root',
      proj,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      name: string;
      path: string;
      tier: string;
      value: string;
      written: boolean;
    };
    expect(parsed.name).toBe('web-node');
    expect(parsed.path).toBe('lintCmd');
    expect(parsed.tier).toBe('project');
    expect(parsed.value).toBe('npm run lint:next');
    expect(parsed.written).toBe(true);
  });

  it('parses array-shaped values via the JSON literal path', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'stack',
      'update',
      'web-node',
      'scope',
      '["**/*.ts","**/*.tsx"]',
      '--project-root',
      proj,
    ]);
    expect(r.exitCode).toBe(0);
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const after = readFileSync(stackPath, 'utf8');
    expect(after).toContain('**/*.ts');
    expect(after).toContain('**/*.tsx');
  });

  it('missing name argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stack', 'update', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/stack name/);
  });

  it('missing field argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stack', 'update', 'web-node', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/field path/);
  });

  it('missing value argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['stack', 'update', 'web-node', 'lintCmd', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/value argument/);
  });

  it('unknown stack surfaces an F2 error from R1 (exit 2)', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'stack',
      'update',
      'definitely-not-a-real-stack',
      'lintCmd',
      'whatever',
      '--project-root',
      proj,
      '--json',
    ]);
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(['MissingFile', 'UnknownStack']).toContain(parsed.code);
  });

  it('schema-violating writes leave the file unchanged', async () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const before = readFileSync(stackPath, 'utf8');

    // schemaVersion must remain `1`; setting it to a string violates the
    // stack schema. R1 returns the schema issue and persists nothing.
    const r = await runGan([
      'stack',
      'update',
      'web-node',
      'schemaVersion',
      '"not-a-number"',
      '--project-root',
      proj,
      '--json',
    ]);
    // SchemaMismatch maps to exit 3 per the locked exit-code table.
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');

    expect(readFileSync(stackPath, 'utf8')).toBe(before);
  });
});
