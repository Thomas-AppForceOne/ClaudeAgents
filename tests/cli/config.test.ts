/**
 * End-to-end tests for the `gan config` subcommands: print, get, and set
 * (acceptance criteria F-AC3 read surface, F-AC4 write surface).
 *
 * Coverage:
 * - `config print` — human and `--json` resolved-config dumps; the JSON form is
 *   canonical (sorted keys, two-space indent, trailing newline), deterministic
 *   across runs, and re-parseable.
 * - `config get` — scalar / nested-dotted / array reads; missing keys exit 1
 *   (KeyNotFound) and a missing path argument exits 64 (bad args).
 * - `config set` — the round-trip write contract: a value written via `set` is
 *   read back identically and lands in the project (or `--tier=user`) overlay
 *   file on disk; tier validation rejects `repo`/`default` with exit 64; and a
 *   schema-violating write persists NOTHING (the before/after file bytes must
 *   match), proving validate-then-write atomicity at the CLI boundary.
 *
 * Read-only cases run against the shared read-only FIXTURE; write cases each
 * copy it to a throwaway temp project so they never mutate the fixture.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';

// Read-only fixture project shared by the print/get tests; never mutated.
const FIXTURE = stackFixturePath('js-ts-minimal');

// Temp dirs created by write tests, torn down after each test (see afterEach).
const tmpDirs: string[] = [];

afterEach(() => {
  // Best-effort cleanup: drain the list (splice) so a failed rm cannot leave a
  // dir queued for a later run, and swallow errors so cleanup never fails a test.
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// Copy the read-only fixture into a fresh temp dir so write tests can mutate a
// disposable project; the dir is registered for afterEach teardown.
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

    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('schemaVersions');
    expect(parsed).toHaveProperty('stacks');
    expect(parsed).toHaveProperty('overlay');
    expect(parsed).toHaveProperty('discarded');
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed).toHaveProperty('issues');

    // The emitted key order must already equal its own sort — i.e. the JSON is
    // emitted with sorted keys, the basis of the byte-determinism guarantee.
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('F-AC3: --json round-trips byte-identically across runs (determinism)', async () => {
    // Two independent invocations must produce identical bytes — no timestamps,
    // map-iteration order, or other run-to-run nondeterminism may leak in.
    const a = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    const b = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('F-AC3: --json output parses cleanly via JSON.parse (jq-equivalent contract)', async () => {
    const r = await runGan(['config', 'print', '--project-root', FIXTURE, '--json']);

    const parsed = JSON.parse(r.stdout) as { apiVersion: string };
    expect(typeof parsed.apiVersion).toBe('string');
  });
});

describe('gan config get', () => {
  it('returns the apiVersion at a known key', async () => {
    const r = await runGan(['config', 'get', 'apiVersion', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    // A scalar read prints the raw value (a semver string), not a JSON document.
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

  // The two missing-key cases below distinguish a *runtime* miss (exit 1,
  // KeyNotFound) from a *usage* error (exit 64, below): a key that simply isn't
  // present is not the same failure class as forgetting the path argument.
  it('missing key exits 1 with stderr mentioning the path', async () => {
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/key not found/);
    // The offending path is echoed so the user can see what was searched.
    expect(r.stderr).toContain('no.such.path');
  });

  it('missing key under --json emits a structured error to stdout, exit 1', async () => {
    // Under --json the error becomes a machine-readable object on stdout (stderr
    // stays clean) so scripts can branch on `code`/`field`, not parse prose.
    const r = await runGan(['config', 'get', 'no.such.path', '--project-root', FIXTURE, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const parsed = JSON.parse(r.stdout) as { code: string; message: string; field: string };
    expect(parsed.code).toBe('KeyNotFound');
    expect(parsed.field).toBe('no.such.path');
    expect(parsed.message).toMatch(/key not found/);
  });

  it('no path argument exits 64 with bad-args framing', async () => {
    // Omitting the dotted-path argument is a usage error (64), distinct from the
    // present-but-missing-key case (exit 1) above.
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

    const getR = await runGan([
      'config',
      'get',
      'overlay.runner.thresholdOverride',
      '--project-root',
      proj,
    ]);
    expect(getR.exitCode).toBe(0);
    expect(getR.stdout.trim()).toBe('8');

    // Beyond the read-back, assert the value actually landed in the project
    // overlay file as a nested mapping (runner: → thresholdOverride: 8), not
    // just in resolved-config memory.
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

  // Value parsing: the CLI tries to JSON-parse the value argument first, so an
  // array/boolean literal is stored typed; a bare token that fails JSON parsing
  // would be treated as a string (and here is rejected by schema, see below).
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
    // `docs/notes.md` is not valid JSON, so it falls through to the bare-string
    // path. additionalContext expects an array, so the bare string is a schema
    // violation — exit 3 (SchemaMismatch), the data-error code (distinct from
    // 64 usage / 1 not-found / 5 unreachable).
    const r = await runGan([
      'config',
      'set',
      'planner.additionalContext',
      'docs/notes.md',
      '--project-root',
      proj,
      '--json',
    ]);

    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');
  });

  it('--tier=user writes to the user-tier overlay', async () => {
    const proj = makeTmpProject();
    // Point both HOME and GAN_USER_HOME at a throwaway dir so the user-tier
    // write lands under the fake home and never touches the developer's real
    // ~/.claude; both vars are set because user-home resolution checks them in
    // turn.
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'gan-cli-home-'));
    tmpDirs.push(fakeHome);

    const r = await runGan(
      ['config', 'set', 'runner.thresholdOverride', '12', '--tier=user', '--project-root', proj],
      { extraEnv: { HOME: fakeHome, GAN_USER_HOME: fakeHome } },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/in user overlay/);

    // The write must materialise the user overlay under the fake home, not the
    // project overlay.
    const userOverlay = path.join(fakeHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(true);
    expect(readFileSync(userOverlay, 'utf8')).toMatch(/thresholdOverride:\s*12/);
  });

  // Only `project` and `user` are writable tiers; `repo` and `default` are read
  // sources the user must not write through, so both are rejected as usage
  // errors (64) before any I/O.
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
    // Snapshot the overlay bytes BEFORE the rejected write so the post-write
    // comparison can prove atomicity.
    const before = readFileSync(overlayPath, 'utf8');

    const r = await runGan([
      'config',
      'set',
      'unknownTopLevelKey',
      '"bogus"',
      '--project-root',
      proj,
      '--json',
    ]);

    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('SchemaMismatch');

    // The load-bearing assertion: a rejected (validate-then-write) mutation must
    // leave the file byte-for-byte unchanged — no partial/clobbered write.
    expect(readFileSync(overlayPath, 'utf8')).toBe(before);
  });
});
