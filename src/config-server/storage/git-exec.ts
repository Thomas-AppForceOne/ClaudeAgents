

import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type GitExec = (args: readonly string[], cwd: string) => string;

export const defaultGitExec: GitExec = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

export function mainWorktreeRoot(git: GitExec, fromDir: string): string {
  const out = git(['rev-parse', '--git-common-dir'], fromDir).trim();
  if (out.length === 0) {
    throw new Error(
      `Could not resolve the repository's git-common-dir from ${fromDir}; is this a git repository?`,
    );
  }

  const commonDir = path.resolve(fromDir, out);
  return path.dirname(commonDir);
}
