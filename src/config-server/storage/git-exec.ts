/**
 * Shared git subprocess seam for the F7 storage modules.
 *
 * `GitExec` is the single injectable seam every storage module uses to run git:
 * production passes {@link defaultGitExec} (`execFileSync('git', argv, { cwd })`,
 * argv-only — never a shell string), tests pass a stub. Centralised here so the
 * seam and the `git rev-parse --git-common-dir` → main-worktree-root derivation
 * have ONE implementation rather than a per-module copy.
 *
 * Subprocess safety (`shell_and_subprocess_safety`): implementations MUST treat
 * `args` as a literal argv array. Untrusted values (slugs, branch names, paths)
 * appear only as discrete argv elements, never interpolated into a command line.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Injectable git exec seam. Returns the command's stdout; throws on a non-zero
 * exit (matching `execFileSync` semantics) so callers can branch on git
 * failures. Implementations MUST treat `args` as a literal argv array (no shell).
 */
export type GitExec = (args: readonly string[], cwd: string) => string;

/** Default git exec seam: `execFileSync('git', argv, { cwd })`, argv-only, no shell. */
export const defaultGitExec: GitExec = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

/**
 * Resolve the repo's **main-worktree root** — the parent of
 * `git rev-parse --git-common-dir`, NOT `git rev-parse --show-toplevel`. All
 * linked worktrees of a repo share one git-common-dir, so from inside any
 * linked worktree this resolves to the original main checkout, not the worktree
 * directory. That shared anchor is what makes the repo key (and therefore the
 * central store directory) identical across all worktrees, and what
 * distinguishes the main checkout (→ 1b for a matching branch) from a linked
 * task worktree (→ 1a).
 *
 * @param git     the injectable git seam.
 * @param fromDir directory inside the repo (worktree or main checkout) to run
 *   git from.
 */
export function mainWorktreeRoot(git: GitExec, fromDir: string): string {
  const out = git(['rev-parse', '--git-common-dir'], fromDir).trim();
  if (out.length === 0) {
    throw new Error(
      `Could not resolve the repository's git-common-dir from ${fromDir}; is this a git repository?`,
    );
  }
  // `--git-common-dir` may be relative to `fromDir` (e.g. `.git` in the main
  // checkout) or absolute (e.g. `/path/to/main/.git` from a linked worktree).
  // Resolve against the invocation directory, then take the parent.
  const commonDir = path.resolve(fromDir, out);
  return path.dirname(commonDir);
}
