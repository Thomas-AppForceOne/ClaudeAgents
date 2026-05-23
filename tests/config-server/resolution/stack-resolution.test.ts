// Pins the C5 stack-file resolution invariants: which on-disk tier wins when a
// stack name exists in more than one place. The precedence is
// project > user > built-in (package) > project-local fixture fallback. The
// suite also asserts that an explicit userHome overrides the env-var fallbacks,
// that an unresolvable stack throws MissingFile, and that the MissingFile
// message enumerates every path that was checked (so a user can see exactly
// where the loader looked). A final case pins that packageRoot() is memoised
// and resolves to the config-server package.
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

// Identical stub content written into each candidate tier; resolution is by
// path/tier precedence, not by file contents, so one shared body is enough.
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
    // Same stack present in both the project-local built-in dir and the user
    // dir; the user tier must take precedence.
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
    // Both the installed-package stacks dir and the project-local fixture
    // fallback carry the stack; the package tier (still reported as 'builtin')
    // wins, so the resolved path points into pkgRoot.
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
    // pkgRoot exists but has no stacks dir, so resolution falls through to the
    // project-local <projectRoot>/stacks fixture as the built-in tier.
    const projStacksDir = path.join(workRoot, 'stacks');
    mkdirSync(projStacksDir, { recursive: true });
    writeFileSync(path.join(projStacksDir, 'web-node.md'), STUB_STACK);

    const resolved = resolveStackFile('web-node', workRoot, { userHome, packageRoot: pkgRoot });
    expect(resolved.tier).toBe('builtin');
    expect(resolved.path).toBe(path.join(projStacksDir, 'web-node.md'));
  });

  it('MissingFile message enumerates all four checked paths', () => {
    // When a stack resolves nowhere, the error must list every candidate path
    // (project, user, package, project-local fixture) so the user can see
    // exactly where the loader looked.
    try {
      resolveStackFile('absent', workRoot, { userHome, packageRoot: pkgRoot });
      throw new Error('expected MissingFile');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      const err = e as ConfigServerError;
      expect(err.code).toBe('MissingFile');

      expect(err.message).toContain(path.join(workRoot, '.claude', 'gan', 'stacks', 'absent.md'));

      expect(err.message).toContain(path.join(userHome, '.claude', 'gan', 'stacks', 'absent.md'));

      expect(err.message).toContain(path.join(pkgRoot, 'stacks', 'absent.md'));

      expect(err.message).toContain(path.join(workRoot, 'stacks', 'absent.md'));
    }
  });
});

describe('packageRoot() helper', () => {
  it('is memoized and points at @claudeagents/config-server', () => {
    const a = packageRoot();
    const b = packageRoot();

    // Memoised: repeated calls return the same string.
    expect(a).toBe(b);

    // And it really is the config-server package root (its package.json name
    // matches), not some ancestor directory.
    const pkgJson = JSON.parse(readFileSync(path.join(a, 'package.json'), 'utf8')) as {
      name?: string;
    };
    expect(pkgJson.name).toBe('@claudeagents/config-server');
  });
});
