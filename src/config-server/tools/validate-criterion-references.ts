/**
 * MCP tool wrapper exposing the contract-proposer's pre-flight name-resolution
 * pass over the wire. The orchestrator calls this tool against a draft
 * contract; the tool reads the base-commit `package.json` from the local git
 * worktree and delegates parsing + resolution to the pure-function backbone
 * at {@link validateCriterionReferences}.
 *
 * Why a thin wrapper. The dual-callable surface rule keeps the resolver itself
 * pure and side-effect-free — testable against fixture inputs without staging
 * a git worktree. The wrapper is the one place the subprocess read happens,
 * so the safe-by-default `execFile` argument-array discipline is enforced
 * once, here, and the backbone never sees an unsanitised string.
 *
 * Subprocess safety. The wrapper invokes `git show <baseRef>:package.json`
 * via `execFileSync('git', ['-C', cwd, 'show', ...])` — an argument-array
 * invocation with no shell interpolation. The `baseRef` is the caller-
 * supplied git ref (a branch name, a tag, or a SHA-1 prefix); it is passed
 * as a single argv element after the colon separator, never concatenated
 * into a shell command line. A `baseRef` containing whitespace, semicolons,
 * or other shell metacharacters cannot escape the argv boundary; `git` itself
 * rejects malformed refs (returning a non-zero exit code) rather than
 * surfacing them as a different command. The boundary refusal pattern is
 * the same one `src/config-server/tools/writes.ts:625` uses for `git
 * rev-parse HEAD` and what `src/config-server/tools/independent-review.ts`
 * notes for its own subprocess discipline.
 */

import { execFileSync } from 'node:child_process';

import { createError } from '../errors.js';
import {
  validateCriterionReferences as resolverValidateCriterionReferences,
  type ContractDraftLike,
  type ValidateCriterionReferencesResult,
} from '../resolution/criterion-references.js';

/**
 * Input to {@link validateCriterionReferencesTool}.
 *
 * @property contractDraft the proposer's draft, conforming to
 *   {@link ContractDraftLike}. The wrapper performs no shape validation
 *   beyond what the backbone tolerates — a draft missing the `criteria`
 *   array yields an empty result array rather than throwing.
 * @property baseRef the git ref the orchestrator pinned for the run (a
 *   branch name, a tag, a SHA-1, or any other revision spec `git show`
 *   accepts). The wrapper invokes `git show <baseRef>:package.json` to
 *   read the base-commit's script map. The ref is passed as an argv
 *   element under `execFile`; shell interpolation is impossible.
 * @property cwd absolute path of the git worktree the `git show` call
 *   runs against. The wrapper supplies it as the `-C` argument to `git`,
 *   so the working directory of the host process does not affect the
 *   read. When omitted the wrapper uses `process.cwd()`; production
 *   callers pass `GAN_WORKTREE` explicitly.
 */
export interface ValidateCriterionReferencesToolInput {
  contractDraft: ContractDraftLike;
  baseRef: string;
  cwd?: string;
}

/**
 * Result of {@link validateCriterionReferencesTool}.
 *
 * Mirrors the backbone's {@link ValidateCriterionReferencesResult} verbatim
 * — `records` and `unresolvedCount` carry the same meaning. The wrapper adds
 * no fields and re-orders nothing.
 */
export type ValidateCriterionReferencesToolResult = ValidateCriterionReferencesResult;

/**
 * Run the pre-flight name-resolution pass over a contract draft.
 *
 * Reads the base-commit `package.json` from the supplied git worktree via
 * `git show <baseRef>:package.json` (argv-form, no shell interpolation),
 * then delegates parsing + resolution to the pure-function backbone. The
 * backbone is the dual-callable surface — a direct library import of
 * {@link resolverValidateCriterionReferences} resolves to the same
 * function this wrapper calls.
 *
 * Failure modes:
 * - `baseRef` is missing or empty. The wrapper throws `MalformedInput`
 *   with the field name pinned (the caller's boundary validator would
 *   normally catch this, but the wrapper repeats the check defensively
 *   so a direct library caller cannot pass an unchecked value).
 * - `git show` fails (the worktree is not a git repo, the ref does not
 *   exist, the base commit has no `package.json`). The wrapper treats
 *   the failure as "no scripts defined": the backbone then surfaces
 *   every recognised reference as unresolved. The behaviour is
 *   intentional — a hard throw on a missing base-commit `package.json`
 *   would block the proposer from ever running the pre-flight against
 *   a repo that does not declare scripts; the noisy-but-bounded
 *   "everything unresolved" report is the diagnostic the proposer
 *   acts on.
 *
 * Caller invariants:
 * - The `cwd` must point at a path inside the orchestrator's worktree.
 *   The wrapper does not re-canonicalise the path; the caller has
 *   already resolved it via the standard `GAN_WORKTREE` convention.
 *
 * Side effects: one subprocess invocation of `git show` against the
 * supplied worktree. No filesystem writes, no network calls. The
 * subprocess inherits the host process's environment.
 *
 * @param input the structured input ({@link ValidateCriterionReferencesToolInput}).
 * @returns the structured result ({@link ValidateCriterionReferencesToolResult}).
 * @throws `MalformedInput` when `baseRef` is missing or empty (defensive;
 *   the boundary validator would normally catch this first).
 */
export function validateCriterionReferencesTool(
  input: ValidateCriterionReferencesToolInput,
): ValidateCriterionReferencesToolResult {
  const { contractDraft, baseRef, cwd } = input;

  // Defensive refusal: the orchestrator's boundary validator should already
  // have caught an empty baseRef, but the library entry-point repeats the
  // check so a direct caller does not silently pass an unresolved value
  // into the subprocess invocation.
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    throw createError('MalformedInput', {
      tool: 'validateCriterionReferences',
      field: 'baseRef',
      message:
        "Tool 'validateCriterionReferences' requires a non-empty 'baseRef' string identifying " +
        "the git ref to resolve the base-commit `package.json` against.",
    });
  }

  // `cwd` falls back to `process.cwd()` only for unit-test ergonomics; the
  // orchestrator always supplies an explicit `GAN_WORKTREE` so the host
  // process's working directory cannot leak into the read.
  const worktree = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();

  // The `git show` invocation uses argv form exclusively: no shell, no
  // string interpolation. `baseRef` is one argv element; `package.json` is
  // its colon-delimited path inside the tree. A `baseRef` containing
  // metacharacters cannot escape the argument boundary because there is
  // no shell to interpret them.
  let packageJsonContents = '';
  try {
    packageJsonContents = execFileSync(
      'git',
      ['-C', worktree, 'show', `${baseRef}:package.json`],
      {
        encoding: 'utf8',
        // Capture stderr separately so a `git show` error does not crash
        // the wrapper; the catch below handles the missing-ref /
        // missing-file paths by treating the result as "no scripts".
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // Documented failure mode: missing repo, missing ref, or missing
    // `package.json` at the base commit. The backbone then surfaces every
    // recognised reference as unresolved, which is the diagnostic the
    // proposer acts on.
    packageJsonContents = '';
  }

  return resolverValidateCriterionReferences({
    draft: contractDraft,
    packageJsonContents,
  });
}
