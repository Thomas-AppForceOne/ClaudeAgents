/**
 * R2 sprint 1 — temporary HOME / stub-bin scaffolding for installer tests.
 *
 * Each `makeTmpHome()` call creates an isolated tmp directory layout:
 *
 *   <tmpRoot>/
 *     home/         # passed as HOME to install.sh
 *     bin/          # prepended to PATH; tests put stub `node`, `git`,
 *                   # `claude` executables here.
 *     repo/         # optional fake repo (only created if requested)
 *
 * Returned `cleanup()` removes the whole layout. Tests register cleanups
 * via afterEach to keep tmp dirs from accumulating.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface TmpHome {
  /** Absolute path to the tmp root. */
  root: string;
  /** Absolute path to the synthetic HOME dir. */
  home: string;
  /** Absolute path to the stub-bin dir (prepend to PATH). */
  bin: string;
  /** Absolute path to the synthetic repo dir (only if `withRepo: true`). */
  repo: string | null;
  /** Removes the whole tmp layout. Idempotent. */
  cleanup(): void;
}

export interface MakeTmpHomeOptions {
  /** If true, also creates `<root>/repo/` as a fresh git repository. */
  withRepo?: boolean;
}

/**
 * System utilities `install.sh` legitimately calls (`dirname`, `cat`, …).
 * They must remain resolvable when a test scrubs PATH down to a
 * stub-only directory; we symlink them into the stub bin from their
 * absolute paths so `command -v <util>` finds them via the stub bin.
 *
 * `node`, `git`, and `claude` are deliberately NOT in this list — those
 * are the prerequisites under test and live exclusively as stubs. Same
 * for `npm` and `claudeagents-config-server`, which the S2 install path
 * depends on but tests stub explicitly.
 */
const SYSTEM_UTILITIES = [
  '/bin/cat',
  '/bin/sh',
  '/bin/cp',
  '/bin/mv',
  '/bin/rm',
  '/bin/ln',
  '/bin/mkdir',
  '/bin/chmod',
  '/bin/date',
  '/usr/bin/dirname',
  '/usr/bin/uname',
  '/usr/bin/env',
  '/usr/bin/basename',
  '/usr/bin/tr',
  '/usr/bin/grep',
  '/usr/bin/touch',
  '/usr/bin/readlink',
  '/usr/bin/find',
  '/usr/bin/head',
  '/usr/bin/tail',
  '/usr/bin/sed',
];

/**
 * Create an isolated tmp HOME + stub-bin layout for an installer test.
 *
 * Tests should call `cleanup()` (typically inside afterEach) to remove
 * the directory tree.
 */
export function makeTmpHome(options: MakeTmpHomeOptions = {}): TmpHome {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-installer-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Seed the stub bin with symlinks to safe system utilities so PATH
  // overrides that exclude `/usr/bin` don't strand `dirname` etc.
  for (const src of SYSTEM_UTILITIES) {
    if (!existsSync(src)) continue;
    try {
      symlinkSync(src, path.join(bin, path.basename(src)));
    } catch {
      // ignore — utility may be present in another location, or the
      // symlink already exists (e.g. on a re-entrant test setup).
    }
  }

  let repo: string | null = null;
  if (options.withRepo) {
    repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const result = spawnSync('git', ['init', '--quiet', repo], { stdio: 'ignore' });
    if (result.status !== 0) {
      throw new Error('makeTmpHome: failed to initialise fake git repo');
    }
  }

  return {
    root,
    home,
    bin,
    repo,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort; the OS reaper will catch leaks
      }
    },
  };
}

/**
 * Write a stub executable into `bin/<name>` with the supplied bash body.
 * The stub is automatically marked executable.
 *
 * Example:
 *   writeStubBin(bin, 'node', 'echo "v20.10.0"');
 *
 * The body is executed under `/bin/bash`. Reading argv via `$1`, `$2`, …
 * works as expected.
 */
export function writeStubBin(bin: string, name: string, body: string): string {
  const target = path.join(bin, name);
  const script = `#!/bin/bash\n${body}\n`;
  writeFileSync(target, script);
  chmodSync(target, 0o755);
  return target;
}
