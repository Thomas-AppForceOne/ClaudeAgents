/**
 * R-post sprint 6 — `gan stacks available` spawn-based tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runGan } from '../helpers/spawn.js';

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

function makeFakePackageRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-test-stacks-available-'));
  tmpDirs.push(dir);
  return dir;
}

function writeStack(packageRoot: string, fileName: string, body: string): void {
  const stacksDir = path.join(packageRoot, 'stacks');
  mkdirSync(stacksDir, { recursive: true });
  writeFileSync(path.join(stacksDir, fileName), body, 'utf8');
}

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
    // Malformed: missing closing marker.
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
    // Sorted keys: description, name, path, schemaVersion.
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
