/**
 * R-post sprint 6 — `gan stacks customize` spawn-based tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePathForDisplay } from '../../../src/config-server/determinism/index.js';
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

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const STACK_BODY = (name: string) =>
  [
    '---',
    `name: ${name}`,
    'schemaVersion: 1',
    'description: example',
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

function seedBuiltin(packageRoot: string, name: string): string {
  const dir = path.join(packageRoot, 'stacks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, STACK_BODY(name), 'utf8');
  return file;
}

describe('gan stacks customize — project tier (default)', () => {
  it('copies the built-in source into <project>/.claude/gan/stacks/<name>.md', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    const source = seedBuiltin(pkg, 'web-foo');
    const r = await runGan(['stacks', 'customize', 'web-foo', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    const target = path.join(
      canonicalizePathForDisplay(proj),
      '.claude',
      'gan',
      'stacks',
      'web-foo.md',
    );
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(r.stdout).toContain(target);
    expect(r.stdout).toMatch(/tier: project/);
  });

  it('refuses to overwrite without --force (exit 1)', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    seedBuiltin(pkg, 'web-foo');
    // Pre-seed an existing customisation.
    const projDir = path.join(canonicalizePathForDisplay(proj), '.claude', 'gan', 'stacks');
    mkdirSync(projDir, { recursive: true });
    const target = path.join(projDir, 'web-foo.md');
    writeFileSync(target, 'EXISTING\n', 'utf8');

    const r = await runGan(['stacks', 'customize', 'web-foo', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(target);
    expect(r.stderr).toMatch(/--force/);
    expect(readFileSync(target, 'utf8')).toBe('EXISTING\n');
  });

  it('overwrites with --force', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    const source = seedBuiltin(pkg, 'web-foo');
    const projDir = path.join(canonicalizePathForDisplay(proj), '.claude', 'gan', 'stacks');
    mkdirSync(projDir, { recursive: true });
    const target = path.join(projDir, 'web-foo.md');
    writeFileSync(target, 'EXISTING\n', 'utf8');

    const r = await runGan(['stacks', 'customize', 'web-foo', '--force', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'));
  });
});

describe('gan stacks customize — user tier', () => {
  it('copies into <userHome>/.claude/gan/stacks/<name>.md', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    const home = makeTmpDir('gan-test-customize-home-');
    const source = seedBuiltin(pkg, 'web-foo');
    const r = await runGan(
      ['stacks', 'customize', 'web-foo', '--tier=user', '--project-root', proj],
      { extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home } },
    );
    expect(r.exitCode).toBe(0);
    const target = path.join(home, '.claude', 'gan', 'stacks', 'web-foo.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(r.stdout).toMatch(/tier: user/);
  });

  it('writes to <userHome>/.claude/gan/stacks/<unique>.md when --tier=user is set', async () => {
    // Companion of the "user tier" success case above; uses a unique
    // stack name to avoid colliding with any leftover customisation in
    // the dev machine's real $HOME (the harness inherits HOME by
    // default; we explicitly reroute via GAN_USER_HOME so the user
    // tier targets a fresh tmp dir).
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    const home = makeTmpDir('gan-test-customize-home-');
    const uniqueName = `web-unique-${Date.now()}`;
    seedBuiltin(pkg, uniqueName);
    const r = await runGan(
      ['stacks', 'customize', uniqueName, '--tier=user', '--project-root', proj],
      { extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home } },
    );
    expect(r.exitCode).toBe(0);
    const target = path.join(home, '.claude', 'gan', 'stacks', `${uniqueName}.md`);
    expect(existsSync(target)).toBe(true);
  });
});

describe('gan stacks customize — argument errors', () => {
  it('missing name argument exits 64', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    const r = await runGan(['stacks', 'customize', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/stack name/);
  });

  it('invalid --tier exits 64', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    seedBuiltin(pkg, 'web-foo');
    const r = await runGan(
      ['stacks', 'customize', 'web-foo', '--tier=repo', '--project-root', proj],
      { extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg } },
    );
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toMatch(/--tier/);
  });

  it('missing source built-in exits 2 (MissingFile)', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    mkdirSync(path.join(pkg, 'stacks'), { recursive: true });
    const r = await runGan(
      ['stacks', 'customize', 'definitely-not-a-stack', '--project-root', proj],
      { extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg } },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/code: MissingFile/);
  });
});

describe('gan stacks customize --json', () => {
  it('emits a deterministic success object on the project tier', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    seedBuiltin(pkg, 'web-foo');
    const r = await runGan(['stacks', 'customize', 'web-foo', '--json', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      forced: boolean;
      name: string;
      path: string;
      source: string;
      tier: string;
      written: boolean;
    };
    expect(parsed.forced).toBe(false);
    expect(parsed.name).toBe('web-foo');
    expect(parsed.tier).toBe('project');
    expect(parsed.written).toBe(true);
    expect(path.isAbsolute(parsed.path)).toBe(true);
    expect(parsed.source).toContain(path.join('stacks', 'web-foo.md'));
    expect(JSON.stringify(Object.keys(parsed))).toBe(
      JSON.stringify(['forced', 'name', 'path', 'source', 'tier', 'written']),
    );
  });

  it('emits forced: true when --force was passed', async () => {
    const pkg = makeTmpDir('gan-test-customize-pkg-');
    const proj = makeTmpDir('gan-test-customize-proj-');
    seedBuiltin(pkg, 'web-foo');
    const projDir = path.join(canonicalizePathForDisplay(proj), '.claude', 'gan', 'stacks');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, 'web-foo.md'), 'OLD\n', 'utf8');
    const r = await runGan(
      ['stacks', 'customize', 'web-foo', '--force', '--json', '--project-root', proj],
      { extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg } },
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { forced: boolean };
    expect(parsed.forced).toBe(true);
  });
});
