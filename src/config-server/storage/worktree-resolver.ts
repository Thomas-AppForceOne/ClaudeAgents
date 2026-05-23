

/**
 * Resolve which git worktree and branch a `/gan` run executes in.
 *
 * Given the run's subject (which seeds a branch slug) and the current
 * directory, {@link resolveWorkspace} picks one of three outcomes, recorded as
 * `resolutionCase`:
 * - `1a` — the caller is already in a dedicated worktree whose checked-out
 *   branch matches the subject; reuse it as-is (the framework did not create
 *   it, so cleanup must not remove it).
 * - `1b` — the caller is on a matching branch but in a *shared/main* checkout;
 *   the framework frees that checkout and moves the branch into a fresh,
 *   run-scoped worktree it owns.
 * - `1c` — no matching branch (or a new worktree was explicitly requested);
 *   create a brand-new branch + run-scoped worktree.
 *
 * Two safety rules are central: the framework never frees a checkout with
 * uncommitted changes (it refuses, to avoid losing work), and a worktree it did
 * not create is flagged `createdByGan: false` so later cleanup leaves it alone.
 *
 * Branch matching is by *slug*: subjects and branch terminal segments are
 * normalised through {@link slugify} so e.g. "Fix login bug" matches
 * `feature/fix-login-bug`.
 */
import path from 'node:path';

import { canonicalizePathForDisplay } from '../determinism/index.js';
import { createError } from '../errors.js';
import { defaultGitExec, mainWorktreeRoot, type GitExec } from './git-exec.js';

export { defaultGitExec };
export type { GitExec };

/**
 * The outcome of workspace resolution.
 *
 * @property worktreePath the worktree the run will use (canonical display form).
 * @property branch the branch checked out there.
 * @property createdByGan whether the framework created this worktree/branch
 *   (governs whether cleanup may remove it).
 * @property resolutionCase which resolution path produced this result (`1a`
 *   reuse / `1b` move-into-scoped / `1c` create-new); see the module doc.
 */
export interface ResolvedWorkspace {

  worktreePath: string;

  branch: string;

  createdByGan: boolean;

  resolutionCase: '1a' | '1b' | '1c';
}

/**
 * Inputs to {@link resolveWorkspace}.
 *
 * @property subject the run subject; slugified to derive/match the branch name.
 * @property runId the run id; used to name the run-scoped worktree directory.
 * @property projectRoot the project root under which run-scoped worktrees live.
 * @property fromDir the directory the run was started from; defaults to
 *   `process.cwd()`.
 * @property newWorktree when `true`, force case `1c` (always create new) even if
 *   the current branch would otherwise match.
 * @property git git executor seam; defaults to {@link defaultGitExec}.
 * @property newBranchPrefix prefix for a freshly created branch; defaults to
 *   `'feature/'`.
 */
export interface ResolveWorkspaceOptions {

  subject: string;

  runId: string;

  projectRoot: string;

  fromDir?: string;

  newWorktree?: boolean;

  git?: GitExec;

  newBranchPrefix?: string;
}

/**
 * Normalise an arbitrary subject into a branch-safe slug: lowercased, every run
 * of non-`[a-z0-9_]` characters collapsed to a single `-`, and leading/trailing
 * `-`/`_` trimmed. Pure.
 *
 * @param subject the free-text subject.
 * @returns the slug (possibly empty if `subject` had no slug-able characters).
 */
export function slugify(subject: string): string {
  const lowered = subject.toLowerCase();

  const collapsed = lowered.replace(/[^a-z0-9_]+/g, '-');

  const trimmed = collapsed.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  return trimmed;
}

/**
 * Slugify only a branch's *terminal* segment (the part after the last `/` or
 * `\`), so `feature/fix-login` reduces to the slug of `fix-login`. Used to
 * compare a branch to a subject slug without the prefix interfering.
 */
export function terminalSlug(branch: string): string {
  const idx = Math.max(branch.lastIndexOf('/'), branch.lastIndexOf('\\'));
  const terminal = idx >= 0 ? branch.slice(idx + 1) : branch;
  return slugify(terminal);
}

/**
 * Whether `branch`'s terminal slug equals the slug of `slug`. This is the
 * "does the current branch belong to this subject?" test that distinguishes
 * resolution cases `1a`/`1b` from `1c`.
 */
export function branchMatchesSlug(branch: string, slug: string): boolean {
  return terminalSlug(branch) === slugify(slug);
}

/**
 * The short name of the branch currently checked out at `fromDir`, or
 * `undefined` when HEAD is detached. `symbolic-ref` errors on a detached HEAD,
 * so the throw is caught and mapped to `undefined` — detached is a normal
 * state, not a fault.
 */
function currentBranch(git: GitExec, fromDir: string): string | undefined {

  try {
    const out = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], fromDir).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute top-level directory of the worktree containing `fromDir`. */
function currentWorktreeTop(git: GitExec, fromDir: string): string {
  return git(['rev-parse', '--show-toplevel'], fromDir).trim();
}

/**
 * Whether the working tree at `fromDir` has any uncommitted changes. Uses
 * `status --porcelain` (stable, script-friendly output); any non-empty result
 * means dirty. This gates case `1b`: the framework refuses to free a dirty
 * checkout.
 */
function isWorkingTreeDirty(git: GitExec, fromDir: string): boolean {

  const out = git(['status', '--porcelain'], fromDir);
  return out.trim().length > 0;
}

/**
 * One entry from `git worktree list --porcelain`.
 *
 * @property worktree the worktree's absolute path.
 * @property branch the fully-qualified branch ref checked out there, if any.
 * @property detached whether the worktree's HEAD is detached.
 */
interface WorktreeEntry {

  worktree: string;

  branch?: string;

  detached: boolean;
}

/**
 * Parse `git worktree list --porcelain` into structured entries.
 *
 * The porcelain format emits a block per worktree (a `worktree <path>` line,
 * optional `branch`/`detached` lines) separated by blank lines. This walks the
 * lines accumulating the current block and flushing it on a blank line or the
 * next `worktree` header — and once more at the end, since the final block has
 * no trailing blank line. `\r` is stripped so the parser is CRLF-tolerant.
 */
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

/**
 * Strip a leading `refs/heads/` from a ref so it can be compared to a short
 * branch name. Passes through `undefined` and already-short refs unchanged.
 */
function shortRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Determine the repository's default branch — the branch a freed checkout is
 * parked on and the merge base cleanup uses.
 *
 * Tries, in order: `origin/HEAD`'s target (the remote's default), the configured
 * `init.defaultBranch`, then the conventional names `develop`, `main`, `master`.
 * Each candidate must actually exist locally to be accepted, so the result is
 * always a checkout-able branch.
 *
 * @returns the default branch name, or `undefined` if none of the candidates
 *   exist locally. Never throws — each git probe's failure is caught and falls
 *   through to the next candidate.
 */
export function resolveDefaultBranch(git: GitExec, fromDir: string): string | undefined {

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

  try {
    const configured = git(['config', '--get', 'init.defaultBranch'], fromDir).trim();
    if (configured.length > 0 && localBranchExists(git, fromDir, configured)) return configured;
  } catch {
    // No config; fall through.
  }

  // Conventional fallback order; `develop` is tried before `main`/`master`
  // because a git-flow repository integrates onto develop.
  for (const candidate of ['develop', 'main', 'master']) {
    if (localBranchExists(git, fromDir, candidate)) return candidate;
  }
  return undefined;
}

/**
 * Whether a local branch `name` exists. Uses `rev-parse --verify --quiet`, which
 * exits non-zero (throws here) when the ref is absent; that throw is the "does
 * not exist" answer and is caught.
 */
function localBranchExists(git: GitExec, fromDir: string, name: string): boolean {
  try {

    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], fromDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `branch` is checked out in some worktree *other than* `exceptWorktree`.
 * Comparison is by canonical display path so differently-spelled paths to the
 * same worktree are treated as equal. Used before parking a freed checkout on a
 * branch — git forbids checking out a branch already held by another worktree.
 */
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

/**
 * Resolve the worktree and branch for a run, possibly creating them.
 *
 * Decision flow (see module doc for the case meanings):
 * - `newWorktree` requested, or the current branch does not match the subject
 *   slug → case `1c`: create a new branch + run-scoped worktree.
 * - current branch matches and the cwd is a dedicated (non-main) worktree
 *   holding it → case `1a`: reuse it, `createdByGan: false`.
 * - otherwise (matching branch but in a shared/main checkout) → case `1b`: free
 *   the current checkout and move the branch into a fresh run-scoped worktree,
 *   `createdByGan: true`.
 *
 * Side effects (cases `1b`/`1c` only): runs `git worktree add` (and, in `1b`, a
 * `git checkout` to free the current branch). Case `1a` performs only git reads.
 *
 * @param opts see {@link ResolveWorkspaceOptions}.
 * @returns the {@link ResolvedWorkspace}.
 * @throws `ConfigServerError('MalformedInput')` when case `1b` is needed but the
 *   current checkout has uncommitted changes — freeing it could lose work, so
 *   the run refuses with remediation guidance. git command failures from the
 *   worktree-creation paths also propagate.
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

  if (opts.newWorktree === true || !matches) {
    return createWorktree1c({ git, fromDir, taskBranch, runScopedWorktree });
  }

  const top = currentWorktreeTop(git, fromDir);
  const entries = listWorktrees(git, fromDir);
  const topCanon = canonicalizePathForDisplay(top);
  const mainRootCanon = canonicalizePathForDisplay(mainWorktreeRoot(git, fromDir));
  const cwdHoldsBranch = entries.some(
    (e) => shortRef(e.branch) === branch && canonicalizePathForDisplay(e.worktree) === topCanon,
  );
  const cwdIsMainCheckout = topCanon === mainRootCanon;
  // "Dedicated" = this worktree holds the matching branch and is NOT the main
  // checkout. Only then is it safe to reuse in place (case 1a); the main
  // checkout is shared, so a matching branch there is moved out in case 1b.
  const dedicated = cwdHoldsBranch && !cwdIsMainCheckout;

  if (dedicated) {

    return {
      worktreePath: canonicalizePathForDisplay(top),
      branch: branch as string,
      createdByGan: false,
      resolutionCase: '1a',
    };
  }

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

  freeCurrentCheckout({ git, fromDir, entries, top: topCanon });

  git(['worktree', 'add', runScopedWorktree, branch as string], fromDir);

  return {
    worktreePath: canonicalizePathForDisplay(runScopedWorktree),
    branch: branch as string,
    createdByGan: true,
    resolutionCase: '1b',
  };
}

/**
 * Move the current checkout off the run's branch so that branch can be added to
 * a run-scoped worktree (git allows a branch to be checked out in only one
 * worktree at a time).
 *
 * Parks on the default branch when one exists and is not already held by
 * another worktree; otherwise detaches HEAD. Detach is the safe fallback — it
 * frees the branch without needing any particular branch to be available, at
 * the cost of leaving the checkout headless.
 *
 * Precondition (enforced by the caller): the working tree is clean, so the
 * checkout cannot discard uncommitted work.
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

  git(['checkout', '--detach'], fromDir);
}

/**
 * Case `1c`: create a brand-new branch `taskBranch` and a run-scoped worktree in
 * one `git worktree add -b` call.
 *
 * @returns a {@link ResolvedWorkspace} with `createdByGan: true` and
 *   `resolutionCase: '1c'`, so the new branch and worktree are eligible for
 *   cleanup later.
 * @throws propagates the git failure if the branch/worktree cannot be created.
 */
function createWorktree1c(args: {
  git: GitExec;
  fromDir: string;
  taskBranch: string;
  runScopedWorktree: string;
}): ResolvedWorkspace {
  const { git, fromDir, taskBranch, runScopedWorktree } = args;

  git(['worktree', 'add', '-b', taskBranch, runScopedWorktree], fromDir);
  return {
    worktreePath: canonicalizePathForDisplay(runScopedWorktree),
    branch: taskBranch,
    createdByGan: true,
    resolutionCase: '1c',
  };
}
