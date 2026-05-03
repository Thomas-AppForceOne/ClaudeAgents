import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendToModuleState,
  appendToOverlayField,
  appendToStackField,
  registerModule,
  removeFromModuleState,
  removeFromOverlayField,
  removeFromStackField,
  setModuleState,
  setOverlayField,
  trustApprove,
  trustRevoke,
  updateStackField,
} from '../../../src/config-server/tools/writes.js';
import { getResolvedConfig } from '../../../src/config-server/tools/reads.js';
import {
  clearResolvedConfigCache,
  getResolvedConfigCache,
  cacheKeyForProjectRoot,
} from '../../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimalSrc = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-writes-'));
  cpSync(jsTsMinimalSrc, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function fileHash(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

beforeEach(() => {
  clearResolvedConfigCache();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
});

describe('updateStackField', () => {
  it('updates a stack body field and preserves the conventions markdown byte-identically', () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const before = readFileSync(stackPath, 'utf8');
    const proseTail = before.slice(before.lastIndexOf('---\n') + '---\n'.length);

    const result = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'lintCmd',
      value: 'npm run lint:next',
    });
    expect(result.mutated).toBe(true);
    if (result.mutated === true) {
      // Path is canonicalised (lowercased on macOS); accept any path that
      // ends with the suffix the test wrote.
      expect(result.path.endsWith(path.join('stacks', 'web-node.md'))).toBe(true);
    }

    const after = readFileSync(stackPath, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('lintCmd: npm run lint:next');
    // Prose tail (everything after the closing `---`) is byte-identical.
    expect(after.endsWith(proseTail)).toBe(true);
  });

  it('returns issues and persists nothing when the new value violates the schema', () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const beforeHash = fileHash(stackPath);

    const result = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      // `lintCmd` must be a string per the schema; passing an object should
      // surface a SchemaMismatch issue.
      fieldPath: 'lintCmd',
      value: { not: 'a-string' },
    });
    expect(result.mutated).toBe(false);
    if (result.mutated === false && 'issues' in result) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].code).toBe('SchemaMismatch');
    } else {
      throw new Error('expected issues');
    }
    // File on disk is unchanged.
    expect(fileHash(stackPath)).toBe(beforeHash);
  });

  it('returns a SchemaMismatch issue when the result has the wrong schemaVersion', () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const beforeHash = fileHash(stackPath);

    // Setting schemaVersion to 2 must fail the F3 exact-match rule and
    // not persist.
    const result = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'schemaVersion',
      value: 2,
    });
    expect(result.mutated).toBe(false);
    if (result.mutated === false && 'issues' in result) {
      expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
    }
    expect(fileHash(stackPath)).toBe(beforeHash);
  });

  it('returns a MissingFile issue (no throw) when the named stack does not exist', () => {
    const proj = makeTmpProject();
    const result = updateStackField({
      projectRoot: proj,
      name: 'does-not-exist',
      fieldPath: 'lintCmd',
      value: 'whatever',
    });
    expect(result.mutated).toBe(false);
    if (result.mutated === false && 'issues' in result) {
      expect(result.issues[0].code).toBe('MissingFile');
    } else {
      throw new Error('expected issues');
    }
  });
});

describe('appendToStackField + removeFromStackField round trip', () => {
  it('appending then removing leaves the parsed data and prose byte-identical to the original', async () => {
    const proj = makeTmpProject();
    const stackPath = path.join(proj, 'stacks', 'web-node.md');
    const before = readFileSync(stackPath, 'utf8');

    const r1 = appendToStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'scope',
      value: '**/*.tsx-extra',
    });
    expect(r1.mutated).toBe(true);
    const mid = readFileSync(stackPath, 'utf8');
    expect(mid).not.toBe(before);
    expect(mid).toContain('**/*.tsx-extra');

    const r2 = removeFromStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'scope',
      value: '**/*.tsx-extra',
    });
    expect(r2.mutated).toBe(true);

    const after = readFileSync(stackPath, 'utf8');
    // The data round-trips structurally; the prose flanks survive.
    const { parseYamlBlock } =
      await import('../../../src/config-server/storage/yaml-block-parser.js');
    const parsedBefore = parseYamlBlock(before);
    const parsedAfter = parseYamlBlock(after);
    expect(parsedAfter.data).toEqual(parsedBefore.data);
    expect(parsedAfter.prose.before).toBe(parsedBefore.prose.before);
    expect(parsedAfter.prose.after).toBe(parsedBefore.prose.after);
  });
});

describe('setOverlayField', () => {
  it('updates an existing overlay field, preserving the markdown body', () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    const before = readFileSync(overlayPath, 'utf8');
    const proseAfter = before.slice(before.lastIndexOf('---\n') + '---\n'.length);

    const result = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['docs/notes.md'],
    });
    expect(result.mutated).toBe(true);
    if (result.mutated === true) {
      expect(result.path.endsWith(path.join('.claude', 'gan', 'project.md'))).toBe(true);
    }

    const after = readFileSync(overlayPath, 'utf8');
    expect(after).toContain('docs/notes.md');
    // Prose preserved byte-identically.
    expect(after.endsWith(proseAfter)).toBe(true);
  });

  it('composes-if-absent: creates the overlay file when missing, with valid schema', () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    rmSync(overlayPath);
    expect(existsSync(overlayPath)).toBe(false);

    const result = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['notes.md'],
    });
    expect(result.mutated).toBe(true);
    if (result.mutated === true) {
      expect(result.path.endsWith(path.join('.claude', 'gan', 'project.md'))).toBe(true);
    }
    expect(existsSync(overlayPath)).toBe(true);

    const written = readFileSync(overlayPath, 'utf8');
    expect(written).toContain('schemaVersion: 1');
    expect(written).toContain('notes.md');
    // The file should re-parse and re-validate cleanly: a follow-up
    // setOverlayField returning identical data is a no-op (data unchanged).
    const r2 = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['notes.md'],
    });
    expect(r2.mutated).toBe(true);
  });

  it('returns issues and persists nothing when the resulting overlay violates the schema', () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    const beforeHash = fileHash(overlayPath);

    // The overlay schema requires every key to be a known agent block;
    // top-level `additionalProperties: false`. Pushing a top-level
    // unknown key surfaces the violation.
    const result = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'unknownTopLevelKey',
      value: { foo: 1 },
    });
    expect(result.mutated).toBe(false);
    if (result.mutated === false && 'issues' in result) {
      expect(result.issues.some((i) => i.code === 'SchemaMismatch')).toBe(true);
    } else {
      throw new Error('expected issues');
    }
    expect(fileHash(overlayPath)).toBe(beforeHash);
  });
});

describe('appendToOverlayField + removeFromOverlayField', () => {
  it('appends to a list field then removes', () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    const before = readFileSync(overlayPath, 'utf8');

    const r1 = appendToOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: 'a/b/c.md',
    });
    expect(r1.mutated).toBe(true);
    const mid = readFileSync(overlayPath, 'utf8');
    expect(mid).toContain('a/b/c.md');

    const r2 = removeFromOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: 'a/b/c.md',
    });
    expect(r2.mutated).toBe(true);

    const after = readFileSync(overlayPath, 'utf8');
    // The append leaves an empty `planner.additionalContext: []` field
    // behind. The before/after may differ in whether the field is present;
    // the contract guarantees the *value list* matches, not byte
    // equivalence after a remove. So we re-load and check semantically.
    expect(after).not.toContain('a/b/c.md');
    void before;
  });
});

describe('trust writes (R5 S4)', () => {
  it('trustApprove writes a record to the trust cache (mutated: true)', () => {
    const proj = makeTmpProject();
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'cas-writes-trust-home-'));
    tmpDirs.push(tmpHome);
    const result = trustApprove({ projectRoot: proj }, { homeDir: tmpHome });
    expect(result.mutated).toBe(true);
    expect(typeof result.record.aggregateHash).toBe('string');
    expect(result.record.aggregateHash.startsWith('sha256:')).toBe(true);
    expect(typeof result.record.approvedAt).toBe('string');
    expect(result.record.projectRoot.length).toBeGreaterThan(0);
  });

  it('trustRevoke is a no-op when no approval exists (mutated: false)', () => {
    const proj = makeTmpProject();
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'cas-writes-trust-home-'));
    tmpDirs.push(tmpHome);
    const result = trustRevoke({ projectRoot: proj }, { homeDir: tmpHome });
    expect(result.mutated).toBe(false);
  });
});

describe('module no-ops', () => {
  it('setModuleState returns {mutated: false}', () => {
    const proj = makeTmpProject();
    const r = setModuleState({ projectRoot: proj, name: 'mod-x', state: { any: 1 } });
    expect(r).toEqual({ mutated: false });
  });

  it('appendToModuleState returns {mutated: false}', () => {
    const proj = makeTmpProject();
    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      fieldPath: 'log',
      value: 'entry',
    });
    expect(r).toEqual({ mutated: false });
  });

  it('removeFromModuleState returns {mutated: false}', () => {
    const proj = makeTmpProject();
    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      fieldPath: 'log',
      value: 'entry',
    });
    expect(r).toEqual({ mutated: false });
  });

  it('registerModule returns {mutated: false}', () => {
    const proj = makeTmpProject();
    const r = registerModule({ projectRoot: proj, name: 'mod-x', manifest: {} });
    expect(r).toEqual({ mutated: false });
  });
});

describe('cache invalidation', () => {
  it('drops the resolved-config cache entry after a successful write', async () => {
    const proj = makeTmpProject();

    // Prime the cache.
    await getResolvedConfig({ projectRoot: proj });
    const cache = getResolvedConfigCache();
    const key = cacheKeyForProjectRoot(proj);
    expect(cache.get(key)).toBeDefined();

    // A successful write must invalidate.
    const r = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'lintCmd',
      value: 'npm run lint -- --fix',
    });
    expect(r.mutated).toBe(true);
    expect(cache.get(key)).toBeUndefined();
  });

  it('does not drop the cache entry on a failed write', async () => {
    const proj = makeTmpProject();
    await getResolvedConfig({ projectRoot: proj });
    const cache = getResolvedConfigCache();
    const key = cacheKeyForProjectRoot(proj);
    expect(cache.get(key)).toBeDefined();

    const r = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: 'lintCmd',
      value: { not: 'a-string' },
    });
    expect(r.mutated).toBe(false);
    // Cache survives because no persistence occurred.
    expect(cache.get(key)).toBeDefined();
  });
});

describe('input validation', () => {
  it('rejects an empty fieldPath via a MalformedInput issue (no throw)', () => {
    const proj = makeTmpProject();
    const r = updateStackField({
      projectRoot: proj,
      name: 'web-node',
      fieldPath: '',
      value: 'x',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues[0].code).toBe('MalformedInput');
    }
  });
});

describe('no temp file leftovers', () => {
  it('successful overlay write leaves no `*.tmp.*` siblings', () => {
    const proj = makeTmpProject();
    const overlayDir = path.join(proj, '.claude', 'gan');
    setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['x'],
    });
    const entries = readdirSync(overlayDir);
    expect(entries.filter((n: string) => n.includes('.tmp.'))).toEqual([]);
  });
});

describe('compose-if-absent + multi-write idempotency', () => {
  it('back-to-back set with the same value preserves bytes after the first write', () => {
    const proj = makeTmpProject();
    const overlayPath = path.join(proj, '.claude', 'gan', 'project.md');
    rmSync(overlayPath);

    const r1 = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['x'],
    });
    expect(r1.mutated).toBe(true);
    const after1 = readFileSync(overlayPath, 'utf8');

    const r2 = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['x'],
    });
    expect(r2.mutated).toBe(true);
    const after2 = readFileSync(overlayPath, 'utf8');
    // Same data → same bytes (yaml-block-writer's deep-equal short circuit
    // returns the original source untouched).
    expect(after2).toBe(after1);
  });
});

describe('writeFileSync escape hatch verification', () => {
  // This test guards the architectural rule rather than a behavior. If a
  // future change adds a raw `writeFileSync` call outside `atomic-write.ts`,
  // it should be deliberate. The grep for that lives in the verification
  // commands; here we just sanity-check that the writes module imports the
  // atomic helper (a smoke test against accidental regression).
  it('writes module references atomicWriteFile', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'config-server', 'tools', 'writes.ts'),
      'utf8',
    );
    expect(src).toContain('atomicWriteFile');
  });
});

describe('user-tier writes', () => {
  it('rejects setOverlayField on user tier for planner.additionalContext (C3 forbidden field)', () => {
    const proj = makeTmpProject();
    const userHome = mkdtempSync(path.join(tmpdir(), 'cas-userhome-'));
    tmpDirs.push(userHome);

    const r = setOverlayField(
      {
        projectRoot: proj,
        tier: 'user',
        fieldPath: 'planner.additionalContext',
        value: ['~/notes.md'],
      },
      { userHome },
    );
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MalformedInput',
          field: 'planner.additionalContext',
        }),
      );
    }
    // File must NOT have been created on disk.
    const userOverlay = path.join(userHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(false);
  });

  it('rejects setOverlayField on user tier for proposer.additionalContext (C3 forbidden field)', () => {
    const proj = makeTmpProject();
    const userHome = mkdtempSync(path.join(tmpdir(), 'cas-userhome-'));
    tmpDirs.push(userHome);

    const r = setOverlayField(
      {
        projectRoot: proj,
        tier: 'user',
        fieldPath: 'proposer.additionalContext',
        value: ['~/checks.md'],
      },
      { userHome },
    );
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MalformedInput',
          field: 'proposer.additionalContext',
        }),
      );
    }
    const userOverlay = path.join(userHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(false);
  });

  it('rejects setOverlayField on user tier for stack.override (C3 forbidden field)', () => {
    const proj = makeTmpProject();
    const userHome = mkdtempSync(path.join(tmpdir(), 'cas-userhome-'));
    tmpDirs.push(userHome);

    const r = setOverlayField(
      {
        projectRoot: proj,
        tier: 'user',
        fieldPath: 'stack.override',
        value: ['web-node'],
      },
      { userHome },
    );
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MalformedInput',
          field: 'stack.override',
        }),
      );
    }
    const userOverlay = path.join(userHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(false);
  });

  it('rejects setOverlayField on user tier for stack.cacheEnvOverride (C3 forbidden field)', () => {
    const proj = makeTmpProject();
    const userHome = mkdtempSync(path.join(tmpdir(), 'cas-userhome-'));
    tmpDirs.push(userHome);

    const r = setOverlayField(
      {
        projectRoot: proj,
        tier: 'user',
        fieldPath: 'stack.cacheEnvOverride',
        value: { 'web-node': { NODE_VERSION: '20' } },
      },
      { userHome },
    );
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MalformedInput',
          field: 'stack.cacheEnvOverride',
        }),
      );
    }
    const userOverlay = path.join(userHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(false);
  });
});

describe('project-tier writes for fields forbidden at user tier (regression guard)', () => {
  it('accepts setOverlayField on project tier for planner.additionalContext', () => {
    const proj = makeTmpProject();

    const r = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'planner.additionalContext',
      value: ['./notes.md'],
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === false && 'issues' in r) {
      // Defensive: should not contain a forbidden-field rejection.
      expect(
        r.issues.some(
          (i) => i.code === 'MalformedInput' && i.field === 'planner.additionalContext',
        ),
      ).toBe(false);
    }
    const projectOverlay = path.join(proj, '.claude', 'gan', 'project.md');
    expect(existsSync(projectOverlay)).toBe(true);
    expect(readFileSync(projectOverlay, 'utf8')).toContain('./notes.md');
  });

  it('accepts setOverlayField on project tier for proposer.additionalContext', () => {
    const proj = makeTmpProject();

    const r = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'proposer.additionalContext',
      value: ['./checks.md'],
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === false && 'issues' in r) {
      expect(
        r.issues.some(
          (i) => i.code === 'MalformedInput' && i.field === 'proposer.additionalContext',
        ),
      ).toBe(false);
    }
    const projectOverlay = path.join(proj, '.claude', 'gan', 'project.md');
    expect(existsSync(projectOverlay)).toBe(true);
    expect(readFileSync(projectOverlay, 'utf8')).toContain('./checks.md');
  });

  it('accepts setOverlayField on project tier for stack.override', () => {
    const proj = makeTmpProject();

    const r = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'stack.override',
      value: ['web-node'],
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === false && 'issues' in r) {
      expect(
        r.issues.some((i) => i.code === 'MalformedInput' && i.field === 'stack.override'),
      ).toBe(false);
    }
    const projectOverlay = path.join(proj, '.claude', 'gan', 'project.md');
    expect(existsSync(projectOverlay)).toBe(true);
    expect(readFileSync(projectOverlay, 'utf8')).toContain('web-node');
  });

  it('accepts setOverlayField on project tier for stack.cacheEnvOverride', () => {
    const proj = makeTmpProject();

    const r = setOverlayField({
      projectRoot: proj,
      tier: 'project',
      fieldPath: 'stack.cacheEnvOverride',
      value: { 'web-node': { NODE_VERSION: '20' } },
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === false && 'issues' in r) {
      expect(
        r.issues.some((i) => i.code === 'MalformedInput' && i.field === 'stack.cacheEnvOverride'),
      ).toBe(false);
    }
    const projectOverlay = path.join(proj, '.claude', 'gan', 'project.md');
    expect(existsSync(projectOverlay)).toBe(true);
    const written = readFileSync(projectOverlay, 'utf8');
    expect(written).toContain('NODE_VERSION');
  });

  it('appendToOverlayField on user tier also rejects a forbidden field (same persist path)', () => {
    const proj = makeTmpProject();
    const userHome = mkdtempSync(path.join(tmpdir(), 'cas-userhome-'));
    tmpDirs.push(userHome);

    const r = appendToOverlayField(
      {
        projectRoot: proj,
        tier: 'user',
        fieldPath: 'planner.additionalContext',
        value: '~/notes.md',
      },
      { userHome },
    );
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'issues' in r) {
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'MalformedInput',
          field: 'planner.additionalContext',
        }),
      );
    }
    const userOverlay = path.join(userHome, '.claude', 'gan', 'user.md');
    expect(existsSync(userOverlay)).toBe(false);
  });
});
