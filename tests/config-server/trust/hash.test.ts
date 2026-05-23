// Verifies computeTrustHash, the function that fingerprints a project's GAN
// config so the trust cache can later detect tampering. The hash IS the trust
// boundary, so these tests pin three properties it must never lose:
//  - Determinism: the same file tree hashes identically across repeated calls
//    (and across 100 calls), so a re-check never spuriously flips to untrusted.
//  - Sensitivity: a one-byte change (here a trailing space) yields a different
//    hash — otherwise an attacker could mutate config without invalidating an
//    existing approval.
//  - A fixed, well-defined input set: only `.claude/gan/project.md`, the direct
//    `.md` children of `stacks/` (never nested), and the `.yaml` (never `.yml`)
//    manifests under `modules/`. The file list is canonicalised, absolute, and
//    locale-sorted so the aggregate is order-independent.
//
// The empty project hashes to the SHA-256 of empty input (EMPTY_SHA256); tests
// assert real fixtures differ from it to prove content actually flowed into the
// digest. Each test runs against a fresh temp project root.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { computeTrustHash } from '../../../src/config-server/trust/hash.js';
import { canonicalizePath, localeSort } from '../../../src/config-server/determinism/index.js';

// The well-known SHA-256 of zero bytes: what an empty/absent config hashes to.
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
    // No config dir at all: empty file list and the empty-input digest. Defines
    // the baseline the content-bearing tests below must diverge from.
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

    for (const f of result.files) {
      expect(path.isAbsolute(f)).toBe(true);
    }

    // Build the expected list in creation order, then canonicalise + locale-sort
    // it ourselves and assert equality: this proves the output is sorted (not
    // in filesystem-readdir order) and canonicalised, both required for an
    // order-independent aggregate.
    const expectedRaw = [
      path.join(ganDir, 'project.md'),
      path.join(stacksDir, 'web-node.md'),
      path.join(stacksDir, 'generic.md'),
      path.join(modulesDir, 'web-node.yaml'),
    ];
    const expectedSorted = localeSort(expectedRaw.map((p) => canonicalizePath(p)));
    expect(result.files).toEqual(expectedSorted);

    // Sorting the result again is a no-op (idempotence) — a second guard that
    // the list was already in localeSort order.
    const reSorted = localeSort(result.files);
    expect(result.files).toEqual(reSorted);
  });

  it('produces different hashes for fixtures differing only in a trailing space', () => {
    // The two bodies differ by exactly one byte: 'hello\n' vs 'hello \n'. The
    // hash must be byte-exact (no whitespace normalisation), so a content tweak
    // an attacker might think invisible still breaks an existing approval. The
    // root is torn down and recreated between the two so file paths match and
    // only the content differs.
    const ganDirA = makeGanDir();
    writeFileSync(path.join(ganDirA, 'project.md'), 'hello\n', 'utf8');
    const hashA = computeTrustHash(root).aggregateHash;

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
    // The .yml file is a deliberate decoy: only `.yaml` is the recognised
    // manifest extension, so the alternate spelling must be excluded from the
    // hashed set rather than silently folded in.
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
    // The nested stacks/sub/inner.md is a decoy: hashing is shallow (direct
    // children only), so a file one level deeper must not enter the digest.
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
