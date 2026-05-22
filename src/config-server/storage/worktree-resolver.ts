/**
 * F7 slice 2 — worktree-aware execution (cases 1a / 1b / 1c).
 *
 * At run start the orchestrator derives a **task slug** from the run subject
 * (the spec name in spec-dir mode, or a slugified prompt in prompt mode) and
 * resolves the workspace by a three-way rule (F7 spec §2):
 *
 *   - **1a Reuse in place.** The current branch matches the task slug AND the
 *     cwd is the worktree dedicated to that branch → reuse it; create no new
 *     worktree; `createdByGan=false`.
 *   - **1b Wrap the matching branch.** The current branch matches the slug but
 *     the cwd is NOT that branch's dedicated worktree → free the branch by
 *     switching the current checkout to the repo's default branch (detached
 *     HEAD only as a fallback when the default branch is itself occupied),
 *     then `git worktree add` the existing task branch into a run-scoped
 *     worktree under `.gan-state/runs/<run-id>/worktree/`; `createdByGan=true`.
 *     **Refuses** when the current checkout's working tree is dirty (commit /
 *     stash, or run from a dedicated worktree) — no auto-stash, no detach over
 *     uncommitted work. The `git worktree add` force flag is never used.
 *   - **1c Create branch + worktree.** Neither matches → create a new
 *     task-named branch checked out in the run-scoped worktree;
 *     `createdByGan=true`.
 *
 * `--new-worktree` forces case-1c behaviour even when 1a/1b would match.
 *
 * Subprocess safety (`shell_and_subprocess_safety`): the task slug, branch
 * name, default-branch name, and every path trace back to user-controlled
 * input (the run subject → slug; cwd; branch names) and are therefore
 * UNTRUSTED. Every git invocation goes through an injectable exec seam that
 * defaults to `execFileSync` with an **argv array** — never a shell string,
 * never the shell-spawning option, never a shell-string subprocess API, and
 * never the `git worktree add` force flag. Untrusted values appear only as discrete argv
 * elements, so a subject containing shell metacharacters reaches git as one
 * literal argument with no expansion.
 *
 * Determinism: `worktreePath` recorded into `progress.json` is canonicalised
 * through the centralised determinism module ({@link canonicalizePath}); this
 * module never re-implements realpath / case-folding / slash-stripping.
 */

import path from 'node:path';

import { canonicalizePathForDisplay } from '../determinism/index.js';
import { createError } from '../errors.js';
import { defaultGitExec, mainWorktreeRoot, type GitExec } from './git-exec.js';

// The git exec seam (`GitExec` / `defaultGitExec`) and the main-worktree-root
// derivation live in the shared `./git-exec` module so there is ONE
// implementation. Re-exported here so existing importers (cleanup-planner,
// tests, the library index) keep their import path.
export { defaultGitExec };
export type { GitExec };

/** The resolved workspace, recorded into `progress.json` at run start. */
export interface ResolvedWorkspace {
  /** Canonical absolute path of the worktree the generator writes into. */
  worktreePath: string;
  /** The resolved branch name (terminal-or-full branch the run executes on). */
  branch: string;
  /** True only for cases 1b/1c (gan created the worktree); false for 1a. */
  createdByGan: boolean;
  /** Which resolution case fired. Useful for tracing / cleanup. */
  resolutionCase: '1a' | '1b' | '1c';
}

/** Inputs to the resolver. */
export interface ResolveWorkspaceOptions {
  /** The run subject — spec name (spec mode) or raw prompt (prompt mode). */
  subject: string;
  /** Run-id in the O2 grammar; names the run-scoped worktree directory. */
  runId: string;
  /**
   * Project root (the main-worktree root) under which a gan-created worktree
   * is placed at `.gan-state/runs/<run-id>/worktree/`. Cases 1b/1c only.
   */
  projectRoot: string;
  /** Directory git commands run from (the current checkout). Defaults to cwd. */
  fromDir?: string;
  /** Force case 1c even when 1a/1b would match (the `--new-worktree` flag). */
  newWorktree?: boolean;
  /** Injectable git seam for tests; defaults to {@link defaultGitExec}. */
  git?: GitExec;
  /**
   * Branch name to create in case 1c. Defaults to `feature/<slug>`. Provided
   * so callers can override the prefix; always passed to git as a single argv
   * element regardless of contents.
   */
  newBranchPrefix?: string;
}

// ---- task-slug derivation -------------------------------------------------

/**
 * Derive a stable, lowercase, branch-safe token from an arbitrary subject.
 *
 * Deterministic and case-insensitive: subjects differing only by letter case
 * yield the same slug. The transform lowercases, replaces every run of
 * non-`[a-z0-9]` characters with a single hyphen, and trims leading/trailing
 * separators. Underscores are preserved as word characters (the slug is
 * "hyphen-or-underscore-safe"); shell metacharacters, spaces, slashes, and
 * punctuation all collapse to hyphens, so a subject such as `Add Export!` and
 * `add-export` and `ADD   EXPORT` all map to `add-export`.
 *
 * The output never contains a path separator, whitespace, or any shell
 * metacharacter — but it is in any case only ever passed to git as a discrete
 * argv element, never interpolated into a command string.
 */
export function slugify(subject: string): string {
  const lowered = subject.toLowerCase();
  // Keep ASCII word-ish characters and underscores; everything else → hyphen.
  const collapsed = lowered.replace(/[^a-z0-9_]+/g, '-');
  // Trim leading/trailing hyphens or underscores so the slug is clean.
  const trimmed = collapsed.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  return trimmed;
}

/**
 * The terminal (last slash-separated) component of a branch name, slugified.
 * `feature/add-export` → `add-export`; a bare `add-export` → `add-export`.
 */
export function terminalSlug(branch: string): string {
  const idx = Math.max(branch.lastIndexOf('/'), branch.lastIndexOf('\\'));
  const terminal = idx >= 0 ? branch.slice(idx + 1) : branch;
  return slugify(terminal);
}

/**
 * `true` when the task slug exactly equals the slugified TERMINAL component of
 * the branch name, compared case-insensitively (slugification already
 * lowercases, so the comparison is a plain equality of two slugs).
 *
 * Examples (slug `add-export`):
 *   - `feature/add-export`  → true
 *   - `FEATURE/ADD-EXPORT`  → true
 *   - `add-export`          → true
 *   - `feature/add-export-2`→ false
 *   - `feature/other`       → false
 */
export function branchMatchesSlug(branch: string, slug: string): boolean {
  return terminalSlug(branch) === slugify(slug);
}

// ---- git helpers (all argv-array, via the injectable seam) ----------------

/** The current branch name, or `undefined` when HEAD is detached. */
function currentBranch(git: GitExec, fromDir: string): string | undefined {
  // `symbolic-ref --quiet --short HEAD` prints the branch and exits 0; on a
  // detached HEAD it exits non-zero, which the seam surfaces as a throw.
  try {
    const out = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], fromDir).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The current worktree's top-level directory (`git rev-parse --show-toplevel`). */
function currentWorktreeTop(git: GitExec, fromDir: string): string {
  return git(['rev-parse', '--show-toplevel'], fromDir).trim();
}

/** `true` when the working tree at `fromDir` has any staged/unstaged/untracked change. */
function isWorkingTreeDirty(git: GitExec, fromDir: string): boolean {
  // `--porcelain` prints one line per change and nothing when clean.
  const out = git(['status', '--porcelain'], fromDir);
  return out.trim().length > 0;
}

interface WorktreeEntry {
  /** Absolute worktree path as git reports it. */
  worktree: string;
  /** Full branch ref name (e.g. `refs/heads/feature/add-export`), if any. */
  branch?: string;
  /** True when the worktree is in a detached-HEAD state. */
  detached: boolean;
}

/** Parse `git worktree list --porcelain` into structured entries. */
function listWorktrees(git: GitExec, fromDir: string): WorktreeEntry[] {
  const out = git(['worktree', 'list', '--porcelain'], fromDir);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | undefined;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (current?.worktree !== undefined) {
        entries.push({
          worktree: current.worktree,
          branch: current.branch,
          detached: current.detached ?? false,
        });
      }
      current = { worktree: line.slice('worktree '.length), detached: false };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached' && current) {
      current.detached = true;
    } else if (line.length === 0 && current?.worktree !== undefined) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch,
        detached: current.detached ?? false,
      });
      current = undefined;
    }
  }
  if (current?.worktree !== undefined) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch,
      detached: current.detached ?? false,
    });
  }
  return entries;
}

/** The bare ref name `refs/heads/<x>` → `<x>`; passthrough otherwise. */
function shortRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Resolve the repo's default branch — used to free a matching branch in 1b.
 * NOT hardcoded to a single literal: resolution order is
 *   1. `origin/HEAD` symbolic ref (the configured remote default), if set;
 *   2. a local branch matching `init.defaultBranch`, if that config exists and
 *      such a branch is present;
 *   3. the first present branch among the conventional defaults
 *      (`develop`, then `main`, then `master`).
 * Returns `undefined` when none can be resolved (the caller then detaches).
 */
export function resolveDefaultBranch(git: GitExec, fromDir: string): string | undefined {
  // 1. origin/HEAD → e.g. `origin/develop`; strip the remote prefix.
  try {
    const head = git(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      fromDir,
    ).trim();
    if (head.length > 0) {
      const slash = head.indexOf('/');
      const name = slash >= 0 ? head.slice(slash + 1) : head;
      if (name.length > 0 && localBranchExists(git, fromDir, name)) return name;
    }
  } catch {
    // No origin/HEAD configured; fall through.
  }

  // 2. init.defaultBranch, if such a local branch exists.
  try {
    const configured = git(['config', '--get', 'init.defaultBranch'], fromDir).trim();
    if (configured.length > 0 && localBranchExists(git, fromDir, configured)) return configured;
  } catch {
    // No config; fall through.
  }

  // 3. Conventional defaults, first present wins.
  for (const candidate of ['develop', 'main', 'master']) {
    if (localBranchExists(git, fromDir, candidate)) return candidate;
  }
  return undefined;
}

/** `true` when a local branch `<name>` exists. */
function localBranchExists(git: GitExec, fromDir: string, name: string): boolean {
  try {
    // `--verify` exits non-zero (→ throw) when the ref is absent.
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], fromDir);
    return true;
  } catch {
    return false;
  }
}

/** `true` when some worktree other than `fromDir`'s checks out `<branch>`. */
function branchOccupiedElsewhere(
  entries: WorktreeEntry[],
  branch: string,
  exceptWorktree: string,
): boolean {
  const exceptCanon = canonicalizePathForDisplay(exceptWorktree);
  for (const e of entries) {
    if (shortRef(e.branch) === branch && canonicalizePathForDisplay(e.worktree) !== exceptCanon) {
      return true;
    }
  }
  return false;
}

// ---- the 1a / 1b / 1c resolver --------------------------------------------

/**
 * Resolve the workspace for a run. See the module header for the 1a/1b/1c
 * rule and the `--new-worktree` override. All git interaction goes through
 * the injectable {@link GitExec} seam.
 *
 * @throws ConfigServerError(MalformedInput) — case 1b refusal on a dirty
 *   working tree. The message names committing/stashing or using a dedicated
 *   worktree as remediation, in shell terms (no ecosystem tokens).
 */
export function resolveWorkspace(opts: ResolveWorkspaceOptions): ResolvedWorkspace {
  const git = opts.git ?? defaultGitExec;
  const fromDir = opts.fromDir ?? process.cwd();
  const slug = slugify(opts.subject);
  const branchPrefix = opts.newBranchPrefix ?? 'feature/';
  const taskBranch = `${branchPrefix}${slug}`;
  const runScopedWorktree = path.join(
    opts.projectRoot,
    '.gan-state',
    'runs',
    opts.runId,
    'worktree',
  );

  const branch = currentBranch(git, fromDir);
  const matches = branch !== undefined && branchMatchesSlug(branch, slug);

  // `--new-worktree` short-circuits to 1c regardless of 1a/1b match.
  if (opts.newWorktree === true || !matches) {
    return createWorktree1c({ git, fromDir, taskBranch, runScopedWorktree });
  }

  // The branch matches. Decide 1a vs 1b. 1a is "reuse in place": the cwd is a
  // worktree DEDICATED to the task branch — meaning a *linked* worktree the
  // engineer created for this task (e.g. `myapp-add-export/`). When the
  // matching branch is merely checked out in the repo's MAIN checkout, that is
  // 1b (the spec's "branch checked out in the main checkout" → non-dedicated):
  // every checked-out branch lives in exactly one worktree, so "dedicated"
  // turns on the worktree being a deliberate, linked, task worktree rather than
  // the main checkout.
  const top = currentWorktreeTop(git, fromDir);
  const entries = listWorktrees(git, fromDir);
  const topCanon = canonicalizePathForDisplay(top);
  const mainRootCanon = canonicalizePathForDisplay(mainWorktreeRoot(git, fromDir));
  const cwdHoldsBranch = entries.some(
    (e) => shortRef(e.branch) === branch && canonicalizePathForDisplay(e.worktree) === topCanon,
  );
  const cwdIsMainCheckout = topCanon === mainRootCanon;
  const dedicated = cwdHoldsBranch && !cwdIsMainCheckout;

  if (dedicated) {
    // 1a: reuse in place. No new worktree.
    return {
      worktreePath: canonicalizePathForDisplay(top),
      branch: branch as string,
      createdByGan: false,
      resolutionCase: '1a',
    };
  }

  // 1b: matching branch in a non-dedicated checkout. Require a clean tree.
  if (isWorkingTreeDirty(git, fromDir)) {
    throw createError('MalformedInput', {
      path: fromDir,
      field: 'workspace',
      message:
        `The current checkout has uncommitted changes, so the framework will not free ` +
        `branch '${branch}' to wrap it in a run-scoped worktree (doing so would risk ` +
        `losing your work). Commit or stash your changes, or start the run from a dedicated ` +
        `worktree for this branch, then run again.`,
      remediation:
        `Run 'git commit -am <message>' or 'git stash' in ${fromDir} to clear the working ` +
        `tree, or 'cd' into a worktree dedicated to '${branch}', then re-run.`,
    });
  }

  // Free the branch: switch the current checkout to the default branch, or
  // detach HEAD as a fallback when the default branch is itself occupied.
  freeCurrentCheckout({ git, fromDir, entries, top: topCanon });

  // Add the existing (now-freed) task branch into the run-scoped worktree.
  // No `-b` (the branch already exists); the force flag is never passed.
  git(['worktree', 'add', runScopedWorktree, branch as string], fromDir);

  return {
    worktreePath: canonicalizePathForDisplay(runScopedWorktree),
    branch: branch as string,
    createdByGan: true,
    resolutionCase: '1b',
  };
}

/**
 * Free the current checkout for 1b: switch it to the repo's resolved default
 * branch, or detach HEAD as a fallback when the default branch is occupied by
 * another worktree (or cannot be resolved). Never operates over uncommitted
 * work — the caller guarantees a clean tree before calling.
 */
function freeCurrentCheckout(args: {
  git: GitExec;
  fromDir: string;
  entries: WorktreeEntry[];
  top: string;
}): void {
  const { git, fromDir, entries, top } = args;
  const defaultBranch = resolveDefaultBranch(git, fromDir);
  if (defaultBranch !== undefined && !branchOccupiedElsewhere(entries, defaultBranch, top)) {
    git(['checkout', defaultBranch], fromDir);
    return;
  }
  // Fallback: detach HEAD at the current commit. `--detach` with no ref keeps
  // the working tree contents but frees the branch ref.
  git(['checkout', '--detach'], fromDir);
}

/** Case 1c: create a new task-named branch checked out in the run-scoped worktree. */
function createWorktree1c(args: {
  git: GitExec;
  fromDir: string;
  taskBranch: string;
  runScopedWorktree: string;
}): ResolvedWorkspace {
  const { git, fromDir, taskBranch, runScopedWorktree } = args;
  // `-b <branch>` creates the branch and checks it out in the new worktree.
  // The force flag is never passed.
  git(['worktree', 'add', '-b', taskBranch, runScopedWorktree], fromDir);
  return {
    worktreePath: canonicalizePathForDisplay(runScopedWorktree),
    branch: taskBranch,
    createdByGan: true,
    resolutionCase: '1c',
  };
}
