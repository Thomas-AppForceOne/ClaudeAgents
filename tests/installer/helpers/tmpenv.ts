
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

  root: string;

  home: string;

  bin: string;

  repo: string | null;

  cleanup(): void;
}

export interface MakeTmpHomeOptions {

  withRepo?: boolean;
}

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

export function writeStubBin(bin: string, name: string, body: string): string {
  const target = path.join(bin, name);

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
