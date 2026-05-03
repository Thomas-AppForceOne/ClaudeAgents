import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigServerError } from '../../../src/config-server/errors.js';
import { packageRoot } from '../../../src/config-server/package-root.js';
import { resolveStackFile } from '../../../src/config-server/resolution/stack-resolution.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const STUB_STACK = ['---', 'name: web-node', 'schemaVersion: 1', '---', 'body', ''].join('\n');

describe('resolveStackFile (C5 invariants)', () => {
  let workRoot: string;
  let userHome: string;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'cas-stack-resolution-project-'));
    userHome = mkdtempSync(path.join(tmpdir(), 'cas-stack-resolution-user-'));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  it('returns the built-in tier when no project- or user-tier file exists', () => {
    const resolved = resolveStackFile('web-node', jsTsMinimal, { userHome });
    expect(resolved.tier).toBe('builtin');
    expect(resolved.path).toBe(path.join(jsTsMinimal, 'stacks', 'web-node.md'));
  });

  it('user tier wins over built-in tier', () => {
    // Seed `<projectRoot>/stacks/web-node.md` (built-in) and a user-tier file.
    const builtinDir = path.join(workRoot, 'stacks');
    mkdirSync(builtinDir, { recursive: true });
    writeFileSync(path.join(builtinDir, 'web-node.md'), STUB_STACK);
    const userStacksDir = path.join(userHome, '.claude', 'gan', 'stacks');
    mkdirSync(userStacksDir, { recursive: true });
    writeFileSync(path.join(userStacksDir, 'web-node.md'), STUB_STACK);

    const resolved = resolveStackFile('web-node', workRoot, { userHome });
    expect(resolved.tier).toBe('user');
    expect(resolved.path).toBe(path.join(userStacksDir, 'web-node.md'));
  });

  it('project tier wins over both user and built-in tiers', () => {
    const builtinDir = path.join(workRoot, 'stacks');
    mkdirSync(builtinDir, { recursive: true });
    writeFileSync(path.join(builtinDir, 'web-node.md'), STUB_STACK);
    const userStacksDir = path.join(userHome, '.claude', 'gan', 'stacks');
    mkdirSync(userStacksDir, { recursive: true });
    writeFileSync(path.join(userStacksDir, 'web-node.md'), STUB_STACK);
    const projectStacksDir = path.join(workRoot, '.claude', 'gan', 'stacks');
    mkdirSync(projectStacksDir, { recursive: true });
    writeFileSync(path.join(projectStacksDir, 'web-node.md'), STUB_STACK);

    const resolved = resolveStackFile('web-node', workRoot, { userHome });
    expect(resolved.tier).toBe('project');
    expect(resolved.path).toBe(path.join(projectStacksDir, 'web-node.md'));
  });

  it('throws MissingFile when no tier carries the stack', () => {
    try {
      resolveStackFile('absent', workRoot, { userHome });
      throw new Error('expected MissingFile');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MissingFile');
    }
  });

  it('honours an explicit userHome over GAN_USER_HOME / process.env.HOME', () => {
    const userStacksDir = path.join(userHome, '.claude', 'gan', 'stacks');
    mkdirSync(userStacksDir, { recursive: true });
    writeFileSync(path.join(userStacksDir, 'web-node.md'), STUB_STACK);

    // workRoot has neither project- nor built-in-tier file, so user tier wins.
    const resolved = resolveStackFile('web-node', workRoot, { userHome });
    expect(resolved.tier).toBe('user');
  });
});

describe('resolveStackFile — built-in package vs. fixture fallback (4-tier)', () => {
  let workRoot: string;
  let userHome: string;
  let pkgRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'cas-stack-resolution-project-'));
    userHome = mkdtempSync(path.join(tmpdir(), 'cas-stack-resolution-user-'));
    pkgRoot = mkdtempSync(path.join(tmpdir(), 'cas-stack-resolution-pkg-'));
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it('package-tier wins over the fixture-tier fallback', () => {
    // Both `<packageRoot>/stacks/web-node.md` AND `<projectRoot>/stacks/web-node.md`
    // exist. Resolver returns the package-tier path, still labelled `'builtin'`.
    const pkgStacksDir = path.join(pkgRoot, 'stacks');
    mkdirSync(pkgStacksDir, { recursive: true });
    writeFileSync(path.join(pkgStacksDir, 'web-node.md'), STUB_STACK);
    const projStacksDir = path.join(workRoot, 'stacks');
    mkdirSync(projStacksDir, { recursive: true });
    writeFileSync(path.join(projStacksDir, 'web-node.md'), STUB_STACK);

    const resolved = resolveStackFile('web-node', workRoot, { userHome, packageRoot: pkgRoot });
    expect(resolved.tier).toBe('builtin');
    expect(resolved.path).toBe(path.join(pkgStacksDir, 'web-node.md'));
  });

  it('falls back to <projectRoot>/stacks/<name>.md when packageRoot is empty', () => {
    // packageRoot points at a tmp dir without any `stacks/` directory; the
    // project-tier fixture path serves as the 4th-tier fallback. Provenance
    // is still `'builtin'`.
    const projStacksDir = path.join(workRoot, 'stacks');
    mkdirSync(projStacksDir, { recursive: true });
    writeFileSync(path.join(projStacksDir, 'web-node.md'), STUB_STACK);

    const resolved = resolveStackFile('web-node', workRoot, { userHome, packageRoot: pkgRoot });
    expect(resolved.tier).toBe('builtin');
    expect(resolved.path).toBe(path.join(projStacksDir, 'web-node.md'));
  });

  it('MissingFile message enumerates all four checked paths', () => {
    // Neither package-tier nor any fallback contains the named stack.
    try {
      resolveStackFile('absent', workRoot, { userHome, packageRoot: pkgRoot });
      throw new Error('expected MissingFile');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      const err = e as ConfigServerError;
      expect(err.code).toBe('MissingFile');
      // Project tier (under .claude/gan/stacks/).
      expect(err.message).toContain(path.join(workRoot, '.claude', 'gan', 'stacks', 'absent.md'));
      // User tier.
      expect(err.message).toContain(path.join(userHome, '.claude', 'gan', 'stacks', 'absent.md'));
      // Package-tier built-in.
      expect(err.message).toContain(path.join(pkgRoot, 'stacks', 'absent.md'));
      // Project-tier fixture fallback.
      expect(err.message).toContain(path.join(workRoot, 'stacks', 'absent.md'));
    }
  });
});

describe('packageRoot() helper', () => {
  it('is memoized and points at @claudeagents/config-server', () => {
    const a = packageRoot();
    const b = packageRoot();
    // Two consecutive calls return the same string (string equality).
    expect(a).toBe(b);
    // Reading <packageRoot()>/package.json yields the expected name.
    const pkgJson = JSON.parse(readFileSync(path.join(a, 'package.json'), 'utf8')) as {
      name?: string;
    };
    expect(pkgJson.name).toBe('@claudeagents/config-server');
  });
});
