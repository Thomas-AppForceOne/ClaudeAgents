/**
 * R2 sprint 3 — feature-branch warning tests for `install.sh`.
 *
 * Covers S3-AC8..S3-AC9:
 *   AC8 — Warning fires when the repo's current branch is the literal
 *         string `feature/stack-plugin-rfc`.
 *   AC9 — Warning trigger is hardcoded — `install.sh` contains the
 *         literal branch name in at least one place, and there is no
 *         environment-variable override pattern (e.g. FEATURE_BRANCH,
 *         GAN_BRANCH, BRANCH_OVERRIDE).
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

    // Stub `git` that intercepts `rev-parse --abbrev-ref HEAD` and
    // returns the trigger branch name. All other invocations forward
    // to the real `/usr/bin/git` so subcommands like
    // `git rev-parse --show-toplevel` (used by zone prep) still work.
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
    // The warning text mentions the trigger branch by name.
    expect(result.stdout).toContain('feature/stack-plugin-rfc');
    // And it is presented as a heads-up / mid-pivot warning.
    expect(result.stdout.toLowerCase()).toMatch(/mid-pivot|not functional/);
  });

  it('S3-AC9: warning trigger is hardcoded — `feature/stack-plugin-rfc` literal in install.sh, no env-var override pattern', () => {
    const installSh = readFileSync(installScriptPath(), 'utf8');
    // Hardcoded literal branch name: at least one occurrence.
    const literalMatches = installSh.match(/feature\/stack-plugin-rfc/g) ?? [];
    expect(literalMatches.length).toBeGreaterThanOrEqual(1);

    // No env-var-override pattern. The contract names three forbidden
    // sigils; any match is a violation.
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
