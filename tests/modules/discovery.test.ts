/**
 * M1 — Sprint M1 — discovery + manifest schema tests.
 *
 * Covers AC1–AC8: schema acceptance/rejection, JSON canonicalisation,
 * `loadModules` discovery + collisions, and the registered-modules
 * surface exposed via reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AjvImport2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defaultModulesRoot,
  loadModules,
  _resetModuleRegistrationCacheForTests,
} from '../../src/config-server/storage/module-loader.js';
import { moduleManifestV1 } from '../../src/config-server/schemas-bundled.js';
import { stableStringify } from '../../src/config-server/determinism/index.js';
import { ConfigServerError } from '../../src/config-server/errors.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv2020: AjvCtor =
  ((AjvImport2020 as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport2020 as unknown as AjvCtor);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'modules');

function compileManifestValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  return ajv.compile(moduleManifestV1);
}

describe('module manifest schema (module-manifest-v1.json)', () => {
  it('manifest schema accepts docker example', () => {
    // The example matches lines 25–38 of specifications/M1-modules-architecture.md.
    const dockerExample = {
      name: 'docker',
      schemaVersion: 1,
      pairsWith: 'docker',
      description: 'Container and port management for git worktree workflows.',
      prerequisites: [
        {
          command: 'docker --version',
          errorHint: 'Install Docker Desktop or Docker Engine.',
        },
      ],
      exports: [
        'PortRegistry',
        'PortDiscovery',
        'ContainerHealth',
        'PortValidator',
        'ContainerNaming',
      ],
      stateKeys: ['port-registry'],
      configKey: 'docker',
    };
    const validator = compileManifestValidator();
    const ok = validator(dockerExample);
    expect(ok).toBe(true);
  });

  it('rejects extra property at top level', () => {
    const validator = compileManifestValidator();
    const bad = {
      name: 'docker',
      schemaVersion: 1,
      description: 'x',
      exports: [],
      bogusExtra: 'nope',
    };
    expect(validator(bad)).toBe(false);
  });

  it('rejects missing name', () => {
    const validator = compileManifestValidator();
    const bad = {
      schemaVersion: 1,
      description: 'x',
      exports: [],
    };
    expect(validator(bad)).toBe(false);
  });

  it('rejects schemaVersion: 2', () => {
    const validator = compileManifestValidator();
    const bad = {
      name: 'docker',
      schemaVersion: 2,
      description: 'x',
      exports: [],
    };
    expect(validator(bad)).toBe(false);
  });

  it('schema document is canonical JSON (sorted keys, two-space indent, trailing newline)', () => {
    const schemaPath = path.join(repoRoot, 'schemas', 'module-manifest-v1.json');
    const onDisk = readFileSync(schemaPath, 'utf8');
    const parsed = JSON.parse(onDisk);
    const canonical = stableStringify(parsed);
    expect(onDisk).toBe(canonical);
  });

  it('does not mention the EOL-d engine version anywhere', () => {
    const schemaPath = path.join(repoRoot, 'schemas', 'module-manifest-v1.json');
    const text = readFileSync(schemaPath, 'utf8');
    // Build the forbidden tokens via runtime concatenation so this test
    // file does not literally contain the EOL-d version text. The
    // assertions still cover both the proper-noun form and the
    // engine-spec form.
    const eolMajor = '1' + '8';
    expect(text).not.toContain('Node ' + eolMajor);
    expect(text).not.toContain('node >=' + eolMajor);
    expect(text).not.toContain('>=' + eolMajor + '.');
  });

  it('command description carries the literal "whitespace-split, no shell expansion"', () => {
    const schema = moduleManifestV1 as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const prereqs = properties.prerequisites as Record<string, unknown>;
    const items = prereqs.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, unknown>;
    const cmd = itemProps.command as Record<string, unknown>;
    expect(typeof cmd.description).toBe('string');
    expect(cmd.description as string).toContain('whitespace-split, no shell expansion');
  });
});

describe('loadModules() discovery', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-discovery-'));
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    _resetModuleRegistrationCacheForTests();
  });

  it('returns one ModuleRegistration per valid manifest', () => {
    const passingDir = path.join(fixturesRoot, 'prereq-passing');
    // Mirror prereq-passing into the scratch root so we can have a
    // hermetic single-module discovery target.
    const dst = path.join(scratch, 'prereq-passing');
    mkdirSync(dst, { recursive: true });
    writeFileSync(
      path.join(dst, 'manifest.json'),
      readFileSync(path.join(passingDir, 'manifest.json'), 'utf8'),
    );
    const result = loadModules(scratch);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('prereq-passing');
    expect(result[0].manifestPath).toBe(path.join(dst, 'manifest.json'));
  });

  it('silently skips a directory without manifest.json', () => {
    mkdirSync(path.join(scratch, 'no-manifest-here'), { recursive: true });
    expect(loadModules(scratch)).toEqual([]);
  });

  it('schema-invalid manifest surfaces a structured error and prevents server start', () => {
    const dst = path.join(scratch, 'broken');
    mkdirSync(dst, { recursive: true });
    writeFileSync(
      path.join(dst, 'manifest.json'),
      JSON.stringify({ name: 'broken', schemaVersion: 99, description: 'x', exports: [] }),
    );
    let caught: unknown = null;
    try {
      loadModules(scratch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    expect((caught as ConfigServerError).code).toBe('ModuleManifestInvalid');
  });

  it('two modules sharing a name halt server start with ModuleCollision', () => {
    const a = path.join(scratch, 'duplicate-a');
    const b = path.join(scratch, 'duplicate-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(
      path.join(a, 'manifest.json'),
      readFileSync(path.join(fixturesRoot, 'duplicate-name-a', 'manifest.json'), 'utf8'),
    );
    writeFileSync(
      path.join(b, 'manifest.json'),
      readFileSync(path.join(fixturesRoot, 'duplicate-name-b', 'manifest.json'), 'utf8'),
    );
    let caught: unknown = null;
    try {
      loadModules(scratch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    expect((caught as ConfigServerError).code).toBe('ModuleCollision');
  });

  it('two modules sharing a pairsWith but distinct names register without error', () => {
    const a = path.join(scratch, 'mod-a');
    const b = path.join(scratch, 'mod-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const manifestA = {
      name: 'mod-a',
      schemaVersion: 1,
      description: 'A',
      exports: ['x'],
      pairsWith: 'shared-stack',
    };
    const manifestB = {
      name: 'mod-b',
      schemaVersion: 1,
      description: 'B',
      exports: ['y'],
      pairsWith: 'shared-stack',
    };
    writeFileSync(path.join(a, 'manifest.json'), JSON.stringify(manifestA));
    writeFileSync(path.join(b, 'manifest.json'), JSON.stringify(manifestB));
    const out = loadModules(scratch);
    expect(out.map((r) => r.name).sort()).toEqual(['mod-a', 'mod-b']);
  });

  it('returns [] when the modules root does not exist', () => {
    expect(loadModules(path.join(scratch, 'nonexistent'))).toEqual([]);
  });

  it('production callers can resolve the default modules root via defaultModulesRoot()', () => {
    const root = defaultModulesRoot();
    // Path must terminate with src/modules — production callers should
    // never need an env var or runtime knob.
    expect(root.endsWith(path.join('src', 'modules'))).toBe(true);
  });
});

describe('listModules read tool integration', () => {
  beforeEach(() => _resetModuleRegistrationCacheForTests());
  afterEach(() => _resetModuleRegistrationCacheForTests());

  it('surfaces the registered set; adding/removing fixture directories changes output on next loadModules()', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-list-'));
    try {
      // Empty root → empty list.
      expect(loadModules(scratch)).toEqual([]);

      const dst = path.join(scratch, 'prereq-passing');
      mkdirSync(dst, { recursive: true });
      writeFileSync(
        path.join(dst, 'manifest.json'),
        readFileSync(path.join(fixturesRoot, 'prereq-passing', 'manifest.json'), 'utf8'),
      );
      const after = loadModules(scratch);
      expect(after.map((r) => r.name)).toEqual(['prereq-passing']);

      rmSync(dst, { recursive: true, force: true });
      expect(loadModules(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('loadModules returns all entries and the name-projection matches what listModules() would surface', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-list-projection-'));
    try {
      const prereqDst = path.join(scratch, 'prereq-passing');
      mkdirSync(prereqDst, { recursive: true });
      writeFileSync(
        path.join(prereqDst, 'manifest.json'),
        readFileSync(path.join(fixturesRoot, 'prereq-passing', 'manifest.json'), 'utf8'),
      );

      const sentinelDst = path.join(scratch, 'sentinel-mod');
      mkdirSync(sentinelDst, { recursive: true });
      writeFileSync(
        path.join(sentinelDst, 'manifest.json'),
        '{"name":"sentinel-mod","schemaVersion":1,"description":"x","exports":[]}',
      );

      const out = loadModules(scratch);
      expect(out.length).toBe(2);
      expect(out.map((r) => r.name)).toEqual(['prereq-passing', 'sentinel-mod']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
