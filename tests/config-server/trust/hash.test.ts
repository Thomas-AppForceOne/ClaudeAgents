import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { computeTrustHash } from '../../../src/config-server/trust/hash.js';
import { canonicalizePath, localeSort } from '../../../src/config-server/determinism/index.js';

// Empty SHA-256 digest, prefixed with the algorithm tag we emit. The literal
// string is intentionally embedded so a grep can confirm the contract.
const EMPTY_SHA256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const HEX_HASH_RE = /^sha256:[0-9a-f]{64}$/;

describe('computeTrustHash', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'r5-hash-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeGanDir(): string {
    const ganDir = path.join(root, '.claude', 'gan');
    mkdirSync(ganDir, { recursive: true });
    return ganDir;
  }

  it('returns empty-set hash for a project without .claude/gan/', () => {
    const result = computeTrustHash(root);
    expect(result).toEqual({
      aggregateHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      files: [],
    });
  });

  it('hashes a single project.md deterministically across two invocations', () => {
    const ganDir = makeGanDir();
    writeFileSync(path.join(ganDir, 'project.md'), '---\nname: example\n---\n', 'utf8');

    const a = computeTrustHash(root);
    const b = computeTrustHash(root);

    expect(a.aggregateHash).toMatch(HEX_HASH_RE);
    expect(a.aggregateHash).not.toBe(EMPTY_SHA256);
    expect(a.files.length).toBe(1);
    expect(b).toEqual(a);
  });

  it('hashes a single stack file deterministically', () => {
    const ganDir = makeGanDir();
    const stacksDir = path.join(ganDir, 'stacks');
    mkdirSync(stacksDir);
    writeFileSync(path.join(stacksDir, 'web-node.md'), '---\nname: web-node\n---\n', 'utf8');

    const a = computeTrustHash(root);
    const b = computeTrustHash(root);

    expect(a.aggregateHash).toMatch(HEX_HASH_RE);
    expect(a.files.length).toBe(1);
    expect(b).toEqual(a);
  });

  it('returns a sorted, canonicalised, absolute file list for a multi-file project', () => {
    const ganDir = makeGanDir();
    const stacksDir = path.join(ganDir, 'stacks');
    const modulesDir = path.join(ganDir, 'modules');
    mkdirSync(stacksDir);
    mkdirSync(modulesDir);

    writeFileSync(path.join(ganDir, 'project.md'), 'project body\n', 'utf8');
    writeFileSync(path.join(stacksDir, 'web-node.md'), 'stack a\n', 'utf8');
    writeFileSync(path.join(stacksDir, 'generic.md'), 'stack b\n', 'utf8');
    writeFileSync(path.join(modulesDir, 'web-node.yaml'), 'module a\n', 'utf8');

    const result = computeTrustHash(root);

    expect(result.aggregateHash).toMatch(HEX_HASH_RE);
    expect(result.files.length).toBe(4);

    // Every entry is absolute.
    for (const f of result.files) {
      expect(path.isAbsolute(f)).toBe(true);
    }

    // List equals localeSort(canonicalizedPaths) of exactly the expected set.
    const expectedRaw = [
      path.join(ganDir, 'project.md'),
      path.join(stacksDir, 'web-node.md'),
      path.join(stacksDir, 'generic.md'),
      path.join(modulesDir, 'web-node.yaml'),
    ];
    const expectedSorted = localeSort(expectedRaw.map((p) => canonicalizePath(p)));
    expect(result.files).toEqual(expectedSorted);

    // Lexicographic order: each entry sorts at-or-after its predecessor under
    // the same locale rule.
    const reSorted = localeSort(result.files);
    expect(result.files).toEqual(reSorted);
  });

  it('produces different hashes for fixtures differing only in a trailing space', () => {
    const ganDirA = makeGanDir();
    writeFileSync(path.join(ganDirA, 'project.md'), 'hello\n', 'utf8');
    const hashA = computeTrustHash(root).aggregateHash;

    // Tear down and rebuild with one extra trailing space.
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), 'r5-hash-'));
    const ganDirB = path.join(root, '.claude', 'gan');
    mkdirSync(ganDirB, { recursive: true });
    writeFileSync(path.join(ganDirB, 'project.md'), 'hello \n', 'utf8');
    const hashB = computeTrustHash(root).aggregateHash;

    expect(hashA).toMatch(HEX_HASH_RE);
    expect(hashB).toMatch(HEX_HASH_RE);
    expect(hashA).not.toBe(hashB);
  });

  it('is deterministic across 100 invocations on the same fixture', () => {
    const ganDir = makeGanDir();
    const stacksDir = path.join(ganDir, 'stacks');
    const modulesDir = path.join(ganDir, 'modules');
    mkdirSync(stacksDir);
    mkdirSync(modulesDir);
    writeFileSync(path.join(ganDir, 'project.md'), 'p\n', 'utf8');
    writeFileSync(path.join(stacksDir, 's1.md'), 's1\n', 'utf8');
    writeFileSync(path.join(stacksDir, 's2.md'), 's2\n', 'utf8');
    writeFileSync(path.join(modulesDir, 'm1.yaml'), 'm1\n', 'utf8');

    const first = computeTrustHash(root);
    for (let i = 0; i < 100; i++) {
      const next = computeTrustHash(root);
      expect(next).toEqual(first);
    }
  });

  it('includes only .yaml manifests under modules/, never .yml', () => {
    const ganDir = makeGanDir();
    const modulesDir = path.join(ganDir, 'modules');
    mkdirSync(modulesDir);
    writeFileSync(path.join(modulesDir, 'm1.yaml'), 'yaml-manifest\n', 'utf8');
    writeFileSync(path.join(modulesDir, 'm2.yml'), 'yml-manifest\n', 'utf8');

    const result = computeTrustHash(root);

    expect(result.files.length).toBe(1);
    const yaml = canonicalizePath(path.join(modulesDir, 'm1.yaml'));
    const yml = canonicalizePath(path.join(modulesDir, 'm2.yml'));
    expect(result.files).toContain(yaml);
    expect(result.files).not.toContain(yml);
  });

  it('includes only direct .md children of stacks/, never nested files', () => {
    const ganDir = makeGanDir();
    const stacksDir = path.join(ganDir, 'stacks');
    const subDir = path.join(stacksDir, 'sub');
    mkdirSync(stacksDir);
    mkdirSync(subDir);
    writeFileSync(path.join(stacksDir, 'web-node.md'), 'top-level\n', 'utf8');
    writeFileSync(path.join(subDir, 'inner.md'), 'nested\n', 'utf8');

    const result = computeTrustHash(root);

    expect(result.files.length).toBe(1);
    const top = canonicalizePath(path.join(stacksDir, 'web-node.md'));
    const inner = canonicalizePath(path.join(subDir, 'inner.md'));
    expect(result.files).toContain(top);
    expect(result.files).not.toContain(inner);
  });
});
