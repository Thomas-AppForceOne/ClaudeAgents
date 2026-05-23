

import path from 'node:path';

import { canonicalizePathForDisplay } from '../determinism/index.js';
import { createError } from '../errors.js';
import { defaultGitExec, mainWorktreeRoot, type GitExec } from './git-exec.js';

export { defaultGitExec };
export type { GitExec };

export interface ResolvedWorkspace {

  worktreePath: string;

  branch: string;

  createdByGan: boolean;

  resolutionCase: '1a' | '1b' | '1c';
}

export interface ResolveWorkspaceOptions {

  subject: string;

  runId: string;

  projectRoot: string;

  fromDir?: string;

  newWorktree?: boolean;

  git?: GitExec;

  newBranchPrefix?: string;
}

export function slugify(subject: string): string {
  const lowered = subject.toLowerCase();

  const collapsed = lowered.replace(/[^a-z0-9_]+/g, '-');

  const trimmed = collapsed.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  return trimmed;
}

export function terminalSlug(branch: string): string {
  const idx = Math.max(branch.lastIndexOf('/'), branch.lastIndexOf('\\'));
  const terminal = idx >= 0 ? branch.slice(idx + 1) : branch;
  return slugify(terminal);
}

export function branchMatchesSlug(branch: string, slug: string): boolean {
  return terminalSlug(branch) === slugify(slug);
}

function currentBranch(git: GitExec, fromDir: string): string | undefined {

  try {
    const out = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], fromDir).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function currentWorktreeTop(git: GitExec, fromDir: string): string {
  return git(['rev-parse', '--show-toplevel'], fromDir).trim();
}

function isWorkingTreeDirty(git: GitExec, fromDir: string): boolean {

  const out = git(['status', '--porcelain'], fromDir);
  return out.trim().length > 0;
}

interface WorktreeEntry {

  worktree: string;

  branch?: string;

  detached: boolean;
}

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

function shortRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

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

  for (const candidate of ['develop', 'main', 'master']) {
    if (localBranchExists(git, fromDir, candidate)) return candidate;
  }
  return undefined;
}

function localBranchExists(git: GitExec, fromDir: string, name: string): boolean {
  try {

    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], fromDir);
    return true;
  } catch {
    return false;
  }
}

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
