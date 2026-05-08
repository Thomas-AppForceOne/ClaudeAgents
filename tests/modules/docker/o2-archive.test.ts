/**
 * M2 — O2 archive non-interference (AC14).
 *
 * Writes deterministic content to the docker module's M3-owned per-key
 * state file at `<scratch>/.gan-state/modules/docker/port-registry.json`,
 * runs the O2-style recovery surfaces (every module-touching API + validateAll),
 * and asserts SHA-256 byte-equality pre/post. The recovery flow must
 * leave docker module state untouched per F1 + O2 semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

describe('O2 archive non-interference: docker module state bytes are inviolate', () => {
  let scratch: string;
  let statePath: string;
  let preHash: string;
  // Deterministic content. The contract requires deterministic; we
  // use a stable JSON literal so reruns produce the same hash.
  const deterministicContent =
    '{\n  "entries": {\n    "/canonical/worktree-a": {\n      "containerName": "app-a",\n      "port": 8080\n    }\n  },\n  "version": 1\n}\n';

  beforeEach(() => {
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm2-o2-archive-'));
    // M3 per-key path: `<scratch>/.gan-state/modules/docker/port-registry.json`.
    statePath = moduleStatePath(scratch, 'docker', 'port-registry');
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, deterministicContent);
    preHash = sha256OfFile(statePath);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    _resetModuleRegistrationCacheForTests();
    clearResolvedConfigCache();
  });

  it('validateAll does not mutate docker module state bytes', () => {
    validateAll({ projectRoot: scratch });
    expect(sha256OfFile(statePath)).toBe(preHash);
  });

  it('listModules does not mutate docker module state bytes', () => {
    listModules({ projectRoot: scratch });
    expect(sha256OfFile(statePath)).toBe(preHash);
  });

  it('getModuleState for an unrelated module does not mutate docker module state bytes', () => {
    getModuleState({ projectRoot: scratch, name: 'unrelated-module', key: 'port-registry' });
    expect(sha256OfFile(statePath)).toBe(preHash);
  });

  it('setModuleState for an unrelated module does not mutate docker module state bytes', () => {
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
    expect(sha256OfFile(statePath)).toBe(preHash);
  });

  it('registerModule probe does not mutate docker module state bytes', () => {
    registerModule({ projectRoot: scratch, name: 'unknown', manifest: {} });
    expect(sha256OfFile(statePath)).toBe(preHash);
  });

  it('full O2-style pipeline leaves docker module state byte-identical', () => {
    validateAll({ projectRoot: scratch });
    listModules({ projectRoot: scratch });
    getModuleState({ projectRoot: scratch, name: 'unrelated', key: 'port-registry' });
    try {
      setModuleState({
        projectRoot: scratch,
        name: 'unrelated',
        key: 'port-registry',
        state: { v: 1 },
      });
    } catch {
      // Expected under M3 (unregistered module).
    }
    registerModule({ projectRoot: scratch, name: 'unknown', manifest: {} });
    expect(sha256OfFile(statePath)).toBe(preHash);
  });
});
