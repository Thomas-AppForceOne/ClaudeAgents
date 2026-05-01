import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigServerError } from '../../../src/config-server/errors.js';
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
