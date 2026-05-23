

/**
 * Builder for the security half of the surface system. A thin adapter over the
 * shared {@link instantiateSurfaces} engine that feeds it each stack's
 * *security* surfaces; the documentation counterpart lives in
 * `documentation-surfaces.ts` and the two differ only in which surface list
 * they pass through.
 */

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

/**
 * Instantiate every stack's security surfaces against the sprint's affected
 * files, producing {@link EvaluatorPlan.securitySurfacesInstantiated}.
 *
 * A stack with no `securitySurfaces` cannot fire. A file absent from
 * `worktree.fileContents` can satisfy a scope trigger but not a keyword
 * trigger (its text is unavailable).
 *
 * @param snapshot resolved config; supplies each stack's name, scope, and
 *   security surfaces.
 * @param sprintPlan its `affectedFiles` are the candidate set surfaces match.
 * @param worktree its optional `fileContents` back keyword triggers; defaulted
 *   to `{}` when absent.
 * @returns instantiated security surfaces, ordered by the shared engine.
 */
export function buildSecuritySurfacesInstantiated(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktree: WorktreeState,
): EvaluatorPlan['securitySurfacesInstantiated'] {
  const fileContents = worktree.fileContents ?? {};
  return instantiateSurfaces(
    snapshot.activeStacks.map((stack) => ({
      name: stack.name,
      scope: stack.scope,
      surfaces: stack.securitySurfaces ?? [],
    })),
    sprintPlan.affectedFiles,
    fileContents,
  );
}
