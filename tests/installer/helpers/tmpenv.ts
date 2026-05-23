/**
 * Builds the hermetic sandbox every installer test runs inside.
 *
 * Each test needs a throwaway `$HOME` and a controlled `PATH` so the real
 * installer can run without touching the developer's machine or depending on
 * whatever happens to be installed. {@link makeTmpHome} mints a fresh temp
 * directory containing an empty `home/` and a `bin/` pre-populated with
 * symlinks to a curated set of real system utilities — bash, coreutils, etc. —
 * so the installer's genuine shell logic works while the *interesting* tools
 * (npm, node, git, claude, config-server) can be shadowed by test stubs via
 * {@link writeStubBin}. Optionally it initialises a real throwaway git repo so
 * cwd-is-a-repo behaviour can be exercised.
 *
 * The `#!/bin/bash` header embedded by {@link writeStubBin} is DATA written
 * into the generated stub file, not a directive on this module.
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

/**
 * Handle to a sandbox created by {@link makeTmpHome}.
 *
 * @property root the temp root containing everything below; removed by
 *   `cleanup`.
 * @property home the fake `$HOME` (initially empty) the installer writes into.
 * @property bin the stub-`PATH` directory: symlinks to real system utilities
 *   plus any stubs a test adds; pass this as `pathOverride`/`prependPath`.
 * @property repo absolute path to the initialised throwaway git repo, or `null`
 *   when `withRepo` was not requested.
 * @property cleanup best-effort recursive removal of `root`; safe to call once
 *   per sandbox (the suites call it from `afterEach`).
 */
export interface TmpHome {

  root: string;

  home: string;

  bin: string;

  repo: string | null;

  cleanup(): void;
}

/**
 * Options for {@link makeTmpHome}.
 *
 * @property withRepo when true, `git init` a throwaway repo at `<root>/repo`
 *   and expose it as {@link TmpHome.repo}; otherwise `repo` is `null`.
 */
export interface MakeTmpHomeOptions {

  withRepo?: boolean;
}

// The real system tools symlinked into the sandbox `bin/` so the installer's
// own shell can run. Deliberately excludes the tools tests want to control
// (npm/node/git/claude/config-server) — those are supplied as stubs per test.
// A missing entry is skipped (see makeTmpHome) so the list can stay generous
// across platforms.
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
 * Create a fresh hermetic sandbox: a temp `root` with an empty `home/` and a
 * `bin/` of symlinks to {@link SYSTEM_UTILITIES}, optionally containing an
 * initialised git repo.
 *
 * Missing system utilities are silently skipped, and a symlink that fails to
 * create (already present, or available elsewhere) is tolerated, so the helper
 * works across machines without a hard dependency on every listed path.
 *
 * @param options see {@link MakeTmpHomeOptions}.
 * @returns the {@link TmpHome} handle (remember to call `cleanup`).
 * @throws Error if `withRepo` is set but `git init` fails.
 */
export function makeTmpHome(options: MakeTmpHomeOptions = {}): TmpHome {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-installer-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

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
 * Write an executable stub named `name` into the sandbox `bin/`, with `body` as
 * its shell script (a `#!/bin/bash` shebang is prepended automatically).
 *
 * Any existing file at the target is removed first so re-stubbing within one
 * test (e.g. swapping `npm` behaviour mid-setup) replaces rather than appends.
 * The file is marked mode 0755 so the installer can exec it.
 *
 * @param bin the sandbox `bin/` directory (from {@link TmpHome.bin}).
 * @param name the executable name to shadow on PATH (e.g. `npm`, `node`).
 * @param body the shell body; treated as DATA — it is the stub's code, not this
 *   module's.
 * @returns the absolute path of the written stub.
 */
export function writeStubBin(bin: string, name: string, body: string): string {
  const target = path.join(bin, name);

  // Remove any prior stub at this name so a within-test re-stub replaces it
  // cleanly rather than colliding; ignore failure if nothing was there.
  try {
    rmSync(target, { force: true });
  } catch {
    // best effort
  }
  const script = `#!/bin/bash\n${body}\n`;
  writeFileSync(target, script);
  chmodSync(target, 0o755);
  return target;
}
