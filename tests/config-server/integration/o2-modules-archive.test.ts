/**
 * M1 — Sprint M1 — O2 archive non-interference (AC14).
 *
 * Per F1 + O2: the recovery flow must never touch
 * `.gan-state/modules/<name>/` durable state. R1 ships no archive
 * implementation yet (recovery semantics live alongside O2's recovery
 * code, which is post-M1 work), so the strongest guard we can run today
 * is: every module-touching API surface (validateAll, listModules,
 * setModuleState, registerModule probe) and the closest the framework
 * has to a "recovery flow" against a project must leave the bytes
 * under `.gan-state/modules/` untouched.
 *
 * Test pipeline:
 *
 *   1. Create a scratch project root.
 *   2. Write random bytes to
 *      `<scratch>/.gan-state/modules/<fixture>/probe.bin`.
 *   3. Compute SHA-256 of the probe bytes.
 *   4. Run every module-related read/write surface against the scratch
 *      root, plus a `validateAll` pass.
 *   5. Compute SHA-256 again.
 *   6. Assert byte-identical pre/post.
 */

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
    // F8: durable module state now lives in the repo-keyed store, not under
    // `<scratch>/.gan-state/modules`. Make `scratch` a real repo, scope the
    // store, and write the probe at the relocated module-state location so the
    // byte-inviolate guard targets the live durable home.
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
    // M3 allowlist gate: `unrelated-module` is not registered so the
    // call rejects with `UnknownStateKey` before any I/O. The probe
    // bytes are unaffected either way — guarding the throw here keeps
    // the surface assertion (no probe-byte mutation) intact.
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
