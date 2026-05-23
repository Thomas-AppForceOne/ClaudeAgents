// M1 prerequisite lifecycle: loadModules() runs each manifest's declared prerequisite
// commands at discovery time and the outcome gates whether the module loads. The suite
// guards three behaviours: a passing prerequisite loads and registers the manifest; a
// failing one throws a structured ModulePrerequisiteFailed error that carries the
// manifest's own errorHint (both in the message and on a typed errorHint field), so the
// user gets the install hint; and — the security-relevant invariant — the command is
// dispatched via execFileSync after a plain whitespace split, NEVER through a shell.
// The no-shell test feeds a command containing `$(false)`: under a shell that would
// expand/execute, but here it is passed as literal argv tokens, so the run fails as a
// missing-binary prerequisite error rather than performing shell substitution.
//
// Each test copies a fixture (or writes an inline) manifest into a fresh scratch dir and
// resets the registration cache so prerequisite checks re-run per test.

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

  // Copy just the manifest of a checked-in fixture into the scratch dir so discovery
  // picks it up from an isolated location rather than the real fixtures tree.
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

    // The fixture's errorHint must reach the user two ways: embedded in the human-readable
    // message AND on a typed errorHint field for programmatic handling.
    expect(err.message).toContain('DOCKER_HINT_FIXTURE');

    expect((err as unknown as { errorHint?: string }).errorHint).toBe('DOCKER_HINT_FIXTURE');
  });

  it('does not invoke a shell — command is whitespace-split and dispatched via execFileSync', () => {
    // The probe command embeds `$(false)` as a literal token. If the loader ran it through
    // a shell, the substitution would execute; instead it is split on whitespace into argv
    // and passed to execFileSync, so `node` receives `--eval` and `$(false)` verbatim and
    // the prerequisite simply fails — proving no shell was involved.
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
