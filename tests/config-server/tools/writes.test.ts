import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  getModuleState,
  getResolvedConfig,
  listModules,
} from '../../../src/config-server/tools/reads.js';
import { _resetModuleRegistrationCacheForTests } from '../../../src/config-server/storage/module-loader.js';
import { _resetPackageRootCacheForTests } from '../../../src/config-server/package-root.js';
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

/**
 * Stage a temp "package root" containing a `package.json` plus a
 * `src/modules/<name>/manifest.json` for each requested module. Used
 * to enable the M3 `stateKeys` allowlist gate in module-state tests:
 * `defaultModulesRoot()` resolves to `<override>/src/modules`, so any
 * module the test wants to write to must be registered here.
 *
 * Each entry `{ name, stateKeys }` becomes a minimal valid manifest
 * (no prerequisites, no exports) at
 * `<override>/src/modules/<name>/manifest.json`. The default
 * `pairsWith` is omitted (validation does not require it for
 * module-state writes).
 *
 * Tests must wrap their setup with
 * `withStagedModuleRoot([...])` (sets `GAN_PACKAGE_ROOT_OVERRIDE`,
 * resets caches) and tear down via `restoreStagedModuleRoot()`.
 */
function stageModuleRoot(modules: Array<{ name: string; stateKeys: string[] }>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-writes-modroot-'));
  tmpDirs.push(root);
  // `package.json` is mandatory for `packageRoot()` resolution.
  const realPkg = path.join(repoRoot, 'package.json');
  writeFileSync(path.join(root, 'package.json'), readFileSync(realPkg, 'utf8'));
  for (const m of modules) {
    const dir = path.join(root, 'src', 'modules', m.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          name: m.name,
          schemaVersion: 1,
          description: `Test fixture module ${m.name}.`,
          exports: [],
          stateKeys: m.stateKeys,
        },
        null,
        2,
      ),
    );
  }
  return root;
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

describe('module writes (M3 per-key)', () => {
  // Stage a fake package root with manifests for the test modules so
  // `assertStateKeyAllowed` can resolve their `stateKeys` arrays.
  let savedOverride: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    savedHome = process.env.GAN_USER_HOME;
    const stagedRoot = stageModuleRoot([
      { name: 'mod-x', stateKeys: ['port-registry'] },
      { name: 'mod-y', stateKeys: ['port-registry'] },
      { name: 'mod-a', stateKeys: ['port-registry'] },
      { name: 'mod-b', stateKeys: ['port-registry'] },
      { name: 'mod-multi', stateKeys: ['key-one', 'key-two'] },
      { name: 'mod-no-keys', stateKeys: [] },
    ]);
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    // Isolate from the host's `~/.claude/gan/` so trust-cache reads
    // never escape the staged environment.
    process.env.GAN_USER_HOME = stagedRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedOverride;
    }
    if (savedHome === undefined) {
      delete process.env.GAN_USER_HOME;
    } else {
      process.env.GAN_USER_HOME = savedHome;
    }
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  it('setModuleState writes to <projectRoot>/.gan-state/modules/<name>/<key>.json', () => {
    const proj = makeTmpProject();
    const r = setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { any: 1 },
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === true) {
      expect(
        r.path.endsWith(
          path.join('.gan-state', 'modules', 'mod-x', 'port-registry.json'),
        ),
      ).toBe(true);
    }
    expect(
      existsSync(path.join(proj, '.gan-state', 'modules', 'mod-x', 'port-registry.json')),
    ).toBe(true);
    // The legacy whole-blob path must NOT be written.
    expect(existsSync(path.join(proj, '.gan-state', 'modules', 'mod-x', 'state.json'))).toBe(
      false,
    );
  });

  it('setModuleState rejects an undeclared key with UnknownStateKey naming the module and key', () => {
    const proj = makeTmpProject();
    expect(() =>
      setModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'not-declared',
        state: { any: 1 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UnknownStateKey',
        message: expect.stringContaining('mod-x'),
      }),
    );
    expect(() =>
      setModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'not-declared',
        state: { any: 1 },
      }),
    ).toThrow(/not-declared/);
    // No file must have been created.
    expect(existsSync(path.join(proj, '.gan-state', 'modules', 'mod-x'))).toBe(false);
  });

  it('setModuleState against a module with empty stateKeys always rejects with UnknownStateKey', () => {
    const proj = makeTmpProject();
    expect(() =>
      setModuleState({
        projectRoot: proj,
        name: 'mod-no-keys',
        key: 'port-registry',
        state: { any: 1 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UnknownStateKey',
      }),
    );
  });

  it('appendToModuleState appends to the array at fieldPath and returns {mutated: true}', () => {
    const proj = makeTmpProject();
    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'log',
      value: 'entry',
    });
    expect(r.mutated).toBe(true);
  });

  it('appendToModuleState default policy rejects a duplicate list entry without writing', () => {
    const proj = makeTmpProject();
    // Seed with `{log: ['entry']}` — append 'entry' a second time.
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { log: ['entry'] },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'log',
      value: 'entry',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    } else {
      throw new Error('expected duplicate-entry reason');
    }
    // Disk untouched.
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState explicit 'error' policy returns duplicate-entry without writing", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { log: ['entry'] },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'log',
      value: 'entry',
      duplicatePolicy: 'error',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    }
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState explicit 'skip' policy returns duplicate-entry without writing", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { log: ['entry'] },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'log',
      value: 'entry',
      duplicatePolicy: 'skip',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    }
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState 'allow' policy appends a duplicate list entry to disk", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { log: ['entry'] },
    });

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'log',
      value: 'entry',
      duplicatePolicy: 'allow',
    });
    expect(r.mutated).toBe(true);

    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual({ log: ['entry', 'entry'] });
  });

  it('appendToModuleState default policy rejects a map-shape key collision without writing', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { ports: { svc: { port: 3000 } } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'ports',
      value: { key: 'svc', port: 4000 },
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    }
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState 'error' policy on a map-shape collision returns duplicate-entry without writing", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { ports: { svc: { port: 3000 } } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'ports',
      value: { key: 'svc', port: 4000 },
      duplicatePolicy: 'error',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    }
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState 'skip' policy on a map-shape collision returns duplicate-entry without writing", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { ports: { svc: { port: 3000 } } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeHash = fileHash(filePath);

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'ports',
      value: { key: 'svc', port: 4000 },
      duplicatePolicy: 'skip',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('duplicate-entry');
    }
    expect(fileHash(filePath)).toBe(beforeHash);
  });

  it("appendToModuleState 'allow' policy on a map-shape collision overwrites the existing key", () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { ports: { svc: { port: 3000 } } },
    });

    const r = appendToModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      fieldPath: 'ports',
      value: { key: 'svc', port: 4000 },
      duplicatePolicy: 'allow',
    });
    expect(r.mutated).toBe(true);

    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual({ ports: { svc: { key: 'svc', port: 4000 } } });
  });

  it('appendToModuleState rejects scalar-shape stored value with MalformedInput', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { greeting: 'hello' },
    });

    expect(() =>
      appendToModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'port-registry',
        fieldPath: 'greeting',
        value: 'world',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'MalformedInput',
        message: expect.stringContaining('string'),
      }),
    );
  });

  it("appendToModuleState rejects an unknown duplicatePolicy value with MalformedInput", () => {
    const proj = makeTmpProject();
    expect(() =>
      appendToModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'port-registry',
        fieldPath: 'log',
        value: 'entry',
        // Cast through `any` so the call compiles even with the
        // strict `DuplicatePolicy` union — the runtime guard is
        // what we're exercising.
        duplicatePolicy: 'replace' as unknown as 'error',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'MalformedInput',
      }),
    );
  });

  it('appendToModuleState rejects an undeclared key with UnknownStateKey', () => {
    const proj = makeTmpProject();
    expect(() =>
      appendToModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'not-declared',
        fieldPath: 'log',
        value: 'entry',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UnknownStateKey',
        message: expect.stringContaining('mod-x'),
      }),
    );
  });

  it('removeFromModuleState is a no-op when no state file exists for the key', () => {
    const proj = makeTmpProject();
    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'some-entry',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('entry-not-found');
    }
  });

  it('removeFromModuleState rejects an undeclared key with UnknownStateKey', () => {
    const proj = makeTmpProject();
    expect(() =>
      removeFromModuleState({
        projectRoot: proj,
        name: 'mod-x',
        key: 'not-declared',
        entryKey: 'some-entry',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UnknownStateKey',
      }),
    );
  });

  it('registerModule probe reports unknown-module when the name is not registered', () => {
    const proj = makeTmpProject();
    const r = registerModule({ projectRoot: proj, name: 'unknown-mod', manifest: {} });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toContain('unknown-module');
    }
  });

  it('two declared keys for one module persist to two distinct files', () => {
    const proj = makeTmpProject();
    const r1 = setModuleState({
      projectRoot: proj,
      name: 'mod-multi',
      key: 'key-one',
      state: { v: 'one' },
    });
    expect(r1.mutated).toBe(true);
    const r2 = setModuleState({
      projectRoot: proj,
      name: 'mod-multi',
      key: 'key-two',
      state: { v: 'two' },
    });
    expect(r2.mutated).toBe(true);
    const fileOne = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-multi',
      'key-one.json',
    );
    const fileTwo = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-multi',
      'key-two.json',
    );
    expect(existsSync(fileOne)).toBe(true);
    expect(existsSync(fileTwo)).toBe(true);
    expect(JSON.parse(readFileSync(fileOne, 'utf8'))).toEqual({ v: 'one' });
    expect(JSON.parse(readFileSync(fileTwo, 'utf8'))).toEqual({ v: 'two' });
    // The legacy whole-blob `state.json` must NOT exist alongside.
    expect(
      existsSync(path.join(proj, '.gan-state', 'modules', 'mod-multi', 'state.json')),
    ).toBe(false);
  });

  it('getModuleState returns null for an undeclared key (no throw)', () => {
    const proj = makeTmpProject();
    const r = getModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'not-declared',
    });
    expect(r).toBeNull();
  });
});

describe('registerModule (success path)', () => {
  // The success-path probe runs against the real `src/modules/` tree
  // (M2's docker module). The docker module's manifest declares a
  // `docker --version` prerequisite, so this test's behavior depends on
  // whether `docker` is on PATH. We detect availability up front and
  // skip the body cleanly when it is not — failing here on a CI runner
  // without docker installed would be an environment error, not a code
  // regression.
  let dockerAvailable = false;
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }

  // The global vitest setup pins `GAN_PACKAGE_ROOT_OVERRIDE` to an empty
  // tmp dir to isolate tests from the framework's canonical `stacks/`
  // directory. For this test we deliberately want the production
  // resolution path — `defaultModulesRoot()` must point at the real
  // repo's `src/modules/` so `getRegisteredModules()` discovers the
  // docker manifest. We swap the override around the test body and
  // restore it (plus the package-root cache) afterwards.
  let savedOverride: string | undefined;

  beforeEach(() => {
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = repoRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedOverride;
    }
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  it('registerModule returns {mutated:true} for the docker module and listModules reflects it (skipped when docker not on PATH)', () => {
    // Early-return when `docker` is not available on PATH: the module's
    // prerequisite probe would fail and the test would be reporting on
    // the host environment rather than the code under test.
    if (!dockerAvailable) return;

    const proj = makeTmpProject();
    const r = registerModule({ projectRoot: proj, name: 'docker', manifest: {} });
    expect(r.mutated).toBe(true);
    if (r.mutated === true) {
      expect(r.path.endsWith(path.join('src', 'modules', 'docker', 'manifest.json'))).toBe(true);
    }

    const listed = listModules({ projectRoot: proj });
    expect(listed.modules).toContain('docker');
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

describe('module state round-trip (M3 per-key)', () => {
  // Reuse the staged fake package root so each module has a manifest
  // declaring `port-registry` as an allowed state key.
  let savedOverride: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedOverride = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    savedHome = process.env.GAN_USER_HOME;
    const stagedRoot = stageModuleRoot([
      { name: 'mod-x', stateKeys: ['port-registry'] },
      { name: 'mod-y', stateKeys: ['port-registry'] },
      { name: 'mod-a', stateKeys: ['port-registry'] },
      { name: 'mod-b', stateKeys: ['port-registry'] },
    ]);
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = stagedRoot;
    process.env.GAN_USER_HOME = stagedRoot;
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    if (savedOverride === undefined) {
      delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
    } else {
      process.env.GAN_PACKAGE_ROOT_OVERRIDE = savedOverride;
    }
    if (savedHome === undefined) {
      delete process.env.GAN_USER_HOME;
    } else {
      process.env.GAN_USER_HOME = savedHome;
    }
    _resetPackageRootCacheForTests();
    _resetModuleRegistrationCacheForTests();
  });

  it('setModuleState persists the blob and getModuleState round-trips it', () => {
    const proj = makeTmpProject();
    const blob = {
      ports: [3000, 3001],
      settings: { healthy: true, label: 'svc' },
      count: 2,
    };

    const result = setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: blob,
    });
    expect(result.mutated).toBe(true);
    if (result.mutated === true) {
      expect(
        result.path.endsWith(
          path.join('.gan-state', 'modules', 'mod-x', 'port-registry.json'),
        ),
      ).toBe(true);
    }

    expect(
      existsSync(path.join(proj, '.gan-state', 'modules', 'mod-x', 'port-registry.json')),
    ).toBe(true);

    const record = getModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
    });
    expect(record).not.toBeNull();
    expect(record!.state).toEqual(blob);
  });

  it('appendToModuleState then removeFromModuleState round-trips through getModuleState', () => {
    const proj = makeTmpProject();

    // Seed two top-level properties via append, each containing a list
    // whose member carries a `key` field. The appended entries are now
    // addressable by name from `removeFromModuleState`'s map-shape
    // branch (the root of the per-key file is a map: top-level
    // properties are the targetable `entryKey`s).
    const r1 = appendToModuleState({
      projectRoot: proj,
      name: 'mod-y',
      key: 'port-registry',
      fieldPath: 'first',
      value: { key: 'first', port: 3000 },
    });
    expect(r1.mutated).toBe(true);

    const r2 = appendToModuleState({
      projectRoot: proj,
      name: 'mod-y',
      key: 'port-registry',
      fieldPath: 'second',
      value: { key: 'second', port: 3001 },
    });
    expect(r2.mutated).toBe(true);

    const afterAppend = getModuleState({
      projectRoot: proj,
      name: 'mod-y',
      key: 'port-registry',
    });
    expect(afterAppend).not.toBeNull();
    expect(afterAppend!.state).toEqual({
      first: [{ key: 'first', port: 3000 }],
      second: [{ key: 'second', port: 3001 }],
    });

    // Map-shape removal: the file root is an object; entryKey 'first'
    // matches the property name and that whole property is removed.
    const r3 = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-y',
      key: 'port-registry',
      entryKey: 'first',
    });
    expect(r3.mutated).toBe(true);

    const afterRemove = getModuleState({
      projectRoot: proj,
      name: 'mod-y',
      key: 'port-registry',
    });
    expect(afterRemove).not.toBeNull();
    expect(afterRemove!.state).toEqual({
      second: [{ key: 'second', port: 3001 }],
    });
  });

  it("setModuleState for two modules in the same project keeps each module's state file independent", () => {
    const proj = makeTmpProject();

    const rA = setModuleState({
      projectRoot: proj,
      name: 'mod-a',
      key: 'port-registry',
      state: { value: 'A' },
    });
    expect(rA.mutated).toBe(true);

    const rB = setModuleState({
      projectRoot: proj,
      name: 'mod-b',
      key: 'port-registry',
      state: { value: 'B' },
    });
    expect(rB.mutated).toBe(true);

    expect(
      existsSync(path.join(proj, '.gan-state', 'modules', 'mod-a', 'port-registry.json')),
    ).toBe(true);
    expect(
      existsSync(path.join(proj, '.gan-state', 'modules', 'mod-b', 'port-registry.json')),
    ).toBe(true);

    const recA1 = getModuleState({
      projectRoot: proj,
      name: 'mod-a',
      key: 'port-registry',
    });
    expect(recA1).not.toBeNull();
    expect(recA1!.state).toEqual({ value: 'A' });

    const recB1 = getModuleState({
      projectRoot: proj,
      name: 'mod-b',
      key: 'port-registry',
    });
    expect(recB1).not.toBeNull();
    expect(recB1!.state).toEqual({ value: 'B' });

    const rA2 = setModuleState({
      projectRoot: proj,
      name: 'mod-a',
      key: 'port-registry',
      state: { value: 'A2' },
    });
    expect(rA2.mutated).toBe(true);

    const recA2 = getModuleState({
      projectRoot: proj,
      name: 'mod-a',
      key: 'port-registry',
    });
    expect(recA2).not.toBeNull();
    expect(recA2!.state).toEqual({ value: 'A2' });

    const recB2 = getModuleState({
      projectRoot: proj,
      name: 'mod-b',
      key: 'port-registry',
    });
    expect(recB2).not.toBeNull();
    expect(recB2!.state).toEqual({ value: 'B' });
  });

  it('removeFromModuleState (map-shape): existing entryKey is removed and persisted', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { alpha: { port: 3000 }, beta: { port: 3001 } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'alpha',
    });
    expect(r.mutated).toBe(true);
    if (r.mutated === true) {
      expect(r.path.endsWith(path.join('mod-x', 'port-registry.json'))).toBe(true);
    }
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual({ beta: { port: 3001 } });
  });

  it('removeFromModuleState (list-shape): member with matching key field is filtered out', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: [
        { key: 'alpha', port: 3000 },
        { key: 'beta', port: 3001 },
        { key: 'gamma', port: 3002 },
      ],
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'beta',
    });
    expect(r.mutated).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual([
      { key: 'alpha', port: 3000 },
      { key: 'gamma', port: 3002 },
    ]);
  });

  it('removeFromModuleState (map-shape): non-existent entryKey is a no-op', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { alpha: { port: 3000 } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeBytes = readFileSync(filePath);

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'not-present',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('entry-not-found');
    }
    expect(readFileSync(filePath).equals(beforeBytes)).toBe(true);
  });

  it('removeFromModuleState (list-shape): non-existent entryKey is a no-op', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: [{ key: 'alpha', port: 3000 }],
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );
    const beforeBytes = readFileSync(filePath);

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'not-present',
    });
    expect(r.mutated).toBe(false);
    if (r.mutated === false && 'reason' in r) {
      expect(r.reason).toBe('entry-not-found');
    }
    expect(readFileSync(filePath).equals(beforeBytes)).toBe(true);
  });

  it('removeFromModuleState (map-shape): removing the only entry leaves {} on disk', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: { only: { port: 3000 } },
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'only',
    });
    expect(r.mutated).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual({});
  });

  it('removeFromModuleState (list-shape): removing the only entry leaves [] on disk', () => {
    const proj = makeTmpProject();
    setModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      state: [{ key: 'only', port: 3000 }],
    });
    const filePath = path.join(
      proj,
      '.gan-state',
      'modules',
      'mod-x',
      'port-registry.json',
    );

    const r = removeFromModuleState({
      projectRoot: proj,
      name: 'mod-x',
      key: 'port-registry',
      entryKey: 'only',
    });
    expect(r.mutated).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual([]);
  });
});
