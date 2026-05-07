/**
 * M1 — Sprint M1 — barrel-prereq lifecycle tests.
 *
 * Covers AC12 + AC13: prerequisite commands run via execFileSync (no
 * shell), errorHint is reachable on failure, the prereq-passing fixture
 * loads cleanly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadModules,
  _resetModuleRegistrationCacheForTests,
} from '../../src/config-server/storage/module-loader.js';
import { ConfigServerError } from '../../src/config-server/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'modules');

describe('module barrel prerequisite lifecycle', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'm1-lifecycle-'));
    _resetModuleRegistrationCacheForTests();
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    _resetModuleRegistrationCacheForTests();
  });

  function copyFixtureModule(name: string): string {
    const src = path.join(fixturesRoot, name);
    const dst = path.join(scratch, name);
    mkdirSync(dst, { recursive: true });
    writeFileSync(
      path.join(dst, 'manifest.json'),
      readFileSync(path.join(src, 'manifest.json'), 'utf8'),
    );
    return dst;
  }

  it('prereq-passing fixture: load succeeds, manifest registered', () => {
    copyFixtureModule('prereq-passing');
    const out = loadModules(scratch);
    expect(out.map((r) => r.name)).toEqual(['prereq-passing']);
    expect(out[0].manifest.prerequisites?.[0].command).toBe('node --version');
  });

  it('prereq-failing fixture: throws structured error containing the manifest errorHint', () => {
    copyFixtureModule('prereq-failing');
    let caught: unknown = null;
    try {
      loadModules(scratch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    const err = caught as ConfigServerError;
    expect(err.code).toBe('ModulePrerequisiteFailed');
    // AC13: the literal errorHint sentinel must be reachable in the
    // thrown error's message.
    expect(err.message).toContain('DOCKER_HINT_FIXTURE');
    // Also reachable via details.errorHint (AC12 surface contract).
    expect((err as unknown as { errorHint?: string }).errorHint).toBe('DOCKER_HINT_FIXTURE');
  });

  it('does not invoke a shell — command is whitespace-split and dispatched via execFileSync', () => {
    // We craft a manifest whose command relies on shell features
    // (`$(...)` substitution). If a shell were used, the substitution
    // would expand and the prereq would pass. With execFileSync +
    // whitespace-split the literal `$(false)` becomes the second
    // argument to the binary, which fails.
    const dir = path.join(scratch, 'no-shell-probe');
    mkdirSync(dir, { recursive: true });
    const manifest = {
      name: 'no-shell-probe',
      schemaVersion: 1,
      description: 'probe',
      exports: [],
      prerequisites: [
        {
          command: 'node --eval $(false)',
          errorHint: 'NO_SHELL_PROBE_HINT',
        },
      ],
    };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    let caught: unknown = null;
    try {
      loadModules(scratch);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigServerError);
    expect((caught as ConfigServerError).code).toBe('ModulePrerequisiteFailed');
    expect((caught as ConfigServerError).message).toContain('NO_SHELL_PROBE_HINT');
  });
});
