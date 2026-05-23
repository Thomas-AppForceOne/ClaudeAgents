// End-to-end tests for `gan stacks where`, spawning the built CLI. Two modes
// are covered: with no name it prints the built-in stacks directory; with a
// name it resolves that stack across tiers and reports its path and tier. The
// load-bearing behaviour is tier precedence — a project-tier customisation must
// win over the same-named built-in — plus the locked `--json` shapes
// (`{kind, path}` for the directory query, `{name, path, tier}` for a named
// resolution) and the exit-2 MissingFile contract when no tier has the stack.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalizePathForDisplay } from '../../../src/config-server/determinism/index.js';
import { runGan } from '../helpers/spawn.js';

// Temp dirs (package roots, project roots, fake homes) created per test.
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

// A fresh temp dir with a descriptive prefix, registered for teardown.
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Minimal schema-valid stack body, reused for both built-in and project-tier
// seeds so resolution tests differ only in WHERE the file is placed.
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

// Seed a built-in (package-tier) stack at `<packageRoot>/stacks/<name>.md`.
function seedBuiltin(packageRoot: string, name: string): string {
  const dir = path.join(packageRoot, 'stacks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, STACK_BODY(name), 'utf8');
  return file;
}

// Seed a project-tier customisation at `<project>/.claude/gan/stacks/<name>.md`.
// The path is canonicalised first so the seeded location matches what the CLI
// resolves (the CLI works in canonical paths), letting the override-wins test
// compare exact paths.
function seedProjectTier(projectRoot: string, name: string): string {
  const dir = path.join(canonicalizePathForDisplay(projectRoot), '.claude', 'gan', 'stacks');
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
