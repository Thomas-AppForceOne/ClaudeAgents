/**
 * R-post sprint 6 — `gan stacks where` spawn-based tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
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

function seedProjectTier(projectRoot: string, name: string): string {
  const dir = path.join(canonicalizePath(projectRoot), '.claude', 'gan', 'stacks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, STACK_BODY(name), 'utf8');
  return file;
}

describe('gan stacks where — no name (built-in directory)', () => {
  it('prints the built-in stacks directory path', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const r = await runGan(['stacks', 'where'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${path.join(pkg, 'stacks')}\n`);
  });

  it('--json emits {kind, path}', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const r = await runGan(['stacks', 'where', '--json'], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { kind: string; path: string };
    expect(parsed.kind).toBe('builtin-directory');
    expect(parsed.path).toBe(path.join(pkg, 'stacks'));
    expect(JSON.stringify(Object.keys(parsed))).toBe(JSON.stringify(['kind', 'path']));
  });
});

describe('gan stacks where <name> — resolution', () => {
  it('resolves a built-in stack and reports tier=builtin', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const proj = makeTmpDir('gan-test-where-proj-');
    const home = makeTmpDir('gan-test-where-home-');
    seedBuiltin(pkg, 'web-foo');
    const r = await runGan(['stacks', 'where', 'web-foo', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/web-foo\.md\s+\(tier: builtin\)/);
  });

  it('a project-tier customization wins over the built-in', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const proj = makeTmpDir('gan-test-where-proj-');
    seedBuiltin(pkg, 'web-foo');
    const projFile = seedProjectTier(proj, 'web-foo');
    const r = await runGan(['stacks', 'where', 'web-foo', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(projFile);
    expect(r.stdout).toMatch(/tier: project/);
  });

  it('--json emits {name, path, tier}', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const proj = makeTmpDir('gan-test-where-proj-');
    const home = makeTmpDir('gan-test-where-home-');
    seedBuiltin(pkg, 'web-foo');
    const r = await runGan(['stacks', 'where', 'web-foo', '--json', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { name: string; path: string; tier: string };
    expect(parsed.name).toBe('web-foo');
    expect(parsed.tier).toBe('builtin');
    expect(path.isAbsolute(parsed.path)).toBe(true);
    expect(JSON.stringify(Object.keys(parsed))).toBe(JSON.stringify(['name', 'path', 'tier']));
  });

  it('exits 2 with MissingFile when the stack cannot be found in any tier', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const proj = makeTmpDir('gan-test-where-proj-');
    const home = makeTmpDir('gan-test-where-home-');
    mkdirSync(path.join(pkg, 'stacks'), { recursive: true });
    const r = await runGan(['stacks', 'where', 'definitely-not-a-stack', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/code: MissingFile/);
  });

  it('--json on missing stack emits a structured error to stdout', async () => {
    const pkg = makeTmpDir('gan-test-where-pkg-');
    const proj = makeTmpDir('gan-test-where-proj-');
    const home = makeTmpDir('gan-test-where-home-');
    mkdirSync(path.join(pkg, 'stacks'), { recursive: true });
    const r = await runGan(['stacks', 'where', 'absent', '--json', '--project-root', proj], {
      extraEnv: { GAN_PACKAGE_ROOT_OVERRIDE: pkg, GAN_USER_HOME: home },
    });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout) as { code: string };
    expect(parsed.code).toBe('MissingFile');
  });
});
