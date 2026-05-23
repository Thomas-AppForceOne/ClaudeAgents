

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { getModuleState, listModules } from '../../../src/config-server/tools/reads.js';
import { setModuleState, registerModule } from '../../../src/config-server/tools/writes.js';
import {
  _resetModuleRegistrationCacheForTests,
  moduleStatePath,
} from '../../../src/config-server/storage/module-loader.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import {
  initGitRepo,
  useTempModuleStateStore,
  type ModuleStateStoreScope,
} from '../../helpers/module-state-store.js';

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe('O2 archive non-interference: repo-keyed module-state bytes are inviolate', () => {
  let scratch: string;
  let probePath: string;
  let preHash: string;
  let store: ModuleStateStoreScope;

  beforeEach(() => {
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-o2-archive-'));

    initGitRepo(scratch);
    store = useTempModuleStateStore();
    probePath = moduleStatePath(scratch, 'fixture-probe', 'probe');
    mkdirSync(path.dirname(probePath), { recursive: true });
    writeFileSync(probePath, randomBytes(4096));
    preHash = sha256OfFile(probePath);
  });

  afterEach(() => {
    store.restore();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(store.storeRoot, { recursive: true, force: true });
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
  });

  it('validateAll does not mutate probe bytes', () => {
    validateAll({ projectRoot: scratch });
    expect(sha256OfFile(probePath)).toBe(preHash);
  });

  it('listModules does not mutate probe bytes', () => {
    listModules({ projectRoot: scratch });
    expect(sha256OfFile(probePath)).toBe(preHash);
  });

  it('getModuleState for a different module does not mutate probe bytes', () => {
    getModuleState({ projectRoot: scratch, name: 'unrelated-module', key: 'port-registry' });
    expect(sha256OfFile(probePath)).toBe(preHash);
  });

  it('setModuleState for an unrelated module does not mutate the probe bytes', () => {

    try {
      setModuleState({
        projectRoot: scratch,
        name: 'unrelated-module',
        key: 'port-registry',
        state: { v: 1 },
      });
    } catch {
      // Expected under M3.
    }
    expect(sha256OfFile(probePath)).toBe(preHash);
  });

  it('registerModule probe does not mutate probe bytes', () => {
    registerModule({
      projectRoot: scratch,
      name: 'unknown-module',
      manifest: {},
    });
    expect(sha256OfFile(probePath)).toBe(preHash);
  });

  it('full pipeline (every surface in sequence) leaves probe bytes byte-identical', () => {
    validateAll({ projectRoot: scratch });
    listModules({ projectRoot: scratch });
    getModuleState({ projectRoot: scratch, name: 'unrelated-module', key: 'port-registry' });
    try {
      setModuleState({
        projectRoot: scratch,
        name: 'unrelated-module',
        key: 'port-registry',
        state: { v: 1 },
      });
    } catch {
      // Expected under M3 (unregistered module).
    }
    registerModule({
      projectRoot: scratch,
      name: 'unknown-module',
      manifest: {},
    });
    expect(sha256OfFile(probePath)).toBe(preHash);
  });
});
