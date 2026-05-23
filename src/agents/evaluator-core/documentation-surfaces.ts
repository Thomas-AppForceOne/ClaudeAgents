

/**
 * Builders for the documentation half of the surface system: instantiating
 * each stack's documentation surfaces against the sprint's changed files, and
 * validating qualified surface ids. Both delegate the matching logic to the
 * shared {@link instantiateSurfaces} engine; this module only adapts the
 * documentation-specific inputs.
 */

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

/**
 * Instantiate every stack's documentation surfaces against the sprint's
 * affected files, producing {@link EvaluatorPlan.documentationSurfacesInstantiated}.
 *
 * A stack with no `documentationSurfaces` contributes an empty surface list
 * (it cannot fire). A file missing from `worktree.fileContents` can match a
 * scope trigger but never a keyword trigger, since its text is unavailable.
 *
 * @param snapshot resolved config; supplies each stack's name, scope, and
 *   documentation surfaces.
 * @param sprintPlan its `affectedFiles` are the candidate set surfaces match.
 * @param worktree its optional `fileContents` back keyword triggers; defaulted
 *   to `{}` when absent.
 * @returns instantiated documentation surfaces, ordered by the shared engine.
 */
export function buildDocumentationSurfacesInstantiated(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktree: WorktreeState,
): EvaluatorPlan['documentationSurfacesInstantiated'] {
  const fileContents = worktree.fileContents ?? {};
  return instantiateSurfaces(
    snapshot.activeStacks.map((stack) => ({
      name: stack.name,
      scope: stack.scope,
      surfaces: stack.documentationSurfaces ?? [],
    })),
    sprintPlan.affectedFiles,
    fileContents,
  );
}

/**
 * Test whether `qualifiedId` names a real surface in the current config.
 *
 * The id is expected in `<stackName>.<bareId>` form and is split on the FIRST
 * dot only, so a `bareId` may itself contain dots. It matches against BOTH the
 * security and documentation surfaces of the named stack — despite living in
 * the documentation module, this is the validator for either surface family.
 *
 * Returns `false` (never throws) for a malformed id: an empty stack-name
 * portion (leading dot), an empty bare-id portion (trailing dot), or no dot at
 * all. An unknown stack name, or a known stack lacking the bare id, also
 * returns `false`.
 *
 * @param snapshot resolved config providing the active stacks and their
 *   surface ids.
 * @param qualifiedId the dotted id to validate, e.g. `node.no-eval`.
 * @returns `true` iff some active stack matches the name and declares the bare
 *   id among its security or documentation surfaces.
 */
export function isKnownSurfaceId(
  snapshot: EvaluatorCoreSnapshot,
  qualifiedId: string,
): boolean {

  // Split on the first dot only: the stack name is the prefix; everything
  // after is the bare id (which may legitimately contain further dots). The
  // bounds check rejects a leading dot (empty name) and a trailing dot (empty
  // id) without a separate length test.
  const firstDot = qualifiedId.indexOf('.');
  if (firstDot <= 0 || firstDot === qualifiedId.length - 1) return false;
  const stackName = qualifiedId.slice(0, firstDot);
  const bareId = qualifiedId.slice(firstDot + 1);

  for (const stack of snapshot.activeStacks) {
    if (stack.name !== stackName) continue;
    const securityIds = (stack.securitySurfaces ?? []).map((s) => s.id);
    const documentationIds = (stack.documentationSurfaces ?? []).map((s) => s.id);

    if (securityIds.includes(bareId) || documentationIds.includes(bareId)) {
      return true;
    }
  }
  return false;
}
