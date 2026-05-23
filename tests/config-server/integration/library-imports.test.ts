
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Lib from '../../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const READ_TOOLS = [
  'getApiVersion',
  'getResolvedConfig',
  'getStack',
  'getActiveStacks',
  'getOverlay',
  'getMergedSplicePoints',
  'getModuleState',
  'listModules',
  'getStackResolution',
  'getTrustState',
  'getTrustDiff',
] as const;

const WRITE_TOOLS = [
  'setOverlayField',
  'appendToOverlayField',
  'removeFromOverlayField',
  'updateStackField',
  'appendToStackField',
  'removeFromStackField',
  'setModuleState',
  'appendToModuleState',
  'removeFromModuleState',
  'registerModule',
  'trustApprove',
  'trustRevoke',
] as const;

const VALIDATE_TOOLS = ['validateAll', 'validateStack', 'validateOverlay'] as const;

describe('integration: library imports from src/index.ts', () => {
  it('every read function is exported and callable', () => {
    for (const name of READ_TOOLS) {
      const fn = (Lib as Record<string, unknown>)[name];
      expect(typeof fn).toBe('function');
    }
  });

  it('every write function is exported and callable', () => {
    for (const name of WRITE_TOOLS) {
      const fn = (Lib as Record<string, unknown>)[name];
      expect(typeof fn).toBe('function');
    }
  });

  it('every validate function is exported and callable', () => {
    for (const name of VALIDATE_TOOLS) {
      const fn = (Lib as Record<string, unknown>)[name];
      expect(typeof fn).toBe('function');
    }
  });

  it('a read function invoked via the library returns a structured result', async () => {
    const r = await Lib.getResolvedConfig({ projectRoot: jsTsMinimal });
    expect(r.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.schemaVersions).toEqual({ stack: 1, overlay: 1 });
  });

  it('validateAll invoked via the library returns the {issues} envelope', () => {
    const r = Lib.validateAll({ projectRoot: jsTsMinimal });
    expect(Array.isArray(r.issues)).toBe(true);
    expect(r.issues).toEqual([]);
  });
});
