/**
 * R3 sprint 2 — `gan config print` and `gan config get`.
 * R3 sprint 3 — `gan config set` (writes to project / user overlays).
 *
 * Covers contract criteria F-AC3 (`config print --json | jq` round-trip),
 * the dotted-path semantics of `config get` (including the missing-key
 * exit-1 path), and F-AC4 (round-trip `set` → resolved-config read).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-config-'));
  cpSync(FIXTURE, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

describe('gan config print', () => {
  it('F-AC3: human surface lists active stacks, schema versions, issues', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/apiVersion:/);
    expect(r.stdout).toMatch(/schemaVersions:/);
    expect(r.stdout).toMatch(/active stacks:/);
    expect(r.stdout).toMatch(/issues:/);
  });

  it('F-AC3: --json emits sorted-key, two-space, trailing-newline JSON parsable as the resolved config', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout).toContain('\n  "');

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // F2 stable-shape: every read returns these top-level keys.
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('schemaVersions');
    expect(parsed).toHaveProperty('stacks');
    expect(parsed).toHaveProperty('overlay');
    expect(parsed).toHaveProperty('discarded');
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed).toHaveProperty('issues');

    // Sorted-keys property: top-level keys come out in lex order.
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('F-AC3: --json round-trips byte-identically across runs (determinism)', async () => {
    const a = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    const b = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('F-AC3: --json output parses cleanly via JSON.parse (jq-equivalent contract)', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    // Throws if the document isn't valid JSON.
    const parsed = JSON.parse(r.stdout) as { apiVersion: string };
    expect(typeof parsed.apiVersion).toBe('string');
  });
});

describe('gan config get', () => {
  it('returns the apiVersion at a known key', async () => {
    const r = await runGan(['config', 'get', 'apiVersion', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    // Human form prints strings unquoted.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns nested values via dotted paths', async () => {
    const r = await runGan(['config', 'get', 'schemaVersions.stack', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  it('--json emits the value as a JSON document (sorted, indented, trailing newline)', async () => {
    const r = await runGan([
      'config',
      'get',
      'schemaVersions',
      '--project-root',
      FIXTURE,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(r.stdout) as { stack: number; overlay: number };
    expect(parsed.stack).toBe(1);
    expect(parsed.overlay).toBe(1);
  });

  it('returns array values verbatim', async () => {
    const r = await runGan(['config', 'get', 'stacks.active', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as string[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('missing key exits 1 with stderr mentioning the path', async () => {
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/key not found/);
    expect(r.stderr).toContain('no.such.path');
  });

  it('missing key under --json emits a structured error to stdout, exit 1', async () => {
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout) as { code: string; message: string; field: string };
    expect(parsed.code).toBe('KeyNotFound');
    expect(parsed.field).toBe('no.such.path');
    expect(parsed.message).toMatch(/key not found/);
  });

  it('no path argument exits 64 with bad-args framing', async () => {
    const r = await runGan(['config', 'get', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/dotted path/);
  });
});

describe('gan config set', () => {
  it('F-AC4: round-trip set → resolved-config read returns the written value', async () => {
    const proj = makeTmpProject();
    const setR = await runGan([
      'config',
      'set',
      'runner.thresholdOverride',
      '8',
      '--project-root',
      proj,
    ]);
    expect(setR.exitCode).toBe(0);
    expect(setR.stderr).toBe('');
    expect(setR.stdout).toMatch(/Updated `runner\.thresholdOverride` to `8` in project overlay/);

    // The cascaded resolved config exposes the overlay tier under
    // `overlay.<...>` per F2's stable shape; the round-trip must surface
    // the just-written value.
    const getR = await runGan([
      'config',
      'get',
      'overlay.runner.thresholdOverride',
      '--project-root',
      proj,
    ]);
    expect(getR.exitCode).toBe(0);
    expect(getR.stdout.trim()).toBe('8');

    // The on-disk overlay file reflects the write.
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    const written = readFileSync(overlayPath, 'utf8');
    expect(written).toMatch(/runner:\s*[\r\n]+\s+thresholdOverride:\s*8/);
  });

  it('F-AC4: --json round-trip emits a structured write result', async () => {
    const proj = makeTmpProject();
    const setR = await runGan([
      'config',
      'set',
      'runner.thresholdOverride',
      '8',
      '--project-root',
      proj,
      '--json',
    ]);
    expect(setR.exitCode).toBe(0);
    expect(setR.stderr).toBe('');
    const parsed = JSON.parse(setR.stdout) as {
      path: string;
      tier: string;
      value: number;
      written: boolean;
    };
    expect(parsed.path).toBe('runner.thresholdOverride');
    expect(parsed.tier).toBe('project');
    expect(parsed.value).toBe(8);
    expect(parsed.written).toBe(true);
  });

  it('parses booleans, strings, and arrays through JSON literal first', async () => {
    const proj = makeTmpProject();

    const r1 = await runGan([
      'config',
      'set',
      'planner.additionalContext',
      '["docs/notes.md"]',
      '--project-root',
      proj,
    ]);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain('["docs/notes.md"]');

    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    expect(readFileSync(overlayPath, 'utf8')).toContain('docs/notes.md');
  });

  it('writes bare strings when JSON parse fails', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'config',
      'set',
      'planner.additionalContext',
      'docs/notes.md',
      '--project-root',
      proj,
      '--json',
    ]);
    // setOverlayField + the schema rejects a bare string under
    // additionalContext (which expects an array). The CLI surfaces the
    // schema error with exit 2.
    // SchemaMismatch maps to exit 3 per the locked exit-code table.
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');
  });

  it('--tier=user writes to the user-tier overlay', async () => {
    const proj = makeTmpProject();
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'gan-cli-home-'));
    tmpDirs.push(fakeHome);

    const r = await runGan(
      ['config', 'set', 'runner.thresholdOverride', '12', '--tier=user', '--project-root', proj],
      { extraEnv: { HOME: fakeHome, GAN_USER_HOME: fakeHome } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/in user overlay/);

    const userOverlay = path.join(fakeHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(true);
    expect(readFileSync(userOverlay, 'utf8')).toMatch(/thresholdOverride:\s*12/);
  });

  it('--tier=repo is rejected with exit 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'config',
      'set',
      'runner.thresholdOverride',
      '8',
      '--tier=repo',
      '--project-root',
      proj,
    ]);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--tier must be 'project' or 'user'/);
  });

  it('--tier=default is rejected with exit 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan([
      'config',
      'set',
      'runner.thresholdOverride',
      '8',
      '--tier=default',
      '--project-root',
      proj,
    ]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/--tier must be 'project' or 'user'/);
  });

  it('missing path argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['config', 'set', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/dotted path/);
  });

  it('missing value argument exits 64', async () => {
    const proj = makeTmpProject();
    const r = await runGan(['config', 'set', 'runner.thresholdOverride', '--project-root', proj]);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/value argument/);
  });

  it('schema-violating writes return the issue list and persist nothing', async () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    const before = readFileSync(overlayPath, 'utf8');

    // Top-level unknown key violates `additionalProperties: false` on the
    // overlay schema.
    const r = await runGan([
      'config',
      'set',
      'unknownTopLevelKey',
      '"bogus"',
      '--project-root',
      proj,
      '--json',
    ]);
    // SchemaMismatch maps to exit 3 per the locked exit-code table.
    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');

    expect(readFileSync(overlayPath, 'utf8')).toBe(before);
  });
});
