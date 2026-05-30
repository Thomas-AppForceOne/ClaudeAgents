/**
 * Run-context tool handlers — the pure store-path resolver and the writing
 * worktree creator. These are the keystone tools the markdown orchestrator
 * calls at run start: every later run-scoped tool (trace, safety,
 * evaluator-core, modules) addresses its data by `runDir`/`repoKey`/`runId`,
 * and the orchestrator must export `GAN_RUN_DIR`/`GAN_WORKTREE`, but none of
 * those identifiers can be computed from a markdown prompt — they come from
 * the shipped library functions re-exported here behind MCP tool wrappers.
 *
 * Each handler is a thin composition over already-shipped library code, per
 * the dual-callable-surface rule: there is no second implementation of run-id
 * minting, store-path resolution, or worktree creation behind these tools.
 *
 * The split into two tools is deliberate. `resolveRunStore` is **pure** and
 * runs both at run start (before the lock) and on every recovery / cleanup /
 * list path — those paths need the addresses, never a new worktree.
 * `createRunWorkspace` **writes** (cases 1b/1c run `git worktree add` /
 * `git checkout`) and must run only after the run lock is held, so a second
 * `/gan` cannot race the first into the same worktree. Recovery and cleanup
 * therefore call `resolveRunStore` but never `createRunWorkspace`.
 */
import {
  generateRunId,
  resolveRunStore as libraryResolveRunStore,
  type ResolvedRunStore,
} from '../storage/run-store.js';
import { resolveWorkspace, type ResolvedWorkspace } from '../storage/worktree-resolver.js';

/**
 * Input to {@link resolveRunStoreTool}.
 *
 * @property fromDir directory inside the repo used to discover the main
 *   worktree root; defaults to `process.cwd()`. Optional so the tool stays
 *   callable from arbitrary cwd's without a forced argument.
 * @property runId an explicit run id; when omitted, a fresh id is minted via
 *   `generateRunId()`. The same call shape thus serves both run-start
 *   ("mint me a fresh run") and recovery / cleanup ("re-resolve this id").
 */
export interface ResolveRunStoreInput {
  fromDir?: string;
  runId?: string;
}

/**
 * Result of {@link resolveRunStoreTool} — the library's `ResolvedRunStore`
 * struct **plus** the `runId` the tool composed it from.
 *
 * The library's `ResolvedRunStore` carries no `runId` field of its own
 * (`runId` is a tool-level input there), so the tool adds it to the return
 * shape: callers need the id back when they let the tool mint, and threading
 * a minted id from a second call would defeat the purpose of the composition
 * wrapper.
 */
export interface ResolveRunStoreResult extends ResolvedRunStore {
  runId: string;
}

/**
 * Resolve every run-store address for one run — purely, without writing
 * anything to disk under the run dir, store root, or repo store dir.
 *
 * Composition wrapper: when `input.runId` is absent it calls
 * `generateRunId()` (which the library `resolveRunStore` itself requires as
 * a fed argument), then forwards to the library `resolveRunStore`. Same call
 * shape, wider tool signature.
 *
 * Side effects: none on the run dir / store root; the underlying library does
 * perform one git read (`git rev-parse --git-common-dir`) to discover the
 * main-worktree root. No file is created.
 *
 * @param input optional `fromDir` and `runId`.
 * @returns the resolved store paths plus the run id (minted or echoed).
 * @throws when `fromDir` (or `process.cwd()`) is not inside a git repository,
 *   propagated from the library worktree-root discovery.
 */
export function resolveRunStoreTool(input: ResolveRunStoreInput = {}): ResolveRunStoreResult {
  // Mint when the caller did not pass one. Doing the mint in the tool layer
  // (rather than the library) is what makes the same tool call valid at both
  // run start ("give me a fresh runId") and recovery ("re-resolve this id") —
  // the library's resolveRunStore requires a runId on every call.
  const runId = input.runId ?? generateRunId();
  const opts: Parameters<typeof libraryResolveRunStore>[0] = { runId };
  if (input.fromDir !== undefined) opts.fromDir = input.fromDir;
  const resolved = libraryResolveRunStore(opts);
  return { ...resolved, runId };
}

/**
 * Input to {@link createRunWorkspaceTool}.
 *
 * @property subject the free-text run subject — required because it slugifies
 *   into the branch name. The library `resolveWorkspace` would happily accept
 *   an empty subject and produce a malformed branch slug; the tool surface
 *   therefore treats `subject` as load-bearing on every call.
 * @property runId the run id whose worktree to create. Required: the worktree
 *   path is `<projectRoot>/.gan-state/runs/<runId>/worktree`, so the id is
 *   not derivable inside the handler.
 * @property fromDir directory inside the repo used to discover the main
 *   worktree root; defaults to `process.cwd()`. Ignored when
 *   `mainWorktreeRoot` is supplied (the root is then already known).
 * @property mainWorktreeRoot the repo's main worktree root, as already
 *   resolved by {@link resolveRunStoreTool} at run start (step 7 of the
 *   orchestration). When supplied, the handler uses it directly as
 *   `projectRoot` and skips the second `git rev-parse --git-common-dir` +
 *   path-resolution pass; when absent, the handler re-derives it internally
 *   (backward compatible — a caller that does not thread the value still
 *   works, it just pays the extra git read).
 * @property newWorktree when `true`, force case 1c (always create new). Same
 *   semantics as the underlying library option.
 */
export interface CreateRunWorkspaceInput {
  subject: string;
  runId: string;
  fromDir?: string;
  mainWorktreeRoot?: string;
  newWorktree?: boolean;
}

/**
 * Result of {@link createRunWorkspaceTool} — the library `ResolvedWorkspace`
 * shape plus the F2 mutation indicator.
 *
 * @property mutated `true` when the tool created a branch/worktree (resolution
 *   cases 1b/1c, where `createdByGan` is also `true`), `false` when it reused
 *   an existing worktree in place (case 1a, a read-only resolution). Mirrors
 *   the library's `createdByGan` flag onto the uniform `mutated` name the F2
 *   mutation-indicator contract uses, so the orchestrator can OR it in with
 *   the other R7 write tools' results.
 */
export type CreateRunWorkspaceResult = ResolvedWorkspace & { mutated: boolean };

/**
 * Resolve and create the run's worktree.
 *
 * Why `projectRoot` is derived from worktree-root discovery rather than taken
 * as a free `projectRoot`: `resolveWorkspace` writes a worktree under
 * `<projectRoot>/.gan-state/runs/`, and a markdown orchestrator that could
 * pass any path here would also be able to redirect the write outside the
 * repo. The handler instead uses the repo's main-worktree root — the same
 * value `resolveRunStore` produces — as `projectRoot`, so the worktree always
 * lands under the repo the run was started from, by construction.
 *
 * The root is resolved once at run start (step 7's `resolveRunStore`). To
 * avoid a second `git rev-parse --git-common-dir` here, the caller may thread
 * that value back in as `input.mainWorktreeRoot`; when supplied it is used
 * directly. When absent the handler re-derives it (one extra git read), so an
 * older caller that does not thread the value still works.
 *
 * Side effects: cases 1b and 1c run `git worktree add` (and 1b additionally
 * runs `git checkout` to free the current checkout). Case 1a performs only
 * git reads. The tool must be called only after `acquireRunLock` has
 * succeeded — the SKILL.md orchestration enforces the ordering; the tool
 * itself does not re-check.
 *
 * @param input see {@link CreateRunWorkspaceInput}.
 * @returns `{ worktreePath, branch, createdByGan, resolutionCase, mutated }` —
 *   the library `ResolvedWorkspace` shape plus the F2 `mutated` indicator.
 * @throws `MalformedInput` when case 1b is needed but the current checkout
 *   has uncommitted changes; git command failures propagate. (Errors come
 *   from the underlying library; this handler adds no error vocabulary.)
 */
export function createRunWorkspaceTool(input: CreateRunWorkspaceInput): CreateRunWorkspaceResult {
  // projectRoot is the repo's main-worktree root — the same value
  // resolveRunStore produces — so the worktree always lands under the run's
  // repo regardless of what the markdown orchestrator might otherwise pass.
  // When the caller threads back the value resolveRunStore already resolved at
  // run start, use it directly; otherwise re-derive it (one extra git read,
  // backward compatible) via the same resolveRunStoreTool path.
  const projectRoot =
    input.mainWorktreeRoot ??
    resolveRunStoreTool(
      input.fromDir !== undefined
        ? { runId: input.runId, fromDir: input.fromDir }
        : { runId: input.runId },
    ).mainWorktreeRoot;
  const opts: Parameters<typeof resolveWorkspace>[0] = {
    subject: input.subject,
    runId: input.runId,
    projectRoot,
  };
  if (input.fromDir !== undefined) opts.fromDir = input.fromDir;
  if (input.newWorktree !== undefined) opts.newWorktree = input.newWorktree;
  const resolved = resolveWorkspace(opts);
  // `createdByGan` is true exactly for cases 1b/1c (a branch/worktree was
  // created) and false for case 1a (an existing worktree reused in place), so
  // it is the durable-state-changed signal — surfaced under the uniform F2
  // `mutated` name alongside the library shape.
  return { ...resolved, mutated: resolved.createdByGan };
}
