

/**
 * The low-level git seam shared by the run/worktree storage layer.
 *
 * It defines the {@link GitExec} function type (so every git-touching module
 * accepts an injectable executor and can be tested without a real repository),
 * the production executor {@link defaultGitExec}, and the one primitive used
 * across worktrees: locating the repository's main worktree root.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * A synchronous git command executor. Implementations run `git <args>` with
 * working directory `cwd` and return captured stdout as a string. The argv form
 * (no shell) is intentional — arguments are passed literally, so a value
 * containing shell metacharacters cannot be reinterpreted as a command.
 */
export type GitExec = (args: readonly string[], cwd: string) => string;

/**
 * Production {@link GitExec}: invokes the `git` binary with `execFileSync` (no
 * shell), inheriting `cwd`. stdin and stderr are ignored; only stdout is
 * captured and returned. A non-zero exit throws (the standard `execFileSync`
 * behaviour), which callers either translate or catch.
 */
export const defaultGitExec: GitExec = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

/**
 * Resolve the filesystem root of a repository's *main* worktree, starting from
 * any directory inside it (including a linked worktree).
 *
 * It asks git for `--git-common-dir` — which always points at the main
 * worktree's `.git` directory even when run from a linked worktree — resolves
 * it relative to `fromDir`, and returns that directory's parent (the working
 * tree root). This is the stable identity used to key per-repository state, so
 * every worktree of a repo maps to the same root.
 *
 * @param git executor to run git through (injectable for tests).
 * @param fromDir a directory inside the repository.
 * @returns the absolute path of the main worktree's root.
 * @throws a plain `Error` when `--git-common-dir` comes back empty (i.e.
 *   `fromDir` is not inside a git repository). This is a THROW, not a returned
 *   value; a non-zero git exit also surfaces as a throw from `git`.
 */
export function mainWorktreeRoot(git: GitExec, fromDir: string): string {
  const out = git(['rev-parse', '--git-common-dir'], fromDir).trim();
  if (out.length === 0) {
    throw new Error(
      `Could not resolve the repository's git-common-dir from ${fromDir}; is this a git repository?`,
    );
  }

  // `--git-common-dir` may be relative to fromDir (e.g. ".git"); resolve it,
  // then take the parent so we return the working-tree root, not the .git dir.
  const commonDir = path.resolve(fromDir, out);
  return path.dirname(commonDir);
}
