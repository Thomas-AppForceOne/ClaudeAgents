// Pins how composeResolvedConfig (R5 S3) surfaces runtimeMode. The only field
// today is noProjectCommands, and the contract is: it mirrors the
// ComposeContext flag, defaulting to false when the flag is omitted. The
// explicit-false case is kept distinct from the omitted case to guard against a
// regression where "false" and "absent" might be conflated differently.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeResolvedConfigSync } from '../../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const jsTsMinimal = path.join(fixturesRoot, 'js-ts-minimal');

describe('ResolvedConfig.runtimeMode (R5 S3)', () => {
  beforeEach(() => clearResolvedConfigCache());
  afterEach(() => clearResolvedConfigCache());

  it('defaults runtimeMode.noProjectCommands to false when ComposeContext omits the flag', () => {
    const r = composeResolvedConfigSync(jsTsMinimal, '0.1.0');
    expect(r.runtimeMode).toEqual({ noProjectCommands: false });
  });

  it('mirrors ComposeContext.noProjectCommands=true onto runtimeMode.noProjectCommands', () => {
    const r = composeResolvedConfigSync(jsTsMinimal, '0.1.0', { noProjectCommands: true });
    expect(r.runtimeMode).toEqual({ noProjectCommands: true });
  });

  it('explicit ComposeContext.noProjectCommands=false also yields false', () => {
    const r = composeResolvedConfigSync(jsTsMinimal, '0.1.0', { noProjectCommands: false });
    expect(r.runtimeMode).toEqual({ noProjectCommands: false });
  });
});
