// Conformance suite for the shipped docker module manifest (src/modules/docker/
// manifest.json). It guards the contract every other docker test assumes: the
// manifest validates against module-manifest-v1.json, declares the expected identity
// (name=docker, schemaVersion=1, pairsWith=docker), carries a non-empty errorHint on
// its `docker --version` prerequisite (so a missing-docker failure stays actionable),
// and lists EXACTLY the five public exports. This is the on-disk source of truth, so
// drift between the manifest and the module's real surface is caught here rather than
// surfacing as a confusing barrel-load failure elsewhere.

import AjvImport2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { moduleManifestV1 } from '../../../src/config-server/schemas-bundled.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv2020: AjvCtor =
  ((AjvImport2020 as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport2020 as unknown as AjvCtor);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const manifestPath = path.join(repoRoot, 'src', 'modules', 'docker', 'manifest.json');

describe('docker manifest', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  it('validates against module-manifest-v1.json', () => {
    // strict + allErrors so a malformed manifest reports every violation at once; on
    // failure the serialized ajv errors are thrown to make the diagnostic actionable.
    const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
    const v = ajv.compile(moduleManifestV1);
    const ok = v(manifest);
    if (!ok) {
      throw new Error(`schema errors: ${JSON.stringify(v.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('declares name=docker, schemaVersion=1, pairsWith=docker', () => {
    expect(manifest.name).toBe('docker');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pairsWith).toBe('docker');
  });

  it('declares prerequisite docker --version with non-empty errorHint', () => {
    const prereqs = manifest.prerequisites as Array<{ command: string; errorHint: string }>;
    expect(Array.isArray(prereqs)).toBe(true);
    expect(prereqs.length).toBeGreaterThanOrEqual(1);
    expect(prereqs[0].command).toBe('docker --version');
    expect(typeof prereqs[0].errorHint).toBe('string');
    expect(prereqs[0].errorHint.length).toBeGreaterThan(0);
  });

  it('lists exactly the five exports', () => {
    const exports = manifest.exports as string[];
    expect(Array.isArray(exports)).toBe(true);
    // Compare on a sorted copy so declaration order in the manifest is irrelevant;
    // the trailing length check pins the count so neither additions nor drops slip by.
    expect(exports.slice().sort()).toEqual(
      ['ContainerHealth', 'ContainerNaming', 'PortDiscovery', 'PortRegistry', 'PortValidator'].sort(),
    );
    expect(exports).toHaveLength(5);
  });
});
