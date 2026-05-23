// End-to-end tests for `gan stacks available`, spawning the built CLI against a
// fake package root seeded with built-in stack files. They lock the human
// surface (a NAME/VERSION/DESCRIPTION table, the "(no built-in stacks)" empty
// message, locale-order sorting, and the skip-malformed-with-warning behaviour)
// and the `--json` surface (a `{ stacks: [...] }` document with deterministic
// per-entry key order). They also pin the exit-code contract: 0 on success
// including the empty case, but 2 with a MissingFile error when the stacks
// directory does not exist (absent dir is an error; present-but-empty is not).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan } from '../helpers/spawn.js';

// Temp package roots created per test, removed in teardown.
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

// A fresh empty package root; tests pass it via GAN_PACKAGE_ROOT_OVERRIDE so the
// CLI reads built-in stacks from here instead of the real install.
function makeFakePackageRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-test-stacks-available-'));
  tmpDirs.push(dir);
  return dir;
}

// Write a stack file into `<packageRoot>/stacks/`, creating the dir on demand.
function writeStack(packageRoot: string, fileName: string, body: string): void {
  const stacksDir = path.join(packageRoot, 'stacks');
  mkdirSync(stacksDir, { recursive: true });
  writeFileSync(path.join(stacksDir, fileName), body, 'utf8');
}

// Build a schema-valid stack file body (frontmatter + a conventions heading).
// Factored out so each test seeds a known-good stack and varies only name/desc.
const VALID_STACK = (name: string, description: string) =>
  [
    '---',
    `name: ${name}`,
    'schemaVersion: 1',
    `description: ${description}`,
    'detection:',
    '  - anyOf:',
    '      - marker.txt',
    'scope:',
    '  - "**/*"',
    '---',
    '',
    `# ${name} conventions`,
    '',
  ].join('\n');

describe('gan stacks available — human surface', () => {
  it('prints a NAME / VERSION / DESCRIPTION table with header row when stacks are present', async () => {
    const pkg = makeFakePackageRoot();
    writeStack(pkg, 'alpha.md', VALID_STACK('alpha', 'first ecosystem'));
    writeStack(pkg, 'beta.md', VALID_STACK('beta', 'second ecosystem'));
    const r = await runGan(['stacks', 'available'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^NAME\s+VERSION\s+DESCRIPTION/m);
    expect(r.stdout).toMatch(/alpha\s+1\s+first ecosystem/);
    expect(r.stdout).toMatch(/beta\s+1\s+second ecosystem/);
  });

  it('prints "(no built-in stacks)" when the directory is empty', async () => {
    const pkg = makeFakePackageRoot();
    mkdirSync(path.join(pkg, 'stacks'), { recursive: true });
    const r = await runGan(['stacks', 'available'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('(no built-in stacks)\n');
  });

  it('exits 2 with MissingFile when the stacks directory does not exist', async () => {
    const pkg = makeFakePackageRoot();
    const r = await runGan(['stacks', 'available'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/code: MissingFile/);
    expect(r.stderr).toContain(path.join(pkg, 'stacks'));
  });

  it('skips malformed entries and emits a stderr warning', async () => {
    const pkg = makeFakePackageRoot();
    writeStack(pkg, 'good.md', VALID_STACK('good', 'fine'));

    // Deliberately malformed: an unterminated frontmatter block (no closing
    // `---`). One bad file must not abort the listing — the good entry still
    // prints and the bad one is reported as a warning, not a hard failure.
    writeStack(pkg, 'broken.md', '---\nname: broken\nschemaVersion: 1\n');
    const r = await runGan(['stacks', 'available'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/good\s+1\s+fine/);
    expect(r.stdout).not.toMatch(/broken/);
    expect(r.stderr).toMatch(/warning:/);
    expect(r.stderr).toContain('broken.md');
  });

  it('sorts entries by name in locale order', async () => {
    const pkg = makeFakePackageRoot();
    writeStack(pkg, 'z.md', VALID_STACK('zeta', ''));
    writeStack(pkg, 'a.md', VALID_STACK('alpha', ''));
    writeStack(pkg, 'm.md', VALID_STACK('mu', ''));
    const r = await runGan(['stacks', 'available'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    // Drop the header row (slice(1)), then take the first whitespace-delimited
    // token of each line as the name. Output order must be locale-sorted by
    // name, independent of the on-disk filenames (z.md/a.md/m.md here).
    const lines = r.stdout
      .split('\n')
      .slice(1)
      .filter((l) => l.length > 0);
    const names = lines.map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('gan stacks available --json', () => {
  it('emits {"stacks": [...]} with deterministic key order', async () => {
    const pkg = makeFakePackageRoot();
    writeStack(pkg, 'alpha.md', VALID_STACK('alpha', 'desc-a'));
    writeStack(pkg, 'beta.md', VALID_STACK('beta', 'desc-b'));
    const r = await runGan(['stacks', 'available', '--json'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      stacks: Array<{ description: string; name: string; path: string; schemaVersion: number }>;
    };
    expect(parsed.stacks).toHaveLength(2);
    expect(parsed.stacks[0]!.name).toBe('alpha');
    expect(parsed.stacks[0]!.schemaVersion).toBe(1);
    expect(parsed.stacks[0]!.description).toBe('desc-a');
    expect(path.isAbsolute(parsed.stacks[0]!.path)).toBe(true);

    // Per-entry keys must serialise in a fixed, sorted order so the JSON is
    // byte-stable for machine consumers — compare the literal key sequence.
    const firstEntry = JSON.stringify(Object.keys(parsed.stacks[0]!));
    expect(firstEntry).toBe(JSON.stringify(['description', 'name', 'path', 'schemaVersion']));
  });

  it('emits {"stacks": []} when the directory is empty (exit 0)', async () => {
    const pkg = makeFakePackageRoot();
    mkdirSync(path.join(pkg, 'stacks'), { recursive: true });
    const r = await runGan(['stacks', 'available', '--json'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ stacks: [] });
  });

  it('emits a structured-error JSON on missing directory (exit 2)', async () => {
    const pkg = makeFakePackageRoot();
    const r = await runGan(['stacks', 'available', '--json'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(2);
    const err = JSON.parse(r.stdout) as { code: string; file?: string; message: string };
    expect(err.code).toBe('MissingFile');
    expect(err.file).toBe(path.join(pkg, 'stacks'));
  });

  it('uses default empty description when the stack file omits one', async () => {
    const pkg = makeFakePackageRoot();
    const noDesc = [
      '---',
      'name: undescribed',
      'schemaVersion: 1',
      'detection:',
      '  - anyOf:',
      '      - marker.txt',
      'scope:',
      '  - "**/*"',
      '---',
      '',
    ].join('\n');
    writeStack(pkg, 'undescribed.md', noDesc);
    const r = await runGan(['stacks', 'available', '--json'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { stacks: Array<{ description: string }> };
    expect(parsed.stacks[0]!.description).toBe('');
  });
});
