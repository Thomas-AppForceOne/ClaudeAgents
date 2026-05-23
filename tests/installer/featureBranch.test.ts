/**
 * Coverage for the S3 feature-branch warning: when the framework repo is itself
 * checked out on the in-progress `feature/stack-plugin-rfc` branch, install.sh
 * warns the user the install may be mid-pivot / not functional.
 *
 * What this verifies: with git stubbed to report that branch name, the warning
 * fires on stdout naming the branch and flagging it as mid-pivot/not-functional
 * (AC8); and statically, that the trigger is a hardcoded literal in install.sh
 * with NO env-var override knob (AC9).
 *
 * What it guards (WHY): the warning must not be silently disable-able. AC9
 * forbids any `FEATURE_BRANCH`/`GAN_BRANCH`/`BRANCH_OVERRIDE` escape hatch, so a
 * user can't accidentally (or be tricked into) suppressing the "this build is
 * unfinished" notice. The branch name in the stubbed git body is DATA.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInstall, repoRootDir, installScriptPath } from './helpers/spawn.js';
import { makeTmpHome, writeStubBin, type TmpHome } from './helpers/tmpenv.js';
import { writeFakeNpm, writeFakeConfigServer, npmInvocationLog } from './helpers/fakeNpm.js';

const cleanups: TmpHome[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c.cleanup();
  }
});

function packageVersion(): string {
  const raw = readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

describe('install.sh — S3 feature-branch warning', () => {
  it('S3-AC8: warning fires when fake git reports `feature/stack-plugin-rfc`', async () => {
    const tmp = makeTmpHome({ withRepo: true });
    cleanups.push(tmp);
    const v = packageVersion();

    // Stub git so `rev-parse --abbrev-ref HEAD` (both the `-C <dir>` and bare
    // forms the installer may use) reports the in-progress feature branch,
    // triggering the warning; all other git calls pass through to the real one.
    writeStubBin(
      tmp.bin,
      'git',
      [
        `if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--abbrev-ref" ] && [ "$5" = "HEAD" ]; then`,
        `  printf '%s\\n' "feature/stack-plugin-rfc"`,
        `  exit 0`,
        `fi`,
        `if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ] && [ "$3" = "HEAD" ]; then`,
        `  printf '%s\\n' "feature/stack-plugin-rfc"`,
        `  exit 0`,
        `fi`,
        `exec /usr/bin/git "$@"`,
      ].join('\n'),
    );
    const hostNode = process.execPath;
    writeStubBin(
      tmp.bin,
      'node',
      [
        `if [ "$1" = "--version" ]; then`,
        `  printf '%s\\n' "v20.10.0"`,
        `  exit 0`,
        `fi`,
        `exec ${JSON.stringify(hostNode)} "$@"`,
      ].join('\n'),
    );
    writeStubBin(tmp.bin, 'claude', 'exit 0');
    writeFakeConfigServer(tmp.bin, { version: v });
    writeFakeNpm(tmp.bin, { exitCode: 0, invocationLog: npmInvocationLog(tmp.root) });

    const result = await runInstall([], {
      home: tmp.home,
      pathOverride: tmp.bin,
      cwd: tmp.repo!,
    });
    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain('feature/stack-plugin-rfc');

    expect(result.stdout.toLowerCase()).toMatch(/mid-pivot|not functional/);
  });

  it('S3-AC9: warning trigger is hardcoded — `feature/stack-plugin-rfc` literal in install.sh, no env-var override pattern', () => {
    const installSh = readFileSync(installScriptPath(), 'utf8');

    const literalMatches = installSh.match(/feature\/stack-plugin-rfc/g) ?? [];
    expect(literalMatches.length).toBeGreaterThanOrEqual(1);

    const forbidden = /FEATURE_BRANCH|GAN_BRANCH|BRANCH_OVERRIDE/g;
    const violations = installSh.match(forbidden) ?? [];
    if (violations.length > 0) {
      throw new Error(
        `Forbidden env-var-override pattern present in install.sh: ${violations.join(', ')}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
