/**
 * End-to-end tests for `gan stack show` and `gan stack update`.
 *
 * `stack show` is the read surface: it must report not just the stack data but
 * its *provenance* — the source tier (e.g. `builtin`) and source path — in both
 * human and `--json` form, and the JSON must be deterministic across runs.
 *
 * `stack update` is the write surface, and the round-trip test is the contract:
 * an updated field is reflected by a subsequent `show`, the on-disk file is
 * actually rewritten, and value parsing honours the JSON-literal path (arrays,
 * quoted strings). The schema-violation test guards write atomicity — a
 * rejected update (exit 3, SchemaMismatch) must leave the file byte-identical.
 * Missing-argument cases each exit 64; an unknown stack surfaces an F2
 * resolution error (exit 2).
 *
 * Read tests use the shared read-only FIXTURE; write tests copy it per-test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

// Read-only fixture shared by the show tests; write tests copy it instead.
const FIXTURE = stackFixturePath('js-ts-minimal');

const tmpDirs: string[] = [];

afterEach(() => {
  // Drain-and-remove temp projects; errors are swallowed so teardown is inert.
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// Disposable copy of the fixture for write tests, registered for teardown.
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

    // `builtin` is the expected provenance: the unmodified fixture resolves
    // web-node from the packaged defaults, not a project-tier override.
    expect(r.stdout).toMatch(/source tier: builtin/);

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

    // Exit 2 is the resolution/not-found class (distinct from 64 usage): the
    // stack name parsed fine, it just doesn't resolve to a file.
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/MissingFile/);
  });
});

describe('gan stack update', () => {
  it('round-trips: update a stack field, show reflects the new value, the file changed on disk', async () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    // Capture the pre-edit state and confirm the field's old value is present,
    // so the post-edit assertions prove a real change rather than a no-op.
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

    // Three-way proof of the write: the new value is on disk, the file actually
    // changed (not equal to before), and a fresh `show` reflects it.
    const after = readFileSync(stackPath, 'utf8');
    expect(after).toContain('vitest run');
    expect(after).not.toBe(before);

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
    // A JSON array literal is parsed to a real array and persisted as a YAML
    // list — verified by both elements appearing in the rewritten file.
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
    // Either error code is acceptable: resolution may report the miss as a
    // MissingFile or an UnknownStack depending on how far it got, but both are
    // the same exit-2 class.
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(['MissingFile', 'UnknownStack']).toContain(parsed.code);
  });

  it('schema-violating writes leave the file unchanged', async () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    // Snapshot before the rejected write so the trailing assertion can prove the
    // file was never touched.
    const before = readFileSync(stackPath, 'utf8');

    // schemaVersion is typed as a number; the quoted "not-a-number" string is a
    // schema violation (exit 3 / SchemaMismatch).
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

    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');

    // Write atomicity: the rejected update must leave the stack file byte-for-
    // byte unchanged.
    expect(readFileSync(stackPath, 'utf8')).toBe(before);
  });
});
